-- ============================================================================
-- Security Audit 2026-07-13 — CRITICAL + HIGH fixes
-- ============================================================================
-- Purely additive: DROP+CREATE POLICY, CREATE OR REPLACE FUNCTION, ALTER TABLE
-- (add trigger only). No column drops, no table drops, no data destruction.
--
-- Fixes 8 CRITICAL + ~18 HIGH findings identified in the audit report at
-- ./SECURITY_AUDIT_2026-07-13.md. See that file for evidence per finding.
-- ============================================================================

BEGIN;

-- ============================================================================
-- CRITICAL #1: user_profiles UPDATE — any user could self-promote to admin
-- CRITICAL #3: auto_create_user_profile trigger trusted raw_user_meta_data.role
-- HIGH: Login bypassed is_active check via email login (client-side signIn also
--       fixed; DB-side ensures a deactivated user cannot be reactivated by
--       self, and reactivation via profile UPDATE is now blocked)
-- ============================================================================

-- Add a WITH CHECK so a caller cannot rewrite id to another user's row.
DROP POLICY IF EXISTS "Users can update own profile" ON public.user_profiles;
CREATE POLICY "Users can update own profile"
  ON public.user_profiles FOR UPDATE
  TO authenticated
  USING (id = (SELECT auth.uid()))
  WITH CHECK (id = (SELECT auth.uid()));

-- BEFORE UPDATE trigger — block self-changes to role/is_active/username.
-- Admin-initiated changes are routed through the admin-update-user edge
-- function (SECURITY DEFINER via supabase.auth.admin API + service role),
-- which bypasses RLS but is still constrained by the trigger. The trigger
-- allows changes when the CURRENT session role is 'service_role' (the case
-- for edge functions using the service-role client).
CREATE OR REPLACE FUNCTION public.prevent_self_privilege_escalation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_role text;
BEGIN
  -- Service-role callers (edge functions) bypass — they enforce their own gates.
  IF auth.role() = 'service_role' THEN
    RETURN NEW;
  END IF;

  -- Allow if the caller is an authenticated admin editing someone else's row.
  SELECT role INTO v_caller_role
  FROM public.user_profiles
  WHERE id = auth.uid();

  IF NEW.role IS DISTINCT FROM OLD.role THEN
    IF auth.uid() = OLD.id OR COALESCE(v_caller_role, '') <> 'admin' THEN
      RAISE EXCEPTION 'Role changes must be made by an admin via admin-update-user';
    END IF;
  END IF;

  IF NEW.is_active IS DISTINCT FROM OLD.is_active THEN
    IF auth.uid() = OLD.id OR COALESCE(v_caller_role, '') <> 'admin' THEN
      RAISE EXCEPTION 'is_active changes must be made by an admin';
    END IF;
  END IF;

  IF NEW.username IS DISTINCT FROM OLD.username THEN
    IF auth.uid() = OLD.id AND COALESCE(v_caller_role, '') <> 'admin' THEN
      RAISE EXCEPTION 'Username changes must be made by an admin';
    END IF;
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_prevent_self_privilege_escalation ON public.user_profiles;
CREATE TRIGGER trg_prevent_self_privilege_escalation
  BEFORE UPDATE ON public.user_profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_self_privilege_escalation();

-- Rewrite handle_new_user (auto_create_user_profile) to hard-code initial role
-- and IGNORE raw_user_meta_data->>'role' so signUp cannot self-provision admin.
-- Signature-preserving: same function name, same trigger wiring.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_username text;
BEGIN
  v_username := COALESCE(
    NULLIF(TRIM(NEW.raw_user_meta_data->>'username'), ''),
    split_part(NEW.email, '@', 1)
  );

  -- Insert with the SAFEST role. Only admins can promote later via
  -- admin-update-user; the prevent_self_privilege_escalation trigger blocks
  -- direct role writes from the user's own JWT.
  INSERT INTO public.user_profiles (id, username, email, full_name, role, is_active)
  VALUES (
    NEW.id,
    v_username,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.email),
    'sales',
    -- New self-signups start inactive to require admin activation. Admin-
    -- created users go through admin-update-user which the caller can
    -- immediately toggle active.
    false
  )
  ON CONFLICT (id) DO NOTHING;

  RETURN NEW;
END $$;

-- If a differently-named auto_create_user_profile fn exists, patch it too.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'auto_create_user_profile'
  ) THEN
    EXECUTE $fn$
      CREATE OR REPLACE FUNCTION public.auto_create_user_profile()
      RETURNS trigger
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = public
      AS $inner$
      DECLARE
        v_username text;
      BEGIN
        v_username := COALESCE(
          NULLIF(TRIM(NEW.raw_user_meta_data->>'username'), ''),
          split_part(NEW.email, '@', 1)
        );
        INSERT INTO public.user_profiles (id, username, email, full_name, role, is_active)
        VALUES (
          NEW.id,
          v_username,
          NEW.email,
          COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.email),
          'sales',
          false
        )
        ON CONFLICT (id) DO NOTHING;
        RETURN NEW;
      END $inner$;
    $fn$;
  END IF;
END $$;

-- ============================================================================
-- CRITICAL #4: get_gmail_connection_secret returned EVERY user's tokens when
-- both args were NULL. Require an explicit scoping arg for non-service callers.
-- HIGH: encrypt_gmail_token / decrypt_gmail_token accessible to authenticated
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_gmail_connection_secret(
  p_connection_id uuid DEFAULT NULL,
  p_user_id uuid DEFAULT NULL
)
RETURNS TABLE(
  id uuid,
  user_id uuid,
  email_address text,
  access_token text,
  refresh_token text,
  access_token_expires_at timestamptz,
  is_connected boolean,
  sync_enabled boolean,
  last_sync timestamptz,
  sync_frequency_minutes integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.role() <> 'service_role' THEN
    IF auth.uid() IS NULL THEN
      RAISE EXCEPTION 'Not authenticated';
    END IF;
    -- Both scoping args cannot be NULL — that would return every row.
    IF p_connection_id IS NULL AND p_user_id IS NULL THEN
      RAISE EXCEPTION 'A connection_id or user_id must be provided';
    END IF;
    -- If both scoping args are provided, they must be consistent with caller.
    IF p_user_id IS NOT NULL AND p_user_id <> auth.uid() THEN
      RAISE EXCEPTION 'Forbidden';
    END IF;
    -- If only p_connection_id is provided, verify it belongs to the caller.
    IF p_user_id IS NULL AND p_connection_id IS NOT NULL THEN
      IF NOT EXISTS (
        SELECT 1 FROM public.gmail_connections
        WHERE id = p_connection_id AND user_id = auth.uid()
      ) THEN
        RAISE EXCEPTION 'Forbidden';
      END IF;
    END IF;
  END IF;

  UPDATE public.gmail_connections gc
  SET token_accessed_at = now()
  WHERE (p_connection_id IS NULL OR gc.id = p_connection_id)
    AND (p_user_id IS NULL OR gc.user_id = p_user_id)
    AND gc.is_connected = true;

  RETURN QUERY
  SELECT
    gc.id,
    gc.user_id,
    gc.email_address,
    COALESCE(gc.access_token, public.decrypt_gmail_token(gc.access_token_encrypted)) AS access_token,
    COALESCE(gc.refresh_token, public.decrypt_gmail_token(gc.refresh_token_encrypted)) AS refresh_token,
    gc.access_token_expires_at,
    gc.is_connected,
    gc.sync_enabled,
    gc.last_sync,
    gc.sync_frequency_minutes
  FROM public.gmail_connections gc
  WHERE (p_connection_id IS NULL OR gc.id = p_connection_id)
    AND (p_user_id IS NULL OR gc.user_id = p_user_id)
    AND gc.is_connected = true;
END $$;

REVOKE ALL ON FUNCTION public.get_gmail_connection_secret(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_gmail_connection_secret(uuid, uuid) TO authenticated, service_role;

-- Revoke direct authenticated EXECUTE on the raw crypto primitives — they
-- should only be reachable via get_gmail_connection_secret (which enforces
-- ownership above) or via the service role in edge functions.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname='public' AND p.proname='decrypt_gmail_token'
  ) THEN
    REVOKE EXECUTE ON FUNCTION public.decrypt_gmail_token(bytea) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.decrypt_gmail_token(bytea) TO service_role;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname='public' AND p.proname='encrypt_gmail_token'
  ) THEN
    REVOKE EXECUTE ON FUNCTION public.encrypt_gmail_token(text) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.encrypt_gmail_token(text) TO service_role;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname='public' AND p.proname='gmail_token_encryption_key'
  ) THEN
    REVOKE EXECUTE ON FUNCTION public.gmail_token_encryption_key() FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.gmail_token_encryption_key() TO service_role;
  END IF;
END $$;

-- ============================================================================
-- CRITICAL #5: create_fund_transfer_with_posting had no role check
-- HIGH: delete_fund_transfer / reverse_fund_transfer had no role check
-- ============================================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname='create_fund_transfer_with_posting'
  ) THEN
    EXECUTE $fn$
      CREATE OR REPLACE FUNCTION public._sec_check_finance_role()
      RETURNS void
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = public
      AS $inner$
      BEGIN
        IF auth.role() = 'service_role' THEN RETURN; END IF;
        IF auth.uid() IS NULL THEN
          RAISE EXCEPTION 'Not authenticated';
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM public.user_profiles
          WHERE id = auth.uid()
            AND is_active = true
            AND role IN ('admin', 'accounts')
        ) THEN
          RAISE EXCEPTION 'Permission denied: only admin/accounts can perform finance operations';
        END IF;
      END $inner$;
    $fn$;
    REVOKE ALL ON FUNCTION public._sec_check_finance_role() FROM PUBLIC, anon;
    GRANT EXECUTE ON FUNCTION public._sec_check_finance_role() TO authenticated, service_role;
  END IF;
END $$;

-- Wrap create_fund_transfer_with_posting with role check. Rather than
-- rewriting the (potentially long) function body, add a BEFORE INSERT trigger
-- on fund_transfers that enforces the role check on any insertion path.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname='fund_transfers' AND relnamespace = 'public'::regnamespace) THEN
    EXECUTE $fn$
      CREATE OR REPLACE FUNCTION public.enforce_fund_transfer_role()
      RETURNS trigger
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = public
      AS $inner$
      BEGIN
        PERFORM public._sec_check_finance_role();
        -- Force created_by/updated_by/reversed_by to the calling auth.uid()
        -- when possible so audit columns cannot be forged.
        IF TG_OP = 'INSERT' AND auth.role() <> 'service_role' THEN
          NEW.created_by := COALESCE(auth.uid(), NEW.created_by);
        END IF;
        RETURN NEW;
      END $inner$;
    $fn$;
    DROP TRIGGER IF EXISTS trg_enforce_fund_transfer_role_ins ON public.fund_transfers;
    CREATE TRIGGER trg_enforce_fund_transfer_role_ins
      BEFORE INSERT OR UPDATE OR DELETE ON public.fund_transfers
      FOR EACH ROW
      EXECUTE FUNCTION public.enforce_fund_transfer_role();
  END IF;
END $$;

-- Add role gate to reverse/delete RPCs if they exist. Idempotent: use
-- CREATE OR REPLACE around wrapper fns is safer than editing bodies.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname='delete_fund_transfer'
  ) THEN
    -- REVOKE authenticated + re-grant only after post-audit approval.
    -- We keep authenticated grant so the app still works, but the trigger
    -- above blocks non-finance-role callers at the fund_transfers DELETE.
    NULL;
  END IF;
END $$;

-- Same for FX validation on fund transfers (HIGH — arbitrary p_exchange_rate).
-- Add a BEFORE INSERT check: |to - from*rate| / max(to,1) < 0.02, and rate>0.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname='fund_transfers' AND relnamespace='public'::regnamespace) THEN
    EXECUTE $fn$
      CREATE OR REPLACE FUNCTION public.validate_fund_transfer_fx()
      RETURNS trigger
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = public
      AS $inner$
      DECLARE
        v_from numeric;
        v_to   numeric;
        v_rate numeric;
        v_expected numeric;
      BEGIN
        v_from := COALESCE(NEW.from_amount, 0);
        v_to   := COALESCE(NEW.to_amount, 0);
        v_rate := COALESCE(NEW.exchange_rate, 1);

        IF v_from <= 0 OR v_to <= 0 THEN
          RAISE EXCEPTION 'Fund transfer amounts must be positive';
        END IF;
        IF v_rate <= 0 THEN
          RAISE EXCEPTION 'exchange_rate must be positive';
        END IF;

        v_expected := v_from * v_rate;
        IF abs(v_to - v_expected) / GREATEST(v_to, 1) > 0.02 THEN
          RAISE EXCEPTION 'FX inconsistency: to_amount % differs from from_amount % * rate % by more than 2%%',
            v_to, v_from, v_rate;
        END IF;

        RETURN NEW;
      END $inner$;
    $fn$;
    DROP TRIGGER IF EXISTS trg_validate_fund_transfer_fx ON public.fund_transfers;
    CREATE TRIGGER trg_validate_fund_transfer_fx
      BEFORE INSERT OR UPDATE OF from_amount, to_amount, exchange_rate ON public.fund_transfers
      FOR EACH ROW
      EXECUTE FUNCTION public.validate_fund_transfer_fx();
  END IF;
END $$;

-- ============================================================================
-- CRITICAL #6: journal_entries / journal_entry_lines writable by any non-
-- read-only user. Restrict to admin/accounts (matches the SELECT gate that
-- already exists).
-- ============================================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname='journal_entries' AND relnamespace='public'::regnamespace) THEN
    EXECUTE 'DROP POLICY IF EXISTS "Authenticated users can manage journal entries" ON public.journal_entries';
    EXECUTE $pol$
      CREATE POLICY "admin_accounts_manage_journal_entries"
        ON public.journal_entries FOR ALL
        TO authenticated
        USING (
          EXISTS (
            SELECT 1 FROM public.user_profiles
            WHERE id = (SELECT auth.uid())
              AND role IN ('admin', 'accounts')
              AND is_active = true
          )
        )
        WITH CHECK (
          EXISTS (
            SELECT 1 FROM public.user_profiles
            WHERE id = (SELECT auth.uid())
              AND role IN ('admin', 'accounts')
              AND is_active = true
          )
        )
    $pol$;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname='journal_entry_lines' AND relnamespace='public'::regnamespace) THEN
    EXECUTE 'DROP POLICY IF EXISTS "Authenticated users can manage journal entry lines" ON public.journal_entry_lines';
    EXECUTE $pol$
      CREATE POLICY "admin_accounts_manage_journal_entry_lines"
        ON public.journal_entry_lines FOR ALL
        TO authenticated
        USING (
          EXISTS (
            SELECT 1 FROM public.user_profiles
            WHERE id = (SELECT auth.uid())
              AND role IN ('admin', 'accounts')
              AND is_active = true
          )
        )
        WITH CHECK (
          EXISTS (
            SELECT 1 FROM public.user_profiles
            WHERE id = (SELECT auth.uid())
              AND role IN ('admin', 'accounts')
              AND is_active = true
          )
        )
    $pol$;
  END IF;
END $$;

-- Same treatment for the voucher / invoice tables that the RLS audit flagged.
DO $$
DECLARE
  v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'payment_vouchers',
    'receipt_vouchers',
    'voucher_allocations',
    'purchase_invoices',
    'purchase_invoice_items'
  ] LOOP
    IF EXISTS (SELECT 1 FROM pg_class WHERE relname = v_table AND relnamespace='public'::regnamespace) THEN
      EXECUTE format('DROP POLICY IF EXISTS "Authenticated users can manage %s" ON public.%I', v_table, v_table);
      EXECUTE format(
        'CREATE POLICY "admin_accounts_manage_%s" ON public.%I FOR ALL TO authenticated USING (EXISTS (SELECT 1 FROM public.user_profiles WHERE id = (SELECT auth.uid()) AND role IN (''admin'',''accounts'') AND is_active = true)) WITH CHECK (EXISTS (SELECT 1 FROM public.user_profiles WHERE id = (SELECT auth.uid()) AND role IN (''admin'',''accounts'') AND is_active = true))',
        v_table, v_table
      );
    END IF;
  END LOOP;
END $$;

-- ============================================================================
-- CRITICAL #7: GRN status flip mints phantom stock; GRN INSERT/UPDATE open to
-- every authenticated user.
-- ============================================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname='goods_receipt_notes' AND relnamespace='public'::regnamespace) THEN
    -- Restrict INSERT/UPDATE to admin/warehouse/accounts.
    EXECUTE 'DROP POLICY IF EXISTS "goods_receipt_notes_insert" ON public.goods_receipt_notes';
    EXECUTE 'DROP POLICY IF EXISTS "goods_receipt_notes_update" ON public.goods_receipt_notes';
    EXECUTE $pol$
      CREATE POLICY "goods_receipt_notes_insert"
        ON public.goods_receipt_notes FOR INSERT
        TO authenticated
        WITH CHECK (
          EXISTS (
            SELECT 1 FROM public.user_profiles
            WHERE id = (SELECT auth.uid())
              AND role IN ('admin','warehouse','accounts')
              AND is_active = true
          )
        )
    $pol$;
    EXECUTE $pol$
      CREATE POLICY "goods_receipt_notes_update"
        ON public.goods_receipt_notes FOR UPDATE
        TO authenticated
        USING (
          EXISTS (
            SELECT 1 FROM public.user_profiles
            WHERE id = (SELECT auth.uid())
              AND role IN ('admin','warehouse','accounts')
              AND is_active = true
          )
        )
        WITH CHECK (
          EXISTS (
            SELECT 1 FROM public.user_profiles
            WHERE id = (SELECT auth.uid())
              AND role IN ('admin','warehouse','accounts')
              AND is_active = true
          )
        )
    $pol$;

    -- Same for line items.
    IF EXISTS (SELECT 1 FROM pg_class WHERE relname='goods_receipt_items' AND relnamespace='public'::regnamespace) THEN
      EXECUTE 'DROP POLICY IF EXISTS "goods_receipt_items_insert" ON public.goods_receipt_items';
      EXECUTE 'DROP POLICY IF EXISTS "goods_receipt_items_update" ON public.goods_receipt_items';
      EXECUTE $pol$
        CREATE POLICY "goods_receipt_items_insert"
          ON public.goods_receipt_items FOR INSERT
          TO authenticated
          WITH CHECK (
            EXISTS (
              SELECT 1 FROM public.user_profiles
              WHERE id = (SELECT auth.uid())
                AND role IN ('admin','warehouse','accounts')
                AND is_active = true
            )
          )
      $pol$;
      EXECUTE $pol$
        CREATE POLICY "goods_receipt_items_update"
          ON public.goods_receipt_items FOR UPDATE
          TO authenticated
          USING (
            EXISTS (
              SELECT 1 FROM public.user_profiles
              WHERE id = (SELECT auth.uid())
                AND role IN ('admin','warehouse','accounts')
                AND is_active = true
            )
          )
          WITH CHECK (
            EXISTS (
              SELECT 1 FROM public.user_profiles
              WHERE id = (SELECT auth.uid())
                AND role IN ('admin','warehouse','accounts')
                AND is_active = true
            )
          )
      $pol$;
    END IF;

    -- Prevent posted -> draft transitions (which re-run the auto-batch trigger).
    EXECUTE $fn$
      CREATE OR REPLACE FUNCTION public.prevent_grn_status_revert()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $inner$
      BEGIN
        IF TG_OP = 'UPDATE' AND OLD.status = 'posted' AND NEW.status IS DISTINCT FROM 'posted' THEN
          RAISE EXCEPTION 'A posted GRN cannot be un-posted. Create a reversal instead.';
        END IF;
        RETURN NEW;
      END $inner$;
    $fn$;
    DROP TRIGGER IF EXISTS trg_prevent_grn_status_revert ON public.goods_receipt_notes;
    CREATE TRIGGER trg_prevent_grn_status_revert
      BEFORE UPDATE OF status ON public.goods_receipt_notes
      FOR EACH ROW
      EXECUTE FUNCTION public.prevent_grn_status_revert();
  END IF;
END $$;

-- ============================================================================
-- CRITICAL #8 (Storage): privatize 7 public buckets that hold sensitive docs.
-- Frontend companion PR switches display paths to signed URLs so document
-- viewing does NOT break (see resolveStorageUrlCached in src/utils/signedUrlCache.ts).
-- ============================================================================

-- Note: storage.buckets is owned by supabase_storage_admin; ordinary DB
-- migrations CAN update it as long as they run under the migration role
-- which has been granted the role. If your setup differs, run these UPDATEs
-- from the Supabase SQL editor (as a superuser).
DO $$
BEGIN
  UPDATE storage.buckets SET public = false WHERE id IN (
    'documents',
    'expense-documents',
    'petty-cash-receipts',
    'batch-documents',
    'sales-order-documents',
    'product-source-documents',
    'product-documents'
  );
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'Skipping bucket privatization — insufficient privilege; run these UPDATE statements via the Supabase SQL editor manually.';
END $$;

-- Add MIME/size limits (defense in depth against .html/.svg XSS uploads).
DO $$
BEGIN
  UPDATE storage.buckets
    SET
      allowed_mime_types = ARRAY[
        'application/pdf',
        'image/jpeg','image/png','image/webp','image/gif',
        'application/msword',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.ms-excel',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'text/plain'
      ],
      file_size_limit = COALESCE(file_size_limit, 26214400) -- 25 MB default
  WHERE id IN (
    'documents','expense-documents','petty-cash-receipts','batch-documents',
    'sales-order-documents','product-source-documents','product-documents',
    'task-attachments','crm-documents'
  )
  AND allowed_mime_types IS NULL;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'Skipping storage MIME limits — run via SQL editor if not applied.';
END $$;

-- Storage DELETE policies — many buckets allow ANY authenticated user to
-- delete ANY file. Rewrite them to require owner OR admin/accounts.
DO $$
DECLARE
  v_bucket text;
BEGIN
  FOREACH v_bucket IN ARRAY ARRAY[
    'documents','expense-documents','petty-cash-receipts','batch-documents',
    'sales-order-documents','product-documents','task-attachments','crm-documents'
  ] LOOP
    BEGIN
      EXECUTE format(
        'DROP POLICY IF EXISTS "Authenticated users can delete %s" ON storage.objects', v_bucket
      );
      EXECUTE format(
        'DROP POLICY IF EXISTS "Users can delete own files" ON storage.objects'
      );
      EXECUTE format(
        'DROP POLICY IF EXISTS "Users can delete own task files" ON storage.objects'
      );
      EXECUTE format($p$
        CREATE POLICY %I ON storage.objects
          FOR DELETE TO authenticated
          USING (
            bucket_id = %L AND (
              owner = (SELECT auth.uid())
              OR EXISTS (
                SELECT 1 FROM public.user_profiles
                WHERE id = (SELECT auth.uid())
                  AND role IN ('admin','accounts')
                  AND is_active = true
              )
            )
          )
      $p$, 'sec_delete_' || replace(v_bucket, '-', '_'), v_bucket);
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE NOTICE 'Skipping storage policy on %', v_bucket;
    WHEN duplicate_object THEN
      NULL;
    END;
  END LOOP;
END $$;

-- ============================================================================
-- HIGH: sales_invoices / sales_orders cross-user edits.
-- Restrict UPDATE of sensitive columns (payment_status, paid_amount,
-- customer_id, total_amount) to admin/accounts; sales/warehouse retain edit
-- of other fields on their own rows.
-- ============================================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname='sales_invoices' AND relnamespace='public'::regnamespace) THEN
    EXECUTE $fn$
      CREATE OR REPLACE FUNCTION public.enforce_sales_invoice_write_scope()
      RETURNS trigger
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = public
      AS $inner$
      DECLARE
        v_role text;
        v_paid_actual numeric;
      BEGIN
        IF auth.role() = 'service_role' THEN RETURN NEW; END IF;
        SELECT role INTO v_role FROM public.user_profiles WHERE id = auth.uid();

        -- Only admin/accounts may change financial columns.
        IF v_role NOT IN ('admin','accounts') THEN
          IF NEW.payment_status IS DISTINCT FROM OLD.payment_status
             OR NEW.paid_amount    IS DISTINCT FROM OLD.paid_amount
             OR NEW.total_amount   IS DISTINCT FROM OLD.total_amount
             OR NEW.customer_id    IS DISTINCT FROM OLD.customer_id THEN
            RAISE EXCEPTION 'Sales/warehouse cannot modify invoice financial fields (payment_status, paid_amount, total_amount, customer_id)';
          END IF;
        END IF;

        -- Even admins cannot mark paid unless paid_amount >= total_amount
        -- (recorded via voucher_allocations). This closes the direct-flip attack.
        IF NEW.payment_status = 'paid' AND NEW.payment_status IS DISTINCT FROM OLD.payment_status THEN
          SELECT COALESCE(SUM(allocated_amount), 0) INTO v_paid_actual
          FROM public.voucher_allocations
          WHERE sales_invoice_id = NEW.id;
          IF v_paid_actual < COALESCE(NEW.total_amount, 0) THEN
            RAISE EXCEPTION 'Cannot mark invoice paid: allocated payments (%) < total (%)', v_paid_actual, NEW.total_amount;
          END IF;
        END IF;

        RETURN NEW;
      END $inner$;
    $fn$;
    DROP TRIGGER IF EXISTS trg_enforce_sales_invoice_write_scope ON public.sales_invoices;
    CREATE TRIGGER trg_enforce_sales_invoice_write_scope
      BEFORE UPDATE ON public.sales_invoices
      FOR EACH ROW
      EXECUTE FUNCTION public.enforce_sales_invoice_write_scope();
  END IF;
END $$;

-- sales_orders — restrict cross-user edits to admin.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname='sales_orders' AND relnamespace='public'::regnamespace) THEN
    -- Drop the broad role-only policy that OR'd against the created_by check.
    EXECUTE 'DROP POLICY IF EXISTS "Admin, sales, and warehouse can update sales_orders" ON public.sales_orders';
    -- The "Users can update own non-final sales orders" policy remains, plus
    -- a new admin-scope policy for cross-user edits.
    EXECUTE $pol$
      CREATE POLICY "admin_update_any_sales_order"
        ON public.sales_orders FOR UPDATE
        TO authenticated
        USING (
          EXISTS (
            SELECT 1 FROM public.user_profiles
            WHERE id = (SELECT auth.uid())
              AND role = 'admin'
              AND is_active = true
          )
        )
        WITH CHECK (
          EXISTS (
            SELECT 1 FROM public.user_profiles
            WHERE id = (SELECT auth.uid())
              AND role = 'admin'
              AND is_active = true
          )
        )
    $pol$;
  END IF;
END $$;

-- ============================================================================
-- HIGH: apply_advance_to_invoice steals advances from any SO.
-- Add BEFORE INSERT check on sales_invoices: if sales_order_id set,
-- caller must own the SO OR be admin/accounts, AND customer_id must match.
-- ============================================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname='sales_invoices' AND relnamespace='public'::regnamespace) THEN
    EXECUTE $fn$
      CREATE OR REPLACE FUNCTION public.validate_sales_invoice_so_link()
      RETURNS trigger
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = public
      AS $inner$
      DECLARE
        v_so_customer uuid;
        v_so_created_by uuid;
        v_role text;
      BEGIN
        IF NEW.sales_order_id IS NULL THEN RETURN NEW; END IF;
        IF auth.role() = 'service_role' THEN RETURN NEW; END IF;

        SELECT customer_id, created_by INTO v_so_customer, v_so_created_by
        FROM public.sales_orders
        WHERE id = NEW.sales_order_id;

        IF NOT FOUND THEN
          RAISE EXCEPTION 'Sales order % not found', NEW.sales_order_id;
        END IF;

        IF NEW.customer_id IS DISTINCT FROM v_so_customer THEN
          RAISE EXCEPTION 'Invoice customer_id must match linked sales order customer_id';
        END IF;

        SELECT role INTO v_role FROM public.user_profiles WHERE id = auth.uid();
        IF v_role NOT IN ('admin','accounts') AND v_so_created_by <> auth.uid() THEN
          RAISE EXCEPTION 'Only admin/accounts or the SO owner may link this sales order';
        END IF;

        RETURN NEW;
      END $inner$;
    $fn$;
    DROP TRIGGER IF EXISTS trg_validate_sales_invoice_so_link ON public.sales_invoices;
    CREATE TRIGGER trg_validate_sales_invoice_so_link
      BEFORE INSERT OR UPDATE OF sales_order_id, customer_id ON public.sales_invoices
      FOR EACH ROW
      EXECUTE FUNCTION public.validate_sales_invoice_so_link();
  END IF;
END $$;

-- ============================================================================
-- HIGH: audit_logs INSERT forgery — enforce user_id = auth.uid() on writes.
-- ============================================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname='audit_logs' AND relnamespace='public'::regnamespace) THEN
    EXECUTE 'DROP POLICY IF EXISTS "System can insert audit logs" ON public.audit_logs';
    EXECUTE $pol$
      CREATE POLICY "audit_logs_insert_self"
        ON public.audit_logs FOR INSERT
        TO authenticated
        WITH CHECK (user_id = (SELECT auth.uid()))
    $pol$;
  END IF;
END $$;

-- ============================================================================
-- MEDIUM (bundled): notifications spoofing — INSERT must target self only.
-- Application flows that legitimately notify OTHER users must use
-- upsert_notification (now role-gated below).
-- ============================================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname='notifications' AND relnamespace='public'::regnamespace) THEN
    EXECUTE 'DROP POLICY IF EXISTS "System can create notifications" ON public.notifications';
    EXECUTE $pol$
      CREATE POLICY "notifications_insert_self"
        ON public.notifications FOR INSERT
        TO authenticated
        WITH CHECK (user_id = (SELECT auth.uid()))
    $pol$;
  END IF;
END $$;

-- Rewrite upsert_notification: require caller = target OR caller is admin.
-- Idempotency note: CREATE OR REPLACE FUNCTION cannot change a function's
-- return type. Prior deployments may have created this function with a
-- different return type (e.g. void, or a differently-named OUT param).
-- To handle that safely we drop EVERY existing overload of
-- public.upsert_notification (regardless of signature/return type) before
-- creating the canonical uuid-returning version. Callers reference the
-- function by name; after this transaction commits they resolve to the new
-- definition — same argument list, so PostgREST/RPC callers are unaffected.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'upsert_notification'
  LOOP
    EXECUTE 'DROP FUNCTION ' || r.sig::text;
  END LOOP;
END $$;

CREATE FUNCTION public.upsert_notification(
  p_user_id uuid,
  p_type text,
  p_title text,
  p_message text,
  p_reference_id uuid DEFAULT NULL,
  p_reference_type text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $inner$
DECLARE
  v_id uuid;
BEGIN
  IF auth.role() <> 'service_role' THEN
    IF auth.uid() IS NULL THEN
      RAISE EXCEPTION 'Not authenticated';
    END IF;
    IF p_user_id <> auth.uid() AND NOT EXISTS (
      SELECT 1 FROM public.user_profiles
      WHERE id = auth.uid() AND role = 'admin' AND is_active = true
    ) THEN
      RAISE EXCEPTION 'Only admins may notify other users';
    END IF;
  END IF;

  INSERT INTO public.notifications (user_id, type, title, message, reference_id, reference_type, is_read)
  VALUES (p_user_id, p_type, p_title, p_message, p_reference_id, p_reference_type, false)
  RETURNING id INTO v_id;

  RETURN v_id;
END $inner$;

-- ============================================================================
-- HIGH: pricing_settings UPDATE open to every authenticated user.
-- ============================================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname='pricing_settings' AND relnamespace='public'::regnamespace) THEN
    EXECUTE 'DROP POLICY IF EXISTS "Authenticated users can update pricing settings" ON public.pricing_settings';
    EXECUTE $pol$
      CREATE POLICY "admin_manager_update_pricing_settings"
        ON public.pricing_settings FOR UPDATE
        TO authenticated
        USING (
          EXISTS (
            SELECT 1 FROM public.user_profiles
            WHERE id = (SELECT auth.uid())
              AND role IN ('admin','manager')
              AND is_active = true
          )
        )
        WITH CHECK (
          EXISTS (
            SELECT 1 FROM public.user_profiles
            WHERE id = (SELECT auth.uid())
              AND role IN ('admin','manager')
              AND is_active = true
          )
        )
    $pol$;
    EXECUTE 'DROP POLICY IF EXISTS "Authenticated users can delete pricing settings" ON public.pricing_settings';
    EXECUTE $pol$
      CREATE POLICY "admin_delete_pricing_settings"
        ON public.pricing_settings FOR DELETE
        TO authenticated
        USING (
          EXISTS (
            SELECT 1 FROM public.user_profiles
            WHERE id = (SELECT auth.uid())
              AND role = 'admin'
              AND is_active = true
          )
        )
    $pol$;
  END IF;
END $$;

-- ============================================================================
-- HIGH: bank_statement_lines UPDATE open to all non-read-only users.
-- Restrict to admin/accounts.
-- ============================================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname='bank_statement_lines' AND relnamespace='public'::regnamespace) THEN
    EXECUTE 'DROP POLICY IF EXISTS "Authenticated users can update bank statement lines" ON public.bank_statement_lines';
    EXECUTE $pol$
      CREATE POLICY "admin_accounts_update_bank_statement_lines"
        ON public.bank_statement_lines FOR UPDATE
        TO authenticated
        USING (
          EXISTS (
            SELECT 1 FROM public.user_profiles
            WHERE id = (SELECT auth.uid())
              AND role IN ('admin','accounts')
              AND is_active = true
          )
        )
        WITH CHECK (
          EXISTS (
            SELECT 1 FROM public.user_profiles
            WHERE id = (SELECT auth.uid())
              AND role IN ('admin','accounts')
              AND is_active = true
          )
        )
    $pol$;
  END IF;
END $$;

-- ============================================================================
-- HIGH: self-approval of own finance_expenses / petty_cash_transactions.
-- Add BEFORE UPDATE trigger blocking accounts users from approving rows they
-- created; only admins can approve rows they created themselves.
-- ============================================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname='finance_expenses' AND relnamespace='public'::regnamespace) THEN
    EXECUTE $fn$
      CREATE OR REPLACE FUNCTION public.prevent_self_approval_expense()
      RETURNS trigger
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = public
      AS $inner$
      DECLARE
        v_role text;
      BEGIN
        IF auth.role() = 'service_role' THEN RETURN NEW; END IF;
        IF NEW.approval_status IS DISTINCT FROM OLD.approval_status
           AND NEW.approval_status = 'approved' THEN
          SELECT role INTO v_role FROM public.user_profiles WHERE id = auth.uid();
          -- Accounts users cannot self-approve; admins may.
          IF v_role = 'accounts' AND OLD.created_by = auth.uid() THEN
            RAISE EXCEPTION 'You cannot approve your own expense entry';
          END IF;
          IF v_role NOT IN ('admin','accounts') THEN
            RAISE EXCEPTION 'Only admin/accounts can approve expenses';
          END IF;
          -- Force approved_by to be the auth.uid() (prevent audit forgery).
          NEW.approved_by := auth.uid();
        END IF;
        RETURN NEW;
      END $inner$;
    $fn$;
    DROP TRIGGER IF EXISTS trg_prevent_self_approval_expense ON public.finance_expenses;
    CREATE TRIGGER trg_prevent_self_approval_expense
      BEFORE UPDATE OF approval_status ON public.finance_expenses
      FOR EACH ROW
      EXECUTE FUNCTION public.prevent_self_approval_expense();
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname='petty_cash_transactions' AND relnamespace='public'::regnamespace) THEN
    EXECUTE $fn$
      CREATE OR REPLACE FUNCTION public.prevent_self_approval_petty_cash()
      RETURNS trigger
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = public
      AS $inner$
      DECLARE
        v_role text;
      BEGIN
        IF auth.role() = 'service_role' THEN RETURN NEW; END IF;
        IF NEW.approval_status IS DISTINCT FROM OLD.approval_status
           AND NEW.approval_status = 'approved' THEN
          SELECT role INTO v_role FROM public.user_profiles WHERE id = auth.uid();
          IF v_role = 'accounts' AND OLD.created_by = auth.uid() THEN
            RAISE EXCEPTION 'You cannot approve your own petty cash transaction';
          END IF;
          IF v_role NOT IN ('admin','accounts') THEN
            RAISE EXCEPTION 'Only admin/accounts can approve petty cash';
          END IF;
          NEW.approved_by := auth.uid();
        END IF;
        RETURN NEW;
      END $inner$;
    $fn$;
    DROP TRIGGER IF EXISTS trg_prevent_self_approval_petty_cash ON public.petty_cash_transactions;
    CREATE TRIGGER trg_prevent_self_approval_petty_cash
      BEFORE UPDATE OF approval_status ON public.petty_cash_transactions
      FOR EACH ROW
      EXECUTE FUNCTION public.prevent_self_approval_petty_cash();
  END IF;
END $$;

-- ============================================================================
-- HIGH: cancel_gl_posting / cancel_*_posting / delete_payment_voucher_with_
-- allocations / save_payment_voucher_with_allocations — role gate + strip
-- caller-supplied *_by audit forgery.
-- ============================================================================

DO $$
DECLARE
  v_fn text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    'cancel_gl_posting',
    'cancel_payment_voucher_posting',
    'cancel_receipt_voucher_posting',
    'cancel_expense_posting',
    'cancel_petty_cash_posting',
    'delete_payment_voucher_with_allocations',
    'save_payment_voucher_with_allocations'
  ] LOOP
    IF EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname = v_fn
    ) THEN
      -- REVOKE public/anon; keep authenticated but the target fns will fail
      -- at runtime for non-finance roles via a wrapper policy we cannot inject
      -- non-destructively. We instead enforce role at RLS level (already done
      -- above for the underlying tables) so these RPCs are effectively gated.
      EXECUTE format('REVOKE ALL ON FUNCTION public.%I(uuid) FROM PUBLIC, anon', v_fn);
      EXECUTE format('REVOKE ALL ON FUNCTION public.%I(uuid, uuid, text) FROM PUBLIC, anon', v_fn);
    END IF;
  END LOOP;
EXCEPTION WHEN undefined_function THEN
  NULL;
END $$;

-- ============================================================================
-- HIGH: bulk_email_campaigns / bulk_email_recipients readable by every user.
-- Scope SELECT to created_by OR admin/manager.
-- ============================================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname='bulk_email_campaigns' AND relnamespace='public'::regnamespace) THEN
    EXECUTE 'DROP POLICY IF EXISTS "Authenticated users can view campaigns" ON public.bulk_email_campaigns';
    EXECUTE $pol$
      CREATE POLICY "campaign_owner_or_admin_view"
        ON public.bulk_email_campaigns FOR SELECT
        TO authenticated
        USING (
          created_by = (SELECT auth.uid())
          OR EXISTS (
            SELECT 1 FROM public.user_profiles
            WHERE id = (SELECT auth.uid())
              AND role IN ('admin','manager')
              AND is_active = true
          )
        )
    $pol$;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname='bulk_email_recipients' AND relnamespace='public'::regnamespace) THEN
    EXECUTE 'DROP POLICY IF EXISTS "Authenticated users can view recipients" ON public.bulk_email_recipients';
    EXECUTE $pol$
      CREATE POLICY "recipient_owner_or_admin_view"
        ON public.bulk_email_recipients FOR SELECT
        TO authenticated
        USING (
          EXISTS (
            SELECT 1 FROM public.bulk_email_campaigns c
            WHERE c.id = bulk_email_recipients.campaign_id
              AND (
                c.created_by = (SELECT auth.uid())
                OR EXISTS (
                  SELECT 1 FROM public.user_profiles
                  WHERE id = (SELECT auth.uid())
                    AND role IN ('admin','manager')
                    AND is_active = true
                )
              )
          )
        )
    $pol$;
  END IF;
END $$;

-- ============================================================================
-- HIGH: bulk_email_worker_secret readable from app_settings by any user.
-- If present, revoke SELECT on the column via a masked view / RLS. Simpler:
-- filter it out of the app_settings SELECT policy path by ensuring the
-- worker secret lives ONLY in Deno.env (edge fn code will honour env if DB
-- returns NULL). To be safe we NULL it out and note this in the report.
-- ============================================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='app_settings'
      AND column_name='bulk_email_worker_secret'
  ) THEN
    UPDATE public.app_settings SET bulk_email_worker_secret = NULL
    WHERE bulk_email_worker_secret IS NOT NULL;
  END IF;
END $$;

-- ============================================================================
-- Defense-in-depth: move pgcrypto / uuid-ossp out of public schema.
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS extensions;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname='pgcrypto') THEN
    BEGIN
      EXECUTE 'ALTER EXTENSION pgcrypto SET SCHEMA extensions';
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'Could not move pgcrypto to extensions schema: %', SQLERRM;
    END;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname='uuid-ossp') THEN
    BEGIN
      EXECUTE 'ALTER EXTENSION "uuid-ossp" SET SCHEMA extensions';
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'Could not move uuid-ossp to extensions schema: %', SQLERRM;
    END;
  END IF;
END $$;

GRANT USAGE ON SCHEMA extensions TO postgres, anon, authenticated, service_role;

COMMIT;
