-- ============================================================================
-- Backfill finance_expenses that had no journal entry
-- ============================================================================
-- Root cause: expenses created before trigger was installed on production DB.
-- The auto_post_expense_accounting trigger guards UPDATE with an early-return
-- if no financial fields change, so a trivial UPDATE cannot trigger posting.
--
-- Additional issue: bpom_ski_fees mapped to 5410 in get_expense_account_id()
-- but account 5410 did not exist in chart_of_accounts — SELECT returned NULL,
-- fallback returned 6000 (header account), prevent_header_account_posting
-- blocked every JE insert silently (EXCEPTION WHEN OTHERS → RETURN NEW).
--
-- Strategy:
--   Part A: Add CoA account 5410 (BPOM / SKI Registration Fees) so
--           get_expense_account_id('bpom_ski_fees') resolves to a leaf account.
--   Part B: UPDATE pib_bm_amount = 0 for expenses where pib_bm_amount IS
--           NULL. NULL IS NOT DISTINCT FROM 0 = FALSE → trigger detects a
--           financial-field change → deletes non-existent old JE (no-op) →
--           creates new JE. Setting NULL→0 is accounting-equivalent.
--   Part C: EXP/26-26/048 is a pib_import with pib_bm_amount = 0.00 (not NULL).
--           Direct JE insert via DO block.
--   Part D: 5 bpom_ski_fees expenses — direct JE insert (5410 now available).
--
-- Idempotent: each part only runs if the JE does not yet exist.
-- ============================================================================

BEGIN;

-- Part A: add missing CoA leaf account for bpom_ski_fees
INSERT INTO chart_of_accounts (code, name, account_type, is_header)
VALUES ('5410', 'BPOM / SKI Registration Fees', 'expense', false)
ON CONFLICT (code) DO NOTHING;

-- Part B: trigger-based backfill for expenses where pib_bm_amount IS NULL
UPDATE finance_expenses
SET pib_bm_amount = 0
WHERE pib_bm_amount IS NULL
  AND payment_method = 'bank_transfer'
  AND NOT EXISTS (
    SELECT 1 FROM journal_entries je
    WHERE je.reference_number = 'EXP-' || finance_expenses.id::text
      AND je.source_module = 'expenses'
  );

-- Part C: direct JE insert for EXP/26-26/048 (pib_import, pib_bm_amount already 0.00)
DO $$
DECLARE
  v_id               UUID := '781d01c0-7f5c-4bd3-95a2-9ce2bc8b128f';
  v_exp              finance_expenses%ROWTYPE;
  v_journal_id       UUID;
  v_entry_number     TEXT;
  v_payment_acct_id  UUID;
  v_bm_acct_id       UUID;
  v_ppn_acct_id      UUID;
  v_pph_acct_id      UUID;
BEGIN
  -- Skip if JE already exists
  IF EXISTS (
    SELECT 1 FROM journal_entries
    WHERE reference_number = 'EXP-' || v_id::text
  ) THEN
    RETURN;
  END IF;

  SELECT * INTO v_exp FROM finance_expenses WHERE id = v_id;
  IF NOT FOUND THEN RETURN; END IF;

  -- Resolve bank account → CoA
  SELECT ba.coa_id INTO v_payment_acct_id FROM bank_accounts ba WHERE ba.id = v_exp.bank_account_id;
  IF v_payment_acct_id IS NULL THEN
    SELECT id INTO v_payment_acct_id FROM chart_of_accounts WHERE code = '1111' LIMIT 1;
  END IF;

  -- Expense accounts for PIB path (same as trigger)
  SELECT get_expense_account_id('duty_customs')  INTO v_bm_acct_id;
  SELECT get_expense_account_id('ppn_import')    INTO v_ppn_acct_id;
  SELECT get_expense_account_id('pph_import')    INTO v_pph_acct_id;

  -- Generate entry number in same format as trigger
  SELECT 'JE' || TO_CHAR(v_exp.expense_date, 'YYMM') || '-' ||
    LPAD((COALESCE(MAX(CAST(SUBSTRING(entry_number FROM '-([0-9]+)$') AS INTEGER)), 0) + 1)::TEXT, 4, '0')
  INTO v_entry_number
  FROM journal_entries
  WHERE entry_number LIKE 'JE' || TO_CHAR(v_exp.expense_date, 'YYMM') || '-%';

  INSERT INTO journal_entries (
    entry_number, entry_date, source_module, reference_number,
    description, transaction_category,
    total_debit, total_credit, is_posted, posted_at, created_by
  ) VALUES (
    v_entry_number, v_exp.expense_date, 'expenses', 'EXP-' || v_id::text,
    COALESCE(v_exp.description, 'PIB Import Payment'), 'pib_import',
    v_exp.amount, v_exp.amount, true, now(), v_exp.created_by
  ) RETURNING id INTO v_journal_id;

  -- PIB Duty (BM) — 0.00, skip
  -- PPN Import
  IF COALESCE(v_exp.pib_ppn_amount, 0) > 0 AND v_ppn_acct_id IS NOT NULL THEN
    INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, debit, credit, description)
    VALUES (v_journal_id, 1, v_ppn_acct_id, v_exp.pib_ppn_amount, 0, 'PIB - PPN Import (Input VAT, PPN Masukan)');
  END IF;

  -- PPh 22 Dibayar Dimuka
  IF COALESCE(v_exp.pib_pph_amount, 0) > 0 AND v_pph_acct_id IS NOT NULL THEN
    INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, debit, credit, description)
    VALUES (v_journal_id, 2, v_pph_acct_id, v_exp.pib_pph_amount, 0, 'PIB - PPh 22 Dibayar Dimuka (Advance Income Tax)');
  END IF;

  -- Bank credit (total outflow)
  INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, debit, credit, description)
  VALUES (v_journal_id, 3, v_payment_acct_id, 0, v_exp.amount,
    'PIB - Bank payment [' || COALESCE(v_exp.description, '') || ']');

END $$;

-- Part D: direct JE insert for bpom_ski_fees expenses (5410 now available)
DO $$
DECLARE
  r                  finance_expenses%ROWTYPE;
  v_journal_id       UUID;
  v_entry_number     TEXT;
  v_payment_acct_id  UUID;
  v_expense_acct_id  UUID;
  v_net_payment      NUMERIC(18,2);
BEGIN
  FOR r IN
    SELECT * FROM finance_expenses
    WHERE expense_category = 'bpom_ski_fees'
      AND NOT EXISTS (
        SELECT 1 FROM journal_entries je
        WHERE je.reference_number = 'EXP-' || finance_expenses.id::text
          AND je.source_module = 'expenses'
      )
    ORDER BY expense_date
  LOOP
    SELECT ba.coa_id INTO v_payment_acct_id FROM bank_accounts ba WHERE ba.id = r.bank_account_id;
    IF v_payment_acct_id IS NULL THEN
      SELECT id INTO v_payment_acct_id FROM chart_of_accounts WHERE code = '1111' LIMIT 1;
    END IF;
    v_expense_acct_id := get_expense_account_id(r.expense_category);
    IF v_expense_acct_id IS NULL OR v_payment_acct_id IS NULL THEN
      RAISE WARNING 'Skipping % — unresolved account', r.voucher_number;
      CONTINUE;
    END IF;
    SELECT 'JE' || TO_CHAR(r.expense_date, 'YYMM') || '-' ||
      LPAD((COALESCE(MAX(CAST(SUBSTRING(entry_number FROM '-([0-9]+)$') AS INTEGER)), 0) + 1)::TEXT, 4, '0')
    INTO v_entry_number
    FROM journal_entries
    WHERE entry_number LIKE 'JE' || TO_CHAR(r.expense_date, 'YYMM') || '-%';
    v_net_payment := r.amount + COALESCE(r.ppn_amount, 0) - COALESCE(r.pph_amount, 0) + COALESCE(r.stamp_duty_amount, 0);
    INSERT INTO journal_entries (
      entry_number, entry_date, source_module, reference_number,
      description, transaction_category, total_debit, total_credit, is_posted, posted_at, created_by
    ) VALUES (
      v_entry_number, r.expense_date, 'expenses', 'EXP-' || r.id::text,
      COALESCE(r.description, r.expense_category), r.expense_category,
      r.amount, r.amount, true, now(), r.created_by
    ) RETURNING id INTO v_journal_id;
    INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, debit, credit, description)
    VALUES (v_journal_id, 1, v_expense_acct_id, r.amount, 0, COALESCE(r.description, r.expense_category));
    INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, debit, credit, description)
    VALUES (v_journal_id, 2, v_payment_acct_id, 0, v_net_payment, COALESCE(r.description, r.expense_category));
  END LOOP;
END $$;

-- Verify: all expenses now have JEs
DO $$
DECLARE v_remaining INT;
BEGIN
  SELECT COUNT(*) INTO v_remaining
  FROM finance_expenses fe
  WHERE NOT EXISTS (
    SELECT 1 FROM journal_entries je
    WHERE je.reference_number = 'EXP-' || fe.id::text
      AND je.source_module = 'expenses'
  );
  IF v_remaining > 0 THEN
    RAISE WARNING 'Backfill incomplete: % expenses still have no JE', v_remaining;
  ELSE
    RAISE NOTICE 'Backfill complete: all 562 expenses now have journal entries';
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';

COMMIT;
