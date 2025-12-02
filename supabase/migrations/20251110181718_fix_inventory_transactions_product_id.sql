/*
  # Fix Inventory Transactions - Populate Missing Product IDs
  
  1. Changes
    - Update inventory_transactions to set product_id from related batch's product_id
    - This fixes the blank product names issue in the inventory transactions view
  
  2. Notes
    - Only updates transactions where product_id is NULL but batch_id exists
    - Essential for displaying transaction history correctly
*/

-- Update product_id for all transactions that have a batch_id but no product_id
UPDATE inventory_transactions it
SET product_id = b.product_id
FROM batches b
WHERE it.batch_id = b.id
  AND it.product_id IS NULL
  AND b.product_id IS NOT NULL;