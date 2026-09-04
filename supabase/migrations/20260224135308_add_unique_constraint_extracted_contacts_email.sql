/*
  # Add unique constraint to extracted_contacts on email_ids per user
  
  Prevents duplicate contacts from being inserted for the same email address.
  Uses upsert-friendly constraint: one row per user_id + email_ids combination.
  
  Also deduplicates any existing rows by keeping the most recent one per email.
*/

DELETE FROM extracted_contacts
WHERE id NOT IN (
  SELECT DISTINCT ON (user_id, email_ids) id
  FROM extracted_contacts
  ORDER BY user_id, email_ids, created_at DESC
);

CREATE UNIQUE INDEX IF NOT EXISTS extracted_contacts_user_email_unique
  ON extracted_contacts (user_id, email_ids);
