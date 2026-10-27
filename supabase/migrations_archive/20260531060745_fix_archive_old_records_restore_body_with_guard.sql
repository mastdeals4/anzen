/*
  # Restore archive_old_records with role guard

  The previous migration replaced the function body with a stub.
  This restores the original purge logic and adds the admin-only guard.
*/

CREATE OR REPLACE FUNCTION public.archive_old_records()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_role text;
  v_notifications_deleted integer := 0;
  v_gmail_deleted integer := 0;
BEGIN
  SELECT role INTO v_role FROM user_profiles WHERE id = auth.uid();
  IF v_role NOT IN ('admin') THEN
    RAISE EXCEPTION 'Permission denied: only admin can archive old records';
  END IF;

  DELETE FROM notifications
  WHERE is_read = true
    AND created_at < now() - interval '90 days';
  GET DIAGNOSTICS v_notifications_deleted = ROW_COUNT;

  DELETE FROM notifications
  WHERE is_read = false
    AND created_at < now() - interval '180 days';

  DELETE FROM gmail_processed_messages
  WHERE created_at < now() - interval '60 days';
  GET DIAGNOSTICS v_gmail_deleted = ROW_COUNT;

  RETURN jsonb_build_object(
    'notifications_deleted', v_notifications_deleted,
    'gmail_processed_deleted', v_gmail_deleted,
    'archived_at', now()
  );
END;
$$;
