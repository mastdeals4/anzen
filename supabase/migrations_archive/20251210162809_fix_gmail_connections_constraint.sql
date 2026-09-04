/*
  # Fix Gmail Connections Unique Constraint

  Remove duplicate UNIQUE (user_id) constraint that conflicts with the new one.
  Keep only UNIQUE (user_id, email_address) for flexibility.
*/

ALTER TABLE gmail_connections
DROP CONSTRAINT IF EXISTS gmail_connections_user_id_key;
