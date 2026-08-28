/*
  # Fix Overly Permissive RLS Policies - Part 2: Accounting Tables

  1. Accounting & Finance Core Tables (10 tables)
     - Restrict to non-read-only users
     - All authenticated users with write access can manage
*/

-- 1. accounting_periods
DROP POLICY IF EXISTS "Authenticated users can manage accounting periods" ON accounting_periods;
CREATE POLICY "Authenticated users can manage accounting periods"
  ON accounting_periods FOR ALL
  TO authenticated
  USING (NOT is_read_only_user())
  WITH CHECK (NOT is_read_only_user());

-- 2. chart_of_accounts
DROP POLICY IF EXISTS "Authenticated users can manage chart of accounts" ON chart_of_accounts;
CREATE POLICY "Authenticated users can manage chart of accounts"
  ON chart_of_accounts FOR ALL
  TO authenticated
  USING (NOT is_read_only_user())
  WITH CHECK (NOT is_read_only_user());

-- 3. journal_entries
DROP POLICY IF EXISTS "Authenticated users can manage journal entries" ON journal_entries;
CREATE POLICY "Authenticated users can manage journal entries"
  ON journal_entries FOR ALL
  TO authenticated
  USING (NOT is_read_only_user())
  WITH CHECK (NOT is_read_only_user());

-- 4. journal_entry_lines
DROP POLICY IF EXISTS "Authenticated users can manage journal entry lines" ON journal_entry_lines;
CREATE POLICY "Authenticated users can manage journal entry lines"
  ON journal_entry_lines FOR ALL
  TO authenticated
  USING (NOT is_read_only_user())
  WITH CHECK (NOT is_read_only_user());

-- 5. organization_tax_settings
DROP POLICY IF EXISTS "Authenticated users can manage tax settings" ON organization_tax_settings;
CREATE POLICY "Authenticated users can manage tax settings"
  ON organization_tax_settings FOR ALL
  TO authenticated
  USING (NOT is_read_only_user())
  WITH CHECK (NOT is_read_only_user());

-- 6. tax_codes
DROP POLICY IF EXISTS "Authenticated users can manage tax codes" ON tax_codes;
CREATE POLICY "Authenticated users can manage tax codes"
  ON tax_codes FOR ALL
  TO authenticated
  USING (NOT is_read_only_user())
  WITH CHECK (NOT is_read_only_user());

-- 7. bank_reconciliations
DROP POLICY IF EXISTS "Authenticated users can manage bank reconciliations" ON bank_reconciliations;
CREATE POLICY "Authenticated users can manage bank reconciliations"
  ON bank_reconciliations FOR ALL
  TO authenticated
  USING (NOT is_read_only_user())
  WITH CHECK (NOT is_read_only_user());

-- 8. bank_reconciliation_items
DROP POLICY IF EXISTS "Authenticated users can manage bank reconciliation items" ON bank_reconciliation_items;
CREATE POLICY "Authenticated users can manage bank reconciliation items"
  ON bank_reconciliation_items FOR ALL
  TO authenticated
  USING (NOT is_read_only_user())
  WITH CHECK (NOT is_read_only_user());

-- 9. bank_statement_lines - UPDATE only
DROP POLICY IF EXISTS "Authenticated users can update bank statement lines" ON bank_statement_lines;
CREATE POLICY "Authenticated users can update bank statement lines"
  ON bank_statement_lines FOR UPDATE
  TO authenticated
  USING (NOT is_read_only_user())
  WITH CHECK (NOT is_read_only_user());

-- 10. suppliers
DROP POLICY IF EXISTS "Authenticated users can manage suppliers" ON suppliers;
CREATE POLICY "Authenticated users can manage suppliers"
  ON suppliers FOR ALL
  TO authenticated
  USING (NOT is_read_only_user())
  WITH CHECK (NOT is_read_only_user());
