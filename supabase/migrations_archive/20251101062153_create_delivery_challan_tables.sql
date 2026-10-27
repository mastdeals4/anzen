/*
  # Delivery Challan (Surat Jalan) System

  1. New Tables
    - `delivery_challans`
      - `id` (uuid, primary key)
      - `challan_number` (text, unique) - Auto-generated DO number
      - `customer_id` (uuid, references customers)
      - `challan_date` (date) - Date of delivery challan
      - `delivery_address` (text) - Delivery address
      - `vehicle_number` (text, nullable) - Vehicle/transport details
      - `driver_name` (text, nullable) - Driver name
      - `status` (text) - pending_invoice, invoiced, delivered
      - `notes` (text, nullable) - Additional notes
      - `created_by` (uuid, references auth.users)
      - `created_at` (timestamptz)
      - `updated_at` (timestamptz)
    
    - `delivery_challan_items`
      - `id` (uuid, primary key)
      - `challan_id` (uuid, references delivery_challans)
      - `product_id` (uuid, references products)
      - `batch_id` (uuid, references batches)
      - `quantity` (numeric) - Total quantity dispatched
      - `pack_size` (numeric) - Weight per pack in kg
      - `pack_type` (text) - bag, drum, tin, box, etc.
      - `number_of_packs` (integer) - Number of packs dispatched
      - `created_at` (timestamptz)

  2. Security
    - Enable RLS on both tables
    - Add appropriate policies for authenticated users

  3. Indexes
    - Add indexes for better query performance on customer_id, challan_date, status
*/

-- Create delivery_challans table
CREATE TABLE IF NOT EXISTS delivery_challans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  challan_number text UNIQUE NOT NULL,
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  challan_date date NOT NULL DEFAULT CURRENT_DATE,
  delivery_address text NOT NULL,
  vehicle_number text,
  driver_name text,
  status text NOT NULL DEFAULT 'pending_invoice' CHECK (status IN ('pending_invoice', 'invoiced', 'delivered')),
  notes text,
  created_by uuid NOT NULL REFERENCES auth.users(id),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Create delivery_challan_items table
CREATE TABLE IF NOT EXISTS delivery_challan_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  challan_id uuid NOT NULL REFERENCES delivery_challans(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  batch_id uuid NOT NULL REFERENCES batches(id) ON DELETE RESTRICT,
  quantity numeric NOT NULL CHECK (quantity > 0),
  pack_size numeric,
  pack_type text,
  number_of_packs integer,
  created_at timestamptz DEFAULT now()
);

-- Add indexes for better performance
CREATE INDEX IF NOT EXISTS idx_delivery_challans_customer ON delivery_challans(customer_id);
CREATE INDEX IF NOT EXISTS idx_delivery_challans_date ON delivery_challans(challan_date DESC);
CREATE INDEX IF NOT EXISTS idx_delivery_challans_status ON delivery_challans(status);
CREATE INDEX IF NOT EXISTS idx_delivery_challans_created_at ON delivery_challans(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_delivery_challan_items_challan ON delivery_challan_items(challan_id);
CREATE INDEX IF NOT EXISTS idx_delivery_challan_items_product ON delivery_challan_items(product_id);
CREATE INDEX IF NOT EXISTS idx_delivery_challan_items_batch ON delivery_challan_items(batch_id);

-- Enable RLS
ALTER TABLE delivery_challans ENABLE ROW LEVEL SECURITY;
ALTER TABLE delivery_challan_items ENABLE ROW LEVEL SECURITY;

-- Policies for delivery_challans
CREATE POLICY "Authenticated users can view delivery challans"
  ON delivery_challans FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can create delivery challans"
  ON delivery_challans FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "Authenticated users can update delivery challans"
  ON delivery_challans FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Authenticated users can delete delivery challans"
  ON delivery_challans FOR DELETE
  TO authenticated
  USING (true);

-- Policies for delivery_challan_items
CREATE POLICY "Authenticated users can view delivery challan items"
  ON delivery_challan_items FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can create delivery challan items"
  ON delivery_challan_items FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "Authenticated users can update delivery challan items"
  ON delivery_challan_items FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Authenticated users can delete delivery challan items"
  ON delivery_challan_items FOR DELETE
  TO authenticated
  USING (true);

-- Add link field to sales_invoices if not exists
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'sales_invoices' AND column_name = 'linked_challan_ids'
  ) THEN
    ALTER TABLE sales_invoices ADD COLUMN linked_challan_ids text[];
  END IF;
END $$;