-- Authorized, evidence-backed correction for EXP/26/119 only.
-- Preserves the original document/journal identity and uses the existing PPh23
-- source fields plus the established expense PPh journal synchronization.
BEGIN;

DO $$
DECLARE
  v_expense public.finance_expenses%ROWTYPE;
  v_journal public.journal_entries%ROWTYPE;
  v_corrected_journal public.journal_entries%ROWTYPE;
  v_pph23_code uuid;
  v_bank_coa uuid;
  v_before_lines jsonb;
  v_after_lines jsonb;
BEGIN
  SELECT * INTO v_expense
    FROM public.finance_expenses
   WHERE voucher_number = 'EXP/26/119'
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'EXP/26/119 not found; correction aborted'; END IF;

  -- Guard the proofed historical state so this migration cannot affect a
  -- revised or unrelated record.
  IF v_expense.amount <> 6860000 OR v_expense.ppn_amount <> 140000
     OR COALESCE(v_expense.pph_amount, 0) <> 0 OR v_expense.pph_code_id IS NOT NULL
  THEN
    RAISE EXCEPTION 'EXP/26/119 no longer matches the approved pre-correction state; correction aborted';
  END IF;

  SELECT * INTO v_journal
    FROM public.journal_entries
   WHERE source_module = 'expenses' AND reference_id = v_expense.id
     AND is_posted = true AND COALESCE(is_reversed, false) = false
   ORDER BY created_at DESC LIMIT 1
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Active source journal for EXP/26/119 not found; correction aborted'; END IF;
  IF v_journal.entry_number <> 'JE2602-0186' OR v_journal.total_debit <> 7000000 OR v_journal.total_credit <> 7000000 THEN
    RAISE EXCEPTION 'JE2602-0186 no longer matches the approved pre-correction state; correction aborted';
  END IF;

  SELECT id INTO v_pph23_code FROM public.tax_codes
   WHERE code = 'PPH23-2' AND tax_type = 'PPh23' AND is_withholding = true;
  IF v_pph23_code IS NULL THEN RAISE EXCEPTION 'Existing PPh23 Services tax code is unavailable; correction aborted'; END IF;

  SELECT coa_id INTO v_bank_coa FROM public.bank_accounts WHERE id = v_expense.bank_account_id;
  IF v_bank_coa IS NULL THEN RAISE EXCEPTION 'EXP/26/119 bank account has no COA; correction aborted'; END IF;

  SELECT jsonb_agg(jsonb_build_object('line_number', line_number, 'account_id', account_id, 'debit', debit, 'credit', credit, 'description', description) ORDER BY line_number)
    INTO v_before_lines FROM public.journal_entry_lines WHERE journal_entry_id = v_journal.id;

  INSERT INTO public.audit_logs (table_name, action_type, record_id, old_values, new_values, user_id)
  VALUES (
    'finance_expenses', 'update', v_expense.id,
    jsonb_build_object(
      'expense', to_jsonb(v_expense), 'journal_id', v_journal.id,
      'journal_number', v_journal.entry_number, 'journal_lines', v_before_lines,
      'reason', 'Authorized correction: documented PPh23 withholding of Rp140,000 was omitted from EXP/26/119 source fields and journal.'
    ),
    jsonb_build_object(
      'pph_amount', 140000, 'pph_code_id', v_pph23_code,
      'expected_bank_settlement', 6860000, 'expected_pph23_payable', 140000
    ),
    NULL
  );

  -- The existing approved-expense posting trigger replaces the source journal
  -- in place (retaining its entry number/source identity), then the existing
  -- PPh synchronization trigger splits its bank credit. Do not hand-write a
  -- second posting path here.
  UPDATE public.finance_expenses
     SET pph_amount = 140000,
         pph_code_id = v_pph23_code
   WHERE id = v_expense.id;

  SELECT * INTO v_corrected_journal
    FROM public.journal_entries
   WHERE source_module = 'expenses' AND reference_id = v_expense.id
     AND is_posted = true AND COALESCE(is_reversed, false) = false
   ORDER BY created_at DESC LIMIT 1;
  IF NOT FOUND OR v_corrected_journal.entry_number <> v_journal.entry_number THEN
    RAISE EXCEPTION 'EXP/26/119 posting did not retain its active source journal identity; correction aborted';
  END IF;

  SELECT jsonb_agg(jsonb_build_object('line_number', line_number, 'account_id', account_id, 'debit', debit, 'credit', credit, 'description', description) ORDER BY line_number)
    INTO v_after_lines FROM public.journal_entry_lines WHERE journal_entry_id = v_corrected_journal.id;

  IF NOT EXISTS (SELECT 1 FROM public.finance_expenses WHERE id=v_expense.id AND settlement_amount=6860000 AND pph_amount=140000 AND pph_code_id=v_pph23_code) THEN
    RAISE EXCEPTION 'EXP/26/119 source settlement/PPh fields did not correct as expected';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.journal_entry_lines WHERE journal_entry_id=v_corrected_journal.id AND account_id=v_bank_coa AND credit=6860000 AND debit=0)
     OR NOT EXISTS (SELECT 1 FROM public.journal_entry_lines jel JOIN public.chart_of_accounts coa ON coa.id=jel.account_id WHERE jel.journal_entry_id=v_corrected_journal.id AND coa.code='2132' AND jel.credit=140000 AND jel.debit=0)
     OR NOT EXISTS (SELECT 1 FROM public.journal_entry_lines jel JOIN public.chart_of_accounts coa ON coa.id=jel.account_id WHERE jel.journal_entry_id=v_corrected_journal.id AND coa.code='6700' AND jel.debit=6860000 AND jel.credit=0)
     OR NOT EXISTS (SELECT 1 FROM public.journal_entry_lines jel JOIN public.chart_of_accounts coa ON coa.id=jel.account_id WHERE jel.journal_entry_id=v_corrected_journal.id AND coa.code='1150' AND jel.debit=140000 AND jel.credit=0)
     OR v_corrected_journal.total_debit <> 7000000
     OR v_corrected_journal.total_credit <> 7000000
  THEN
    RAISE EXCEPTION 'JE2602-0186 did not correct to the authorized PPh23/bank split';
  END IF;

  INSERT INTO public.audit_logs (table_name, action_type, record_id, old_values, new_values, user_id)
  VALUES (
    'journal_entries', 'update', v_corrected_journal.id,
    jsonb_build_object('journal_id_before', v_journal.id, 'journal_lines_before', v_before_lines),
    jsonb_build_object('journal_id_after', v_corrected_journal.id, 'journal_lines_after', v_after_lines, 'reason', 'Existing expense PPh23 synchronization corrected the authorized withholding split.'),
    NULL
  );
END $$;

NOTIFY pgrst, 'reload schema';
COMMIT;
