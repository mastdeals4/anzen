/*
  # Fix Petty Cash Transaction Delete Policy

  1. Changes
    - Fix DELETE policy on petty_cash_transactions to use user_profiles instead of profiles (consistency)
    - This ensures delete operations work correctly for admin and accounts roles

  2. Security
    - Maintains role-based access control
    - Only admin and accounts roles can delete petty cash transactions
*/

-- Drop old policy
DROP POLICY IF EXISTS "Admin and accounts can delete petty cash transactions" ON petty_cash_transactions;

-- Create corrected policy using user_profiles
CREATE POLICY "Admin and accounts can delete petty cash transactions"
  ON petty_cash_transactions
  FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM user_profiles
      WHERE user_profiles.id = auth.uid()
      AND user_profiles.role = ANY(ARRAY['admin', 'accounts'])
    )
  );
