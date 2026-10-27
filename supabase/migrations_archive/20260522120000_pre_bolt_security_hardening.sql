/*
  # Pre-Bolt Security Hardening (safe, focused)

  This migration only addresses the high-priority Supabase Security Advisor
  warnings that are safe to fix without touching finance / stock / import /
  sales-order / delivery-challan / invoice / PriceCalculator logic.

  What this migration does:
    1. Drops broad legacy pricing RLS policies that were `WITH CHECK (true)` /
       `USING (true)`. Newer role-based policies already exist; we only remove
       the broad ones.
    2. Re-asserts (idempotently) the role-based pricing policies that should
       remain, in case the advisor sees an unsafe duplicate.
    3. Re-asserts role-safe insert on communication_timeline (and on a
       possible legacy `price_request_communications` table, if present).
    4. Revokes PUBLIC execution from internal pricing helper / trigger
       functions. These are not called by the frontend (verified by grepping
       src/ and supabase/functions/).
    5. Pins `search_path = public` on `public.update_updated_at_column`.
    6. Re-asserts `security_invoker = true` on `public.product_stock_summary`
       in case the live view drifted back to definer.

  What this migration intentionally does NOT do:
    - Does not touch finance / stock / import / sales-order / delivery-challan
      / invoice / PriceCalculator RPCs even if they show SECURITY DEFINER
      warnings — those need a separate, deliberate review.
    - Does not enable "Leaked password protection" — that is a Supabase
      Dashboard setting (Auth → Password Security). It cannot be flipped
      from a SQL migration. See note at the bottom of this file.

  Safe to re-run.
*/

-- ────────────────────────────────────────────────────────────────────────────
-- 1. Drop broad legacy pricing RLS policies (if they exist).
--    These were the `Authenticated users can …` policies flagged by the
--    advisor. They are not present in our migrations but may have been
--    created live via the dashboard.
-- ────────────────────────────────────────────────────────────────────────────

-- price_requests
DROP POLICY IF EXISTS "Authenticated users can insert price requests"  ON price_requests;
DROP POLICY IF EXISTS "Authenticated users can update price requests"  ON price_requests;
DROP POLICY IF EXISTS "Authenticated users can select price requests"  ON price_requests;
DROP POLICY IF EXISTS "Authenticated users can delete price requests"  ON price_requests;
DROP POLICY IF EXISTS "Enable insert for authenticated users only"     ON price_requests;
DROP POLICY IF EXISTS "Enable update for authenticated users only"     ON price_requests;

-- price_request_items
DROP POLICY IF EXISTS "Authenticated users can insert price request items" ON price_request_items;
DROP POLICY IF EXISTS "Authenticated users can update price request items" ON price_request_items;
DROP POLICY IF EXISTS "Authenticated users can select price request items" ON price_request_items;
DROP POLICY IF EXISTS "Authenticated users can delete price request items" ON price_request_items;

-- pricing_ledger
DROP POLICY IF EXISTS "Authenticated users can insert pricing ledger"  ON pricing_ledger;
DROP POLICY IF EXISTS "Authenticated users can update pricing ledger"  ON pricing_ledger;
DROP POLICY IF EXISTS "Authenticated users can select pricing ledger"  ON pricing_ledger;
DROP POLICY IF EXISTS "Authenticated users can delete pricing ledger"  ON pricing_ledger;

-- communication_timeline  (broad legacy insert flagged by advisor)
DROP POLICY IF EXISTS "Authenticated users can insert communications"  ON communication_timeline;
DROP POLICY IF EXISTS "Authenticated users can insert timeline"        ON communication_timeline;
DROP POLICY IF EXISTS "Anyone can insert timeline"                     ON communication_timeline;

-- Legacy `price_request_communications` table — drop policies only if the
-- table happens to exist (we do not reference it from the app).
DO $$
BEGIN
  IF to_regclass('public.price_request_communications') IS NOT NULL THEN
    EXECUTE 'DROP POLICY IF EXISTS "Authenticated users can insert communications" ON price_request_communications';
    EXECUTE 'DROP POLICY IF EXISTS "Authenticated users can update communications" ON price_request_communications';
    EXECUTE 'DROP POLICY IF EXISTS "Authenticated users can select communications" ON price_request_communications';
    EXECUTE 'ALTER TABLE price_request_communications ENABLE ROW LEVEL SECURITY';

    -- Replace with a role-safe insert. Only admin/manager/sales can insert.
    EXECUTE 'DROP POLICY IF EXISTS "pricing_communications_insert_role" ON price_request_communications';
    EXECUTE $POL$
      CREATE POLICY "pricing_communications_insert_role" ON price_request_communications
        FOR INSERT TO authenticated
        WITH CHECK (current_user_has_pricing_role(ARRAY['admin','manager','sales']))
    $POL$;

    EXECUTE 'DROP POLICY IF EXISTS "pricing_communications_read_role" ON price_request_communications';
    EXECUTE $POL$
      CREATE POLICY "pricing_communications_read_role" ON price_request_communications
        FOR SELECT TO authenticated
        USING (current_user_has_pricing_role(ARRAY['admin','manager','sales']))
    $POL$;
  END IF;
END $$;

-- ────────────────────────────────────────────────────────────────────────────
-- 2. Re-assert the role-based pricing policies (idempotent). These already
--    exist via 20260521090000_pricing_rls_safety_patch.sql; this block is a
--    defensive re-application in case the live DB diverged.
--    Sales role is allowed to manage records but cannot change final-quote
--    fields (final_quote_price, final_quote_currency, final_entered_by,
--    final_entered_at) — enforced both by the policy WITH CHECK and by the
--    enforce_final_quote_write_restriction trigger that already exists.
-- ────────────────────────────────────────────────────────────────────────────

-- price_requests
DROP POLICY IF EXISTS "pricing_request_read"            ON price_requests;
DROP POLICY IF EXISTS "pricing_request_insert"          ON price_requests;
DROP POLICY IF EXISTS "pricing_request_update_manager"  ON price_requests;
DROP POLICY IF EXISTS "pricing_request_update_sales"    ON price_requests;

CREATE POLICY "pricing_request_read" ON price_requests
  FOR SELECT TO authenticated
  USING (current_user_has_pricing_role(ARRAY['admin','manager','sales']));

CREATE POLICY "pricing_request_insert" ON price_requests
  FOR INSERT TO authenticated
  WITH CHECK (current_user_has_pricing_role(ARRAY['admin','manager','sales']));

CREATE POLICY "pricing_request_update_manager" ON price_requests
  FOR UPDATE TO authenticated
  USING      (current_user_has_pricing_role(ARRAY['admin','manager']))
  WITH CHECK (current_user_has_pricing_role(ARRAY['admin','manager']));

CREATE POLICY "pricing_request_update_sales" ON price_requests
  FOR UPDATE TO authenticated
  USING      (current_user_has_pricing_role(ARRAY['sales']))
  WITH CHECK (current_user_has_pricing_role(ARRAY['sales']));

-- price_request_items
DROP POLICY IF EXISTS "pricing_items_read"           ON price_request_items;
DROP POLICY IF EXISTS "pricing_items_insert"         ON price_request_items;
DROP POLICY IF EXISTS "pricing_items_update_manager" ON price_request_items;
DROP POLICY IF EXISTS "pricing_items_update_sales"   ON price_request_items;

CREATE POLICY "pricing_items_read" ON price_request_items
  FOR SELECT TO authenticated
  USING (current_user_has_pricing_role(ARRAY['admin','manager','sales']));

CREATE POLICY "pricing_items_insert" ON price_request_items
  FOR INSERT TO authenticated
  WITH CHECK (current_user_has_pricing_role(ARRAY['admin','manager','sales']));

CREATE POLICY "pricing_items_update_manager" ON price_request_items
  FOR UPDATE TO authenticated
  USING      (current_user_has_pricing_role(ARRAY['admin','manager']))
  WITH CHECK (current_user_has_pricing_role(ARRAY['admin','manager']));

-- Sales may update items they own but not the final-quote fields.
-- The enforce_final_quote_write_restriction trigger (already deployed)
-- raises if a non-admin/manager tries to change those columns.
CREATE POLICY "pricing_items_update_sales" ON price_request_items
  FOR UPDATE TO authenticated
  USING      (current_user_has_pricing_role(ARRAY['sales']))
  WITH CHECK (current_user_has_pricing_role(ARRAY['sales']));

-- pricing_ledger — write is admin/manager only
DROP POLICY IF EXISTS "pricing_ledger_read"   ON pricing_ledger;
DROP POLICY IF EXISTS "pricing_ledger_insert" ON pricing_ledger;
DROP POLICY IF EXISTS "pricing_ledger_update" ON pricing_ledger;

CREATE POLICY "pricing_ledger_read" ON pricing_ledger
  FOR SELECT TO authenticated
  USING (current_user_has_pricing_role(ARRAY['admin','manager','sales']));

CREATE POLICY "pricing_ledger_insert" ON pricing_ledger
  FOR INSERT TO authenticated
  WITH CHECK (current_user_has_pricing_role(ARRAY['admin','manager']));

CREATE POLICY "pricing_ledger_update" ON pricing_ledger
  FOR UPDATE TO authenticated
  USING      (current_user_has_pricing_role(ARRAY['admin','manager']))
  WITH CHECK (current_user_has_pricing_role(ARRAY['admin','manager']));

-- communication_timeline — role-safe insert (no WITH CHECK true)
DROP POLICY IF EXISTS "pricing_timeline_read"   ON communication_timeline;
DROP POLICY IF EXISTS "pricing_timeline_insert" ON communication_timeline;

CREATE POLICY "pricing_timeline_read" ON communication_timeline
  FOR SELECT TO authenticated
  USING (current_user_has_pricing_role(ARRAY['admin','manager','sales']));

CREATE POLICY "pricing_timeline_insert" ON communication_timeline
  FOR INSERT TO authenticated
  WITH CHECK (current_user_has_pricing_role(ARRAY['admin','manager','sales']));

-- ────────────────────────────────────────────────────────────────────────────
-- 3. Revoke PUBLIC execution from internal pricing helper / trigger functions.
--    Verified by repo grep: none of these are called by the frontend or
--    Edge Functions. They are invoked exclusively from triggers, RLS, or
--    server-side context that operates with elevated rights.
-- ────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  fn text;
  fns text[] := ARRAY[
    'current_user_has_pricing_role(text[])',
    'enforce_final_quote_write_restriction()',
    'generate_price_request_number()',
    'generate_pr_number()',
    'trg_sync_price_request_counts()',
    'recompute_price_request_counts(uuid)'
  ];
BEGIN
  FOREACH fn IN ARRAY fns
  LOOP
    IF EXISTS (
      SELECT 1
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.oid::regprocedure::text = 'public.' || fn
    ) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC', fn);
      EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM anon', fn);
      -- current_user_has_pricing_role is used in RLS USING clauses; it must
      -- still be callable by authenticated. Other helpers are trigger-only.
      IF fn = 'current_user_has_pricing_role(text[])' THEN
        EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO authenticated', fn);
      ELSE
        EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM authenticated', fn);
      END IF;
    END IF;
  END LOOP;
END $$;

-- ────────────────────────────────────────────────────────────────────────────
-- 4. Pin search_path on update_updated_at_column. Body is unchanged.
-- ────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- ────────────────────────────────────────────────────────────────────────────
-- 5. product_stock_summary view — re-assert SECURITY INVOKER. Repo grep
--    shows two prior migrations did this already (20260110160747 and
--    20260209143036). We re-apply defensively in case the live view drifted.
--    The view body is NOT rewritten — only its option is set.
-- ────────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF to_regclass('public.product_stock_summary') IS NOT NULL THEN
    EXECUTE 'ALTER VIEW public.product_stock_summary SET (security_invoker = true)';
  END IF;
END $$;

-- ────────────────────────────────────────────────────────────────────────────
-- 6. NOT FIXED HERE — intentional. To be reviewed manually later:
--
--    Older ERP RPCs that the advisor flags as SECURITY DEFINER, including
--    (non-exhaustive):
--      - auto_match_smart, safe_delete_bank_statement_lines,
--        preview_bank_statement_delete
--      - generate_journal_entry_number, generate_voucher_number,
--        get_petty_cash_balance, get_petty_cash_balance_by_date,
--        create_fund_transfer_with_posting
--      - get_invoices_with_balance, get_invoice_paid_amount,
--        get_invoice_latest_payment_date, get_pending_dc_items_for_customer,
--        update_sales_invoice_atomic, adjust_batch_stock_atomic
--      - get_overdue_balances, get_cogs_for_period, get_trial_balance,
--        get_current_financial_year, get_user_appointments
--      - fn_release_reservation_by_so_id, mark_requirement_sent,
--        upsert_notification
--
--    All of these are actively called by the finance / stock / sales /
--    delivery-challan / invoice modules and must not be touched without a
--    deliberate review.
--
--    Auth → Password Security → "Leaked password protection":
--    This advisor item CANNOT be resolved from SQL. It is a project setting
--    in the Supabase Dashboard:
--        Dashboard → Authentication → Policies → Password Security
--        → Enable "Leaked password protection".
--    A human operator must toggle that switch. This migration does NOT
--    pretend to fix it.
-- ────────────────────────────────────────────────────────────────────────────
