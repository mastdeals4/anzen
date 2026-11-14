BEGIN;

-- Least-privilege: allocation rows are written only by trusted SECURITY DEFINER
-- triggers / server-side functions. Authenticated Finance users retain read access.
REVOKE ALL ON TABLE public.finance_expense_pph_allocations FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.finance_expense_pph_allocations TO authenticated;
GRANT ALL ON TABLE public.finance_expense_pph_allocations TO service_role, postgres;

-- Amendment authorization must never be callable by anonymous clients.
-- Authenticated calls are still checked internally against admin/super_admin.
REVOKE ALL ON FUNCTION public.authorize_tax_period_amendment(uuid, text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.authorize_tax_period_amendment(uuid, text, integer) TO authenticated, service_role;

-- Remove the hard-coded unpaid Ricardo voucher exception. Legacy expense-level
-- recognition now requires an actual positive paid_amount; new multi-payment
-- expenses are recognized from finance_expense_pph_allocations.
CREATE OR REPLACE FUNCTION public.fn_pph_authoritative_source_total(p_period_id uuid)
RETURNS numeric
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH period AS (
    SELECT id, fiscal_year, period_month, tax_type, period_start, period_end
      FROM public.tax_periods WHERE id = p_period_id AND tax_type <> 'PPN'
  )
  SELECT COALESCE((
    SELECT SUM(fepa.recognized_pph_amount)
      FROM period p
      JOIN public.finance_expense_pph_allocations fepa ON fepa.tax_period_id = p.id
      JOIN public.finance_expenses fe ON fe.id = fepa.expense_id
      JOIN public.effective_expense_posting_state eps ON eps.expense_id = fe.id
       AND eps.effective_posting_state IN ('ACTIVE','REPLACED')
      LEFT JOIN public.tax_codes tc ON tc.id = fe.pph_code_id
     WHERE fe.approval_status = 'approved' AND fe.pph_amount > 0
       AND NOT fepa.is_reversed
       AND COALESCE(fe.expense_category,'') NOT IN ('pib_import','pph_import')
       AND (p.tax_type = 'PPh_Unifikasi' OR tc.tax_type = p.tax_type)
  ), 0)
  + COALESCE((
    SELECT SUM(fe.pph_amount)
      FROM period p
      JOIN public.finance_expenses fe
        ON (
          fe.pph_tax_period_id = p.id
          OR (
            p.tax_type = 'PPh_Unifikasi' AND EXISTS (
              SELECT 1 FROM public.tax_periods p_sub
               WHERE p_sub.id = fe.pph_tax_period_id
                 AND p_sub.fiscal_year = p.fiscal_year
                 AND p_sub.period_month = p.period_month
            )
          )
        )
      JOIN public.effective_expense_posting_state eps ON eps.expense_id = fe.id
       AND eps.effective_posting_state IN ('ACTIVE','REPLACED')
      LEFT JOIN public.tax_codes tc ON tc.id = fe.pph_code_id
     WHERE fe.approval_status = 'approved' AND fe.pph_amount > 0
       AND COALESCE(fe.expense_category,'') NOT IN ('pib_import','pph_import')
       AND (p.tax_type = 'PPh_Unifikasi' OR tc.tax_type = p.tax_type)
       AND NOT EXISTS (
         SELECT 1 FROM public.finance_expense_pph_allocations fepa
          WHERE fepa.expense_id = fe.id
       )
       AND COALESCE(fe.paid_amount, 0) > 0.01
  ), 0)
  + COALESCE((
    SELECT SUM(pv.pph_amount) FROM period p
      JOIN public.payment_vouchers pv ON (
        pv.tax_period_id = p.id
        OR (p.tax_type = 'PPh_Unifikasi' AND EXISTS (
            SELECT 1 FROM public.tax_periods p_sub
             WHERE p_sub.id = pv.tax_period_id
               AND p_sub.fiscal_year = p.fiscal_year
               AND p_sub.period_month = p.period_month
        ))
      )
      LEFT JOIN public.tax_codes tc ON tc.id = pv.pph_code_id
     WHERE COALESCE(pv.is_posted,false) AND pv.pph_amount > 0
       AND (p.tax_type = 'PPh_Unifikasi' OR tc.tax_type = p.tax_type)
  ), 0)
  + COALESCE((
    SELECT SUM(tp.amount) FROM period p
      JOIN public.tax_payments tp ON tp.tax_period_id = p.id
     WHERE (p.tax_type = 'PPh_Unifikasi' OR tp.tax_type = p.tax_type)
       AND tp.historical_source_status = 'missing_source_verified'
  ), 0);
$$;

-- These two entries were hard-coded into November despite having zero paid_amount
-- and no bank, voucher, petty-cash or payment-level allocation. November is open,
-- not filed. Clear only their incorrect PPh period links.
DO $$
DECLARE
    v_period_id uuid;
    v_filing_status text;
    v_status text;
    v_updated integer;
BEGIN
    SELECT id, filing_status, status
      INTO v_period_id, v_filing_status, v_status
      FROM public.tax_periods
     WHERE fiscal_year = 2026 AND period_month = 11 AND tax_type = 'PPh21'
     FOR UPDATE;

    IF v_period_id IS NULL THEN
        RAISE EXCEPTION 'November 2026 PPh21 period not found';
    END IF;

    IF v_filing_status = 'filed' OR v_status IN ('filed','closed') THEN
        RAISE EXCEPTION 'November 2026 PPh21 is filed/closed; refusing unpaid-source correction';
    END IF;

    PERFORM set_config('app.finance_metadata_repair', 'on', true);

    UPDATE public.finance_expenses fe
       SET pph_tax_period_id = NULL
     WHERE fe.voucher_number IN ('EXP/26/334','EXP/26/335')
       AND fe.pph_tax_period_id = v_period_id
       AND COALESCE(fe.pph_amount,0) = 50000
       AND COALESCE(fe.paid_amount,0) <= 0.01
       AND NOT EXISTS (SELECT 1 FROM public.bank_statement_allocations bsa WHERE bsa.document_id = fe.id)
       AND NOT EXISTS (SELECT 1 FROM public.voucher_allocations va WHERE va.finance_expense_id = fe.id)
       AND NOT EXISTS (SELECT 1 FROM public.petty_cash_transactions pct WHERE pct.finance_expense_id = fe.id)
       AND NOT EXISTS (SELECT 1 FROM public.finance_expense_pph_allocations a WHERE a.expense_id = fe.id AND NOT a.is_reversed);

    GET DIAGNOSTICS v_updated = ROW_COUNT;
    IF v_updated NOT IN (0, 2) THEN
        RAISE EXCEPTION 'Expected either 2 unpaid November PPh links to clear or 0 already-corrected rows; updated %', v_updated;
    END IF;

    PERFORM public.compute_period_ppn(v_period_id);
END;
$$;

COMMIT;
