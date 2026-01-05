/*
  # Link Import Container Costs to Finance Module + Add Product Duty %

  ## Problem
  1. Import container costs (BM, PPN, PPh, Freight, etc.) are entered but don't automatically flow to Finance Module
  2. Each product has different import duty %, but products table only has duty_a1 (text)
  3. Need proper linkage: Import Container → Finance Expenses → Accounting Entries
  4. Need Input/Output tax reports for monthly tax filing

  ## Solution
  1. Add duty_percent field to products table (per-product duty rate)
  2. Create trigger to auto-generate finance_expenses when import container costs are entered/updated
  3. Each import cost → separate expense entry under correct category
  4. These expenses then auto-post to accounting via existing trigger
  5. Create tax report views for Input PPN and Output PPN

  ## Changes
  1. Products Table: Add duty_percent field
  2. Trigger: Auto-create finance_expenses from import_container costs
  3. Views: Input/Output tax reports

  ## Tax Flow
  Import Container Costs → Finance Expenses (with container_id) → Journal Entries (Inventory Dr, Cash Cr)
  
  PPN confirmed at 11% ✓
*/

-- =====================================================
-- STEP 1: Add duty_percent to products
-- =====================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'products' AND column_name = 'duty_percent'
  ) THEN
    ALTER TABLE products ADD COLUMN duty_percent DECIMAL(5,2) DEFAULT 0;
    COMMENT ON COLUMN products.duty_percent IS 'Import duty percentage (BM) specific to this product. Example: 5.00 = 5%';
  END IF;
END $$;

-- =====================================================
-- STEP 2: Create function to auto-generate finance expenses
-- =====================================================

CREATE OR REPLACE FUNCTION auto_create_import_expenses()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_expense_date DATE;
  v_created_by UUID;
BEGIN
  -- Use import date as expense date
  v_expense_date := NEW.import_date;
  v_created_by := COALESCE(NEW.created_by, auth.uid());

  -- Only process if this is a new record or cost fields changed
  IF (TG_OP = 'INSERT') OR 
     (TG_OP = 'UPDATE' AND (
       OLD.duty_bm IS DISTINCT FROM NEW.duty_bm OR
       OLD.ppn_import IS DISTINCT FROM NEW.ppn_import OR
       OLD.pph_import IS DISTINCT FROM NEW.pph_import OR
       OLD.freight_charges IS DISTINCT FROM NEW.freight_charges OR
       OLD.clearing_forwarding IS DISTINCT FROM NEW.clearing_forwarding OR
       OLD.port_charges IS DISTINCT FROM NEW.port_charges OR
       OLD.container_handling IS DISTINCT FROM NEW.container_handling OR
       OLD.transportation IS DISTINCT FROM NEW.transportation OR
       OLD.other_import_costs IS DISTINCT FROM NEW.other_import_costs
     )) THEN

    -- Delete old expense entries for this container (if update)
    IF TG_OP = 'UPDATE' THEN
      DELETE FROM finance_expenses WHERE import_container_id = NEW.id;
    END IF;

    -- Create expense entry for BM (Duty)
    IF NEW.duty_bm > 0 THEN
      INSERT INTO finance_expenses (
        expense_category,
        expense_type,
        amount,
        expense_date,
        description,
        import_container_id,
        created_by
      ) VALUES (
        'duty_customs',
        'import',
        NEW.duty_bm,
        v_expense_date,
        'BM (Duty) - Container ' || NEW.container_ref,
        NEW.id,
        v_created_by
      );
    END IF;

    -- Create expense entry for PPN Import
    IF NEW.ppn_import > 0 THEN
      INSERT INTO finance_expenses (
        expense_category,
        expense_type,
        amount,
        expense_date,
        description,
        import_container_id,
        created_by
      ) VALUES (
        'ppn_import',
        'import',
        NEW.ppn_import,
        v_expense_date,
        'PPN Import (11%) - Container ' || NEW.container_ref,
        NEW.id,
        v_created_by
      );
    END IF;

    -- Create expense entry for PPh Import
    IF NEW.pph_import > 0 THEN
      INSERT INTO finance_expenses (
        expense_category,
        expense_type,
        amount,
        expense_date,
        description,
        import_container_id,
        created_by
      ) VALUES (
        'pph_import',
        'import',
        NEW.pph_import,
        v_expense_date,
        'PPh Import - Container ' || NEW.container_ref,
        NEW.id,
        v_created_by
      );
    END IF;

    -- Create expense entry for Freight
    IF NEW.freight_charges > 0 THEN
      INSERT INTO finance_expenses (
        expense_category,
        expense_type,
        amount,
        expense_date,
        description,
        import_container_id,
        created_by
      ) VALUES (
        'freight_import',
        'import',
        NEW.freight_charges,
        v_expense_date,
        'Freight Charges - Container ' || NEW.container_ref,
        NEW.id,
        v_created_by
      );
    END IF;

    -- Create expense entry for Clearing & Forwarding
    IF NEW.clearing_forwarding > 0 THEN
      INSERT INTO finance_expenses (
        expense_category,
        expense_type,
        amount,
        expense_date,
        description,
        import_container_id,
        created_by
      ) VALUES (
        'clearing_forwarding',
        'import',
        NEW.clearing_forwarding,
        v_expense_date,
        'Clearing & Forwarding - Container ' || NEW.container_ref,
        NEW.id,
        v_created_by
      );
    END IF;

    -- Create expense entry for Port Charges
    IF NEW.port_charges > 0 THEN
      INSERT INTO finance_expenses (
        expense_category,
        expense_type,
        amount,
        expense_date,
        description,
        import_container_id,
        created_by
      ) VALUES (
        'port_charges',
        'import',
        NEW.port_charges,
        v_expense_date,
        'Port Charges - Container ' || NEW.container_ref,
        NEW.id,
        v_created_by
      );
    END IF;

    -- Create expense entry for Container Handling
    IF NEW.container_handling > 0 THEN
      INSERT INTO finance_expenses (
        expense_category,
        expense_type,
        amount,
        expense_date,
        description,
        import_container_id,
        created_by
      ) VALUES (
        'container_handling',
        'import',
        NEW.container_handling,
        v_expense_date,
        'Container Handling - Container ' || NEW.container_ref,
        NEW.id,
        v_created_by
      );
    END IF;

    -- Create expense entry for Transportation
    IF NEW.transportation > 0 THEN
      INSERT INTO finance_expenses (
        expense_category,
        expense_type,
        amount,
        expense_date,
        description,
        import_container_id,
        created_by
      ) VALUES (
        'transport_import',
        'import',
        NEW.transportation,
        v_expense_date,
        'Transportation - Container ' || NEW.container_ref,
        NEW.id,
        v_created_by
      );
    END IF;

    -- Create expense entry for Other Import Costs
    IF NEW.other_import_costs > 0 THEN
      INSERT INTO finance_expenses (
        expense_category,
        expense_type,
        amount,
        expense_date,
        description,
        import_container_id,
        created_by
      ) VALUES (
        'other',
        'import',
        NEW.other_import_costs,
        v_expense_date,
        'Other Import Costs - Container ' || NEW.container_ref,
        NEW.id,
        v_created_by
      );
    END IF;

  END IF;

  RETURN NEW;
END;
$$;

-- Drop and recreate trigger
DROP TRIGGER IF EXISTS trigger_auto_create_import_expenses ON import_containers;

CREATE TRIGGER trigger_auto_create_import_expenses
  AFTER INSERT OR UPDATE ON import_containers
  FOR EACH ROW
  EXECUTE FUNCTION auto_create_import_expenses();

COMMENT ON FUNCTION auto_create_import_expenses() IS 
'Automatically creates finance_expenses entries when import container costs are entered.
Each cost type (BM, PPN, PPh, Freight, etc.) creates a separate expense entry.
These expenses then flow to accounting via the auto_post_expense_accounting trigger.';

-- =====================================================
-- STEP 3: Create Tax Report Views
-- =====================================================

-- Input PPN Report (PPN paid on imports - can be claimed back)
CREATE OR REPLACE VIEW vw_input_ppn_report AS
SELECT 
  DATE_TRUNC('month', fe.expense_date) AS month,
  fe.expense_date,
  ic.container_ref,
  s.company_name AS supplier,
  ic.import_invoice_value,
  fe.amount AS ppn_amount,
  fe.description,
  fe.created_at
FROM finance_expenses fe
JOIN import_containers ic ON fe.import_container_id = ic.id
LEFT JOIN suppliers s ON ic.supplier_id = s.id
WHERE fe.expense_category = 'ppn_import'
ORDER BY fe.expense_date DESC;

COMMENT ON VIEW vw_input_ppn_report IS 
'Input PPN Report - PPN paid on imports (can be claimed as tax credit).
Used for monthly tax filing to offset against Output PPN.';

-- Output PPN Report (PPN collected on sales - must be paid to government)
CREATE OR REPLACE VIEW vw_output_ppn_report AS
SELECT 
  DATE_TRUNC('month', si.invoice_date) AS month,
  si.invoice_date,
  si.invoice_number,
  c.company_name AS customer,
  c.npwp AS customer_npwp,
  si.subtotal,
  si.tax_amount AS ppn_amount,
  si.total_amount,
  si.payment_status,
  si.created_at
FROM sales_invoices si
JOIN customers c ON si.customer_id = c.id
WHERE si.tax_amount > 0
ORDER BY si.invoice_date DESC;

COMMENT ON VIEW vw_output_ppn_report IS 
'Output PPN Report - PPN collected from customers on sales (must be paid to tax office).
Used for monthly tax filing. Net PPN = Output PPN - Input PPN.';

-- Monthly Tax Summary
CREATE OR REPLACE VIEW vw_monthly_tax_summary AS
SELECT 
  COALESCE(all_months.month, input.month, output.month) AS month,
  COALESCE(input_ppn, 0) AS input_ppn_paid,
  COALESCE(output_ppn, 0) AS output_ppn_collected,
  COALESCE(output_ppn, 0) - COALESCE(input_ppn, 0) AS net_ppn_payable
FROM (
  SELECT DISTINCT DATE_TRUNC('month', expense_date) AS month
  FROM finance_expenses
  WHERE expense_category = 'ppn_import'
  UNION
  SELECT DISTINCT DATE_TRUNC('month', invoice_date) AS month
  FROM sales_invoices
  WHERE tax_amount > 0
) all_months
LEFT JOIN (
  SELECT 
    DATE_TRUNC('month', expense_date) AS month,
    SUM(amount) AS input_ppn
  FROM finance_expenses
  WHERE expense_category = 'ppn_import'
  GROUP BY DATE_TRUNC('month', expense_date)
) input ON input.month = all_months.month
LEFT JOIN (
  SELECT 
    DATE_TRUNC('month', invoice_date) AS month,
    SUM(tax_amount) AS output_ppn
  FROM sales_invoices
  WHERE tax_amount > 0
  GROUP BY DATE_TRUNC('month', invoice_date)
) output ON output.month = all_months.month
ORDER BY month DESC;

COMMENT ON VIEW vw_monthly_tax_summary IS 
'Monthly Tax Summary - Shows Input PPN, Output PPN, and Net PPN Payable.
If Net PPN is positive: Pay to tax office
If Net PPN is negative: Carry forward to next month or claim refund';

-- =====================================================
-- STEP 4: Add index for performance
-- =====================================================

CREATE INDEX IF NOT EXISTS idx_products_duty_percent 
  ON products(duty_percent) 
  WHERE duty_percent > 0;

COMMENT ON INDEX idx_products_duty_percent IS 
'Index for products with import duty to speed up duty calculations';
