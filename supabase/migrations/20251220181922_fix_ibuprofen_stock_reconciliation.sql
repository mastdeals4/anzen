/*
  # Fix Ibuprofen Stock Reconciliation
  
  ## Problem
  Ibuprofen stock levels are incorrect due to historical transaction issues:
  - Batch A-3145: 600 kg missing (currently 250, should be 850)
  - Batch A-3146: 300 kg missing (currently 100, should be 400)
  - Batch A-3147: 3 kg extra (currently 203, should be 200)
  
  ## Solution
  Recalculate stock based on:
  - Import quantities (all 1000 kg)
  - Actual delivery challan items
  - Actual sales invoice items
  - Correct current_stock to match expected values
  
  ## Changes
  1. Update batch current_stock to match actual usage
  2. Create audit trail entries for reconciliation
*/

-- Update Batch A-3145: Add missing 600 kg
UPDATE batches
SET current_stock = 850.000,
    updated_at = now()
WHERE batch_number = '4001/1101/25/A-3145';

-- Update Batch A-3146: Add missing 300 kg
UPDATE batches
SET current_stock = 400.000,
    updated_at = now()
WHERE batch_number = '4001/1101/25/A-3146';

-- Update Batch A-3147: Remove extra 3 kg
UPDATE batches
SET current_stock = 200.000,
    updated_at = now()
WHERE batch_number = '4001/1101/25/A-3147';

-- Create audit trail entries for stock reconciliation
INSERT INTO inventory_transactions (
  product_id, batch_id, transaction_type, quantity,
  transaction_date, reference_number, reference_type,
  notes, stock_before, stock_after
)
SELECT 
  b.product_id,
  b.id,
  'adjustment',
  CASE 
    WHEN b.batch_number = '4001/1101/25/A-3145' THEN 600.000
    WHEN b.batch_number = '4001/1101/25/A-3146' THEN 300.000
    WHEN b.batch_number = '4001/1101/25/A-3147' THEN -3.000
  END,
  CURRENT_DATE,
  'STOCK-RECON-' || TO_CHAR(now(), 'YYYYMMDD-HH24MI'),
  'stock_reconciliation',
  CASE 
    WHEN b.batch_number = '4001/1101/25/A-3145' THEN 'Stock reconciliation: Corrected from 250 kg to 850 kg based on actual DC/Sales records'
    WHEN b.batch_number = '4001/1101/25/A-3146' THEN 'Stock reconciliation: Corrected from 100 kg to 400 kg based on actual DC/Sales records'
    WHEN b.batch_number = '4001/1101/25/A-3147' THEN 'Stock reconciliation: Corrected from 203 kg to 200 kg based on actual DC/Sales records'
  END,
  CASE 
    WHEN b.batch_number = '4001/1101/25/A-3145' THEN 250.00
    WHEN b.batch_number = '4001/1101/25/A-3146' THEN 100.00
    WHEN b.batch_number = '4001/1101/25/A-3147' THEN 203.00
  END,
  CASE 
    WHEN b.batch_number = '4001/1101/25/A-3145' THEN 850.00
    WHEN b.batch_number = '4001/1101/25/A-3146' THEN 400.00
    WHEN b.batch_number = '4001/1101/25/A-3147' THEN 200.00
  END
FROM batches b
JOIN products p ON p.id = b.product_id
WHERE p.product_name ILIKE '%ibuprofen%'
  AND b.batch_number IN ('4001/1101/25/A-3145', '4001/1101/25/A-3146', '4001/1101/25/A-3147');
