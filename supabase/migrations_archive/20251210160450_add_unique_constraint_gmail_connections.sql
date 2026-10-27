/*
  # Add Unique Constraint to Gmail Connections

  1. Changes
    - Add unique constraint on user_id to ensure one Gmail account per user
    - Clean up any duplicate connections
  
  2. Security
    - No changes to RLS policies
*/

-- Clean up duplicates first (keep most recent)
WITH ranked_connections AS (
  SELECT 
    id,
    user_id,
    ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY created_at DESC) as rn
  FROM gmail_connections
)
DELETE FROM gmail_connections
WHERE id IN (
  SELECT id FROM ranked_connections WHERE rn > 1
);

-- Add unique constraint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint 
    WHERE conname = 'gmail_connections_user_id_key'
  ) THEN
    ALTER TABLE gmail_connections 
    ADD CONSTRAINT gmail_connections_user_id_key UNIQUE (user_id);
  END IF;
END $$;
