BEGIN;

-- Remove the fifth-argument default so four-argument SQL calls resolve only
-- to the compatibility wrapper. PostgREST continues calling all five named
-- parameters from the current UI.
ALTER FUNCTION public.link_bank_statement_line(uuid,text,uuid,text,numeric)
  RENAME TO link_bank_statement_line_with_default;

CREATE FUNCTION public.link_bank_statement_line(
  p_bank_line_id uuid,p_document_type text,p_document_id uuid,
  p_payment_kind text,p_allocation_amount numeric
) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT public.link_bank_statement_line_with_default(
    p_bank_line_id,p_document_type,p_document_id,p_payment_kind,p_allocation_amount
  );
$$;

DROP FUNCTION public.link_bank_statement_line_with_default(uuid,text,uuid,text,numeric);

REVOKE ALL ON FUNCTION public.link_bank_statement_line(uuid,text,uuid,text,numeric)
FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.link_bank_statement_line(uuid,text,uuid,text,numeric)
TO authenticated,service_role;

NOTIFY pgrst,'reload schema';
COMMIT;
