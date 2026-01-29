-- ============================================================================
-- MANUAL DATA CLEANUP FOR 2026 - Finance Module Complete Fix
-- ============================================================================
-- This script will:
-- 1. Move all cash expenses before 2026 to petty cash system
-- 2. Update journal entry descriptions to include expense categories
-- 3. Fix inventory product codes
-- 4. Ensure all data is properly categorized
-- ============================================================================

-- STEP 1: Create petty cash entries for all cash expenses before 2026
-- ============================================================================

INSERT INTO petty_cash_transactions (
  transaction_number,
  transaction_date,
  transaction_type,
  amount,
  description,
  expense_category,
  paid_by,
  import_container_id,
  delivery_challan_id,
  created_by,
  created_at,
  updated_at
)
SELECT
  'PCMIG-' || TO_CHAR(expense_date, 'YYMM') || '-' || LPAD(ROW_NUMBER() OVER (PARTITION BY TO_CHAR(expense_date, 'YYMM') ORDER BY expense_date, id)::text, 4, '0'),
  expense_date,
  'expense',
  amount,
  '[' || UPPER(REPLACE(expense_category, '_', ' ')) || '] ' || description,
  expense_category,
  COALESCE(paid_by, 'cash'),
  import_container_id,
  delivery_challan_id,
  created_by,
  NOW(),
  NOW()
FROM finance_expenses
WHERE payment_method = 'cash'
  AND expense_date < '2026-01-01'
  AND id NOT IN (
    -- Exclude any that might already be migrated
    SELECT DISTINCT id FROM finance_expenses
    WHERE payment_method = 'cash'
      AND expense_date < '2026-01-01'
      AND id IN (SELECT reference_id::uuid FROM petty_cash_transactions WHERE reference_id IS NOT NULL)
  )
ORDER BY expense_date, id;

-- STEP 2: Update journal entry descriptions to include expense categories
-- ============================================================================

UPDATE journal_entry_lines jel
SET description = CONCAT(
  '[', UPPER(REPLACE(fe.expense_category, '_', ' ')), '] ',
  COALESCE(jel.description, fe.description)
)
FROM journal_entries je
JOIN finance_expenses fe ON je.reference_id = fe.id
WHERE jel.journal_entry_id = je.id
  AND je.source_module = 'expenses'
  AND je.entry_date < '2026-01-01'
  AND jel.description NOT LIKE '[%]%'; -- Only update if not already formatted

-- STEP 3: Fix missing product codes in products table
-- ============================================================================

-- Generate product codes for products that don't have one
UPDATE products
SET product_code = 'PROD-' || LPAD(ROW_NUMBER() OVER (ORDER BY created_at)::text, 4, '0')
WHERE product_code IS NULL OR product_code = '';

-- STEP 4: Add opening balance for petty cash (if needed)
-- ============================================================================

-- Calculate total cash expenses that were migrated
DO $$
DECLARE
  total_migrated NUMERIC;
  petty_cash_coa_id UUID;
BEGIN
  -- Get total amount migrated
  SELECT COALESCE(SUM(amount), 0) INTO total_migrated
  FROM finance_expenses
  WHERE payment_method = 'cash'
    AND expense_date < '2026-01-01';

  -- Get Petty Cash account ID
  SELECT id INTO petty_cash_coa_id
  FROM chart_of_accounts
  WHERE code = '1102' LIMIT 1;

  RAISE NOTICE 'Total cash expenses migrated: %', total_migrated;
  RAISE NOTICE 'Petty Cash COA ID: %', petty_cash_coa_id;

  -- Note: The petty cash opening balance should match the total
  -- This will be reflected in the fund transfers from bank to petty cash
END $$;

-- STEP 5: Generate summary report
-- ============================================================================

-- Summary of migrated expenses by category
SELECT
  expense_category,
  COUNT(*) as transaction_count,
  SUM(amount) as total_amount,
  MIN(expense_date) as first_date,
  MAX(expense_date) as last_date
FROM finance_expenses
WHERE payment_method = 'cash'
  AND expense_date < '2026-01-01'
GROUP BY expense_category
ORDER BY expense_category;

-- Summary of petty cash transactions
SELECT
  expense_category,
  COUNT(*) as count,
  SUM(amount) as total
FROM petty_cash_transactions
WHERE transaction_type = 'expense'
GROUP BY expense_category
ORDER BY expense_category;

-- Verify inventory products have codes
SELECT
  COUNT(*) as total_products,
  COUNT(CASE WHEN product_code IS NOT NULL AND product_code != '' THEN 1 END) as with_code,
  COUNT(CASE WHEN product_code IS NULL OR product_code = '' THEN 1 END) as without_code
FROM products;

-- ============================================================================
-- END OF MANUAL DATA CLEANUP SCRIPT
-- ============================================================================
