/*
  # Fix Warehouse Role Restrictions
  
  1. Changes
    - Remove warehouse access from import_requirements SELECT policy
    - Remove warehouse access from import_containers SELECT policy
    - Ensure warehouse cannot access finance tables
  
  2. Security
    - Warehouse role restricted to operational tables only
    - No access to import management or financial data
*/

-- Import Requirements: Remove warehouse, keep admin + sales only
DROP POLICY IF EXISTS "Allow users to view import_requirements" ON import_requirements;
CREATE POLICY "Allow users to view import_requirements"
  ON import_requirements FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid() AND role IN ('admin', 'sales', 'auditor_ca')
    )
  );

-- Import Containers: Remove warehouse, keep admin + accounts only
DROP POLICY IF EXISTS "Allow users to view import_containers" ON import_containers;
CREATE POLICY "Allow users to view import_containers"
  ON import_containers FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid() AND role IN ('admin', 'accounts', 'auditor_ca')
    )
  );

-- Finance Expenses: Ensure warehouse excluded
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'finance_expenses') THEN
    DROP POLICY IF EXISTS "Allow users to view finance_expenses" ON finance_expenses;
    CREATE POLICY "Allow users to view finance_expenses"
      ON finance_expenses FOR SELECT
      TO authenticated
      USING (
        EXISTS (
          SELECT 1 FROM user_profiles
          WHERE id = auth.uid() AND role IN ('admin', 'accounts', 'auditor_ca')
        )
      );
  END IF;
END $$;

-- Chart of Accounts: Ensure warehouse excluded
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'chart_of_accounts') THEN
    DROP POLICY IF EXISTS "Allow users to view chart_of_accounts" ON chart_of_accounts;
    CREATE POLICY "Allow users to view chart_of_accounts"
      ON chart_of_accounts FOR SELECT
      TO authenticated
      USING (
        EXISTS (
          SELECT 1 FROM user_profiles
          WHERE id = auth.uid() AND role IN ('admin', 'accounts', 'auditor_ca')
        )
      );
  END IF;
END $$;

-- Journal Entries: Ensure warehouse excluded
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'journal_entries') THEN
    DROP POLICY IF EXISTS "Allow users to view journal_entries" ON journal_entries;
    CREATE POLICY "Allow users to view journal_entries"
      ON journal_entries FOR SELECT
      TO authenticated
      USING (
        EXISTS (
          SELECT 1 FROM user_profiles
          WHERE id = auth.uid() AND role IN ('admin', 'accounts', 'auditor_ca')
        )
      );
  END IF;
END $$;

-- Journal Entry Lines: Ensure warehouse excluded
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'journal_entry_lines') THEN
    DROP POLICY IF EXISTS "Allow users to view journal_entry_lines" ON journal_entry_lines;
    CREATE POLICY "Allow users to view journal_entry_lines"
      ON journal_entry_lines FOR SELECT
      TO authenticated
      USING (
        EXISTS (
          SELECT 1 FROM user_profiles
          WHERE id = auth.uid() AND role IN ('admin', 'accounts', 'auditor_ca')
        )
      );
  END IF;
END $$;

-- Bank Accounts: Ensure warehouse excluded
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'bank_accounts') THEN
    DROP POLICY IF EXISTS "Allow users to view bank_accounts" ON bank_accounts;
    CREATE POLICY "Allow users to view bank_accounts"
      ON bank_accounts FOR SELECT
      TO authenticated
      USING (
        EXISTS (
          SELECT 1 FROM user_profiles
          WHERE id = auth.uid() AND role IN ('admin', 'accounts', 'auditor_ca')
        )
      );
  END IF;
END $$;

-- Purchase Orders: Add warehouse access (they need to see POs for receiving goods)
DROP POLICY IF EXISTS "Allow users to view purchase_orders" ON purchase_orders;
CREATE POLICY "Allow users to view purchase_orders"
  ON purchase_orders FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid() AND role IN ('admin', 'accounts', 'auditor_ca')
    )
  );

-- Purchase Order Items
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'purchase_order_items') THEN
    DROP POLICY IF EXISTS "Allow users to view purchase_order_items" ON purchase_order_items;
    CREATE POLICY "Allow users to view purchase_order_items"
      ON purchase_order_items FOR SELECT
      TO authenticated
      USING (
        EXISTS (
          SELECT 1 FROM user_profiles
          WHERE id = auth.uid() AND role IN ('admin', 'accounts', 'auditor_ca')
        )
      );
  END IF;
END $$;
