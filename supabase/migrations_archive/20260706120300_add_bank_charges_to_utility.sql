/*
  # Optional Bank Charges on Utility expenses

  Finance Stabilization Sprint (2026-07-06), Task 5.

  Adds finance_expenses.bank_charges_amount (default 0). Only utility
  expenses use it in the UI. When > 0, the auto_post_expense_accounting
  trigger emits a 3-line JE:
      Dr Utility Expense          (amount)
      Dr Bank Charges Expense     (bank_charges_amount)
      Cr Bank / Payment           (amount + bank_charges_amount)

  Utility base amount is unchanged. Bank reconciliation uses the total
  payment (amount + bank_charges_amount) via the payment_voucher flow.

  Backward compatibility:
    - Existing rows default to 0 → no behavioural change.
    - Non-utility categories: field forced to 0 by the frontend (and the
      trigger only branches when bank_charges_amount > 0, so a stray value
      still degrades to the standard 2-line JE where the category has no
      dedicated bank-charges account).
*/

-- 1. Column ---------------------------------------------------------------
ALTER TABLE public.finance_expenses
  ADD COLUMN IF NOT EXISTS bank_charges_amount NUMERIC(18,2) NOT NULL DEFAULT 0
    CHECK (bank_charges_amount >= 0);

COMMENT ON COLUMN public.finance_expenses.bank_charges_amount IS
'Optional bank charges paid alongside a utility bill. Only used for the '
'utilities expense_category. Journal: Dr Utility, Dr Bank Charges, Cr Bank '
'(=amount+bank_charges_amount). Utility expense amount itself is unchanged.';

-- 2. Extend auto_post_expense_accounting to add a Bank Charges leg -------
-- Keeps the entire existing PIB and standard 2-line logic identical; only
-- inserts an extra Dr line for bank charges and grosses up the Cr Bank leg
-- when the expense is a utility with bank_charges_amount > 0.

CREATE OR REPLACE FUNCTION public.auto_post_expense_accounting()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  -- shared
  v_expense_account_id UUID;
  v_payment_account_id UUID;
  v_bank_charge_acc_id UUID;
  v_journal_id         UUID;
  v_description        TEXT;
  v_credit_desc        TEXT;
  v_entry_number       TEXT;
  v_category_label     TEXT;
  v_bank_charges       NUMERIC(18,2);
  v_total_credit       NUMERIC(18,2);
  -- pib_import split
  v_bm_account_id      UUID;
  v_ppn_account_id     UUID;
  v_pph_account_id     UUID;
  v_line_num           INTEGER;
BEGIN
  -- ── UPDATE: reverse ALL old journal entries if anything accounting-relevant changed ──
  IF TG_OP = 'UPDATE' THEN
    IF (
      OLD.amount               = NEW.amount AND
      OLD.expense_category     = NEW.expense_category AND
      OLD.payment_method       IS NOT DISTINCT FROM NEW.payment_method AND
      OLD.bank_account_id      IS NOT DISTINCT FROM NEW.bank_account_id AND
      OLD.pib_bm_amount        IS NOT DISTINCT FROM NEW.pib_bm_amount AND
      OLD.pib_ppn_amount       IS NOT DISTINCT FROM NEW.pib_ppn_amount AND
      OLD.pib_pph_amount       IS NOT DISTINCT FROM NEW.pib_pph_amount AND
      COALESCE(OLD.bank_charges_amount, 0) = COALESCE(NEW.bank_charges_amount, 0)
    ) THEN
      RETURN NEW; -- nothing accounting-relevant changed
    END IF;

    DELETE FROM journal_entry_lines
    WHERE journal_entry_id IN (
      SELECT id FROM journal_entries
      WHERE reference_number = 'EXP-' || NEW.id::text
    );
    DELETE FROM journal_entries
    WHERE reference_number = 'EXP-' || NEW.id::text;
  END IF;

  -- ── INSERT idempotency guard ──
  IF TG_OP = 'INSERT' THEN
    IF EXISTS (
      SELECT 1 FROM journal_entries
      WHERE reference_number = 'EXP-' || NEW.id::text
    ) THEN
      RETURN NEW;
    END IF;
  END IF;

  -- ── Resolve bank / cash payment account ──
  IF NEW.payment_method = 'cash' THEN
    SELECT id INTO v_payment_account_id FROM chart_of_accounts WHERE code = '1101' LIMIT 1;
  ELSIF NEW.payment_method = 'petty_cash' THEN
    SELECT id INTO v_payment_account_id FROM chart_of_accounts WHERE code = '1102' LIMIT 1;
  ELSIF NEW.payment_method = 'bank_transfer' AND NEW.bank_account_id IS NOT NULL THEN
    SELECT coa_id INTO v_payment_account_id FROM bank_accounts WHERE id = NEW.bank_account_id;
    IF v_payment_account_id IS NULL THEN
      SELECT id INTO v_payment_account_id FROM chart_of_accounts WHERE code = '1111' LIMIT 1;
    END IF;
  ELSIF NEW.payment_method IS NULL THEN
    SELECT id INTO v_payment_account_id FROM chart_of_accounts WHERE code = '2110' LIMIT 1;
  ELSE
    SELECT id INTO v_payment_account_id FROM chart_of_accounts WHERE code = '1101' LIMIT 1;
  END IF;

  IF v_payment_account_id IS NULL THEN RETURN NEW; END IF;

  -- ── Generate journal entry number ──
  SELECT
    'JE' || TO_CHAR(NEW.expense_date, 'YYMM') || '-' ||
    LPAD(
      (COALESCE(
        MAX(CAST(SUBSTRING(entry_number FROM '-([0-9]+)$') AS INTEGER)), 0
      ) + 1)::TEXT,
      4, '0'
    )
  INTO v_entry_number
  FROM journal_entries
  WHERE entry_number LIKE 'JE' || TO_CHAR(NEW.expense_date, 'YYMM') || '-%';

  -- ════════════════════════════════════════════════════════════════════════
  -- SPECIAL PATH: PIB Import (unchanged)
  -- ════════════════════════════════════════════════════════════════════════
  IF NEW.expense_category = 'pib_import' THEN

    v_bm_account_id  := get_expense_account_id('duty_customs');
    v_ppn_account_id := get_expense_account_id('ppn_import');
    v_pph_account_id := get_expense_account_id('pph_import');

    INSERT INTO journal_entries (
      entry_number, entry_date, source_module, reference_number,
      description, transaction_category,
      total_debit, total_credit, is_posted, posted_at, created_by
    ) VALUES (
      v_entry_number, NEW.expense_date, 'expenses',
      'EXP-' || NEW.id::text,
      COALESCE(NEW.description, 'PIB Import Payment'), 'pib_import',
      NEW.amount, NEW.amount, true, now(), NEW.created_by
    ) RETURNING id INTO v_journal_id;

    v_line_num := 1;

    IF COALESCE(NEW.pib_bm_amount, 0) > 0 AND v_bm_account_id IS NOT NULL THEN
      INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, debit, credit, description)
      VALUES (v_journal_id, v_line_num, v_bm_account_id, NEW.pib_bm_amount, 0,
              'PIB - Import Duty (BM) [landed cost]');
      v_line_num := v_line_num + 1;
    END IF;

    IF COALESCE(NEW.pib_ppn_amount, 0) > 0 AND v_ppn_account_id IS NOT NULL THEN
      INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, debit, credit, description)
      VALUES (v_journal_id, v_line_num, v_ppn_account_id, NEW.pib_ppn_amount, 0,
              'PIB - PPN Import (Input VAT, PPN Masukan)');
      v_line_num := v_line_num + 1;
    END IF;

    IF COALESCE(NEW.pib_pph_amount, 0) > 0 AND v_pph_account_id IS NOT NULL THEN
      INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, debit, credit, description)
      VALUES (v_journal_id, v_line_num, v_pph_account_id, NEW.pib_pph_amount, 0,
              'PIB - PPh 22 Dibayar Dimuka (Advance Income Tax)');
      v_line_num := v_line_num + 1;
    END IF;

    INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, debit, credit, description)
    VALUES (v_journal_id, v_line_num, v_payment_account_id, 0, NEW.amount,
            'PIB - Bank payment [' || COALESCE(NEW.description, '') || ']');

    RETURN NEW;
  END IF;

  -- ════════════════════════════════════════════════════════════════════════
  -- STANDARD PATH: 2-line JE, or 3-line if Utility w/ bank_charges > 0
  -- ════════════════════════════════════════════════════════════════════════
  v_expense_account_id := get_expense_account_id(NEW.expense_category);
  IF v_expense_account_id IS NULL THEN RETURN NEW; END IF;

  v_category_label := REPLACE(INITCAP(REPLACE(NEW.expense_category, '_', ' ')), ' ', ' ');
  v_description    := COALESCE(NEW.description, NEW.expense_category);
  v_credit_desc    := COALESCE(
                        SUBSTRING(NEW.description FROM '^[^\n]+'),
                        NEW.expense_category
                      ) || ' [' || v_category_label || ']';

  -- Bank charges only apply to Utility category
  v_bank_charges := CASE
    WHEN NEW.expense_category = 'utilities' THEN COALESCE(NEW.bank_charges_amount, 0)
    ELSE 0
  END;

  IF v_bank_charges > 0 THEN
    v_bank_charge_acc_id := get_expense_account_id('bank_charges');
  END IF;

  -- If bank_charges > 0 but the bank_charges COA is missing, degrade
  -- gracefully to the standard 2-line JE.
  IF v_bank_charges > 0 AND v_bank_charge_acc_id IS NULL THEN
    v_bank_charges := 0;
  END IF;

  v_total_credit := NEW.amount + v_bank_charges;

  INSERT INTO journal_entries (
    entry_number, entry_date, source_module, reference_number,
    description, transaction_category,
    total_debit, total_credit, is_posted, posted_at, created_by
  ) VALUES (
    v_entry_number, NEW.expense_date, 'expenses', 'EXP-' || NEW.id::text,
    v_description, NEW.expense_category,
    v_total_credit, v_total_credit, true, now(), NEW.created_by
  ) RETURNING id INTO v_journal_id;

  -- Dr Expense account (unchanged base amount)
  INSERT INTO journal_entry_lines
    (journal_entry_id, line_number, account_id, debit, credit, description)
  VALUES (v_journal_id, 1, v_expense_account_id, NEW.amount, 0, v_credit_desc);

  v_line_num := 2;

  -- Dr Bank Charges (Utility only, when > 0)
  IF v_bank_charges > 0 THEN
    INSERT INTO journal_entry_lines
      (journal_entry_id, line_number, account_id, debit, credit, description)
    VALUES (v_journal_id, v_line_num, v_bank_charge_acc_id, v_bank_charges, 0,
            'Bank charges [' || v_category_label || ']');
    v_line_num := v_line_num + 1;
  END IF;

  -- Cr Payment / Bank (grossed up by bank charges)
  INSERT INTO journal_entry_lines
    (journal_entry_id, line_number, account_id, debit, credit, description)
  VALUES (v_journal_id, v_line_num, v_payment_account_id, 0, v_total_credit, v_credit_desc);

  RETURN NEW;

EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'auto_post_expense_accounting failed for expense %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

-- Re-attach trigger
DROP TRIGGER IF EXISTS trigger_auto_post_expense_accounting ON public.finance_expenses;
CREATE TRIGGER trigger_auto_post_expense_accounting
  AFTER INSERT OR UPDATE ON public.finance_expenses
  FOR EACH ROW
  EXECUTE FUNCTION public.auto_post_expense_accounting();

COMMENT ON FUNCTION public.auto_post_expense_accounting() IS
'Auto-posts JEs for finance_expenses.
UPDATE: bulk-deletes ALL existing JEs for the expense before recreating (clears legacy dupes).
pib_import: 4-line split (Dr BM/1130, Dr PPN Masukan/1150, Dr PPh22/1155, Cr Bank).
utilities w/ bank_charges_amount > 0: 3-line (Dr Utility, Dr Bank Charges, Cr Bank total).
All other categories: 2-line (Dr expense account, Cr payment account).';
