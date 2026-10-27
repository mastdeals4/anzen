/*
  # Auto Product Code Generation

  1. Backfills all products missing a product_code with PROD-XXXX format
  2. Creates a sequence-based trigger so new products get auto-coded
  3. Creates a helper function get_next_product_code() for frontend use

  The existing max code is PROD-0016, so backfill starts from PROD-0017.
*/

CREATE OR REPLACE FUNCTION public.get_next_product_code()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_next_num integer;
BEGIN
  SELECT COALESCE(MAX(CAST(SUBSTRING(product_code FROM 6) AS INTEGER)), 0) + 1
  INTO v_next_num
  FROM products
  WHERE product_code ~ '^PROD-[0-9]+$';

  RETURN 'PROD-' || LPAD(v_next_num::text, 4, '0');
END;
$$;

CREATE OR REPLACE FUNCTION public.auto_assign_product_code()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.product_code IS NULL OR NEW.product_code = '' THEN
    NEW.product_code := get_next_product_code();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_auto_product_code ON products;
CREATE TRIGGER trg_auto_product_code
  BEFORE INSERT ON products
  FOR EACH ROW
  EXECUTE FUNCTION auto_assign_product_code();

DO $$
DECLARE
  v_id uuid;
  v_num integer := 17;
BEGIN
  FOR v_id IN (
    SELECT id FROM products
    WHERE (product_code IS NULL OR product_code = '')
    ORDER BY created_at
  ) LOOP
    UPDATE products
    SET product_code = 'PROD-' || LPAD(v_num::text, 4, '0')
    WHERE id = v_id;
    v_num := v_num + 1;
  END LOOP;
END $$;
