/*
  # Create Multi-Product Inquiry System

  1. New Tables
    - `crm_inquiry_items`
      - `id` (uuid, primary key)
      - `parent_inquiry_id` (uuid, references crm_inquiries)
      - `inquiry_number` (text) - Format: INQ-2025-001.1, INQ-2025-001.2, etc.
      - `product_name` (text)
      - `specification` (text, nullable)
      - `quantity` (text, nullable)
      - `target_price` (text, nullable)
      - `status` (text) - Individual product status
      - `pipeline_stage` (text) - Individual pipeline stage
      - `document_sent` (boolean) - Per-product document tracking
      - `document_sent_at` (timestamptz, nullable)
      - `notes` (text, nullable)
      - `created_at` (timestamptz)
      - `updated_at` (timestamptz)

  2. Changes to Existing Tables
    - Add `is_multi_product` boolean to crm_inquiries
    - Add `has_items` boolean to crm_inquiries (parent inquiry indicator)

  3. Security
    - Enable RLS on crm_inquiry_items
    - Add policies for authenticated users to manage their inquiry items

  4. Indexes
    - Index on parent_inquiry_id for fast child lookups
    - Index on inquiry_number for quick searches
*/

-- Add fields to crm_inquiries table
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'crm_inquiries' AND column_name = 'is_multi_product'
  ) THEN
    ALTER TABLE crm_inquiries ADD COLUMN is_multi_product boolean DEFAULT false;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'crm_inquiries' AND column_name = 'has_items'
  ) THEN
    ALTER TABLE crm_inquiries ADD COLUMN has_items boolean DEFAULT false;
  END IF;
END $$;

-- Create inquiry items table
CREATE TABLE IF NOT EXISTS crm_inquiry_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_inquiry_id uuid NOT NULL REFERENCES crm_inquiries(id) ON DELETE CASCADE,
  inquiry_number text NOT NULL,
  product_name text NOT NULL,
  specification text,
  quantity text,
  target_price text,
  status text DEFAULT 'open',
  pipeline_stage text DEFAULT 'new',
  document_sent boolean DEFAULT false,
  document_sent_at timestamptz,
  notes text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Enable RLS
ALTER TABLE crm_inquiry_items ENABLE ROW LEVEL SECURITY;

-- RLS Policies
CREATE POLICY "Users can view inquiry items"
  ON crm_inquiry_items FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Users can insert inquiry items"
  ON crm_inquiry_items FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "Users can update inquiry items"
  ON crm_inquiry_items FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Users can delete inquiry items"
  ON crm_inquiry_items FOR DELETE
  TO authenticated
  USING (true);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_inquiry_items_parent ON crm_inquiry_items(parent_inquiry_id);
CREATE INDEX IF NOT EXISTS idx_inquiry_items_number ON crm_inquiry_items(inquiry_number);
CREATE INDEX IF NOT EXISTS idx_inquiry_items_status ON crm_inquiry_items(status);
CREATE INDEX IF NOT EXISTS idx_inquiry_items_pipeline ON crm_inquiry_items(pipeline_stage);

-- Update timestamp trigger
CREATE OR REPLACE FUNCTION update_inquiry_items_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_inquiry_items_updated_at ON crm_inquiry_items;
CREATE TRIGGER update_inquiry_items_updated_at
  BEFORE UPDATE ON crm_inquiry_items
  FOR EACH ROW
  EXECUTE FUNCTION update_inquiry_items_updated_at();
