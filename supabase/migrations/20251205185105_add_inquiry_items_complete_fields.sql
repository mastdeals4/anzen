/*
  # Add Complete Fields to Inquiry Items Table

  1. New Columns Added
    - `supplier_name` (text) - Supplier information per product
    - `supplier_country` (text) - Supplier country per product
    - `delivery_date` (date) - Expected delivery date per product
    - `delivery_terms` (text) - Delivery terms per product
    - `aceerp_no` (text) - ACE ERP number per product
    - `purchase_price` (numeric) - Purchase price per product
    - `purchase_price_currency` (text) - Purchase price currency (default 'USD')
    - `offered_price` (numeric) - Offered price to customer per product
    - `offered_price_currency` (text) - Offered price currency (default 'USD')
    - `our_side_status` (text[]) - Array of status flags like ['P', 'C'] per product
    - `price_sent_at` (timestamptz) - When price was sent for this product
    - `coa_sent_at` (timestamptz) - When COA was sent for this product
    - `sample_sent_at` (timestamptz) - When sample was sent for this product
    - `agency_letter_sent_at` (timestamptz) - When agency letter was sent for this product
    - `remarks` (text) - Additional remarks per product
    - `make` (text) - Manufacturer/make information

  2. Purpose
    - Enable full product-level tracking for multi-quantity inquiries
    - Each quantity variation of same product can have different:
      * Suppliers and pricing
      * Delivery dates and terms
      * Document tracking (P, C, COA, Sample, etc.)
      * Pipeline status and remarks

  3. Security
    - No changes to RLS policies needed (already covered)
*/

-- Add new columns to crm_inquiry_items
DO $$
BEGIN
  -- Supplier information
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'crm_inquiry_items' AND column_name = 'supplier_name'
  ) THEN
    ALTER TABLE crm_inquiry_items ADD COLUMN supplier_name text;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'crm_inquiry_items' AND column_name = 'supplier_country'
  ) THEN
    ALTER TABLE crm_inquiry_items ADD COLUMN supplier_country text;
  END IF;

  -- Delivery information
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'crm_inquiry_items' AND column_name = 'delivery_date'
  ) THEN
    ALTER TABLE crm_inquiry_items ADD COLUMN delivery_date date;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'crm_inquiry_items' AND column_name = 'delivery_terms'
  ) THEN
    ALTER TABLE crm_inquiry_items ADD COLUMN delivery_terms text;
  END IF;

  -- ERP and pricing
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'crm_inquiry_items' AND column_name = 'aceerp_no'
  ) THEN
    ALTER TABLE crm_inquiry_items ADD COLUMN aceerp_no text;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'crm_inquiry_items' AND column_name = 'purchase_price'
  ) THEN
    ALTER TABLE crm_inquiry_items ADD COLUMN purchase_price numeric(15,2);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'crm_inquiry_items' AND column_name = 'purchase_price_currency'
  ) THEN
    ALTER TABLE crm_inquiry_items ADD COLUMN purchase_price_currency text DEFAULT 'USD';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'crm_inquiry_items' AND column_name = 'offered_price'
  ) THEN
    ALTER TABLE crm_inquiry_items ADD COLUMN offered_price numeric(15,2);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'crm_inquiry_items' AND column_name = 'offered_price_currency'
  ) THEN
    ALTER TABLE crm_inquiry_items ADD COLUMN offered_price_currency text DEFAULT 'USD';
  END IF;

  -- Our side status tracking
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'crm_inquiry_items' AND column_name = 'our_side_status'
  ) THEN
    ALTER TABLE crm_inquiry_items ADD COLUMN our_side_status text[] DEFAULT '{}';
  END IF;

  -- Document sent timestamps per product
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'crm_inquiry_items' AND column_name = 'price_sent_at'
  ) THEN
    ALTER TABLE crm_inquiry_items ADD COLUMN price_sent_at timestamptz;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'crm_inquiry_items' AND column_name = 'coa_sent_at'
  ) THEN
    ALTER TABLE crm_inquiry_items ADD COLUMN coa_sent_at timestamptz;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'crm_inquiry_items' AND column_name = 'sample_sent_at'
  ) THEN
    ALTER TABLE crm_inquiry_items ADD COLUMN sample_sent_at timestamptz;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'crm_inquiry_items' AND column_name = 'agency_letter_sent_at'
  ) THEN
    ALTER TABLE crm_inquiry_items ADD COLUMN agency_letter_sent_at timestamptz;
  END IF;

  -- Additional fields
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'crm_inquiry_items' AND column_name = 'remarks'
  ) THEN
    ALTER TABLE crm_inquiry_items ADD COLUMN remarks text;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'crm_inquiry_items' AND column_name = 'make'
  ) THEN
    ALTER TABLE crm_inquiry_items ADD COLUMN make text;
  END IF;
END $$;

-- Create indexes for commonly queried fields
CREATE INDEX IF NOT EXISTS idx_inquiry_items_supplier ON crm_inquiry_items(supplier_name);
CREATE INDEX IF NOT EXISTS idx_inquiry_items_aceerp ON crm_inquiry_items(aceerp_no);
CREATE INDEX IF NOT EXISTS idx_inquiry_items_delivery_date ON crm_inquiry_items(delivery_date);
