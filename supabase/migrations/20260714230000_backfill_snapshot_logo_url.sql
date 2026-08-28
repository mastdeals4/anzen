-- ============================================================================
-- Backfill company_snapshot.company_logo_url on existing documents
-- ============================================================================
-- Context:
--   company_profiles.company_logo_url was NULL at the time existing document
--   snapshots were stamped (the logo upload pipeline was blocked by the
--   protect_historical_company_profile trigger — fixed in 20260714220000).
--   As a result, company_snapshot->>'company_logo_url' is NULL on all
--   documents created before the logo was successfully saved.
--
-- This migration repairs ONLY the missing branding field.
-- It does NOT touch any other field in company_snapshot.
-- Historical accounting data (totals, line items, tax amounts, party names,
-- dates, invoice numbers) is never read or written by this migration.
--
-- Strategy:
--   For each affected row, read company_snapshot->>'id' to identify which
--   company_profiles record was "current" at insert time, then pull
--   company_logo_url from that profile and patch it into the snapshot using
--   jsonb_set(). The rest of the snapshot JSONB is byte-for-byte unchanged.
--
--   Guard: only update rows where:
--     1. company_snapshot is not NULL (has a valid snapshot)
--     2. company_snapshot->>'id' is not NULL (snapshot has a profile reference)
--     3. company_snapshot->>'company_logo_url' IS NULL  (logo is missing)
--     4. the referenced profile has a non-NULL company_logo_url  (there is
--        something to copy — don't replace NULL with NULL)
--
-- Tables: all 10 snapshot-bearing tables.
-- Idempotent: re-running after all logos are present is a no-op (guard 3).
-- No schema changes.
-- ============================================================================

BEGIN;

DO $$
DECLARE
  v_table   text;
  v_updated int := 0;
  v_total   int := 0;
BEGIN
  FOR v_table IN
    SELECT * FROM (VALUES
      ('sales_invoices'),
      ('delivery_challans'),
      ('credit_notes'),
      ('material_returns'),
      ('stock_rejections'),
      ('purchase_orders'),
      ('payment_vouchers'),
      ('receipt_vouchers'),
      ('purchase_invoices'),
      ('sales_orders')
    ) AS t(tbl)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = v_table
    ) THEN
      CONTINUE;
    END IF;

    -- Surgical patch: copy company_logo_url from the profile that was
    -- referenced at snapshot time. Only touches rows where the logo is
    -- missing AND the profile now has one. All other snapshot fields
    -- (name, address, tax_id, totals, etc.) are untouched.
    EXECUTE format($f$
      UPDATE public.%1$I t
      SET company_snapshot = jsonb_set(
        t.company_snapshot,
        '{company_logo_url}',
        to_jsonb(p.company_logo_url)
      )
      FROM public.company_profiles p
      WHERE t.company_snapshot IS NOT NULL
        AND t.company_snapshot->>'id' IS NOT NULL
        AND (t.company_snapshot->>'company_logo_url') IS NULL
        AND p.id = (t.company_snapshot->>'id')::uuid
        AND p.company_logo_url IS NOT NULL
    $f$, v_table);

    GET DIAGNOSTICS v_updated = ROW_COUNT;
    v_total := v_total + v_updated;

    IF v_updated > 0 THEN
      RAISE NOTICE 'logo backfill: % rows patched in %.', v_updated, v_table;
    END IF;
  END LOOP;

  RAISE NOTICE 'Snapshot logo backfill complete. % row(s) patched in total.', v_total;
END $$;

-- Spot-check: report any rows that still have a NULL logo after the backfill.
-- This only happens when the referenced profile itself still has no logo,
-- which means the upload must be completed first.
DO $$
DECLARE
  v_table text;
  v_cnt   int;
BEGIN
  FOR v_table IN
    SELECT * FROM (VALUES
      ('sales_invoices'),
      ('delivery_challans'),
      ('credit_notes'),
      ('material_returns'),
      ('stock_rejections'),
      ('purchase_orders'),
      ('payment_vouchers'),
      ('receipt_vouchers'),
      ('purchase_invoices'),
      ('sales_orders')
    ) AS t(tbl)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = v_table
    ) THEN
      CONTINUE;
    END IF;

    EXECUTE format(
      'SELECT COUNT(*) FROM public.%I WHERE company_snapshot IS NOT NULL AND (company_snapshot->>''company_logo_url'') IS NULL',
      v_table
    ) INTO v_cnt;

    IF v_cnt > 0 THEN
      RAISE WARNING '% row(s) in % still have no logo in company_snapshot — the referenced company_profiles row may itself have no logo yet.',
        v_cnt, v_table;
    END IF;
  END LOOP;
END $$;

NOTIFY pgrst, 'reload schema';

COMMIT;
