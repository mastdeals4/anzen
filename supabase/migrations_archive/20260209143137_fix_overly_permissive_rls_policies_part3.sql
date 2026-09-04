/*
  # Fix Overly Permissive RLS Policies - Part 3: Vouchers & Payments

  1. Voucher and Payment Tables (6 tables)
     - Restrict to non-read-only users
*/

-- 1. payment_vouchers
DROP POLICY IF EXISTS "Authenticated users can manage payment vouchers" ON payment_vouchers;
CREATE POLICY "Authenticated users can manage payment vouchers"
  ON payment_vouchers FOR ALL
  TO authenticated
  USING (NOT is_read_only_user())
  WITH CHECK (NOT is_read_only_user());

-- 2. receipt_vouchers
DROP POLICY IF EXISTS "Authenticated users can manage receipt vouchers" ON receipt_vouchers;
CREATE POLICY "Authenticated users can manage receipt vouchers"
  ON receipt_vouchers FOR ALL
  TO authenticated
  USING (NOT is_read_only_user())
  WITH CHECK (NOT is_read_only_user());

-- 3. voucher_allocations
DROP POLICY IF EXISTS "Authenticated users can manage voucher allocations" ON voucher_allocations;
CREATE POLICY "Authenticated users can manage voucher allocations"
  ON voucher_allocations FOR ALL
  TO authenticated
  USING (NOT is_read_only_user())
  WITH CHECK (NOT is_read_only_user());

-- 4. petty_cash_books
DROP POLICY IF EXISTS "Authenticated users can manage petty cash books" ON petty_cash_books;
CREATE POLICY "Authenticated users can manage petty cash books"
  ON petty_cash_books FOR ALL
  TO authenticated
  USING (NOT is_read_only_user())
  WITH CHECK (NOT is_read_only_user());

-- 5. petty_cash_vouchers
DROP POLICY IF EXISTS "Authenticated users can manage petty cash vouchers" ON petty_cash_vouchers;
CREATE POLICY "Authenticated users can manage petty cash vouchers"
  ON petty_cash_vouchers FOR ALL
  TO authenticated
  USING (NOT is_read_only_user())
  WITH CHECK (NOT is_read_only_user());

-- 6. petty_cash_files
DROP POLICY IF EXISTS "Authenticated users can manage petty cash files" ON petty_cash_files;
CREATE POLICY "Authenticated users can manage petty cash files"
  ON petty_cash_files FOR ALL
  TO authenticated
  USING (NOT is_read_only_user())
  WITH CHECK (NOT is_read_only_user());

-- 7. petty_cash_documents
DROP POLICY IF EXISTS "Authenticated users can insert petty cash documents" ON petty_cash_documents;
DROP POLICY IF EXISTS "Authenticated users can delete petty cash documents" ON petty_cash_documents;

CREATE POLICY "Authenticated users can insert petty cash documents"
  ON petty_cash_documents FOR INSERT
  TO authenticated
  WITH CHECK (NOT is_read_only_user());

CREATE POLICY "Authenticated users can delete petty cash documents"
  ON petty_cash_documents FOR DELETE
  TO authenticated
  USING (NOT is_read_only_user());
