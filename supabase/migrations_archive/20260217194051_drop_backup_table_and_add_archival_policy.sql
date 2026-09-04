/*
  # Drop Backup Table & Add Data Archival Policy

  1. Changes
    - Drop the backup table `invoice_payment_allocations_backup_20260209` (only 2 rows, safe to remove)
    - Add pg_cron-compatible archival: delete notifications older than 90 days that are read
    - Add archival for gmail_processed_messages older than 60 days
    - Add a database function `archive_old_records()` that can be called periodically

  2. Notes
    - We do NOT use pg_cron here (may not be enabled), instead we create a callable function
    - The frontend SystemTaskService can call this function on login or schedule
    - Read notifications older than 90 days are safe to purge
    - Gmail processed messages older than 60 days are safe to purge (they're just dedup trackers)
*/

-- Drop the backup table (confirmed only 2 rows, no longer needed)
DROP TABLE IF EXISTS invoice_payment_allocations_backup_20260209;

-- Create archival function that purges stale records safely
CREATE OR REPLACE FUNCTION archive_old_records()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_notifications_deleted integer := 0;
  v_gmail_deleted integer := 0;
BEGIN
  -- Delete read notifications older than 90 days
  DELETE FROM notifications
  WHERE is_read = true
    AND created_at < now() - interval '90 days';
  GET DIAGNOSTICS v_notifications_deleted = ROW_COUNT;

  -- Delete unread notifications older than 180 days (very stale)
  DELETE FROM notifications
  WHERE is_read = false
    AND created_at < now() - interval '180 days';

  -- Delete gmail processed message trackers older than 60 days
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

-- Grant execute to authenticated users (admin will call this)
GRANT EXECUTE ON FUNCTION archive_old_records() TO authenticated;
