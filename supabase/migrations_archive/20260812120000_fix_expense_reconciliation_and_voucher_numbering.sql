-- Targeted SAPJ Finance stabilization:
--   1. Remove the stale legacy bank match from pending EXP/26/101.
--   2. Complete EXP/26-26/085 through the existing fixed-asset posting path.
--   3. Standardize all newly generated expense vouchers as EXP/YY/NNN.
--
-- Historical voucher numbers and historical expense values are not renamed.

-- Voucher numbers are document identities. The canonical generator serializes
-- allocation, while this index is the final database-level duplicate guard.
CREATE UNIQUE INDEX IF NOT EXISTS uq_finance_expenses_voucher_number
  ON public.finance_expenses (voucher_number)
  WHERE voucher_number IS NOT NULL;

CREATE OR REPLACE FUNCTION public.next_expense_voucher_number(p_expense_date date)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_year text;
  v_prefix text;
  v_next int;
BEGIN
  IF p_expense_date IS NULL THEN
    RAISE EXCEPTION 'Expense date is required';
  END IF;

  v_year := to_char(p_expense_date, 'YY');
  v_prefix := 'EXP/' || v_year || '/';

  -- One lock covers both the canonical EXP/YY/NNN series and the preserved
  -- historical EXP/YY-YY/NNN series so their numeric suffixes cannot collide.
  PERFORM pg_advisory_xact_lock(hashtext('expense_voucher_' || v_year));

  SELECT COALESCE(MAX((regexp_match(voucher_number, '/([0-9]+)$'))[1]::int), 0) + 1
    INTO v_next
    FROM public.finance_expenses
   WHERE voucher_number LIKE v_prefix || '%'
      OR voucher_number LIKE 'EXP/' || v_year || '-' || v_year || '/%';

  RETURN v_prefix || lpad(v_next::text, 3, '0');
END;
$$;

REVOKE ALL ON FUNCTION public.next_expense_voucher_number(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.next_expense_voucher_number(date)
  TO authenticated, service_role;

DO $$
DECLARE
  v_expense_id uuid;
  v_bank_line_id uuid;
BEGIN
  SELECT fe.id, bsl.id
    INTO v_expense_id, v_bank_line_id
    FROM public.finance_expenses fe
    JOIN public.bank_statement_lines bsl ON bsl.matched_expense_id = fe.id
   WHERE fe.voucher_number = 'EXP/26/101'
     AND fe.approval_status = 'pending_approval'
     AND fe.settlement_amount = 3219000.00
     AND bsl.id = 'c4c4033b-f661-4574-8878-dc593ee4eb33'::uuid
     AND bsl.reconciliation_status = 'matched'
     AND bsl.matched_entry_id IS NULL
     AND (COALESCE(bsl.debit_amount, 0) + COALESCE(bsl.credit_amount, 0)) = 3651500.00;

  IF v_expense_id IS NOT NULL THEN
    -- The canonical unlink command clears every typed/journal link, marks the
    -- line manually unlinked, and recalculates the expense payment state.
    PERFORM set_config('request.jwt.claim.role', 'service_role', true);
    PERFORM public.unmatch_bank_line(v_bank_line_id);
  END IF;
END;
$$;

DO $$
DECLARE
  v_expense_id uuid;
  v_asset_account_id uuid;
  v_bank_line_id uuid;
BEGIN
  SELECT id INTO v_asset_account_id
    FROM public.chart_of_accounts
   WHERE code = '1203'
     AND name = 'Air Conditioners'
     AND account_type = 'asset'
     AND is_active = true
     AND is_header = false;

  IF v_asset_account_id IS NULL THEN
    RAISE EXCEPTION 'Active leaf Fixed Asset COA 1203 — Air Conditioners is required';
  END IF;

  SELECT fe.id INTO v_expense_id
    FROM public.finance_expenses fe
   WHERE fe.voucher_number = 'EXP/26-26/085'
     AND fe.approval_status = 'approved'
     AND fe.expense_category = 'fixed_asset'
     AND fe.fixed_asset_account_id IS NULL
     AND fe.expense_date = DATE '2025-10-15'
     AND fe.amount = 4684685.00
     AND fe.ppn_amount = 515315.00
     AND fe.settlement_amount = 5200000.00
     AND fe.description ILIKE '%AC 1.5 PK MIDEA%';

  IF v_expense_id IS NOT NULL THEN
    -- Updating the source classification invokes the existing expense posting
    -- trigger; it creates the normal DR 1203 / DR 1150 / CR bank journal.
    UPDATE public.finance_expenses
       SET fixed_asset_account_id = v_asset_account_id
     WHERE id = v_expense_id;

    SELECT id INTO v_bank_line_id
      FROM public.bank_statement_lines
     WHERE matched_expense_id = v_expense_id
       AND reconciliation_status = 'matched'
       AND matched_entry_id IS NULL
       AND (COALESCE(debit_amount, 0) + COALESCE(credit_amount, 0)) = 5200000.00;

    IF v_bank_line_id IS NULL THEN
      RAISE EXCEPTION 'EXP/26-26/085 requires its existing Rp5,200,000 bank statement line';
    END IF;

    PERFORM set_config('request.jwt.claim.role', 'service_role', true);
    PERFORM public.link_bank_statement_line(v_bank_line_id, 'expense', v_expense_id, 'supplier');
  END IF;
END;
$$;

DO $$
BEGIN
  IF public.next_expense_voucher_number(DATE '2026-08-12') <> 'EXP/26/174' THEN
    RAISE EXCEPTION 'Unexpected next expense voucher number: %', public.next_expense_voucher_number(DATE '2026-08-12');
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.finance_expenses
     WHERE voucher_number = 'EXP/26/101'
       AND (approval_status <> 'pending_approval' OR paid_amount <> 0)
  ) THEN RAISE EXCEPTION 'EXP/26/101 state was not corrected'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.bank_statement_lines
     WHERE id = 'c4c4033b-f661-4574-8878-dc593ee4eb33'::uuid
       AND (reconciliation_status <> 'unmatched' OR matched_expense_id IS NOT NULL OR matched_entry_id IS NOT NULL)
  ) THEN RAISE EXCEPTION 'EXP/26/101 bank line was not truthfully unlinked'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.finance_expenses fe
    JOIN public.chart_of_accounts coa ON coa.id = fe.fixed_asset_account_id
     WHERE fe.voucher_number = 'EXP/26-26/085' AND coa.code = '1203'
  ) THEN RAISE EXCEPTION 'EXP/26-26/085 did not resolve to Fixed Asset COA 1203'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.finance_expenses fe
    JOIN public.bank_statement_lines bsl ON bsl.matched_expense_id = fe.id
    JOIN public.journal_entries je ON je.id = bsl.matched_entry_id
     WHERE fe.voucher_number = 'EXP/26-26/085'
       AND bsl.reconciliation_status = 'matched'
       AND je.is_posted AND NOT COALESCE(je.is_reversed, false)
  ) THEN RAISE EXCEPTION 'EXP/26-26/085 journal/bank relationship was not restored'; END IF;
END;
$$;
