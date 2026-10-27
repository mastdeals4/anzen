-- Fix petty cash documents RLS policies for insert/update/delete

-- Drop existing policies
DROP POLICY IF EXISTS "Admin and accounts can insert petty cash documents" ON petty_cash_documents;
DROP POLICY IF EXISTS "Admin and accounts can delete petty cash documents" ON petty_cash_documents;

-- Recreate with simpler, working policies
CREATE POLICY "Authenticated users can insert petty cash documents"
  ON petty_cash_documents FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "Authenticated users can delete petty cash documents"
  ON petty_cash_documents FOR DELETE
  TO authenticated
  USING (true);
