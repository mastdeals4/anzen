/*
  # Create upsert_notification RPC

  1. Purpose
    - Replaces direct INSERT into notifications from the frontend
    - Uses INSERT ... ON CONFLICT DO NOTHING at SQL level
    - Returns 200 (not 409) when a duplicate is silently skipped
    - Eliminates the browser console flood of 409 errors

  2. Conflict handling
    - If the unique index `idx_notifications_daily_dedup` or
      `idx_notifications_unique_unread` would fire, the insert is silently skipped
    - Returns true if inserted, false if skipped
*/

CREATE OR REPLACE FUNCTION public.upsert_notification(
  p_user_id       uuid,
  p_type          text,
  p_title         text,
  p_message       text,
  p_reference_id  text DEFAULT NULL,
  p_reference_type text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_inserted boolean := false;
BEGIN
  INSERT INTO notifications (user_id, type, title, message, reference_id, reference_type, is_read)
  VALUES (p_user_id, p_type, p_title, p_message, p_reference_id, p_reference_type, false)
  ON CONFLICT DO NOTHING;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN v_inserted > 0;
EXCEPTION
  WHEN unique_violation THEN
    RETURN false;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.upsert_notification TO authenticated;
