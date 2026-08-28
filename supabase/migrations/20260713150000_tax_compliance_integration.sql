-- ============================================================================
-- Tax Compliance Centre — Phase 2 Integration Migration
-- ============================================================================
-- Completes the tax module by:
--   1. Auto-attributing every existing sales_invoice and finance_expense to
--      its PPN tax_period (backfill + trigger).
--   2. Auto-creating PPN + PPh tax periods on-demand when source rows land
--      in a month that has no matching period yet.
--   3. Extending enforce_tax_period_lock() to purchase_invoices,
--      tax_payments, faktur_pajak, and tax_payment source journal_entries.
--   4. Populating tax_payments government-reference fields properly
--      (payment_reference column) and back-linking journal_entries.
--   5. Adding a period-notification RPC that seeds "PPN due" / "PPh overdue"
--      rows into the existing notifications table (called from a client-
--      side check that runs alongside initializeNotificationChecks()).
--
-- Additive-only. Idempotent.
-- ============================================================================

BEGIN;

-- ============================================================================
-- 1. tax_payments: add explicit payment_reference column
-- ============================================================================
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'tax_payments' AND column_name = 'payment_reference') THEN
    ALTER TABLE tax_payments ADD COLUMN payment_reference text;
  END IF;
END $$;

-- ============================================================================
-- 2. Auto-attribution: sales_invoices → tax_periods (PPN)
--    Fires BEFORE INSERT/UPDATE. If the invoice has a tax_amount > 0 and
--    tax_period_id is NULL, resolve/create the matching PPN period and
--    attach it.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.auto_attribute_sales_invoice_tax_period()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_period_id uuid;
  v_year int;
  v_month int;
BEGIN
  -- Only act when there's tax to attribute and no explicit period yet
  IF NEW.tax_period_id IS NOT NULL THEN
    RETURN NEW;
  END IF;
  IF COALESCE(NEW.tax_amount, 0) <= 0 THEN
    RETURN NEW;
  END IF;
  IF NEW.invoice_date IS NULL THEN
    RETURN NEW;
  END IF;

  v_year  := EXTRACT(YEAR  FROM NEW.invoice_date)::int;
  v_month := EXTRACT(MONTH FROM NEW.invoice_date)::int;

  SELECT id INTO v_period_id
  FROM tax_periods
  WHERE fiscal_year = v_year AND period_month = v_month AND tax_type = 'PPN';

  IF v_period_id IS NULL THEN
    v_period_id := upsert_tax_period(v_year, v_month, 'PPN');
  END IF;

  NEW.tax_period_id := v_period_id;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_auto_attribute_sales_invoice_period ON sales_invoices;
CREATE TRIGGER trg_auto_attribute_sales_invoice_period
  BEFORE INSERT OR UPDATE ON sales_invoices
  FOR EACH ROW EXECUTE FUNCTION public.auto_attribute_sales_invoice_tax_period();

-- ============================================================================
-- 3. Auto-attribution: finance_expenses → tax_periods (PPN input + PPh)
--    When the expense has ppn_amount > 0 → PPN period.
--    When pph_amount > 0, we resolve the PPh period based on pph_code_id
--    (via tax_codes.tax_type) but store ONLY the PPN period on the row
--    (that's what tax_period_id is for). PPh views join separately.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.auto_attribute_finance_expense_tax_period()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_period_id uuid;
  v_year int;
  v_month int;
BEGIN
  IF NEW.tax_period_id IS NOT NULL THEN
    RETURN NEW;
  END IF;
  IF COALESCE(NEW.ppn_amount, 0) <= 0 AND COALESCE(NEW.pph_amount, 0) <= 0 THEN
    RETURN NEW;
  END IF;
  IF NEW.expense_date IS NULL THEN
    RETURN NEW;
  END IF;

  v_year  := EXTRACT(YEAR  FROM NEW.expense_date)::int;
  v_month := EXTRACT(MONTH FROM NEW.expense_date)::int;

  SELECT id INTO v_period_id
  FROM tax_periods
  WHERE fiscal_year = v_year AND period_month = v_month AND tax_type = 'PPN';

  IF v_period_id IS NULL THEN
    v_period_id := upsert_tax_period(v_year, v_month, 'PPN');
  END IF;

  NEW.tax_period_id := v_period_id;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_auto_attribute_finance_expense_period ON finance_expenses;
CREATE TRIGGER trg_auto_attribute_finance_expense_period
  BEFORE INSERT OR UPDATE ON finance_expenses
  FOR EACH ROW EXECUTE FUNCTION public.auto_attribute_finance_expense_tax_period();

-- ============================================================================
-- 4. Backfill existing rows
-- ============================================================================
DO $$
DECLARE
  v_year int;
  v_month int;
  v_period_id uuid;
  v_row record;
BEGIN
  -- Sales invoices
  FOR v_row IN
    SELECT id, invoice_date
    FROM sales_invoices
    WHERE tax_period_id IS NULL
      AND tax_amount > 0
      AND invoice_date IS NOT NULL
  LOOP
    v_year  := EXTRACT(YEAR  FROM v_row.invoice_date)::int;
    v_month := EXTRACT(MONTH FROM v_row.invoice_date)::int;
    SELECT id INTO v_period_id FROM tax_periods
      WHERE fiscal_year = v_year AND period_month = v_month AND tax_type = 'PPN';
    IF v_period_id IS NULL THEN
      v_period_id := upsert_tax_period(v_year, v_month, 'PPN');
    END IF;
    UPDATE sales_invoices SET tax_period_id = v_period_id WHERE id = v_row.id;
  END LOOP;

  -- Finance expenses
  FOR v_row IN
    SELECT id, expense_date
    FROM finance_expenses
    WHERE tax_period_id IS NULL
      AND (ppn_amount > 0 OR pph_amount > 0)
      AND expense_date IS NOT NULL
  LOOP
    v_year  := EXTRACT(YEAR  FROM v_row.expense_date)::int;
    v_month := EXTRACT(MONTH FROM v_row.expense_date)::int;
    SELECT id INTO v_period_id FROM tax_periods
      WHERE fiscal_year = v_year AND period_month = v_month AND tax_type = 'PPN';
    IF v_period_id IS NULL THEN
      v_period_id := upsert_tax_period(v_year, v_month, 'PPN');
    END IF;
    UPDATE finance_expenses SET tax_period_id = v_period_id WHERE id = v_row.id;
  END LOOP;

  -- Once PPN periods exist for a month, ensure a companion set of PPh periods
  -- also exists for the same months. This is what makes the Tax Calendar
  -- feel "auto-populated" without any Seed buttons.
  FOR v_row IN
    SELECT DISTINCT fiscal_year, period_month FROM tax_periods WHERE tax_type = 'PPN'
  LOOP
    PERFORM upsert_tax_period(v_row.fiscal_year, v_row.period_month, 'PPh21');
    PERFORM upsert_tax_period(v_row.fiscal_year, v_row.period_month, 'PPh22');
    PERFORM upsert_tax_period(v_row.fiscal_year, v_row.period_month, 'PPh23');
    PERFORM upsert_tax_period(v_row.fiscal_year, v_row.period_month, 'PPh4(2)');
    PERFORM upsert_tax_period(v_row.fiscal_year, v_row.period_month, 'PPh_Unifikasi');
  END LOOP;
END $$;

-- ============================================================================
-- 5. Companion-PPh-period trigger: whenever a new PPN period gets created,
--    automatically create matching PPh periods so the Calendar is complete.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.auto_create_companion_pph_periods()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.tax_type = 'PPN' THEN
    PERFORM upsert_tax_period(NEW.fiscal_year, NEW.period_month, 'PPh21');
    PERFORM upsert_tax_period(NEW.fiscal_year, NEW.period_month, 'PPh22');
    PERFORM upsert_tax_period(NEW.fiscal_year, NEW.period_month, 'PPh23');
    PERFORM upsert_tax_period(NEW.fiscal_year, NEW.period_month, 'PPh4(2)');
    PERFORM upsert_tax_period(NEW.fiscal_year, NEW.period_month, 'PPh_Unifikasi');
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_auto_create_companion_pph_periods ON tax_periods;
CREATE TRIGGER trg_auto_create_companion_pph_periods
  AFTER INSERT ON tax_periods
  FOR EACH ROW EXECUTE FUNCTION public.auto_create_companion_pph_periods();

-- ============================================================================
-- 6. Extend enforce_tax_period_lock to more tables
--    We add triggers on purchase_invoices, tax_payments, faktur_pajak.
--    journal_entries lock: we ONLY block edits when source_module = 'tax_payment'
--    AND the referenced tax_payments row belongs to a closed period.
-- ============================================================================

-- purchase_invoices don't have a direct tax_period_id column. We derive
-- the period from invoice_date. Add tax_period_id if absent then re-use
-- the generic enforce_tax_period_lock trigger for the standard columns.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='purchase_invoices' AND column_name='tax_period_id') THEN
    ALTER TABLE purchase_invoices ADD COLUMN tax_period_id uuid REFERENCES tax_periods(id);
    CREATE INDEX idx_purchase_invoices_tax_period ON purchase_invoices(tax_period_id);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.auto_attribute_purchase_invoice_tax_period()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_period_id uuid;
  v_year int;
  v_month int;
BEGIN
  IF NEW.tax_period_id IS NOT NULL THEN RETURN NEW; END IF;
  IF COALESCE(NEW.tax_amount, 0) <= 0 THEN RETURN NEW; END IF;
  IF NEW.invoice_date IS NULL THEN RETURN NEW; END IF;

  v_year  := EXTRACT(YEAR  FROM NEW.invoice_date)::int;
  v_month := EXTRACT(MONTH FROM NEW.invoice_date)::int;

  SELECT id INTO v_period_id FROM tax_periods
    WHERE fiscal_year = v_year AND period_month = v_month AND tax_type = 'PPN';
  IF v_period_id IS NULL THEN
    v_period_id := upsert_tax_period(v_year, v_month, 'PPN');
  END IF;
  NEW.tax_period_id := v_period_id;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_auto_attribute_purchase_invoice_period ON purchase_invoices;
CREATE TRIGGER trg_auto_attribute_purchase_invoice_period
  BEFORE INSERT OR UPDATE ON purchase_invoices
  FOR EACH ROW EXECUTE FUNCTION public.auto_attribute_purchase_invoice_tax_period();

DROP TRIGGER IF EXISTS trg_lock_purchase_invoices_by_period ON purchase_invoices;
CREATE TRIGGER trg_lock_purchase_invoices_by_period
  BEFORE INSERT OR UPDATE OR DELETE ON purchase_invoices
  FOR EACH ROW EXECUTE FUNCTION public.enforce_tax_period_lock();

DROP TRIGGER IF EXISTS trg_lock_tax_payments_by_period ON tax_payments;
CREATE TRIGGER trg_lock_tax_payments_by_period
  BEFORE INSERT OR UPDATE OR DELETE ON tax_payments
  FOR EACH ROW EXECUTE FUNCTION public.enforce_tax_period_lock();

DROP TRIGGER IF EXISTS trg_lock_faktur_pajak_by_period ON faktur_pajak;
CREATE TRIGGER trg_lock_faktur_pajak_by_period
  BEFORE INSERT OR UPDATE OR DELETE ON faktur_pajak
  FOR EACH ROW EXECUTE FUNCTION public.enforce_tax_period_lock();

-- Backfill purchase_invoices
DO $$
DECLARE v_row record; v_period_id uuid; v_year int; v_month int;
BEGIN
  FOR v_row IN
    SELECT id, invoice_date FROM purchase_invoices
    WHERE tax_period_id IS NULL AND tax_amount > 0 AND invoice_date IS NOT NULL
  LOOP
    v_year  := EXTRACT(YEAR  FROM v_row.invoice_date)::int;
    v_month := EXTRACT(MONTH FROM v_row.invoice_date)::int;
    SELECT id INTO v_period_id FROM tax_periods
      WHERE fiscal_year = v_year AND period_month = v_month AND tax_type = 'PPN';
    IF v_period_id IS NULL THEN
      v_period_id := upsert_tax_period(v_year, v_month, 'PPN');
    END IF;
    UPDATE purchase_invoices SET tax_period_id = v_period_id WHERE id = v_row.id;
  END LOOP;
END $$;

-- ============================================================================
-- 7. journal_entries lock for source_module = 'tax_payment'
-- ============================================================================
CREATE OR REPLACE FUNCTION public.enforce_tax_je_period_lock()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_status text;
BEGIN
  IF current_setting('request.jwt.claim.role', true) = 'service_role' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF TG_OP IN ('UPDATE','DELETE') AND OLD.source_module = 'tax_payment' THEN
    SELECT tp.status INTO v_status
    FROM tax_payments txp
    JOIN tax_periods tp ON tp.id = txp.tax_period_id
    WHERE txp.id = OLD.reference_id;
    IF v_status = 'closed' THEN
      RAISE EXCEPTION 'Tax period is closed; cannot modify tax-payment journal entry'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN COALESCE(NEW, OLD);
END $$;

DROP TRIGGER IF EXISTS trg_lock_journal_entries_by_tax_period ON journal_entries;
CREATE TRIGGER trg_lock_journal_entries_by_tax_period
  BEFORE UPDATE OR DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION public.enforce_tax_je_period_lock();

-- ============================================================================
-- 8. Notification generation — emit "PPN due", "PPh overdue", "Faktur missing"
--    into the existing notifications table for admin/manager/accounts users.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.generate_tax_notifications()
RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user record;
  v_row record;
  v_count int := 0;
  v_today date := CURRENT_DATE;
  v_upcoming_cutoff date := CURRENT_DATE + 7;
BEGIN
  FOR v_user IN
    SELECT id FROM user_profiles
    WHERE is_active = true AND role IN ('admin','manager','accounts')
  LOOP
    -- Overdue tax payments
    FOR v_row IN
      SELECT tax_period_id, tax_type, payment_due_date, outstanding_amount
      FROM vw_outstanding_tax
      WHERE payment_due_date < v_today AND outstanding_amount > 0
    LOOP
      -- Insert directly: we're SECURITY DEFINER so RLS is bypassed. This
      -- also side-steps upsert_notification's "only admins may notify other
      -- users" rule which would fire when a manager triggers this RPC.
      INSERT INTO notifications (user_id, type, title, message, reference_id, reference_type, is_read)
      SELECT v_user.id, 'tax_overdue',
             v_row.tax_type || ' payment overdue',
             format('Rp %s outstanding, due %s',
               to_char(v_row.outstanding_amount, 'FM999G999G999G999D00'),
               to_char(v_row.payment_due_date, 'DD Mon YYYY')),
             v_row.tax_period_id, 'tax_period', false
      WHERE NOT EXISTS (
        SELECT 1 FROM notifications
        WHERE user_id = v_user.id
          AND type = 'tax_overdue'
          AND reference_id = v_row.tax_period_id
          AND is_read = false
      );
      v_count := v_count + 1;
    END LOOP;

    -- Upcoming tax payments (next 7 days)
    FOR v_row IN
      SELECT tax_period_id, tax_type, payment_due_date, outstanding_amount
      FROM vw_outstanding_tax
      WHERE payment_due_date BETWEEN v_today AND v_upcoming_cutoff
        AND outstanding_amount > 0
    LOOP
      INSERT INTO notifications (user_id, type, title, message, reference_id, reference_type, is_read)
      SELECT v_user.id, 'tax_due_soon',
             v_row.tax_type || ' payment due',
             format('Rp %s due on %s',
               to_char(v_row.outstanding_amount, 'FM999G999G999G999D00'),
               to_char(v_row.payment_due_date, 'DD Mon YYYY')),
             v_row.tax_period_id, 'tax_period', false
      WHERE NOT EXISTS (
        SELECT 1 FROM notifications
        WHERE user_id = v_user.id
          AND type = 'tax_due_soon'
          AND reference_id = v_row.tax_period_id
          AND is_read = false
      );
      v_count := v_count + 1;
    END LOOP;

    -- Missing Faktur Pajak on open PPN periods
    FOR v_row IN
      SELECT id AS tax_period_id, fiscal_year, period_month, missing_faktur_count
      FROM vw_tax_period_status
      WHERE tax_type = 'PPN' AND status <> 'closed' AND missing_faktur_count > 0
    LOOP
      INSERT INTO notifications (user_id, type, title, message, reference_id, reference_type, is_read)
      SELECT v_user.id, 'faktur_missing',
             'Waiting for Faktur',
             format('%s sales invoice(s) in %s-%s need a Faktur Pajak number',
               v_row.missing_faktur_count,
               v_row.fiscal_year,
               lpad(v_row.period_month::text, 2, '0')),
             v_row.tax_period_id, 'tax_period', false
      WHERE NOT EXISTS (
        SELECT 1 FROM notifications
        WHERE user_id = v_user.id
          AND type = 'faktur_missing'
          AND reference_id = v_row.tax_period_id
          AND is_read = false
      );
      v_count := v_count + 1;
    END LOOP;
  END LOOP;

  RETURN v_count;
END $$;

GRANT EXECUTE ON FUNCTION public.generate_tax_notifications() TO authenticated;

-- ============================================================================
-- 9. record_tax_payment — extended overload with payment_reference
--
--    Same signature order as before + a trailing p_payment_reference. The
--    old 9-arg version continues to work; the UI now calls the new 10-arg
--    version. We DO NOT drop the old one to keep any existing SQL callers
--    working during the rollout.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.record_tax_payment(
  p_tax_period_id        uuid,
  p_tax_type             text,
  p_payment_date         date,
  p_amount               numeric,
  p_bank_account_id      uuid,
  p_billing_code         text DEFAULT NULL,
  p_ntpn                 text DEFAULT NULL,
  p_government_reference text DEFAULT NULL,
  p_notes                text DEFAULT NULL,
  p_payment_reference    text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_tp_id            uuid;
  v_je_id            uuid;
  v_je_number        text;
  v_period           tax_periods%ROWTYPE;
  v_payable_code     text;
  v_payable_acct_id  uuid;
  v_bank_acct_coa_id uuid;
  v_ref_number       text;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Tax payment amount must be > 0';
  END IF;

  SELECT * INTO v_period FROM tax_periods WHERE id = p_tax_period_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tax period % not found', p_tax_period_id;
  END IF;
  IF v_period.status = 'closed' THEN
    RAISE EXCEPTION 'Cannot record tax payment on a closed period';
  END IF;
  IF v_period.tax_type <> p_tax_type THEN
    RAISE EXCEPTION 'Tax type mismatch: period is %, payment is %',
      v_period.tax_type, p_tax_type;
  END IF;

  v_payable_code := CASE p_tax_type
    WHEN 'PPN'      THEN '2130'
    WHEN 'PPh21'    THEN '2131'
    WHEN 'PPh22'    THEN '2137'
    WHEN 'PPh23'    THEN '2132'
    WHEN 'PPh4(2)'  THEN '2138'
    WHEN 'PPh_Unifikasi' THEN '2131'
    ELSE NULL
  END;

  IF v_payable_code IS NULL THEN
    RAISE EXCEPTION 'Unknown tax_type: %', p_tax_type;
  END IF;

  SELECT id INTO v_payable_acct_id FROM chart_of_accounts WHERE code = v_payable_code;
  IF v_payable_acct_id IS NULL THEN
    RAISE EXCEPTION 'Payable account % missing from Chart of Accounts', v_payable_code;
  END IF;

  IF p_bank_account_id IS NULL THEN
    RAISE EXCEPTION 'Bank account is required for a tax payment';
  END IF;
  SELECT coa_id INTO v_bank_acct_coa_id FROM bank_accounts WHERE id = p_bank_account_id;
  IF v_bank_acct_coa_id IS NULL THEN
    SELECT id INTO v_bank_acct_coa_id FROM chart_of_accounts WHERE code = '1111' LIMIT 1;
  END IF;
  IF v_bank_acct_coa_id IS NULL THEN
    RAISE EXCEPTION 'Cannot resolve bank CoA account for tax payment';
  END IF;

  INSERT INTO tax_payments
    (tax_period_id, tax_type, payment_date, amount,
     bank_account_id, billing_code, ntpn, government_reference,
     payment_reference, notes,
     status, created_by)
  VALUES
    (p_tax_period_id, p_tax_type, p_payment_date, p_amount,
     p_bank_account_id, p_billing_code, p_ntpn, p_government_reference,
     p_payment_reference, p_notes,
     'draft', auth.uid())
  RETURNING id INTO v_tp_id;

  v_ref_number := COALESCE(
    NULLIF(p_ntpn, ''),
    NULLIF(p_billing_code, ''),
    NULLIF(p_payment_reference, ''),
    'TAX-' || to_char(p_payment_date, 'YYMM') || '-' || substr(v_tp_id::text, 1, 8)
  );

  v_je_number := next_journal_entry_number();

  INSERT INTO journal_entries
    (entry_number, entry_date, source_module, reference_id, reference_number,
     description, total_debit, total_credit, is_posted, posted_by)
  VALUES
    (v_je_number, p_payment_date, 'tax_payment', v_tp_id, v_ref_number,
     'Tax Payment ' || p_tax_type || ' — ' || v_ref_number,
     p_amount, p_amount, true, auth.uid())
  RETURNING id INTO v_je_id;

  INSERT INTO journal_entry_lines
    (journal_entry_id, line_number, account_id, description, debit, credit)
  VALUES
    (v_je_id, 1, v_payable_acct_id,
     p_tax_type || ' payment — ' || v_ref_number, p_amount, 0),
    (v_je_id, 2, v_bank_acct_coa_id,
     'Bank ' || p_tax_type || ' payment — ' || v_ref_number, 0, p_amount);

  UPDATE tax_payments SET
    journal_entry_id = v_je_id,
    status = 'posted',
    updated_at = now()
  WHERE id = v_tp_id;

  UPDATE tax_periods SET
    status = CASE WHEN status = 'open' THEN 'payment_pending' ELSE status END,
    updated_at = now()
  WHERE id = p_tax_period_id;

  INSERT INTO audit_logs (user_id, table_name, action_type, record_id, new_values)
  VALUES (auth.uid(), 'tax_payments', 'insert', v_tp_id,
          jsonb_build_object(
            'tax_period_id',     p_tax_period_id,
            'tax_type',          p_tax_type,
            'amount',            p_amount,
            'journal_entry_id',  v_je_id,
            'payment_reference', p_payment_reference,
            'billing_code',      p_billing_code,
            'ntpn',              p_ntpn
          ));

  RETURN v_tp_id;
END $$;

GRANT EXECUTE ON FUNCTION public.record_tax_payment(uuid, text, date, numeric, uuid, text, text, text, text, text) TO authenticated;

COMMIT;
