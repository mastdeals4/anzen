/*
  # Fix Security Issues - Optimize RLS Policies Part 2

  1. Purpose
    - Fix RLS policies for finance tables
    - Replace auth.uid() with (select auth.uid())

  2. Changes
    - Bank accounts policies
    - Customer payments policies
    - Vendor bills policies
    - Vendor payments policies
*/

-- Bank Accounts
DROP POLICY IF EXISTS "Admins and accounts can view bank accounts" ON bank_accounts;
CREATE POLICY "Admins and accounts can view bank accounts"
  ON bank_accounts FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = (select auth.uid())
      AND user_profiles.role IN ('admin', 'accounts')
    )
  );

DROP POLICY IF EXISTS "Admins and accounts can insert bank accounts" ON bank_accounts;
CREATE POLICY "Admins and accounts can insert bank accounts"
  ON bank_accounts FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = (select auth.uid())
      AND user_profiles.role IN ('admin', 'accounts')
    )
  );

DROP POLICY IF EXISTS "Admins and accounts can update bank accounts" ON bank_accounts;
CREATE POLICY "Admins and accounts can update bank accounts"
  ON bank_accounts FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = (select auth.uid())
      AND user_profiles.role IN ('admin', 'accounts')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = (select auth.uid())
      AND user_profiles.role IN ('admin', 'accounts')
    )
  );

DROP POLICY IF EXISTS "Admins can delete bank accounts" ON bank_accounts;
CREATE POLICY "Admins can delete bank accounts"
  ON bank_accounts FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = (select auth.uid())
      AND user_profiles.role = 'admin'
    )
  );

-- Customer Payments
DROP POLICY IF EXISTS "Admins and accounts can insert customer payments" ON customer_payments;
CREATE POLICY "Admins and accounts can insert customer payments"
  ON customer_payments FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = (select auth.uid())
      AND user_profiles.role IN ('admin', 'accounts')
    )
  );

DROP POLICY IF EXISTS "Admins and accounts can update customer payments" ON customer_payments;
CREATE POLICY "Admins and accounts can update customer payments"
  ON customer_payments FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = (select auth.uid())
      AND user_profiles.role IN ('admin', 'accounts')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = (select auth.uid())
      AND user_profiles.role IN ('admin', 'accounts')
    )
  );

DROP POLICY IF EXISTS "Admins can delete customer payments" ON customer_payments;
CREATE POLICY "Admins can delete customer payments"
  ON customer_payments FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = (select auth.uid())
      AND user_profiles.role = 'admin'
    )
  );

-- Vendor Bills
DROP POLICY IF EXISTS "Admins and accounts can insert vendor bills" ON vendor_bills;
CREATE POLICY "Admins and accounts can insert vendor bills"
  ON vendor_bills FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = (select auth.uid())
      AND user_profiles.role IN ('admin', 'accounts')
    )
  );

DROP POLICY IF EXISTS "Admins and accounts can update vendor bills" ON vendor_bills;
CREATE POLICY "Admins and accounts can update vendor bills"
  ON vendor_bills FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = (select auth.uid())
      AND user_profiles.role IN ('admin', 'accounts')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = (select auth.uid())
      AND user_profiles.role IN ('admin', 'accounts')
    )
  );

DROP POLICY IF EXISTS "Admins can delete vendor bills" ON vendor_bills;
CREATE POLICY "Admins can delete vendor bills"
  ON vendor_bills FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = (select auth.uid())
      AND user_profiles.role = 'admin'
    )
  );

-- Vendor Payments
DROP POLICY IF EXISTS "Admins and accounts can insert vendor payments" ON vendor_payments;
CREATE POLICY "Admins and accounts can insert vendor payments"
  ON vendor_payments FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = (select auth.uid())
      AND user_profiles.role IN ('admin', 'accounts')
    )
  );

DROP POLICY IF EXISTS "Admins and accounts can update vendor payments" ON vendor_payments;
CREATE POLICY "Admins and accounts can update vendor payments"
  ON vendor_payments FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = (select auth.uid())
      AND user_profiles.role IN ('admin', 'accounts')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = (select auth.uid())
      AND user_profiles.role IN ('admin', 'accounts')
    )
  );

DROP POLICY IF EXISTS "Admins can delete vendor payments" ON vendor_payments;
CREATE POLICY "Admins can delete vendor payments"
  ON vendor_payments FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = (select auth.uid())
      AND user_profiles.role = 'admin'
    )
  );
