-- ==============================================================================
-- MIGRATION: 20261102020000_synchronize_ndpbm_and_standardize_reporting_cogs.sql
-- Description: 1. Synchronize Container E0000117/2627 Customs NDPBM with Official PIB (17,937.00)
--              2. Standardize get_expense_vs_profit_report to use Authoritative Line COGS
--              3. Exclude Reversed Journal Entries from get_pnl_summary and get_trial_balance
--              4. Harmonize get_cogs_for_period and get_sales_profit_summary
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. FUNCTION: update_container_customs_ndpbm
-- Recalculates PIB Bea Masuk using official DJBC thousand-rounding rule
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.update_container_customs_ndpbm(
  p_container_id uuid,
  p_customs_ndpbm_rate numeric
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_rec record;
  v_batch_total_bm numeric;
  v_batch_unit_bm numeric;
  v_total_calculated_bm numeric := 0;
  v_has_duty_batches boolean := false;
  v_pib record;
BEGIN
  -- 1. Update container NDPBM rate
  UPDATE public.import_containers
     SET customs_ndpbm_rate = p_customs_ndpbm_rate,
         updated_at = now()
   WHERE id = p_container_id;

  -- 2. Recalculate BM for each linked batch using:
  -- Foreign Currency Assessable Value * Customs NDPBM FX * Duty Percentage
  -- Rounded up to nearest thousand IDR per official DJBC Bea Cukai billing rules
  FOR v_rec IN
    SELECT b.id,
           b.batch_number,
           b.import_quantity,
           b.import_price_usd,
           COALESCE(b.duty_percent, 0) AS duty_percent
      FROM public.batches b
     WHERE b.import_container_id = p_container_id
  LOOP
    IF COALESCE(v_rec.duty_percent, 0) > 0 AND COALESCE(v_rec.import_price_usd, 0) > 0 THEN
      -- DJBC billing rule: Total BM is rounded up to the nearest thousand IDR
      v_batch_total_bm := CEIL((v_rec.import_price_usd * p_customs_ndpbm_rate * (v_rec.duty_percent / 100.0) * COALESCE(v_rec.import_quantity, 1)) / 1000.0) * 1000.0;
      v_batch_unit_bm := ROUND(v_batch_total_bm / NULLIF(v_rec.import_quantity, 0), 2);
      v_total_calculated_bm := v_total_calculated_bm + v_batch_total_bm;
      v_has_duty_batches := true;

      UPDATE public.batches
         SET customs_ndpbm_rate = p_customs_ndpbm_rate,
             customs_assessable_value_idr = ROUND(v_rec.import_price_usd * p_customs_ndpbm_rate * COALESCE(v_rec.import_quantity, 1), 2),
             actual_duty_charges = v_batch_total_bm,
             estimated_duty_charges = v_batch_total_bm,
             duty_charges = v_batch_unit_bm,
             updated_at = now()
       WHERE id = v_rec.id;
    ELSE
      -- 0% duty line remains zero
      UPDATE public.batches
         SET customs_ndpbm_rate = p_customs_ndpbm_rate,
             customs_assessable_value_idr = ROUND(COALESCE(v_rec.import_price_usd, 0) * p_customs_ndpbm_rate * COALESCE(v_rec.import_quantity, 1), 2),
             actual_duty_charges = 0.00,
             estimated_duty_charges = 0.00,
             duty_charges = 0.00,
             updated_at = now()
       WHERE id = v_rec.id;
    END IF;
  END LOOP;

  -- 3. Update existing PIB expense pib_bm_amount & total amount
  IF v_has_duty_batches AND v_total_calculated_bm > 0 THEN
    FOR v_pib IN
      SELECT id, pib_ppn_amount, pib_pph_amount
        FROM public.finance_expenses
       WHERE import_container_id = p_container_id
         AND expense_category = 'pib_import'
    LOOP
      UPDATE public.finance_expenses
         SET pib_bm_amount = v_total_calculated_bm,
             amount = v_total_calculated_bm + COALESCE(v_pib.pib_ppn_amount, 0) + COALESCE(v_pib.pib_pph_amount, 0)
       WHERE id = v_pib.id;
    END LOOP;
  END IF;

  -- 4. Reallocate container costs and propagate into layers, inventory, and COGS
  PERFORM public.reallocate_container_costs(p_container_id);
END;
$function$;

-- ------------------------------------------------------------------------------
-- 2. FUNCTION: get_expense_vs_profit_report
-- Harmonize with CanonicalSalesProfitReport (exclude cancelled invoices, use authoritative COGS)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_expense_vs_profit_report(p_start_date date, p_end_date date)
 RETURNS TABLE(total_sales numeric, total_cogs numeric, gross_profit numeric, outbound_delivery numeric, contribution_profit numeric, operating_expenses numeric, operational_profit numeric, profit_pct numeric, costed_lines bigint, total_lines bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH reportable_lines AS (
    SELECT
      ar.line_id,
      ar.invoice_id,
      ar.quantity,
      sii.unit_price,
      ROUND(ar.quantity * sii.unit_price, 2) AS line_gross_sales,
      ar.authoritative_cogs,
      (ar.authoritative_cogs IS NOT NULL) AS is_costed
    FROM public.get_authoritative_sales_line_cogs(p_start_date, p_end_date) ar
    JOIN public.sales_invoice_items sii ON sii.id = ar.line_id
    JOIN public.sales_invoices si ON si.id = ar.invoice_id
    WHERE public.is_reportable_sales_invoice(si.document_status, si.is_draft, si.notes)
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
        AND NOT COALESCE(je.is_reversed, false)
    ) cogs_reversal ON true
    WHERE cn.status = 'approved'
      AND cn.credit_note_date BETWEEN p_start_date AND p_end_date
  ),
  sales AS (
    SELECT 
      COALESCE(SUM(line_gross_sales), 0) - (SELECT total_return_revenue FROM returns) AS total_sales,
      COALESCE(SUM(line_gross_sales) FILTER (WHERE is_costed), 0) - (SELECT total_return_revenue FROM returns) AS costed_revenue,
      COALESCE(SUM(authoritative_cogs) FILTER (WHERE is_costed), 0) - (SELECT total_return_cogs FROM returns) AS total_cogs,
      COUNT(*) FILTER (WHERE is_costed) AS costed_lines,
      COUNT(*) AS total_lines
    FROM reportable_lines
  ),
  expenses AS (
    SELECT 
      COALESCE(SUM(amount) FILTER (WHERE expense_category IN ('delivery_sales', 'loading_sales', 'freight_outward', 'delivery_expense')), 0) AS outbound_delivery,
      COALESCE(SUM(amount) FILTER (WHERE expense_category NOT IN ('delivery_sales', 'loading_sales', 'freight_outward', 'delivery_expense')), 0) AS operating_expenses
    FROM public.finance_expenses
    WHERE expense_date >= p_start_date AND expense_date <= p_end_date
      AND COALESCE(approval_status, 'approved') NOT IN ('cancelled', 'rejected')
  )
  SELECT 
    ROUND(s.total_sales, 2),
    ROUND(s.total_cogs, 2),
    ROUND(s.costed_revenue - s.total_cogs, 2) AS gross_profit,
    ROUND(e.outbound_delivery, 2),
    ROUND(s.costed_revenue - s.total_cogs - e.outbound_delivery, 2) AS contribution_profit,
    ROUND(e.operating_expenses, 2),
    ROUND(s.costed_revenue - s.total_cogs - e.outbound_delivery - e.operating_expenses, 2) AS operational_profit,
    CASE WHEN s.costed_revenue = 0 THEN NULL 
      ELSE ROUND((s.costed_revenue - s.total_cogs - e.outbound_delivery - e.operating_expenses) / s.costed_revenue * 100, 2) 
    END AS profit_pct,
    s.costed_lines,
    s.total_lines
  FROM sales s CROSS JOIN expenses e;
$function$;

-- ------------------------------------------------------------------------------
-- 3. FUNCTION: get_pnl_summary (with reversed journals excluded)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_pnl_summary(p_start_date date, p_end_date date, p_usd_rate numeric)
 RETURNS TABLE(total_revenue numeric, total_expenses numeric, net_income numeric)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT
    COALESCE(SUM(CASE WHEN coa.account_type = 'revenue'
      THEN (jel.credit - jel.debit) * public.get_journal_reporting_multiplier(je.id, p_usd_rate)
      ELSE 0 END), 0)::numeric AS total_revenue,
    COALESCE(SUM(CASE WHEN coa.account_type = 'expense'
      THEN (jel.debit - jel.credit) * public.get_journal_reporting_multiplier(je.id, p_usd_rate)
      ELSE 0 END), 0)::numeric AS total_expenses,
    (
      COALESCE(SUM(CASE WHEN coa.account_type = 'revenue'
        THEN (jel.credit - jel.debit) * public.get_journal_reporting_multiplier(je.id, p_usd_rate)
        ELSE 0 END), 0)
      - COALESCE(SUM(CASE WHEN coa.account_type = 'expense'
        THEN (jel.debit - jel.credit) * public.get_journal_reporting_multiplier(je.id, p_usd_rate)
        ELSE 0 END), 0)
    )::numeric AS net_income
  FROM public.journal_entry_lines jel
  JOIN public.journal_entries je ON je.id = jel.journal_entry_id
  JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
  WHERE je.is_posted = true
    AND NOT COALESCE(je.is_reversed, false)
    AND je.entry_date BETWEEN p_start_date AND p_end_date;
$function$;

-- ------------------------------------------------------------------------------
-- 4. FUNCTION: get_trial_balance (with reversed journals excluded)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_trial_balance(p_start_date date, p_end_date date, p_usd_rate numeric)
 RETURNS TABLE(code character varying, name character varying, name_id character varying, account_type character varying, account_group character varying, normal_balance character varying, total_debit numeric, total_credit numeric, balance numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  RETURN QUERY
  WITH active_lines AS (
    SELECT jel.account_id, jel.debit, jel.credit
    FROM public.journal_entry_lines jel
    JOIN public.journal_entries je ON je.id = jel.journal_entry_id
    WHERE je.is_posted = true
      AND NOT COALESCE(je.is_reversed, false)
      AND je.entry_date BETWEEN p_start_date AND p_end_date
  )
  SELECT coa.code, coa.name, coa.name_id, coa.account_type, coa.account_group,
    COALESCE(coa.normal_balance,
      CASE WHEN coa.account_type IN ('asset', 'expense') THEN 'debit' ELSE 'credit' END),
    COALESCE(SUM(al.debit), 0)::numeric,
    COALESCE(SUM(al.credit), 0)::numeric,
    (COALESCE(SUM(al.debit), 0) - COALESCE(SUM(al.credit), 0))::numeric
  FROM public.chart_of_accounts coa
  LEFT JOIN active_lines al ON al.account_id = coa.id
  WHERE coa.is_header = false AND coa.is_active = true
  GROUP BY coa.id, coa.code, coa.name, coa.name_id, coa.account_type,
    coa.account_group, coa.normal_balance
  HAVING COALESCE(SUM(al.debit), 0) <> 0 OR COALESCE(SUM(al.credit), 0) <> 0
  ORDER BY coa.code;
END;
$function$;

-- ------------------------------------------------------------------------------
-- 5. FUNCTION: get_cogs_for_period (harmonized with authoritative line COGS)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_cogs_for_period(p_start date, p_end date)
 RETURNS numeric
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT COALESCE(SUM(authoritative_cogs), 0)
  FROM public.get_authoritative_sales_line_cogs(p_start, p_end);
$function$;

-- ------------------------------------------------------------------------------
-- 6. FUNCTION: get_sales_profit_summary (harmonized with authoritative line COGS)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_sales_profit_summary(p_start_date date, p_end_date date)
 RETURNS TABLE(product_id uuid, product_name text, product_code text, product_unit text, total_qty_sold numeric, total_revenue numeric, costed_revenue numeric, total_cogs numeric, total_profit numeric, profit_pct numeric, costed_lines bigint, total_lines bigint, no_cost boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH reportable_lines AS (
    SELECT
      ar.line_id,
      ar.invoice_id,
      ar.product_id,
      p.product_name,
      COALESCE(p.product_code, '') AS product_code,
      COALESCE(p.unit, 'kg') AS product_unit,
      ar.quantity,
      sii.unit_price,
      ROUND(ar.quantity * sii.unit_price, 2) AS line_gross_sales,
      ar.authoritative_cogs,
      (ar.authoritative_cogs IS NOT NULL) AS is_costed
    FROM public.get_authoritative_sales_line_cogs(p_start_date, p_end_date) ar
    JOIN public.sales_invoice_items sii ON sii.id = ar.line_id
    JOIN public.sales_invoices si ON si.id = ar.invoice_id
    JOIN public.products p ON p.id = ar.product_id
    WHERE public.is_reportable_sales_invoice(si.document_status, si.is_draft, si.notes)
  ), grouped AS (
    SELECT product_id, product_name, product_code, product_unit,
      SUM(quantity) AS total_qty_sold,
      SUM(line_gross_sales) AS total_revenue,
      SUM(line_gross_sales) FILTER (WHERE is_costed) AS costed_revenue,
      COALESCE(SUM(authoritative_cogs) FILTER (WHERE is_costed), 0) AS total_cogs,
      COUNT(*) FILTER (WHERE is_costed) AS costed_lines,
      COUNT(*) AS total_lines
    FROM reportable_lines GROUP BY product_id, product_name, product_code, product_unit
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
$function$;

-- ------------------------------------------------------------------------------
-- 7. RECONCILE CONTAINER E0000117/2627 CUSTOMS NDPBM
-- ------------------------------------------------------------------------------
DO $$
BEGIN
  -- Reconcile container E0000117/2627 NDPBM with official PIB declaration: 17,937.0000
  UPDATE public.import_containers
     SET customs_ndpbm_rate = 17937.0000
   WHERE id = '4df4f6b9-a237-4eec-a297-1babcfb82856';

  -- Trigger recalculation and propagation for container E0000117/2627
  PERFORM public.update_container_customs_ndpbm('4df4f6b9-a237-4eec-a297-1babcfb82856'::uuid, 17937.0000);

  -- Record migration in schema_migrations
  INSERT INTO supabase_migrations.schema_migrations (version, name)
  VALUES ('20261102020000', 'synchronize_ndpbm_and_standardize_reporting_cogs')
  ON CONFLICT (version) DO NOTHING;
END $$;

