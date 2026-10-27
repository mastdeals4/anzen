/*
  # Add Comprehensive Unit System for Products
  
  ## Overview
  Expands the unit system to support pharmaceutical products sold in various quantities,
  from milligrams to tons, including volume and packaging units.
  
  ## Changes
  
  1. **Expanded Units**
     - Weight: Kilogram (kg), Gram (g), Milligram (mg), Ton (ton)
     - Volume: Litre (litre), Millilitre (ml)
     - Count: Piece (piece), Box (box), Bottle (bottle), Pack (pack)
  
  ## Use Cases
  - Small quantities: 25g, 100mg (for APIs)
  - Medium quantities: 5kg, 10 litres (for excipients)
  - Large quantities: 1 ton (for bulk materials)
  - Packaged goods: bottles, boxes, packs
*/

-- Drop existing constraint
ALTER TABLE products 
  DROP CONSTRAINT IF EXISTS products_unit_check;

-- Add new comprehensive unit constraint
ALTER TABLE products
  ADD CONSTRAINT products_unit_check 
  CHECK (unit IN (
    'kg',        -- Kilogram
    'g',         -- Gram
    'mg',        -- Milligram
    'ton',       -- Ton
    'litre',     -- Litre
    'ml',        -- Millilitre
    'piece',     -- Piece
    'box',       -- Box
    'bottle',    -- Bottle
    'pack'       -- Pack
  ));

-- Update comment to reflect new units
COMMENT ON COLUMN products.unit IS 'Unit of measurement: kg (Kilogram), g (Gram), mg (Milligram), ton (Ton), litre (Litre), ml (Millilitre), piece (Piece), box (Box), bottle (Bottle), pack (Pack)';
COMMENT ON COLUMN products.min_stock_level IS 'Minimum stock threshold for this product, in the product unit. When stock falls below this level, low stock alerts are triggered.';