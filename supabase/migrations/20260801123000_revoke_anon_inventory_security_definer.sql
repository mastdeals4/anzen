-- ERP V1 security freeze: Inventory and stock SECURITY DEFINER functions are
-- internal or authenticated ERP entrypoints. Anonymous execution is forbidden.

BEGIN;

DO $revoke_anon_inventory_security_definer$
DECLARE
  v_function record;
BEGIN
  FOR v_function IN
    SELECT p.oid::regprocedure AS signature
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prosecdef
      AND p.proname ~* '(inventory|stock|batch|reservation|delivery)'
  LOOP
    EXECUTE format(
      'REVOKE ALL ON FUNCTION %s FROM anon',
      v_function.signature
    );
  END LOOP;
END;
$revoke_anon_inventory_security_definer$;

COMMIT;
