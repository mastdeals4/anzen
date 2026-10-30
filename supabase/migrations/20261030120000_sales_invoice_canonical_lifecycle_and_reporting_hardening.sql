-- Migration: 20261030120000_sales_invoice_canonical_lifecycle_and_reporting_hardening.sql
-- Description:
-- 1. Introduces structured document_status on sales_invoices ('draft', 'posted', 'cancelled')
--    with cancellation metadata (cancelled_at, cancelled_by, cancellation_reason).
-- 2. Establishes single authoritative definition of reportable sales across the database.
-- 3. Creates active_sales_invoices and active_sales_invoice_items canonical views.
-- 4. Updates cancel_sales_invoice RPC to populate structured cancellation metadata.
-- 5. Updates create_sales_invoice_atomic and DC validation to respect document_status.
-- 6. Hardens all reporting functions (get_authoritative_sales_line_cogs, get_sales_profitability_summary,
--    get_sales_profitability_line_expenses, get_sales_profitability_product_batches,
--    get_sales_profitability_batch_orders, get_sales_profit_summary, get_sales_profit_drilldown,
--    get_customer_sales_report, get_product_performance_report, dc_invoicing_summary,
--    so_delivery_invoice_status, trg_dc_reverse_product_reservation_v2).
-- 7. Returns separate disclosure of excluded cancelled invoices in sales profitability summary.

BEGIN;

-- ==============================================================================
-- 1. Schema Enhancements on public.sales_invoices
-- ==============================================================================

ALTER TABLE public.sales_invoices
  ADD COLUMN IF NOT EXISTS document_status text NOT NULL DEFAULT 'posted'
  CHECK (document_status IN ('draft', 'posted', 'cancelled'));

ALTER TABLE public.sales_invoices
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;

ALTER TABLE public.sales_invoices
  ADD COLUMN IF NOT EXISTS cancelled_by uuid REFERENCES public.user_profiles(id);

ALTER TABLE public.sales_invoices
  ADD COLUMN IF NOT EXISTS cancellation_reason text;

CREATE INDEX IF NOT EXISTS idx_sales_invoices_document_status
  ON public.sales_invoices(document_status, invoice_date);

-- Safe historical backfill
UPDATE public.sales_invoices
SET document_status = 'draft'
WHERE is_draft = true;

UPDATE public.sales_invoices
SET document_status = 'cancelled',
    cancelled_at = COALESCE(updated_at, created_at),
    cancellation_reason = COALESCE(notes, 'Historical cancellation')
WHERE COALESCE(is_draft, false) = false
  AND (notes LIKE '[CANCELLED%' OR LOWER(notes) LIKE 'cancelled%');

UPDATE public.sales_invoices
SET document_status = 'posted'
WHERE document_status IS NULL;

-- Two-way synchronization trigger between is_draft and document_status
CREATE OR REPLACE FUNCTION public.trg_sync_sales_invoice_document_status()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.document_status = 'draft' THEN
    NEW.is_draft := true;
  ELSIF NEW.document_status IN ('posted', 'cancelled') THEN
    NEW.is_draft := false;
  ELSIF NEW.is_draft = true THEN
    NEW.document_status := 'draft';
  ELSE
    NEW.document_status := 'posted';
  END IF;

  IF NEW.document_status = 'cancelled' AND NEW.cancelled_at IS NULL THEN
    NEW.cancelled_at := now();
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
-- 2. Canonical Views & Helper Function
-- ==============================================================================

CREATE OR REPLACE VIEW public.active_sales_invoices WITH (security_invoker = true) AS
SELECT *
FROM public.sales_invoices
WHERE document_status = 'posted'
  AND is_draft = false;

CREATE OR REPLACE VIEW public.active_sales_invoice_items WITH (security_invoker = true) AS
SELECT sii.*
FROM public.sales_invoice_items sii
JOIN public.sales_invoices si ON si.id = sii.invoice_id
WHERE si.document_status = 'posted'
  AND si.is_draft = false;

GRANT SELECT ON public.active_sales_invoices TO authenticated, service_role;
GRANT SELECT ON public.active_sales_invoice_items TO authenticated, service_role;

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
    AND NOT (COALESCE(p_notes, '') ILIKE '[CANCELLED%');
$$;

GRANT EXECUTE ON FUNCTION public.is_reportable_sales_invoice(text, boolean, text) TO authenticated, service_role;

-- ==============================================================================
-- 3. Hardened cancel_sales_invoice RPC
-- ==============================================================================

CREATE OR REPLACE FUNCTION public.cancel_sales_invoice(
  p_invoice_id uuid,
  p_reason text DEFAULT NULL,
  p_actor uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_caller uuid := COALESCE(auth.uid(), p_actor);
  v_role text;
  v_inv record;
  v_alloc_paid numeric := 0;
  v_adj_paid numeric := 0;
  v_reason text;
  v_rev_count int := 0;
  v_cogs_count int := 0;
  v_updated_notes text;
  v_je record;
  v_period_id uuid;
  v_rev_entry text;
  v_reversal_id uuid;
BEGIN
  -- Permission check: only admin and accounts can cancel financially posted invoices
  IF v_caller IS NOT NULL THEN
    SELECT role INTO v_role FROM public.user_profiles WHERE id = v_caller;
    IF v_role NOT IN ('admin', 'accounts') THEN
      RAISE EXCEPTION 'Permission denied: role % cannot cancel sales invoices', v_role;
    END IF;
  END IF;

  -- Lock invoice row
  SELECT * INTO v_inv
  FROM public.sales_invoices
  WHERE id = p_invoice_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sales invoice % not found', p_invoice_id;
  END IF;

  -- Idempotency check: if already cancelled, return success without duplicate reversals
  IF v_inv.document_status = 'cancelled' OR v_inv.notes LIKE '[CANCELLED%' THEN
    RETURN jsonb_build_object(
      'success', true,
      'already_cancelled', true,
      'invoice_id', p_invoice_id,
      'invoice_number', v_inv.invoice_number,
      'document_status', 'cancelled',
      'cancelled_at', v_inv.cancelled_at,
      'reason', v_inv.cancellation_reason
    );
  END IF;

  -- Payment guard: check allocated receipts and adjustments
  SELECT COALESCE(SUM(allocated_amount), 0) INTO v_alloc_paid
  FROM public.voucher_allocations
  WHERE sales_invoice_id = p_invoice_id AND voucher_type = 'receipt';

  SELECT COALESCE(SUM(adjustment_amount), 0) INTO v_adj_paid
  FROM public.invoice_rounding_adjustments
  WHERE sales_invoice_id = p_invoice_id;

  IF (COALESCE(v_inv.paid_amount, 0) > 0.01 OR v_alloc_paid > 0.01 OR v_adj_paid > 0.01) THEN
    RAISE EXCEPTION 'Cannot cancel invoice %: payments of Rp % are allocated. Unallocate payments first.',
      v_inv.invoice_number, (COALESCE(v_inv.paid_amount, 0) + v_alloc_paid + v_adj_paid);
  END IF;

  v_reason := COALESCE(p_reason, '[CANCELLED on ' || CURRENT_DATE::text || ' by ' || COALESCE(v_role, 'Admin') || ']');

  -- 1. Reverse Revenue Journal Entries (Commercial AR, Sales, VAT Output, Stamp Duty)
  FOR v_je IN
    SELECT *
    FROM public.journal_entries
    WHERE is_posted = true
      AND COALESCE(is_reversed, false) = false
      AND (
        id = v_inv.journal_entry_id
        OR (reference_id = p_invoice_id AND source_module IN ('sales_invoice', 'sales', 'sales_invoices'))
        OR (reference_number = v_inv.invoice_number AND source_module IN ('sales_invoice', 'sales', 'sales_invoices'))
      )
    FOR UPDATE
  LOOP
    SELECT id INTO v_period_id
    FROM public.accounting_periods
    WHERE CURRENT_DATE BETWEEN start_date AND end_date
      AND status = 'open'
    LIMIT 1;
    IF v_period_id IS NULL THEN v_period_id := v_je.period_id; END IF;

    v_rev_entry := public.next_journal_entry_number();

    INSERT INTO public.journal_entries (
      entry_number, entry_date, period_id, source_module, reference_id,
      reference_number, description, total_debit, total_credit,
      is_posted, is_reversed, posted_by, posted_at, created_by, created_at,
      transaction_category, transaction_currency, functional_currency, exchange_rate, amounts_are_functional
    ) VALUES (
      v_rev_entry, CURRENT_DATE, v_period_id, v_je.source_module || '_cancellation', p_invoice_id,
      'CANCEL-' || v_inv.invoice_number,
      'Cancellation reversal of ' || v_je.entry_number || ': ' || v_reason,
      v_je.total_credit, v_je.total_debit,
      true, true, v_caller, now(), v_caller, now(),
      v_je.transaction_category, v_je.transaction_currency, v_je.functional_currency, v_je.exchange_rate, v_je.amounts_are_functional
    ) RETURNING id INTO v_reversal_id;

    INSERT INTO public.journal_entry_lines (
      journal_entry_id, line_number, account_id, description, debit, credit,
      tax_code_id, customer_id, supplier_id, batch_id, transaction_currency,
      transaction_debit, transaction_credit, functional_currency, exchange_rate, sales_invoice_item_id
    )
    SELECT
      v_reversal_id, line_number, account_id, 'CANCEL: ' || COALESCE(description, ''),
      credit, debit, tax_code_id, customer_id, supplier_id, batch_id, transaction_currency,
      transaction_credit, transaction_debit, functional_currency, exchange_rate, sales_invoice_item_id
    FROM public.journal_entry_lines
    WHERE journal_entry_id = v_je.id
    ORDER BY line_number;

    UPDATE public.journal_entries
    SET is_reversed = true,
        reversed_by_id = v_reversal_id,
        description = v_reason || ' ' || COALESCE(description, '')
    WHERE id = v_je.id;

    v_rev_count := v_rev_count + 1;
  END LOOP;

  -- 2. Reverse COGS Journal Entries (COGS Dr 5100, Inventory Cr 1130)
  FOR v_je IN
    SELECT *
    FROM public.journal_entries
    WHERE is_posted = true
      AND COALESCE(is_reversed, false) = false
      AND source_module = 'sales_invoice_cogs'
      AND (reference_id = p_invoice_id OR reference_number = v_inv.invoice_number)
    FOR UPDATE
  LOOP
    SELECT id INTO v_period_id
    FROM public.accounting_periods
    WHERE CURRENT_DATE BETWEEN start_date AND end_date
      AND status = 'open'
    LIMIT 1;
    IF v_period_id IS NULL THEN v_period_id := v_je.period_id; END IF;

    v_rev_entry := public.next_journal_entry_number();

    INSERT INTO public.journal_entries (
      entry_number, entry_date, period_id, source_module, reference_id,
      reference_number, description, total_debit, total_credit,
      is_posted, is_reversed, posted_by, posted_at, created_by, created_at,
      transaction_category, transaction_currency, functional_currency, exchange_rate, amounts_are_functional
    ) VALUES (
      v_rev_entry, CURRENT_DATE, v_period_id, 'sales_invoice_cogs_cancellation', p_invoice_id,
      'CANCEL-' || v_inv.invoice_number || '-COGS',
      'Cancellation reversal of COGS ' || v_je.entry_number || ': ' || v_reason,
      v_je.total_credit, v_je.total_debit,
      true, true, v_caller, now(), v_caller, now(),
      v_je.transaction_category, v_je.transaction_currency, v_je.functional_currency, v_je.exchange_rate, v_je.amounts_are_functional
    ) RETURNING id INTO v_reversal_id;

    INSERT INTO public.journal_entry_lines (
      journal_entry_id, line_number, account_id, description, debit, credit,
      tax_code_id, customer_id, supplier_id, batch_id, transaction_currency,
      transaction_debit, transaction_credit, functional_currency, exchange_rate, sales_invoice_item_id
    )
    SELECT
      v_reversal_id, line_number, account_id, 'CANCEL: ' || COALESCE(description, ''),
      credit, debit, tax_code_id, customer_id, supplier_id, batch_id, transaction_currency,
      transaction_credit, transaction_debit, functional_currency, exchange_rate, sales_invoice_item_id
    FROM public.journal_entry_lines
    WHERE journal_entry_id = v_je.id
    ORDER BY line_number;

    UPDATE public.journal_entries
    SET is_reversed = true,
        reversed_by_id = v_reversal_id,
        description = v_reason || ' ' || COALESCE(description, '') || ' COGS'
    WHERE id = v_je.id;

    v_cogs_count := v_cogs_count + 1;
  END LOOP;

  -- 3. Release Delivery Challan link while preserving invoice line items for viewing
  PERFORM set_config('app.sales_invoice_cancel', 'true', true);
  UPDATE public.sales_invoice_items
  SET delivery_challan_item_id = NULL
  WHERE invoice_id = p_invoice_id;
  PERFORM set_config('app.sales_invoice_cancel', 'false', true);

  -- 4. Update sales invoice header with canonical status & audit metadata
  v_updated_notes := CASE
    WHEN v_inv.notes IS NULL OR v_inv.notes = '' THEN v_reason
    WHEN v_inv.notes LIKE '[CANCELLED%' THEN v_inv.notes
    ELSE v_reason || E'\n' || v_inv.notes
  END;

  UPDATE public.sales_invoices
  SET document_status = 'cancelled',
      cancelled_at = now(),
      cancelled_by = v_caller,
      cancellation_reason = v_reason,
      notes = v_updated_notes,
      balance_amount = 0,
      updated_at = now()
  WHERE id = p_invoice_id;

  RETURN jsonb_build_object(
    'success', true,
    'invoice_id', p_invoice_id,
    'invoice_number', v_inv.invoice_number,
    'document_status', 'cancelled',
    'cancelled_at', now(),
    'cancelled_by', v_caller,
    'reason', v_reason,
    'reversed_revenue_journals', v_rev_count,
    'reversed_cogs_journals', v_cogs_count
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.cancel_sales_invoice(uuid, text, uuid) TO authenticated, service_role;

-- ==============================================================================
-- 4. Hardened create_sales_invoice_atomic
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
    SELECT dci.product_id,dci.batch_id,dci.quantity,dc.customer_id,dc.approval_status,dc.sales_order_id
      INTO v_dc
    FROM public.delivery_challan_items dci
    JOIN public.delivery_challans dc ON dc.id=dci.challan_id
    WHERE dci.id=v_dc_item
    FOR SHARE;
    IF NOT FOUND OR v_dc.product_id IS DISTINCT FROM v_product OR v_dc.batch_id IS DISTINCT FROM v_batch
       OR v_dc.customer_id IS DISTINCT FROM (p_invoice->>'customer_id')::uuid
       OR v_dc.approval_status <> 'approved' THEN
      RAISE EXCEPTION 'Invoice line source Delivery Challan is invalid or not approved';
    END IF;
    IF v_invoice_so_id IS NOT NULL AND v_dc.sales_order_id IS DISTINCT FROM v_invoice_so_id THEN
      RAISE EXCEPTION 'Invoice Sales Order does not match its Delivery Challan source';
    END IF;
    -- Exclude cancelled invoices from consumed Delivery Challan quantity
    IF v_qty > v_dc.quantity - COALESCE((SELECT sum(sii.quantity)
      FROM public.sales_invoice_items sii
      JOIN public.sales_invoices si ON si.id = sii.invoice_id
      WHERE sii.delivery_challan_item_id = v_dc_item
        AND COALESCE(si.document_status, 'posted') = 'posted'
        AND NOT COALESCE(si.is_draft, false)
        AND NOT (COALESCE(si.notes, '') LIKE '[CANCELLED%'
                 OR LOWER(COALESCE(si.notes, '')) LIKE 'cancelled%')), 0) THEN
      RAISE EXCEPTION 'Invoice quantity exceeds remaining Delivery Challan quantity';
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
    invoice_number,customer_id,sales_order_id,invoice_date,due_date,discount_amount,
    delivery_challan_number,po_number,payment_terms_days,notes,subtotal,tax_amount,
    stamp_duty_amount,total_amount,payment_status,created_by,linked_challan_ids,document_status
  ) VALUES (
    p_invoice->>'invoice_number',(p_invoice->>'customer_id')::uuid,v_invoice_so_id,
    COALESCE((p_invoice->>'invoice_date')::date,CURRENT_DATE),(p_invoice->>'due_date')::date,v_discount,
    NULL,p_invoice->>'po_number',(p_invoice->>'payment_terms_days')::integer,p_invoice->>'notes',
    v_subtotal,v_tax,v_stamp,v_total,'pending',COALESCE(NULLIF(p_invoice->>'created_by','')::uuid,auth.uid()),
    COALESCE(v_linked_challans, CASE WHEN jsonb_typeof(p_invoice->'linked_challan_ids')='array' THEN
      ARRAY(SELECT jsonb_array_elements_text(p_invoice->'linked_challan_ids')::uuid) ELSE NULL END),
    v_doc_status
  ) RETURNING id INTO v_invoice_id;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_items)
  LOOP
    INSERT INTO public.sales_invoice_items
      (invoice_id,product_id,batch_id,quantity,unit_price,tax_rate,delivery_challan_item_id)
    VALUES (v_invoice_id,(v_item->>'product_id')::uuid,NULLIF(v_item->>'batch_id','')::uuid,
      (v_item->>'quantity')::numeric,(v_item->>'unit_price')::numeric,
      COALESCE((v_item->>'tax_rate')::numeric,0),(v_item->>'delivery_challan_item_id')::uuid);
  END LOOP;

  IF (SELECT count(*) FROM public.sales_invoice_items WHERE invoice_id=v_invoice_id) <> v_count THEN
    RAISE EXCEPTION 'Invoice line count verification failed';
  END IF;
  RETURN v_invoice_id;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.create_sales_invoice_atomic(jsonb, jsonb) TO authenticated, service_role;

-- ==============================================================================
-- 5. Updated dc_invoicing_summary and so_delivery_invoice_status views
-- ==============================================================================

CREATE OR REPLACE VIEW public.dc_invoicing_summary WITH (security_invoker = true) AS
 SELECT dc.id AS challan_id,
    dc.challan_number,
    dc.customer_id,
    dc.challan_date,
    dc.approval_status,
    count(DISTINCT dci.id) AS total_items,
    count(DISTINCT
        CASE
            WHEN sii.id IS NULL THEN dci.id
            ELSE NULL::uuid
        END) AS not_invoiced_items,
    count(DISTINCT
        CASE
            WHEN sii.id IS NOT NULL THEN dci.id
            ELSE NULL::uuid
        END) AS invoiced_items,
    COALESCE(sum(dci.quantity), 0::numeric) AS total_quantity,
    COALESCE(sum(
        CASE
            WHEN sii.id IS NULL THEN dci.quantity
            ELSE 0::numeric
        END), 0::numeric) AS total_remaining_quantity,
    CASE
        WHEN count(DISTINCT sii.id) = 0 THEN 'not_invoiced'::text
        WHEN count(DISTINCT sii.id) < count(DISTINCT dci.id) THEN 'partially_invoiced'::text
        ELSE 'fully_invoiced'::text
    END AS dc_status,
    COALESCE(array_agg(DISTINCT si.invoice_number) FILTER (WHERE si.invoice_number IS NOT NULL), ARRAY[]::text[]) AS linked_invoices,
    COALESCE(array_agg(DISTINCT si.invoice_number) FILTER (WHERE si.invoice_number IS NOT NULL), ARRAY[]::text[]) AS linked_invoice_numbers
   FROM public.delivery_challans dc
     LEFT JOIN public.delivery_challan_items dci ON dc.id = dci.challan_id
     LEFT JOIN (
       public.sales_invoice_items sii
       JOIN public.sales_invoices si ON si.id = sii.invoice_id
         AND COALESCE(si.document_status, 'posted') = 'posted'
         AND NOT COALESCE(si.is_draft, false)
         AND NOT (si.notes LIKE '[CANCELLED%' OR LOWER(si.notes) LIKE 'cancelled%')
     ) ON sii.delivery_challan_item_id = dci.id
  WHERE dc.approval_status = 'approved'::public.dc_approval_status
  GROUP BY dc.id, dc.challan_number, dc.customer_id, dc.challan_date, dc.approval_status;

GRANT SELECT ON public.dc_invoicing_summary TO authenticated, service_role;

CREATE OR REPLACE VIEW public.so_delivery_invoice_status WITH (security_invoker = true) AS
 WITH ordered AS (
   SELECT soi.sales_order_id AS so_id,
          COALESCE(sum(soi.quantity), 0::numeric) AS ordered_qty
   FROM public.sales_order_items soi
   GROUP BY soi.sales_order_id
 ),
 approved_delivery AS (
   SELECT dc.sales_order_id AS so_id,
          COALESCE(sum(dci.quantity), 0::numeric) AS approved_delivered_qty,
          count(DISTINCT dc.id) AS approved_dc_count
   FROM public.delivery_challans dc
     JOIN public.delivery_challan_items dci ON dci.challan_id = dc.id
   WHERE dc.approval_status = 'approved'::public.dc_approval_status
     AND dc.sales_order_id IS NOT NULL
   GROUP BY dc.sales_order_id
 ),
 invoice_items_by_so AS (
   SELECT DISTINCT sii.id AS invoice_item_id,
          COALESCE(si.sales_order_id, dc.sales_order_id) AS so_id,
          sii.quantity
   FROM public.sales_invoice_items sii
     JOIN public.sales_invoices si ON si.id = sii.invoice_id
     LEFT JOIN public.delivery_challan_items dci ON dci.id = sii.delivery_challan_item_id
     LEFT JOIN public.delivery_challans dc ON dc.id = dci.challan_id
   WHERE COALESCE(si.is_draft, false) = false
     AND COALESCE(si.document_status, 'posted') = 'posted'
     AND si.invoice_number !~~* 'TEST-COGS-%'::text
     AND NOT (si.notes LIKE '[CANCELLED%' OR LOWER(si.notes) LIKE 'cancelled%')
     AND COALESCE(si.sales_order_id, dc.sales_order_id) IS NOT NULL
 ),
 invoiced AS (
   SELECT i_1.so_id,
          COALESCE(sum(i_1.quantity), 0::numeric) AS invoiced_qty,
          count(DISTINCT i_1.invoice_item_id) AS invoice_count
   FROM invoice_items_by_so i_1
   GROUP BY i_1.so_id
 )
 SELECT so.id AS so_id,
    so.so_number,
    so.customer_id,
    so.status AS so_status,
    CASE
        WHEN (COALESCE(ad.approved_delivered_qty, 0::numeric) = 0::numeric) THEN 'pending'::text
        WHEN (COALESCE(ad.approved_delivered_qty, 0::numeric) >= COALESCE(o.ordered_qty, 0::numeric) AND COALESCE(o.ordered_qty, 0::numeric) > 0::numeric) THEN 'completed'::text
        ELSE 'partial'::text
    END AS delivery_status,
    CASE
        WHEN (COALESCE(inv.invoiced_qty, 0::numeric) = 0::numeric) THEN 'pending'::text
        WHEN (COALESCE(inv.invoiced_qty, 0::numeric) >= COALESCE(o.ordered_qty, 0::numeric) AND COALESCE(o.ordered_qty, 0::numeric) > 0::numeric) THEN 'completed'::text
        ELSE 'partial'::text
    END AS invoice_status,
    COALESCE(o.ordered_qty, 0::numeric) AS ordered_quantity,
    COALESCE(ad.approved_delivered_qty, 0::numeric) AS delivered_quantity,
    COALESCE(inv.invoiced_qty, 0::numeric) AS invoiced_quantity,
    COALESCE(ad.approved_dc_count, 0::bigint) AS approved_dc_count,
    COALESCE(inv.invoice_count, 0::bigint) AS invoice_count
   FROM public.sales_orders so
     LEFT JOIN ordered o ON o.so_id = so.id
     LEFT JOIN approved_delivery ad ON ad.so_id = so.id
     LEFT JOIN invoiced inv ON inv.so_id = so.id;

GRANT SELECT ON public.so_delivery_invoice_status TO authenticated, service_role;

-- ==============================================================================
-- 6. Updated DC Reversal Trigger trg_dc_reverse_product_reservation_v2
-- ==============================================================================

CREATE OR REPLACE FUNCTION public.trg_dc_reverse_product_reservation_v2()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  r record;
  v_blocking_invoices text;
BEGIN
  IF OLD.approval_status = 'approved' AND NEW.approval_status IN ('rejected', 'cancelled') THEN
    -- Only block DC reversal if there is an active (uncancelled) invoice item referencing it
    SELECT string_agg(DISTINCT si.invoice_number, ', ')
    INTO v_blocking_invoices
    FROM public.sales_invoice_items sii
    JOIN public.delivery_challan_items dci ON dci.id = sii.delivery_challan_item_id
    JOIN public.sales_invoices si ON si.id = sii.invoice_id
    WHERE dci.challan_id = NEW.id
      AND COALESCE(si.document_status, 'posted') = 'posted'
      AND NOT COALESCE(si.is_draft, false)
      AND NOT (si.notes LIKE '[CANCELLED%' OR LOWER(si.notes) LIKE 'cancelled%');

    IF v_blocking_invoices IS NOT NULL AND v_blocking_invoices <> '' THEN
      RAISE EXCEPTION 'Approved Delivery Challan % already invoiced by active invoice(s) %; reverse or cancel the invoice(s) first',
        COALESCE(NEW.challan_number, NEW.id::text), v_blocking_invoices;
    END IF;

    -- Reverse consumed allocations and restore inventory
    FOR r IN
      SELECT dci.*, a.id AS allocation_id
      FROM public.delivery_challan_items dci
      JOIN public.dc_batch_allocations a ON a.delivery_challan_item_id = dci.id AND a.status = 'consumed'
      WHERE dci.challan_id = NEW.id
      ORDER BY dci.id
      FOR UPDATE OF a
    LOOP
      PERFORM public.post_inventory_movement(
        public.uuid_from_text('inventory-v2:dc-reversal:' || NEW.id || ':' || r.id),
        r.product_id,
        r.batch_id,
        'adjustment',
        r.quantity,
        CURRENT_DATE,
        NEW.challan_number,
        'delivery_challan_reversal',
        NEW.id,
        'Reversal of product-reservation DC batch allocation',
        COALESCE(NEW.rejected_by, auth.uid()),
        NULL,
        NULL
      );
      UPDATE public.dc_batch_allocations
      SET status = 'reversed',
          reversed_at = now(),
          reversal_reason = NEW.approval_status
      WHERE id = r.allocation_id;
    END LOOP;

    -- Fallback for legacy DC items without dc_batch_allocations
    FOR r IN
      SELECT dci.*
      FROM public.delivery_challan_items dci
      WHERE dci.challan_id = NEW.id
        AND NOT EXISTS (
          SELECT 1 FROM public.dc_batch_allocations a
          WHERE a.delivery_challan_item_id = dci.id
        )
      ORDER BY dci.id
    LOOP
      PERFORM public.post_inventory_movement(
        public.uuid_from_text('inventory-v1:dc-reversal:' || NEW.id || ':' || r.id || ':' || NEW.approval_status),
        r.product_id,
        r.batch_id,
        'adjustment',
        r.quantity,
        CURRENT_DATE,
        NEW.challan_number,
        'delivery_challan_reversal',
        NEW.id,
        'Canonical reversal of DC ' || NEW.challan_number || ' (' || NEW.approval_status || ')',
        COALESCE(NEW.rejected_by, auth.uid()),
        NULL,
        NULL
      );
    END LOOP;

  END IF;
  RETURN NEW;
END;
$$;

-- ==============================================================================
-- 7. Hardened SQL Reporting Functions
-- ==============================================================================

-- 7.1 get_authoritative_sales_line_cogs: exclude cancelled invoices
CREATE OR REPLACE FUNCTION public.get_authoritative_sales_line_cogs(p_start_date date, p_end_date date)
 RETURNS TABLE(
   line_id uuid,
   invoice_id uuid,
   product_id uuid,
   batch_id uuid,
   quantity numeric,
   authoritative_cogs numeric,
   authoritative_unit_cogs numeric,
   resolution_tier text,
   invoice_line_count bigint,
   invoice_product_count bigint,
   posted_invoice_cogs numeric,
   base_line_cost numeric,
   reconciliation_difference numeric
 )
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
WITH active_cogs AS (
  SELECT je.reference_id AS invoice_id, je.id AS journal_id,
         SUM(jel.debit - jel.credit) AS cogs_amount
  FROM public.journal_entries je
  JOIN public.journal_entry_lines jel ON jel.journal_entry_id = je.id
  JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
  WHERE je.is_posted = true
    AND NOT COALESCE(je.is_reversed, false)
    AND coa.code = '5100'
    AND je.reference_id IS NOT NULL
    AND (
      je.source_module IN ('sales_invoice_cogs', 'sales_invoice_cogs_adjustment')
      OR je.source_module IN ('historical_cogs_correction', 'historical_cogs_final_correction')
      OR je.source_module LIKE 'historical_cogs%'
      OR je.source_module LIKE '%cogs%'
    )
  GROUP BY je.reference_id, je.id
), posted_cogs AS (
  SELECT invoice_id, SUM(cogs_amount) AS posted_invoice_cogs
  FROM active_cogs GROUP BY invoice_id
), posted_item_cogs AS (
  SELECT jel.sales_invoice_item_id AS line_id,
         SUM(jel.debit - jel.credit) AS posted_item_cogs
  FROM public.journal_entries je
  JOIN public.journal_entry_lines jel ON jel.journal_entry_id = je.id
  JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
  WHERE je.is_posted = true AND NOT COALESCE(je.is_reversed, false)
    AND coa.code = '5100' AND jel.sales_invoice_item_id IS NOT NULL
    AND (
      je.source_module IN ('sales_invoice_cogs', 'sales_invoice_cogs_adjustment')
      OR je.source_module IN ('historical_cogs_correction', 'historical_cogs_final_correction')
      OR je.source_module LIKE 'historical_cogs%'
      OR je.source_module LIKE '%cogs%'
    )
  GROUP BY jel.sales_invoice_item_id
), line_basis AS (
  SELECT sii.id AS line_id, sii.invoice_id, sii.product_id, sii.batch_id,
         sii.quantity,
         pic.posted_item_cogs,
         sii.cogs_total_cost AS snapshot_cogs,
         sii.cogs_unit_cost AS snapshot_unit_cogs,
         CASE 
           WHEN b.id IS NOT NULL 
           THEN public.calculate_batch_authoritative_cost(b)
           ELSE NULL 
         END AS batch_authoritative_unit_cost,
         CASE 
           WHEN b.id IS NOT NULL 
           THEN ROUND(sii.quantity * public.calculate_batch_authoritative_cost(b), 2)
           WHEN COALESCE(NULLIF(b.landed_cost_per_unit, 0), NULLIF(b.cost_per_unit, 0), NULLIF(b.import_price, 0)) IS NOT NULL
           THEN ROUND(sii.quantity * COALESCE(NULLIF(b.landed_cost_per_unit, 0), NULLIF(b.cost_per_unit, 0), NULLIF(b.import_price, 0)), 2)
           ELSE NULL 
         END AS base_line_cost,
         pc.posted_invoice_cogs
  FROM public.sales_invoice_items sii
  JOIN public.sales_invoices si ON si.id = sii.invoice_id
  LEFT JOIN public.batches b ON b.id = sii.batch_id
  LEFT JOIN posted_cogs pc ON pc.invoice_id = sii.invoice_id
  LEFT JOIN posted_item_cogs pic ON pic.line_id = sii.id
  WHERE si.invoice_date BETWEEN p_start_date AND p_end_date
    AND NOT COALESCE(si.is_draft, false)
    AND COALESCE(si.document_status, 'posted') = 'posted'
    AND NOT (COALESCE(si.notes, '') LIKE '[CANCELLED%' OR LOWER(COALESCE(si.notes, '')) LIKE 'cancelled%')
), invoice_evidence AS (
  SELECT invoice_id,
         COUNT(*) AS invoice_line_count,
         COUNT(DISTINCT product_id) AS invoice_product_count,
         COUNT(*) FILTER (WHERE base_line_cost IS NULL AND snapshot_cogs IS NULL) AS unresolved_line_count,
         COUNT(*) FILTER (WHERE base_line_cost IS NULL AND snapshot_cogs IS NULL AND base_line_cost IS NOT NULL) AS unresolved_base_line_count,
         COALESCE(SUM(COALESCE(base_line_cost, snapshot_cogs)), 0) AS resolved_cogs_total,
         SUM(base_line_cost) FILTER (WHERE base_line_cost IS NULL AND snapshot_cogs IS NULL) AS unresolved_base_cost_total,
         MAX(posted_invoice_cogs) AS posted_invoice_cogs
  FROM line_basis GROUP BY invoice_id
), resolved AS (
  SELECT lb.*, ie.invoice_line_count, ie.invoice_product_count,
         ie.unresolved_line_count, ie.unresolved_base_line_count,
         ie.resolved_cogs_total, ie.unresolved_base_cost_total,
         ie.posted_invoice_cogs AS invoice_posted_cogs,
         ie.posted_invoice_cogs - ie.resolved_cogs_total AS residual_posted_cogs,
         ABS(ie.unresolved_base_cost_total - (ie.posted_invoice_cogs - ie.resolved_cogs_total)) AS reconciliation_difference
  FROM line_basis lb JOIN invoice_evidence ie ON ie.invoice_id = lb.invoice_id
)
SELECT r.line_id, r.invoice_id, r.product_id, r.batch_id, r.quantity,
  CASE
    WHEN r.base_line_cost IS NOT NULL AND r.base_line_cost > 0 THEN r.base_line_cost
    WHEN r.snapshot_cogs IS NOT NULL AND r.snapshot_cogs > 0 THEN r.snapshot_cogs
    WHEN r.invoice_line_count = 1 AND r.invoice_posted_cogs IS NOT NULL AND r.invoice_posted_cogs > 0 THEN r.invoice_posted_cogs
    WHEN r.invoice_line_count > 1 AND r.invoice_posted_cogs IS NOT NULL
      AND r.unresolved_line_count = r.unresolved_base_line_count
      AND r.unresolved_base_cost_total > 0
      THEN r.base_line_cost * (r.residual_posted_cogs / r.unresolved_base_cost_total)
    WHEN r.posted_item_cogs IS NOT NULL AND r.posted_item_cogs > 0 THEN r.posted_item_cogs
    WHEN r.base_line_cost IS NOT NULL THEN r.base_line_cost
    WHEN r.snapshot_cogs IS NOT NULL THEN r.snapshot_cogs
    ELSE NULL 
  END AS authoritative_cogs,
  CASE
    WHEN r.quantity = 0 THEN NULL
    WHEN r.base_line_cost IS NOT NULL AND r.base_line_cost > 0 THEN r.base_line_cost / r.quantity
    WHEN r.snapshot_cogs IS NOT NULL AND r.snapshot_cogs > 0 THEN r.snapshot_cogs / r.quantity
    WHEN r.invoice_line_count = 1 AND r.invoice_posted_cogs IS NOT NULL AND r.invoice_posted_cogs > 0 THEN r.invoice_posted_cogs / r.quantity
    WHEN r.invoice_line_count > 1 AND r.invoice_posted_cogs IS NOT NULL
      AND r.unresolved_line_count = r.unresolved_base_line_count
      AND r.unresolved_base_cost_total > 0
      THEN (r.base_line_cost * (r.residual_posted_cogs / r.unresolved_base_cost_total)) / r.quantity
    WHEN r.posted_item_cogs IS NOT NULL AND r.posted_item_cogs > 0 THEN r.posted_item_cogs / r.quantity
    WHEN r.base_line_cost IS NOT NULL THEN r.base_line_cost / r.quantity
    WHEN r.snapshot_cogs IS NOT NULL THEN r.snapshot_cogs / r.quantity
    ELSE NULL 
  END AS authoritative_unit_cogs,
  CASE
    WHEN r.base_line_cost IS NOT NULL AND r.base_line_cost > 0 THEN 'canonical_batch_cost'
    WHEN r.snapshot_cogs IS NOT NULL AND r.snapshot_cogs > 0 THEN 'snapshot'
    WHEN r.invoice_line_count = 1 AND r.invoice_posted_cogs IS NOT NULL AND r.invoice_posted_cogs > 0 THEN 'single_line_posted_cogs'
    WHEN r.invoice_line_count > 1 AND r.invoice_product_count = 1 AND r.invoice_posted_cogs IS NOT NULL
      AND r.unresolved_line_count = r.unresolved_base_line_count AND r.unresolved_base_cost_total > 0 THEN 'single_product_proven_allocation'
    WHEN r.invoice_line_count > 1 AND r.invoice_product_count > 1 AND r.invoice_posted_cogs IS NOT NULL
      AND r.unresolved_line_count = r.unresolved_base_line_count AND r.unresolved_base_cost_total > 0 THEN 'multi_product_proven_allocation'
    WHEN r.posted_item_cogs IS NOT NULL AND r.posted_item_cogs > 0 THEN 'posted_item_cogs'
    WHEN r.base_line_cost IS NOT NULL THEN 'canonical_batch_cost'
    WHEN r.snapshot_cogs IS NOT NULL THEN 'snapshot'
    ELSE 'unresolved' 
  END AS resolution_tier,
  r.invoice_line_count, r.invoice_product_count, r.invoice_posted_cogs,
  r.base_line_cost, r.reconciliation_difference
FROM resolved r;
$function$;

GRANT EXECUTE ON FUNCTION public.get_authoritative_sales_line_cogs(date, date) TO authenticated, service_role;

-- 7.2 get_sales_profitability_line_expenses: exclude cancelled invoices
CREATE OR REPLACE FUNCTION public.get_sales_profitability_line_expenses(
  p_start_date date,
  p_end_date date
)
RETURNS TABLE(line_id uuid, sales_expense numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
WITH scoped AS (
  SELECT sii.id AS line_id,
         dci.challan_id AS dc_id,
         si.sales_order_id AS so_id,
         ROUND(sii.quantity * sii.unit_price, 2) AS line_sales,
         sii.quantity
  FROM public.sales_invoice_items sii
  JOIN public.sales_invoices si ON si.id = sii.invoice_id
  LEFT JOIN public.delivery_challan_items dci ON dci.id = sii.delivery_challan_item_id
  WHERE si.invoice_date BETWEEN p_start_date AND p_end_date
    AND NOT COALESCE(si.is_draft, false)
    AND COALESCE(si.document_status, 'posted') = 'posted'
    AND NOT (COALESCE(si.notes, '') LIKE '[CANCELLED%' OR LOWER(COALESCE(si.notes, '')) LIKE 'cancelled%')
),
dc_totals AS (
  SELECT dci.challan_id AS dc_id,
         SUM(ROUND(sii.quantity * sii.unit_price, 2)) AS total_sales,
         SUM(sii.quantity) AS total_qty
  FROM public.sales_invoice_items sii
  JOIN public.sales_invoices si ON si.id = sii.invoice_id
  JOIN public.delivery_challan_items dci ON dci.id = sii.delivery_challan_item_id
  WHERE NOT COALESCE(si.is_draft, false)
    AND COALESCE(si.document_status, 'posted') = 'posted'
    AND NOT (COALESCE(si.notes, '') LIKE '[CANCELLED%' OR LOWER(COALESCE(si.notes, '')) LIKE 'cancelled%')
    AND dci.challan_id IN (SELECT DISTINCT dc_id FROM scoped WHERE dc_id IS NOT NULL)
  GROUP BY dci.challan_id
),
dc_expenses AS (
  SELECT fe.delivery_challan_id AS dc_id, SUM(fe.amount) AS total_expense
  FROM public.finance_expenses fe
  WHERE (
      fe.expense_category IN ('delivery_sales', 'loading_sales', 'marketing_advertising', 'other_sales')
      OR EXISTS (
        SELECT 1 FROM public.expense_categories ec
        WHERE ec.category_key = fe.expense_category
          AND ec.category_type = 'sales'
      )
    )
    AND fe.approval_status = 'approved'
    AND fe.delivery_challan_id IN (SELECT DISTINCT dc_id FROM scoped WHERE dc_id IS NOT NULL)
  GROUP BY fe.delivery_challan_id
),
so_totals AS (
  SELECT si.sales_order_id AS so_id,
         SUM(ROUND(sii.quantity * sii.unit_price, 2)) AS total_sales,
         SUM(sii.quantity) AS total_qty
  FROM public.sales_invoice_items sii
  JOIN public.sales_invoices si ON si.id = sii.invoice_id
  WHERE NOT COALESCE(si.is_draft, false)
    AND COALESCE(si.document_status, 'posted') = 'posted'
    AND NOT (COALESCE(si.notes, '') LIKE '[CANCELLED%' OR LOWER(COALESCE(si.notes, '')) LIKE 'cancelled%')
    AND si.sales_order_id IN (SELECT DISTINCT so_id FROM scoped WHERE so_id IS NOT NULL)
  GROUP BY si.sales_order_id
),
so_allocated_expenses AS (
  SELECT
    (alloc->>'sales_order_id')::uuid AS so_id,
    SUM(COALESCE((alloc->>'allocated_amount')::numeric, 0)) AS total_allocated_expense
  FROM public.finance_expenses fe,
       jsonb_array_elements(fe.sales_order_allocations) AS alloc
  WHERE (
      fe.expense_category IN ('delivery_sales', 'loading_sales', 'marketing_advertising', 'other_sales')
      OR EXISTS (
        SELECT 1 FROM public.expense_categories ec
        WHERE ec.category_key = fe.expense_category
          AND ec.category_type = 'sales'
      )
    )
    AND fe.approval_status = 'approved'
    AND fe.sales_order_allocations IS NOT NULL
    AND jsonb_typeof(fe.sales_order_allocations) = 'array'
    AND (alloc->>'sales_order_id')::uuid IN (SELECT DISTINCT so_id FROM scoped WHERE so_id IS NOT NULL)
  GROUP BY (alloc->>'sales_order_id')::uuid
),
so_direct_expenses AS (
  SELECT fe.sales_order_id AS so_id, SUM(fe.amount) AS total_expense
  FROM public.finance_expenses fe
  WHERE (
      fe.expense_category IN ('delivery_sales', 'loading_sales', 'marketing_advertising', 'other_sales')
      OR EXISTS (
        SELECT 1 FROM public.expense_categories ec
        WHERE ec.category_key = fe.expense_category
          AND ec.category_type = 'sales'
      )
    )
    AND fe.approval_status = 'approved'
    AND fe.sales_order_id IN (SELECT DISTINCT so_id FROM scoped WHERE so_id IS NOT NULL)
    AND (fe.sales_order_allocations IS NULL OR fe.sales_order_allocations = '[]'::jsonb)
  GROUP BY fe.sales_order_id
)
SELECT
  s.line_id,
  ROUND(
    COALESCE(
      CASE WHEN COALESCE(dct.total_sales, 0) > 0 THEN (s.line_sales / dct.total_sales) * dce.total_expense
           WHEN COALESCE(dct.total_qty, 0) > 0 THEN (s.quantity / dct.total_qty) * dce.total_expense
           ELSE 0 END, 0
    ) +
    COALESCE(
      CASE WHEN COALESCE(sot.total_sales, 0) > 0 THEN (s.line_sales / sot.total_sales) * soa.total_allocated_expense
           WHEN COALESCE(sot.total_qty, 0) > 0 THEN (s.quantity / sot.total_qty) * soa.total_allocated_expense
           ELSE 0 END, 0
    ) +
    COALESCE(
      CASE WHEN COALESCE(sot.total_sales, 0) > 0 THEN (s.line_sales / sot.total_sales) * sod.total_expense
           WHEN COALESCE(sot.total_qty, 0) > 0 THEN (s.quantity / sot.total_qty) * sod.total_expense
           ELSE 0 END, 0
    ),
    2
  ) AS sales_expense
FROM scoped s
LEFT JOIN dc_totals dct ON dct.dc_id = s.dc_id
LEFT JOIN dc_expenses dce ON dce.dc_id = s.dc_id
LEFT JOIN so_totals sot ON sot.so_id = s.so_id
LEFT JOIN so_allocated_expenses soa ON soa.so_id = s.so_id
LEFT JOIN so_direct_expenses sod ON sod.so_id = s.so_id;
$$;

GRANT EXECUTE ON FUNCTION public.get_sales_profitability_line_expenses(date, date) TO authenticated, service_role;

-- 7.3 get_sales_profitability_summary: exclude cancelled invoices and return separate disclosure
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
    WHERE COALESCE(si.document_status, 'posted') = 'posted'
      AND NOT COALESCE(si.is_draft, false)
      AND NOT (COALESCE(si.notes, '') LIKE '[CANCELLED%' OR LOWER(COALESCE(si.notes, '')) LIKE 'cancelled%')
  ),
  cancelled_invoices_data AS (
    SELECT
      COUNT(DISTINCT si.id) AS cancelled_count,
      COALESCE(SUM(si.total_amount), 0) AS cancelled_total_amount,
      COALESCE(SUM(si.subtotal), 0) AS cancelled_subtotal,
      COALESCE(SUM(sii.quantity), 0) AS cancelled_total_qty
    FROM public.sales_invoices si
    LEFT JOIN public.sales_invoice_items sii ON sii.invoice_id = si.id
    WHERE si.invoice_date BETWEEN p_start_date AND p_end_date
      AND (
        si.document_status = 'cancelled'
        OR (COALESCE(si.notes, '') LIKE '[CANCELLED%' OR LOWER(COALESCE(si.notes, '')) LIKE 'cancelled%')
      )
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
  unallocated AS (
    SELECT COALESCE(SUM(fe.amount), 0) AS amount
    FROM public.finance_expenses fe
    WHERE (
        fe.expense_category IN ('delivery_sales', 'loading_sales', 'marketing_advertising', 'other_sales')
        OR EXISTS (
          SELECT 1 FROM public.expense_categories ec
          WHERE ec.category_key = fe.expense_category
            AND ec.category_type = 'sales'
        )
      )
      AND fe.approval_status = 'approved'
      AND fe.expense_date BETWEEN p_start_date AND p_end_date
      AND (fe.delivery_challan_id IS NULL OR NOT EXISTS (SELECT 1 FROM lines l WHERE l.dc_id = fe.delivery_challan_id))
  ),
  prod AS (
    SELECT
      l.product_id,
      MAX(l.product_name) AS product_name,
      MAX(l.product_code) AS product_code,
      MAX(l.product_unit) AS product_unit,
      COALESCE((SELECT SUM(b.current_stock) FROM public.batches b WHERE b.product_id = l.product_id AND b.is_active), 0) AS current_stock,
      SUM(l.quantity) - COALESCE(MAX(pr.return_qty), 0) AS sold_qty,
      SUM(l.line_gross_sales) - COALESCE(MAX(pr.return_revenue), 0) AS gross_sales,
      SUM(l.authoritative_cogs) - COALESCE(MAX(pr.return_cogs), 0) AS product_cost,
      SUM(l.line_sales_expense) AS sales_expense,
      ROUND((SUM(l.line_gross_sales) - COALESCE(MAX(pr.return_revenue), 0)) / NULLIF(SUM(l.quantity) - COALESCE(MAX(pr.return_qty), 0), 0), 2) AS avg_selling_price,
      ROUND(SUM(l.line_sales_expense) / NULLIF(SUM(l.quantity) - COALESCE(MAX(pr.return_qty), 0), 0), 2) AS sales_expense_per_unit,
      ROUND(((SUM(l.line_gross_sales) - COALESCE(MAX(pr.return_revenue), 0)) - SUM(l.line_sales_expense)) / NULLIF(SUM(l.quantity) - COALESCE(MAX(pr.return_qty), 0), 0), 2) AS net_selling_price_per_unit,
      COALESCE(
        ROUND((SUM(l.authoritative_cogs) - COALESCE(MAX(pr.return_cogs), 0)) / NULLIF(SUM(CASE WHEN l.authoritative_cogs IS NOT NULL THEN l.quantity ELSE 0 END) - COALESCE(MAX(pr.return_qty), 0), 0), 2),
        ROUND(SUM(l.quantity * l.batch_unit_cost) / NULLIF(SUM(l.quantity), 0), 2)
      ) AS avg_landed_cost,
      ROUND((SUM(l.line_gross_sales) - COALESCE(MAX(pr.return_revenue), 0)) - (SUM(l.authoritative_cogs) - COALESCE(MAX(pr.return_cogs), 0)), 2) AS gross_profit,
      ROUND((SUM(l.line_gross_sales) - COALESCE(MAX(pr.return_revenue), 0)) - (SUM(l.authoritative_cogs) - COALESCE(MAX(pr.return_cogs), 0)) - SUM(l.line_sales_expense), 2) AS profit_after_sales_expense,
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

-- 7.4 get_sales_profitability_product_batches: exclude cancelled invoices
CREATE OR REPLACE FUNCTION public.get_sales_profitability_product_batches(
  p_product_id uuid,
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
  WITH l AS (
    SELECT
      ar.*,
      sii.unit_price,
      ROUND(ar.quantity * sii.unit_price, 2) AS gross_sales,
      b.batch_number,
      b.current_stock,
      COALESCE(le.sales_expense, 0) AS sales_expense,
      b.import_price,
      b.import_price_usd,
      b.exchange_rate_usd_to_idr,
      b.duty_charges,
      b.freight_charges,
      b.other_charges,
      b.landed_cost_per_unit,
      b.cost_per_unit
    FROM public.get_authoritative_sales_line_cogs(p_start_date, p_end_date) ar
    JOIN public.sales_invoice_items sii ON sii.id = ar.line_id
    JOIN public.sales_invoices si ON si.id = ar.invoice_id
    LEFT JOIN public.batches b ON b.id = ar.batch_id
    LEFT JOIN public.get_sales_profitability_line_expenses(p_start_date, p_end_date) le ON le.line_id = ar.line_id
    WHERE ar.product_id = p_product_id
      AND COALESCE(si.document_status, 'posted') = 'posted'
      AND NOT COALESCE(si.is_draft, false)
      AND NOT (COALESCE(si.notes, '') LIKE '[CANCELLED%' OR LOWER(COALESCE(si.notes, '')) LIKE 'cancelled%')
  ),
  batch_returns AS (
    SELECT
      cni.batch_id,
      COALESCE(SUM(cni.total_price), 0) AS return_revenue,
      COALESCE(SUM(cni.quantity), 0) AS return_qty,
      COALESCE(SUM(public.get_credit_note_item_fifo_cogs(cni.id)), 0) AS return_cogs
    FROM public.credit_notes cn
    JOIN public.credit_note_items cni ON cni.credit_note_id = cn.id
    WHERE cn.status = 'approved'
      AND cni.product_id = p_product_id
      AND cn.credit_note_date BETWEEN p_start_date AND p_end_date
    GROUP BY cni.batch_id
  ),
  b AS (
    SELECT
      l.batch_id,
      COALESCE(l.batch_number, 'Unassigned Batch') AS batch_number,
      COALESCE(l.current_stock, 0) AS current_stock,
      SUM(l.quantity) - COALESCE(MAX(br.return_qty), 0) AS sold_qty,
      SUM(l.gross_sales) - COALESCE(MAX(br.return_revenue), 0) AS gross_sales,
      SUM(l.authoritative_cogs) - COALESCE(MAX(br.return_cogs), 0) AS product_cost,
      SUM(l.sales_expense) AS sales_expense,
      ROUND((SUM(l.gross_sales) - COALESCE(MAX(br.return_revenue), 0)) / NULLIF(SUM(l.quantity) - COALESCE(MAX(br.return_qty), 0), 0), 2) AS avg_selling_price,
      ROUND(SUM(l.sales_expense) / NULLIF(SUM(l.quantity) - COALESCE(MAX(br.return_qty), 0), 0), 2) AS sales_expense_per_unit,
      ROUND(((SUM(l.gross_sales) - COALESCE(MAX(br.return_revenue), 0)) - SUM(l.sales_expense)) / NULLIF(SUM(l.quantity) - COALESCE(MAX(br.return_qty), 0), 0), 2) AS net_selling_price_per_unit,
      COALESCE(
        ROUND((SUM(l.authoritative_cogs) - COALESCE(MAX(br.return_cogs), 0)) / NULLIF(SUM(CASE WHEN l.authoritative_cogs IS NOT NULL THEN l.quantity ELSE 0 END) - COALESCE(MAX(br.return_qty), 0), 0), 2),
        MAX(COALESCE(l.landed_cost_per_unit, l.cost_per_unit))
      ) AS cost_per_unit,
      ROUND((SUM(l.gross_sales) - COALESCE(MAX(br.return_revenue), 0)) - (SUM(l.authoritative_cogs) - COALESCE(MAX(br.return_cogs), 0)), 2) AS gross_profit,
      ROUND((SUM(l.gross_sales) - COALESCE(MAX(br.return_revenue), 0)) - (SUM(l.authoritative_cogs) - COALESCE(MAX(br.return_cogs), 0)) - SUM(l.sales_expense), 2) AS profit_after_sales_expense,
      ROUND(
        ((SUM(l.gross_sales) - COALESCE(MAX(br.return_revenue), 0)) - (SUM(l.authoritative_cogs) - COALESCE(MAX(br.return_cogs), 0)) - SUM(l.sales_expense))
        / NULLIF(SUM(CASE WHEN l.authoritative_cogs IS NOT NULL THEN l.quantity ELSE 0 END) - COALESCE(MAX(br.return_qty), 0), 0),
        2
      ) AS profit_per_unit,
      CASE
        WHEN (SUM(l.gross_sales) - COALESCE(MAX(br.return_revenue), 0)) = 0 THEN NULL
        ELSE ROUND(
          ((SUM(l.gross_sales) - COALESCE(MAX(br.return_revenue), 0)) - (SUM(l.authoritative_cogs) - COALESCE(MAX(br.return_cogs), 0)) - SUM(l.sales_expense))
          / (SUM(l.gross_sales) - COALESCE(MAX(br.return_revenue), 0)) * 100,
          2
        )
      END AS profit_margin_pct,
      COUNT(l.authoritative_cogs) AS costed_lines,
      COUNT(*) AS total_lines,
      CASE
        WHEN COUNT(l.authoritative_cogs) = 0 THEN 'unavailable'
        WHEN COUNT(l.authoritative_cogs) < COUNT(*) THEN 'partial'
        ELSE 'complete'
      END AS cost_coverage,
      BOOL_OR(l.import_price IS NOT NULL OR l.landed_cost_per_unit IS NOT NULL) AS is_imported,
      jsonb_build_object(
        'import_price', MAX(l.import_price),
        'import_price_usd', MAX(l.import_price_usd),
        'exchange_rate', MAX(l.exchange_rate_usd_to_idr),
        'duty_charges', MAX(l.duty_charges),
        'freight_charges', MAX(l.freight_charges),
        'other_charges', MAX(l.other_charges),
        'landed_cost_per_unit', MAX(l.landed_cost_per_unit),
        'local_cost_per_unit', MAX(l.cost_per_unit)
      ) AS cost_breakdown
    FROM l
    LEFT JOIN batch_returns br ON br.batch_id = l.batch_id
    GROUP BY l.batch_id, l.batch_number, l.current_stock
  ),
  p AS (
    SELECT
      pr.id AS product_id,
      pr.product_name,
      COALESCE(pr.product_code, '') AS product_code,
      COALESCE(pr.unit, 'kg') AS product_unit,
      COALESCE((SELECT SUM(cur_b.current_stock) FROM public.batches cur_b WHERE cur_b.product_id = pr.id AND cur_b.is_active), 0) AS current_stock,
      COALESCE(SUM(b.sold_qty), 0) AS sold_qty,
      COALESCE(SUM(b.gross_sales), 0) AS gross_sales,
      COALESCE(SUM(b.product_cost), 0) AS product_cost,
      COALESCE(SUM(b.sales_expense), 0) AS sales_expense,
      COALESCE(SUM(b.costed_lines), 0) AS costed_lines,
      COALESCE(SUM(b.total_lines), 0) AS total_lines,
      ROUND(COALESCE(SUM(b.gross_sales), 0) / NULLIF(SUM(b.sold_qty), 0), 2) AS avg_selling_price,
      ROUND(COALESCE(SUM(b.sales_expense), 0) / NULLIF(SUM(b.sold_qty), 0), 2) AS sales_expense_per_unit,
      ROUND((COALESCE(SUM(b.gross_sales), 0) - COALESCE(SUM(b.sales_expense), 0)) / NULLIF(SUM(b.sold_qty), 0), 2) AS net_selling_price_per_unit,
      ROUND(COALESCE(SUM(b.product_cost), 0) / NULLIF(SUM(CASE WHEN b.costed_lines > 0 THEN b.sold_qty ELSE 0 END), 0), 2) AS avg_landed_cost,
      ROUND(SUM(b.gross_profit), 2) AS gross_profit,
      ROUND(SUM(b.profit_after_sales_expense), 2) AS profit_after_sales_expense,
      ROUND(SUM(b.profit_after_sales_expense) / NULLIF(SUM(CASE WHEN b.costed_lines > 0 THEN b.sold_qty ELSE 0 END), 0), 2) AS profit_per_unit,
      CASE
        WHEN SUM(CASE WHEN b.costed_lines > 0 THEN b.gross_sales ELSE 0 END) = 0 THEN NULL
        ELSE ROUND(SUM(b.profit_after_sales_expense) / SUM(CASE WHEN b.costed_lines > 0 THEN b.gross_sales ELSE 0 END) * 100, 2)
      END AS profit_margin_pct
    FROM public.products pr
    LEFT JOIN b ON true
    WHERE pr.id = p_product_id
    GROUP BY pr.id, pr.product_name, pr.product_code, pr.unit
  )
  SELECT jsonb_build_object(
    'product', (SELECT to_jsonb(p) FROM p),
    'batches', COALESCE((SELECT jsonb_agg(to_jsonb(b) ORDER BY b.profit_after_sales_expense DESC NULLS LAST) FROM b), '[]'::jsonb)
  ) INTO v_result;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_sales_profitability_product_batches(uuid, date, date) TO authenticated, service_role;

-- 7.5 get_sales_profitability_batch_orders: exclude cancelled invoices
CREATE OR REPLACE FUNCTION public.get_sales_profitability_batch_orders(
  p_batch_id uuid,
  p_start_date date,
  p_end_date date
)
RETURNS jsonb
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
WITH x AS (
  SELECT
    ar.line_id, ar.invoice_id, si.invoice_number, si.invoice_date, si.customer_id,
    COALESCE(c.company_name, 'Unknown Customer') AS customer_name,
    si.sales_order_id, so.so_number, dci.challan_id AS dc_id, dc.challan_number AS dc_number,
    ar.quantity, sii.unit_price AS selling_price,
    ROUND(ar.quantity * sii.unit_price, 2) AS gross_sales,
    ar.authoritative_unit_cogs AS unit_cost,
    ar.authoritative_cogs AS line_cost,
    COALESCE(le.sales_expense, 0) AS line_sales_expense,
    ar.resolution_tier AS cogs_resolution
  FROM public.get_authoritative_sales_line_cogs(p_start_date, p_end_date) ar
  JOIN public.sales_invoice_items sii ON sii.id = ar.line_id
  JOIN public.sales_invoices si ON si.id = ar.invoice_id
  LEFT JOIN public.customers c ON c.id = si.customer_id
  LEFT JOIN public.sales_orders so ON so.id = si.sales_order_id
  LEFT JOIN public.delivery_challan_items dci ON dci.id = sii.delivery_challan_item_id
  LEFT JOIN public.delivery_challans dc ON dc.id = dci.challan_id
  LEFT JOIN public.get_sales_profitability_line_expenses(p_start_date, p_end_date) le ON le.line_id = ar.line_id
  WHERE ar.batch_id = p_batch_id
    AND COALESCE(si.document_status, 'posted') = 'posted'
    AND NOT COALESCE(si.is_draft, false)
    AND NOT (COALESCE(si.notes, '') LIKE '[CANCELLED%' OR LOWER(COALESCE(si.notes, '')) LIKE 'cancelled%')
),
ex AS (
  SELECT
    fe.delivery_challan_id AS dc_id,
    jsonb_agg(jsonb_build_object(
      'id', fe.id,
      'voucher_number', fe.voucher_number,
      'category', fe.expense_category,
      'total_amount', fe.amount,
      'description', fe.description,
      'expense_date', fe.expense_date
    )) AS expenses
  FROM public.finance_expenses fe
  WHERE (
      fe.expense_category IN ('delivery_sales', 'loading_sales', 'marketing_advertising', 'other_sales')
      OR EXISTS (
        SELECT 1 FROM public.expense_categories ec
        WHERE ec.category_key = fe.expense_category
          AND ec.category_type = 'sales'
      )
    )
    AND fe.approval_status = 'approved'
    AND fe.delivery_challan_id IN (SELECT DISTINCT dc_id FROM x WHERE dc_id IS NOT NULL)
  GROUP BY fe.delivery_challan_id
)
SELECT jsonb_build_object(
  'batch', (
    SELECT jsonb_build_object(
      'batch_id', b.id,
      'batch_number', b.batch_number,
      'product_name', p.product_name,
      'product_code', COALESCE(p.product_code, ''),
      'product_unit', COALESCE(p.unit, 'kg'),
      'current_stock', b.current_stock
    )
    FROM public.batches b
    JOIN public.products p ON p.id = b.product_id
    WHERE b.id = p_batch_id
  ),
  'orders', COALESCE((
    SELECT jsonb_agg(
      jsonb_build_object(
        'line_id', x.line_id,
        'invoice_id', x.invoice_id,
        'invoice_number', x.invoice_number,
        'invoice_date', x.invoice_date,
        'customer_id', x.customer_id,
        'customer_name', x.customer_name,
        'sales_order_id', x.sales_order_id,
        'so_number', x.so_number,
        'dc_id', x.dc_id,
        'dc_number', x.dc_number,
        'quantity', x.quantity,
        'selling_price', x.selling_price,
        'gross_sales', x.gross_sales,
        'unit_cost', x.unit_cost,
        'line_cost', x.line_cost,
        'line_sales_expense', x.line_sales_expense,
        'gross_profit', x.gross_sales - COALESCE(x.line_cost, 0),
        'net_selling_realization', x.gross_sales - x.line_sales_expense,
        'profit', x.gross_sales - COALESCE(x.line_cost, 0) - x.line_sales_expense,
        'profit_margin_pct', CASE WHEN x.gross_sales = 0 THEN NULL
          ELSE ROUND((x.gross_sales - COALESCE(x.line_cost, 0) - x.line_sales_expense) / x.gross_sales * 100, 2) END,
        'cogs_resolution', x.cogs_resolution,
        'dc_expenses', COALESCE(ex.expenses, '[]'::jsonb)
      ) ORDER BY x.invoice_date DESC, x.invoice_number
    )
    FROM x
    LEFT JOIN ex ON ex.dc_id = x.dc_id
  ), '[]'::jsonb)
);
$$;

GRANT EXECUTE ON FUNCTION public.get_sales_profitability_batch_orders(uuid, date, date) TO authenticated, service_role;

-- 7.6 get_sales_profit_summary: exclude cancelled invoices
CREATE OR REPLACE FUNCTION public.get_sales_profit_summary(p_start_date date, p_end_date date)
RETURNS TABLE(
  product_id uuid,
  product_name text,
  product_code text,
  product_unit text,
  total_qty_sold numeric,
  total_revenue numeric,
  costed_revenue numeric,
  total_cogs numeric,
  total_profit numeric,
  profit_pct numeric,
  costed_lines bigint,
  total_lines bigint,
  no_cost boolean
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  WITH lines AS (
    SELECT sii.product_id, p.product_name, COALESCE(p.product_code, '') AS product_code,
      COALESCE(p.unit, 'kg') AS product_unit, sii.quantity, sii.unit_price,
      public.effective_sales_cogs_unit_cost(sii.batch_id) AS effective_unit_cost
    FROM public.sales_invoice_items sii
    JOIN public.sales_invoices si ON si.id = sii.invoice_id
    JOIN public.products p ON p.id = sii.product_id
    WHERE si.invoice_date >= p_start_date AND si.invoice_date <= p_end_date
      AND COALESCE(si.is_draft, false) = false
      AND COALESCE(si.document_status, 'posted') = 'posted'
      AND NOT (COALESCE(si.notes, '') LIKE '[CANCELLED%' OR LOWER(COALESCE(si.notes, '')) LIKE 'cancelled%')
  ), grouped AS (
    SELECT product_id, product_name, product_code, product_unit,
      SUM(quantity) AS total_qty_sold,
      SUM(quantity * unit_price) AS total_revenue,
      SUM(quantity * unit_price) FILTER (WHERE effective_unit_cost IS NOT NULL) AS costed_revenue,
      COALESCE(SUM(quantity * effective_unit_cost) FILTER (WHERE effective_unit_cost IS NOT NULL), 0) AS total_cogs,
      COUNT(*) FILTER (WHERE effective_unit_cost IS NOT NULL) AS costed_lines,
      COUNT(*) AS total_lines
    FROM lines GROUP BY product_id, product_name, product_code, product_unit
  )
  SELECT
    product_id,
    product_name,
    product_code,
    product_unit,
    ROUND(total_qty_sold, 3) AS total_qty_sold,
    ROUND(total_revenue, 2) AS total_revenue,
    ROUND(COALESCE(costed_revenue, 0), 2) AS costed_revenue,
    ROUND(total_cogs, 2) AS total_cogs,
    ROUND(COALESCE(costed_revenue, 0) - total_cogs, 2) AS total_profit,
    CASE WHEN COALESCE(costed_revenue, 0) = 0 THEN NULL
      ELSE ROUND((costed_revenue - total_cogs) / costed_revenue * 100, 2) END AS profit_pct,
    costed_lines,
    total_lines,
    costed_lines = 0 AS no_cost
  FROM grouped
  ORDER BY (COALESCE(costed_revenue, 0) - total_cogs) DESC NULLS LAST;
$$;

GRANT EXECUTE ON FUNCTION public.get_sales_profit_summary(date, date) TO authenticated, service_role;

-- 7.7 get_sales_profit_drilldown: exclude cancelled invoices
CREATE OR REPLACE FUNCTION public.get_sales_profit_drilldown(
  p_product_id uuid,
  p_start_date date,
  p_end_date date
)
RETURNS TABLE(
  invoice_id uuid,
  invoice_number text,
  invoice_date date,
  customer_name text,
  batch_number text,
  qty numeric,
  product_unit text,
  selling_price numeric,
  landed_cost numeric,
  line_sales numeric,
  line_cost numeric,
  line_profit numeric,
  profit_pct numeric,
  no_cost boolean
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT si.id, si.invoice_number, si.invoice_date, COALESCE(c.company_name, ''),
    COALESCE(b.batch_number, ''), sii.quantity, COALESCE(p.unit, ''), sii.unit_price,
    CASE WHEN b.landed_cost_per_unit > 0 THEN b.landed_cost_per_unit END,
    ROUND(sii.quantity * sii.unit_price, 2),
    CASE WHEN b.landed_cost_per_unit > 0 THEN ROUND(sii.quantity * b.landed_cost_per_unit, 2) END,
    CASE WHEN b.landed_cost_per_unit > 0
      THEN ROUND(sii.quantity * (sii.unit_price - b.landed_cost_per_unit), 2) END,
    CASE WHEN b.landed_cost_per_unit > 0 AND sii.unit_price <> 0
      THEN ROUND((sii.unit_price - b.landed_cost_per_unit) / sii.unit_price * 100, 2) END,
    NOT COALESCE(b.landed_cost_per_unit > 0, false)
  FROM public.sales_invoice_items sii
  JOIN public.sales_invoices si ON si.id = sii.invoice_id
  LEFT JOIN public.customers c ON c.id = si.customer_id
  JOIN public.products p ON p.id = sii.product_id
  LEFT JOIN public.batches b ON b.id = sii.batch_id
  WHERE sii.product_id = p_product_id
    AND si.invoice_date >= p_start_date
    AND si.invoice_date <= p_end_date
    AND COALESCE(si.is_draft, false) = false
    AND COALESCE(si.document_status, 'posted') = 'posted'
    AND NOT (COALESCE(si.notes, '') LIKE '[CANCELLED%' OR LOWER(COALESCE(si.notes, '')) LIKE 'cancelled%')
  ORDER BY si.invoice_date DESC, si.invoice_number;
$$;

GRANT EXECUTE ON FUNCTION public.get_sales_profit_drilldown(uuid, date, date) TO authenticated, service_role;

-- 7.8 get_customer_sales_report: exclude cancelled invoices
CREATE OR REPLACE FUNCTION public.get_customer_sales_report(
  p_start_date date,
  p_end_date date
)
RETURNS TABLE(
  customer_id uuid,
  customer_name text,
  total_orders bigint,
  total_sales numeric,
  avg_order_value numeric,
  last_order_date date,
  total_qty numeric,
  total_cogs numeric,
  total_profit numeric,
  profit_pct numeric,
  costed_lines bigint,
  total_lines bigint,
  cost_coverage numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH lines AS (
    SELECT
      si.id,
      si.customer_id,
      c.company_name,
      si.invoice_date,
      sii.quantity,
      sii.unit_price,
      b.landed_cost_per_unit,
      (b.landed_cost_per_unit > 0) AS is_costed
    FROM public.sales_invoices si
    JOIN public.sales_invoice_items sii ON sii.invoice_id = si.id
    JOIN public.customers c ON c.id = si.customer_id
    LEFT JOIN public.batches b ON b.id = sii.batch_id
    WHERE si.invoice_date >= p_start_date AND si.invoice_date <= p_end_date
      AND COALESCE(si.is_draft, false) = false
      AND COALESCE(si.document_status, 'posted') = 'posted'
      AND NOT (COALESCE(si.notes, '') LIKE '[CANCELLED%' OR LOWER(COALESCE(si.notes, '')) LIKE 'cancelled%')
  ),
  customer_returns AS (
    SELECT 
      cn.customer_id,
      COALESCE(SUM(cn.subtotal), 0) AS return_revenue,
      COALESCE(SUM(cogs_reversal.total_cogs), 0) AS return_cogs,
      COALESCE(SUM(cni_q.qty), 0) AS return_qty
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
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(cni.quantity), 0) AS qty
      FROM public.credit_note_items cni
      WHERE cni.credit_note_id = cn.id
    ) cni_q ON true
    WHERE cn.status = 'approved'
      AND cn.credit_note_date BETWEEN p_start_date AND p_end_date
    GROUP BY cn.customer_id
  ),
  grouped AS (
    SELECT
      l.customer_id,
      l.company_name,
      COUNT(DISTINCT l.id) AS total_orders,
      SUM(l.quantity * l.unit_price) AS invoice_sales,
      SUM(l.quantity) AS invoice_qty,
      SUM(l.quantity * l.unit_price) FILTER (WHERE l.is_costed) AS costed_revenue,
      COALESCE(SUM(l.quantity * l.landed_cost_per_unit) FILTER (WHERE l.is_costed), 0) AS invoice_cogs,
      MAX(l.invoice_date) AS last_order_date,
      COUNT(*) FILTER (WHERE l.is_costed) AS costed_lines,
      COUNT(*) AS total_lines,
      COALESCE(MAX(cr.return_revenue), 0) AS return_revenue,
      COALESCE(MAX(cr.return_cogs), 0) AS return_cogs,
      COALESCE(MAX(cr.return_qty), 0) AS return_qty
    FROM lines l
    LEFT JOIN customer_returns cr ON cr.customer_id = l.customer_id
    GROUP BY l.customer_id, l.company_name
  )
  SELECT
    g.customer_id,
    g.company_name AS customer_name,
    g.total_orders,
    ROUND(g.invoice_sales - g.return_revenue, 2) AS total_sales,
    ROUND((g.invoice_sales - g.return_revenue) / NULLIF(g.total_orders, 0), 2) AS avg_order_value,
    g.last_order_date,
    g.invoice_qty - g.return_qty AS total_qty,
    ROUND(g.invoice_cogs - g.return_cogs, 2) AS total_cogs,
    ROUND((COALESCE(g.costed_revenue, 0) - g.return_revenue) - (g.invoice_cogs - g.return_cogs), 2) AS total_profit,
    CASE
      WHEN (COALESCE(g.costed_revenue, 0) - g.return_revenue) = 0 THEN NULL
      ELSE ROUND(((COALESCE(g.costed_revenue, 0) - g.return_revenue) - (g.invoice_cogs - g.return_cogs)) / (COALESCE(g.costed_revenue, 0) - g.return_revenue) * 100, 2)
    END AS profit_pct,
    g.costed_lines,
    g.total_lines,
    ROUND(g.costed_lines::numeric / NULLIF(g.total_lines, 0) * 100, 2) AS cost_coverage
  FROM grouped g
  ORDER BY total_sales DESC;
$$;

GRANT EXECUTE ON FUNCTION public.get_customer_sales_report(date, date) TO authenticated, service_role;

-- 7.9 get_product_performance_report: exclude cancelled invoices
CREATE OR REPLACE FUNCTION public.get_product_performance_report(
  p_start_date date,
  p_end_date date
)
RETURNS TABLE(
  product_id uuid,
  product_name text,
  product_code text,
  qty_sold numeric,
  total_sales numeric,
  total_cost numeric,
  total_profit numeric,
  profit_pct numeric,
  costed_lines bigint,
  total_lines bigint,
  cost_coverage numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH lines AS (
    SELECT
      sii.product_id,
      p.product_name,
      COALESCE(p.product_code, '') AS product_code,
      sii.quantity,
      sii.unit_price,
      b.landed_cost_per_unit,
      (b.landed_cost_per_unit > 0) AS is_costed
    FROM public.sales_invoice_items sii
    JOIN public.sales_invoices si ON si.id = sii.invoice_id
    JOIN public.products p ON p.id = sii.product_id
    LEFT JOIN public.batches b ON b.id = sii.batch_id
    WHERE si.invoice_date >= p_start_date AND si.invoice_date <= p_end_date
      AND COALESCE(si.is_draft, false) = false
      AND COALESCE(si.document_status, 'posted') = 'posted'
      AND NOT (COALESCE(si.notes, '') LIKE '[CANCELLED%' OR LOWER(COALESCE(si.notes, '')) LIKE 'cancelled%')
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
  grouped AS (
    SELECT
      l.product_id,
      l.product_name,
      l.product_code,
      SUM(l.quantity) AS qty_sold,
      SUM(l.quantity * l.unit_price) AS total_sales,
      COALESCE(SUM(l.quantity * l.landed_cost_per_unit) FILTER (WHERE l.is_costed), 0) AS total_cost,
      SUM(l.quantity * l.unit_price) FILTER (WHERE l.is_costed) AS costed_revenue,
      COUNT(*) FILTER (WHERE l.is_costed) AS costed_lines,
      COUNT(*) AS total_lines,
      COALESCE(MAX(pr.return_revenue), 0) AS return_revenue,
      COALESCE(MAX(pr.return_cogs), 0) AS return_cogs,
      COALESCE(MAX(pr.return_qty), 0) AS return_qty
    FROM lines l
    LEFT JOIN prod_returns pr ON pr.product_id = l.product_id
    GROUP BY l.product_id, l.product_name, l.product_code
  )
  SELECT
    g.product_id,
    g.product_name,
    g.product_code,
    g.qty_sold - g.return_qty AS qty_sold,
    ROUND(g.total_sales - g.return_revenue, 2) AS total_sales,
    ROUND(g.total_cost - g.return_cogs, 2) AS total_cost,
    ROUND((COALESCE(g.costed_revenue, 0) - g.return_revenue) - (g.total_cost - g.return_cogs), 2) AS total_profit,
    CASE
      WHEN (COALESCE(g.costed_revenue, 0) - g.return_revenue) = 0 THEN NULL
      ELSE ROUND(((COALESCE(g.costed_revenue, 0) - g.return_revenue) - (g.total_cost - g.return_cogs)) / (COALESCE(g.costed_revenue, 0) - g.return_revenue) * 100, 2)
    END AS profit_pct,
    g.costed_lines,
    g.total_lines,
    ROUND(g.costed_lines::numeric / NULLIF(g.total_lines, 0) * 100, 2) AS cost_coverage
  FROM grouped g
  ORDER BY total_sales DESC;
$$;

GRANT EXECUTE ON FUNCTION public.get_product_performance_report(date, date) TO authenticated, service_role;

COMMIT;
