/*
  # Clean up notification flood - Step 2

  For daily notification types (low_stock, follow_up, near_expiry),
  keep only 1 notification per user per type per calendar day.
  Prefer unread rows if there's a choice, then newest.
*/

DELETE FROM notifications
WHERE type IN ('low_stock', 'follow_up', 'near_expiry')
  AND id NOT IN (
    SELECT DISTINCT ON (user_id, type, DATE(created_at AT TIME ZONE 'Asia/Jakarta')) id
    FROM notifications
    WHERE type IN ('low_stock', 'follow_up', 'near_expiry')
    ORDER BY user_id, type, DATE(created_at AT TIME ZONE 'Asia/Jakarta'),
             is_read ASC,  -- prefer unread (false < true)
             created_at DESC
  );
