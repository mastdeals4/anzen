-- ==============================================================================
-- SAPJ ERP: Final Unified Settlement & Financial Reporting Security Hardening
-- Migration: 20261030230000_final_unified_settlement_and_reporting_security_hardening.sql
-- ==============================================================================

-- 1. Register migration in schema tracker
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables 
    WHERE table_schema = 'supabase_migrations' AND table_name = 'schema_migrations'
  ) THEN
    INSERT INTO supabase_migrations.schema_migrations (version) VALUES
      ('20261030230000')
    ON CONFLICT (version) DO NOTHING;
  END IF;
END $$;

-- 2. CORRECTION A: Secure Financial Reporting RPCs
--    - Enforce server-side role authorization in PL/pgSQL reporting functions
--    - Revoke EXECUTE from PUBLIC and anon on sensitive reporting functions
--    - Grant EXECUTE strictly to authenticated and service_role

CREATE OR REPLACE FUNCTION public.get_sales_profitability_summary(p_start_date date, p_end_date date)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_result jsonb;
BEGIN
  -- Server-side authorization check: admin, accounts, auditor_ca, manager, or service_role
  IF auth.role() <> 'service_role' AND current_user <> 'service_role' AND session_user <> 'postgres' AND NOT (SELECT rolsuper FROM pg_roles WHERE rolname = session_user) THEN
    IF auth.uid() IS NULL THEN
      RAISE EXCEPTION 'Not authenticated';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.user_profiles
      WHERE id = auth.uid()
        AND is_active = true
        AND role IN ('admin', 'accounts', 'auditor_ca', 'manager')
    ) THEN
      RAISE EXCEPTION 'Permission denied: unauthorized to access sales profitability reports';
    END IF;
  END IF;

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
      AND (
        fe.expense_category IN ('delivery_sales', 'loading_sales', 'marketing_advertising', 'other_sales', 'sales_distribution', 'freight_outward', 'delivery_expense', 'sales_commission', 'travel_sales')
        OR EXISTS (
          SELECT 1 FROM public.expense_categories ec
          WHERE ec.category_key = fe.expense_category
            AND ec.category_type = 'sales'
        )
      )
      AND fe.approval_status = 'approved'
      AND fe.batch_id IS NULL
      AND fe.import_container_id IS NULL
      AND fe.delivery_challan_id IS NULL
      AND fe.sales_order_id IS NULL
      AND (
        fe.sales_order_allocations IS NULL
        OR fe.sales_order_allocations = '[]'::jsonb
        OR (jsonb_typeof(fe.sales_order_allocations) = 'array' AND jsonb_array_length(fe.sales_order_allocations) = 0)
      )
      AND fe.linked_sales_invoice_id IS NULL
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
      SUM(l.quantity) - COALESCE(MAX(pr.return_qty), 0) AS total_qty_sold,
      SUM(l.line_gross_sales) - COALESCE(MAX(pr.return_revenue), 0) AS total_revenue,
      SUM(CASE WHEN l.authoritative_cogs IS NOT NULL THEN l.line_gross_sales ELSE 0 END) - COALESCE(MAX(pr.return_revenue), 0) AS costed_revenue,
      SUM(l.authoritative_cogs) - COALESCE(MAX(pr.return_cogs), 0) AS total_cogs,
      (SUM(l.line_gross_sales) - COALESCE(MAX(pr.return_revenue), 0)) - (SUM(l.authoritative_cogs) - COALESCE(MAX(pr.return_cogs), 0)) AS gross_profit,
      SUM(l.line_sales_expense) AS total_sales_expenses,
      ((SUM(l.line_gross_sales) - COALESCE(MAX(pr.return_revenue), 0)) - (SUM(l.authoritative_cogs) - COALESCE(MAX(pr.return_cogs), 0))) - SUM(l.line_sales_expense) AS profit_after_sales_expenses,
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
$function$;

CREATE OR REPLACE FUNCTION public.get_sales_profitability_product_batches(p_product_id uuid, p_start_date date, p_end_date date)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_result jsonb;
BEGIN
  IF auth.role() <> 'service_role' AND current_user <> 'service_role' AND session_user <> 'postgres' AND NOT (SELECT rolsuper FROM pg_roles WHERE rolname = session_user) THEN
    IF auth.uid() IS NULL THEN
      RAISE EXCEPTION 'Not authenticated';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.user_profiles
      WHERE id = auth.uid()
        AND is_active = true
        AND role IN ('admin', 'accounts', 'auditor_ca', 'manager')
    ) THEN
      RAISE EXCEPTION 'Permission denied: unauthorized to access sales profitability reports';
    END IF;
  END IF;

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
      AND public.is_reportable_sales_invoice(si.document_status, si.is_draft, si.notes)
  ),
  grouped AS (
    SELECT
      batch_id,
      MAX(batch_number) AS batch_number,
      SUM(quantity) AS quantity_sold,
      MAX(current_stock) AS current_stock,
      SUM(gross_sales) AS gross_sales,
      SUM(authoritative_cogs) AS product_cost,
      SUM(gross_sales) - SUM(authoritative_cogs) AS gross_profit,
      SUM(sales_expense) AS sales_expenses,
      (SUM(gross_sales) - SUM(authoritative_cogs)) - SUM(sales_expense) AS net_profit,
      CASE
        WHEN SUM(gross_sales) = 0 THEN NULL
        ELSE ROUND(((SUM(gross_sales) - SUM(authoritative_cogs) - SUM(sales_expense)) / SUM(gross_sales)) * 100, 2)
      END AS margin_percentage,
      ROUND(
        (SUM(gross_sales) - SUM(authoritative_cogs) - SUM(sales_expense)) / NULLIF(SUM(quantity), 0),
        2
      ) AS profit_per_unit,
      MAX(import_price) AS import_price,
      MAX(import_price_usd) AS import_price_usd,
      MAX(exchange_rate_usd_to_idr) AS exchange_rate_usd_to_idr,
      MAX(duty_charges) AS duty_charges,
      MAX(freight_charges) AS freight_charges,
      MAX(other_charges) AS other_charges,
      MAX(landed_cost_per_unit) AS landed_cost_per_unit,
      MAX(cost_per_unit) AS cost_per_unit,
      MAX(authoritative_unit_cogs) AS authoritative_unit_cogs,
      MAX(resolution_tier) AS resolution_tier,
      COUNT(DISTINCT invoice_id) AS order_count
    FROM l
    GROUP BY batch_id
  )
  SELECT COALESCE(jsonb_agg(to_jsonb(g) ORDER BY g.batch_number), '[]'::jsonb)
  INTO v_result
  FROM grouped g;

  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_sales_profitability_batch_orders(p_batch_id uuid, p_start_date date, p_end_date date)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_result jsonb;
BEGIN
  IF auth.role() <> 'service_role' AND current_user <> 'service_role' AND session_user <> 'postgres' AND NOT (SELECT rolsuper FROM pg_roles WHERE rolname = session_user) THEN
    IF auth.uid() IS NULL THEN
      RAISE EXCEPTION 'Not authenticated';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.user_profiles
      WHERE id = auth.uid()
        AND is_active = true
        AND role IN ('admin', 'accounts', 'auditor_ca', 'manager')
    ) THEN
      RAISE EXCEPTION 'Permission denied: unauthorized to access sales profitability reports';
    END IF;
  END IF;

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
      AND public.is_reportable_sales_invoice(si.document_status, si.is_draft, si.notes)
  )
  SELECT COALESCE(jsonb_agg(
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
      'gross_profit', x.gross_sales - x.line_cost,
      'sales_expense', x.line_sales_expense,
      'profit_after_sales_expenses', x.gross_sales - x.line_cost - x.line_sales_expense,
      'profit_margin_pct', CASE WHEN x.gross_sales = 0 THEN NULL ELSE ROUND((x.gross_sales - x.line_cost - x.line_sales_expense) / x.gross_sales * 100, 2) END,
      'cogs_resolution', x.cogs_resolution
    ) ORDER BY x.invoice_date DESC, x.invoice_number DESC
  ), '[]'::jsonb)
  INTO v_result
  FROM x;

  RETURN v_result;
END;
$function$;

-- Revoke execute from PUBLIC and anon for all financial reporting RPCs
REVOKE ALL ON FUNCTION public.get_sales_profitability_summary(date,date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_sales_profitability_summary(date,date) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.get_sales_profitability_line_expenses(date,date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_sales_profitability_line_expenses(date,date) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.get_authoritative_sales_line_cogs(date,date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_authoritative_sales_line_cogs(date,date) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.get_sales_profit_summary(date,date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_sales_profit_summary(date,date) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.get_sales_profitability_batch_orders(uuid,date,date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_sales_profitability_batch_orders(uuid,date,date) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.get_sales_profitability_product_batches(uuid,date,date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_sales_profitability_product_batches(uuid,date,date) TO authenticated, service_role;

-- Revoke Credit Note internals from anon
REVOKE ALL ON FUNCTION public.next_credit_note_allocation_number() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.next_credit_note_allocation_number() TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.trg_validate_credit_note_integrity() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.trg_validate_credit_note_integrity() TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.trg_validate_credit_note_item_quantities() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.trg_validate_credit_note_item_quantities() TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.validate_credit_note_item_quantities() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.validate_credit_note_item_quantities() TO authenticated, service_role;


-- 3. CORRECTION B, C, D: Secure get_party_balance_summary()
--    - Enforces _sec_check_finance_role()
--    - Factor in Customer Refunds (reducing customer credit position)
--    - Factor in Supplier Refunds (reducing supplier advance position)
--    - Isolate Director balances with mandatory valid director ID and loan account (no global fallback)

CREATE OR REPLACE FUNCTION public.get_party_balance_summary(
  p_party_type text,
  p_party_id text,
  p_as_of_date date DEFAULT CURRENT_DATE
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uuid uuid;
  v_party_type text := lower(trim(COALESCE(p_party_type, '')));
  v_total_receivable numeric(15,2) := 0;
  v_total_payable numeric(15,2) := 0;
  v_raw_credits numeric(15,2) := 0;
  v_customer_refunds numeric(15,2) := 0;
  v_unallocated_credits numeric(15,2) := 0;
  v_raw_advances numeric(15,2) := 0;
  v_supplier_refunds numeric(15,2) := 0;
  v_unallocated_advances numeric(15,2) := 0;
  v_net_balance numeric(15,2) := 0;
  v_direction text := 'zero';
  v_open_docs jsonb := '[]'::jsonb;
  v_doc record;
  v_gl_balance numeric(15,2) := 0;
BEGIN
  -- Server-side authorization check: admin and accounts roles only
  PERFORM public._sec_check_finance_role();

  IF p_party_id IS NOT NULL AND p_party_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    v_uuid := p_party_id::uuid;
  END IF;

  IF v_party_type = 'customer' THEN
    IF v_uuid IS NULL THEN
      RAISE EXCEPTION 'A valid customer ID is required';
    END IF;

    -- Open Sales Invoices
    SELECT COALESCE(SUM(balance_amount), 0)
    INTO v_total_receivable
    FROM public.sales_invoices
    WHERE customer_id = v_uuid
      AND is_draft = false
      AND document_status = 'posted'
      AND payment_status IN ('unpaid', 'partial', 'pending')
      AND invoice_date <= p_as_of_date;

    -- Unallocated Receipts / Customer Advances
    SELECT COALESCE(SUM(rv.amount - COALESCE(va.allocated, 0)), 0)
    INTO v_raw_credits
    FROM public.receipt_vouchers rv
    LEFT JOIN (
      SELECT receipt_voucher_id, SUM(allocated_amount) as allocated
      FROM public.voucher_allocations
      GROUP BY receipt_voucher_id
    ) va ON va.receipt_voucher_id = rv.id
    WHERE rv.customer_id = v_uuid
      AND rv.is_posted = true
      AND rv.voucher_date <= p_as_of_date
      AND (rv.amount - COALESCE(va.allocated, 0)) > 0.01;

    -- Outgoing Customer Refunds (Payment Vouchers to Customer)
    SELECT COALESCE(SUM(
      (pv.amount * COALESCE(pv.exchange_rate, 1)) + COALESCE(pv.settlement_discount, 0)
    ), 0)
    INTO v_customer_refunds
    FROM public.payment_vouchers pv
    WHERE pv.customer_id = v_uuid
      AND pv.party_type = 'customer'
      AND pv.is_posted = true
      AND pv.voucher_date <= p_as_of_date;

    -- Net unallocated customer credits after refund deduction
    v_unallocated_credits := GREATEST(v_raw_credits - v_customer_refunds, 0);

    -- Net Balance = Receivables (Dr) - Net Credits (Cr)
    v_net_balance := v_total_receivable - (v_raw_credits - v_customer_refunds);

    -- Check General Ledger Account 1120 / 2140 for customer running position
    SELECT COALESCE(SUM(jel.debit) - SUM(jel.credit), 0)
    INTO v_gl_balance
    FROM public.journal_entry_lines jel
    JOIN public.journal_entries je ON je.id = jel.journal_entry_id
    JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
    WHERE jel.customer_id = v_uuid
      AND coa.code IN ('1120', '2140')
      AND je.is_posted = true
      AND NOT COALESCE(je.is_reversed, false)
      AND je.entry_date <= p_as_of_date;

    -- Build open documents array
    FOR v_doc IN (
      SELECT id, invoice_number as doc_number, invoice_date as doc_date, total_amount, balance_amount, 'sales_invoice' as doc_type
      FROM public.sales_invoices
      WHERE customer_id = v_uuid
        AND is_draft = false
        AND document_status = 'posted'
        AND payment_status IN ('unpaid', 'partial', 'pending')
        AND invoice_date <= p_as_of_date
      ORDER BY invoice_date ASC
    ) LOOP
      v_open_docs := v_open_docs || jsonb_build_object(
        'id', v_doc.id,
        'document_type', v_doc.doc_type,
        'document_number', v_doc.doc_number,
        'document_date', v_doc.doc_date,
        'total_amount', v_doc.total_amount,
        'balance_amount', v_doc.balance_amount
      );
    END LOOP;

  ELSIF v_party_type = 'supplier' THEN
    IF v_uuid IS NULL THEN
      RAISE EXCEPTION 'A valid supplier ID is required';
    END IF;

    -- Open Purchase Invoices
    SELECT COALESCE(SUM(balance_amount), 0)
    INTO v_total_payable
    FROM public.purchase_invoices
    WHERE supplier_id = v_uuid
      AND status IN ('pending', 'partial', 'unpaid', 'approved')
      AND invoice_date <= p_as_of_date;

    -- Open Approved Expenses (A/P)
    v_total_payable := v_total_payable + COALESCE((
      SELECT SUM(COALESCE(fe.amount, 0) + COALESCE(fe.ppn_amount, 0) - COALESCE(fe.pph_amount, 0) - COALESCE(fe.paid_amount, 0))
      FROM public.finance_expenses fe
      WHERE fe.supplier_id = v_uuid
        AND fe.approval_status = 'approved'
        AND fe.payment_method IS NULL
        AND fe.expense_category NOT IN ('pib_import', 'import_broker', 'loading_import', 'port_charges')
        AND fe.expense_date <= p_as_of_date
    ), 0);

    -- Unallocated Payment Vouchers (Supplier Advances / Overpayments)
    SELECT COALESCE(SUM(pv.amount - COALESCE(va.allocated, 0)), 0)
    INTO v_raw_advances
    FROM public.payment_vouchers pv
    LEFT JOIN (
      SELECT payment_voucher_id, SUM(allocated_amount) as allocated
      FROM public.voucher_allocations
      GROUP BY payment_voucher_id
    ) va ON va.payment_voucher_id = pv.id
    WHERE pv.supplier_id = v_uuid
      AND pv.is_posted = true
      AND pv.voucher_date <= p_as_of_date
      AND (pv.amount - COALESCE(va.allocated, 0)) > 0.01;

    -- Unallocated outgoing bank statement lines for this supplier
    v_raw_advances := v_raw_advances + COALESCE((
      SELECT SUM(bsl.debit_amount - COALESCE(bsa.allocated, 0))
      FROM public.bank_statement_lines bsl
      JOIN public.suppliers s ON s.id = v_uuid
      LEFT JOIN (
        SELECT bank_statement_line_id, SUM(allocation_amount) as allocated
        FROM public.bank_statement_allocations
        GROUP BY bank_statement_line_id
      ) bsa ON bsa.bank_statement_line_id = bsl.id
      WHERE bsl.debit_amount > 0
        AND bsl.transaction_date <= p_as_of_date
        AND (bsl.debit_amount - COALESCE(bsa.allocated, 0)) > 0.01
        AND bsl.description ILIKE ('%' || s.company_name || '%')
    ), 0);

    -- Incoming Supplier Refunds (Receipt Vouchers from Supplier)
    SELECT COALESCE(SUM(
      (rv.amount * COALESCE(rv.exchange_rate, 1)) + COALESCE(rv.settlement_discount, 0)
    ), 0)
    INTO v_supplier_refunds
    FROM public.receipt_vouchers rv
    WHERE rv.supplier_id = v_uuid
      AND rv.party_type = 'supplier'
      AND rv.is_posted = true
      AND rv.voucher_date <= p_as_of_date;

    -- Net unallocated advances after deducting supplier refunds received
    v_unallocated_advances := GREATEST(v_raw_advances - v_supplier_refunds, 0);

    -- Net Balance: total_payable minus net advances
    v_net_balance := v_total_payable - (v_raw_advances - v_supplier_refunds);

    -- Check General Ledger Account 2110 for supplier running position
    SELECT COALESCE(SUM(jel.credit) - SUM(jel.debit), 0)
    INTO v_gl_balance
    FROM public.journal_entry_lines jel
    JOIN public.journal_entries je ON je.id = jel.journal_entry_id
    JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
    WHERE jel.supplier_id = v_uuid
      AND coa.code = '2110'
      AND je.is_posted = true
      AND NOT COALESCE(je.is_reversed, false)
      AND je.entry_date <= p_as_of_date;

    -- Build open documents array for supplier
    FOR v_doc IN (
      SELECT id, invoice_number as doc_number, invoice_date as doc_date, total_amount, balance_amount, 'purchase_invoice' as doc_type
      FROM public.purchase_invoices
      WHERE supplier_id = v_uuid
        AND status IN ('pending', 'partial', 'unpaid', 'approved')
        AND invoice_date <= p_as_of_date
      UNION ALL
      SELECT id, COALESCE(voucher_number, invoice_number) as doc_number, expense_date as doc_date,
             (amount + COALESCE(ppn_amount,0) - COALESCE(pph_amount,0)) as total_amount,
             (amount + COALESCE(ppn_amount,0) - COALESCE(pph_amount,0) - COALESCE(paid_amount,0)) as balance_amount,
             'expense_bill' as doc_type
      FROM public.finance_expenses
      WHERE supplier_id = v_uuid
        AND approval_status = 'approved'
        AND payment_method IS NULL
        AND expense_category NOT IN ('pib_import', 'import_broker', 'loading_import', 'port_charges')
        AND expense_date <= p_as_of_date
      ORDER BY doc_date ASC
    ) LOOP
      v_open_docs := v_open_docs || jsonb_build_object(
        'id', v_doc.id,
        'document_type', v_doc.doc_type,
        'document_number', v_doc.doc_number,
        'document_date', v_doc.doc_date,
        'total_amount', v_doc.total_amount,
        'balance_amount', v_doc.balance_amount
      );
    END LOOP;

  ELSIF v_party_type = 'employee' THEN
    IF v_uuid IS NULL THEN
      RAISE EXCEPTION 'A valid staff ID is required';
    END IF;

    -- Staff Advances (Asset 1160)
    SELECT COALESCE(SUM(jel.debit) - SUM(jel.credit), 0)
    INTO v_net_balance
    FROM public.journal_entry_lines jel
    JOIN public.journal_entries je ON je.id = jel.journal_entry_id
    JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
    WHERE (jel.payee_id = v_uuid OR jel.description ILIKE ('%' || p_party_id || '%'))
      AND coa.code = '1160'
      AND je.is_posted = true
      AND NOT COALESCE(je.is_reversed, false)
      AND je.entry_date <= p_as_of_date;

  ELSIF v_party_type = 'director' THEN
    -- Director ID is mandatory; reject null/empty/malformed/unknown IDs
    IF v_uuid IS NULL THEN
      RAISE EXCEPTION 'A valid director ID is required for director balance query';
    END IF;

    DECLARE
      v_dir_loan_acc uuid;
      v_dir_exists boolean;
    BEGIN
      SELECT true, loan_account_id INTO v_dir_exists, v_dir_loan_acc
      FROM public.directors
      WHERE id = v_uuid;

      IF NOT COALESCE(v_dir_exists, false) THEN
        RAISE EXCEPTION 'Director with ID % not found', p_party_id;
      END IF;

      -- Strictly isolate director loan balance by dedicated loan account or payee ID
      -- No global fallback across other directors!
      SELECT COALESCE(SUM(jel.credit) - SUM(jel.debit), 0)
      INTO v_net_balance
      FROM public.journal_entry_lines jel
      JOIN public.journal_entries je ON je.id = jel.journal_entry_id
      JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
      WHERE (
        (v_dir_loan_acc IS NOT NULL AND jel.account_id = v_dir_loan_acc)
        OR (v_dir_loan_acc IS NULL AND (coa.code = '2105' OR coa.code LIKE '2105%') AND jel.payee_id = v_uuid)
      )
        AND je.is_posted = true
        AND NOT COALESCE(je.is_reversed, false)
        AND je.entry_date <= p_as_of_date;
    END;

  ELSIF v_party_type = 'other' THEN
    IF v_uuid IS NOT NULL THEN
      SELECT COALESCE(SUM(jel.credit) - SUM(jel.debit), 0)
      INTO v_net_balance
      FROM public.journal_entry_lines jel
      JOIN public.journal_entries je ON je.id = jel.journal_entry_id
      WHERE jel.payee_id = v_uuid
        AND je.is_posted = true
        AND NOT COALESCE(je.is_reversed, false)
        AND je.entry_date <= p_as_of_date;
    END IF;
  ELSE
    RAISE EXCEPTION 'Unsupported party type %', v_party_type;
  END IF;

  IF v_net_balance > 0.005 THEN
    v_direction := 'debit';
  ELSIF v_net_balance < -0.005 THEN
    v_direction := 'credit';
  ELSE
    v_direction := 'zero';
  END IF;

  RETURN jsonb_build_object(
    'party_type', v_party_type,
    'party_id', p_party_id,
    'total_receivable', v_total_receivable,
    'total_payable', v_total_payable,
    'unallocated_credits', v_unallocated_credits,
    'unallocated_advances', v_unallocated_advances,
    'gl_balance', v_gl_balance,
    'net_balance', v_net_balance,
    'balance_direction', v_direction,
    'outstanding_amount', abs(v_net_balance),
    'open_documents', v_open_docs
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.get_party_balance_summary(text, text, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_party_balance_summary(text, text, date) TO authenticated, service_role;


-- 4. CORRECTION E & F: Hardened Posting & Concurrency Checks
--    - In post_receipt_voucher: Lock supplier row on supplier refund to serialize concurrent refunds
--    - In post_payment_voucher: Lock customer row on customer refund to serialize concurrent refunds
--    - Enforce non-negative settlement adjustment, reason requirement, and valid adjustment account existence

CREATE OR REPLACE FUNCTION public.post_receipt_voucher(p_rv_id uuid, p_posted_by uuid DEFAULT NULL::uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_rv                 RECORD;
  v_je_id              UUID;
  v_je_number          TEXT;
  v_bank_account_id    UUID;
  v_credit_account_id  UUID;
  v_diff_account_id    UUID;
  v_actual_poster      UUID;
  v_rate               NUMERIC := 1;
  v_actual_received    NUMERIC;
  v_settle_diff        NUMERIC := 0;
  v_carrying_amount    NUMERIC := 0;
  v_total_debit        NUMERIC;
  v_total_credit       NUMERIC;
  v_line               INTEGER := 1;
  v_currency           TEXT;
  v_party_type         TEXT;
  v_avail_advances     NUMERIC;
BEGIN
  PERFORM public._sec_check_finance_role();
  v_actual_poster := auth.uid();
  IF v_actual_poster IS NULL THEN
    v_actual_poster := COALESCE(p_posted_by, 'a0000000-0000-0000-0000-000000000001'::uuid);
  END IF;

  SELECT * INTO v_rv FROM public.receipt_vouchers WHERE id = p_rv_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Receipt voucher % not found', p_rv_id; END IF;
  IF v_rv.is_posted THEN RAISE EXCEPTION 'Receipt voucher % is already posted', v_rv.voucher_number; END IF;

  v_party_type := lower(COALESCE(v_rv.party_type, 'customer'));
  v_currency := UPPER(COALESCE(v_rv.payment_currency, v_rv.transaction_currency, 'IDR'));
  v_rate := COALESCE(v_rv.exchange_rate, 1);
  IF v_rate <= 0 THEN v_rate := 1; END IF;

  v_actual_received := COALESCE(v_rv.settlement_amount, v_rv.amount * v_rate);
  v_settle_diff := COALESCE(v_rv.settlement_discount, 0);

  -- Validate settlement adjustment
  IF v_settle_diff < 0 THEN
    RAISE EXCEPTION 'Settlement discount cannot be negative';
  END IF;
  IF v_settle_diff > 0 AND (v_rv.adjustment_reason IS NULL OR trim(v_rv.adjustment_reason) = '') THEN
    RAISE EXCEPTION 'Adjustment reason is mandatory when settlement discount/difference is non-zero';
  END IF;
  IF v_rv.adjustment_account_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.chart_of_accounts WHERE id = v_rv.adjustment_account_id AND is_active = true
  ) THEN
    RAISE EXCEPTION 'Adjustment account % does not exist or is inactive', v_rv.adjustment_account_id;
  END IF;

  -- Concurrency & Balance Validation for Supplier Refund
  IF v_party_type = 'supplier' AND v_rv.supplier_id IS NOT NULL THEN
    -- Lock the supplier row FOR UPDATE to strictly serialize concurrent refund postings
    PERFORM id FROM public.suppliers WHERE id = v_rv.supplier_id FOR UPDATE;

    -- Calculate available unallocated supplier advances
    SELECT COALESCE(SUM(pv.amount - COALESCE(va.allocated, 0)), 0)
    INTO v_avail_advances
    FROM public.payment_vouchers pv
    LEFT JOIN (
      SELECT payment_voucher_id, SUM(allocated_amount) as allocated
      FROM public.voucher_allocations
      GROUP BY payment_voucher_id
    ) va ON va.payment_voucher_id = pv.id
    WHERE pv.supplier_id = v_rv.supplier_id
      AND pv.is_posted = true;

    -- Deduct previously posted supplier refund receipts
    v_avail_advances := v_avail_advances - COALESCE((
      SELECT SUM((rv2.amount * COALESCE(rv2.exchange_rate, 1)) + COALESCE(rv2.settlement_discount, 0))
      FROM public.receipt_vouchers rv2
      WHERE rv2.supplier_id = v_rv.supplier_id
        AND rv2.party_type = 'supplier'
        AND rv2.is_posted = true
        AND rv2.id <> v_rv.id
    ), 0);

    -- Ensure carrying amount does not exceed available advance position if settling against advances
    IF v_avail_advances > 0 AND (v_actual_received + v_settle_diff) > (v_avail_advances + 0.01) THEN
      RAISE EXCEPTION 'Supplier refund amount (%) exceeds available supplier advance balance (%)',
        (v_actual_received + v_settle_diff), v_avail_advances;
    ELSIF v_avail_advances <= 0 AND COALESCE(v_rv.settlement_against, '') = 'advance' THEN
      RAISE EXCEPTION 'No available supplier advance balance to refund against';
    END IF;
  END IF;

  -- Resolve Bank / Cash Debit Account
  IF v_rv.bank_account_id IS NOT NULL THEN
    SELECT coa_id INTO v_bank_account_id FROM public.bank_accounts WHERE id = v_rv.bank_account_id;
  ELSIF v_rv.payment_method = 'cash' THEN
    SELECT id INTO v_bank_account_id FROM public.chart_of_accounts WHERE code = '1101' LIMIT 1;
  END IF;
  IF v_bank_account_id IS NULL THEN
    SELECT id INTO v_bank_account_id FROM public.chart_of_accounts WHERE code = '1110' LIMIT 1;
  END IF;
  IF v_bank_account_id IS NULL THEN
    SELECT id INTO v_bank_account_id FROM public.chart_of_accounts WHERE code = '1111' LIMIT 1;
  END IF;
  IF v_bank_account_id IS NULL THEN
    RAISE EXCEPTION 'Bank or Cash GL account could not be resolved for voucher %', v_rv.voucher_number;
  END IF;

  -- Resolve Credit Control Account based on party type and purpose
  IF v_party_type = 'customer' THEN
    IF v_rv.coa_account_id IS NOT NULL THEN
      v_credit_account_id := v_rv.coa_account_id;
    ELSIF v_rv.payment_purpose IN ('customer_advance', 'excess_payment') THEN
      SELECT id INTO v_credit_account_id FROM public.chart_of_accounts WHERE code = '2140' LIMIT 1;
      IF v_credit_account_id IS NULL THEN
        SELECT id INTO v_credit_account_id FROM public.chart_of_accounts WHERE code = '1120' LIMIT 1;
      END IF;
    ELSE
      SELECT id INTO v_credit_account_id FROM public.chart_of_accounts WHERE code = '1120' LIMIT 1;
    END IF;

    IF v_settle_diff <> 0 THEN
      IF v_rv.adjustment_account_id IS NOT NULL THEN
        v_diff_account_id := v_rv.adjustment_account_id;
      ELSE
        SELECT id INTO v_diff_account_id FROM public.chart_of_accounts WHERE code = '4200' LIMIT 1;
        IF v_diff_account_id IS NULL THEN
          SELECT id INTO v_diff_account_id FROM public.chart_of_accounts WHERE code = '6910' LIMIT 1;
        END IF;
      END IF;
    END IF;

    v_carrying_amount := v_actual_received + v_settle_diff;

  ELSIF v_party_type = 'supplier' THEN
    IF v_rv.coa_account_id IS NOT NULL THEN
      v_credit_account_id := v_rv.coa_account_id;
    ELSE
      SELECT id INTO v_credit_account_id FROM public.chart_of_accounts WHERE code = '2110' LIMIT 1;
    END IF;

    IF v_settle_diff <> 0 THEN
      IF v_rv.adjustment_account_id IS NOT NULL THEN
        v_diff_account_id := v_rv.adjustment_account_id;
      ELSE
        SELECT id INTO v_diff_account_id FROM public.chart_of_accounts WHERE code = '6910' LIMIT 1;
        IF v_diff_account_id IS NULL THEN
          SELECT id INTO v_diff_account_id FROM public.chart_of_accounts WHERE code = '6900' LIMIT 1;
        END IF;
      END IF;
    END IF;

    v_carrying_amount := v_actual_received + v_settle_diff;

  ELSIF v_party_type = 'employee' THEN
    SELECT id INTO v_credit_account_id FROM public.chart_of_accounts WHERE code = '1160' LIMIT 1;
    IF v_credit_account_id IS NULL THEN
      SELECT id INTO v_credit_account_id FROM public.chart_of_accounts WHERE code = '1120' LIMIT 1;
    END IF;
    v_carrying_amount := v_actual_received;

  ELSIF v_party_type = 'director' THEN
    SELECT id INTO v_credit_account_id FROM public.chart_of_accounts WHERE code = '2105' LIMIT 1;
    IF v_credit_account_id IS NULL THEN
      SELECT id INTO v_credit_account_id FROM public.chart_of_accounts WHERE code = '2110' LIMIT 1;
    END IF;
    v_carrying_amount := v_actual_received;

  ELSE
    IF v_rv.coa_account_id IS NOT NULL THEN
      v_credit_account_id := v_rv.coa_account_id;
    ELSE
      SELECT id INTO v_credit_account_id FROM public.chart_of_accounts WHERE code = '4900' LIMIT 1;
    END IF;
    v_carrying_amount := v_actual_received;
  END IF;

  v_total_debit := v_actual_received + CASE WHEN v_settle_diff > 0 THEN v_settle_diff ELSE 0 END;
  v_total_credit := v_carrying_amount;

  v_je_number := public.next_journal_entry_number();

  INSERT INTO public.journal_entries (
    entry_number,
    entry_date,
    source_module,
    reference_id,
    reference_number,
    description,
    total_debit,
    total_credit,
    is_posted,
    posted_by,
    transaction_currency,
    functional_currency,
    exchange_rate
  ) VALUES (
    v_je_number,
    v_rv.voucher_date,
    'receipt',
    v_rv.id,
    v_rv.voucher_number,
    'Receipt Voucher (' || v_party_type || '): ' || v_rv.voucher_number,
    v_total_debit,
    v_total_credit,
    TRUE,
    v_actual_poster,
    v_currency,
    'IDR',
    v_rate
  ) RETURNING id INTO v_je_id;

  -- Line 1: Debit Bank / Cash with Actual Cash Received
  INSERT INTO public.journal_entry_lines (
    journal_entry_id, line_number, account_id, description, debit, credit,
    customer_id, supplier_id, payee_id, transaction_currency, exchange_rate
  ) VALUES (
    v_je_id, v_line, v_bank_account_id,
    'Bank Receipt - ' || v_rv.voucher_number,
    v_actual_received, 0,
    v_rv.customer_id, v_rv.supplier_id, v_rv.staff_id, v_currency, v_rate
  );
  v_line := v_line + 1;

  -- Line 2: Debit Settlement Discount / Adjustment Expense (if adjustment was granted/absorbed)
  IF v_settle_diff > 0 AND v_diff_account_id IS NOT NULL THEN
    INSERT INTO public.journal_entry_lines (
      journal_entry_id, line_number, account_id, description, debit, credit,
      customer_id, supplier_id, payee_id, transaction_currency, exchange_rate
    ) VALUES (
      v_je_id, v_line, v_diff_account_id,
      COALESCE(v_rv.adjustment_reason, 'Settlement adjustment') || ' - ' || v_rv.voucher_number,
      v_settle_diff, 0,
      v_rv.customer_id, v_rv.supplier_id, v_rv.staff_id, v_currency, v_rate
    );
    v_line := v_line + 1;
  END IF;

  -- Line 3: Credit Party Control Account with Full Carrying Amount (closing party balance)
  INSERT INTO public.journal_entry_lines (
    journal_entry_id, line_number, account_id, description, debit, credit,
    customer_id, supplier_id, payee_id, transaction_currency, exchange_rate
  ) VALUES (
    v_je_id, v_line, v_credit_account_id,
    CASE 
      WHEN v_party_type = 'supplier' THEN 'Supplier Refund Settlement - '
      WHEN v_party_type = 'employee' THEN 'Staff Advance Recovery - '
      WHEN v_party_type = 'director' THEN 'Director Funding - '
      ELSE 'Customer Receipt - '
    END || v_rv.voucher_number,
    0, v_carrying_amount,
    v_rv.customer_id, v_rv.supplier_id, v_rv.staff_id, v_currency, v_rate
  );
  v_line := v_line + 1;

  -- Recalculate Sales Invoice states if allocations were linked
  IF v_party_type = 'customer' THEN
    PERFORM public.recalculate_sales_invoice_payment_state(va.sales_invoice_id)
    FROM public.voucher_allocations va
    WHERE va.receipt_voucher_id = p_rv_id AND va.sales_invoice_id IS NOT NULL;
  END IF;

  UPDATE public.receipt_vouchers
  SET is_posted = TRUE, journal_entry_id = v_je_id
  WHERE id = p_rv_id;

  INSERT INTO public.audit_logs (table_name, record_id, action_type, old_values, new_values, user_id)
  VALUES (
    'receipt_vouchers', p_rv_id, 'update',
    jsonb_build_object('is_posted', FALSE),
    jsonb_build_object('is_posted', TRUE, 'journal_entry_id', v_je_id, 'journal_entry_number', v_je_number, 'posted_by', v_actual_poster),
    v_actual_poster
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.post_payment_voucher(p_pv_id uuid, p_posted_by uuid DEFAULT NULL::uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_pv RECORD;
  v_entry text;
  v_je uuid;
  v_bank_coa uuid;
  v_debit_coa uuid;
  v_charge_coa uuid;
  v_diff_coa uuid;
  v_pph_coa uuid;
  v_total_debit numeric;
  v_total_credit numeric;
  v_line int := 1;
  v_actual_poster uuid;
  v_party_type text;
  v_gross numeric;
  v_actual numeric;
  v_settle_diff numeric;
  v_debit_amount numeric;
  v_rate numeric := 1;
  v_charge_amt numeric := 0;
  v_pph_bank numeric := 0;
  v_bank_currency text;
  v_invoice_currency text;
  v_avail_deposits numeric;
BEGIN
  PERFORM public._sec_check_finance_role();
  v_actual_poster := auth.uid();
  IF v_actual_poster IS NULL THEN
    v_actual_poster := COALESCE(p_posted_by, 'a0000000-0000-0000-0000-000000000001'::uuid);
  END IF;

  SELECT * INTO v_pv FROM public.payment_vouchers WHERE id = p_pv_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payment voucher % not found', p_pv_id; END IF;
  IF v_pv.is_posted THEN RAISE EXCEPTION 'Payment voucher % is already posted', v_pv.voucher_number; END IF;

  v_party_type := lower(COALESCE(v_pv.party_type, 'supplier'));
  v_rate := COALESCE(v_pv.exchange_rate, 1);
  IF v_rate <= 0 THEN v_rate := 1; END IF;

  v_bank_currency := UPPER(COALESCE(v_pv.bank_currency, v_pv.payment_currency, 'IDR'));
  v_invoice_currency := UPPER(COALESCE(v_pv.invoice_currency, v_pv.transaction_currency, 'IDR'));

  v_gross := COALESCE(v_pv.invoice_amount, v_pv.amount, 0);
  v_settle_diff := COALESCE(v_pv.settlement_discount, 0);
  v_charge_amt := COALESCE(v_pv.bank_charge, 0);
  v_pph_bank := COALESCE(v_pv.pph_amount, 0) * v_rate;
  v_actual := COALESCE(v_pv.bank_amount, v_pv.actual_bank_debit, v_gross * v_rate);

  -- Validate settlement adjustment
  IF v_settle_diff < 0 THEN
    RAISE EXCEPTION 'Settlement discount cannot be negative';
  END IF;
  IF v_settle_diff > 0 AND (v_pv.adjustment_reason IS NULL OR trim(v_pv.adjustment_reason) = '') THEN
    RAISE EXCEPTION 'Adjustment reason is mandatory when settlement discount/difference is non-zero';
  END IF;
  IF v_pv.adjustment_account_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.chart_of_accounts WHERE id = v_pv.adjustment_account_id AND is_active = true
  ) THEN
    RAISE EXCEPTION 'Adjustment account % does not exist or is inactive', v_pv.adjustment_account_id;
  END IF;

  -- Concurrency & Balance Validation for Customer Refund
  IF v_party_type = 'customer' AND v_pv.customer_id IS NOT NULL THEN
    -- Lock customer row FOR UPDATE to strictly serialize concurrent customer refund postings
    PERFORM id FROM public.customers WHERE id = v_pv.customer_id FOR UPDATE;

    -- Calculate available unallocated customer receipts/deposits
    SELECT COALESCE(SUM(rv.amount - COALESCE(va.allocated, 0)), 0)
    INTO v_avail_deposits
    FROM public.receipt_vouchers rv
    LEFT JOIN (
      SELECT receipt_voucher_id, SUM(allocated_amount) as allocated
      FROM public.voucher_allocations
      GROUP BY receipt_voucher_id
    ) va ON va.receipt_voucher_id = rv.id
    WHERE rv.customer_id = v_pv.customer_id
      AND rv.is_posted = true;

    -- Deduct previously posted customer refund payments
    v_avail_deposits := v_avail_deposits - COALESCE((
      SELECT SUM((pv2.amount * COALESCE(pv2.exchange_rate, 1)) + COALESCE(pv2.settlement_discount, 0))
      FROM public.payment_vouchers pv2
      WHERE pv2.customer_id = v_pv.customer_id
        AND pv2.party_type = 'customer'
        AND pv2.is_posted = true
        AND pv2.id <> v_pv.id
    ), 0);

    -- Ensure refund does not exceed customer deposit balance
    IF (v_gross + v_settle_diff) > (v_avail_deposits + 0.01) AND v_avail_deposits >= 0 THEN
      RAISE EXCEPTION 'Customer refund amount (%) exceeds available customer deposit/credit balance (%)',
        (v_gross + v_settle_diff), v_avail_deposits;
    END IF;
  END IF;

  -- Resolve Bank Credit Account
  IF v_pv.bank_account_id IS NOT NULL THEN
    SELECT coa_id INTO v_bank_coa FROM public.bank_accounts WHERE id = v_pv.bank_account_id;
  ELSIF v_pv.payment_method = 'cash' THEN
    SELECT id INTO v_bank_coa FROM public.chart_of_accounts WHERE code = '1101' LIMIT 1;
  END IF;
  IF v_bank_coa IS NULL THEN
    SELECT id INTO v_bank_coa FROM public.chart_of_accounts WHERE code = '1110' LIMIT 1;
  END IF;
  IF v_bank_coa IS NULL THEN
    SELECT id INTO v_bank_coa FROM public.chart_of_accounts WHERE code = '1111' LIMIT 1;
  END IF;
  IF v_bank_coa IS NULL THEN
    RAISE EXCEPTION 'Bank or Cash GL account could not be resolved for voucher %', v_pv.voucher_number;
  END IF;

  -- Resolve Debit Control Account
  IF v_party_type = 'customer' THEN
    SELECT id INTO v_debit_coa FROM public.chart_of_accounts WHERE code = '2140' LIMIT 1;
    IF v_debit_coa IS NULL THEN
      SELECT id INTO v_debit_coa FROM public.chart_of_accounts WHERE code = '1120' LIMIT 1;
    END IF;
    IF v_settle_diff <> 0 THEN
      IF v_pv.adjustment_account_id IS NOT NULL THEN
        v_diff_coa := v_pv.adjustment_account_id;
      ELSE
        SELECT id INTO v_diff_coa FROM public.chart_of_accounts WHERE code = '6910' LIMIT 1;
      END IF;
    END IF;
    v_debit_amount := (v_gross + v_settle_diff) * v_rate;

  ELSIF v_party_type = 'supplier' THEN
    IF v_pv.coa_account_id IS NOT NULL THEN
      v_debit_coa := v_pv.coa_account_id;
    ELSE
      SELECT id INTO v_debit_coa FROM public.chart_of_accounts WHERE code = '2110' LIMIT 1;
    END IF;
    IF v_settle_diff <> 0 THEN
      IF v_pv.adjustment_account_id IS NOT NULL THEN
        v_diff_coa := v_pv.adjustment_account_id;
      ELSE
        SELECT id INTO v_diff_coa FROM public.chart_of_accounts WHERE code = '5105' LIMIT 1;
        IF v_diff_coa IS NULL THEN SELECT id INTO v_diff_coa FROM public.chart_of_accounts WHERE code = '6910' LIMIT 1; END IF;
      END IF;
    END IF;
    v_debit_amount := (v_gross + v_settle_diff) * v_rate;

  ELSIF v_party_type = 'employee' THEN
    SELECT id INTO v_debit_coa FROM public.chart_of_accounts WHERE code = '1160' LIMIT 1;
    IF v_debit_coa IS NULL THEN SELECT id INTO v_debit_coa FROM public.chart_of_accounts WHERE code = '2110' LIMIT 1; END IF;
    v_debit_amount := v_gross * v_rate;

  ELSIF v_party_type = 'director' THEN
    DECLARE
      v_dir_loan_acc uuid;
    BEGIN
      IF v_pv.staff_id IS NOT NULL THEN
        SELECT loan_account_id INTO v_dir_loan_acc FROM public.directors WHERE id = v_pv.staff_id;
      END IF;
      IF v_dir_loan_acc IS NOT NULL THEN
        v_debit_coa := v_dir_loan_acc;
      ELSE
        SELECT id INTO v_debit_coa FROM public.chart_of_accounts WHERE code = '2105' LIMIT 1;
      END IF;
    END;
    v_debit_amount := v_gross * v_rate;

  ELSE
    IF v_pv.coa_account_id IS NOT NULL THEN
      v_debit_coa := v_pv.coa_account_id;
    ELSE
      SELECT id INTO v_debit_coa FROM public.chart_of_accounts WHERE code = '6900' LIMIT 1;
    END IF;
    v_debit_amount := v_gross * v_rate;
  END IF;

  SELECT id INTO v_charge_coa FROM public.chart_of_accounts WHERE code = '6901' LIMIT 1;
  IF v_charge_coa IS NULL THEN SELECT id INTO v_charge_coa FROM public.chart_of_accounts WHERE code = '6900' LIMIT 1; END IF;

  SELECT id INTO v_pph_coa FROM public.chart_of_accounts WHERE code = '2132' LIMIT 1;

  v_total_debit := v_debit_amount + v_charge_amt;
  v_total_credit := v_actual + v_pph_bank + CASE WHEN v_settle_diff > 0 THEN v_settle_diff ELSE 0 END;

  v_entry := public.next_journal_entry_number();

  INSERT INTO public.journal_entries(
    entry_number, entry_date, source_module, reference_id, reference_number, description,
    total_debit, total_credit, is_posted, posted_by, transaction_currency, functional_currency, exchange_rate
  ) VALUES (
    v_entry, v_pv.voucher_date, 'payment', v_pv.id, v_pv.voucher_number,
    'Payment Voucher (' || v_party_type || '): ' || v_pv.voucher_number,
    v_total_debit, v_total_credit, true, v_actual_poster, v_invoice_currency, 'IDR', v_rate
  ) RETURNING id INTO v_je;

  -- Line 1: Debit Party Control Account (clearing AP / Customer Deposit / Staff Advance)
  INSERT INTO public.journal_entry_lines(
    journal_entry_id, line_number, account_id, description, debit, credit,
    transaction_currency, transaction_debit, transaction_credit, exchange_rate,
    supplier_id, customer_id, payee_id
  ) VALUES (
    v_je, v_line, v_debit_coa,
    CASE 
      WHEN v_party_type = 'customer' THEN 'Customer Refund - '
      WHEN v_party_type = 'employee' THEN 'Staff Payment - '
      WHEN v_party_type = 'director' THEN 'Director Loan Repayment - '
      ELSE 'Supplier Payment - '
    END || v_pv.voucher_number,
    v_debit_amount, 0,
    v_invoice_currency, (v_gross + v_settle_diff), 0, v_rate,
    v_pv.supplier_id, v_pv.customer_id, v_pv.staff_id
  );
  v_line := v_line + 1;

  -- Line 2: Bank Charge
  IF v_charge_amt > 0 AND v_charge_coa IS NOT NULL THEN
    INSERT INTO public.journal_entry_lines(
      journal_entry_id, line_number, account_id, description, debit, credit,
      transaction_currency, transaction_debit, transaction_credit, exchange_rate,
      supplier_id, customer_id, payee_id
    ) VALUES (
      v_je, v_line, v_charge_coa, 'Bank Charge - ' || v_pv.voucher_number, v_charge_amt, 0,
      v_bank_currency, v_charge_amt, 0, 1,
      v_pv.supplier_id, v_pv.customer_id, v_pv.staff_id
    );
    v_line := v_line + 1;
  END IF;

  -- Line 3: PPh Withholding
  IF v_pph_bank > 0 AND v_pph_coa IS NOT NULL THEN
    INSERT INTO public.journal_entry_lines(
      journal_entry_id, line_number, account_id, description, debit, credit,
      transaction_currency, transaction_debit, transaction_credit, exchange_rate,
      supplier_id, customer_id, payee_id
    ) VALUES (
      v_je, v_line, v_pph_coa, 'PPh Withholding - ' || v_pv.voucher_number, 0, v_pph_bank,
      v_bank_currency, 0, v_pv.pph_amount, v_rate,
      v_pv.supplier_id, v_pv.customer_id, v_pv.staff_id
    );
    v_line := v_line + 1;
  END IF;

  -- Line 4: Settlement Discount / Difference Credit
  IF v_settle_diff > 0 AND v_diff_coa IS NOT NULL THEN
    INSERT INTO public.journal_entry_lines(
      journal_entry_id, line_number, account_id, description, debit, credit,
      transaction_currency, transaction_debit, transaction_credit, exchange_rate,
      supplier_id, customer_id, payee_id
    ) VALUES (
      v_je, v_line, v_diff_coa,
      COALESCE(v_pv.adjustment_reason, 'Settlement discount') || ' - ' || v_pv.voucher_number,
      0, v_settle_diff,
      v_bank_currency, 0, v_settle_diff, 1,
      v_pv.supplier_id, v_pv.customer_id, v_pv.staff_id
    );
    v_line := v_line + 1;
  END IF;

  -- Line 5: Credit Bank / Cash with actual cash paid
  INSERT INTO public.journal_entry_lines(
    journal_entry_id, line_number, account_id, description, debit, credit,
    transaction_currency, transaction_debit, transaction_credit, exchange_rate,
    supplier_id, customer_id, payee_id
  ) VALUES (
    v_je, v_line, v_bank_coa, 'Bank Payment - ' || v_pv.voucher_number, 0, v_actual,
    v_bank_currency, 0, v_actual, 1,
    v_pv.supplier_id, v_pv.customer_id, v_pv.staff_id
  );

  UPDATE public.payment_vouchers SET is_posted = true, journal_entry_id = v_je WHERE id = p_pv_id;

  INSERT INTO public.audit_logs(table_name, record_id, action_type, old_values, new_values, user_id)
  VALUES('payment_vouchers', p_pv_id, 'update', jsonb_build_object('is_posted', false), jsonb_build_object('is_posted', true, 'journal_entry_id', v_je), v_actual_poster);
END;
$function$;

REVOKE ALL ON FUNCTION public.post_receipt_voucher(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.post_receipt_voucher(uuid, uuid) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.post_payment_voucher(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.post_payment_voucher(uuid, uuid) TO authenticated, service_role;
