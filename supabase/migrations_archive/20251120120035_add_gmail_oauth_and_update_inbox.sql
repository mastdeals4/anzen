/*
  # Gmail OAuth2 Integration - Update Existing Tables

  1. New Table
    - `gmail_connections` - Store OAuth2 credentials

  2. Updates to Existing Table
    - Add gmail_connection_id to crm_email_inbox
    - Rename email_id to message_id for consistency

  3. Security
    - Enable RLS on gmail_connections
    - Update RLS policies for crm_email_inbox
*/

-- Create gmail_connections table
CREATE TABLE IF NOT EXISTS gmail_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  email_address text NOT NULL,
  access_token text,
  refresh_token text,
  access_token_expires_at timestamptz,
  is_connected boolean DEFAULT true,
  sync_enabled boolean DEFAULT true,
  last_sync timestamptz,
  sync_frequency_minutes integer DEFAULT 10,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(user_id, email_address)
);

-- Add gmail_connection_id to crm_email_inbox if not exists
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'crm_email_inbox' AND column_name = 'gmail_connection_id'
  ) THEN
    ALTER TABLE crm_email_inbox ADD COLUMN gmail_connection_id uuid REFERENCES gmail_connections(id) ON DELETE CASCADE;
  END IF;
END $$;

-- Add body_html column if not exists
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'crm_email_inbox' AND column_name = 'body_html'
  ) THEN
    ALTER TABLE crm_email_inbox ADD COLUMN body_html text;
  END IF;
END $$;

-- Add labels column if not exists
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'crm_email_inbox' AND column_name = 'labels'
  ) THEN
    ALTER TABLE crm_email_inbox ADD COLUMN labels text[];
  END IF;
END $$;

-- Rename email_id to message_id for consistency (only if not already done)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'crm_email_inbox' AND column_name = 'email_id'
  ) THEN
    ALTER TABLE crm_email_inbox RENAME COLUMN email_id TO message_id;
  END IF;
END $$;

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_gmail_connections_user_id ON gmail_connections(user_id);
CREATE INDEX IF NOT EXISTS idx_gmail_connections_sync ON gmail_connections(sync_enabled, is_connected);
CREATE INDEX IF NOT EXISTS idx_email_inbox_gmail_connection ON crm_email_inbox(gmail_connection_id);
CREATE INDEX IF NOT EXISTS idx_email_inbox_message_id ON crm_email_inbox(message_id);
CREATE INDEX IF NOT EXISTS idx_email_inbox_processed ON crm_email_inbox(is_processed);

-- Enable RLS
ALTER TABLE gmail_connections ENABLE ROW LEVEL SECURITY;

-- RLS Policies for gmail_connections
DROP POLICY IF EXISTS "Users can view own Gmail connections" ON gmail_connections;
DROP POLICY IF EXISTS "Users can insert own Gmail connections" ON gmail_connections;
DROP POLICY IF EXISTS "Users can update own Gmail connections" ON gmail_connections;
DROP POLICY IF EXISTS "Users can delete own Gmail connections" ON gmail_connections;

CREATE POLICY "Users can view own Gmail connections"
  ON gmail_connections FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own Gmail connections"
  ON gmail_connections FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own Gmail connections"
  ON gmail_connections FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own Gmail connections"
  ON gmail_connections FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_gmail_connection_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to auto-update updated_at
DROP TRIGGER IF EXISTS update_gmail_connections_updated_at ON gmail_connections;
CREATE TRIGGER update_gmail_connections_updated_at
  BEFORE UPDATE ON gmail_connections
  FOR EACH ROW
  EXECUTE FUNCTION update_gmail_connection_updated_at();
