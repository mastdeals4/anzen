/*
  # Add Rejection Fields to Delivery Challans

  ## Summary
  Adds rejection tracking fields to delivery_challans table to support
  the approval/rejection workflow for delivery challans.

  ## Changes
  - Add `rejected_by` (uuid, foreign key to auth.users) - User who rejected the challan
  - Add `rejected_at` (timestamptz, nullable) - When the challan was rejected
  - Add `rejection_reason` (text, nullable) - Reason for rejection

  ## Security
  - Uses existing RLS policies on delivery_challans table
*/

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'delivery_challans' AND column_name = 'rejected_by'
  ) THEN
    ALTER TABLE delivery_challans ADD COLUMN rejected_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'delivery_challans' AND column_name = 'rejected_at'
  ) THEN
    ALTER TABLE delivery_challans ADD COLUMN rejected_at timestamptz;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'delivery_challans' AND column_name = 'rejection_reason'
  ) THEN
    ALTER TABLE delivery_challans ADD COLUMN rejection_reason text;
  END IF;
END $$;

COMMENT ON COLUMN delivery_challans.rejected_by IS 'User who rejected the delivery challan';
COMMENT ON COLUMN delivery_challans.rejected_at IS 'Timestamp when the challan was rejected';
COMMENT ON COLUMN delivery_challans.rejection_reason IS 'Reason provided for rejecting the challan';
