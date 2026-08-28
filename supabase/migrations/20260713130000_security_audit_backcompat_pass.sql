-- ============================================================================
-- Security Audit 2026-07-13 — backward-compat pass on the previous migration
-- ============================================================================
-- Fixes to 20260713120000_security_audit_2026_07_13_critical_high.sql to
-- ensure no legitimate ERP workflow (SO->DC->Invoice, payment allocation,
-- petty-cash approval, fund-transfer FX, etc.) is broken by the new triggers.
--
-- Strategy:
--   - Every new BEFORE trigger returns NEW unchanged when pg_trigger_depth() > 1
--     so cascading SECURITY DEFINER triggers (recalculate_invoice_payment_status,
--     etc.) that ALREADY ran their own logic keep working.
--   - sales_orders policy is restored to preserve warehouse status writes;
--     column-restriction is enforced via a BEFORE UPDATE trigger instead.
--   - handle_new_user new-signups return to is_active=true (role clamping to
--     'sales' is the load-bearing security fix; admin approval workflow
--     doesn't exist yet in the app).
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. handle_new_user — restore is_active=true. Role clamp to 'sales' remains.
-- ---------------------------------------------------------------------------

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

  INSERT INTO public.user_profiles (id, username, email, full_name, role, is_active)
  VALUES (
    NEW.id,
    v_username,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.email),
    'sales',  -- Hard-coded. IGNORES raw_user_meta_data->>'role'.
    true       -- Preserve prior signup UX.
  )
  ON CONFLICT (id) DO NOTHING;

  RETURN NEW;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname='auto_create_user_profile'
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
          true
        )
        ON CONFLICT (id) DO NOTHING;
        RETURN NEW;
      END $inner$;
    $fn$;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. sales_invoices trigger — allow cascading updates from SECURITY DEFINER
--    triggers (customer_payments -> recalculate_invoice_payment_status)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.enforce_sales_invoice_write_scope()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
  v_paid_actual numeric;
BEGIN
  -- Cascading updates from other triggers (e.g. recalculate_invoice_payment_
  -- status on voucher_allocations) are trusted. pg_trigger_depth() > 1 means
  -- we're inside a nested trigger chain.
  IF pg_trigger_depth() > 1 THEN RETURN NEW; END IF;

  IF auth.role() = 'service_role' THEN RETURN NEW; END IF;

  SELECT role INTO v_role FROM public.user_profiles WHERE id = auth.uid();

  IF v_role NOT IN ('admin','accounts') THEN
    IF NEW.payment_status IS DISTINCT FROM OLD.payment_status
       OR NEW.paid_amount    IS DISTINCT FROM OLD.paid_amount
       OR NEW.total_amount   IS DISTINCT FROM OLD.total_amount
       OR NEW.customer_id    IS DISTINCT FROM OLD.customer_id THEN
      RAISE EXCEPTION 'Sales/warehouse cannot modify invoice financial fields (payment_status, paid_amount, total_amount, customer_id)';
    END IF;
  END IF;

  IF NEW.payment_status = 'paid' AND NEW.payment_status IS DISTINCT FROM OLD.payment_status THEN
    SELECT COALESCE(SUM(allocated_amount), 0) INTO v_paid_actual
    FROM public.voucher_allocations
    WHERE sales_invoice_id = NEW.id;
    IF v_paid_actual < COALESCE(NEW.total_amount, 0) THEN
      RAISE EXCEPTION 'Cannot mark invoice paid: allocated payments (%) < total (%)', v_paid_actual, NEW.total_amount;
    END IF;
  END IF;

  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------
-- 3. finance_expenses / petty_cash_transactions — same depth-check for
--    cascading approvals from posting triggers.
-- ---------------------------------------------------------------------------

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
        IF pg_trigger_depth() > 1 THEN RETURN NEW; END IF;
        IF auth.role() = 'service_role' THEN RETURN NEW; END IF;
        IF NEW.approval_status IS DISTINCT FROM OLD.approval_status
           AND NEW.approval_status = 'approved' THEN
          SELECT role INTO v_role FROM public.user_profiles WHERE id = auth.uid();
          IF v_role = 'accounts' AND OLD.created_by = auth.uid() THEN
            RAISE EXCEPTION 'You cannot approve your own expense entry';
          END IF;
          IF v_role NOT IN ('admin','accounts') THEN
            RAISE EXCEPTION 'Only admin/accounts can approve expenses';
          END IF;
          NEW.approved_by := auth.uid();
        END IF;
        RETURN NEW;
      END $inner$;
    $fn$;
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
        IF pg_trigger_depth() > 1 THEN RETURN NEW; END IF;
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
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 4. validate_sales_invoice_so_link — depth guard so cascading SO backfills
--    (e.g. import-container-fills-invoice pipeline) can update linked rows
--    when appropriate.
-- ---------------------------------------------------------------------------

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
        IF pg_trigger_depth() > 1 THEN RETURN NEW; END IF;
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
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 5. fund_transfer triggers — depth guard. Only user-initiated INSERTs need
--    the role check; cascading calls from delete_fund_transfer / reverse
--    RPCs (SECURITY DEFINER) will run at depth=1 anyway (they're called from
--    RPC, not from a trigger), so the guard mainly protects future re-entrant
--    paths.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname='fund_transfers' AND relnamespace='public'::regnamespace) THEN
    EXECUTE $fn$
      CREATE OR REPLACE FUNCTION public.enforce_fund_transfer_role()
      RETURNS trigger
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = public
      AS $inner$
      BEGIN
        IF pg_trigger_depth() > 1 THEN RETURN COALESCE(NEW, OLD); END IF;
        PERFORM public._sec_check_finance_role();
        IF TG_OP = 'INSERT' AND auth.role() <> 'service_role' THEN
          NEW.created_by := COALESCE(auth.uid(), NEW.created_by);
        END IF;
        RETURN COALESCE(NEW, OLD);
      END $inner$;
    $fn$;

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
        IF pg_trigger_depth() > 1 THEN RETURN NEW; END IF;

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
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 6. sales_orders — restore backward compat by dropping the admin-only
--    policy I added in the prior migration and using a column-restriction
--    trigger instead. Warehouse/sales can still write status transitions
--    (delivery workflow) but cannot mutate customer_id / total_amount /
--    prices on rows they don't own.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname='sales_orders' AND relnamespace='public'::regnamespace) THEN
    -- Undo the admin-only UPDATE policy from 20260713120000; the pre-existing
    -- policies (warehouse workflow) are enough at RLS level. Column-restriction
    -- happens via trigger below.
    EXECUTE 'DROP POLICY IF EXISTS "admin_update_any_sales_order" ON public.sales_orders';

    EXECUTE $fn$
      CREATE OR REPLACE FUNCTION public.enforce_sales_order_column_scope()
      RETURNS trigger
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = public
      AS $inner$
      DECLARE
        v_role text;
      BEGIN
        IF pg_trigger_depth() > 1 THEN RETURN NEW; END IF;
        IF auth.role() = 'service_role' THEN RETURN NEW; END IF;

        SELECT role INTO v_role FROM public.user_profiles WHERE id = auth.uid();

        -- Admins can do anything.
        IF v_role = 'admin' THEN RETURN NEW; END IF;

        -- Non-owners cannot mutate sensitive commercial columns.
        IF OLD.created_by IS NOT NULL AND OLD.created_by <> auth.uid() THEN
          IF NEW.customer_id  IS DISTINCT FROM OLD.customer_id
             OR NEW.total_amount IS DISTINCT FROM OLD.total_amount THEN
            RAISE EXCEPTION 'Only the SO owner or an admin may change customer_id / total_amount';
          END IF;
        END IF;

        RETURN NEW;
      END $inner$;
    $fn$;

    DROP TRIGGER IF EXISTS trg_enforce_sales_order_column_scope ON public.sales_orders;
    CREATE TRIGGER trg_enforce_sales_order_column_scope
      BEFORE UPDATE ON public.sales_orders
      FOR EACH ROW
      EXECUTE FUNCTION public.enforce_sales_order_column_scope();
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 7. GRN posted->non-posted trigger — allow the ADMIN role to override
--    for genuine correction workflows (audit trail preserved via existing
--    audit_logs). Warehouse/accounts cannot un-post.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname='goods_receipt_notes' AND relnamespace='public'::regnamespace) THEN
    EXECUTE $fn$
      CREATE OR REPLACE FUNCTION public.prevent_grn_status_revert()
      RETURNS trigger
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = public
      AS $inner$
      DECLARE
        v_role text;
      BEGIN
        IF pg_trigger_depth() > 1 THEN RETURN NEW; END IF;
        IF auth.role() = 'service_role' THEN RETURN NEW; END IF;

        IF TG_OP = 'UPDATE' AND OLD.status = 'posted' AND NEW.status IS DISTINCT FROM 'posted' THEN
          SELECT role INTO v_role FROM public.user_profiles WHERE id = auth.uid();
          IF v_role <> 'admin' THEN
            RAISE EXCEPTION 'A posted GRN cannot be un-posted. Contact an admin for reversal.';
          END IF;
        END IF;

        RETURN NEW;
      END $inner$;
    $fn$;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 8. user_profiles trigger — depth guard so admin edge functions
--    (service_role) and cascading updates (e.g. handle_new_user trigger) do
--    not trip. Also ensure service_role fully bypasses.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.prevent_self_privilege_escalation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_role text;
BEGIN
  IF pg_trigger_depth() > 1 THEN RETURN NEW; END IF;
  IF auth.role() = 'service_role' THEN RETURN NEW; END IF;

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

COMMIT;
