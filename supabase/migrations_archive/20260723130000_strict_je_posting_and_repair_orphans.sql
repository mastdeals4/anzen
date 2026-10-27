/*
  Fix: silent failures in the two auto-posting triggers on the finance side.

  Two source tables — finance_expenses and petty_cash_transactions — have
  AFTER-INSERT/UPDATE triggers that create the Journal Entry. Both functions
  wrap their entire body in an EXCEPTION WHEN OTHERS handler that RAISEs a
  WARNING and returns NEW. When any required chart-of-accounts entry was
  missing (or any other exception fired), the source row was still written,
  but the JE never appeared — with no user-visible error.

  Audit against avira on 2026-07-23 found:
    - 1 finance_expenses row (id e2695a1e-…, expense_category='fixed_asset',
      amount 4,684,685, approved, fixed_asset_account_id=NULL). Root cause:
      the current live trigger falls through to the standard-expense path,
      which calls get_expense_account_id('fixed_asset'). On avira that returns
      NULL, and the trigger silently returned NEW. This row requires an
      explicit posting (leaf) Fixed Asset GL account selected by the user.

    - 2 petty_cash_transactions rows (b29b0b9f-… and 09e7032c-…,
      expense_category='delivery_sales', amount 10,000 each, approved
      2026-06-22, 'SEND DOCS TO PT LAPI'). Root cause: the outer EXCEPTION
      handler swallowed some historical error at approval time. Chart of
      accounts codes 1102, 5102, and 6510 are all present now, so re-firing
      the trigger with today's config succeeds.

  Fix (this migration): three changes, minimum surface.

    1. Replace public.auto_post_expense_accounting():
         - Keep the exact posting logic from mig 20260722160000 (PIB branch,
           dedicated fixed_asset branch requiring fixed_asset_account_id
           + PPN Masukan,
           standard-expense branch, salary/staff always-regen policy,
           approval_status in change-detection).
         - Remove the outer EXCEPTION WHEN OTHERS handler — real errors
           now propagate to the user's save.
         - Every "required account missing" early-return becomes a
           RAISE EXCEPTION with a clear message identifying the missing
           CoA code and the affected expense category.
         - The idempotency guards (existing JE on INSERT; unchanged fields
           on UPDATE) remain silent — they are correct no-ops, not errors.

    2. Replace public.post_petty_cash_to_journal_fixed():
         - Keep the exact posting logic already in place.
         - Remove the outer EXCEPTION WHEN OTHERS handler.
         - Add explicit RAISE for the withdraw path when the bank_account
           lookup fails.
         - The existing internal RAISEs for 1102 / 5102 already surface,
           but they were being swallowed. Removing the outer handler makes
           them visible.

    3. Repair the 2 petty-cash rows AS PART OF the migration, using only the
       trigger's own posting logic — no manually-patched account IDs.
         - finance_expenses e2695a1e-… is not repaired automatically because
           fixed_asset_account_id is NULL. The migration prints a notice
           instructing the operator to select a valid posting (leaf) Fixed
           Asset GL account in Expense Manager.
         - petty_cash_transactions b29b0b9f-… and 09e7032c-…: un-approve
           then re-approve. The approval-transition trigger fires with
           the strict function installed in step 2 and creates one JE
           for each row. If any prerequisite is missing the migration
           aborts and rolls back everything — no half-repair.

  If the migration aborts on repair (missing account for one of the 3 rows),
  the schema changes in steps 1 and 2 also roll back — the DB stays at its
  prior state, and the failure message tells the operator exactly which row
  and which CoA code needs configuration before re-running.

  Not touched:
    - trigger_post_expense_on_approval, trigger_post_petty_cash_on_approval
    - Any RPC (post_payment_voucher, cancel_*, save_*_with_allocations, etc.)
    - Chart of accounts, journal_entries, journal_entry_lines,
      voucher_allocations, bank_statement_lines
    - Reports, ledgers, dashboards
*/

-- ────────────────────────────────────────────────────────────────────────────
-- 1. auto_post_expense_accounting: strict, no silent swallow
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.auto_post_expense_accounting()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
  DECLARE
    v_expense_account_id    UUID;
    v_payment_account_id    UUID;
    v_journal_id            UUID;
    v_description           TEXT;
    v_credit_desc           TEXT;
    v_entry_number          TEXT;
    v_category_label        TEXT;
    v_bm_account_id         UUID;
    v_ppn_account_id        UUID;
    v_pph_account_id        UUID;
    v_stamp_duty_account_id UUID;
    v_bank_charge_acc_id    UUID;
    v_line_num              INTEGER;
    v_net_payment           NUMERIC(18,2);
    v_bank_charges          NUMERIC(18,2);
    v_is_salary_family      BOOLEAN;
  BEGIN
    IF TG_OP = 'UPDATE' THEN
      v_is_salary_family := NEW.expense_category IN ('salary', 'staff_overtime', 'staff_welfare');

      IF NOT v_is_salary_family AND (
        OLD.amount                 = NEW.amount AND
        OLD.expense_category       = NEW.expense_category AND
        OLD.payment_method         IS NOT DISTINCT FROM NEW.payment_method AND
        OLD.bank_account_id        IS NOT DISTINCT FROM NEW.bank_account_id AND
        OLD.pib_bm_amount          IS NOT DISTINCT FROM NEW.pib_bm_amount AND
        OLD.pib_ppn_amount         IS NOT DISTINCT FROM NEW.pib_ppn_amount AND
        OLD.pib_pph_amount         IS NOT DISTINCT FROM NEW.pib_pph_amount AND
        OLD.ppn_amount             IS NOT DISTINCT FROM NEW.ppn_amount AND
        OLD.pph_amount             IS NOT DISTINCT FROM NEW.pph_amount AND
        OLD.stamp_duty_amount      IS NOT DISTINCT FROM NEW.stamp_duty_amount AND
        OLD.fixed_asset_account_id IS NOT DISTINCT FROM NEW.fixed_asset_account_id AND
        COALESCE(OLD.bank_charges_amount, 0) = COALESCE(NEW.bank_charges_amount, 0) AND
        OLD.approval_status        IS NOT DISTINCT FROM NEW.approval_status
      ) THEN
        RETURN NEW;
      END IF;

      DELETE FROM journal_entry_lines
      WHERE journal_entry_id IN (
        SELECT id FROM journal_entries
        WHERE reference_number = 'EXP-' || NEW.id::text
      );
      DELETE FROM journal_entries
      WHERE reference_number = 'EXP-' || NEW.id::text;
    END IF;

    IF TG_OP = 'INSERT' THEN
      IF EXISTS (
        SELECT 1 FROM journal_entries
        WHERE reference_number = 'EXP-' || NEW.id::text
      ) THEN
        RETURN NEW;
      END IF;
    END IF;

    -- Resolve payment/credit account
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

    IF v_payment_account_id IS NULL THEN
      RAISE EXCEPTION 'Cannot post expense %: payment account missing. Configure chart_of_accounts for payment_method=% (expected code 1101 cash, 1102 petty_cash, 1111 bank, 2110 A/P).',
        NEW.id, NEW.payment_method;
    END IF;

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

    -- PIB Import path
    IF NEW.expense_category = 'pib_import' THEN

      v_bm_account_id  := get_expense_account_id('duty_customs');
      v_ppn_account_id := get_expense_account_id('ppn_import');
      v_pph_account_id := get_expense_account_id('pph_import');

      IF COALESCE(NEW.pib_bm_amount, 0)  > 0 AND v_bm_account_id  IS NULL THEN
        RAISE EXCEPTION 'Cannot post PIB expense %: Import Duty (duty_customs) account missing from chart of accounts', NEW.id;
      END IF;
      IF COALESCE(NEW.pib_ppn_amount, 0) > 0 AND v_ppn_account_id IS NULL THEN
        RAISE EXCEPTION 'Cannot post PIB expense %: PPN Import (ppn_import) account missing from chart of accounts', NEW.id;
      END IF;
      IF COALESCE(NEW.pib_pph_amount, 0) > 0 AND v_pph_account_id IS NULL THEN
        RAISE EXCEPTION 'Cannot post PIB expense %: PPh Import (pph_import) account missing from chart of accounts', NEW.id;
      END IF;

      INSERT INTO journal_entries (
        entry_number, entry_date, source_module, reference_id, reference_number,
        description, transaction_category,
        total_debit, total_credit, is_posted, posted_at, created_by
      ) VALUES (
        v_entry_number, NEW.expense_date, 'expenses', NEW.id, 'EXP-' || NEW.id::text,
        COALESCE(NEW.description, 'PIB Import Payment'), 'pib_import',
        NEW.amount, NEW.amount, true, now(), NEW.created_by
      ) RETURNING id INTO v_journal_id;

      v_line_num := 1;

      IF COALESCE(NEW.pib_bm_amount, 0) > 0 THEN
        INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, debit, credit, description)
        VALUES (v_journal_id, v_line_num, v_bm_account_id, NEW.pib_bm_amount, 0, 'PIB - Import Duty (BM) [landed cost]');
        v_line_num := v_line_num + 1;
      END IF;

      IF COALESCE(NEW.pib_ppn_amount, 0) > 0 THEN
        INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, debit, credit, description)
        VALUES (v_journal_id, v_line_num, v_ppn_account_id, NEW.pib_ppn_amount, 0, 'PIB - PPN Import (Input VAT, PPN Masukan)');
        v_line_num := v_line_num + 1;
      END IF;

      IF COALESCE(NEW.pib_pph_amount, 0) > 0 THEN
        INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, debit, credit, description)
        VALUES (v_journal_id, v_line_num, v_pph_account_id, NEW.pib_pph_amount, 0, 'PIB - PPh 22 Dibayar Dimuka (Advance Income Tax)');
        v_line_num := v_line_num + 1;
      END IF;

      INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, debit, credit, description)
      VALUES (v_journal_id, v_line_num, v_payment_account_id, 0, NEW.amount, 'PIB - Bank payment [' || COALESCE(NEW.description, '') || ']');

      RETURN NEW;
    END IF;

    -- Fixed Asset category (DR asset + DR PPN Masukan when > 0 + CR bank)
    IF NEW.expense_category = 'fixed_asset' THEN
      v_expense_account_id := NEW.fixed_asset_account_id;
      IF v_expense_account_id IS NULL THEN
        RAISE EXCEPTION 'Cannot post fixed asset expense %: fixed_asset_account_id is required. Select a valid posting (leaf) Fixed Asset GL account in Expense Manager; header accounts and automatic fallbacks are not allowed.', NEW.id;
      END IF;

      v_description := COALESCE(NEW.description, 'Fixed Asset Purchase');

      SELECT id INTO v_ppn_account_id FROM chart_of_accounts WHERE code = '1150' LIMIT 1;
      IF COALESCE(NEW.ppn_amount, 0) > 0 AND v_ppn_account_id IS NULL THEN
        RAISE EXCEPTION 'Cannot post fixed asset expense %: PPN Masukan account (1150) missing from chart of accounts', NEW.id;
      END IF;

      v_net_payment := NEW.amount + COALESCE(NEW.ppn_amount, 0);

      INSERT INTO journal_entries (
        entry_number, entry_date, source_module, reference_id, reference_number,
        description, transaction_category,
        total_debit, total_credit, is_posted, posted_at, created_by
      ) VALUES (
        v_entry_number, NEW.expense_date, 'expenses', NEW.id, 'EXP-' || NEW.id::text,
        v_description, 'fixed_asset',
        v_net_payment, v_net_payment, true, now(), NEW.created_by
      ) RETURNING id INTO v_journal_id;

      v_line_num := 1;

      INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, debit, credit, description)
      VALUES (v_journal_id, v_line_num, v_expense_account_id, NEW.amount, 0, v_description);
      v_line_num := v_line_num + 1;

      IF COALESCE(NEW.ppn_amount, 0) > 0 THEN
        INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, debit, credit, description)
        VALUES (v_journal_id, v_line_num, v_ppn_account_id, NEW.ppn_amount, 0, 'PPN Masukan - ' || v_description);
        v_line_num := v_line_num + 1;
      END IF;

      INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, debit, credit, description)
      VALUES (v_journal_id, v_line_num, v_payment_account_id, 0, v_net_payment, v_description);

      RETURN NEW;
    END IF;

    -- Standard expense path (non-PIB, non-fixed-asset)
    v_expense_account_id := get_expense_account_id(NEW.expense_category);
    IF v_expense_account_id IS NULL THEN
      RAISE EXCEPTION 'Cannot post expense %: no chart_of_accounts entry mapped for expense_category=% (see get_expense_account_id).',
        NEW.id, NEW.expense_category;
    END IF;

    v_category_label := REPLACE(INITCAP(REPLACE(NEW.expense_category, '_', ' ')), ' ', ' ');
    v_description    := COALESCE(NEW.description, NEW.expense_category);
    v_credit_desc    := COALESCE(SUBSTRING(NEW.description FROM '^[^\n]+'), NEW.expense_category) || ' [' || v_category_label || ']';

    SELECT id INTO v_ppn_account_id        FROM chart_of_accounts WHERE code = '1150' LIMIT 1;
    SELECT id INTO v_pph_account_id        FROM chart_of_accounts WHERE code = '2132' LIMIT 1;
    SELECT id INTO v_stamp_duty_account_id FROM chart_of_accounts WHERE code = '6950' LIMIT 1;

    IF COALESCE(NEW.ppn_amount, 0)        > 0 AND v_ppn_account_id        IS NULL THEN
      RAISE EXCEPTION 'Cannot post expense %: PPN Masukan account (1150) missing from chart of accounts', NEW.id;
    END IF;
    IF COALESCE(NEW.pph_amount, 0)        > 0 AND v_pph_account_id        IS NULL THEN
      RAISE EXCEPTION 'Cannot post expense %: PPh Payable account (2132) missing from chart of accounts', NEW.id;
    END IF;
    IF COALESCE(NEW.stamp_duty_amount, 0) > 0 AND v_stamp_duty_account_id IS NULL THEN
      RAISE EXCEPTION 'Cannot post expense %: Stamp Duty account (6950) missing from chart of accounts', NEW.id;
    END IF;

    v_bank_charges := CASE
      WHEN NEW.expense_category = 'utilities' THEN COALESCE(NEW.bank_charges_amount, 0)
      ELSE 0
    END;
    IF v_bank_charges > 0 THEN
      v_bank_charge_acc_id := get_expense_account_id('bank_charges');
      IF v_bank_charge_acc_id IS NULL THEN
        RAISE EXCEPTION 'Cannot post utility expense %: Bank Charges account missing (see get_expense_account_id(''bank_charges''))', NEW.id;
      END IF;
    END IF;

    v_net_payment := NEW.amount
      + COALESCE(NEW.ppn_amount, 0)
      - COALESCE(NEW.pph_amount, 0)
      + COALESCE(NEW.stamp_duty_amount, 0)
      + v_bank_charges;

    INSERT INTO journal_entries (
      entry_number, entry_date, source_module, reference_id, reference_number,
      description, transaction_category,
      total_debit, total_credit, is_posted, posted_at, created_by
    ) VALUES (
      v_entry_number, NEW.expense_date, 'expenses', NEW.id, 'EXP-' || NEW.id::text,
      v_description, NEW.expense_category,
      NEW.amount + COALESCE(NEW.ppn_amount, 0) + COALESCE(NEW.stamp_duty_amount, 0) + v_bank_charges,
      NEW.amount + COALESCE(NEW.ppn_amount, 0) + COALESCE(NEW.stamp_duty_amount, 0) + v_bank_charges,
      true, now(), NEW.created_by
    ) RETURNING id INTO v_journal_id;

    v_line_num := 1;

    INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, debit, credit, description)
    VALUES (v_journal_id, v_line_num, v_expense_account_id, NEW.amount, 0, v_credit_desc);
    v_line_num := v_line_num + 1;

    IF COALESCE(NEW.ppn_amount, 0) > 0 THEN
      INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, debit, credit, description)
      VALUES (v_journal_id, v_line_num, v_ppn_account_id, NEW.ppn_amount, 0, 'PPN Masukan - ' || v_description);
      v_line_num := v_line_num + 1;
    END IF;

    IF COALESCE(NEW.stamp_duty_amount, 0) > 0 THEN
      INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, debit, credit, description)
      VALUES (v_journal_id, v_line_num, v_stamp_duty_account_id, NEW.stamp_duty_amount, 0, 'Bea Meterai - ' || v_description);
      v_line_num := v_line_num + 1;
    END IF;

    IF v_bank_charges > 0 THEN
      INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, debit, credit, description)
      VALUES (v_journal_id, v_line_num, v_bank_charge_acc_id, v_bank_charges, 0, 'Bank charges [' || v_category_label || ']');
      v_line_num := v_line_num + 1;
    END IF;

    IF COALESCE(NEW.pph_amount, 0) > 0 THEN
      INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, debit, credit, description)
      VALUES (v_journal_id, v_line_num, v_pph_account_id, 0, NEW.pph_amount, 'PPh Ditahan - ' || v_description);
      v_line_num := v_line_num + 1;
    END IF;

    INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, debit, credit, description)
    VALUES (v_journal_id, v_line_num, v_payment_account_id, 0, v_net_payment, v_credit_desc);

    RETURN NEW;

    -- NO OUTER EXCEPTION WHEN OTHERS HANDLER. Any failure propagates to the
    -- caller so the user sees a clear error at save/approve time instead of
    -- an orphaned row with no JE.
  END;
$$;

DROP TRIGGER IF EXISTS trigger_auto_post_expense_accounting ON public.finance_expenses;
CREATE TRIGGER trigger_auto_post_expense_accounting
  AFTER INSERT OR UPDATE ON public.finance_expenses
  FOR EACH ROW
  EXECUTE FUNCTION public.auto_post_expense_accounting();


-- ────────────────────────────────────────────────────────────────────────────
-- 2. post_petty_cash_to_journal_fixed: strict, no silent swallow
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.post_petty_cash_to_journal_fixed()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_journal_id         UUID;
  v_petty_cash_account UUID;
  v_bank_coa           UUID;
  v_expense_account    UUID;
  v_line_num           INT  := 0;
  v_je_number          TEXT;
BEGIN
  IF NEW.fund_transfer_id IS NOT NULL THEN RETURN NEW; END IF;

  SELECT id INTO v_petty_cash_account FROM chart_of_accounts WHERE code = '1102' LIMIT 1;
  IF v_petty_cash_account IS NULL THEN
    RAISE EXCEPTION 'Cannot post petty cash %: Petty Cash account (1102) missing from chart of accounts', NEW.id;
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtext('pc_je_number_' || TO_CHAR(NEW.transaction_date, 'YYYYMMDD'))
  );

  SELECT 'JE-' || TO_CHAR(NEW.transaction_date, 'YYYYMMDD') || '-' ||
         LPAD((COUNT(*) + 1)::TEXT, 4, '0')
    INTO v_je_number
    FROM journal_entries WHERE entry_date = NEW.transaction_date;

  INSERT INTO journal_entries (
    entry_number, entry_date, source_module, reference_id, reference_number,
    description, total_debit, total_credit, is_posted, created_by, posted_at
  ) VALUES (
    v_je_number, NEW.transaction_date, 'petty_cash', NEW.id, NEW.transaction_number,
    'Petty cash ' || NEW.transaction_type || ': ' || NEW.description,
    NEW.amount, NEW.amount, TRUE, NEW.created_by, NOW()
  ) RETURNING id INTO v_journal_id;

  IF NEW.transaction_type = 'withdraw' THEN
    v_line_num := v_line_num + 1;
    INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, debit, credit, description)
    VALUES (v_journal_id, v_line_num, v_petty_cash_account, NEW.amount, 0, 'Cash withdrawal');

    IF NEW.bank_account_id IS NOT NULL THEN
      SELECT coa_id INTO v_bank_coa FROM bank_accounts WHERE id = NEW.bank_account_id;
      IF v_bank_coa IS NULL THEN
        RAISE EXCEPTION 'Cannot post petty cash withdrawal %: bank_account % has no linked chart-of-accounts (coa_id)', NEW.id, NEW.bank_account_id;
      END IF;
      v_line_num := v_line_num + 1;
      INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, debit, credit, description)
      VALUES (v_journal_id, v_line_num, v_bank_coa, 0, NEW.amount, 'Bank withdrawal for petty cash');
    END IF;

  ELSIF NEW.transaction_type = 'expense' THEN
    SELECT id INTO v_expense_account FROM chart_of_accounts
     WHERE account_type = 'expense' AND (
       CASE
         WHEN NEW.expense_category = 'Utilities'                    THEN code = '6300'
         WHEN NEW.expense_category = 'Office Supplies'              THEN code = '6310'
         WHEN NEW.expense_category = 'Transportation'               THEN code = '6320'
         WHEN NEW.expense_category = 'Meals & Entertainment'        THEN code = '6330'
         WHEN NEW.expense_category = 'Postage & Courier'            THEN code = '6340'
         WHEN NEW.expense_category = 'Cleaning & Maintenance'       THEN code = '6350'
         WHEN NEW.expense_category = 'Staff Salaries & Wages'       THEN code = '6360'
         WHEN NEW.expense_category = 'Staff Benefits & Allowances'  THEN code = '6370'
         WHEN NEW.expense_category = 'Printing & Stationery'        THEN code = '6380'
         WHEN NEW.expense_category = 'Telephone & Internet'         THEN code = '6390'
         WHEN NEW.expense_category = 'Bank Charges'                 THEN code = '6400'
         WHEN NEW.expense_category = 'Professional Fees'            THEN code = '6410'
         WHEN NEW.expense_category = 'Office Renovation & Shifting' THEN code = '6420'
         WHEN NEW.expense_category = 'Other Expenses'               THEN code = '6490'
         ELSE code = '5102'
       END
     ) LIMIT 1;

    IF v_expense_account IS NULL THEN
      SELECT id INTO v_expense_account FROM chart_of_accounts WHERE code = '5102' LIMIT 1;
    END IF;

    IF v_expense_account IS NULL THEN
      RAISE EXCEPTION 'Cannot post petty cash expense %: no expense account matched category=% and fallback code 5102 (General Expenses) is missing from chart of accounts', NEW.id, NEW.expense_category;
    END IF;

    v_line_num := v_line_num + 1;
    INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, debit, credit, description)
    VALUES (v_journal_id, v_line_num, v_expense_account, NEW.amount, 0,
            COALESCE(NEW.expense_category, 'General expense'));

    v_line_num := v_line_num + 1;
    INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, debit, credit, description)
    VALUES (v_journal_id, v_line_num, v_petty_cash_account, 0, NEW.amount, 'Cash expense');
  END IF;

  RETURN NEW;

  -- NO OUTER EXCEPTION WHEN OTHERS HANDLER. Real errors now surface to the
  -- caller instead of being swallowed with a WARNING and leaving the source
  -- row without a Journal Entry.
END;
$$;


-- ────────────────────────────────────────────────────────────────────────────
-- 3. Repair the 2 petty-cash rows using only the trigger's own posting logic
--    (no manually-patched account IDs). The fixed-asset expense is explicitly
--    skipped until the user selects a valid posting (leaf) GL account.
-- ────────────────────────────────────────────────────────────────────────────

-- 3a. Fixed asset expense: do not guess or auto-select an account.
--     Print a clear operator message and continue to the petty-cash repairs.
DO $repair_expense$
DECLARE
  v_id                     uuid := 'e2695a1e-dff2-4246-81da-95a1760af228'::uuid;
  v_fixed_asset_account_id uuid;
BEGIN
  IF EXISTS (
    SELECT 1 FROM journal_entries
    WHERE source_module = 'expenses'
      AND reference_number = 'EXP-' || v_id::text
  ) THEN
    RAISE NOTICE 'EXP/26-26/085 already has a Journal Entry; no repair action was taken.';
    RETURN;
  END IF;

  SELECT fixed_asset_account_id
    INTO v_fixed_asset_account_id
    FROM public.finance_expenses
   WHERE id = v_id;

  IF NOT FOUND THEN
    RAISE NOTICE 'EXP/26-26/085 was not found; no repair action was taken.';
    RETURN;
  END IF;

  IF v_fixed_asset_account_id IS NULL THEN
    RAISE NOTICE 'EXP/26-26/085 was skipped: fixed_asset_account_id is NULL. Select a valid posting (leaf) Fixed Asset GL account in Expense Manager and save the expense to regenerate the Journal Entry through the existing AFTER UPDATE trigger.';
  ELSE
    RAISE NOTICE 'EXP/26-26/085 was not repaired automatically. Its Fixed Asset GL account is now set; save the expense in Expense Manager to regenerate the Journal Entry through the existing AFTER UPDATE trigger.';
  END IF;
END
$repair_expense$;

-- 3b. Two petty-cash rows: cycle approval_status through pending_approval and
--     back to approved so trigger_post_petty_cash_on_approval fires with the
--     strict function above. Two-step cycle also refreshes audit_logs.
DO $repair_pc$
DECLARE
  v_ids uuid[] := ARRAY[
    'b29b0b9f-e54c-4e66-bfcc-eb2f8462fbe0'::uuid,
    '09e7032c-cbe8-478b-8cf3-43bcbe1b6cef'::uuid
  ];
  v_id uuid;
  v_approver uuid;
BEGIN
  FOREACH v_id IN ARRAY v_ids LOOP
    -- Skip if already repaired (JE exists) — makes this idempotent.
    IF EXISTS (
      SELECT 1 FROM journal_entries
      WHERE source_module = 'petty_cash' AND reference_id = v_id
    ) THEN
      CONTINUE;
    END IF;

    -- Snapshot the current approver so we can restore it verbatim.
    SELECT approved_by INTO v_approver FROM petty_cash_transactions WHERE id = v_id;

    UPDATE public.petty_cash_transactions
       SET approval_status = 'pending_approval',
           approved_by     = NULL,
           approved_at     = NULL
     WHERE id = v_id;

    UPDATE public.petty_cash_transactions
       SET approval_status = 'approved',
           approved_by     = v_approver,
           approved_at     = now()
     WHERE id = v_id;
  END LOOP;
END
$repair_pc$;
