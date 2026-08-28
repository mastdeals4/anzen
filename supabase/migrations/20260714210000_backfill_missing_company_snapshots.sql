-- ============================================================================
-- Backfill missing / incomplete company_snapshot values
-- ============================================================================
-- Views now refuse to render a business document when its company_snapshot
-- is NULL — silently substituting FALLBACK_COMPANY would misrepresent the
-- document. This migration heals every document whose snapshot is missing
-- or badly incomplete (no company_name and no id) by stamping the profile
-- that would have been "current" on the document's own business date.
--
-- Strict never-overwrite rule: any snapshot that already carries a
-- company_name AND an id is treated as valid and is left untouched.
-- Historical documents keep byte-for-byte what they were originally
-- stamped with.
--
-- Tables covered — every table that receives auto_snapshot_company_profile
-- via 20260713230000 + 20260713240000 + 20260714120000:
--   sales_invoices     (invoice_date)
--   delivery_challans  (challan_date)
--   credit_notes       (credit_note_date)
--   material_returns   (return_date)
--   stock_rejections   (rejection_date)
--   purchase_orders    (order_date)
--   payment_vouchers   (voucher_date)
--   receipt_vouchers   (voucher_date)
--   purchase_invoices  (invoice_date)
--   sales_orders       (so_date)
--
-- Two passes per table:
--   Pass 1 — date-aware lookup: profile with the greatest
--            effective_from <= <business_date>.
--   Pass 2 — orphan fallback: for the tiny handful of rows whose date
--            predates the earliest profile, use the earliest profile.
--            Without this, they'd still fail the snapshot check.
--
-- Idempotent. Additive. No schema changes.
-- ============================================================================

BEGIN;

DO $$
DECLARE
  v_table   text;
  v_date    text;
  v_pair    record;
  v_updated int := 0;
  v_total   int := 0;
BEGIN
  FOR v_pair IN
    SELECT * FROM (VALUES
      ('sales_invoices',    'invoice_date'),
      ('delivery_challans', 'challan_date'),
      ('credit_notes',      'credit_note_date'),
      ('material_returns',  'return_date'),
      ('stock_rejections',  'rejection_date'),
      ('purchase_orders',   'po_date'),
      ('payment_vouchers',  'voucher_date'),
      ('receipt_vouchers',  'voucher_date'),
      ('purchase_invoices', 'invoice_date'),
      ('sales_orders',      'so_date')
    ) AS t(table_name, date_col)
  LOOP
    v_table := v_pair.table_name;
    v_date  := v_pair.date_col;

    -- Skip if the table doesn't exist in this environment.
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = v_table
    ) THEN
      CONTINUE;
    END IF;

    -- Pass 1 — date-aware stamp using the profile that was current on
    -- the business date. WHERE clause uses "missing OR incomplete":
    --   company_snapshot IS NULL
    --   or company_snapshot->>'id' IS NULL
    --   or company_snapshot->>'company_name' IS NULL
    -- so partially-populated JSONB (rare) is also healed.
    EXECUTE format($f$
      UPDATE public.%1$I t
      SET company_snapshot = (
        SELECT to_jsonb(p)
        FROM public.company_profiles p
        WHERE p.effective_from <= t.%2$I
        ORDER BY p.effective_from DESC
        LIMIT 1
      )
      WHERE (t.company_snapshot IS NULL
             OR t.company_snapshot->>'id' IS NULL
             OR t.company_snapshot->>'company_name' IS NULL)
        AND t.%2$I IS NOT NULL
    $f$, v_table, v_date);
    GET DIAGNOSTICS v_updated = ROW_COUNT;
    v_total := v_total + v_updated;
    IF v_updated > 0 THEN
      RAISE NOTICE 'backfill pass 1: %.% rows stamped from % (date-aware).', v_table, v_updated, v_date;
    END IF;

    -- Pass 2 — orphan fallback for rows whose business date predates
    -- the earliest profile (or whose date is NULL). Use the earliest
    -- profile so the field is never NULL after this migration.
    EXECUTE format($f$
      UPDATE public.%1$I t
      SET company_snapshot = (
        SELECT to_jsonb(p)
        FROM public.company_profiles p
        ORDER BY p.effective_from ASC
        LIMIT 1
      )
      WHERE t.company_snapshot IS NULL
         OR t.company_snapshot->>'id' IS NULL
         OR t.company_snapshot->>'company_name' IS NULL
    $f$, v_table);
    GET DIAGNOSTICS v_updated = ROW_COUNT;
    v_total := v_total + v_updated;
    IF v_updated > 0 THEN
      RAISE NOTICE 'backfill pass 2: %.% rows stamped from earliest profile (orphan fallback).', v_table, v_updated;
    END IF;
  END LOOP;

  RAISE NOTICE 'Company snapshot backfill complete. % row(s) healed in total.', v_total;
END $$;

-- Report any still-NULL rows so operators know which docs need manual
-- attention (this only happens if the company_profiles table itself is
-- empty, which is a genuine setup error).
DO $$
DECLARE
  v_pair record;
  v_orphan_count int;
BEGIN
  FOR v_pair IN
    SELECT * FROM (VALUES
      ('sales_invoices',    'invoice_number'),
      ('delivery_challans', 'challan_number'),
      ('credit_notes',      'credit_note_number'),
      ('material_returns',  'return_number'),
      ('stock_rejections',  'rejection_number'),
      ('purchase_orders',   'po_number'),
      ('payment_vouchers',  'voucher_number'),
      ('receipt_vouchers',  'voucher_number'),
      ('purchase_invoices', 'invoice_number'),
      ('sales_orders',      'so_number')
    ) AS t(table_name, num_col)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = v_pair.table_name
    ) THEN CONTINUE; END IF;

    EXECUTE format('SELECT COUNT(*) FROM public.%I WHERE company_snapshot IS NULL', v_pair.table_name)
      INTO v_orphan_count;
    IF v_orphan_count > 0 THEN
      RAISE WARNING '%.% row(s) still have NULL company_snapshot after backfill — check that public.company_profiles has at least one row.',
        v_pair.table_name, v_orphan_count;
    END IF;
  END LOOP;
END $$;

NOTIFY pgrst, 'reload schema';

COMMIT;
