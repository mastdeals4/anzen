BEGIN;

-- Existing four-argument callers retain their strict exact-match contract.
-- Partial reconciliation is available only through the five-argument RPC,
-- where the UI has displayed and confirmed the explicit allocation amount.
CREATE OR REPLACE FUNCTION public.link_bank_statement_line(
  p_bank_line_id uuid,p_document_type text,p_document_id uuid,p_payment_kind text DEFAULT 'supplier'
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_bank_amount numeric;
BEGIN
  SELECT COALESCE(NULLIF(debit_amount,0),credit_amount,0) INTO v_bank_amount
  FROM public.bank_statement_lines WHERE id=p_bank_line_id;
  RETURN public.link_bank_statement_line(
    p_bank_line_id,p_document_type,p_document_id,p_payment_kind,v_bank_amount
  );
END $$;

REVOKE ALL ON FUNCTION public.link_bank_statement_line(uuid,text,uuid,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.link_bank_statement_line(uuid,text,uuid,text) TO authenticated,service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
