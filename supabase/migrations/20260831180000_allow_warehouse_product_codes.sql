-- Product RLS already permits warehouse users to create Products. Keep the
-- existing code generator logic and align its role guard with that policy.
CREATE OR REPLACE FUNCTION public.get_next_product_code()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_role text;
  v_max_code text;
  v_next_num integer;
BEGIN
  SELECT role INTO v_role FROM user_profiles WHERE id = auth.uid();
  IF v_role NOT IN ('admin', 'accounts', 'manager', 'warehouse') THEN
    RAISE EXCEPTION 'Permission denied: role % cannot generate product codes', v_role;
  END IF;

  SELECT MAX(product_code) INTO v_max_code
  FROM products
  WHERE product_code ~ '^[A-Z]{2,4}-[0-9]+$';

  IF v_max_code IS NULL THEN RETURN 'PRD-001'; END IF;
  v_next_num := (regexp_match(v_max_code, '[0-9]+$'))[1]::integer + 1;
  RETURN regexp_replace(v_max_code, '[0-9]+$', LPAD(v_next_num::text, 3, '0'));
END;
$function$;
