-- ============================================================================
-- Migration: 20261114130000_pph_null_unallocated_unpaid_exclusions.sql
-- Description:
--   Establishes statutory cash payment-basis recognition for PPh withholding tax:
--   1. An expense with PPh receives a PPh tax period ONLY after actual payment,
--      using the actual payment date (bank transfer, cash date, voucher date).
--   2. Unpaid expenses retain pph_tax_period_id = NULL and contribute Rp 0 to
--      monthly PPh recognized totals.
--   3. REMOVES the date-based fallback from fn_pph_authoritative_source_total.
--      Unallocated expenses (pph_tax_period_id IS NULL) are NEVER silently
--      attributed to their expense month.
--   4. Excludes advance import taxes (pib_import, pph_import) from withholding.
--   5. PPN calculation behavior remains 100% intact.
-- ============================================================================

BEGIN;

-- 1. Helper function: resolves actual payment event date of an expense
CREATE OR REPLACE FUNCTION public.get_expense_pph_payment_date(p_expense_id uuid)
RETURNS date
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_payment_date date;
  v_payment_method text;
  v_expense_date date;
  v_paid_amount numeric;
  v_orig_bsl_id uuid;
BEGIN
  SELECT fe.expense_date, fe.payment_method, fe.paid_amount, fe.originating_bank_statement_line_id
    INTO v_expense_date, v_payment_method, v_paid_amount, v_orig_bsl_id
    FROM public.finance_expenses fe
   WHERE fe.id = p_expense_id;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  -- (a) Cash / petty cash expenses are paid at recorded expense date
  IF v_payment_method = 'cash' THEN
    RETURN v_expense_date;
  END IF;

  -- (b) Check bank_statement_allocations
  SELECT bsl.transaction_date INTO v_payment_date
    FROM public.bank_statement_allocations bsa
    JOIN public.bank_statement_lines bsl ON bsl.id = bsa.bank_statement_line_id
   WHERE bsa.document_id = p_expense_id
     AND bsl.transaction_date IS NOT NULL
   ORDER BY bsl.transaction_date ASC
   LIMIT 1;

  IF v_payment_date IS NOT NULL THEN
    RETURN v_payment_date;
  END IF;

  -- (c) Check originating_bank_statement_line_id
  IF v_orig_bsl_id IS NOT NULL THEN
    SELECT bsl.transaction_date INTO v_payment_date
      FROM public.bank_statement_lines bsl
     WHERE bsl.id = v_orig_bsl_id
       AND bsl.transaction_date IS NOT NULL;

    IF v_payment_date IS NOT NULL THEN
      RETURN v_payment_date;
    END IF;
  END IF;

  -- (d) Check direct bank_statement_lines match
  SELECT bsl.transaction_date INTO v_payment_date
    FROM public.bank_statement_lines bsl
   WHERE bsl.matched_expense_id = p_expense_id
     AND bsl.transaction_date IS NOT NULL
   ORDER BY bsl.transaction_date ASC
   LIMIT 1;

  IF v_payment_date IS NOT NULL THEN
    RETURN v_payment_date;
  END IF;

  -- (e) Check payment voucher allocations
  SELECT pv.voucher_date INTO v_payment_date
    FROM public.voucher_allocations va
    JOIN public.payment_vouchers pv ON pv.id = va.voucher_id
   WHERE (va.expense_id = p_expense_id OR va.finance_expense_id = p_expense_id)
     AND pv.voucher_date IS NOT NULL
   ORDER BY pv.voucher_date ASC
   LIMIT 1;

  IF v_payment_date IS NOT NULL THEN
    RETURN v_payment_date;
  END IF;

  -- If paid_amount > 0.01 but no linked record, use recorded payment/expense date
  IF COALESCE(v_paid_amount, 0) > 0.01 THEN
    RETURN v_expense_date;
  END IF;

  -- Unpaid
  RETURN NULL;
END;
$$;

-- 2. Central PPh period date resolver
CREATE OR REPLACE FUNCTION public.get_expense_pph_period_date(p_expense_id uuid)
RETURNS date
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_payment_date date;
BEGIN
  v_payment_date := public.get_expense_pph_payment_date(p_expense_id);
  RETURN v_payment_date;
END;
$$;

-- 3. Authoritative source resolver:
-- STRICT RULE: PPh is recognized ONLY through explicit, assigned pph_tax_period_id.
-- DATE-BASED FALLBACK REMOVED.
CREATE OR REPLACE FUNCTION public.fn_pph_authoritative_source_total(p_period_id uuid)
RETURNS numeric LANGUAGE sql STABLE SET search_path = public AS $$
  WITH period AS (
    SELECT id, fiscal_year, period_month, tax_type, period_start, period_end
      FROM public.tax_periods WHERE id = p_period_id AND tax_type <> 'PPN'
  )
  -- (a) Genuine withholding on expenses explicitly allocated to this PPh period
  SELECT COALESCE((
    SELECT SUM(
      CASE
        -- If cash, withholding is full
        WHEN COALESCE(fe.payment_method, '') = 'cash' THEN fe.pph_amount
        -- If completely unpaid, 0 recognized withholding
        WHEN COALESCE(fe.paid_amount, 0) <= 0.01 THEN 0
        -- For partial payments, proportionate recognition
        ELSE ROUND(
          fe.pph_amount * LEAST(
            1.0,
            GREATEST(
              0.0,
              fe.paid_amount / NULLIF(
                fe.amount
                + COALESCE(fe.ppn_amount, 0)
                - CASE WHEN fe.pph_treatment = 'deduct' THEN fe.pph_amount ELSE 0 END
                + COALESCE(fe.stamp_duty_amount, 0)
                + COALESCE(fe.bank_charges_amount, 0),
                0
              )
            )
          )
        )
      END
    )
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
       -- Exclude completely unpaid expenses from recognized withholding
       AND NOT (COALESCE(fe.payment_method, '') <> 'cash' AND COALESCE(fe.paid_amount, 0) <= 0.01)
  ),0)
  -- (b) Genuine withholding on payment vouchers explicitly assigned to this tax period
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
  ),0)
  -- (c) Historical verified tax payments with missing source
  + COALESCE((
    SELECT SUM(tp.amount) FROM period p
      JOIN public.tax_payments tp ON tp.tax_period_id = p.id
     WHERE (p.tax_type = 'PPh_Unifikasi' OR tp.tax_type = p.tax_type)
       AND tp.historical_source_status = 'missing_source_verified'
  ),0);
$$;

GRANT EXECUTE ON FUNCTION public.get_expense_pph_payment_date(uuid) TO authenticated, service_role, anon;
GRANT EXECUTE ON FUNCTION public.get_expense_pph_period_date(uuid) TO authenticated, service_role, anon;
GRANT EXECUTE ON FUNCTION public.fn_pph_authoritative_source_total(uuid) TO authenticated, service_role, anon;

COMMIT;

