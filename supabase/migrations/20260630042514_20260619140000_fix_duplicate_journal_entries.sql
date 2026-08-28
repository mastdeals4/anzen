DO $$
DECLARE
  v_deleted_lines   INTEGER;
  v_deleted_entries INTEGER;
BEGIN
  DELETE FROM public.journal_entry_lines
  WHERE journal_entry_id IN (
    SELECT id FROM (
      SELECT
        id,
        ROW_NUMBER() OVER (
          PARTITION BY source_module, reference_number
          ORDER BY created_at DESC NULLS LAST, id DESC
        ) AS rn
      FROM public.journal_entries
      WHERE reference_number IS NOT NULL
        AND source_module    IS NOT NULL
    ) ranked
    WHERE rn > 1
  );
  GET DIAGNOSTICS v_deleted_lines = ROW_COUNT;

  DELETE FROM public.journal_entries
  WHERE id IN (
    SELECT id FROM (
      SELECT
        id,
        ROW_NUMBER() OVER (
          PARTITION BY source_module, reference_number
          ORDER BY created_at DESC NULLS LAST, id DESC
        ) AS rn
      FROM public.journal_entries
      WHERE reference_number IS NOT NULL
        AND source_module    IS NOT NULL
    ) ranked
    WHERE rn > 1
  );
  GET DIAGNOSTICS v_deleted_entries = ROW_COUNT;

  RAISE NOTICE 'Duplicate JE cleanup: deleted % lines across % entries', v_deleted_lines, v_deleted_entries;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_journal_entries_source_ref_number
  ON public.journal_entries (source_module, reference_number)
  WHERE reference_number IS NOT NULL
    AND source_module    IS NOT NULL;

CREATE OR REPLACE FUNCTION public.auto_post_expense_accounting()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_expense_account_id UUID;
  v_payment_account_id UUID;
  v_journal_id         UUID;
  v_description        TEXT;
  v_credit_desc        TEXT;
  v_entry_number       TEXT;
  v_category_label     TEXT;
  v_bm_account_id      UUID;
  v_ppn_account_id     UUID;
  v_pph_account_id     UUID;
  v_line_num           INTEGER;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (
      OLD.amount             = NEW.amount AND
      OLD.expense_category   = NEW.expense_category AND
      OLD.payment_method     IS NOT DISTINCT FROM NEW.payment_method AND
      OLD.bank_account_id    IS NOT DISTINCT FROM NEW.bank_account_id AND
      OLD.pib_bm_amount      IS NOT DISTINCT FROM NEW.pib_bm_amount AND
      OLD.pib_ppn_amount     IS NOT DISTINCT FROM NEW.pib_ppn_amount AND
      OLD.pib_pph_amount     IS NOT DISTINCT FROM NEW.pib_pph_amount
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

  v_expense_account_id := get_expense_account_id(NEW.expense_category);
  IF v_expense_account_id IS NULL THEN RETURN NEW; END IF;

  v_category_label := REPLACE(INITCAP(REPLACE(NEW.expense_category, '_', ' ')), ' ', ' ');
  v_description    := COALESCE(NEW.description, NEW.expense_category);
  v_credit_desc    := COALESCE(SUBSTRING(NEW.description FROM '^[^\n]+'), NEW.expense_category) || ' [' || v_category_label || ']';

  INSERT INTO journal_entries (
    entry_number, entry_date, source_module, reference_number,
    description, transaction_category,
    total_debit, total_credit, is_posted, posted_at, created_by
  ) VALUES (
    v_entry_number, NEW.expense_date, 'expenses', 'EXP-' || NEW.id::text,
    v_description, NEW.expense_category,
    NEW.amount, NEW.amount, true, now(), NEW.created_by
  ) RETURNING id INTO v_journal_id;

  INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, debit, credit, description)
  VALUES (v_journal_id, 1, v_expense_account_id, NEW.amount, 0, v_credit_desc);

  INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, debit, credit, description)
  VALUES (v_journal_id, 2, v_payment_account_id, 0, NEW.amount, v_credit_desc);

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
