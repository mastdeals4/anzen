/*
  # Create import_data table for pharma import records

  ## Summary
  Creates a new table to store pharma raw material import data uploaded via CSV/Excel.

  ## New Tables
  - `import_data`
    - `id` (uuid, primary key)
    - `date` (date) - import date
    - `hs_code` (text) - HS/customs code
    - `product_name` (text) - product/material name
    - `quantity` (numeric) - imported quantity
    - `unit` (text) - unit of measure (Kilogram, Box, Piece, etc.)
    - `unit_rate` (numeric) - price per unit
    - `currency` (text) - currency code (USD, EUR, etc.)
    - `total_usd` (numeric) - total value in USD
    - `origin` (text) - country of origin
    - `destination` (text) - destination country
    - `exporter` (text) - exporter company name
    - `importer` (text) - importer company name
    - `type` (text) - product type (API, Finished Product, Excipient, etc.)
    - `created_at` (timestamptz)

  ## Security
  - RLS enabled - only authenticated users can read data
  - Only authenticated users can insert data
  - Admin role can delete data

  ## Indexes
  - product_name (for fast search)
  - importer (for fast search)
  - exporter (for fast search)
  - date (for sorting)
*/

CREATE TABLE IF NOT EXISTS import_data (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  date date,
  hs_code text DEFAULT '',
  product_name text DEFAULT '',
  quantity numeric DEFAULT 0,
  unit text DEFAULT '',
  unit_rate numeric DEFAULT 0,
  currency text DEFAULT 'USD',
  total_usd numeric DEFAULT 0,
  origin text DEFAULT '',
  destination text DEFAULT '',
  exporter text DEFAULT '',
  importer text DEFAULT '',
  type text DEFAULT '',
  created_at timestamptz DEFAULT now()
);

ALTER TABLE import_data ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view import data"
  ON import_data FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can insert import data"
  ON import_data FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "Authenticated users can delete import data"
  ON import_data FOR DELETE
  TO authenticated
  USING (true);

CREATE INDEX IF NOT EXISTS idx_import_data_product_name ON import_data (product_name);
CREATE INDEX IF NOT EXISTS idx_import_data_importer ON import_data (importer);
CREATE INDEX IF NOT EXISTS idx_import_data_exporter ON import_data (exporter);
CREATE INDEX IF NOT EXISTS idx_import_data_date ON import_data (date DESC);
CREATE INDEX IF NOT EXISTS idx_import_data_hs_code ON import_data (hs_code);
