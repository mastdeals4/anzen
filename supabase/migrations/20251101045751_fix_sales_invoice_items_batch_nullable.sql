/*
  # Fix Sales Invoice Items - Make batch_id nullable

  ## Changes
  - Alter `sales_invoice_items` table to make `batch_id` column nullable
  - This allows creating invoice items without specifying a batch
  
  ## Reason
  The application allows users to create invoice items without selecting a specific batch,
  but the database schema currently requires batch_id to be NOT NULL, causing save failures.
*/

-- Make batch_id nullable in sales_invoice_items
ALTER TABLE sales_invoice_items 
ALTER COLUMN batch_id DROP NOT NULL;