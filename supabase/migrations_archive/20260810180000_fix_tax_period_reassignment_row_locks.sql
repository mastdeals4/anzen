-- PostgreSQL does not permit FOR UPDATE on the nullable side of an outer
-- join. Lock the source document row first, then read its optional tax code
-- separately before changing only the existing reporting-period reference.
BEGIN;

CREATE OR REPLACE FUNCTION public.reassign_tax_document_period(
  p_source text,
  p_document_id uuid,
  p_tax_period_id uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_target public.tax_periods%ROWTYPE;
  v_old_period_id uuid;
  v_tax_type text;
  v_tax_code_id uuid;
BEGIN
  SELECT * INTO v_target
    FROM public.tax_periods
   WHERE id = p_tax_period_id
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Tax period % not found', p_tax_period_id; END IF;
  IF v_target.status IN ('closed', 'filed') OR v_target.filing_status = 'filed' THEN
    RAISE EXCEPTION 'Tax period % is filed or closed and cannot be selected', p_tax_period_id;
  END IF;

  CASE p_source
    WHEN 'purchase_invoice' THEN
      SELECT tax_period_id INTO v_old_period_id FROM public.purchase_invoices WHERE id=p_document_id FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'Purchase invoice % not found', p_document_id; END IF;
      IF v_target.tax_type <> 'PPN' THEN RAISE EXCEPTION 'Purchase invoices require a PPN tax period'; END IF;
    WHEN 'sales_invoice' THEN
      SELECT tax_period_id INTO v_old_period_id FROM public.sales_invoices WHERE id=p_document_id FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'Sales invoice % not found', p_document_id; END IF;
      IF v_target.tax_type <> 'PPN' THEN RAISE EXCEPTION 'Sales invoices require a PPN tax period'; END IF;
    WHEN 'credit_note' THEN
      SELECT tax_period_id INTO v_old_period_id FROM public.credit_notes WHERE id=p_document_id FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'Credit note % not found', p_document_id; END IF;
      IF v_target.tax_type <> 'PPN' THEN RAISE EXCEPTION 'Credit notes require a PPN tax period'; END IF;
    WHEN 'finance_expense_ppn' THEN
      SELECT tax_period_id INTO v_old_period_id FROM public.finance_expenses WHERE id=p_document_id FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'Expense % not found', p_document_id; END IF;
      IF v_target.tax_type <> 'PPN' THEN RAISE EXCEPTION 'Expenses require a PPN tax period for PPN reporting'; END IF;
    WHEN 'finance_expense_pph' THEN
      SELECT pph_tax_period_id, pph_code_id INTO v_old_period_id, v_tax_code_id
        FROM public.finance_expenses WHERE id=p_document_id FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'Expense % not found', p_document_id; END IF;
      SELECT tax_type INTO v_tax_type FROM public.tax_codes WHERE id=v_tax_code_id;
      IF v_tax_type IS NULL OR v_target.tax_type <> v_tax_type THEN RAISE EXCEPTION 'Expense PPh tax type must match the selected period'; END IF;
    WHEN 'payment_voucher' THEN
      SELECT tax_period_id, pph_code_id INTO v_old_period_id, v_tax_code_id
        FROM public.payment_vouchers WHERE id=p_document_id FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'Payment voucher % not found', p_document_id; END IF;
      SELECT tax_type INTO v_tax_type FROM public.tax_codes WHERE id=v_tax_code_id;
      IF v_tax_type IS NULL OR v_target.tax_type <> v_tax_type THEN RAISE EXCEPTION 'Payment voucher PPh tax type must match the selected period'; END IF;
    ELSE
      RAISE EXCEPTION 'Unsupported tax document source %', p_source;
  END CASE;

  IF v_old_period_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.tax_periods
     WHERE id=v_old_period_id AND (status IN ('closed', 'filed') OR filing_status='filed')
  ) THEN
    RAISE EXCEPTION 'The current tax period is filed or closed; reopen it before changing this document';
  END IF;

  CASE p_source
    WHEN 'purchase_invoice' THEN UPDATE public.purchase_invoices SET tax_period_id=p_tax_period_id WHERE id=p_document_id;
    WHEN 'sales_invoice' THEN
      UPDATE public.sales_invoices SET tax_period_id=p_tax_period_id WHERE id=p_document_id;
      UPDATE public.faktur_pajak SET tax_period_id=p_tax_period_id WHERE sales_invoice_id=p_document_id;
    WHEN 'credit_note' THEN UPDATE public.credit_notes SET tax_period_id=p_tax_period_id WHERE id=p_document_id;
    WHEN 'finance_expense_ppn' THEN UPDATE public.finance_expenses SET tax_period_id=p_tax_period_id WHERE id=p_document_id;
    WHEN 'finance_expense_pph' THEN UPDATE public.finance_expenses SET pph_tax_period_id=p_tax_period_id WHERE id=p_document_id;
    WHEN 'payment_voucher' THEN UPDATE public.payment_vouchers SET tax_period_id=p_tax_period_id WHERE id=p_document_id;
  END CASE;

  IF v_old_period_id IS NOT NULL THEN PERFORM public.compute_period_ppn(v_old_period_id); END IF;
  PERFORM public.compute_period_ppn(p_tax_period_id);
END;
$$;

REVOKE ALL ON FUNCTION public.reassign_tax_document_period(text, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reassign_tax_document_period(text, uuid, uuid) TO authenticated, service_role;
NOTIFY pgrst, 'reload schema';
COMMIT;
