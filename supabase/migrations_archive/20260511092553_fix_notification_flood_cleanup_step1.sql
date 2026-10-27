/*
  # Clean up notification flood - Step 1

  Delete all duplicate notifications keeping only the newest per (user_id, type, message, is_read).
  This covers both read and unread duplicates.
*/

-- Delete duplicate unread notifications (keep newest per user+type+message)
DELETE FROM notifications
WHERE id NOT IN (
  SELECT DISTINCT ON (user_id, type, message, is_read) id
  FROM notifications
  ORDER BY user_id, type, message, is_read, created_at DESC
);
