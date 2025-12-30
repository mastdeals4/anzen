/*
  # Add Archive and Stock Reservation Fields
  
  1. New Fields for Sales Orders
    - `is_archived` - Boolean to mark archived orders
    - `archived_at` - Timestamp when archived
    - `archived_by` - User who archived
    - `archive_reason` - Reason for archiving
  
  2. New Fields for Batches
    - `reserved_stock` - Quantity reserved for sales orders
  
  3. New Fields for Stock Reservations
    - `is_released` - Track if reservation has been released
    - `released_at` - When reservation was released
    - `released_by` - Who released it
  
  4. New Field for Delivery Challans
    - `sales_order_id` - Link to sales order (if not exists)
  
  5. Indexes
    - Add indexes for performance on new fields
*/

-- Add archive fields to sales_orders
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'sales_orders' AND column_name = 'is_archived'
  ) THEN
    ALTER TABLE sales_orders ADD COLUMN is_archived boolean DEFAULT false;
  END IF;
  
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'sales_orders' AND column_name = 'archived_at'
  ) THEN
    ALTER TABLE sales_orders ADD COLUMN archived_at timestamptz;
  END IF;
  
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'sales_orders' AND column_name = 'archived_by'
  ) THEN
    ALTER TABLE sales_orders ADD COLUMN archived_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;
  END IF;
  
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'sales_orders' AND column_name = 'archive_reason'
  ) THEN
    ALTER TABLE sales_orders ADD COLUMN archive_reason text;
  END IF;
END $$;

-- Add reserved_stock to batches
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'batches' AND column_name = 'reserved_stock'
  ) THEN
    ALTER TABLE batches ADD COLUMN reserved_stock numeric(15,3) DEFAULT 0 CHECK (reserved_stock >= 0);
  END IF;
END $$;

-- Add release tracking to stock_reservations
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'stock_reservations' AND column_name = 'is_released'
  ) THEN
    ALTER TABLE stock_reservations ADD COLUMN is_released boolean DEFAULT false;
  END IF;
  
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'stock_reservations' AND column_name = 'released_at'
  ) THEN
    ALTER TABLE stock_reservations ADD COLUMN released_at timestamptz;
  END IF;
  
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'stock_reservations' AND column_name = 'released_by'
  ) THEN
    ALTER TABLE stock_reservations ADD COLUMN released_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;
  END IF;
END $$;

-- Add sales_order_id to delivery_challans if not exists
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'delivery_challans' AND column_name = 'sales_order_id'
  ) THEN
    ALTER TABLE delivery_challans ADD COLUMN sales_order_id uuid REFERENCES sales_orders(id) ON DELETE SET NULL;
  END IF;
END $$;

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_sales_orders_archived ON sales_orders(is_archived);
CREATE INDEX IF NOT EXISTS idx_sales_orders_archived_at ON sales_orders(archived_at DESC);
CREATE INDEX IF NOT EXISTS idx_batches_reserved_stock ON batches(reserved_stock);
CREATE INDEX IF NOT EXISTS idx_stock_reservations_released ON stock_reservations(is_released);
CREATE INDEX IF NOT EXISTS idx_delivery_challans_sales_order ON delivery_challans(sales_order_id);

-- Create view for batch stock summary
CREATE OR REPLACE VIEW v_batch_stock_summary AS
SELECT 
  b.id,
  b.batch_number,
  b.product_id,
  p.product_name,
  b.current_stock,
  COALESCE(b.reserved_stock, 0) as reserved_stock,
  (b.current_stock - COALESCE(b.reserved_stock, 0)) as free_stock,
  b.expiry_date,
  b.import_date,
  b.is_active
FROM batches b
LEFT JOIN products p ON b.product_id = p.id;
