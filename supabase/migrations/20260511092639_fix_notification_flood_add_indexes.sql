/*
  # Add notification deduplication indexes

  1. Partial unique index: at most ONE unread notification per (user_id, type, message)
     Enables ON CONFLICT DO NOTHING to prevent race-condition duplicates from multiple tabs.

  2. Daily dedup unique index for recurring types (low_stock, follow_up, near_expiry):
     at most ONE notification per (user_id, type, day). After mark-as-read, no new
     notification of the same type will be created until the next calendar day.
*/

CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_unique_unread
  ON notifications (user_id, type, message)
  WHERE is_read = false;

CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_daily_dedup
  ON notifications (user_id, type, DATE(created_at AT TIME ZONE 'Asia/Jakarta'))
  WHERE type IN ('low_stock', 'follow_up', 'near_expiry');
