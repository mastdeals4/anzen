-- ============================================================================
-- Temporary Setup Mode + one-off deletion of test Sales Order SO-2026-0048
-- ============================================================================
-- The Company Profile Versioning protections (introduced in
-- 20260714140000_company_profile_edit_delete_support.sql) are production-
-- appropriate but block ERP configuration during the current
-- implementation and testing phase.
--
-- This migration adds a single, admin-controlled feature flag —
-- app_settings.setup_mode — that lets us configure the ERP without
-- weakening the production protections. When the flag flips off, the
-- existing guards are back to full strength with no code changes needed.
--
-- Contents:
--   1. Add app_settings.setup_mode boolean (default false = Production Mode).
--   2. Add public.is_setup_mode() helper — reads the flag safely.
--   3. Extend protect_historical_company_profile trigger to no-op when
--      Setup Mode is on. Notes-only updates already flow; Setup Mode also
--      allows name / logo / stamp / NPWP / effective_from edits AND
--      deletion of referenced profiles.
--   4. Extend delete_company_profile RPC the same way.
--   5. Delete test Sales Order SO-2026-0048 cleanly, letting the pre-
--      existing FK cascades (sales_order_items → CASCADE) and set-nulls
--      (delivery_challans.sales_order_id / sales_invoices.sales_order_id
--      → SET NULL) do their work. Idempotent — no-op if the row is
--      already gone.
--
-- Additive-only. No production guards weakened. Setup Mode is off by
-- default, so applying this migration on a production instance changes
-- nothing until an admin explicitly enables it.
-- ============================================================================

BEGIN;

-- 1. Setup Mode flag on app_settings ------------------------------------------
ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS setup_mode boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.app_settings.setup_mode IS
  'Temporary implementation-phase flag. When true, historical Company Profile protections and other production audit guards are bypassed. Flip back to false before going live.';

-- 2. Helper: is_setup_mode() --------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_setup_mode()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public AS $$
  SELECT COALESCE((SELECT setup_mode FROM public.app_settings LIMIT 1), false);
$$;

REVOKE ALL     ON FUNCTION public.is_setup_mode() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.is_setup_mode() TO authenticated;

-- 3. Extend protect_historical_company_profile with Setup Mode bypass --------
-- Same reference-count semantics as 20260714140000; only difference is the
-- early return when is_setup_mode() is true.
CREATE OR REPLACE FUNCTION public.protect_historical_company_profile()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_ref_count bigint;
  v_target_id uuid;
BEGIN
  -- Setup Mode: skip every guard. Admins may edit / delete any profile.
  IF public.is_setup_mode() THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  v_target_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END;

  SELECT COALESCE(SUM(ref_count), 0) INTO v_ref_count
  FROM public.get_company_profile_reference_counts()
  WHERE profile_id = v_target_id;

  IF v_ref_count > 0 THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION
        'PROFILE_REFERENCED: This Company Profile is referenced by % business document(s) and cannot be deleted. '
        'Historical company identities must remain permanently available.',
        v_ref_count;
    ELSIF TG_OP = 'UPDATE' THEN
      IF (NEW.company_name       IS DISTINCT FROM OLD.company_name       OR
          NEW.company_legal_name IS DISTINCT FROM OLD.company_legal_name OR
          NEW.company_address    IS DISTINCT FROM OLD.company_address    OR
          NEW.company_phone      IS DISTINCT FROM OLD.company_phone      OR
          NEW.company_email      IS DISTINCT FROM OLD.company_email      OR
          NEW.company_website    IS DISTINCT FROM OLD.company_website    OR
          NEW.company_tax_id     IS DISTINCT FROM OLD.company_tax_id     OR
          NEW.company_logo_url   IS DISTINCT FROM OLD.company_logo_url   OR
          NEW.company_stamp_url  IS DISTINCT FROM OLD.company_stamp_url  OR
          NEW.pbf_license        IS DISTINCT FROM OLD.pbf_license        OR
          NEW.cdob_certificate   IS DISTINCT FROM OLD.cdob_certificate   OR
          NEW.effective_from     IS DISTINCT FROM OLD.effective_from) THEN
        RAISE EXCEPTION
          'PROFILE_REFERENCED: This Company Profile is referenced by % business document(s) and cannot be edited. '
          'Create a new profile version for future documents instead. Only the "notes" field may be updated.',
          v_ref_count;
      END IF;
    END IF;
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

-- Trigger definition itself is unchanged from 20260713240000 / 20260714140000.

-- 4. Extend delete_company_profile RPC with Setup Mode bypass ----------------
CREATE OR REPLACE FUNCTION public.delete_company_profile(p_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_ref_count bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.user_profiles WHERE id = auth.uid() AND role = 'admin') THEN
    RAISE EXCEPTION 'FORBIDDEN: Only admins may delete company profiles.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.company_profiles WHERE id = p_id) THEN
    RAISE EXCEPTION 'NOT_FOUND: Company profile does not exist.';
  END IF;

  -- Setup Mode: skip the reference-count check. The trigger above also
  -- no-ops in this mode, so the DELETE proceeds cleanly.
  IF NOT public.is_setup_mode() THEN
    SELECT COALESCE(SUM(ref_count), 0) INTO v_ref_count
    FROM public.get_company_profile_reference_counts()
    WHERE profile_id = p_id;

    IF v_ref_count > 0 THEN
      RAISE EXCEPTION
        'PROFILE_REFERENCED: This Company Profile is already referenced by % business document(s) and cannot be deleted. Historical company identities must remain permanently available.',
        v_ref_count;
    END IF;
  END IF;

  DELETE FROM public.company_profiles WHERE id = p_id;
END;
$$;

REVOKE ALL     ON FUNCTION public.delete_company_profile(uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.delete_company_profile(uuid) TO authenticated;

-- 5a. Consolidate fn_release_stock_reservations overloads -------------------
-- Migrations 20251128163039 and 20251129130712 left two conflicting overloads
-- in place:
--   (uuid, text)                    — the audit-rich version (writes an
--                                     inventory_transactions row per released
--                                     reservation, uses auth.uid()).
--   (uuid, text, uuid DEFAULT NULL) — the "pass-user-id" version (updates
--                                     released_by from param, but skips the
--                                     inventory_transactions insert).
-- Postgres can't pick a "best candidate" when trg_sales_order_deleted()
-- calls it with two positional args and an unknown-typed literal ("Sales
-- order deleted"), so ANY sales_orders DELETE throws 42725 and aborts —
-- which is exactly what blocks the SO-2026-0048 cleanup below.
--
-- Fix: drop both, then install a single consolidated function that keeps
-- BOTH behaviours: takes p_user_id as an optional third arg (defaulting to
-- auth.uid()), and still writes the inventory_transactions release rows.
DROP FUNCTION IF EXISTS public.fn_release_stock_reservations(uuid, text);
DROP FUNCTION IF EXISTS public.fn_release_stock_reservations(uuid, text, uuid);

CREATE OR REPLACE FUNCTION public.fn_release_stock_reservations(
  p_so_id   uuid,
  p_reason  text,
  p_user_id uuid DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_reservation RECORD;
  v_so_number   text;
  v_actor       uuid := COALESCE(p_user_id, auth.uid());
BEGIN
  SELECT so_number INTO v_so_number FROM sales_orders WHERE id = p_so_id;

  -- Emit an inventory_transactions release row per active reservation so
  -- Reports / drill-downs can trace the release event to a source doc.
  FOR v_reservation IN
    SELECT * FROM stock_reservations
    WHERE sales_order_id = p_so_id
      AND status = 'active'
  LOOP
    INSERT INTO inventory_transactions (
      product_id,
      batch_id,
      transaction_type,
      quantity,
      transaction_date,
      reference_number,
      notes,
      created_by
    ) VALUES (
      v_reservation.product_id,
      v_reservation.batch_id,
      'release_reservation',
      v_reservation.reserved_quantity,
      CURRENT_DATE,
      v_so_number,
      'Reservation released: ' || p_reason,
      v_actor
    );
  END LOOP;

  UPDATE stock_reservations
  SET status         = 'released',
      released_at    = now(),
      released_by    = v_actor,
      release_reason = p_reason
  WHERE sales_order_id = p_so_id
    AND status = 'active';

  RETURN true;
END;
$$;

REVOKE ALL     ON FUNCTION public.fn_release_stock_reservations(uuid, text, uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.fn_release_stock_reservations(uuid, text, uuid) TO authenticated;

-- 5b. Clean up the test Sales Order SO-2026-0048 -------------------------------
-- sales_order_items → CASCADE, delivery_challans.sales_order_id → SET NULL,
-- sales_invoices.sales_order_id → SET NULL, sales_order_advances → CASCADE.
-- Nothing else references sales_orders, so a plain DELETE is sufficient
-- once the overload above is unambiguous. Wrapped in DO so we can log
-- via RAISE NOTICE.
DO $$
DECLARE
  v_id     uuid;
  v_dc_cnt int;
  v_si_cnt int;
BEGIN
  SELECT id INTO v_id FROM public.sales_orders WHERE so_number = 'SO-2026-0048';

  IF v_id IS NULL THEN
    RAISE NOTICE 'SO-2026-0048 not found — nothing to delete (idempotent no-op).';
    RETURN;
  END IF;

  -- Count downstream test docs that will be unlinked (SET NULL) so the
  -- operator can see what happened. Not deleting them here — the user
  -- asked us to "remove OR unlink"; the pre-existing FKs already unlink,
  -- which is the non-destructive default for downstream data.
  SELECT COUNT(*) INTO v_dc_cnt FROM public.delivery_challans WHERE sales_order_id = v_id;
  SELECT COUNT(*) INTO v_si_cnt FROM public.sales_invoices    WHERE sales_order_id = v_id;

  DELETE FROM public.sales_orders WHERE id = v_id;

  RAISE NOTICE 'Deleted test Sales Order SO-2026-0048 (id=%). Unlinked % delivery challan(s), % invoice(s).',
    v_id, v_dc_cnt, v_si_cnt;
END $$;

NOTIFY pgrst, 'reload schema';

COMMIT;
