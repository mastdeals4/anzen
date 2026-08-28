/*
  # Enforce Expense Context by Category

  ## Problem
  Expenses lack enforced context, making Finance module feel complex:
  - Import expenses can be saved without linking to Import Container
  - Sales/Delivery expenses don't require DC linkage
  - Users can save expenses with wrong or missing context

  ## Solution
  Enforce context via category validation:
  1. Import context → MUST link to Import Container
  2. Sales/Delivery context → CAN link to DC (optional)
  3. General/Admin context → no linkage required

  ## Changes
  1. Update expense_category CHECK constraint to match frontend categories
  2. Add validation trigger to enforce import_container_id for import expenses
  3. Auto-set expense_type based on category for consistency

  ## Security
  - Maintains existing RLS policies
  - Uses SECURITY DEFINER with search_path
*/

-- =====================================================
-- STEP 1: Drop old CHECK constraint and add new one
-- =====================================================

-- Drop the old constraint if it exists
ALTER TABLE finance_expenses
  DROP CONSTRAINT IF EXISTS finance_expenses_expense_category_check;

-- Add updated constraint with all current categories
ALTER TABLE finance_expenses
  ADD CONSTRAINT finance_expenses_expense_category_check
  CHECK (expense_category IN (
    -- Import categories (require container)
    'duty_customs',
    'ppn_import',
    'pph_import',
    'freight_import',
    'clearing_forwarding',
    'port_charges',
    'container_handling',
    'transport_import',
    -- Sales categories (optional DC)
    'delivery_sales',
    'loading_sales',
    -- Admin categories (no linkage)
    'warehouse_rent',
    'utilities',
    'salary',
    'office_admin',
    -- Legacy categories (keep for backward compatibility)
    'duty',
    'freight',
    'office',
    'other'
  ));

-- =====================================================
-- STEP 2: Create trigger to enforce context rules
-- =====================================================

CREATE OR REPLACE FUNCTION validate_expense_context()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Determine expense type based on category
  IF NEW.expense_category IN (
    'duty_customs', 'ppn_import', 'pph_import', 'freight_import',
    'clearing_forwarding', 'port_charges', 'container_handling',
    'transport_import', 'duty', 'freight'
  ) THEN
    NEW.expense_type := 'import';

    -- ENFORCE: Import expenses MUST have import_container_id
    IF NEW.import_container_id IS NULL THEN
      RAISE EXCEPTION 'Import expenses must be linked to an Import Container. Please select a container.';
    END IF;

  ELSIF NEW.expense_category IN ('delivery_sales', 'loading_sales') THEN
    NEW.expense_type := 'sales';

    -- Sales expenses CAN have delivery_challan_id (optional, no enforcement)

  ELSE
    -- Admin/General expenses
    NEW.expense_type := 'admin';

    -- No linkage required for admin expenses
  END IF;

  RETURN NEW;
END;
$$;

-- Drop trigger if exists and recreate
DROP TRIGGER IF EXISTS trigger_validate_expense_context ON finance_expenses;

CREATE TRIGGER trigger_validate_expense_context
  BEFORE INSERT OR UPDATE ON finance_expenses
  FOR EACH ROW
  EXECUTE FUNCTION validate_expense_context();

-- =====================================================
-- STEP 3: Add indexes for better performance
-- =====================================================

CREATE INDEX IF NOT EXISTS idx_finance_expenses_container
  ON finance_expenses(import_container_id)
  WHERE import_container_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_finance_expenses_challan
  ON finance_expenses(delivery_challan_id)
  WHERE delivery_challan_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_finance_expenses_type
  ON finance_expenses(expense_type);
