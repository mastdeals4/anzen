/*
  # Fix duplicate unique indexes on gmail_processed_messages
  
  Two unique indexes exist on (connection_id, gmail_message_id):
  - idx_gmail_processed_unique (original)
  - gmail_processed_messages_connection_gmail_unique (newly added, duplicate)
  
  Drop the new duplicate and keep the original one.
*/

ALTER TABLE gmail_processed_messages
DROP CONSTRAINT IF EXISTS gmail_processed_messages_connection_gmail_unique;
