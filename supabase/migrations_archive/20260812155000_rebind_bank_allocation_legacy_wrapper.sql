BEGIN;

CREATE OR REPLACE FUNCTION public.link_bank_statement_line(
  p_bank_line_id uuid,p_document_type text,p_document_id uuid,p_payment_kind text DEFAULT 'supplier'
) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT public.link_bank_statement_line(p_bank_line_id,p_document_type,p_document_id,p_payment_kind,NULL::numeric);
$$;

REVOKE ALL ON FUNCTION public.link_bank_statement_line(uuid,text,uuid,text)
FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.link_bank_statement_line(uuid,text,uuid,text)
TO authenticated,service_role;

NOTIFY pgrst,'reload schema';
COMMIT;
