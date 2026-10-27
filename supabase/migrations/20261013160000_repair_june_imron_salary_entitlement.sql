-- ============================================================================
-- Repair June 2026 Imron Salary Entitlement (EXP/26-26/087)
-- ============================================================================
-- Confirmed facts:
-- 1. Muhamad Imron Hanifah had absence in June 2026.
-- 2. Net salary entitlement after absence deduction: Rp2,335,000.
-- 3. Paid via Rp500,000 cash advance (PV/26-26/014 on 18 June) + Rp1,835,000
--    bank transfer (on 02 July, matched to EXP/26-26/087).
-- 4. Advance recovered via non-cash PV/26-26/022 (Rp500,000).
-- 5. EXP/26-26/087 was previously entered as Rp1,835,000 (net cash only),
--    leaving an artificial debit on AP and under-recording salary expense.
-- 6. Updating EXP/26-26/087 and accrual JE2607-0025 to Rp2,335,000 brings
--    Salaries (6100), Accounts Payable (2110), Staff Advances (1160), and Bank
--    into complete balance with Rp0 outstanding payable.
-- ============================================================================

DO $$
DECLARE
  v_exp_id uuid := 'c5c17015-dbec-4b42-8cdf-9c20ef752a9b';
  v_je_id  uuid := '75ef78fe-574a-4141-842c-f0c1e44a4d2c';
  v_exp RECORD;
  v_je  RECORD;
BEGIN
  -- 1. Update accrual journal lines
  UPDATE public.journal_entry_lines
     SET debit = 2335000.00
   WHERE journal_entry_id = v_je_id AND debit > 0;

  UPDATE public.journal_entry_lines
     SET credit = 2335000.00
   WHERE journal_entry_id = v_je_id AND credit > 0;

  -- 2. Update journal entry totals
  UPDATE public.journal_entries
     SET total_debit = 2335000.00,
         total_credit = 2335000.00
   WHERE id = v_je_id;

  -- 3. Update expense amount
  UPDATE public.finance_expenses
     SET amount = 2335000.00
   WHERE id = v_exp_id;

  -- 4. Recompute payment state
  PERFORM public.recalculate_expense_payment_state(v_exp_id);

  -- 5. Assertions
  SELECT * INTO v_exp FROM public.finance_expenses WHERE id = v_exp_id;
  IF v_exp.amount <> 2335000.00 OR v_exp.paid_amount <> 2335000.00 THEN
    RAISE EXCEPTION 'Assertion failed: EXP/26-26/087 amount (%) or paid_amount (%) unexpected',
      v_exp.amount, v_exp.paid_amount;
  END IF;

  SELECT * INTO v_je FROM public.journal_entries WHERE id = v_je_id;
  IF v_je.total_debit <> 2335000.00 OR v_je.total_credit <> 2335000.00 THEN
    RAISE EXCEPTION 'Assertion failed: JE2607-0025 out of balance';
  END IF;

  RAISE NOTICE 'Successfully repaired June 2026 Imron salary entitlement to Rp2,335,000.';
END $$;
