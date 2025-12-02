/*
  # Notifications and Financial Year System

  1. New Tables
    - `notifications`
      - `id` (uuid, primary key)
      - `user_id` (uuid, references auth.users)
      - `type` (text) - Type of notification (low_stock, near_expiry, pending_invoice, follow_up)
      - `title` (text) - Notification title
      - `message` (text) - Notification message
      - `reference_id` (uuid, nullable) - ID of related record
      - `reference_type` (text, nullable) - Type of related record
      - `is_read` (boolean) - Read status
      - `created_at` (timestamptz)
      - `read_at` (timestamptz, nullable)

  2. Schema Changes
    - Add financial year fields to `app_settings` table
      - `financial_year_start` (text) - Format: YYYY-MM-DD
      - `financial_year_end` (text) - Format: YYYY-MM-DD
      - `current_financial_year` (text) - Format: YYYY

  3. Security
    - Enable RLS on `notifications` table
    - Add policies for users to read their own notifications
    - Add policies for system to create notifications
*/

-- Create notifications table
CREATE TABLE IF NOT EXISTS notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  type text NOT NULL,
  title text NOT NULL,
  message text NOT NULL,
  reference_id uuid,
  reference_type text,
  is_read boolean DEFAULT false,
  created_at timestamptz DEFAULT now(),
  read_at timestamptz
);

-- Add indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_is_read ON notifications(is_read);
CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_user_read ON notifications(user_id, is_read);

-- Enable RLS
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

-- Policies for notifications
CREATE POLICY "Users can view own notifications"
  ON notifications FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users can update own notifications"
  ON notifications FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "System can create notifications"
  ON notifications FOR INSERT
  TO authenticated
  WITH CHECK (true);

-- Add financial year fields to app_settings if they don't exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'app_settings' AND column_name = 'financial_year_start'
  ) THEN
    ALTER TABLE app_settings ADD COLUMN financial_year_start text DEFAULT '2024-01-01';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'app_settings' AND column_name = 'financial_year_end'
  ) THEN
    ALTER TABLE app_settings ADD COLUMN financial_year_end text DEFAULT '2024-12-31';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'app_settings' AND column_name = 'current_financial_year'
  ) THEN
    ALTER TABLE app_settings ADD COLUMN current_financial_year text DEFAULT '2024';
  END IF;
END $$;