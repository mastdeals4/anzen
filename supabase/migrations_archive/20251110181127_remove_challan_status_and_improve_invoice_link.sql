/*
  # Remove Status from Delivery Challans and Improve Invoice Linking

  1. Changes
    - Remove `status` field from `delivery_challans` table
    - Status is no longer needed as we track via `linked_challan_ids` in sales_invoices
    - Drop related index on status
  
  2. Notes
    - Delivery challans without invoices = pending
    - Delivery challans with invoices = invoiced (tracked via linked_challan_ids)
    - This simplifies the workflow and prevents sync issues
*/

-- Drop the status column check constraint first
ALTER TABLE delivery_challans DROP CONSTRAINT IF EXISTS delivery_challans_status_check;

-- Drop the status index
DROP INDEX IF EXISTS idx_delivery_challans_status;

-- Remove status column
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'delivery_challans' AND column_name = 'status'
  ) THEN
    ALTER TABLE delivery_challans DROP COLUMN status;
  END IF;
END $$;