-- SAPJ Master Data Standardization
-- Product ↔ Batch Packaging & Country Master Data Normalization

BEGIN;

-- 1. Normalize historical product packaging strings and backfill pack_type and per_pack_weight
-- Sync products that already have canonical pack_type and per_pack_weight
UPDATE products
SET packaging_type = pack_type
WHERE (packaging_type IS NULL OR trim(packaging_type) = '')
  AND pack_type IN ('Bag', 'Drum', 'Tin', 'Box', 'Carton', 'Pallet');

-- Normalize known free-text packaging strings
UPDATE products
SET packaging_type = 'Drum',
    pack_type = 'Drum',
    per_pack_weight = 25.000
WHERE packaging_type IN ('25kg Drum', '25kg durm');

UPDATE products
SET packaging_type = 'Bag',
    pack_type = 'Bag',
    per_pack_weight = 25.000
WHERE packaging_type IN ('25kg woven bag', '25 KGS');

UPDATE products
SET packaging_type = 'Drum',
    pack_type = 'Drum',
    per_pack_weight = 25.000
WHERE trim(packaging_type) = '600 kg' OR product_name ILIKE '%Piperazine Phosphate%';

-- Normalize products where numeric batch quantity was erroneously entered as packaging_type
UPDATE products
SET packaging_type = 'Drum',
    pack_type = 'Drum',
    per_pack_weight = 20.000
WHERE product_name ILIKE '%Cefixime Trihydrate Powder Micronized%';

UPDATE products
SET packaging_type = 'Drum',
    pack_type = 'Drum',
    per_pack_weight = 10.000
WHERE product_name ILIKE '%Cyproheptadine Hydrochloride%';

UPDATE products
SET packaging_type = 'Drum',
    pack_type = 'Drum',
    per_pack_weight = 25.000
WHERE product_name ILIKE '%Diclofenac Potassium%';

UPDATE products
SET packaging_type = 'Drum',
    pack_type = 'Drum',
    per_pack_weight = 10.000
WHERE product_name ILIKE '%Domperidone BP%';

UPDATE products
SET packaging_type = 'Drum',
    pack_type = 'Drum',
    per_pack_weight = 50.000
WHERE product_name ILIKE '%Ibuprofen%' AND (per_pack_weight IS NULL OR packaging_type IN ('3000', '1000'));

UPDATE products
SET packaging_type = 'Drum',
    pack_type = 'Drum',
    per_pack_weight = 10.000
WHERE product_name ILIKE '%Loratadine%';

UPDATE products
SET packaging_type = 'Drum',
    pack_type = 'Drum',
    per_pack_weight = 25.000
WHERE product_name ILIKE '%Sulfamethoxazole%';

UPDATE products
SET packaging_type = 'Drum',
    pack_type = 'Drum',
    per_pack_weight = 25.000
WHERE product_name ILIKE '%Trimethoprim%';

-- Remaining products with empty packaging_type verified against batch packaging
UPDATE products
SET packaging_type = 'Drum',
    pack_type = 'Drum',
    per_pack_weight = 25.000
WHERE product_name IN (
  'Cefixime USP',
  'Cetirizine Hydrochloride EP',
  'Diclofenac Diethylamine BP',
  'Diclofenac Sodium',
  'Ketoconazole USP',
  'Meloxicam USP',
  'Pregabalin'
) AND (packaging_type IS NULL OR packaging_type = '');

UPDATE products
SET packaging_type = 'Box',
    pack_type = 'Box',
    per_pack_weight = 250.000
WHERE product_name ILIKE '%Mometasone Furoate%'
  AND (packaging_type IS NULL OR packaging_type = '');

-- Fallback for any other product: sync pack_type and packaging_type
UPDATE products
SET pack_type = packaging_type
WHERE pack_type IS NULL AND packaging_type IN ('Bag', 'Drum', 'Tin', 'Box', 'Carton', 'Pallet');

-- 2. Add validation constraint to products table
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_packaging_type_canonical;
ALTER TABLE products ADD CONSTRAINT products_packaging_type_canonical
  CHECK (packaging_type IS NULL OR packaging_type IN ('Bag', 'Drum', 'Tin', 'Box', 'Carton', 'Pallet'));

-- 3. Canonical country normalization on product_sources (idempotent)
UPDATE product_sources
SET country = 'China'
WHERE country ILIKE 'china' OR country ILIKE 'prc' OR country IN ('CN', 'CHN');

UPDATE product_sources
SET country = 'India'
WHERE country ILIKE 'india' OR country IN ('IN', 'IND');

UPDATE product_sources
SET country = 'Indonesia'
WHERE country ILIKE 'indonesia' OR country IN ('ID', 'IDN');

ALTER TABLE product_sources DROP CONSTRAINT IF EXISTS product_sources_country_not_empty;
ALTER TABLE product_sources ADD CONSTRAINT product_sources_country_not_empty
  CHECK (country IS NULL OR length(trim(country)) > 0);

COMMIT;
