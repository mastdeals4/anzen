/*
  # Optimize RLS Policies - Auth Function Initialization (Part 3)

  Final batch of RLS policy optimizations for better performance.

  ## Changes
  
  ### Petty Cash Documents
  - Optimized: Admin and accounts can insert petty cash documents
  - Optimized: Admin can delete petty cash documents
  
  ### Petty Cash Transactions
  - Optimized: Admin and accounts can insert petty cash transactions
  - Optimized: Admin and accounts can update petty cash transactions
  - Optimized: Admin can delete petty cash transactions
  
  ### Sales Orders
  - Optimized: Users can update own non-final sales orders
*/

-- Optimize petty_cash_documents policies
DROP POLICY IF EXISTS "Admin and accounts can insert petty cash documents" ON petty_cash_documents;
CREATE POLICY "Admin and accounts can insert petty cash documents"
  ON petty_cash_documents FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = (select auth.uid())
      AND role IN ('admin', 'accounts')
    )
  );

DROP POLICY IF EXISTS "Admin can delete petty cash documents" ON petty_cash_documents;
CREATE POLICY "Admin can delete petty cash documents"
  ON petty_cash_documents FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = (select auth.uid())
      AND role = 'admin'
    )
  );

-- Optimize petty_cash_transactions policies
DROP POLICY IF EXISTS "Admin and accounts can insert petty cash transactions" ON petty_cash_transactions;
CREATE POLICY "Admin and accounts can insert petty cash transactions"
  ON petty_cash_transactions FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = (select auth.uid())
      AND role IN ('admin', 'accounts')
    )
  );

DROP POLICY IF EXISTS "Admin and accounts can update petty cash transactions" ON petty_cash_transactions;
CREATE POLICY "Admin and accounts can update petty cash transactions"
  ON petty_cash_transactions FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = (select auth.uid())
      AND role IN ('admin', 'accounts')
    )
  );

DROP POLICY IF EXISTS "Admin can delete petty cash transactions" ON petty_cash_transactions;
CREATE POLICY "Admin can delete petty cash transactions"
  ON petty_cash_transactions FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = (select auth.uid())
      AND role = 'admin'
    )
  );

-- Optimize sales_orders policies
DROP POLICY IF EXISTS "Users can update own non-final sales orders" ON sales_orders;
CREATE POLICY "Users can update own non-final sales orders"
  ON sales_orders FOR UPDATE
  TO authenticated
  USING (
    created_by = (select auth.uid())
    AND status NOT IN ('closed', 'cancelled')
  );
