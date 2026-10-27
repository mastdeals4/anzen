-- ============================================================================
-- Reassert the canonical delete_tax_payment / update_tax_payment definitions.
-- ============================================================================
--
-- Fix 1 — Root cause:
--   bank_statement_lines does NOT have an updated_at column (noted in
--   20260714200000_receipt_voucher_delete_journal_cleanup.sql).
--   delete_tax_payment() at line ~402 and update_tax_payment() at line ~629
--   both write `updated_at = now()` to bank_statement_lines, causing
--   ERROR 42703: column "updated_at" of relation "bank_statement_lines" does
--   not exist. This aborts the entire delete/update transaction.
--
--   Fix: redefine both functions with the offending `updated_at = now()`
--   line removed from the bank_statement_lines UPDATE. All other logic is
--   identical. matched_at IS the authoritative recon timestamp (set by the
--   reconciliation UI, not by these functions), so no information is lost.
--
-- The migration ledger can contain the original fix while the live routine
-- body has drifted back to the older definition. This migration changes no
-- business rules; it restores the already-approved repository definitions.
-- Idempotent.
-- ============================================================================

BEGIN;

-- ============================================================================
-- Fix 1a: delete_tax_payment — remove bank_statement_lines.updated_at write
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

  -- Release bank_statement_lines matched to this payment.
  -- NOTE: bank_statement_lines has no updated_at column — do not write it.
  UPDATE public.bank_statement_lines
     SET matched_entry_id       = NULL,
         matched_tax_payment_id = NULL,
         reconciliation_status  = 'unmatched'
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

  -- Audit trail (best-effort — do not let audit failure abort the delete)
  BEGIN
    INSERT INTO public.audit_logs (table_name, record_id, action_type, old_values, new_values, user_id)
    VALUES (
      'tax_payments', p_id, 'delete',
      jsonb_build_object(
        'tax_period_id',   v_payment.tax_period_id,
        'tax_type',        v_payment.tax_type,
        'amount',          v_payment.amount,
        'payment_date',    v_payment.payment_date,
        'status',          v_payment.status,
        'file_urls',       v_file_urls
      ),
      NULL,
      auth.uid()
    );
  EXCEPTION WHEN OTHERS THEN
    NULL; -- audit failure must not abort the delete
  END;
END $$;

REVOKE ALL     ON FUNCTION public.delete_tax_payment(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.delete_tax_payment(uuid) FROM anon;
GRANT  EXECUTE ON FUNCTION public.delete_tax_payment(uuid) TO authenticated;

-- ============================================================================
-- Fix 1b: update_tax_payment — remove bank_statement_lines.updated_at write
--
-- Exact production body from 20260713160000 (RETURNS uuid, 5 optional params
-- with DEFAULT NULL, full admin/reconciled guard, full audit log).
-- Only change: removed `updated_at = now()` from the bank_statement_lines
-- UPDATE (line 628-629 in the original) — that column does not exist.
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

  -- Release bank recon matches before deleting the JEs.
  -- NOTE: bank_statement_lines has no updated_at column — do not write it.
  UPDATE bank_statement_lines
     SET matched_entry_id       = NULL,
         matched_tax_payment_id = NULL,
         reconciliation_status  = 'unmatched'
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

NOTIFY pgrst, 'reload schema';

COMMIT;
