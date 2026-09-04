-- ============================================================================
-- Fix notification 409 / race-condition duplicate key errors
-- ============================================================================
-- Root cause: generate_tax_notifications() uses WHERE NOT EXISTS (...) to
-- deduplicate. Under concurrent calls (multiple browser tabs, 10-min timer
-- overlapping with a fresh page load), both callers pass the NOT EXISTS check
-- before either commits, then the second INSERT violates
-- idx_notifications_unique_unread (user_id, type, message) WHERE is_read=false.
--
-- Fix: replace WHERE NOT EXISTS with ON CONFLICT DO NOTHING on all three
-- INSERT statements.  Also re-affirm upsert_notification's ON CONFLICT DO
-- NOTHING in case the earlier boolean-operator fix migration wasn't applied.
-- ============================================================================

-- ── 1. Harden upsert_notification (idempotent re-create) ─────────────────────
DROP FUNCTION IF EXISTS public.upsert_notification(uuid, text, text, text, text, text);
DROP FUNCTION IF EXISTS public.upsert_notification(uuid, text, text, text, uuid, text);

CREATE OR REPLACE FUNCTION public.upsert_notification(
  p_user_id       uuid,
  p_type          text,
  p_title         text,
  p_message       text,
  p_reference_id  uuid DEFAULT NULL,
  p_reference_type text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_inserted integer := 0;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  INSERT INTO notifications (user_id, type, title, message, reference_id, reference_type, is_read)
  VALUES (p_user_id, p_type, p_title, p_message, p_reference_id, p_reference_type, false)
  ON CONFLICT DO NOTHING;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN v_inserted > 0;
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_notification(uuid, text, text, text, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.upsert_notification(uuid, text, text, text, uuid, text) TO authenticated;

-- ── 2. Fix generate_tax_notifications: ON CONFLICT DO NOTHING everywhere ──────
CREATE OR REPLACE FUNCTION public.generate_tax_notifications()
RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user record;
  v_row  record;
  v_count int := 0;
  v_today           date := CURRENT_DATE;
  v_upcoming_cutoff date := CURRENT_DATE + 7;
BEGIN
  FOR v_user IN
    SELECT id FROM user_profiles
    WHERE is_active = true AND role IN ('admin','manager','accounts')
  LOOP
    -- Overdue tax payments
    FOR v_row IN
      SELECT tax_period_id, tax_type, payment_due_date, outstanding_amount
      FROM vw_outstanding_tax
      WHERE payment_due_date < v_today AND outstanding_amount > 0
    LOOP
      INSERT INTO notifications (user_id, type, title, message, reference_id, reference_type, is_read)
      VALUES (
        v_user.id,
        'tax_overdue',
        v_row.tax_type || ' payment overdue',
        format('Rp %s outstanding, due %s',
          to_char(v_row.outstanding_amount, 'FM999G999G999G999D00'),
          to_char(v_row.payment_due_date, 'DD Mon YYYY')),
        v_row.tax_period_id,
        'tax_period',
        false
      )
      ON CONFLICT DO NOTHING;
      v_count := v_count + 1;
    END LOOP;

    -- Upcoming tax payments (next 7 days)
    FOR v_row IN
      SELECT tax_period_id, tax_type, payment_due_date, outstanding_amount
      FROM vw_outstanding_tax
      WHERE payment_due_date BETWEEN v_today AND v_upcoming_cutoff
        AND outstanding_amount > 0
    LOOP
      INSERT INTO notifications (user_id, type, title, message, reference_id, reference_type, is_read)
      VALUES (
        v_user.id,
        'tax_due_soon',
        v_row.tax_type || ' payment due',
        format('Rp %s due on %s',
          to_char(v_row.outstanding_amount, 'FM999G999G999G999D00'),
          to_char(v_row.payment_due_date, 'DD Mon YYYY')),
        v_row.tax_period_id,
        'tax_period',
        false
      )
      ON CONFLICT DO NOTHING;
      v_count := v_count + 1;
    END LOOP;

    -- Missing Faktur Pajak on open PPN periods
    FOR v_row IN
      SELECT id AS tax_period_id, fiscal_year, period_month, missing_faktur_count
      FROM vw_tax_period_status
      WHERE tax_type = 'PPN' AND status <> 'closed' AND missing_faktur_count > 0
    LOOP
      INSERT INTO notifications (user_id, type, title, message, reference_id, reference_type, is_read)
      VALUES (
        v_user.id,
        'faktur_missing',
        'Waiting for Faktur',
        format('%s sales invoice(s) in %s-%s need a Faktur Pajak number',
          v_row.missing_faktur_count,
          v_row.fiscal_year,
          lpad(v_row.period_month::text, 2, '0')),
        v_row.tax_period_id,
        'tax_period',
        false
      )
      ON CONFLICT DO NOTHING;
      v_count := v_count + 1;
    END LOOP;
  END LOOP;

  RETURN v_count;
END $$;

REVOKE ALL ON FUNCTION public.generate_tax_notifications() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.generate_tax_notifications() TO authenticated;
