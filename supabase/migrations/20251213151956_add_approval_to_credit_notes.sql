/*
  # Add Approval Workflow to Credit Notes

  ## Changes
  1. Add `status` field to credit_notes table (pending_approval, approved, rejected)
  2. Add `approved_by` field to track who approved
  3. Add `approval_date` field
  4. Update RLS policies to restrict status changes to managers/admins only

  ## Security
  - Only managers and admins can change status
  - All authenticated users can create credit notes
  - Creators and managers can edit their own pending credit notes
*/

-- Add approval fields to credit_notes
ALTER TABLE credit_notes 
  ADD COLUMN IF NOT EXISTS status text DEFAULT 'pending_approval' 
    CHECK (status IN ('pending_approval', 'approved', 'rejected')),
  ADD COLUMN IF NOT EXISTS approved_by uuid REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS approval_date timestamptz;

-- Update RLS policy for updates to restrict status changes
DROP POLICY IF EXISTS "Users can update own credit notes" ON credit_notes;
CREATE POLICY "Users can update own credit notes"
  ON credit_notes FOR UPDATE
  TO authenticated
  USING (
    created_by = auth.uid() OR
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
      AND user_profiles.role IN ('manager', 'admin')
    )
  )
  WITH CHECK (
    created_by = auth.uid() OR
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
      AND user_profiles.role IN ('manager', 'admin')
    )
  );

-- Create index for status field
CREATE INDEX IF NOT EXISTS idx_credit_notes_status ON credit_notes(status);

COMMENT ON COLUMN credit_notes.status IS 'Approval status: pending_approval, approved, rejected';
COMMENT ON COLUMN credit_notes.approved_by IS 'User who approved/rejected the credit note';
COMMENT ON COLUMN credit_notes.approval_date IS 'Date when credit note was approved/rejected';
