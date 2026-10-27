/*
  # Finance Cleanup — Repair Missing Objects (2026-07-09)

  Consolidating idempotent repair for three production 404s reported after the
  previous stabilization sprint:

    1. GET  /rest/v1/finance_staff_master              → 404 (schema cache)
    2. GET  /rest/v1/finance_utility_master            → 404 (schema cache)
    3. POST /rest/v1/rpc/get_petty_cash_balance_by_date → 404 (function missing
       from schema cache in some environments)

  Root cause
  ----------
  The two masters were introduced in migration 20260708120000 and the RPC in
  20260430130000. Both DDL sets exist in the repo but the deployed database
  either does not have them applied yet, or the PostgREST schema cache never
  picked them up (NOTIFY pgrst 'reload schema' was not sent on the last
  successful apply for the master tables).

  This migration is idempotent — it CREATE IF NOT EXISTS every object, then
  fires NOTIFY pgrst 'reload schema'. It is safe to run against a database that
  already has these objects; only the NOTIFY has any effect there.
*/

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. finance_staff_master  (idempotent)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.finance_staff_master (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name         TEXT NOT NULL,
  employee_code     TEXT,
  department        TEXT,
  default_gl_code   TEXT,
  default_gl_name   TEXT,
  npwp              TEXT,
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by        UUID REFERENCES auth.users(id),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_finance_staff_master_status
  ON public.finance_staff_master(status);
CREATE INDEX IF NOT EXISTS idx_finance_staff_master_name
  ON public.finance_staff_master(full_name);

ALTER TABLE public.finance_staff_master ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "staff_master_read" ON public.finance_staff_master;
CREATE POLICY "staff_master_read" ON public.finance_staff_master
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "staff_master_write" ON public.finance_staff_master;
CREATE POLICY "staff_master_write" ON public.finance_staff_master
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_profiles up
      WHERE up.id = (SELECT auth.uid()) AND up.role IN ('admin', 'accounts')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.user_profiles up
      WHERE up.id = (SELECT auth.uid()) AND up.role IN ('admin', 'accounts')
    )
  );

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. finance_utility_master  (idempotent)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.finance_utility_master (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_name     TEXT NOT NULL,
  utility_type      TEXT NOT NULL,
  account_number    TEXT,
  default_gl_code   TEXT,
  default_gl_name   TEXT,
  supplier_id       UUID REFERENCES public.suppliers(id) ON DELETE SET NULL,
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by        UUID REFERENCES auth.users(id),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_finance_utility_master_status
  ON public.finance_utility_master(status);
CREATE INDEX IF NOT EXISTS idx_finance_utility_master_type
  ON public.finance_utility_master(utility_type);

ALTER TABLE public.finance_utility_master ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "utility_master_read" ON public.finance_utility_master;
CREATE POLICY "utility_master_read" ON public.finance_utility_master
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "utility_master_write" ON public.finance_utility_master;
CREATE POLICY "utility_master_write" ON public.finance_utility_master
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_profiles up
      WHERE up.id = (SELECT auth.uid()) AND up.role IN ('admin', 'accounts')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.user_profiles up
      WHERE up.id = (SELECT auth.uid()) AND up.role IN ('admin', 'accounts')
    )
  );

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. updated_at trigger — shared function, safe to re-CREATE OR REPLACE
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.tg_touch_finance_master_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tr_staff_master_touch   ON public.finance_staff_master;
CREATE TRIGGER tr_staff_master_touch
  BEFORE UPDATE ON public.finance_staff_master
  FOR EACH ROW EXECUTE FUNCTION public.tg_touch_finance_master_updated_at();

DROP TRIGGER IF EXISTS tr_utility_master_touch ON public.finance_utility_master;
CREATE TRIGGER tr_utility_master_touch
  BEFORE UPDATE ON public.finance_utility_master
  FOR EACH ROW EXECUTE FUNCTION public.tg_touch_finance_master_updated_at();

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. get_petty_cash_balance_by_date  — repair RPC
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.get_petty_cash_balance_by_date(
  start_date date,
  end_date   date
)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  total_withdrawals numeric := 0;
  total_expenses    numeric := 0;
BEGIN
  SELECT COALESCE(SUM(amount), 0)
  INTO total_withdrawals
  FROM public.petty_cash_transactions
  WHERE transaction_type = 'withdraw'
    AND transaction_date BETWEEN start_date AND end_date;

  SELECT COALESCE(SUM(amount), 0)
  INTO total_expenses
  FROM public.petty_cash_transactions
  WHERE transaction_type = 'expense'
    AND transaction_date BETWEEN start_date AND end_date;

  RETURN total_withdrawals - total_expenses;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_petty_cash_balance_by_date(date, date) TO authenticated;

-- Also re-assert the legacy signature so the frontend's fallback path resolves.
CREATE OR REPLACE FUNCTION public.get_petty_cash_balance()
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  total_withdrawals numeric := 0;
  total_expenses    numeric := 0;
BEGIN
  SELECT COALESCE(SUM(amount), 0)
  INTO total_withdrawals
  FROM public.petty_cash_transactions
  WHERE transaction_type = 'withdraw';

  SELECT COALESCE(SUM(amount), 0)
  INTO total_expenses
  FROM public.petty_cash_transactions
  WHERE transaction_type = 'expense';

  RETURN total_withdrawals - total_expenses;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_petty_cash_balance() TO authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. Force PostgREST to reload its schema cache
-- ═══════════════════════════════════════════════════════════════════════════

NOTIFY pgrst, 'reload schema';
