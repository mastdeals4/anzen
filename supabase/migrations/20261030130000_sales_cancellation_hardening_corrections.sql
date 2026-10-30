-- Migration: 20261030130000_sales_cancellation_hardening_corrections.sql
-- Description:
-- 1. Corrects cancelled invoice disclosure aggregation in get_sales_profitability_summary:
--    Aggregates invoice headers and item quantities separately so that multi-line cancelled
--    invoices count their total_amount and subtotal exactly once.
-- 2. Corrects trg_sync_sales_invoice_document_status:
--    Detects OLD vs NEW changes; guarantees that legacy updates to is_draft cannot uncancel
--    a cancelled invoice; establishes explicit document_status precedence over is_draft.
-- 3. Corrects create_sales_invoice_atomic concurrency:
--    Acquires transactional row locks on delivery_challan_items with deterministic ORDER BY id ASC FOR UPDATE;
--    recalculates remaining unbilled quantity after lock acquisition; protects against concurrent over-billing
--    and intra-request multi-line overselling without deadlocks.
-- 4. Establishes single reportability rule across all views and reporting functions using
--    authoritative public.is_reportable_sales_invoice(document_status, is_draft, notes).

BEGIN;

-- ==============================================================================
-- 1. Authoritative Reportability Helper & Canonical Views
-- ==============================================================================

CREATE OR REPLACE FUNCTION public.is_reportable_sales_invoice(
  p_document_status text,
  p_is_draft boolean,
  p_notes text
)
RETURNS boolean
IMMUTABLE
LANGUAGE sql
AS $$
  SELECT COALESCE(p_document_status, CASE WHEN p_is_draft THEN 'draft' ELSE 'posted' END) = 'posted'
    AND NOT COALESCE(p_is_draft, false)
    AND NOT (COALESCE(p_notes, '') LIKE '[CANCELLED%' OR LOWER(COALESCE(p_notes, '')) LIKE 'cancelled%');
$$;

GRANT EXECUTE ON FUNCTION public.is_reportable_sales_invoice(text, boolean, text) TO authenticated, service_role;

CREATE OR REPLACE VIEW public.active_sales_invoices WITH (security_invoker = true) AS
SELECT *
FROM public.sales_invoices
WHERE public.is_reportable_sales_invoice(document_status, is_draft, notes);

CREATE OR REPLACE VIEW public.active_sales_invoice_items WITH (security_invoker = true) AS
SELECT sii.*
FROM public.sales_invoice_items sii
JOIN public.sales_invoices si ON si.id = sii.invoice_id
WHERE public.is_reportable_sales_invoice(si.document_status, si.is_draft, si.notes);

GRANT SELECT ON public.active_sales_invoices TO authenticated, service_role;
GRANT SELECT ON public.active_sales_invoice_items TO authenticated, service_role;

-- ==============================================================================
-- 2. Hardened Lifecycle Trigger with Change Detection and Cancellation Preservation
-- ==============================================================================

CREATE OR REPLACE FUNCTION public.trg_sync_sales_invoice_document_status()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_status_changed boolean := false;
  v_draft_changed boolean := false;
  v_is_cancelled boolean := false;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- If document_status is explicitly provided, it dictates is_draft
    IF NEW.document_status = 'draft' THEN
      NEW.is_draft := true;
    ELSIF NEW.document_status IN ('posted', 'cancelled') THEN
      NEW.is_draft := false;
    -- Otherwise infer document_status from is_draft and legacy cancellation notes
    ELSIF NEW.is_draft = true THEN
      NEW.document_status := 'draft';
    ELSIF (COALESCE(NEW.notes, '') LIKE '[CANCELLED%' OR LOWER(COALESCE(NEW.notes, '')) LIKE 'cancelled%') THEN
      NEW.document_status := 'cancelled';
      NEW.is_draft := false;
    ELSE
      NEW.document_status := 'posted';
      NEW.is_draft := false;
    END IF;

    IF NEW.document_status = 'cancelled' AND NEW.cancelled_at IS NULL THEN
      NEW.cancelled_at := now();
    END IF;

    RETURN NEW;
  END IF;

  -- TG_OP = 'UPDATE'
  v_status_changed := (NEW.document_status IS DISTINCT FROM OLD.document_status);
  v_draft_changed  := (NEW.is_draft IS DISTINCT FROM OLD.is_draft);
  v_is_cancelled   := (OLD.document_status = 'cancelled' OR OLD.notes LIKE '[CANCELLED%' OR LOWER(OLD.notes) LIKE 'cancelled%');

  -- PRESERVATION RULE: If an invoice is currently cancelled, legacy updates to is_draft
  -- (e.g. SET is_draft = false) or updates where document_status was not explicitly changed
  -- MUST NEVER turn a cancelled invoice back into a posted invoice.
  IF v_is_cancelled AND NOT v_status_changed THEN
    NEW.document_status := 'cancelled';
    NEW.is_draft := false;
    IF NEW.cancelled_at IS NULL THEN
      NEW.cancelled_at := COALESCE(OLD.cancelled_at, now());
    END IF;
    RETURN NEW;
  END IF;

  -- PRECEDENCE & CONFLICT RESOLUTION RULE:
  -- 1. If document_status was explicitly changed (including conflicting simultaneous updates
  --    where both were passed), explicit document_status takes absolute precedence over is_draft.
  IF v_status_changed THEN
    IF NEW.document_status = 'draft' THEN
      NEW.is_draft := true;
    ELSIF NEW.document_status IN ('posted', 'cancelled') THEN
      NEW.is_draft := false;
    END IF;
  ELSIF v_draft_changed THEN
    -- 2. Only is_draft was changed on an uncancelled invoice (legacy update path):
    -- synchronize document_status from the updated is_draft.
    IF NEW.is_draft = true THEN
      NEW.document_status := 'draft';
    ELSE
      NEW.document_status := 'posted';
    END IF;
  ELSE
    -- 3. Neither status nor is_draft changed (e.g. routine update to notes/customer):
    -- preserve internal consistency between document_status and is_draft.
    IF NEW.document_status = 'draft' THEN
      NEW.is_draft := true;
    ELSIF NEW.document_status IN ('posted', 'cancelled') THEN
      NEW.is_draft := false;
    ELSIF NEW.is_draft = true THEN
      NEW.document_status := 'draft';
    ELSE
      NEW.document_status := 'posted';
    END IF;
  END IF;

  IF NEW.document_status = 'cancelled' AND NEW.cancelled_at IS NULL THEN
    NEW.cancelled_at := COALESCE(OLD.cancelled_at, now());
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_sales_invoice_document_status ON public.sales_invoices;
CREATE TRIGGER trg_sync_sales_invoice_document_status
  BEFORE INSERT OR UPDATE ON public.sales_invoices
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_sync_sales_invoice_document_status();

-- ==============================================================================
-- 3. Concurrent Delivery Challan Invoicing Serialization (create_sales_invoice_atomic)
-- ==============================================================================

CREATE OR REPLACE FUNCTION public.create_sales_invoice_atomic(p_invoice jsonb, p_items jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_role text;
  v_invoice_id uuid;
  v_subtotal numeric := 0;
  v_tax numeric := 0;
  v_discount numeric := COALESCE((p_invoice->>'discount_amount')::numeric, 0);
  v_stamp numeric := COALESCE((p_invoice->>'stamp_duty_amount')::numeric, 0);
  v_total numeric;
  v_count integer := 0;
  v_item jsonb;
  v_product uuid;
  v_batch uuid;
  v_dc_item uuid;
  v_qty numeric;
  v_price numeric;
  v_rate numeric;
  v_dc record;
  v_linked_challans uuid[];
  v_invoice_so_id uuid := NULLIF(p_invoice->>'sales_order_id','')::uuid;
  v_doc_status text := COALESCE(p_invoice->>'document_status', 'posted');
  v_already_invoiced numeric;
  v_requested_dc_qty numeric;
BEGIN
  SELECT role INTO v_role FROM public.user_profiles WHERE id = auth.uid();
  IF v_role IS NULL OR v_role NOT IN ('admin', 'accounts', 'sales','warehouse') THEN
    RAISE EXCEPTION 'Permission denied: role % cannot create sales invoices', v_role;
  END IF;
  IF jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Sales invoice requires at least one product line';
  END IF;
  IF NULLIF(p_invoice->>'invoice_number','') IS NULL OR NULLIF(p_invoice->>'customer_id','') IS NULL THEN
    RAISE EXCEPTION 'Invoice number and customer are required';
  END IF;
  IF EXISTS (SELECT 1 FROM public.sales_invoices WHERE invoice_number=p_invoice->>'invoice_number') THEN
    RAISE EXCEPTION 'Invoice number already exists';
  END IF;

  -- 1. Transactional Row Locking: Acquire FOR UPDATE on delivery_challan_items in deterministic
  -- ORDER BY id ASC. This serializes competing concurrent transactions attempting to consume
  -- the same DC items and prevents deadlocks.
  PERFORM dci.id
  FROM public.delivery_challan_items dci
  WHERE dci.id IN (
    SELECT DISTINCT (val->>'delivery_challan_item_id')::uuid
    FROM jsonb_array_elements(p_items) val
    WHERE NULLIF(val->>'delivery_challan_item_id', '') IS NOT NULL
  )
  ORDER BY dci.id ASC
  FOR UPDATE;

  -- 2. Process and validate each invoice line item against locked DC items
  FOR v_item IN SELECT value FROM jsonb_array_elements(p_items)
  LOOP
    v_product := NULLIF(v_item->>'product_id','')::uuid;
    v_batch := NULLIF(v_item->>'batch_id','')::uuid;
    v_dc_item := NULLIF(v_item->>'delivery_challan_item_id','')::uuid;
    v_qty := (v_item->>'quantity')::numeric;
    v_price := (v_item->>'unit_price')::numeric;
    v_rate := COALESCE((v_item->>'tax_rate')::numeric, 0);

    IF v_product IS NULL OR v_dc_item IS NULL OR COALESCE(v_qty,0) <= 0 OR COALESCE(v_price,0) < 0 THEN
      RAISE EXCEPTION 'Every invoice line must have a source Delivery Challan item, product, quantity, and price';
    END IF;

    SELECT dci.product_id, dci.batch_id, dci.quantity, dc.customer_id, dc.approval_status, dc.sales_order_id
      INTO v_dc
    FROM public.delivery_challan_items dci
    JOIN public.delivery_challans dc ON dc.id=dci.challan_id
    WHERE dci.id=v_dc_item;

    IF NOT FOUND OR v_dc.product_id IS DISTINCT FROM v_product OR v_dc.batch_id IS DISTINCT FROM v_batch
       OR v_dc.customer_id IS DISTINCT FROM (p_invoice->>'customer_id')::uuid
       OR v_dc.approval_status <> 'approved' THEN
      RAISE EXCEPTION 'Invoice line source Delivery Challan is invalid or not approved';
    END IF;

    IF v_invoice_so_id IS NOT NULL AND v_dc.sales_order_id IS DISTINCT FROM v_invoice_so_id THEN
      RAISE EXCEPTION 'Invoice Sales Order does not match its Delivery Challan source';
    END IF;

    -- Recalculate remaining invoiceable quantity for this DC item across all reportable invoices
    SELECT COALESCE(SUM(sii.quantity), 0)
    INTO v_already_invoiced
    FROM public.sales_invoice_items sii
    JOIN public.sales_invoices si ON si.id = sii.invoice_id
    WHERE sii.delivery_challan_item_id = v_dc_item
      AND public.is_reportable_sales_invoice(si.document_status, si.is_draft, si.notes);

    -- Calculate total quantity requested in current invoice items payload for this DC item (intra-request summation)
    SELECT COALESCE(SUM((val->>'quantity')::numeric), 0)
    INTO v_requested_dc_qty
    FROM jsonb_array_elements(p_items) val
    WHERE (val->>'delivery_challan_item_id')::uuid = v_dc_item;

    IF (v_already_invoiced + v_requested_dc_qty) > v_dc.quantity THEN
      RAISE EXCEPTION 'Invoice quantity % exceeds remaining Delivery Challan quantity % (DC total %, already invoiced %)',
        v_requested_dc_qty, (v_dc.quantity - v_already_invoiced), v_dc.quantity, v_already_invoiced;
    END IF;

    v_subtotal := v_subtotal + (v_qty * v_price);
    v_tax := v_tax + (v_qty * v_price * v_rate / 100);
    v_count := v_count + 1;
  END LOOP;

  v_total := v_subtotal + v_tax - v_discount + v_stamp;

  SELECT array_agg(DISTINCT dc.id) INTO v_linked_challans
  FROM public.delivery_challan_items dci
  JOIN public.delivery_challans dc ON dc.id=dci.challan_id
  WHERE dci.id IN (SELECT (value->>'delivery_challan_item_id')::uuid FROM jsonb_array_elements(p_items));

  IF p_invoice ? 'subtotal' AND abs(v_subtotal - (p_invoice->>'subtotal')::numeric) > 0.01
     OR p_invoice ? 'tax_amount' AND abs(v_tax - (p_invoice->>'tax_amount')::numeric) > 0.01
     OR p_invoice ? 'total_amount' AND abs(v_total - (p_invoice->>'total_amount')::numeric) > 0.01 THEN
    RAISE EXCEPTION 'Invoice totals do not match persisted product lines';
  END IF;

  INSERT INTO public.sales_invoices (
    invoice_number, customer_id, sales_order_id, invoice_date, due_date, discount_amount,
    delivery_challan_number, po_number, payment_terms_days, notes, subtotal, tax_amount,
    stamp_duty_amount, total_amount, payment_status, created_by, linked_challan_ids, document_status
  ) VALUES (
    p_invoice->>'invoice_number', (p_invoice->>'customer_id')::uuid, v_invoice_so_id,
    COALESCE((p_invoice->>'invoice_date')::date, CURRENT_DATE), (p_invoice->>'due_date')::date, v_discount,
    NULL, p_invoice->>'po_number', (p_invoice->>'payment_terms_days')::integer, p_invoice->>'notes',
    v_subtotal, v_tax, v_stamp, v_total, 'pending', COALESCE(NULLIF(p_invoice->>'created_by','')::uuid, auth.uid()),
    COALESCE(v_linked_challans, CASE WHEN jsonb_typeof(p_invoice->'linked_challan_ids')='array' THEN
      ARRAY(SELECT jsonb_array_elements_text(p_invoice->'linked_challan_ids')::uuid) ELSE NULL END),
    v_doc_status
  ) RETURNING id INTO v_invoice_id;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_items)
  LOOP
    INSERT INTO public.sales_invoice_items
      (invoice_id, product_id, batch_id, quantity, unit_price, tax_rate, delivery_challan_item_id)
    VALUES (v_invoice_id, (v_item->>'product_id')::uuid, NULLIF(v_item->>'batch_id','')::uuid,
      (v_item->>'quantity')::numeric, (v_item->>'unit_price')::numeric,
      COALESCE((v_item->>'tax_rate')::numeric,0), (v_item->>'delivery_challan_item_id')::uuid);
  END LOOP;

  IF (SELECT count(*) FROM public.sales_invoice_items WHERE invoice_id=v_invoice_id) <> v_count THEN
    RAISE EXCEPTION 'Invoice line count verification failed';
  END IF;
  RETURN v_invoice_id;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.create_sales_invoice_atomic(jsonb, jsonb) TO authenticated, service_role;

-- ==============================================================================
-- 4. Hardened Sales Profitability Summary with Separated Cancelled Disclosure
-- ==============================================================================

CREATE OR REPLACE FUNCTION public.get_sales_profitability_summary(
  p_start_date date,
  p_end_date date
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_result jsonb;
BEGIN
  WITH lines AS (
    SELECT
      ar.*,
      si.invoice_date,
      si.invoice_number,
      si.customer_id,
      COALESCE(c.company_name, 'Unknown Customer') AS customer_name,
      si.sales_order_id,
      so.so_number,
      sii.unit_price,
      ROUND(sii.quantity * sii.unit_price, 2) AS line_gross_sales,
      p.product_name,
      COALESCE(p.product_code, '') AS product_code,
      COALESCE(p.unit, 'kg') AS product_unit,
      b.batch_number,
      COALESCE(b.landed_cost_per_unit, b.cost_per_unit) AS batch_unit_cost,
      COALESCE(le.sales_expense, 0) AS line_sales_expense,
      dci.challan_id AS dc_id,
      dc.challan_number AS dc_number
    FROM public.get_authoritative_sales_line_cogs(p_start_date, p_end_date) ar
    JOIN public.sales_invoice_items sii ON sii.id = ar.line_id
    JOIN public.sales_invoices si ON si.id = ar.invoice_id
    JOIN public.products p ON p.id = ar.product_id
    LEFT JOIN public.customers c ON c.id = si.customer_id
    LEFT JOIN public.sales_orders so ON so.id = si.sales_order_id
    LEFT JOIN public.batches b ON b.id = ar.batch_id
    LEFT JOIN public.delivery_challan_items dci ON dci.id = sii.delivery_challan_item_id
    LEFT JOIN public.delivery_challans dc ON dc.id = dci.challan_id
    LEFT JOIN public.get_sales_profitability_line_expenses(p_start_date, p_end_date) le ON le.line_id = ar.line_id
    WHERE public.is_reportable_sales_invoice(si.document_status, si.is_draft, si.notes)
  ),
  cancelled_headers AS (
    SELECT
      id,
      COALESCE(total_amount, 0) AS total_amount,
      COALESCE(subtotal, 0) AS subtotal
    FROM public.sales_invoices
    WHERE invoice_date BETWEEN p_start_date AND p_end_date
      AND NOT public.is_reportable_sales_invoice(document_status, is_draft, notes)
      AND (
        document_status = 'cancelled'
        OR (COALESCE(notes, '') LIKE '[CANCELLED%' OR LOWER(COALESCE(notes, '')) LIKE 'cancelled%')
      )
  ),
  cancelled_invoices_data AS (
    SELECT
      COUNT(ch.id)::int AS cancelled_count,
      COALESCE(SUM(ch.total_amount), 0)::numeric AS cancelled_total_amount,
      COALESCE(SUM(ch.subtotal), 0)::numeric AS cancelled_subtotal,
      COALESCE((
        SELECT SUM(sii.quantity)
        FROM public.sales_invoice_items sii
        WHERE sii.invoice_id IN (SELECT id FROM cancelled_headers)
      ), 0)::numeric AS cancelled_total_qty
    FROM cancelled_headers ch
  ),
  returns AS (
    SELECT 
      COALESCE(SUM(cn.subtotal), 0) AS total_return_revenue,
      COALESCE(SUM(cogs_reversal.total_cogs), 0) AS total_return_cogs
    FROM public.credit_notes cn
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(jel.credit), 0) AS total_cogs
      FROM public.journal_entries je
      JOIN public.journal_entry_lines jel ON jel.journal_entry_id = je.id
      JOIN public.chart_of_accounts coa ON coa.id = jel.account_id AND coa.code = '5100'
      WHERE je.source_module = 'credit_note_cogs'
        AND je.reference_id = cn.id
        AND je.is_posted = true
    ) cogs_reversal ON true
    WHERE cn.status = 'approved'
      AND cn.credit_note_date BETWEEN p_start_date AND p_end_date
  ),
  unallocated AS (
    SELECT COALESCE(SUM(fe.amount), 0) AS amount
    FROM public.finance_expenses fe
    WHERE fe.expense_date BETWEEN p_start_date AND p_end_date
      AND fe.expense_category IN ('freight_outward', 'delivery_expense', 'sales_commission', 'travel_sales')
      AND fe.delivery_challan_id IS NULL
      AND fe.sales_order_id IS NULL
      AND fe.product_id IS NULL
  ),
  prod_returns AS (
    SELECT 
      cni.product_id,
      COALESCE(SUM(cni.total_price), 0) AS return_revenue,
      COALESCE(SUM(cni.quantity), 0) AS return_qty,
      COALESCE(SUM(public.get_credit_note_item_fifo_cogs(cni.id)), 0) AS return_cogs
    FROM public.credit_notes cn
    JOIN public.credit_note_items cni ON cni.credit_note_id = cn.id
    WHERE cn.status = 'approved'
      AND cn.credit_note_date BETWEEN p_start_date AND p_end_date
    GROUP BY cni.product_id
  ),
  prod AS (
    SELECT
      l.product_id,
      MAX(l.product_name) AS product_name,
      MAX(l.product_code) AS product_code,
      MAX(l.product_unit) AS product_unit,
      SUM(l.line_gross_sales) AS gross_sales,
      COALESCE(MAX(pr.return_revenue), 0) AS sales_returns,
      SUM(l.line_gross_sales) - COALESCE(MAX(pr.return_revenue), 0) AS net_sales,
      SUM(l.authoritative_cogs) AS product_cost,
      COALESCE(MAX(pr.return_cogs), 0) AS return_cogs,
      SUM(l.authoritative_cogs) - COALESCE(MAX(pr.return_cogs), 0) AS net_product_cost,
      SUM(l.line_sales_expense) AS sales_expenses,
      (SUM(l.line_gross_sales) - COALESCE(MAX(pr.return_revenue), 0)) - (SUM(l.authoritative_cogs) - COALESCE(MAX(pr.return_cogs), 0)) AS gross_profit,
      (SUM(l.line_gross_sales) - COALESCE(MAX(pr.return_revenue), 0)) - (SUM(l.authoritative_cogs) - COALESCE(MAX(pr.return_cogs), 0)) - SUM(l.line_sales_expense) AS profit_after_sales_expenses,
      SUM(l.quantity) AS total_qty_sold,
      COALESCE(MAX(pr.return_qty), 0) AS return_qty,
      SUM(l.quantity) - COALESCE(MAX(pr.return_qty), 0) AS net_qty_sold,
      COUNT(DISTINCT l.invoice_id) AS order_count,
      ROUND(
        ((SUM(l.line_gross_sales) - COALESCE(MAX(pr.return_revenue), 0)) - (SUM(l.authoritative_cogs) - COALESCE(MAX(pr.return_cogs), 0)) - SUM(l.line_sales_expense))
        / NULLIF(SUM(CASE WHEN l.authoritative_cogs IS NOT NULL THEN l.quantity ELSE 0 END) - COALESCE(MAX(pr.return_qty), 0), 0),
        2
      ) AS profit_per_unit,
      CASE
        WHEN (SUM(l.line_gross_sales) - COALESCE(MAX(pr.return_revenue), 0)) = 0 THEN NULL
        ELSE ROUND(
          ((SUM(l.line_gross_sales) - COALESCE(MAX(pr.return_revenue), 0)) - (SUM(l.authoritative_cogs) - COALESCE(MAX(pr.return_cogs), 0)) - SUM(l.line_sales_expense))
          / (SUM(l.line_gross_sales) - COALESCE(MAX(pr.return_revenue), 0)) * 100,
          2
        )
      END AS profit_margin_pct,
      COUNT(l.authoritative_cogs) AS costed_lines,
      COUNT(*) AS total_lines,
      COUNT(l.authoritative_cogs) < COUNT(*) AS has_unreported_cost
    FROM lines l
    LEFT JOIN prod_returns pr ON pr.product_id = l.product_id
    GROUP BY l.product_id
  ),
  inv AS (
    SELECT
      invoice_id,
      MAX(invoice_date) AS invoice_date,
      MAX(posted_invoice_cogs) AS product_cost,
      SUM(line_gross_sales) AS gross_sales,
      SUM(quantity) AS total_qty_sold,
      SUM(line_sales_expense) AS sales_expenses
    FROM lines
    GROUP BY invoice_id
  ),
  months AS (
    SELECT
      DATE_TRUNC('month', invoice_date)::date AS month_start,
      TO_CHAR(DATE_TRUNC('month', invoice_date), 'Mon YYYY') AS month_label,
      SUM(gross_sales) AS gross_sales,
      SUM(product_cost) AS product_cost,
      SUM(sales_expenses) AS sales_expenses,
      SUM(total_qty_sold) AS total_qty_sold,
      COUNT(*) AS order_count
    FROM inv
    GROUP BY 1, 2
  ),
  company AS (
    SELECT
      COALESCE(SUM(gross_sales), 0) AS gross_sales,
      COALESCE(SUM(product_cost), 0) AS product_cost,
      COALESCE(SUM(sales_expenses), 0) + (SELECT amount FROM unallocated) AS sales_expenses,
      (SELECT amount FROM unallocated) AS unallocated_sales_expenses,
      COALESCE(SUM(total_qty_sold), 0) AS total_qty_sold,
      COUNT(*) AS order_count,
      (SELECT COUNT(DISTINCT product_id) FROM lines) AS product_count,
      (SELECT total_return_revenue FROM returns) AS sales_returns,
      (SELECT total_return_cogs FROM returns) AS return_cogs
    FROM inv
  )
  SELECT jsonb_build_object(
    'company', jsonb_build_object(
      'gross_sales', c.gross_sales,
      'sales_returns', c.sales_returns,
      'net_sales', c.gross_sales - c.sales_returns,
      'product_cost', c.product_cost,
      'return_cogs', c.return_cogs,
      'net_product_cost', c.product_cost - c.return_cogs,
      'sales_expenses', c.sales_expenses,
      'unallocated_sales_expenses', c.unallocated_sales_expenses,
      'gross_profit', (c.gross_sales - c.sales_returns) - (c.product_cost - c.return_cogs),
      'profit_after_sales_expenses', (c.gross_sales - c.sales_returns) - (c.product_cost - c.return_cogs) - c.sales_expenses,
      'profit_margin_pct', CASE WHEN (c.gross_sales - c.sales_returns) = 0 THEN NULL 
        ELSE ROUND(((c.gross_sales - c.sales_returns) - (c.product_cost - c.return_cogs) - c.sales_expenses) / (c.gross_sales - c.sales_returns) * 100, 2) END,
      'total_qty_sold', c.total_qty_sold,
      'order_count', c.order_count,
      'product_count', c.product_count,
      'cancelled_invoices', jsonb_build_object(
        'count', cid.cancelled_count,
        'total_amount', cid.cancelled_total_amount,
        'subtotal', cid.cancelled_subtotal,
        'total_qty', cid.cancelled_total_qty
      )
    ),
    'cancelled_invoices', jsonb_build_object(
      'count', cid.cancelled_count,
      'total_amount', cid.cancelled_total_amount,
      'subtotal', cid.cancelled_subtotal,
      'total_qty', cid.cancelled_total_qty
    ),
    'products', COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.product_name) FROM prod p), '[]'::jsonb),
    'monthly', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'month_label', m.month_label,
          'month_start', m.month_start,
          'gross_sales', m.gross_sales,
          'product_cost', m.product_cost,
          'sales_expenses', m.sales_expenses,
          'gross_profit', m.gross_sales - m.product_cost,
          'profit_after_sales_expenses', m.gross_sales - m.product_cost - m.sales_expenses,
          'profit_margin_pct', CASE WHEN m.gross_sales = 0 THEN NULL ELSE ROUND((m.gross_sales - m.product_cost - m.sales_expenses) / m.gross_sales * 100, 2) END,
          'total_qty_sold', m.total_qty_sold,
          'order_count', m.order_count
        ) ORDER BY m.month_start
      ) FROM months m
    ), '[]'::jsonb)
  ) INTO v_result
  FROM company c
  CROSS JOIN cancelled_invoices_data cid;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_sales_profitability_summary(date, date) TO authenticated, service_role;

-- ==============================================================================
-- 5. Updated dc_invoicing_summary and so_delivery_invoice_status views
-- ==============================================================================

CREATE OR REPLACE VIEW public.dc_invoicing_summary WITH (security_invoker = true) AS
WITH dc_item_inv AS (
  SELECT
    dci.id AS dc_item_id,
    dci.challan_id,
    dci.quantity AS approved_quantity,
    COALESCE(SUM(sii.quantity), 0::numeric) AS invoiced_quantity,
    GREATEST(0::numeric, dci.quantity - COALESCE(SUM(sii.quantity), 0::numeric)) AS remaining_quantity
  FROM public.delivery_challan_items dci
  LEFT JOIN (
    public.sales_invoice_items sii
    JOIN public.sales_invoices si ON si.id = sii.invoice_id
      AND public.is_reportable_sales_invoice(si.document_status, si.is_draft, si.notes)
  ) ON sii.delivery_challan_item_id = dci.id
  GROUP BY dci.id, dci.challan_id, dci.quantity
),
dc_item_totals AS (
  SELECT
    challan_id,
    count(*)::bigint AS total_items,
    count(CASE WHEN invoiced_quantity = 0 THEN 1 END)::bigint AS not_invoiced_items,
    count(CASE WHEN invoiced_quantity >= approved_quantity THEN 1 END)::bigint AS invoiced_items,
    count(CASE WHEN invoiced_quantity > 0 AND invoiced_quantity < approved_quantity THEN 1 END)::bigint AS partially_invoiced_items,
    COALESCE(sum(approved_quantity), 0::numeric) AS total_quantity,
    COALESCE(sum(invoiced_quantity), 0::numeric) AS total_invoiced_quantity,
    COALESCE(sum(remaining_quantity), 0::numeric) AS total_remaining_quantity
  FROM dc_item_inv
  GROUP BY challan_id
),
dc_invoices AS (
  SELECT
    dci.challan_id,
    COALESCE(array_agg(DISTINCT si.invoice_number) FILTER (WHERE si.invoice_number IS NOT NULL), ARRAY[]::text[]) AS invoice_numbers
  FROM public.delivery_challan_items dci
  JOIN public.sales_invoice_items sii ON sii.delivery_challan_item_id = dci.id
  JOIN public.sales_invoices si ON si.id = sii.invoice_id
    AND public.is_reportable_sales_invoice(si.document_status, si.is_draft, si.notes)
  GROUP BY dci.challan_id
)
SELECT
  dc.id AS challan_id,
  dc.challan_number,
  dc.customer_id,
  dc.challan_date,
  dc.approval_status,
  COALESCE(t.total_items, 0::bigint) AS total_items,
  COALESCE(t.not_invoiced_items, 0::bigint) AS not_invoiced_items,
  COALESCE(t.invoiced_items, 0::bigint) AS invoiced_items,
  COALESCE(t.total_quantity, 0::numeric) AS total_quantity,
  COALESCE(t.total_remaining_quantity, 0::numeric) AS total_remaining_quantity,
  CASE
    WHEN COALESCE(t.total_invoiced_quantity, 0::numeric) = 0 THEN 'not_invoiced'::text
    WHEN COALESCE(t.total_remaining_quantity, 0::numeric) = 0 THEN 'fully_invoiced'::text
    ELSE 'partially_invoiced'::text
  END AS dc_status,
  COALESCE(inv.invoice_numbers, ARRAY[]::text[]) AS linked_invoices,
  COALESCE(inv.invoice_numbers, ARRAY[]::text[]) AS linked_invoice_numbers
FROM public.delivery_challans dc
LEFT JOIN dc_item_totals t ON t.challan_id = dc.id
LEFT JOIN dc_invoices inv ON inv.challan_id = dc.id;

CREATE OR REPLACE VIEW public.so_delivery_invoice_status WITH (security_invoker = true) AS
WITH ordered AS (
  SELECT
    soi.sales_order_id AS so_id,
    COALESCE(SUM(soi.quantity), 0::numeric) AS ordered_qty
  FROM public.sales_order_items soi
  GROUP BY soi.sales_order_id
),
approved_delivery AS (
  SELECT
    dc.sales_order_id AS so_id,
    COALESCE(SUM(dci.quantity), 0::numeric) AS approved_delivered_qty,
    count(DISTINCT dc.id) AS approved_dc_count
  FROM public.delivery_challans dc
  JOIN public.delivery_challan_items dci ON dci.challan_id = dc.id
  WHERE dc.approval_status::text = 'approved'
    AND dc.sales_order_id IS NOT NULL
  GROUP BY dc.sales_order_id
),
so_reportable_invoices AS (
  SELECT DISTINCT
    sii.id AS invoice_item_id,
    COALESCE(si.sales_order_id, dc.sales_order_id) AS so_id,
    sii.quantity
  FROM public.sales_invoice_items sii
  JOIN public.sales_invoices si ON si.id = sii.invoice_id
  LEFT JOIN public.delivery_challan_items dci ON dci.id = sii.delivery_challan_item_id
  LEFT JOIN public.delivery_challans dc ON dc.id = dci.challan_id
  WHERE public.is_reportable_sales_invoice(si.document_status, si.is_draft, si.notes)
    AND (si.invoice_number NOT ILIKE 'TEST-COGS-%')
    AND COALESCE(si.sales_order_id, dc.sales_order_id) IS NOT NULL
),
invoiced AS (
  SELECT
    so_id,
    COALESCE(SUM(quantity), 0::numeric) AS invoiced_qty,
    count(DISTINCT invoice_item_id) AS invoice_count
  FROM so_reportable_invoices
  GROUP BY so_id
)
SELECT
  so.id AS so_id,
  so.so_number,
  so.customer_id,
  so.status AS so_status,
  CASE
    WHEN COALESCE(ad.approved_delivered_qty, 0::numeric) = 0::numeric THEN 'pending'::text
    WHEN COALESCE(ad.approved_delivered_qty, 0::numeric) >= COALESCE(o.ordered_qty, 0::numeric)
         AND COALESCE(o.ordered_qty, 0::numeric) > 0::numeric THEN 'completed'::text
    ELSE 'partial'::text
  END AS delivery_status,
  CASE
    WHEN COALESCE(i.invoiced_qty, 0::numeric) = 0::numeric THEN 'pending'::text
    WHEN COALESCE(i.invoiced_qty, 0::numeric) >= COALESCE(o.ordered_qty, 0::numeric)
         AND COALESCE(o.ordered_qty, 0::numeric) > 0::numeric THEN 'completed'::text
    ELSE 'partial'::text
  END AS invoice_status,
  CASE
    WHEN COALESCE(i.invoiced_qty, 0::numeric) > 0::numeric
         AND COALESCE(ad.approved_delivered_qty, 0::numeric) = 0::numeric THEN 'invoice_done_delivery_pending'::text
    ELSE NULL::text
  END AS special_status,
  COALESCE(ad.approved_dc_count, 0::bigint) AS approved_dc_count,
  COALESCE(i.invoice_count, 0::bigint) AS invoice_count,
  COALESCE(o.ordered_qty, 0::numeric) AS ordered_qty,
  COALESCE(ad.approved_delivered_qty, 0::numeric) AS approved_delivered_qty,
  COALESCE(i.invoiced_qty, 0::numeric) AS invoiced_qty
FROM public.sales_orders so
LEFT JOIN ordered o ON o.so_id = so.id
LEFT JOIN approved_delivery ad ON ad.so_id = so.id
LEFT JOIN invoiced i ON i.so_id = so.id;
GRANT SELECT ON public.dc_invoicing_summary TO authenticated, service_role;
GRANT SELECT ON public.so_delivery_invoice_status TO authenticated, service_role;

COMMIT;
