/*
  # Fix Petty Cash RLS Policies

  1. Changes
    - Fix INSERT policy for petty_cash_documents to allow accounts/admin
    - Fix DELETE policy to use correct profiles table
    - Allow accounts role to delete petty cash transactions
  
  2. Security
    - Only admin and accounts can insert documents
    - Only admin and accounts can delete transactions
    - All authenticated users can view
*/

-- Fix petty_cash_documents INSERT policy
DROP POLICY IF EXISTS "Users can upload petty cash documents" ON petty_cash_documents;
DROP POLICY IF EXISTS "Admin and accounts can insert petty cash documents" ON petty_cash_documents;

CREATE POLICY "Admin and accounts can insert petty cash documents"
  ON petty_cash_documents FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role IN ('admin', 'accounts')
    )
  );

-- Fix petty_cash_transactions DELETE policy to use profiles table
DROP POLICY IF EXISTS "Admin can delete petty cash transactions" ON petty_cash_transactions;

CREATE POLICY "Admin and accounts can delete petty cash transactions"
  ON petty_cash_transactions FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role IN ('admin', 'accounts')
    )
  );

-- Fix petty_cash_documents DELETE policy
DROP POLICY IF EXISTS "Admin can delete petty cash documents" ON petty_cash_documents;

CREATE POLICY "Admin and accounts can delete petty cash documents"
  ON petty_cash_documents FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role IN ('admin', 'accounts')
    )
  );
