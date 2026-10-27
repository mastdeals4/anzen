-- ============================================================================
-- Sales Orders: company_snapshot column, trigger, and date-aware backfill
-- ============================================================================
-- sales_orders was missed by the original Company Profile Versioning migration
-- (20260713230000). ProformaInvoiceView therefore falls back to FALLBACK_COMPANY,
-- which shows the wrong identity ("PT. Avira Parama Pharma") for historical
-- orders that should show "PT. Shubham Anzen Pharma Jaya".
--
-- This migration:
--   1. Adds company_snapshot jsonb to sales_orders (idempotent).
--   2. Attaches the shared auto_snapshot_company_profile BEFORE INSERT trigger
--      already used by every other document table — no duplicate logic.
--   3. Backfills existing rows using the profile whose effective_from is the
--      greatest value ≤ the order's so_date. This is the same "point-in-time"
--      lookup applied at INSERT-time by get_current_company_profile(), just
--      parameterised by the order's own business date so historical orders
--      pick up the correct historical identity.
-- ============================================================================

BEGIN;

-- ── 1. Column ────────────────────────────────────────────────────────────────
ALTER TABLE public.sales_orders
  ADD COLUMN IF NOT EXISTS company_snapshot jsonb;

-- ── 2. Trigger (shared function from 20260713230000) ─────────────────────────
DROP TRIGGER IF EXISTS trg_snapshot_company_sales_orders ON public.sales_orders;
CREATE TRIGGER trg_snapshot_company_sales_orders
  BEFORE INSERT ON public.sales_orders
  FOR EACH ROW EXECUTE FUNCTION public.auto_snapshot_company_profile();

-- ── 3. Date-aware backfill ───────────────────────────────────────────────────
-- For each existing row without a snapshot, stamp the profile that would have
-- been "current" on the SO's own date. Correlated subquery avoids the
-- LATERAL syntax quirk when the outer UPDATE target is referenced.
UPDATE public.sales_orders so
SET company_snapshot = (
  SELECT to_jsonb(p)
  FROM public.company_profiles p
  WHERE p.effective_from <= so.so_date
  ORDER BY p.effective_from DESC
  LIMIT 1
)
WHERE so.company_snapshot IS NULL;

-- Any row whose so_date predates the earliest profile still has NULL after
-- the pass above; assign the earliest profile so the field is never NULL.
UPDATE public.sales_orders so
SET company_snapshot = (
  SELECT to_jsonb(p)
  FROM public.company_profiles p
  ORDER BY p.effective_from ASC
  LIMIT 1
)
WHERE so.company_snapshot IS NULL;

NOTIFY pgrst, 'reload schema';

COMMIT;
