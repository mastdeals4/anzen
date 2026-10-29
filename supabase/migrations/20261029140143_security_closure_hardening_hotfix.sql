
BEGIN;

-- 1. Harden search_path on the functions identified by the live Supabase Security Advisor.
-- Include both overloads of calculate_batch_authoritative_cost and related COGS helpers.
DO $$
DECLARE
  v_sig text;
  v_proc regprocedure;
  v_sigs text[] := ARRAY[
    'public.fn_protect_enquiry_message_content()',
    'public.fn_crm_email_activities_dedup()',
    'public.recalculate_sales_invoice_payment_state(uuid)',
    'public.get_invoice_paid_amount(uuid)',
    'public.get_invoice_credit_note_amount(uuid)',
    'public.enforce_sales_invoice_write_scope()',
    'public.trg_sync_credit_note_invoice_payment()',
    'public.calculate_batch_authoritative_cost(public.batches)',
    'public.calculate_batch_authoritative_cost(uuid)',
    'public.effective_sales_cogs_unit_cost(uuid)',
    'public.cancel_payment_voucher_posting(uuid,uuid,text)',
    'public._sec_check_finance_role()',
    'public.trg_batch_inward_reconcile_shortages()',
    'public.trg_guard_credit_note_type_transition()',
    'public.trg_sync_nota_retur_linkages()',
    'public.generate_nota_retur_number(date)',
    'public.lookup_login_email(text)',
    'public.calculate_staff_bpjs(uuid,numeric,date)',
    'public.approve_finance_expense(uuid,uuid)',
    'public.cancel_sales_invoice(uuid,text,uuid)',
    'public.cancel_expense_posting(uuid,uuid,text)',
    'public.post_bpjs_monthly_register(uuid,uuid)'
  ];
BEGIN
  FOREACH v_sig IN ARRAY v_sigs LOOP
    v_proc := to_regprocedure(v_sig);
    IF v_proc IS NOT NULL THEN
      EXECUTE format('ALTER FUNCTION %s SET search_path = pg_catalog, public, pg_temp', v_proc);
    END IF;
  END LOOP;
END $$;

-- 2. Revoke anon/public execution on SECURITY DEFINER functions exposed to anon,
-- while preserving effective authenticated access for business RPCs.
-- Trigger-only/internal functions are revoked from authenticated too.
DO $$
DECLARE
  r record;
  v_fn text;
  v_internal boolean;
BEGIN
  FOR r IN
    SELECT p.oid,
           p.proname,
           has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_exec
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prosecdef
      AND has_function_privilege('anon', p.oid, 'EXECUTE')
      AND p.proname NOT IN ('lookup_login_email', 'is_setup_mode')
  LOOP
    v_fn := r.oid::regprocedure::text;
    v_internal := r.proname IN (
      'trg_release_so_product_reservation_status_v2',
      'trg_batch_inward_reconcile_shortages',
      'trg_guard_credit_note_type_transition',
      'trg_sync_credit_note_invoice_payment',
      'trg_sync_nota_retur_linkages',
      'trg_ensure_credit_note_number',
      'trg_credit_note_inventory_v1',
      'enforce_sales_invoice_write_scope',
      'invoke_sapj_gmail_agent',
      '_post_credit_note_je'
    );

    IF v_internal THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', v_fn);
    ELSE
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', v_fn);
      IF r.auth_exec THEN
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', v_fn);
      END IF;
    END IF;
  END LOOP;
END $$;

-- Explicitly lock down internal trigger/helper functions, regardless of their
-- current SECURITY DEFINER setting or inherited PUBLIC grants.
DO $$
DECLARE
  v_sig text;
  v_proc regprocedure;
  v_sigs text[] := ARRAY[
    'public.trg_release_so_product_reservation_status_v2()',
    'public.trg_batch_inward_reconcile_shortages()',
    'public.trg_guard_credit_note_type_transition()',
    'public.trg_sync_credit_note_invoice_payment()',
    'public.trg_sync_nota_retur_linkages()',
    'public.trg_ensure_credit_note_number()',
    'public.trg_credit_note_inventory_v1()',
    'public.enforce_sales_invoice_write_scope()',
    'public._post_credit_note_je(public.credit_notes)',
    'public.invoke_sapj_gmail_agent()'
  ];
BEGIN
  FOREACH v_sig IN ARRAY v_sigs LOOP
    v_proc := to_regprocedure(v_sig);
    IF v_proc IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', v_proc);
      IF v_sig = 'public.invoke_sapj_gmail_agent()' THEN
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', v_proc);
      END IF;
    END IF;
  END LOOP;
END $$;

-- Preserve the required pre-login username flow, but validate input and only
-- return an active matching account. Invalid input returns before querying profiles.
CREATE OR REPLACE FUNCTION public.lookup_login_email(p_username text)
RETURNS TABLE(email text, is_active boolean)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_clean_username text;
BEGIN
  v_clean_username := lower(trim(COALESCE(p_username, '')));
  IF v_clean_username = '' OR length(v_clean_username) > 100 THEN
    RETURN;
  END IF;

  IF v_clean_username !~ '^[a-z0-9._@+-]+$' THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT up.email, up.is_active
  FROM public.user_profiles AS up
  WHERE lower(trim(up.username)) = v_clean_username
    AND up.is_active = true
  LIMIT 1;
END;
$$;
REVOKE ALL ON FUNCTION public.lookup_login_email(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.lookup_login_email(text) TO anon, authenticated, service_role;

-- BPJS calculation exposes staff wages and identifiers. Keep the existing
-- response/calculation logic, but require the established finance-role check.
DO $$
DECLARE
  v_oid oid;
  v_def text;
  v_old text := E'BEGIN\n  SELECT * INTO v_staff FROM public.finance_staff_master WHERE id = p_staff_id;';
  v_new text := E'BEGIN\n  IF auth.role() IS DISTINCT FROM ''service_role'' THEN\n    PERFORM public._sec_check_finance_role();\n  END IF;\n  SELECT * INTO v_staff FROM public.finance_staff_master WHERE id = p_staff_id;';
BEGIN
  SELECT p.oid INTO v_oid
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname='calculate_staff_bpjs'
    AND pg_get_function_identity_arguments(p.oid) = 'p_staff_id uuid, p_wage_override numeric, p_period_date date'
  LIMIT 1;

  IF v_oid IS NOT NULL THEN
    v_def := pg_get_functiondef(v_oid);
    IF position(v_old IN v_def) > 0 THEN
      v_def := replace(v_def, v_old, v_new);
      EXECUTE v_def;
    ELSIF position('public._sec_check_finance_role()' IN v_def) = 0 THEN
      RAISE EXCEPTION 'Cannot safely harden calculate_staff_bpjs: expected body marker not found';
    END IF;
  END IF;
END $$;

-- Prevent direct anonymous sequence-number generation while keeping authenticated
-- application/trigger use of the existing function.
DO $$
DECLARE v_proc regprocedure;
BEGIN
  v_proc := to_regprocedure('public.generate_nota_retur_number(date)');
  IF v_proc IS NOT NULL THEN
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', v_proc);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', v_proc);
  END IF;
END $$;

-- 3. Fix function authorization bypasses by editing only the security checks in
-- the live definitions, preserving their existing accounting/reversal logic.
DO $$
DECLARE
  v_oid oid;
  v_def text;
  v_old text;
  v_new text;
BEGIN
  -- approve_finance_expense: do not trust p_approved_by from an authenticated caller.
  SELECT p.oid INTO v_oid FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname='approve_finance_expense'
    AND pg_get_function_identity_arguments(p.oid)='p_expense_id uuid, p_approved_by uuid'
  LIMIT 1;
  IF v_oid IS NOT NULL THEN
    v_def := pg_get_functiondef(v_oid);
    v_old := 'approved_by=COALESCE(p_approved_by,auth.uid())';
    v_new := 'approved_by=CASE WHEN auth.role() = ''service_role'' THEN COALESCE(p_approved_by,auth.uid()) ELSE auth.uid() END';
    IF position(v_old IN v_def)>0 THEN
      EXECUTE replace(v_def,v_old,v_new);
    ELSIF position('approved_by=CASE WHEN auth.role()' IN v_def)=0 THEN
      RAISE EXCEPTION 'Cannot safely harden approve_finance_expense: expected approver assignment not found';
    END IF;
  END IF;

  -- cancel_sales_invoice: never permit an anonymous caller to impersonate p_actor.
  SELECT p.oid INTO v_oid FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname='cancel_sales_invoice'
    AND pg_get_function_identity_arguments(p.oid)='p_invoice_id uuid, p_reason text, p_actor uuid'
  LIMIT 1;
  IF v_oid IS NOT NULL THEN
    v_def := pg_get_functiondef(v_oid);
    v_old := 'v_caller uuid := COALESCE(auth.uid(), p_actor);';
    v_new := 'v_caller uuid := CASE WHEN auth.role() = ''service_role'' THEN COALESCE(p_actor, auth.uid()) ELSE auth.uid() END;';
    IF position(v_old IN v_def)>0 THEN
      v_def := replace(v_def,v_old,v_new);
    ELSIF position('v_caller uuid := CASE WHEN auth.role()' IN v_def)=0 THEN
      RAISE EXCEPTION 'Cannot safely harden cancel_sales_invoice: expected caller assignment not found';
    END IF;

    v_old := E'  -- Permission check: only admin and accounts can cancel financially posted invoices\n  IF v_caller IS NOT NULL THEN\n    SELECT role INTO v_role FROM public.user_profiles WHERE id = v_caller;\n    IF v_role NOT IN (''admin'', ''accounts'') THEN\n      RAISE EXCEPTION ''Permission denied: role % cannot cancel sales invoices'', v_role;\n    END IF;\n  END IF;';
    v_new := E'  -- Enforce authenticated identity and active-role authorization; service_role is trusted.\n  IF auth.role() IS DISTINCT FROM ''service_role'' THEN\n    IF v_caller IS NULL THEN\n      RAISE EXCEPTION ''Not authenticated'';\n    END IF;\n    SELECT role INTO v_role FROM public.user_profiles WHERE id = v_caller AND is_active = true;\n    IF COALESCE(v_role, '''') NOT IN (''admin'', ''accounts'') THEN\n      RAISE EXCEPTION ''Permission denied: role % cannot cancel sales invoices'', COALESCE(v_role, ''unknown'');\n    END IF;\n  END IF;';
    IF position(v_old IN v_def)>0 THEN
      v_def := replace(v_def,v_old,v_new);
    ELSIF position('Enforce authenticated identity and active-role authorization' IN v_def)=0 THEN
      RAISE EXCEPTION 'Cannot safely harden cancel_sales_invoice: expected authorization block not found';
    END IF;
    EXECUTE v_def;
  END IF;

  -- cancel_payment_voucher_posting: keep existing adjustment cleanup and GL reversal,
  -- add finance-role authorization and bind the caller ID to auth.uid().
  SELECT p.oid INTO v_oid FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname='cancel_payment_voucher_posting'
    AND pg_get_function_identity_arguments(p.oid)='p_pv_id uuid, p_cancelled_by uuid, p_reason text'
  LIMIT 1;
  IF v_oid IS NOT NULL THEN
    v_def := pg_get_functiondef(v_oid);
    v_old := E'  IF auth.uid() IS NULL THEN\n    RAISE EXCEPTION ''Not authenticated'';\n  END IF;\n\n  SELECT * INTO v_pv FROM payment_vouchers';
    v_new := E'  IF auth.uid() IS NULL THEN\n    RAISE EXCEPTION ''Not authenticated'';\n  END IF;\n  PERFORM public._sec_check_finance_role();\n  IF p_cancelled_by IS DISTINCT FROM auth.uid() THEN\n    RAISE EXCEPTION ''Cancelled-by identity must match the authenticated user'';\n  END IF;\n\n  SELECT * INTO v_pv FROM payment_vouchers';
    IF position(v_old IN v_def)>0 THEN
      v_def := replace(v_def,v_old,v_new);
    ELSIF position('Cancelled-by identity must match the authenticated user' IN v_def)=0 THEN
      RAISE EXCEPTION 'Cannot safely harden cancel_payment_voucher_posting: expected auth block not found';
    END IF;
    EXECUTE v_def;
  END IF;

  -- cancel_expense_posting: preserve its full journal reversal/settlement guards,
  -- add finance-role authorization after its caller identity check.
  SELECT p.oid INTO v_oid FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname='cancel_expense_posting'
    AND pg_get_function_identity_arguments(p.oid)='p_exp_id uuid, p_cancelled_by uuid, p_reason text'
  LIMIT 1;
  IF v_oid IS NOT NULL THEN
    v_def := pg_get_functiondef(v_oid);
    v_old := E'  IF p_cancelled_by IS NULL OR p_cancelled_by <> auth.uid() THEN\n    RAISE EXCEPTION ''Cancelled-by identity must match the authenticated user'';\n  END IF;\n';
    v_new := v_old || E'  PERFORM public._sec_check_finance_role();\n';
    IF position(v_old IN v_def)>0 THEN
      v_def := replace(v_def,v_old,v_new);
    ELSIF position('PERFORM public._sec_check_finance_role();' IN v_def)=0 THEN
      RAISE EXCEPTION 'Cannot safely harden cancel_expense_posting: expected actor validation not found';
    END IF;
    EXECUTE v_def;
  END IF;

  -- post_bpjs_monthly_register: use auth.uid() for authenticated callers; only
  -- trusted service_role may use an explicitly supplied actor ID.
  SELECT p.oid INTO v_oid FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname='post_bpjs_monthly_register'
    AND pg_get_function_identity_arguments(p.oid)='p_register_id uuid, p_user_id uuid'
  LIMIT 1;
  IF v_oid IS NOT NULL THEN
    v_def := pg_get_functiondef(v_oid);
    v_old := 'v_user := COALESCE(p_user_id, auth.uid());';
    v_new := 'v_user := CASE WHEN auth.role() = ''service_role'' THEN COALESCE(p_user_id, auth.uid()) ELSE auth.uid() END;';
    IF position(v_old IN v_def)>0 THEN
      v_def := replace(v_def,v_old,v_new);
    ELSIF position('v_user := CASE WHEN auth.role()' IN v_def)=0 THEN
      RAISE EXCEPTION 'Cannot safely harden post_bpjs_monthly_register: expected actor assignment not found';
    END IF;
    EXECUTE v_def;
  END IF;
END $$;

-- 4. Lock down sensitive tables: remove PUBLIC/anon grants, strip dangerous
-- maintenance privileges from authenticated, and enforce RLS without changing
-- existing application-role CRUD grants or policies.
DO $$
DECLARE
  v_table text;
  v_tables text[] := ARRAY[
    'credit_notes','credit_note_items',
    'sales_invoices','sales_invoice_items',
    'delivery_challans','delivery_challan_items',
    'finance_expenses','payment_vouchers','receipt_vouchers',
    'journal_entries','journal_entry_lines',
    'bank_accounts','bank_statement_lines','bank_statement_allocations',
    'bpjs_monthly_registers','bpjs_monthly_register_items',
    'staff_master','finance_staff_master','user_profiles'
  ];
BEGIN
  FOREACH v_table IN ARRAY v_tables LOOP
    IF EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname=v_table AND c.relkind IN ('r','p')
    ) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon', v_table);
      EXECUTE format('REVOKE TRUNCATE, TRIGGER, REFERENCES ON TABLE public.%I FROM authenticated', v_table);
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', v_table);
      EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', v_table);
    END IF;
  END LOOP;
END $$;

-- 5. pg_net is used by trusted background workers. Do not move/reinstall it.
-- Prevent clients from invoking outbound HTTP jobs directly through SQL.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname='net') THEN
    REVOKE ALL ON SCHEMA net FROM PUBLIC, anon, authenticated;
    REVOKE ALL ON ALL FUNCTIONS IN SCHEMA net FROM PUBLIC, anon, authenticated;
    GRANT USAGE ON SCHEMA net TO service_role;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA net TO service_role;
  END IF;
END $$;

-- Prevent direct client use of the Nota Retur sequence.
DO $$
BEGIN
  IF to_regclass('public.nota_retur_number_seq') IS NOT NULL THEN
    REVOKE ALL ON SEQUENCE public.nota_retur_number_seq FROM PUBLIC, anon, authenticated;
    GRANT USAGE, SELECT ON SEQUENCE public.nota_retur_number_seq TO service_role;
  END IF;
END $$;

COMMIT;
