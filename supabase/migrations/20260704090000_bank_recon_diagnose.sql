/*
  # Bank Reconciliation — Automatic diagnostic RPC

  When BankReconciliationEnhanced renders a row that carries a typed FK
  (matched_fund_transfer_id / matched_expense_id / matched_receipt_id /
   matched_petty_cash_id / matched_entry_id) but the client-side batch fetch
  did not return the target document, we currently show "Linked (reference
  unresolved)". This is caused by one of:

    1. The target row has been deleted → dangling FK (should be impossible
       after the ON DELETE SET NULL FKs from 20260703180000, but a stale row
       could still exist from before that migration).
    2. The target row exists in a different company scope than the bsl's bank
       account → company_mismatch.
    3. The target row exists but RLS is masking it from the caller's role.

  This SECURITY DEFINER function inspects the target row directly (bypassing
  the caller's RLS), compares scopes, and returns a jsonb payload that names
  the exact root_cause. It is meant to be called as a best-effort background
  diagnostic from the client whenever an unresolved link is rendered.

  Read-only. No accounting/GL impact.
*/

CREATE OR REPLACE FUNCTION public.diagnose_bank_line_link(p_bank_line_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_bsl              bank_statement_lines%ROWTYPE;
  v_fk_type          text;
  v_fk_uuid          uuid;
  v_exists           boolean := false;
  v_target_row       jsonb;
  v_target_company   uuid;
  v_bsl_bank_company uuid;
  v_current_uid      uuid;
  v_current_role     text;
BEGIN
  v_current_uid := auth.uid();
  SELECT role INTO v_current_role FROM user_profiles WHERE id = v_current_uid;

  SELECT * INTO v_bsl FROM bank_statement_lines WHERE id = p_bank_line_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error','bank_statement_line not found','id',p_bank_line_id);
  END IF;

  -- Pick the first populated FK (priority mirrors display code).
  IF v_bsl.matched_fund_transfer_id IS NOT NULL THEN
    v_fk_type := 'fund_transfer'; v_fk_uuid := v_bsl.matched_fund_transfer_id;
  ELSIF v_bsl.matched_expense_id IS NOT NULL THEN
    v_fk_type := 'expense'; v_fk_uuid := v_bsl.matched_expense_id;
  ELSIF v_bsl.matched_receipt_id IS NOT NULL THEN
    v_fk_type := 'receipt'; v_fk_uuid := v_bsl.matched_receipt_id;
  ELSIF v_bsl.matched_petty_cash_id IS NOT NULL THEN
    v_fk_type := 'petty_cash'; v_fk_uuid := v_bsl.matched_petty_cash_id;
  ELSIF v_bsl.matched_entry_id IS NOT NULL THEN
    v_fk_type := 'journal_entry'; v_fk_uuid := v_bsl.matched_entry_id;
  ELSE
    RETURN jsonb_build_object(
      'bank_statement_line_id', v_bsl.id,
      'root_cause','no_fk_populated',
      'reconciliation_status', v_bsl.reconciliation_status,
      'notes', v_bsl.notes
    );
  END IF;

  -- Existence + target-side scope + soft-delete probe.
  IF v_fk_type = 'fund_transfer' THEN
    SELECT to_jsonb(t.*) INTO v_target_row FROM fund_transfers t WHERE t.id = v_fk_uuid;
  ELSIF v_fk_type = 'expense' THEN
    SELECT to_jsonb(t.*) INTO v_target_row FROM finance_expenses t WHERE t.id = v_fk_uuid;
  ELSIF v_fk_type = 'receipt' THEN
    SELECT to_jsonb(t.*) INTO v_target_row FROM receipt_vouchers t WHERE t.id = v_fk_uuid;
  ELSIF v_fk_type = 'petty_cash' THEN
    SELECT to_jsonb(t.*) INTO v_target_row FROM petty_cash_transactions t WHERE t.id = v_fk_uuid;
  ELSIF v_fk_type = 'journal_entry' THEN
    SELECT to_jsonb(t.*) INTO v_target_row FROM journal_entries t WHERE t.id = v_fk_uuid;
  END IF;
  v_exists := (v_target_row IS NOT NULL);

  -- Extract company_id if present (some tables have it, some don't).
  IF v_exists AND v_target_row ? 'company_id' THEN
    v_target_company := (v_target_row->>'company_id')::uuid;
  END IF;
  -- Best-effort bsl-side company: derive via bank_accounts.company_id if present.
  BEGIN
    SELECT ba.company_id INTO v_bsl_bank_company
      FROM bank_accounts ba WHERE ba.id = v_bsl.bank_account_id;
  EXCEPTION WHEN undefined_column THEN
    v_bsl_bank_company := NULL;
  END;

  RETURN jsonb_build_object(
    'bank_statement_line_id',  v_bsl.id,
    'fk_type',                 v_fk_type,
    'fk_uuid',                 v_fk_uuid,
    'exists_in_db',            v_exists,
    'target_row',              v_target_row,
    'target_company_id',       v_target_company,
    'bsl_bank_company_id',     v_bsl_bank_company,
    'company_match',           CASE
                                 WHEN v_target_company IS NULL OR v_bsl_bank_company IS NULL THEN NULL
                                 ELSE (v_target_company = v_bsl_bank_company)
                               END,
    'current_user_id',         v_current_uid,
    'current_role',            v_current_role,
    'reconciliation_status',   v_bsl.reconciliation_status,
    'root_cause',              CASE
                                 WHEN NOT v_exists                        THEN 'dangling_fk_target_deleted'
                                 WHEN v_target_company IS NOT NULL AND v_bsl_bank_company IS NOT NULL
                                      AND v_target_company <> v_bsl_bank_company THEN 'company_mismatch'
                                 ELSE 'rls_masks_target_for_current_role'
                               END
  );
END $$;

GRANT EXECUTE ON FUNCTION public.diagnose_bank_line_link(uuid) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.diagnose_bank_line_link(uuid) FROM anon;
