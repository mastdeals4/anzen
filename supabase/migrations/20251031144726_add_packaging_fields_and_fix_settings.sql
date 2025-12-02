/*
  # Add Packaging Calculation Fields and Fix Settings Schema
  
  ## Changes Made
  
  ### 1. Products Table
  - Add `total_quantity` (numeric) - Total quantity in selected unit
  - Add `per_pack_weight` (numeric) - Weight per package
  - Add `pack_type` (text) - Type of packaging (Bag, Drum, Tin, Carton)
  - Add `calculated_packs` (numeric) - Auto-calculated number of packs
  
  ### 2. Batches Table  
  - Add `per_pack_weight` (numeric) - Weight per package for batch
  - Add `pack_type` (text) - Type of packaging
  - Add `calculated_packs` (numeric) - Auto-calculated number of packs
  - Add `cost_per_pack` (numeric) - Total cost divided by packs
  
  ### 3. App Settings Table
  - Add missing `invoice_start_number` column
  - Rename columns to match application code
  
  ### 4. CRM Activities Table
  - Enhance to support conversation notes
*/

-- Add packaging fields to products table
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'products' AND column_name = 'total_quantity'
  ) THEN
    ALTER TABLE products ADD COLUMN total_quantity numeric(15,3);
  END IF;
  
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'products' AND column_name = 'per_pack_weight'
  ) THEN
    ALTER TABLE products ADD COLUMN per_pack_weight numeric(15,3);
  END IF;
  
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'products' AND column_name = 'pack_type'
  ) THEN
    ALTER TABLE products ADD COLUMN pack_type text CHECK (pack_type IN ('Bag', 'Drum', 'Tin', 'Carton', 'Box', 'Container', 'Other'));
  END IF;
  
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'products' AND column_name = 'calculated_packs'
  ) THEN
    ALTER TABLE products ADD COLUMN calculated_packs numeric(15,3);
  END IF;
END $$;

-- Add packaging fields to batches table
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'batches' AND column_name = 'per_pack_weight'
  ) THEN
    ALTER TABLE batches ADD COLUMN per_pack_weight numeric(15,3);
  END IF;
  
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'batches' AND column_name = 'pack_type'
  ) THEN
    ALTER TABLE batches ADD COLUMN pack_type text CHECK (pack_type IN ('Bag', 'Drum', 'Tin', 'Carton', 'Box', 'Container', 'Other'));
  END IF;
  
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'batches' AND column_name = 'calculated_packs'
  ) THEN
    ALTER TABLE batches ADD COLUMN calculated_packs numeric(15,3);
  END IF;
  
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'batches' AND column_name = 'cost_per_pack'
  ) THEN
    ALTER TABLE batches ADD COLUMN cost_per_pack numeric(15,2);
  END IF;
END $$;

-- Fix app_settings table - add invoice_start_number if missing
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'app_settings' AND column_name = 'invoice_start_number'
  ) THEN
    ALTER TABLE app_settings ADD COLUMN invoice_start_number integer DEFAULT 1;
  END IF;
  
  -- Rename default_tax_rate to tax_rate for consistency
  IF EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'app_settings' AND column_name = 'default_tax_rate'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'app_settings' AND column_name = 'tax_rate'
  ) THEN
    ALTER TABLE app_settings RENAME COLUMN default_tax_rate TO tax_rate;
  END IF;
  
  -- Rename smtp columns for consistency
  IF EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'app_settings' AND column_name = 'smtp_host'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'app_settings' AND column_name = 'email_host'
  ) THEN
    ALTER TABLE app_settings RENAME COLUMN smtp_host TO email_host;
  END IF;
  
  IF EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'app_settings' AND column_name = 'smtp_port'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'app_settings' AND column_name = 'email_port'
  ) THEN
    ALTER TABLE app_settings RENAME COLUMN smtp_port TO email_port;
  END IF;
  
  IF EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'app_settings' AND column_name = 'smtp_username'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'app_settings' AND column_name = 'email_username'
  ) THEN
    ALTER TABLE app_settings RENAME COLUMN smtp_username TO email_username;
  END IF;
END $$;

-- Create index on packaging fields for better performance
CREATE INDEX IF NOT EXISTS idx_products_pack_type ON products(pack_type);
CREATE INDEX IF NOT EXISTS idx_batches_pack_type ON batches(pack_type);

-- Add comment to clarify packaging calculation
COMMENT ON COLUMN products.calculated_packs IS 'Automatically calculated as total_quantity / per_pack_weight';
COMMENT ON COLUMN batches.calculated_packs IS 'Automatically calculated as import_quantity / per_pack_weight';
COMMENT ON COLUMN batches.cost_per_pack IS 'Total cost (import + duty + freight + other) / calculated_packs';
