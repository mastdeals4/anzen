-- ============================================================================
-- One-time historical Company Profile correction (2026-07-13)
-- ============================================================================
-- The 2020-01-01 seed profile was created with company_name "PT. Avira Parama
-- Pharma" because that value was already in app_settings when the Company
-- Profile Versioning feature was first deployed. Every document snapshot
-- created before this fix therefore carries the wrong company_name.
--
-- The correct historical identity for every pre-2026-07-13 document is
-- "PT. Shubham Anzen Pharma Jaya". "PT. Avira Parama Pharma" is a NEW company
-- identity effective 2026-07-13.
--
-- This migration:
--   1. Renames the 2020-01-01 seed profile to "PT. Shubham Anzen Pharma Jaya".
--   2. Updates every document snapshot that was stamped with the wrong name.
--   3. Inserts a new profile "PT. Avira Parama Pharma" effective 2026-07-13,
--      copying the remaining fields from the corrected 2020-01-01 profile.
--
-- Normal referenced-profile protection is bypassed only for the duration of
-- this transaction (SET LOCAL session_replication_role) — this is precisely
-- the one-time exception authorized. Protection resumes automatically at
-- COMMIT.
-- ============================================================================

BEGIN;

SET LOCAL session_replication_role = 'replica';

-- ── 1. Correct the seed profile name ─────────────────────────────────────────
UPDATE public.company_profiles
SET
  company_name = 'PT. Shubham Anzen Pharma Jaya',
  notes = COALESCE(notes, '') ||
    CASE WHEN COALESCE(notes, '') = '' THEN '' ELSE ' | ' END ||
    '2026-07-13: historical name corrected from mistakenly-seeded "PT. Avira Parama Pharma"'
WHERE effective_from = '2020-01-01'
  AND company_name = 'PT. Avira Parama Pharma';

-- ── 2. Correct existing document snapshots stamped with the wrong name ───────
-- Only touch rows whose snapshot company_name is the mistakenly-seeded value.
-- All other snapshot fields are left untouched.
DO $outer$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'sales_invoices',
    'delivery_challans',
    'credit_notes',
    'material_returns',
    'stock_rejections',
    'purchase_orders',
    'payment_vouchers',
    'receipt_vouchers',
    'purchase_invoices'
  ] LOOP
    EXECUTE format($f$
      UPDATE public.%I
      SET company_snapshot = jsonb_set(
        company_snapshot,
        '{company_name}',
        to_jsonb('PT. Shubham Anzen Pharma Jaya'::text)
      )
      WHERE company_snapshot IS NOT NULL
        AND company_snapshot->>'company_name' = 'PT. Avira Parama Pharma'
    $f$, t);
  END LOOP;
END;
$outer$;

-- ── 3. Insert the new Avira profile effective 2026-07-13 ─────────────────────
-- Copies remaining fields (address/phone/email/tax/logo/licenses) from the
-- corrected 2020-01-01 profile. If a 2026-07-13 profile already exists (e.g.
-- someone created it manually via UI), the UNIQUE (effective_from) constraint
-- makes this a no-op.
INSERT INTO public.company_profiles (
  effective_from,
  company_name,
  company_address,
  company_phone,
  company_email,
  company_tax_id,
  company_logo_url,
  pbf_license,
  cdob_certificate,
  notes
)
SELECT
  '2026-07-13'::date,
  'PT. Avira Parama Pharma',
  cp.company_address,
  cp.company_phone,
  cp.company_email,
  cp.company_tax_id,
  cp.company_logo_url,
  cp.pbf_license,
  cp.cdob_certificate,
  '2026-07-13: new company identity split from PT. Shubham Anzen Pharma Jaya'
FROM public.company_profiles cp
WHERE cp.effective_from = '2020-01-01'
ON CONFLICT (effective_from) DO NOTHING;

-- SET LOCAL is transaction-scoped; the session default (origin) is restored
-- automatically at COMMIT. Referenced-profile protection resumes for all
-- future edits.

NOTIFY pgrst, 'reload schema';

COMMIT;
