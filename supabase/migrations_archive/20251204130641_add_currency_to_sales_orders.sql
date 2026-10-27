/*
  # Add Currency Field to Sales Orders

  1. Changes
    - Add `currency` column to `sales_orders` table
    - Set default value to 'IDR' (Indonesian Rupiah)
    - Support USD and IDR currencies
  
  2. Notes
    - Existing orders will default to IDR
    - Currency affects display formatting ($ vs Rp)
    - Does NOT add exchange rate conversion
*/

DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'sales_orders' AND column_name = 'currency'
  ) THEN
    ALTER TABLE sales_orders 
    ADD COLUMN currency text DEFAULT 'IDR' CHECK (currency IN ('USD', 'IDR'));
  END IF;
END $$;

COMMENT ON COLUMN sales_orders.currency IS 'Currency for the sales order: USD or IDR';