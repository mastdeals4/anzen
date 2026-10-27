/*
  Finance Masters — Staff + Utility
  ----------------------------------
  Two lookup tables for the Expense form (2026-07-08).

    finance_staff_master     — payroll / staff expense targets.
      Salary / staff_overtime / staff_welfare / travel_conveyance
      expenses select the staff member here instead of a supplier.

    finance_utility_master   — utility providers.
      PLN, PAM, Telkom, Biznet, gas, office rent, etc.
      Utility expenses select the provider here.

  Both tables are pure lookups — no accounting logic runs from them.
  finance_expenses stays exactly as it is; the frontend just fills the
  supplier_id column (or leaves it null) after resolving from these tables
  as needed. Journal / Ledger / Tax reports are untouched.

  Both tables ship with RLS enabled — read for any authenticated user,
  write for admin / accounts only.
*/

-- ────────────────────────────────────────────────────────────────────────────
-- 1. finance_staff_master
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.finance_staff_master (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name         TEXT NOT NULL,
  employee_code     TEXT,
  department        TEXT,
  default_gl_code   TEXT,           -- e.g. '6100' Salary Expense
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

COMMENT ON TABLE public.finance_staff_master IS
'Payroll / staff expense targets. Used by the Expense form when the category '
'is one of salary / staff_overtime / staff_welfare / travel_conveyance.';

-- ────────────────────────────────────────────────────────────────────────────
-- 2. finance_utility_master
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.finance_utility_master (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_name     TEXT NOT NULL,
  utility_type      TEXT NOT NULL,   -- 'electricity' | 'water' | 'internet' | 'phone' | 'gas' | 'rent' | 'other'
  account_number    TEXT,            -- customer/subscriber ID at the provider
  default_gl_code   TEXT,            -- e.g. '6200' Utilities Expense
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

COMMENT ON TABLE public.finance_utility_master IS
'Utility providers (PLN electricity, PAM water, Telkom internet/phone, Biznet, '
'gas, office rent, etc). Used by the Expense form when category = utilities. '
'Optional supplier_id points at the finance supplier for AP integration; when '
'set, saving a utility expense also fills finance_expenses.supplier_id.';

-- ────────────────────────────────────────────────────────────────────────────
-- 3. Row-level security — read: any authenticated; write: admin / accounts
-- ────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.finance_staff_master ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.finance_utility_master ENABLE ROW LEVEL SECURITY;

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

-- ────────────────────────────────────────────────────────────────────────────
-- 4. updated_at triggers
-- ────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.tg_touch_finance_master_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tr_staff_master_touch ON public.finance_staff_master;
CREATE TRIGGER tr_staff_master_touch
  BEFORE UPDATE ON public.finance_staff_master
  FOR EACH ROW EXECUTE FUNCTION public.tg_touch_finance_master_updated_at();

DROP TRIGGER IF EXISTS tr_utility_master_touch ON public.finance_utility_master;
CREATE TRIGGER tr_utility_master_touch
  BEFORE UPDATE ON public.finance_utility_master
  FOR EACH ROW EXECUTE FUNCTION public.tg_touch_finance_master_updated_at();
