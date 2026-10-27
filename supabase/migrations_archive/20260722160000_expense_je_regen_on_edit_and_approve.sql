/*
  Fix: Journal Entries did not always regenerate when an expense was edited,
  approved, reposted, or otherwise updated.

  Root cause: auto_post_expense_accounting()'s UPDATE branch early-returned
  whenever all *financial* fields matched. Two consequences:

    1. Approving an expense changes only approval_status/approved_by/approved_at.
       Those fields were not in the change-detection list, so the JE was never
       refreshed against the latest accounting rules on approval / repost.

    2. Editing a Salary expense that kept the same amount/category/tax fields
       (e.g. correcting a description or reassigning a staff member) also
       skipped regeneration. Policy requires that any Salary edit regenerates
       the JE using the latest rules.

  Fix (surgical, one function replaced):
    - Add approval_status to the change-detection block. Any status transition
      (pending_approval → approved, approved → rejected, etc.) now triggers a
      DELETE + reinsert of the JE lines against current accounting rules.
    - For the salary family (expense_category IN 'salary', 'staff_overtime',
      'staff_welfare'), skip the early-return entirely and ALWAYS regenerate
      on UPDATE. This matches the finance policy: historical entries stay
      untouched (the trigger only fires when the row is updated), but any
      touch refreshes the JE against the latest rules.

  Nothing else in the trigger changes. All account-resolution and posting
  branches (PIB import, fixed_asset with PPN Masukan, standard, utilities
  with bank_charges) are copied verbatim from 20260722140000.

  Historical data: this migration does NOT rewrite existing JEs. Regeneration
  happens the next time a row is edited or its approval_status changes.
*/

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

    IF v_payment_account_id IS NULL THEN RETURN NEW; END IF;

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

      INSERT INTO journal_entries (
        entry_number, entry_date, source_module, reference_number,
        description, transaction_category,
        total_debit, total_credit, is_posted, posted_at, created_by
      ) VALUES (
        v_entry_number, NEW.expense_date, 'expenses', 'EXP-' || NEW.id::text,
        COALESCE(NEW.description, 'PIB Import Payment'), 'pib_import',
        NEW.amount, NEW.amount, true, now(), NEW.created_by
      ) RETURNING id INTO v_journal_id;

      v_line_num := 1;

      IF COALESCE(NEW.pib_bm_amount, 0) > 0 AND v_bm_account_id IS NOT NULL THEN
        INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, debit, credit, description)
        VALUES (v_journal_id, v_line_num, v_bm_account_id, NEW.pib_bm_amount, 0, 'PIB - Import Duty (BM) [landed cost]');
        v_line_num := v_line_num + 1;
      END IF;

      IF COALESCE(NEW.pib_ppn_amount, 0) > 0 AND v_ppn_account_id IS NOT NULL THEN
        INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, debit, credit, description)
        VALUES (v_journal_id, v_line_num, v_ppn_account_id, NEW.pib_ppn_amount, 0, 'PIB - PPN Import (Input VAT, PPN Masukan)');
        v_line_num := v_line_num + 1;
      END IF;

      IF COALESCE(NEW.pib_pph_amount, 0) > 0 AND v_pph_account_id IS NOT NULL THEN
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
        SELECT id INTO v_expense_account_id FROM chart_of_accounts WHERE code = '1200' LIMIT 1;
      END IF;
      IF v_expense_account_id IS NULL THEN RETURN NEW; END IF;

      v_description := COALESCE(NEW.description, 'Fixed Asset Purchase');

      SELECT id INTO v_ppn_account_id FROM chart_of_accounts WHERE code = '1150' LIMIT 1;

      v_net_payment := NEW.amount + COALESCE(NEW.ppn_amount, 0);

      INSERT INTO journal_entries (
        entry_number, entry_date, source_module, reference_number,
        description, transaction_category,
        total_debit, total_credit, is_posted, posted_at, created_by
      ) VALUES (
        v_entry_number, NEW.expense_date, 'expenses', 'EXP-' || NEW.id::text,
        v_description, 'fixed_asset',
        v_net_payment, v_net_payment, true, now(), NEW.created_by
      ) RETURNING id INTO v_journal_id;

      v_line_num := 1;

      INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, debit, credit, description)
      VALUES (v_journal_id, v_line_num, v_expense_account_id, NEW.amount, 0, v_description);
      v_line_num := v_line_num + 1;

      IF COALESCE(NEW.ppn_amount, 0) > 0 AND v_ppn_account_id IS NOT NULL THEN
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
    IF v_expense_account_id IS NULL THEN RETURN NEW; END IF;

    v_category_label := REPLACE(INITCAP(REPLACE(NEW.expense_category, '_', ' ')), ' ', ' ');
    v_description    := COALESCE(NEW.description, NEW.expense_category);
    v_credit_desc    := COALESCE(SUBSTRING(NEW.description FROM '^[^\n]+'), NEW.expense_category) || ' [' || v_category_label || ']';

    SELECT id INTO v_ppn_account_id        FROM chart_of_accounts WHERE code = '1150' LIMIT 1;
    SELECT id INTO v_pph_account_id        FROM chart_of_accounts WHERE code = '2132' LIMIT 1;
    SELECT id INTO v_stamp_duty_account_id FROM chart_of_accounts WHERE code = '6950' LIMIT 1;

    v_bank_charges := CASE
      WHEN NEW.expense_category = 'utilities' THEN COALESCE(NEW.bank_charges_amount, 0)
      ELSE 0
    END;
    IF v_bank_charges > 0 THEN
      v_bank_charge_acc_id := get_expense_account_id('bank_charges');
      IF v_bank_charge_acc_id IS NULL THEN v_bank_charges := 0; END IF;
    END IF;

    v_net_payment := NEW.amount
      + COALESCE(NEW.ppn_amount, 0)
      - COALESCE(NEW.pph_amount, 0)
      + COALESCE(NEW.stamp_duty_amount, 0)
      + v_bank_charges;

    INSERT INTO journal_entries (
      entry_number, entry_date, source_module, reference_number,
      description, transaction_category,
      total_debit, total_credit, is_posted, posted_at, created_by
    ) VALUES (
      v_entry_number, NEW.expense_date, 'expenses', 'EXP-' || NEW.id::text,
      v_description, NEW.expense_category,
      NEW.amount + COALESCE(NEW.ppn_amount, 0) + COALESCE(NEW.stamp_duty_amount, 0) + v_bank_charges,
      NEW.amount + COALESCE(NEW.ppn_amount, 0) + COALESCE(NEW.stamp_duty_amount, 0) + v_bank_charges,
      true, now(), NEW.created_by
    ) RETURNING id INTO v_journal_id;

    v_line_num := 1;

    INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, debit, credit, description)
    VALUES (v_journal_id, v_line_num, v_expense_account_id, NEW.amount, 0, v_credit_desc);
    v_line_num := v_line_num + 1;

    IF COALESCE(NEW.ppn_amount, 0) > 0 AND v_ppn_account_id IS NOT NULL THEN
      INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, debit, credit, description)
      VALUES (v_journal_id, v_line_num, v_ppn_account_id, NEW.ppn_amount, 0, 'PPN Masukan - ' || v_description);
      v_line_num := v_line_num + 1;
    END IF;

    IF COALESCE(NEW.stamp_duty_amount, 0) > 0 AND v_stamp_duty_account_id IS NOT NULL THEN
      INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, debit, credit, description)
      VALUES (v_journal_id, v_line_num, v_stamp_duty_account_id, NEW.stamp_duty_amount, 0, 'Bea Meterai - ' || v_description);
      v_line_num := v_line_num + 1;
    END IF;

    IF v_bank_charges > 0 THEN
      INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, debit, credit, description)
      VALUES (v_journal_id, v_line_num, v_bank_charge_acc_id, v_bank_charges, 0, 'Bank charges [' || v_category_label || ']');
      v_line_num := v_line_num + 1;
    END IF;

    IF COALESCE(NEW.pph_amount, 0) > 0 AND v_pph_account_id IS NOT NULL THEN
      INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, debit, credit, description)
      VALUES (v_journal_id, v_line_num, v_pph_account_id, 0, NEW.pph_amount, 'PPh Ditahan - ' || v_description);
      v_line_num := v_line_num + 1;
    END IF;

    INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, debit, credit, description)
    VALUES (v_journal_id, v_line_num, v_payment_account_id, 0, v_net_payment, v_credit_desc);

    RETURN NEW;

  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'auto_post_expense_accounting failed for expense %: %', NEW.id, SQLERRM;
    RETURN NEW;
  END;
$$;

DROP TRIGGER IF EXISTS trigger_auto_post_expense_accounting ON public.finance_expenses;
CREATE TRIGGER trigger_auto_post_expense_accounting
  AFTER INSERT OR UPDATE ON public.finance_expenses
  FOR EACH ROW
  EXECUTE FUNCTION public.auto_post_expense_accounting();
