/*
  # Add Gmail Processed Messages Tracking

  1. New Tables
    - `gmail_processed_messages`
      - `id` (uuid, primary key)
      - `user_id` (uuid, references auth.users)
      - `connection_id` (uuid, references gmail_connections)
      - `gmail_message_id` (text, unique per connection)
      - `processed_at` (timestamptz)
      - `contacts_extracted` (integer)
      - `extraction_data` (jsonb)
      
  2. Changes
    - Tracks which Gmail messages have been processed for contact extraction
    - Prevents duplicate processing of same emails
    - Stores extraction results for audit trail
    
  3. Security
    - Enable RLS
    - Users can only access their own processed messages
*/

CREATE TABLE IF NOT EXISTS gmail_processed_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  connection_id uuid REFERENCES gmail_connections(id) ON DELETE CASCADE NOT NULL,
  gmail_message_id text NOT NULL,
  processed_at timestamptz DEFAULT now() NOT NULL,
  contacts_extracted integer DEFAULT 0,
  extraction_data jsonb,
  created_at timestamptz DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_gmail_processed_unique 
  ON gmail_processed_messages(connection_id, gmail_message_id);

CREATE INDEX IF NOT EXISTS idx_gmail_processed_user 
  ON gmail_processed_messages(user_id);

CREATE INDEX IF NOT EXISTS idx_gmail_processed_connection 
  ON gmail_processed_messages(connection_id);

ALTER TABLE gmail_processed_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own processed messages"
  ON gmail_processed_messages FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own processed messages"
  ON gmail_processed_messages FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own processed messages"
  ON gmail_processed_messages FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own processed messages"
  ON gmail_processed_messages FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);