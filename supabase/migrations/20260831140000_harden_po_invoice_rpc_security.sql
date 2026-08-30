-- The PO -> Purchase Invoice orchestration RPC is an authenticated workflow.
-- Remove PostgreSQL's default PUBLIC execute privilege so anonymous callers
-- cannot invoke the SECURITY DEFINER function.

REVOKE ALL ON FUNCTION public.create_purchase_invoice_from_po(uuid, jsonb, jsonb)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_purchase_invoice_from_po(uuid, jsonb, jsonb)
  TO authenticated, service_role;
