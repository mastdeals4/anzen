/*
  # Fix gmail_processed_messages duplicate entries
  
  ## Problem
  - 365 duplicate message IDs exist in gmail_processed_messages
  - No unique constraint was enforced, allowing same email to be re-processed
  - This causes the same 5 contacts to appear every run
  
  ## Changes
  1. Remove duplicate rows (keep most recent)
  2. Add unique constraint on (connection_id, gmail_message_id) to prevent future duplicates
*/

-- Remove duplicates keeping the most recent entry
DELETE FROM gmail_processed_messages
WHERE id NOT IN (
  SELECT DISTINCT ON (connection_id, gmail_message_id) id
  FROM gmail_processed_messages
  ORDER BY connection_id, gmail_message_id, created_at DESC
);

-- Now add unique constraint to prevent future duplicates
ALTER TABLE gmail_processed_messages
DROP CONSTRAINT IF EXISTS gmail_processed_messages_connection_gmail_unique;

ALTER TABLE gmail_processed_messages
ADD CONSTRAINT gmail_processed_messages_connection_gmail_unique 
UNIQUE (connection_id, gmail_message_id);
