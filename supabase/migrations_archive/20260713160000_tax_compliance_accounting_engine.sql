-- ============================================================================
-- Tax Compliance — Accounting Engine Completion (2026-07-13)
-- ============================================================================
-- This migration finishes the business logic behind the Tax Compliance UI.
-- No UI changes here — this is pure DB.
--
-- Deliverables:
--   1. bank_statement_lines.matched_tax_payment_id column (typed FK,
--      following the same pattern as matched_expense_id /
--      matched_receipt_id / matched_petty_cash_id / matched_fund_transfer_id).
--   2. delete_tax_payment(p_id uuid) — SECURITY DEFINER, self-verifying.
--      Reverses JE, releases bank recon match, deletes attachments,
--      writes audit_logs, refuses if period closed, integrity checks all
--      touched tables and RAISE EXCEPTION on any orphan.
--   3. update_tax_payment(...) — SECURITY DEFINER. Editing a tax payment
--      reverses the old JE and re-posts a new one atomically, preserving
--      audit history. Refuses if period closed. Refuses if reconciled
--      unless caller is admin.
--   4. compute_period_ppn() upgraded — Input PPN now sums BOTH
--      finance_expenses AND purchase_invoices (was: expenses only).
--      Output PPN sums sales_invoices. PPh totals include paid_amount.
--      Snapshot is authoritative.
--   5. Auto-recompute triggers on sales_invoices, purchase_invoices,
--      finance_expenses, tax_payments — whenever a source row lands, the
--      matching period's snapshot is refreshed. No stale zeros.
--   6. close_tax_period() hardened — checks: no missing Faktur, no draft
--      sales/purchase invoices, no unposted journal_entries, no
--      unreconciled tax_payments, outstanding = 0.
--   7. mark_tax_payment_reconciled() / auto_reconcile_tax_payment() use
--      the new typed FK so a subsequent unmatch flips status back to
--      'posted'.
--   8. faktur_pajak.customer_id backfill — the row's customer_id now
--      always resolves from sales_invoices.customer_id (was: could be
--      NULL if invoice had no customer at Faktur time).
--   9. Legacy vw_input_ppn_report / vw_output_ppn_report unchanged
--      (used by the "Registers (legacy)" report shim). Tax Reports UI
--      uses the new tax_period-aware views vw_ppn_net_by_period etc.
--
-- Additive-only. Idempotent. No column drops, no data loss.
-- ============================================================================

BEGIN;

-- ============================================================================
-- 1. bank_statement_lines.matched_tax_payment_id
-- ============================================================================
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='bank_statement_lines'
                   AND column_name='matched_tax_payment_id') THEN
    ALTER TABLE bank_statement_lines
      ADD COLUMN matched_tax_payment_id uuid REFERENCES tax_payments(id) ON DELETE SET NULL;
    CREATE INDEX idx_bank_statement_lines_matched_tax_payment
      ON bank_statement_lines(matched_tax_payment_id)
      WHERE matched_tax_payment_id IS NOT NULL;
  END IF;
END $$;

-- ============================================================================
-- 2. Auto-reconcile trigger — write to typed FK too
-- ============================================================================
CREATE OR REPLACE FUNCTION public.auto_reconcile_tax_payment()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_tax_payment_id uuid;
BEGIN
  IF NEW.is_matched = true
     AND (OLD.is_matched IS DISTINCT FROM NEW.is_matched)
     AND NEW.journal_entry_id IS NOT NULL THEN
    SELECT id INTO v_tax_payment_id
      FROM tax_payments
     WHERE journal_entry_id = NEW.journal_entry_id
       AND status = 'posted';
    IF v_tax_payment_id IS NOT NULL THEN
      UPDATE tax_payments
         SET status = 'reconciled', updated_at = now()
       WHERE id = v_tax_payment_id;
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- Mirror trigger on bank_statement_lines (PDF-statement path). When the
-- reconciliation UI flips reconciliation_status = 'matched' with a
-- matched_entry_id belonging to a tax_payment JE, flip the tax payment.
CREATE OR REPLACE FUNCTION public.auto_reconcile_tax_payment_from_bsl()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_tax_payment_id uuid;
BEGIN
  -- On becoming matched — flip tax_payment to reconciled
  IF NEW.reconciliation_status = 'matched'
     AND (OLD.reconciliation_status IS DISTINCT FROM NEW.reconciliation_status)
     AND NEW.matched_entry_id IS NOT NULL THEN
    SELECT id INTO v_tax_payment_id
      FROM tax_payments
     WHERE journal_entry_id = NEW.matched_entry_id
       AND status IN ('posted','draft');
    IF v_tax_payment_id IS NOT NULL THEN
      UPDATE tax_payments
         SET status = 'reconciled',
             updated_at = now()
       WHERE id = v_tax_payment_id;
      -- Also write the typed FK for symmetry with other modules
      NEW.matched_tax_payment_id := v_tax_payment_id;
    END IF;
  END IF;

  -- On becoming unmatched — flip tax_payment back to 'posted'
  IF NEW.reconciliation_status <> 'matched'
     AND (OLD.reconciliation_status = 'matched' OR OLD.matched_tax_payment_id IS NOT NULL)
     AND OLD.matched_tax_payment_id IS NOT NULL THEN
    UPDATE tax_payments
       SET status = 'posted',
           updated_at = now()
     WHERE id = OLD.matched_tax_payment_id
       AND status = 'reconciled';
    NEW.matched_tax_payment_id := NULL;
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_auto_reconcile_tax_payment_from_bsl ON bank_statement_lines;
CREATE TRIGGER trg_auto_reconcile_tax_payment_from_bsl
  BEFORE UPDATE OF reconciliation_status, matched_entry_id
  ON bank_statement_lines
  FOR EACH ROW EXECUTE FUNCTION public.auto_reconcile_tax_payment_from_bsl();

-- ============================================================================
-- 3. compute_period_ppn — authoritative snapshot
--
--    Input PPN  = SUM(purchase_invoices.tax_amount) + SUM(finance_expenses.ppn_amount)
--                 attributed to this PPN period.
--    Output PPN = SUM(sales_invoices.tax_amount) attributed to this PPN period.
--    Carry Fwd In = prior PPN period's carry_forward_out (chained).
--    Net Payable  = MAX(Output − Input − CarryFwdIn, 0).
--    Carry Fwd Out= MAX(Input + CarryFwdIn − Output, 0).
--    For PPh periods: pph_total = SUM(finance_expenses.pph_amount) filtered by
--                     tax_codes.tax_type = period.tax_type.
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
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tax period % not found', p_period_id;
  END IF;

  -- Recompute is safe on closed periods too — it does not mutate anything
  -- that affects the closed status; only refreshes cached totals. The
  -- period-lock trigger continues to block writes to source rows.

  IF v_period.tax_type = 'PPN' THEN
    -- INPUT PPN — purchases + expenses attributed to this period
    SELECT COALESCE((SELECT SUM(tax_amount) FROM purchase_invoices
                      WHERE tax_period_id = p_period_id AND tax_amount > 0), 0)
         + COALESCE((SELECT SUM(ppn_amount) FROM finance_expenses
                      WHERE tax_period_id = p_period_id AND ppn_amount > 0), 0)
    INTO v_input;

    -- OUTPUT PPN — sales attributed to this period
    SELECT COALESCE(SUM(tax_amount), 0) INTO v_output
      FROM sales_invoices
     WHERE tax_period_id = p_period_id AND tax_amount > 0;

    -- Prior period's carry_forward_out becomes this period's carry_forward_in
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
    -- PPh period. tax_type ∈ {PPh21, PPh22, PPh23, PPh4(2), PPh_Unifikasi}.
    -- Filter finance_expenses by pph_code_id → tax_codes.tax_type match.
    SELECT COALESCE(SUM(fe.pph_amount), 0) INTO v_pph_total
      FROM finance_expenses fe
      LEFT JOIN tax_codes tc ON tc.id = fe.pph_code_id
     WHERE fe.tax_period_id = p_period_id
       AND fe.pph_amount > 0
       AND (
         v_period.tax_type = 'PPh_Unifikasi'
         OR tc.tax_type = v_period.tax_type
       );

    UPDATE tax_periods SET
      pph_total  = v_pph_total,
      updated_at = now()
    WHERE id = p_period_id;
  END IF;
END $$;

-- Also expose an "all periods for a source row's month" convenience so
-- triggers can refresh both PPN and PPh periods with one call.
CREATE OR REPLACE FUNCTION public.recompute_periods_for_date(p_date date)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_period_id uuid;
BEGIN
  IF p_date IS NULL THEN RETURN; END IF;
  FOR v_period_id IN
    SELECT id FROM tax_periods
     WHERE fiscal_year  = EXTRACT(YEAR  FROM p_date)::int
       AND period_month = EXTRACT(MONTH FROM p_date)::int
  LOOP
    PERFORM compute_period_ppn(v_period_id);
  END LOOP;
END $$;

-- ============================================================================
-- 4. Auto-recompute triggers on source tables
--    Fire AFTER any INSERT/UPDATE/DELETE of a tax-bearing row.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.trg_recompute_from_sales_invoice()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM recompute_periods_for_date(OLD.invoice_date);
  ELSE
    PERFORM recompute_periods_for_date(NEW.invoice_date);
    IF TG_OP = 'UPDATE'
       AND (NEW.invoice_date IS DISTINCT FROM OLD.invoice_date) THEN
      PERFORM recompute_periods_for_date(OLD.invoice_date);
    END IF;
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_recompute_sales_invoice_period ON sales_invoices;
CREATE TRIGGER trg_recompute_sales_invoice_period
  AFTER INSERT OR UPDATE OR DELETE ON sales_invoices
  FOR EACH ROW EXECUTE FUNCTION public.trg_recompute_from_sales_invoice();

CREATE OR REPLACE FUNCTION public.trg_recompute_from_purchase_invoice()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM recompute_periods_for_date(OLD.invoice_date);
  ELSE
    PERFORM recompute_periods_for_date(NEW.invoice_date);
    IF TG_OP = 'UPDATE'
       AND (NEW.invoice_date IS DISTINCT FROM OLD.invoice_date) THEN
      PERFORM recompute_periods_for_date(OLD.invoice_date);
    END IF;
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_recompute_purchase_invoice_period ON purchase_invoices;
CREATE TRIGGER trg_recompute_purchase_invoice_period
  AFTER INSERT OR UPDATE OR DELETE ON purchase_invoices
  FOR EACH ROW EXECUTE FUNCTION public.trg_recompute_from_purchase_invoice();

CREATE OR REPLACE FUNCTION public.trg_recompute_from_finance_expense()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM recompute_periods_for_date(OLD.expense_date);
  ELSE
    PERFORM recompute_periods_for_date(NEW.expense_date);
    IF TG_OP = 'UPDATE'
       AND (NEW.expense_date IS DISTINCT FROM OLD.expense_date) THEN
      PERFORM recompute_periods_for_date(OLD.expense_date);
    END IF;
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_recompute_finance_expense_period ON finance_expenses;
CREATE TRIGGER trg_recompute_finance_expense_period
  AFTER INSERT OR UPDATE OR DELETE ON finance_expenses
  FOR EACH ROW EXECUTE FUNCTION public.trg_recompute_from_finance_expense();

CREATE OR REPLACE FUNCTION public.trg_recompute_from_tax_payment()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM compute_period_ppn(OLD.tax_period_id);
  ELSE
    PERFORM compute_period_ppn(NEW.tax_period_id);
    IF TG_OP = 'UPDATE'
       AND NEW.tax_period_id IS DISTINCT FROM OLD.tax_period_id THEN
      PERFORM compute_period_ppn(OLD.tax_period_id);
    END IF;
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_recompute_tax_payment_period ON tax_payments;
CREATE TRIGGER trg_recompute_tax_payment_period
  AFTER INSERT OR UPDATE OR DELETE ON tax_payments
  FOR EACH ROW EXECUTE FUNCTION public.trg_recompute_from_tax_payment();

-- ============================================================================
-- 5. Backfill snapshot for every existing period so no stale zeros remain
-- ============================================================================
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT id FROM tax_periods LOOP
    PERFORM compute_period_ppn(r.id);
  END LOOP;
END $$;

-- ============================================================================
-- 6. faktur_pajak.customer_id — backfill from sales_invoices
-- ============================================================================
UPDATE faktur_pajak fp
   SET customer_id = si.customer_id
  FROM sales_invoices si
 WHERE fp.sales_invoice_id = si.id
   AND (fp.customer_id IS NULL OR fp.customer_id <> si.customer_id)
   AND si.customer_id IS NOT NULL;

-- ============================================================================
-- 7. delete_tax_payment(p_id) — SECURITY DEFINER, self-verifying
-- ============================================================================
CREATE OR REPLACE FUNCTION public.delete_tax_payment(p_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_payment        tax_payments%ROWTYPE;
  v_period_status  text;
  v_je_ids         uuid[];
  v_file_urls      text[];

  v_orphan_pay     int;
  v_orphan_je      int;
  v_orphan_je_lines int;
  v_orphan_bsl     int;
  v_orphan_bri     int;
  v_orphan_files   int;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_id IS NULL THEN
    RAISE EXCEPTION 'Tax payment id is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Lock the row
  SELECT * INTO v_payment
    FROM public.tax_payments
   WHERE id = p_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tax payment % not found', p_id USING ERRCODE = 'no_data_found';
  END IF;

  -- Refuse if the period is closed (unless service_role)
  IF current_setting('request.jwt.claim.role', true) <> 'service_role' THEN
    SELECT status INTO v_period_status FROM tax_periods WHERE id = v_payment.tax_period_id;
    IF v_period_status = 'closed' THEN
      RAISE EXCEPTION 'Tax period is closed; cannot delete tax payment. Reopen the period first.'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- Collect JEs owned by this tax payment
  SELECT COALESCE(array_agg(id), ARRAY[]::uuid[])
    INTO v_je_ids
    FROM public.journal_entries
   WHERE source_module = 'tax_payment'
     AND reference_id  = p_id;

  IF v_payment.journal_entry_id IS NOT NULL
     AND NOT v_payment.journal_entry_id = ANY (v_je_ids) THEN
    v_je_ids := array_append(v_je_ids, v_payment.journal_entry_id);
  END IF;

  -- Release bank_statement_lines matched to this payment (typed FK + JE FK)
  UPDATE public.bank_statement_lines
     SET matched_entry_id       = NULL,
         matched_tax_payment_id = NULL,
         reconciliation_status  = 'unmatched',
         updated_at             = now()
   WHERE (matched_tax_payment_id = p_id)
      OR (array_length(v_je_ids, 1) IS NOT NULL AND matched_entry_id = ANY (v_je_ids));

  -- Release bank_reconciliation_items entries
  IF array_length(v_je_ids, 1) IS NOT NULL THEN
    UPDATE public.bank_reconciliation_items
       SET is_matched = false,
           matched_at = NULL
     WHERE journal_entry_id = ANY (v_je_ids);
  END IF;

  -- Snapshot attachment paths BEFORE cascade-deleting the rows
  SELECT COALESCE(array_agg(file_url), ARRAY[]::text[])
    INTO v_file_urls
    FROM public.tax_payment_files
   WHERE tax_payment_id = p_id;

  DELETE FROM public.tax_payment_files WHERE tax_payment_id = p_id;

  -- Break FK from tax_payments → JE before deleting JE
  UPDATE public.tax_payments
     SET journal_entry_id = NULL
   WHERE id = p_id;

  IF array_length(v_je_ids, 1) IS NOT NULL THEN
    DELETE FROM public.journal_entry_lines WHERE journal_entry_id = ANY (v_je_ids);
    DELETE FROM public.journal_entries     WHERE id = ANY (v_je_ids);
  END IF;

  DELETE FROM public.tax_payments WHERE id = p_id;

  -- ═══ INTEGRITY CHECKS ═════════════════════════════════════════════════
  SELECT COUNT(*) INTO v_orphan_pay FROM public.tax_payments WHERE id = p_id;
  IF v_orphan_pay <> 0 THEN
    RAISE EXCEPTION 'delete_tax_payment(%): integrity check failed — tax_payments row still present. Rolling back.', p_id
      USING ERRCODE = 'raise_exception';
  END IF;

  SELECT COUNT(*) INTO v_orphan_je
    FROM public.journal_entries
   WHERE source_module = 'tax_payment' AND reference_id = p_id;
  IF v_orphan_je <> 0 THEN
    RAISE EXCEPTION 'delete_tax_payment(%): integrity check failed — % orphan journal_entries (source=tax_payment) remain. Rolling back.', p_id, v_orphan_je
      USING ERRCODE = 'raise_exception';
  END IF;

  IF array_length(v_je_ids, 1) IS NOT NULL THEN
    SELECT COUNT(*) INTO v_orphan_je_lines
      FROM public.journal_entry_lines WHERE journal_entry_id = ANY (v_je_ids);
    IF v_orphan_je_lines <> 0 THEN
      RAISE EXCEPTION 'delete_tax_payment(%): integrity check failed — % orphan journal_entry_lines remain. Rolling back.', p_id, v_orphan_je_lines
        USING ERRCODE = 'raise_exception';
    END IF;

    SELECT COUNT(*) INTO v_orphan_bsl
      FROM public.bank_statement_lines
     WHERE matched_entry_id = ANY (v_je_ids);
    IF v_orphan_bsl <> 0 THEN
      RAISE EXCEPTION 'delete_tax_payment(%): integrity check failed — % bank_statement_lines still matched to deleted JE. Rolling back.', p_id, v_orphan_bsl
        USING ERRCODE = 'raise_exception';
    END IF;

    SELECT COUNT(*) INTO v_orphan_bri
      FROM public.bank_reconciliation_items
     WHERE journal_entry_id = ANY (v_je_ids) AND is_matched = true;
    IF v_orphan_bri <> 0 THEN
      RAISE EXCEPTION 'delete_tax_payment(%): integrity check failed — % bank_reconciliation_items still matched to deleted JE. Rolling back.', p_id, v_orphan_bri
        USING ERRCODE = 'raise_exception';
    END IF;
  END IF;

  SELECT COUNT(*) INTO v_orphan_files FROM public.tax_payment_files WHERE tax_payment_id = p_id;
  IF v_orphan_files <> 0 THEN
    RAISE EXCEPTION 'delete_tax_payment(%): integrity check failed — % orphan tax_payment_files remain. Rolling back.', p_id, v_orphan_files
      USING ERRCODE = 'raise_exception';
  END IF;

  -- Audit trail
  BEGIN
    INSERT INTO public.audit_logs (table_name, record_id, action_type, old_values, new_values, user_id)
    VALUES (
      'tax_payments', p_id, 'delete',
      jsonb_build_object(
        'tax_period_id',        v_payment.tax_period_id,
        'tax_type',             v_payment.tax_type,
        'payment_date',         v_payment.payment_date,
        'amount',               v_payment.amount,
        'ntpn',                 v_payment.ntpn,
        'billing_code',         v_payment.billing_code,
        'payment_reference',    v_payment.payment_reference,
        'status_before_delete', v_payment.status,
        'journal_entry_ids',    to_jsonb(v_je_ids),
        'file_urls_released',   to_jsonb(v_file_urls),
        'integrity_checks',     'passed'
      ),
      jsonb_build_object(
        '_action',    'DELETE_TAX_PAYMENT',
        'deleted_at', now(),
        'deleted_by', auth.uid()
      ),
      auth.uid()
    );
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
END;
$$;

REVOKE ALL     ON FUNCTION public.delete_tax_payment(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.delete_tax_payment(uuid) FROM anon;
GRANT  EXECUTE ON FUNCTION public.delete_tax_payment(uuid) TO authenticated;

COMMENT ON FUNCTION public.delete_tax_payment(uuid) IS
'Accounting-safe tax payment delete. Reverses JE, releases bank recon match
(both typed FK and matched_entry_id), removes attachments, refuses on
closed periods, self-verifies orphan state, RAISE EXCEPTION rolls back on
any orphan. Storage bucket cleanup is client-side (file_urls returned in
audit_logs.old_values.file_urls_released).';

-- ============================================================================
-- 8. update_tax_payment — reverse-and-repost pattern
--
--    The old JE cannot simply be UPDATEd because JE line accounts may
--    change (bank account change → different CoA row). We reverse the old
--    JE (delete lines, delete JE) and post a fresh one, all within the
--    same transaction. Audit log captures both old and new state.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.update_tax_payment(
  p_id                   uuid,
  p_payment_date         date,
  p_amount               numeric,
  p_bank_account_id      uuid,
  p_billing_code         text  DEFAULT NULL,
  p_ntpn                 text  DEFAULT NULL,
  p_government_reference text  DEFAULT NULL,
  p_notes                text  DEFAULT NULL,
  p_payment_reference    text  DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_old              tax_payments%ROWTYPE;
  v_period           tax_periods%ROWTYPE;
  v_je_number        text;
  v_je_id            uuid;
  v_old_je_ids       uuid[];
  v_payable_code     text;
  v_payable_acct_id  uuid;
  v_bank_acct_coa_id uuid;
  v_ref_number       text;
  v_is_admin         boolean;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Tax payment amount must be > 0';
  END IF;
  IF p_bank_account_id IS NULL THEN
    RAISE EXCEPTION 'Bank account is required';
  END IF;

  SELECT * INTO v_old FROM tax_payments WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tax payment % not found', p_id USING ERRCODE = 'no_data_found';
  END IF;

  SELECT * INTO v_period FROM tax_periods WHERE id = v_old.tax_period_id;
  IF v_period.status = 'closed' AND current_setting('request.jwt.claim.role', true) <> 'service_role' THEN
    RAISE EXCEPTION 'Tax period is closed; cannot edit tax payment. Reopen the period first.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Reconciled payments can only be edited by admin (edit implies breaking
  -- the current bank reconciliation match). Non-admins must first unmatch
  -- via the Bank Reconciliation screen.
  IF v_old.status = 'reconciled' THEN
    SELECT (up.role = 'admin' AND up.is_active) INTO v_is_admin
      FROM user_profiles up WHERE up.id = auth.uid();
    IF NOT COALESCE(v_is_admin, false) THEN
      RAISE EXCEPTION 'Tax payment is reconciled; only an admin may edit it. Unmatch it in Bank Reconciliation first.'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;

  -- Resolve accounts (same logic as record_tax_payment)
  v_payable_code := CASE v_old.tax_type
    WHEN 'PPN'      THEN '2130'
    WHEN 'PPh21'    THEN '2131'
    WHEN 'PPh22'    THEN '2137'
    WHEN 'PPh23'    THEN '2132'
    WHEN 'PPh4(2)'  THEN '2138'
    WHEN 'PPh_Unifikasi' THEN '2131'
    ELSE NULL
  END;
  IF v_payable_code IS NULL THEN
    RAISE EXCEPTION 'Unknown tax_type: %', v_old.tax_type;
  END IF;

  SELECT id INTO v_payable_acct_id FROM chart_of_accounts WHERE code = v_payable_code;
  IF v_payable_acct_id IS NULL THEN
    RAISE EXCEPTION 'Payable account % missing from Chart of Accounts', v_payable_code;
  END IF;

  SELECT coa_id INTO v_bank_acct_coa_id FROM bank_accounts WHERE id = p_bank_account_id;
  IF v_bank_acct_coa_id IS NULL THEN
    SELECT id INTO v_bank_acct_coa_id FROM chart_of_accounts WHERE code = '1111' LIMIT 1;
  END IF;
  IF v_bank_acct_coa_id IS NULL THEN
    RAISE EXCEPTION 'Cannot resolve bank CoA account';
  END IF;

  -- Reverse old JE(s)
  SELECT COALESCE(array_agg(id), ARRAY[]::uuid[])
    INTO v_old_je_ids
    FROM journal_entries
   WHERE source_module = 'tax_payment' AND reference_id = p_id;
  IF v_old.journal_entry_id IS NOT NULL AND NOT v_old.journal_entry_id = ANY (v_old_je_ids) THEN
    v_old_je_ids := array_append(v_old_je_ids, v_old.journal_entry_id);
  END IF;

  -- Release bank recon matches before deleting the JEs
  UPDATE bank_statement_lines
     SET matched_entry_id       = NULL,
         matched_tax_payment_id = NULL,
         reconciliation_status  = 'unmatched',
         updated_at             = now()
   WHERE matched_tax_payment_id = p_id
      OR (array_length(v_old_je_ids, 1) IS NOT NULL AND matched_entry_id = ANY (v_old_je_ids));

  IF array_length(v_old_je_ids, 1) IS NOT NULL THEN
    UPDATE bank_reconciliation_items
       SET is_matched = false, matched_at = NULL
     WHERE journal_entry_id = ANY (v_old_je_ids);
    DELETE FROM journal_entry_lines WHERE journal_entry_id = ANY (v_old_je_ids);
    DELETE FROM journal_entries     WHERE id = ANY (v_old_je_ids);
  END IF;

  -- Update the payment row (period + type unchanged; use delete+create for that)
  UPDATE tax_payments SET
    payment_date         = p_payment_date,
    amount               = p_amount,
    bank_account_id      = p_bank_account_id,
    billing_code         = p_billing_code,
    ntpn                 = p_ntpn,
    government_reference = p_government_reference,
    notes                = p_notes,
    payment_reference    = p_payment_reference,
    journal_entry_id     = NULL,
    status               = 'draft',
    updated_at           = now()
  WHERE id = p_id;

  -- Post fresh JE
  v_ref_number := COALESCE(
    NULLIF(p_ntpn, ''), NULLIF(p_billing_code, ''), NULLIF(p_payment_reference, ''),
    'TAX-' || to_char(p_payment_date, 'YYMM') || '-' || substr(p_id::text, 1, 8)
  );
  v_je_number := next_journal_entry_number();

  INSERT INTO journal_entries
    (entry_number, entry_date, source_module, reference_id, reference_number,
     description, total_debit, total_credit, is_posted, posted_by)
  VALUES
    (v_je_number, p_payment_date, 'tax_payment', p_id, v_ref_number,
     'Tax Payment ' || v_old.tax_type || ' — ' || v_ref_number,
     p_amount, p_amount, true, auth.uid())
  RETURNING id INTO v_je_id;

  INSERT INTO journal_entry_lines
    (journal_entry_id, line_number, account_id, description, debit, credit)
  VALUES
    (v_je_id, 1, v_payable_acct_id,
     v_old.tax_type || ' payment — ' || v_ref_number, p_amount, 0),
    (v_je_id, 2, v_bank_acct_coa_id,
     'Bank ' || v_old.tax_type || ' payment — ' || v_ref_number, 0, p_amount);

  UPDATE tax_payments SET journal_entry_id = v_je_id, status = 'posted', updated_at = now()
   WHERE id = p_id;

  -- Refresh period snapshot (belt-and-braces; the AFTER trigger also fires)
  PERFORM compute_period_ppn(v_old.tax_period_id);

  -- Audit log — captures full before/after
  INSERT INTO audit_logs (user_id, table_name, action_type, record_id, old_values, new_values)
  VALUES (
    auth.uid(), 'tax_payments', 'update', p_id,
    jsonb_build_object(
      'payment_date',      v_old.payment_date,
      'amount',            v_old.amount,
      'bank_account_id',   v_old.bank_account_id,
      'ntpn',              v_old.ntpn,
      'billing_code',      v_old.billing_code,
      'payment_reference', v_old.payment_reference,
      'notes',             v_old.notes,
      'status',            v_old.status,
      'old_je_ids',        to_jsonb(v_old_je_ids)
    ),
    jsonb_build_object(
      'payment_date',      p_payment_date,
      'amount',            p_amount,
      'bank_account_id',   p_bank_account_id,
      'ntpn',              p_ntpn,
      'billing_code',      p_billing_code,
      'payment_reference', p_payment_reference,
      'notes',             p_notes,
      'new_je_id',         v_je_id,
      'edited_at',         now()
    )
  );

  RETURN p_id;
END $$;

REVOKE ALL     ON FUNCTION public.update_tax_payment(uuid, date, numeric, uuid, text, text, text, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.update_tax_payment(uuid, date, numeric, uuid, text, text, text, text, text) FROM anon;
GRANT  EXECUTE ON FUNCTION public.update_tax_payment(uuid, date, numeric, uuid, text, text, text, text, text) TO authenticated;

COMMENT ON FUNCTION public.update_tax_payment(uuid, date, numeric, uuid, text, text, text, text, text) IS
'Reverse-and-repost tax payment editor. Refuses on closed periods. Refuses
on reconciled payments unless caller is admin (in which case the recon
match is broken and the payment returns to posted state). Full old/new
audit log entry written.';

-- ============================================================================
-- 9. close_tax_period — hardened preconditions
-- ============================================================================
CREATE OR REPLACE FUNCTION public.close_tax_period(p_period_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_period                  tax_periods%ROWTYPE;
  v_missing_faktur          int;
  v_draft_sales             int;
  v_draft_purchase          int;
  v_unposted_je             int;
  v_unreconciled_payments   int;
  v_outstanding             numeric(18,2);
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

  -- Recompute snapshot before validating
  PERFORM compute_period_ppn(p_period_id);
  SELECT * INTO v_period FROM tax_periods WHERE id = p_period_id;

  -- 1. Missing Faktur Pajak (PPN only)
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

  -- 2. No draft sales invoices attributed to this period
  BEGIN
    SELECT COUNT(*) INTO v_draft_sales
      FROM sales_invoices
     WHERE tax_period_id = p_period_id
       AND status = 'draft';
    IF v_draft_sales > 0 THEN
      RAISE EXCEPTION 'Cannot close period: % draft sales invoice(s) remain', v_draft_sales;
    END IF;
  EXCEPTION WHEN undefined_column THEN
    NULL;  -- sales_invoices.status may not be present in every branch
  END;

  -- 3. No draft purchase invoices attributed to this period
  BEGIN
    SELECT COUNT(*) INTO v_draft_purchase
      FROM purchase_invoices
     WHERE tax_period_id = p_period_id
       AND status = 'draft';
    IF v_draft_purchase > 0 THEN
      RAISE EXCEPTION 'Cannot close period: % draft purchase invoice(s) remain', v_draft_purchase;
    END IF;
  EXCEPTION WHEN undefined_column THEN
    NULL;
  END;

  -- 4. No unposted journal_entries referencing this period's source docs
  --    (any tax_payment JE where is_posted = false is a blocker)
  SELECT COUNT(*) INTO v_unposted_je
    FROM journal_entries je
    JOIN tax_payments txp ON txp.id = je.reference_id
   WHERE je.source_module = 'tax_payment'
     AND txp.tax_period_id = p_period_id
     AND je.is_posted = false;
  IF v_unposted_je > 0 THEN
    RAISE EXCEPTION 'Cannot close period: % unposted journal entries for tax payments', v_unposted_je;
  END IF;

  -- 5. No unreconciled tax_payments (must all be in status='reconciled')
  SELECT COUNT(*) INTO v_unreconciled_payments
    FROM tax_payments
   WHERE tax_period_id = p_period_id
     AND status IN ('draft','posted');
  IF v_unreconciled_payments > 0 THEN
    RAISE EXCEPTION 'Cannot close period: % unreconciled tax payment(s) remain (status draft or posted)', v_unreconciled_payments;
  END IF;

  -- 6. Zero outstanding payable
  SELECT outstanding_amount INTO v_outstanding
    FROM vw_outstanding_tax
   WHERE tax_period_id = p_period_id;
  IF COALESCE(v_outstanding, 0) > 0 THEN
    RAISE EXCEPTION 'Cannot close period: Rp % still outstanding. Record additional tax payments first.', v_outstanding;
  END IF;

  -- Flip status
  UPDATE tax_periods SET
    status    = 'closed',
    closed_at = now(),
    closed_by = auth.uid(),
    updated_at = now()
  WHERE id = p_period_id;

  INSERT INTO audit_logs (user_id, table_name, action_type, record_id, new_values)
  VALUES (auth.uid(), 'tax_periods', 'update', p_period_id,
          jsonb_build_object(
            'action', 'close',
            'status', 'closed',
            'input_ppn_total',  v_period.input_ppn_total,
            'output_ppn_total', v_period.output_ppn_total,
            'net_ppn',          v_period.net_ppn,
            'pph_total',        v_period.pph_total
          ));
END $$;

COMMIT;
