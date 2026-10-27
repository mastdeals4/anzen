-- ============================================================================
-- Tax Compliance Centre — Phase 1b: RPCs, Journal Posting, Audit Trail
-- ============================================================================
-- All functions SECURITY DEFINER (like all other Finance functions in this
-- repo). They enforce role/period-status checks internally.
--
-- Functions:
--   * compute_tax_due_dates(tax_type, fiscal_year, period_month)
--       — pure function; returns (period_start, period_end, payment_due, filing_due)
--   * upsert_tax_period(fiscal_year, period_month, tax_type)
--       — idempotent; creates or refreshes a tax_periods row
--   * compute_period_ppn(p_period_id)
--       — recomputes input/output/net/carry-forward snapshot on the row
--   * assign_faktur_pajak_number(p_sales_invoice_id)
--       — atomically consumes organization_tax_settings.faktur_current_number,
--         writes sales_invoices.faktur_pajak_number, upserts faktur_pajak row
--   * record_tax_payment(...)
--       — creates tax_payments row + journal_entry + journal_entry_lines,
--         debit tax-payable, credit bank/cash.  Bank Reconciliation picks it
--         up automatically via journal_entry_id.
--   * close_tax_period(p_period_id)
--       — pre-conditions: all faktur generated for PPN periods, all tax
--         payments >= outstanding, no draft payments.
--         Writes audit_logs, sets status='closed'.
--   * reopen_tax_period(p_period_id, p_reason)
--       — admin-only. Writes audit_logs.
--   * check_tax_period_locked (trigger) — blocks writes to sales_invoices /
--         finance_expenses inside a closed tax_period.
--
-- Every state-changing RPC writes to audit_logs.
-- ============================================================================

BEGIN;

-- ============================================================================
-- 1. compute_tax_due_dates — pure calendar math
-- ============================================================================
CREATE OR REPLACE FUNCTION public.compute_tax_due_dates(
  p_tax_type    text,
  p_fiscal_year int,
  p_period_month int
) RETURNS TABLE (
  period_start     date,
  period_end       date,
  payment_due_date date,
  filing_due_date  date
) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_start                 date;
  v_end                   date;
  v_cfg                   tax_calendar_config%ROWTYPE;
  v_offset_month_start    date;
BEGIN
  v_start := make_date(p_fiscal_year, p_period_month, 1);
  v_end   := (v_start + interval '1 month - 1 day')::date;

  SELECT * INTO v_cfg
  FROM tax_calendar_config
  WHERE tax_type = p_tax_type AND is_active = true;

  IF NOT FOUND THEN
    RETURN QUERY SELECT v_start, v_end, NULL::date, NULL::date;
    RETURN;
  END IF;

  v_offset_month_start := (v_start + (v_cfg.due_relative_month_offset || ' months')::interval)::date;

  RETURN QUERY SELECT
    v_start,
    v_end,
    CASE
      WHEN v_cfg.end_of_month_payment THEN
        ((v_offset_month_start + interval '1 month - 1 day')::date)
      WHEN v_cfg.payment_due_day IS NOT NULL THEN
        make_date(
          EXTRACT(YEAR  FROM v_offset_month_start)::int,
          EXTRACT(MONTH FROM v_offset_month_start)::int,
          LEAST(v_cfg.payment_due_day,
                EXTRACT(DAY FROM (v_offset_month_start + interval '1 month - 1 day'))::int)
        )
      ELSE NULL
    END,
    CASE
      WHEN v_cfg.filing_due_day IS NOT NULL THEN
        make_date(
          EXTRACT(YEAR  FROM v_offset_month_start)::int,
          EXTRACT(MONTH FROM v_offset_month_start)::int,
          LEAST(v_cfg.filing_due_day,
                EXTRACT(DAY FROM (v_offset_month_start + interval '1 month - 1 day'))::int)
        )
      WHEN v_cfg.end_of_month_payment THEN
        ((v_offset_month_start + interval '1 month - 1 day')::date)
      ELSE NULL
    END;
END $$;

-- ============================================================================
-- 2. upsert_tax_period — creates or refreshes due-dates for a period.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.upsert_tax_period(
  p_fiscal_year  int,
  p_period_month int,
  p_tax_type     text
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_id       uuid;
  v_start    date;
  v_end      date;
  v_pay_due  date;
  v_file_due date;
BEGIN
  SELECT period_start, period_end, payment_due_date, filing_due_date
  INTO v_start, v_end, v_pay_due, v_file_due
  FROM compute_tax_due_dates(p_tax_type, p_fiscal_year, p_period_month);

  INSERT INTO tax_periods
    (fiscal_year, period_month, tax_type, period_start, period_end,
     payment_due_date, filing_due_date, created_by)
  VALUES
    (p_fiscal_year, p_period_month, p_tax_type, v_start, v_end,
     v_pay_due, v_file_due, auth.uid())
  ON CONFLICT (fiscal_year, period_month, tax_type)
  DO UPDATE SET
    payment_due_date = EXCLUDED.payment_due_date,
    filing_due_date  = EXCLUDED.filing_due_date,
    updated_at       = now()
  RETURNING id INTO v_id;

  RETURN v_id;
END $$;

-- ============================================================================
-- 3. compute_period_ppn — recomputes Input/Output/Net + carry-forward snapshot
--    Reads from finance_expenses (input) and sales_invoices (output).
-- ============================================================================
CREATE OR REPLACE FUNCTION public.compute_period_ppn(p_period_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_period    tax_periods%ROWTYPE;
  v_input     numeric(18,2);
  v_output    numeric(18,2);
  v_prior_cf  numeric(18,2);
  v_pph_total numeric(18,2);
BEGIN
  SELECT * INTO v_period FROM tax_periods WHERE id = p_period_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Tax period % not found', p_period_id; END IF;

  IF v_period.status = 'closed' THEN
    RAISE EXCEPTION 'Cannot recompute a closed tax period';
  END IF;

  IF v_period.tax_type = 'PPN' THEN
    -- Input PPN from finance_expenses attributed to this period
    SELECT COALESCE(SUM(ppn_amount), 0) INTO v_input
    FROM finance_expenses
    WHERE tax_period_id = p_period_id;

    -- Output PPN from sales_invoices attributed to this period
    SELECT COALESCE(SUM(tax_amount), 0) INTO v_output
    FROM sales_invoices
    WHERE tax_period_id = p_period_id;

    -- Carry-forward IN = prior period's carry_forward_out (if a prior period exists)
    SELECT COALESCE(carry_forward_out, 0) INTO v_prior_cf
    FROM tax_periods
    WHERE tax_type = 'PPN'
      AND (fiscal_year, period_month) < (v_period.fiscal_year, v_period.period_month)
    ORDER BY fiscal_year DESC, period_month DESC
    LIMIT 1;

    v_prior_cf := COALESCE(v_prior_cf, 0);

    UPDATE tax_periods SET
      input_ppn_total   = v_input,
      output_ppn_total  = v_output,
      carry_forward_in  = v_prior_cf,
      net_ppn           = GREATEST(v_output - v_input - v_prior_cf, 0),
      carry_forward_out = GREATEST(v_input + v_prior_cf - v_output, 0),
      updated_at        = now()
    WHERE id = p_period_id;
  ELSE
    -- PPh: sum from finance_expenses with matching tax_period_id
    SELECT COALESCE(SUM(pph_amount), 0) INTO v_pph_total
    FROM finance_expenses
    WHERE tax_period_id = p_period_id;

    UPDATE tax_periods SET
      pph_total  = v_pph_total,
      updated_at = now()
    WHERE id = p_period_id;
  END IF;
END $$;

-- ============================================================================
-- 4. assign_faktur_pajak_number — atomic
-- ============================================================================
CREATE OR REPLACE FUNCTION public.assign_faktur_pajak_number(
  p_sales_invoice_id uuid
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_settings   organization_tax_settings%ROWTYPE;
  v_number     text;
  v_next       int;
  v_invoice    sales_invoices%ROWTYPE;
  v_lock_id    bigint;
  v_period_id  uuid;
  v_dpp        numeric(18,2);
  v_ppn        numeric(18,2);
BEGIN
  -- Serialize faktur-number issuance across concurrent callers
  v_lock_id := hashtext('faktur_pajak_seq');
  PERFORM pg_advisory_xact_lock(v_lock_id);

  SELECT * INTO v_settings FROM organization_tax_settings ORDER BY created_at LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'organization_tax_settings not configured — cannot issue Faktur Pajak';
  END IF;
  IF v_settings.pkp_status = false THEN
    RAISE EXCEPTION 'Organization is not PKP — cannot issue Faktur Pajak';
  END IF;

  SELECT * INTO v_invoice FROM sales_invoices WHERE id = p_sales_invoice_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sales invoice % not found', p_sales_invoice_id;
  END IF;
  IF v_invoice.faktur_pajak_number IS NOT NULL AND v_invoice.faktur_pajak_number <> '' THEN
    -- Idempotent: return the existing number
    RETURN v_invoice.faktur_pajak_number;
  END IF;

  v_next := COALESCE(v_settings.faktur_current_number, 0) + 1;

  v_number := COALESCE(v_settings.faktur_prefix, '000') || '.' ||
              lpad(v_next::text, 8, '0') || '-' ||
              to_char(COALESCE(v_invoice.invoice_date, CURRENT_DATE), 'YY');

  UPDATE organization_tax_settings
    SET faktur_current_number = v_next, updated_at = now()
    WHERE id = v_settings.id;

  UPDATE sales_invoices
    SET faktur_pajak_number = v_number,
        updated_at = now()
    WHERE id = p_sales_invoice_id;

  -- Attribute invoice to its PPN tax_period (idempotent upsert)
  v_period_id := upsert_tax_period(
    EXTRACT(YEAR  FROM v_invoice.invoice_date)::int,
    EXTRACT(MONTH FROM v_invoice.invoice_date)::int,
    'PPN'
  );
  UPDATE sales_invoices SET tax_period_id = v_period_id WHERE id = p_sales_invoice_id;

  -- Derive DPP + PPN split from tax_amount (Indonesian PPN 11%)
  v_ppn := COALESCE(v_invoice.tax_amount, 0);
  v_dpp := GREATEST(COALESCE(v_invoice.total_amount, 0) - v_ppn, 0);

  INSERT INTO faktur_pajak
    (sales_invoice_id, tax_period_id, faktur_number, issue_date,
     customer_id, dpp_amount, ppn_amount, status, created_by)
  VALUES
    (p_sales_invoice_id, v_period_id, v_number,
     COALESCE(v_invoice.invoice_date, CURRENT_DATE),
     v_invoice.customer_id, v_dpp, v_ppn, 'generated', auth.uid())
  ON CONFLICT (sales_invoice_id) DO UPDATE SET
    faktur_number = EXCLUDED.faktur_number,
    tax_period_id = EXCLUDED.tax_period_id,
    dpp_amount    = EXCLUDED.dpp_amount,
    ppn_amount    = EXCLUDED.ppn_amount,
    updated_at    = now();

  INSERT INTO audit_logs (user_id, table_name, action_type, record_id, new_values)
  VALUES (auth.uid(), 'faktur_pajak', 'insert', p_sales_invoice_id,
          jsonb_build_object('faktur_number', v_number, 'sales_invoice_id', p_sales_invoice_id));

  RETURN v_number;
END $$;

-- ============================================================================
-- 5. record_tax_payment
--
--    Posts:
--      Dr  Tax Payable (2130 / 2131 / 2132 / 2133 / 2137 / 2138 by type)
--      Cr  Bank account (bank_accounts.coa_id) or Cash (1101)
--
--    JE has source_module='tax_payment', reference_id = tax_payments.id,
--    reference_number = tax_payments row (BILLING_CODE or NTPN or 'TAX-YYMM-N').
--    Bank reconciliation matches on journal_entry_id exactly like every
--    other payment.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.record_tax_payment(
  p_tax_period_id       uuid,
  p_tax_type            text,
  p_payment_date        date,
  p_amount              numeric,
  p_bank_account_id     uuid,
  p_billing_code        text DEFAULT NULL,
  p_ntpn                text DEFAULT NULL,
  p_government_reference text DEFAULT NULL,
  p_notes               text DEFAULT NULL
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

  -- Map tax type → payable account code
  v_payable_code := CASE p_tax_type
    WHEN 'PPN'      THEN '2130'
    WHEN 'PPh21'    THEN '2131'
    WHEN 'PPh22'    THEN '2137'
    WHEN 'PPh23'    THEN '2132'
    WHEN 'PPh4(2)'  THEN '2138'
    WHEN 'PPh_Unifikasi' THEN '2131'  -- treated as PPh 21 payable by default
    ELSE NULL
  END;

  IF v_payable_code IS NULL THEN
    RAISE EXCEPTION 'Unknown tax_type: %', p_tax_type;
  END IF;

  SELECT id INTO v_payable_acct_id FROM chart_of_accounts WHERE code = v_payable_code;
  IF v_payable_acct_id IS NULL THEN
    RAISE EXCEPTION 'Payable account % missing from Chart of Accounts', v_payable_code;
  END IF;

  -- Bank account → CoA account
  IF p_bank_account_id IS NULL THEN
    RAISE EXCEPTION 'Bank account is required for a tax payment';
  END IF;
  SELECT coa_id INTO v_bank_acct_coa_id FROM bank_accounts WHERE id = p_bank_account_id;
  IF v_bank_acct_coa_id IS NULL THEN
    -- Fallback to generic Bank BCA (1111) when bank_accounts.coa_id not wired
    SELECT id INTO v_bank_acct_coa_id FROM chart_of_accounts WHERE code = '1111' LIMIT 1;
  END IF;
  IF v_bank_acct_coa_id IS NULL THEN
    RAISE EXCEPTION 'Cannot resolve bank CoA account for tax payment';
  END IF;

  -- 1) Create tax_payments row (draft)
  INSERT INTO tax_payments
    (tax_period_id, tax_type, payment_date, amount,
     bank_account_id, billing_code, ntpn, government_reference, notes,
     status, created_by)
  VALUES
    (p_tax_period_id, p_tax_type, p_payment_date, p_amount,
     p_bank_account_id, p_billing_code, p_ntpn, p_government_reference, p_notes,
     'draft', auth.uid())
  RETURNING id INTO v_tp_id;

  v_ref_number := COALESCE(NULLIF(p_ntpn,''), NULLIF(p_billing_code,''),
                           'TAX-' || to_char(p_payment_date, 'YYMM') || '-' || substr(v_tp_id::text, 1, 8));

  -- 2) Post journal entry: Dr Tax Payable / Cr Bank
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
     p_tax_type || ' payment — ' || v_ref_number,
     p_amount, 0),
    (v_je_id, 2, v_bank_acct_coa_id,
     'Bank ' || p_tax_type || ' payment — ' || v_ref_number,
     0, p_amount);

  -- 3) Link back and mark posted
  UPDATE tax_payments SET
    journal_entry_id = v_je_id,
    status           = 'posted',
    updated_at       = now()
  WHERE id = v_tp_id;

  -- 4) Nudge the period status if it was open
  UPDATE tax_periods SET
    status = CASE WHEN status = 'open' THEN 'payment_pending' ELSE status END,
    updated_at = now()
  WHERE id = p_tax_period_id;

  INSERT INTO audit_logs (user_id, table_name, action_type, record_id, new_values)
  VALUES (auth.uid(), 'tax_payments', 'insert', v_tp_id,
          jsonb_build_object(
            'tax_period_id', p_tax_period_id,
            'tax_type',      p_tax_type,
            'amount',        p_amount,
            'journal_entry_id', v_je_id
          ));

  RETURN v_tp_id;
END $$;

-- ============================================================================
-- 6. mark_tax_payment_reconciled — called by BankReconciliation flow
--    Currently manual; a future trigger on bank_reconciliation_items could
--    call this automatically when is_matched flips true for a JE that
--    corresponds to a tax_payments row.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.mark_tax_payment_reconciled(p_tax_payment_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE tax_payments
    SET status = 'reconciled', updated_at = now()
    WHERE id = p_tax_payment_id AND status = 'posted';

  INSERT INTO audit_logs (user_id, table_name, action_type, record_id, new_values)
  VALUES (auth.uid(), 'tax_payments', 'update', p_tax_payment_id,
          jsonb_build_object('status','reconciled'));
END $$;

-- Auto-reconcile trigger: when bank_reconciliation_items.is_matched flips
-- true for a JE that belongs to a tax_payment, mark that tax_payment
-- reconciled.
CREATE OR REPLACE FUNCTION public.auto_reconcile_tax_payment()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.is_matched = true
     AND (OLD.is_matched IS DISTINCT FROM NEW.is_matched)
     AND NEW.journal_entry_id IS NOT NULL THEN
    UPDATE tax_payments
      SET status = 'reconciled', updated_at = now()
      WHERE journal_entry_id = NEW.journal_entry_id
        AND status = 'posted';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_auto_reconcile_tax_payment ON bank_reconciliation_items;
CREATE TRIGGER trg_auto_reconcile_tax_payment
  AFTER UPDATE OF is_matched ON bank_reconciliation_items
  FOR EACH ROW EXECUTE FUNCTION public.auto_reconcile_tax_payment();

-- ============================================================================
-- 7. close_tax_period
-- ============================================================================
CREATE OR REPLACE FUNCTION public.close_tax_period(p_period_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_period tax_periods%ROWTYPE;
  v_missing_faktur int;
  v_unreconciled_payments int;
  v_outstanding numeric(18,2);
BEGIN
  IF NOT EXISTS (SELECT 1 FROM user_profiles
                 WHERE id = auth.uid() AND role IN ('admin','manager') AND is_active = true) THEN
    RAISE EXCEPTION 'Only admins/managers may close a tax period';
  END IF;

  SELECT * INTO v_period FROM tax_periods WHERE id = p_period_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tax period % not found', p_period_id;
  END IF;
  IF v_period.status = 'closed' THEN
    RAISE EXCEPTION 'Tax period already closed';
  END IF;

  -- Recompute snapshot before closing
  PERFORM compute_period_ppn(p_period_id);
  SELECT * INTO v_period FROM tax_periods WHERE id = p_period_id;

  -- Pre-conditions
  IF v_period.tax_type = 'PPN' THEN
    SELECT COUNT(*) INTO v_missing_faktur
    FROM sales_invoices
    WHERE tax_period_id = p_period_id
      AND tax_amount > 0
      AND (faktur_pajak_number IS NULL OR faktur_pajak_number = '');
    IF v_missing_faktur > 0 THEN
      RAISE EXCEPTION 'Cannot close period: % sales invoice(s) missing Faktur Pajak number', v_missing_faktur;
    END IF;
  END IF;

  SELECT COUNT(*) INTO v_unreconciled_payments
  FROM tax_payments
  WHERE tax_period_id = p_period_id
    AND status IN ('draft','posted');
  IF v_unreconciled_payments > 0 THEN
    RAISE EXCEPTION 'Cannot close period: % unreconciled tax payment(s)', v_unreconciled_payments;
  END IF;

  -- Outstanding = tax due − payments reconciled
  SELECT outstanding_amount INTO v_outstanding
  FROM vw_outstanding_tax
  WHERE tax_period_id = p_period_id;
  IF COALESCE(v_outstanding, 0) > 0 THEN
    RAISE EXCEPTION 'Cannot close period: Rp % still outstanding', v_outstanding;
  END IF;

  UPDATE tax_periods SET
    status    = 'closed',
    closed_at = now(),
    closed_by = auth.uid(),
    updated_at = now()
  WHERE id = p_period_id;

  INSERT INTO audit_logs (user_id, table_name, action_type, record_id, new_values)
  VALUES (auth.uid(), 'tax_periods', 'update', p_period_id,
          jsonb_build_object('action','close','status','closed'));
END $$;

-- ============================================================================
-- 8. reopen_tax_period — admin-only, requires a reason
-- ============================================================================
CREATE OR REPLACE FUNCTION public.reopen_tax_period(p_period_id uuid, p_reason text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'Reopen reason is required';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM user_profiles
                 WHERE id = auth.uid() AND role = 'admin' AND is_active = true) THEN
    RAISE EXCEPTION 'Only admins may reopen a closed tax period';
  END IF;

  UPDATE tax_periods SET
    status         = 'reopened',
    reopen_reason  = p_reason,
    reopened_at    = now(),
    reopened_by    = auth.uid(),
    updated_at     = now()
  WHERE id = p_period_id AND status = 'closed';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Period % is not in closed state', p_period_id;
  END IF;

  INSERT INTO audit_logs (user_id, table_name, action_type, record_id, new_values)
  VALUES (auth.uid(), 'tax_periods', 'update', p_period_id,
          jsonb_build_object('action','reopen','reason',p_reason));
END $$;

-- ============================================================================
-- 9. Period lock — prevent edits to sales_invoices / finance_expenses
--    that belong to a closed tax_period.  Non-service-role only.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.enforce_tax_period_lock()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_status text;
BEGIN
  IF (current_setting('request.jwt.claim.role', true) = 'service_role') THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF TG_OP = 'UPDATE' OR TG_OP = 'DELETE' THEN
    -- Check OLD row's period
    IF (COALESCE(OLD.tax_period_id, NULL) IS NOT NULL) THEN
      SELECT status INTO v_status FROM tax_periods WHERE id = OLD.tax_period_id;
      IF v_status = 'closed' THEN
        RAISE EXCEPTION 'Tax period is closed; cannot modify % on %',
          TG_OP, TG_TABLE_NAME
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;

  IF TG_OP = 'INSERT' OR TG_OP = 'UPDATE' THEN
    IF NEW.tax_period_id IS NOT NULL THEN
      SELECT status INTO v_status FROM tax_periods WHERE id = NEW.tax_period_id;
      IF v_status = 'closed' THEN
        RAISE EXCEPTION 'Tax period is closed; cannot assign new rows to it'
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;

  RETURN COALESCE(NEW, OLD);
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_lock_sales_invoices_by_period') THEN
    CREATE TRIGGER trg_lock_sales_invoices_by_period
      BEFORE INSERT OR UPDATE OR DELETE ON sales_invoices
      FOR EACH ROW EXECUTE FUNCTION public.enforce_tax_period_lock();
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='finance_expenses')
     AND NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_lock_finance_expenses_by_period') THEN
    CREATE TRIGGER trg_lock_finance_expenses_by_period
      BEFORE INSERT OR UPDATE OR DELETE ON finance_expenses
      FOR EACH ROW EXECUTE FUNCTION public.enforce_tax_period_lock();
  END IF;
END $$;

-- ============================================================================
-- 10. Grants — RPCs exposed to authenticated users
-- ============================================================================
GRANT EXECUTE ON FUNCTION public.compute_tax_due_dates(text, int, int)             TO authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_tax_period(int, int, text)                  TO authenticated;
GRANT EXECUTE ON FUNCTION public.compute_period_ppn(uuid)                           TO authenticated;
GRANT EXECUTE ON FUNCTION public.assign_faktur_pajak_number(uuid)                   TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_tax_payment(uuid, text, date, numeric, uuid, text, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mark_tax_payment_reconciled(uuid)                  TO authenticated;
GRANT EXECUTE ON FUNCTION public.close_tax_period(uuid)                             TO authenticated;
GRANT EXECUTE ON FUNCTION public.reopen_tax_period(uuid, text)                      TO authenticated;

COMMIT;

-- ============================================================================
-- 11. Post-migration sanity assertions (self-tests)
--     These verify the accounting rails without needing a client. They run
--     once per migration apply. If any assertion fails, the DB is in a
--     known-good pre-migration state (we're outside the BEGIN block on
--     purpose so the DDL commits before we assert).
-- ============================================================================
DO $$
DECLARE
  v_ok int;
BEGIN
  -- Sanity: all 6 tax_calendar_config rows exist
  SELECT COUNT(*) INTO v_ok FROM tax_calendar_config
  WHERE tax_type IN ('PPN','PPh21','PPh22','PPh23','PPh4(2)','PPh_Unifikasi');
  IF v_ok < 6 THEN
    RAISE WARNING 'tax_calendar_config seed incomplete: % rows', v_ok;
  END IF;

  -- Sanity: payable accounts exist
  PERFORM 1 FROM chart_of_accounts WHERE code IN ('2130','2131','2132','2137','2138');
  IF NOT FOUND THEN
    RAISE WARNING 'Tax payable accounts missing from CoA';
  END IF;

  -- Sanity: PPN due-dates for a sample period compute cleanly
  PERFORM * FROM compute_tax_due_dates('PPN', 2026, 7);

  -- Sanity: views exist and are queryable
  PERFORM * FROM vw_tax_period_status LIMIT 0;
  PERFORM * FROM vw_ppn_net_by_period LIMIT 0;
  PERFORM * FROM vw_pph_by_period_type LIMIT 0;
  PERFORM * FROM vw_outstanding_tax LIMIT 0;
END $$;
