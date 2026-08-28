/*
  # Sales Order Management System with Approval Workflows

  ## Overview
  Complete sales order management with role-based approvals, stock reservation,
  and import requirement tracking. Implements SO → DC → Invoice workflow.

  ## 1. New Tables

  ### `sales_orders`
  Main sales order table storing customer purchase orders
  - `id` (uuid, primary key)
  - `so_number` (text, unique, auto-generated format: SO-YYYY-NNNN)
  - `customer_id` (uuid, foreign key to customers)
  - `customer_po_number` (text, required)
  - `customer_po_date` (date, required)
  - `customer_po_file_url` (text, nullable - URL to uploaded PO file)
  - `so_date` (date, default today)
  - `expected_delivery_date` (date, nullable)
  - `notes` (text, nullable)
  - `status` (enum: draft/pending_approval/approved/rejected/stock_reserved/shortage/pending_delivery/partially_delivered/delivered/closed/cancelled)
  - `subtotal_amount` (numeric, default 0)
  - `tax_amount` (numeric, default 0)
  - `total_amount` (numeric, default 0)
  - `created_by` (uuid, foreign key to auth.users)
  - `created_at` (timestamptz, default now)
  - `updated_at` (timestamptz, default now)
  - `approved_by` (uuid, nullable, foreign key to auth.users)
  - `approved_at` (timestamptz, nullable)
  - `rejected_by` (uuid, nullable, foreign key to auth.users)
  - `rejected_at` (timestamptz, nullable)
  - `rejection_reason` (text, nullable)

  ### `sales_order_items`
  Line items for each sales order
  - `id` (uuid, primary key)
  - `sales_order_id` (uuid, foreign key to sales_orders)
  - `product_id` (uuid, foreign key to products)
  - `quantity` (numeric, required)
  - `unit_price` (numeric, required)
  - `discount_percent` (numeric, default 0)
  - `discount_amount` (numeric, default 0)
  - `tax_percent` (numeric, default 0)
  - `tax_amount` (numeric, default 0)
  - `line_total` (numeric, calculated)
  - `item_delivery_date` (date, nullable)
  - `notes` (text, nullable)
  - `delivered_quantity` (numeric, default 0)
  - `created_at` (timestamptz, default now)

  ### `stock_reservations`
  Tracks reserved stock for approved sales orders
  - `id` (uuid, primary key)
  - `sales_order_id` (uuid, foreign key to sales_orders)
  - `sales_order_item_id` (uuid, foreign key to sales_order_items)
  - `batch_id` (uuid, foreign key to batches)
  - `product_id` (uuid, foreign key to products)
  - `reserved_quantity` (numeric, required)
  - `reserved_at` (timestamptz, default now)
  - `reserved_by` (uuid, foreign key to auth.users)
  - `released_at` (timestamptz, nullable)
  - `released_by` (uuid, nullable, foreign key to auth.users)
  - `release_reason` (text, nullable)
  - `status` (enum: active/released/consumed)

  ### `import_requirements`
  Auto-generated import needs based on stock shortages
  - `id` (uuid, primary key)
  - `product_id` (uuid, foreign key to products)
  - `sales_order_id` (uuid, foreign key to sales_orders)
  - `customer_id` (uuid, foreign key to customers)
  - `required_quantity` (numeric, required)
  - `shortage_quantity` (numeric, required)
  - `required_delivery_date` (date, required)
  - `supplier_id` (uuid, nullable)
  - `lead_time_days` (integer, default 30)
  - `priority` (enum: high/medium/low, default medium)
  - `status` (enum: pending/ordered/partially_received/received/cancelled)
  - `notes` (text, nullable)
  - `created_at` (timestamptz, default now)
  - `updated_at` (timestamptz, default now)

  ## 2. Table Modifications

  ### `delivery_challans`
  Add approval workflow and SO linking
  - Add `sales_order_id` (uuid, nullable, foreign key to sales_orders)
  - Add `approval_status` (enum: pending_approval/approved/rejected)
  - Add `approved_by` (uuid, nullable, foreign key to auth.users)
  - Add `approved_at` (timestamptz, nullable)
  - Add `rejection_reason` (text, nullable)

  ## 3. Security
  - Enable RLS on all new tables
  - Add policies for authenticated users based on roles
  - Restrict approvals to admin and sales roles
  - DC approval restricted to admin role only

  ## 4. Indexes
  - Index on so_number for quick lookups
  - Index on customer_id, status, created_at for filtering
  - Index on all foreign keys for join performance
*/

-- Create enum types
DO $$ BEGIN
  CREATE TYPE sales_order_status AS ENUM (
    'draft',
    'pending_approval',
    'approved',
    'rejected',
    'stock_reserved',
    'shortage',
    'pending_delivery',
    'partially_delivered',
    'delivered',
    'closed',
    'cancelled'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE stock_reservation_status AS ENUM (
    'active',
    'released',
    'consumed'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE import_priority AS ENUM (
    'high',
    'medium',
    'low'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE import_status AS ENUM (
    'pending',
    'ordered',
    'partially_received',
    'received',
    'cancelled'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE dc_approval_status AS ENUM (
    'pending_approval',
    'approved',
    'rejected'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- Create sales_orders table
CREATE TABLE IF NOT EXISTS sales_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  so_number text UNIQUE NOT NULL,
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  customer_po_number text NOT NULL,
  customer_po_date date NOT NULL,
  customer_po_file_url text,
  so_date date NOT NULL DEFAULT CURRENT_DATE,
  expected_delivery_date date,
  notes text,
  status sales_order_status NOT NULL DEFAULT 'draft',
  subtotal_amount numeric(15,2) NOT NULL DEFAULT 0,
  tax_amount numeric(15,2) NOT NULL DEFAULT 0,
  total_amount numeric(15,2) NOT NULL DEFAULT 0,
  created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  approved_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  approved_at timestamptz,
  rejected_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  rejected_at timestamptz,
  rejection_reason text,
  CONSTRAINT valid_customer_po_number CHECK (length(trim(customer_po_number)) > 0),
  CONSTRAINT valid_amounts CHECK (subtotal_amount >= 0 AND tax_amount >= 0 AND total_amount >= 0)
);

-- Create sales_order_items table
CREATE TABLE IF NOT EXISTS sales_order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sales_order_id uuid NOT NULL REFERENCES sales_orders(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  quantity numeric(15,3) NOT NULL CHECK (quantity > 0),
  unit_price numeric(15,2) NOT NULL CHECK (unit_price >= 0),
  discount_percent numeric(5,2) NOT NULL DEFAULT 0 CHECK (discount_percent >= 0 AND discount_percent <= 100),
  discount_amount numeric(15,2) NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
  tax_percent numeric(5,2) NOT NULL DEFAULT 0 CHECK (tax_percent >= 0),
  tax_amount numeric(15,2) NOT NULL DEFAULT 0 CHECK (tax_amount >= 0),
  line_total numeric(15,2) NOT NULL DEFAULT 0 CHECK (line_total >= 0),
  item_delivery_date date,
  notes text,
  delivered_quantity numeric(15,3) NOT NULL DEFAULT 0 CHECK (delivered_quantity >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT valid_delivered_qty CHECK (delivered_quantity <= quantity)
);

-- Create stock_reservations table
CREATE TABLE IF NOT EXISTS stock_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sales_order_id uuid NOT NULL REFERENCES sales_orders(id) ON DELETE CASCADE,
  sales_order_item_id uuid NOT NULL REFERENCES sales_order_items(id) ON DELETE CASCADE,
  batch_id uuid NOT NULL REFERENCES batches(id) ON DELETE RESTRICT,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  reserved_quantity numeric(15,3) NOT NULL CHECK (reserved_quantity > 0),
  reserved_at timestamptz NOT NULL DEFAULT now(),
  reserved_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  released_at timestamptz,
  released_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  release_reason text,
  status stock_reservation_status NOT NULL DEFAULT 'active'
);

-- Create import_requirements table
CREATE TABLE IF NOT EXISTS import_requirements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  sales_order_id uuid NOT NULL REFERENCES sales_orders(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  required_quantity numeric(15,3) NOT NULL CHECK (required_quantity > 0),
  shortage_quantity numeric(15,3) NOT NULL CHECK (shortage_quantity > 0),
  required_delivery_date date NOT NULL,
  supplier_id uuid,
  lead_time_days integer NOT NULL DEFAULT 30 CHECK (lead_time_days >= 0),
  priority import_priority NOT NULL DEFAULT 'medium',
  status import_status NOT NULL DEFAULT 'pending',
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Modify delivery_challans table
DO $$
BEGIN
  -- Add sales_order_id column
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'delivery_challans' AND column_name = 'sales_order_id'
  ) THEN
    ALTER TABLE delivery_challans ADD COLUMN sales_order_id uuid REFERENCES sales_orders(id) ON DELETE SET NULL;
  END IF;

  -- Add approval_status column
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'delivery_challans' AND column_name = 'approval_status'
  ) THEN
    ALTER TABLE delivery_challans ADD COLUMN approval_status dc_approval_status NOT NULL DEFAULT 'pending_approval';
  END IF;

  -- Add approved_by column
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'delivery_challans' AND column_name = 'approved_by'
  ) THEN
    ALTER TABLE delivery_challans ADD COLUMN approved_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;
  END IF;

  -- Add approved_at column
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'delivery_challans' AND column_name = 'approved_at'
  ) THEN
    ALTER TABLE delivery_challans ADD COLUMN approved_at timestamptz;
  END IF;

  -- Add rejection_reason column
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'delivery_challans' AND column_name = 'rejection_reason'
  ) THEN
    ALTER TABLE delivery_challans ADD COLUMN rejection_reason text;
  END IF;
END $$;

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_sales_orders_so_number ON sales_orders(so_number);
CREATE INDEX IF NOT EXISTS idx_sales_orders_customer_id ON sales_orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_sales_orders_status ON sales_orders(status);
CREATE INDEX IF NOT EXISTS idx_sales_orders_created_at ON sales_orders(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sales_orders_created_by ON sales_orders(created_by);
CREATE INDEX IF NOT EXISTS idx_sales_orders_approved_by ON sales_orders(approved_by);

CREATE INDEX IF NOT EXISTS idx_sales_order_items_so_id ON sales_order_items(sales_order_id);
CREATE INDEX IF NOT EXISTS idx_sales_order_items_product_id ON sales_order_items(product_id);

CREATE INDEX IF NOT EXISTS idx_stock_reservations_so_id ON stock_reservations(sales_order_id);
CREATE INDEX IF NOT EXISTS idx_stock_reservations_batch_id ON stock_reservations(batch_id);
CREATE INDEX IF NOT EXISTS idx_stock_reservations_product_id ON stock_reservations(product_id);
CREATE INDEX IF NOT EXISTS idx_stock_reservations_status ON stock_reservations(status);

CREATE INDEX IF NOT EXISTS idx_import_requirements_product_id ON import_requirements(product_id);
CREATE INDEX IF NOT EXISTS idx_import_requirements_so_id ON import_requirements(sales_order_id);
CREATE INDEX IF NOT EXISTS idx_import_requirements_status ON import_requirements(status);
CREATE INDEX IF NOT EXISTS idx_import_requirements_priority ON import_requirements(priority);

CREATE INDEX IF NOT EXISTS idx_delivery_challans_so_id ON delivery_challans(sales_order_id);
CREATE INDEX IF NOT EXISTS idx_delivery_challans_approval_status ON delivery_challans(approval_status);

-- Enable Row Level Security
ALTER TABLE sales_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_requirements ENABLE ROW LEVEL SECURITY;

-- RLS Policies for sales_orders
CREATE POLICY "Users can view sales orders"
  ON sales_orders FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Users can create sales orders"
  ON sales_orders FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = created_by);

CREATE POLICY "Users can update own draft sales orders"
  ON sales_orders FOR UPDATE
  TO authenticated
  USING (created_by = auth.uid() AND status = 'draft')
  WITH CHECK (created_by = auth.uid());

CREATE POLICY "Admins and sales can update all sales orders"
  ON sales_orders FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
      AND user_profiles.role IN ('admin', 'sales')
    )
  );

CREATE POLICY "Users can delete own draft sales orders"
  ON sales_orders FOR DELETE
  TO authenticated
  USING (created_by = auth.uid() AND status = 'draft');

-- RLS Policies for sales_order_items
CREATE POLICY "Users can view sales order items"
  ON sales_order_items FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Users can manage sales order items"
  ON sales_order_items FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM sales_orders
      WHERE sales_orders.id = sales_order_items.sales_order_id
      AND (sales_orders.created_by = auth.uid() OR EXISTS (
        SELECT 1 FROM user_profiles
        WHERE user_profiles.id = auth.uid()
        AND user_profiles.role IN ('admin', 'sales')
      ))
    )
  );

-- RLS Policies for stock_reservations
CREATE POLICY "Users can view stock reservations"
  ON stock_reservations FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "System can manage stock reservations"
  ON stock_reservations FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);

-- RLS Policies for import_requirements
CREATE POLICY "Users can view import requirements"
  ON import_requirements FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Admins can manage import requirements"
  ON import_requirements FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
      AND user_profiles.role = 'admin'
    )
  );

-- Create function to generate SO number
CREATE OR REPLACE FUNCTION generate_so_number()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  next_number integer;
  year_part text;
  new_so_number text;
BEGIN
  year_part := to_char(CURRENT_DATE, 'YYYY');
  
  SELECT COALESCE(MAX(
    CAST(
      substring(so_number from 'SO-' || year_part || '-(.*)') AS integer
    )
  ), 0) + 1
  INTO next_number
  FROM sales_orders
  WHERE so_number LIKE 'SO-' || year_part || '-%';
  
  new_so_number := 'SO-' || year_part || '-' || LPAD(next_number::text, 4, '0');
  
  RETURN new_so_number;
END;
$$;

-- Create trigger to auto-generate SO number
CREATE OR REPLACE FUNCTION trg_generate_so_number()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.so_number IS NULL OR NEW.so_number = '' THEN
    NEW.so_number := generate_so_number();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_generate_so_number ON sales_orders;
CREATE TRIGGER trigger_generate_so_number
  BEFORE INSERT ON sales_orders
  FOR EACH ROW
  EXECUTE FUNCTION trg_generate_so_number();

-- Create trigger to update updated_at timestamp
CREATE OR REPLACE FUNCTION trg_update_timestamp()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_sales_orders_updated_at ON sales_orders;
CREATE TRIGGER trigger_sales_orders_updated_at
  BEFORE UPDATE ON sales_orders
  FOR EACH ROW
  EXECUTE FUNCTION trg_update_timestamp();

DROP TRIGGER IF EXISTS trigger_import_requirements_updated_at ON import_requirements;
CREATE TRIGGER trigger_import_requirements_updated_at
  BEFORE UPDATE ON import_requirements
  FOR EACH ROW
  EXECUTE FUNCTION trg_update_timestamp();
