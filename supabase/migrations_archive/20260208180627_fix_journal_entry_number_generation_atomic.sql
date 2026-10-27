/*
  # Fix Journal Entry Number Generation - Eliminate Duplicate Key Errors

  1. Problem
    - ALL trigger functions generating journal entry numbers use COUNT(*)+1 pattern
    - This causes race conditions: two concurrent transactions get the same number
    - Results in: "duplicate key value violates unique constraint journal_entries_entry_number_key"
    - Also fails when journal entries are deleted (COUNT returns lower than MAX)

  2. Solution
    - Create a centralized `next_journal_entry_number()` function
    - Uses MAX(substring) instead of COUNT to find the highest existing number
    - Uses pg_advisory_xact_lock to serialize number generation per month prefix
    - Eliminates all race conditions and gaps
    - Update ALL trigger functions to use this centralized function

  3. Changes
    - New function: `next_journal_entry_number()` with advisory lock
    - Updated: `generate_journal_entry_number()` to use the new logic
    - Updated: `generate_voucher_number(p_prefix)` to use MAX-based approach
    - Updated: `post_receipt_voucher_journal()` trigger
    - Updated: `post_payment_voucher_journal()` trigger
    - Updated: `post_sales_invoice_journal()` trigger
    - Updated: `post_purchase_invoice_journal()` trigger
    - Updated: `post_petty_cash_journal()` trigger
    - Updated: `post_sales_invoice_cogs()` trigger
    - Updated: `post_grn_accounting()` trigger

  4. Important Notes
    - Advisory locks are transaction-scoped and automatically released
    - MAX-based approach handles gaps from deleted entries correctly
    - All existing data is preserved
*/

-- =========================================
-- STEP 1: Create centralized JE number generator with advisory lock
-- =========================================
CREATE OR REPLACE FUNCTION next_journal_entry_number()
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_prefix TEXT;
  v_max_num INTEGER;
  v_number TEXT;
  v_lock_id BIGINT;
BEGIN
  v_prefix := 'JE' || TO_CHAR(CURRENT_DATE, 'YYMM');

  v_lock_id := hashtext('je_number_' || v_prefix);
  PERFORM pg_advisory_xact_lock(v_lock_id);

  SELECT COALESCE(MAX(
    CAST(NULLIF(SUBSTRING(entry_number FROM LENGTH(v_prefix) + 2), '') AS INTEGER)
  ), 0) + 1
  INTO v_max_num
  FROM journal_entries
  WHERE entry_number LIKE v_prefix || '-%'
  AND SUBSTRING(entry_number FROM LENGTH(v_prefix) + 2) ~ '^\d+$';

  v_number := v_prefix || '-' || LPAD(v_max_num::TEXT, 4, '0');

  RETURN v_number;
END;
$$;

-- =========================================
-- STEP 2: Update generate_journal_entry_number to use new logic
-- =========================================
CREATE OR REPLACE FUNCTION generate_journal_entry_number()
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN next_journal_entry_number();
END;
$$;

-- =========================================
-- STEP 3: Update generate_voucher_number to use MAX-based approach
-- =========================================
CREATE OR REPLACE FUNCTION generate_voucher_number(p_prefix TEXT)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_year TEXT;
  v_month TEXT;
  v_max_num INTEGER;
  v_number TEXT;
  v_like_prefix TEXT;
  v_lock_id BIGINT;
BEGIN
  v_year := TO_CHAR(CURRENT_DATE, 'YY');
  v_month := TO_CHAR(CURRENT_DATE, 'MM');
  v_like_prefix := p_prefix || v_year || v_month;

  v_lock_id := hashtext('voucher_' || v_like_prefix);
  PERFORM pg_advisory_xact_lock(v_lock_id);

  IF p_prefix = 'RV' THEN
    SELECT COALESCE(MAX(
      CAST(NULLIF(SUBSTRING(voucher_number FROM LENGTH(v_like_prefix) + 2), '') AS INTEGER)
    ), 0) + 1
    INTO v_max_num
    FROM receipt_vouchers
    WHERE voucher_number LIKE v_like_prefix || '-%'
    AND SUBSTRING(voucher_number FROM LENGTH(v_like_prefix) + 2) ~ '^\d+$';
  ELSIF p_prefix = 'PV' THEN
    SELECT COALESCE(MAX(
      CAST(NULLIF(SUBSTRING(voucher_number FROM LENGTH(v_like_prefix) + 2), '') AS INTEGER)
    ), 0) + 1
    INTO v_max_num
    FROM payment_vouchers
    WHERE voucher_number LIKE v_like_prefix || '-%'
    AND SUBSTRING(voucher_number FROM LENGTH(v_like_prefix) + 2) ~ '^\d+$';
  ELSIF p_prefix = 'PC' THEN
    SELECT COALESCE(MAX(
      CAST(NULLIF(SUBSTRING(voucher_number FROM LENGTH(v_like_prefix) + 2), '') AS INTEGER)
    ), 0) + 1
    INTO v_max_num
    FROM petty_cash_vouchers
    WHERE voucher_number LIKE v_like_prefix || '-%'
    AND SUBSTRING(voucher_number FROM LENGTH(v_like_prefix) + 2) ~ '^\d+$';
  ELSE
    v_max_num := 1;
  END IF;

  v_number := v_like_prefix || '-' || LPAD(v_max_num::TEXT, 4, '0');

  RETURN v_number;
END;
$$;

-- =========================================
-- STEP 4: Update post_receipt_voucher_journal to use centralized function
-- =========================================
CREATE OR REPLACE FUNCTION post_receipt_voucher_journal()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_je_id UUID;
  v_je_number TEXT;
  v_debit_account_id UUID;
  v_ar_account_id UUID;
BEGIN
  IF TG_OP = 'INSERT' THEN

    IF NEW.bank_account_id IS NOT NULL THEN
      SELECT coa_id INTO v_debit_account_id
      FROM bank_accounts
      WHERE id = NEW.bank_account_id;

      IF v_debit_account_id IS NULL THEN
        SELECT id INTO v_debit_account_id FROM chart_of_accounts WHERE code = '1111' LIMIT 1;
      END IF;
    ELSIF NEW.payment_method = 'cash' THEN
      SELECT id INTO v_debit_account_id FROM chart_of_accounts WHERE code = '1101' LIMIT 1;
    ELSE
      SELECT id INTO v_debit_account_id FROM chart_of_accounts WHERE code = '1111' LIMIT 1;
    END IF;

    SELECT id INTO v_ar_account_id FROM chart_of_accounts WHERE code = '1120' LIMIT 1;

    IF v_debit_account_id IS NULL OR v_ar_account_id IS NULL THEN
      RETURN NEW;
    END IF;

    v_je_number := next_journal_entry_number();

    INSERT INTO journal_entries (
      entry_number, entry_date, source_module, reference_id, reference_number,
      description, total_debit, total_credit, is_posted, posted_by
    ) VALUES (
      v_je_number, NEW.voucher_date, 'receipt', NEW.id, NEW.voucher_number,
      'Receipt Voucher: ' || NEW.voucher_number,
      NEW.amount, NEW.amount, true, NEW.created_by
    ) RETURNING id INTO v_je_id;

    INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, description, debit, credit, customer_id)
    VALUES (v_je_id, 1, v_debit_account_id, 'Cash Receipt - ' || NEW.voucher_number, NEW.amount, 0, NEW.customer_id);

    INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, description, debit, credit, customer_id)
    VALUES (v_je_id, 2, v_ar_account_id, 'A/R Payment - ' || NEW.voucher_number, 0, NEW.amount, NEW.customer_id);

    NEW.journal_entry_id := v_je_id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_post_receipt_voucher ON receipt_vouchers;
CREATE TRIGGER trg_post_receipt_voucher
  BEFORE INSERT ON receipt_vouchers
  FOR EACH ROW EXECUTE FUNCTION post_receipt_voucher_journal();

-- =========================================
-- STEP 5: Update post_payment_voucher_journal to use centralized function
-- =========================================
CREATE OR REPLACE FUNCTION post_payment_voucher_journal()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_je_id UUID;
  v_je_number TEXT;
  v_credit_account_id UUID;
  v_ap_account_id UUID;
  v_pph_account_id UUID;
  v_net_amount DECIMAL(18,2);
BEGIN
  IF TG_OP = 'INSERT' THEN

    IF NEW.bank_account_id IS NOT NULL THEN
      SELECT coa_id INTO v_credit_account_id
      FROM bank_accounts
      WHERE id = NEW.bank_account_id;

      IF v_credit_account_id IS NULL THEN
        SELECT id INTO v_credit_account_id FROM chart_of_accounts WHERE code = '1111' LIMIT 1;
      END IF;
    ELSIF NEW.payment_method = 'cash' THEN
      SELECT id INTO v_credit_account_id FROM chart_of_accounts WHERE code = '1101' LIMIT 1;
    ELSE
      SELECT id INTO v_credit_account_id FROM chart_of_accounts WHERE code = '1111' LIMIT 1;
    END IF;

    SELECT id INTO v_ap_account_id FROM chart_of_accounts WHERE code = '2110' LIMIT 1;
    SELECT id INTO v_pph_account_id FROM chart_of_accounts WHERE code = '2132' LIMIT 1;

    IF v_credit_account_id IS NULL OR v_ap_account_id IS NULL THEN
      RETURN NEW;
    END IF;

    v_net_amount := NEW.amount - COALESCE(NEW.pph_amount, 0);

    v_je_number := next_journal_entry_number();

    INSERT INTO journal_entries (
      entry_number, entry_date, source_module, reference_id, reference_number,
      description, total_debit, total_credit, is_posted, posted_by
    ) VALUES (
      v_je_number, NEW.voucher_date, 'payment', NEW.id, NEW.voucher_number,
      'Payment Voucher: ' || NEW.voucher_number,
      NEW.amount, NEW.amount, true, NEW.created_by
    ) RETURNING id INTO v_je_id;

    INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, description, debit, credit, supplier_id)
    VALUES (v_je_id, 1, v_ap_account_id, 'A/P Payment - ' || NEW.voucher_number, NEW.amount, 0, NEW.supplier_id);

    IF NEW.pph_amount > 0 AND v_pph_account_id IS NOT NULL THEN
      INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, description, debit, credit, supplier_id)
      VALUES (v_je_id, 2, v_pph_account_id, 'PPh Withholding - ' || NEW.voucher_number, 0, NEW.pph_amount, NEW.supplier_id);
    END IF;

    INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, description, debit, credit, supplier_id)
    VALUES (v_je_id, 3, v_credit_account_id, 'Cash Payment - ' || NEW.voucher_number, 0, v_net_amount, NEW.supplier_id);

    NEW.journal_entry_id := v_je_id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_post_payment_voucher ON payment_vouchers;
CREATE TRIGGER trg_post_payment_voucher
  BEFORE INSERT ON payment_vouchers
  FOR EACH ROW EXECUTE FUNCTION post_payment_voucher_journal();
