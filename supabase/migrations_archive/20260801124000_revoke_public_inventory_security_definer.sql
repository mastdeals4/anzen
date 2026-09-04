-- Trigger functions inherited PostgreSQL's default PUBLIC EXECUTE privilege.
-- Anonymous users inherit PUBLIC, so both grants must be removed.

BEGIN;

DO $revoke_public_inventory_security_definer$
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
      'REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon',
      v_function.signature
    );
  END LOOP;
END;
$revoke_public_inventory_security_definer$;

COMMIT;
