-- Fix dynamic PPh period reassignment, trigger synchronization, and canonical amounts
BEGIN;

-- 1. Central authoritative source resolver that handles reassigned expenses in PPh_Unifikasi
--    and includes missing_source_verified historical tax payments.
CREATE OR REPLACE FUNCTION public.fn_pph_authoritative_source_total(p_period_id uuid)
RETURNS numeric LANGUAGE sql STABLE SET search_path = public AS $$
  WITH period AS (
    SELECT id, fiscal_year, period_month, tax_type, period_start, period_end
      FROM public.tax_periods WHERE id = p_period_id AND tax_type <> 'PPN'
  )
  SELECT COALESCE((
    SELECT SUM(fe.pph_amount)
      FROM period p
      JOIN public.finance_expenses fe
        ON (fe.pph_tax_period_id = p.id
            OR (p.tax_type = 'PPh_Unifikasi' AND EXISTS (
                SELECT 1 FROM public.tax_periods p_sub
                 WHERE p_sub.id = fe.pph_tax_period_id
                   AND p_sub.fiscal_year = p.fiscal_year
                   AND p_sub.period_month = p.period_month
            ))
            OR (fe.pph_tax_period_id IS NULL AND fe.expense_date BETWEEN p.period_start AND p.period_end))
      JOIN public.effective_expense_posting_state eps ON eps.expense_id = fe.id
       AND eps.effective_posting_state IN ('ACTIVE','REPLACED')
      LEFT JOIN public.tax_codes tc ON tc.id = fe.pph_code_id
     WHERE fe.approval_status = 'approved' AND fe.pph_amount > 0
       AND COALESCE(fe.expense_category,'') NOT IN ('pib_import','pph_import')
       AND (p.tax_type = 'PPh_Unifikasi' OR tc.tax_type = p.tax_type)
  ),0) + COALESCE((
    SELECT SUM(pv.pph_amount) FROM period p
      JOIN public.payment_vouchers pv ON (pv.tax_period_id = p.id
        OR (p.tax_type = 'PPh_Unifikasi' AND EXISTS (
            SELECT 1 FROM public.tax_periods p_sub
             WHERE p_sub.id = pv.tax_period_id
               AND p_sub.fiscal_year = p.fiscal_year
               AND p_sub.period_month = p.period_month
        ))
        OR (pv.tax_period_id IS NULL AND pv.voucher_date BETWEEN p.period_start AND p.period_end))
      LEFT JOIN public.tax_codes tc ON tc.id = pv.pph_code_id
     WHERE COALESCE(pv.is_posted,false) AND pv.pph_amount > 0
       AND (p.tax_type = 'PPh_Unifikasi' OR tc.tax_type = p.tax_type)
  ),0) + COALESCE((
    SELECT SUM(CASE WHEN fe.expense_category='pib_import' THEN COALESCE(fe.pib_pph_amount,0) ELSE COALESCE(fe.amount,0) END)
      FROM period p JOIN public.finance_expenses fe ON (fe.pph_tax_period_id = p.id
        OR (p.tax_type = 'PPh_Unifikasi' AND EXISTS (
            SELECT 1 FROM public.tax_periods p_sub
             WHERE p_sub.id = fe.pph_tax_period_id
               AND p_sub.fiscal_year = p.fiscal_year
               AND p_sub.period_month = p.period_month
        ))
        OR (fe.pph_tax_period_id IS NULL AND fe.expense_date BETWEEN p.period_start AND p.period_end))
      JOIN public.effective_expense_posting_state eps ON eps.expense_id = fe.id
       AND eps.effective_posting_state IN ('ACTIVE','REPLACED')
     WHERE p.tax_type IN ('PPh22','PPh_Unifikasi') AND fe.approval_status='approved'
       AND fe.expense_category IN ('pib_import','pph_import')
  ),0) + COALESCE((
    SELECT SUM(tp.amount) FROM period p
      JOIN public.tax_payments tp ON tp.tax_period_id = p.id
     WHERE (p.tax_type = 'PPh_Unifikasi' OR tp.tax_type = p.tax_type)
       AND tp.historical_source_status = 'missing_source_verified'
  ),0);
$$;

-- 2. Make canonical PPh total dynamic for all unfiled/open/partial periods
CREATE OR REPLACE VIEW public.vw_canonical_tax_period_amounts AS
WITH amounts AS (
 SELECT tp.*, public.fn_tax_payments_paid(tp.id) actual_paid,
   CASE WHEN tp.status IN ('filed','closed') OR tp.filing_status = 'filed' THEN tp.pph_total
        ELSE public.fn_pph_authoritative_source_total(tp.id) END::numeric(18,2) resolved_pph_total
 FROM public.tax_periods tp
)
SELECT id tax_period_id,fiscal_year,period_month,tax_type,status,filing_status,
 payment_due_date,filing_due_date,input_ppn_total,output_ppn_total,net_ppn,
 CASE WHEN tax_type='PPN' THEN 0::numeric(18,2) ELSE resolved_pph_total END pph_total,
 CASE WHEN tax_type='PPN' THEN net_ppn ELSE resolved_pph_total END::numeric(18,2) total_tax,
 actual_paid paid_amount,
 GREATEST((CASE WHEN tax_type='PPN' THEN net_ppn ELSE resolved_pph_total END)-actual_paid,0) outstanding_amount,
 GREATEST(actual_paid-(CASE WHEN tax_type='PPN' THEN net_ppn ELSE resolved_pph_total END),0) overpaid_amount,
 (CASE WHEN tax_type='PPN' THEN net_ppn ELSE resolved_pph_total END)-actual_paid net_position,
 public.fn_tax_period_payment_status(status,CASE WHEN tax_type='PPN' THEN net_ppn ELSE resolved_pph_total END,actual_paid,payment_due_date) payment_status,
 public.fn_period_payment_source(CASE WHEN tax_type='PPN' THEN net_ppn ELSE resolved_pph_total END,actual_paid,0) payment_source,
 (SELECT count(*) FROM public.tax_payments p WHERE p.tax_period_id=amounts.id AND p.status='reconciled') reconciled_payments_count,
 (SELECT count(*) FROM public.tax_payments p WHERE p.tax_period_id=amounts.id AND p.status IN ('draft','posted')) unreconciled_payments_count,
 (SELECT count(*) FROM public.sales_invoices si WHERE si.tax_period_id=amounts.id AND COALESCE(si.faktur_pajak_number,'')='' AND si.tax_amount>0) missing_faktur_count
FROM amounts;

ALTER VIEW public.vw_canonical_tax_period_amounts SET (security_invoker = true);
GRANT SELECT ON public.vw_canonical_tax_period_amounts TO anon, authenticated, service_role;

-- 3. Update reassign_tax_document_period to resolve default/implicit periods and recompute both periods
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
  v_doc_date date;
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
      SELECT tax_period_id, invoice_date INTO v_old_period_id, v_doc_date FROM public.purchase_invoices WHERE id=p_document_id FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'Purchase invoice % not found', p_document_id; END IF;
      IF v_target.tax_type <> 'PPN' THEN RAISE EXCEPTION 'Purchase invoices require a PPN tax period'; END IF;
      IF v_old_period_id IS NULL AND v_doc_date IS NOT NULL THEN
        SELECT id INTO v_old_period_id FROM public.tax_periods WHERE tax_type = 'PPN' AND v_doc_date BETWEEN period_start AND period_end;
      END IF;

    WHEN 'sales_invoice' THEN
      SELECT tax_period_id, invoice_date INTO v_old_period_id, v_doc_date FROM public.sales_invoices WHERE id=p_document_id FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'Sales invoice % not found', p_document_id; END IF;
      IF v_target.tax_type <> 'PPN' THEN RAISE EXCEPTION 'Sales invoices require a PPN tax period'; END IF;
      IF v_old_period_id IS NULL AND v_doc_date IS NOT NULL THEN
        SELECT id INTO v_old_period_id FROM public.tax_periods WHERE tax_type = 'PPN' AND v_doc_date BETWEEN period_start AND period_end;
      END IF;

    WHEN 'credit_note' THEN
      SELECT tax_period_id, issue_date INTO v_old_period_id, v_doc_date FROM public.credit_notes WHERE id=p_document_id FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'Credit note % not found', p_document_id; END IF;
      IF v_target.tax_type <> 'PPN' THEN RAISE EXCEPTION 'Credit notes require a PPN tax period'; END IF;
      IF v_old_period_id IS NULL AND v_doc_date IS NOT NULL THEN
        SELECT id INTO v_old_period_id FROM public.tax_periods WHERE tax_type = 'PPN' AND v_doc_date BETWEEN period_start AND period_end;
      END IF;

    WHEN 'finance_expense_ppn' THEN
      SELECT tax_period_id, expense_date INTO v_old_period_id, v_doc_date FROM public.finance_expenses WHERE id=p_document_id FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'Expense % not found', p_document_id; END IF;
      IF v_target.tax_type <> 'PPN' THEN RAISE EXCEPTION 'Expenses require a PPN tax period for PPN reporting'; END IF;
      IF v_old_period_id IS NULL AND v_doc_date IS NOT NULL THEN
        SELECT id INTO v_old_period_id FROM public.tax_periods WHERE tax_type = 'PPN' AND v_doc_date BETWEEN period_start AND period_end;
      END IF;

    WHEN 'finance_expense_pph' THEN
      SELECT pph_tax_period_id, pph_code_id, expense_date INTO v_old_period_id, v_tax_code_id, v_doc_date
        FROM public.finance_expenses WHERE id=p_document_id FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'Expense % not found', p_document_id; END IF;
      SELECT tax_type INTO v_tax_type FROM public.tax_codes WHERE id=v_tax_code_id;
      IF v_tax_type IS NULL OR v_target.tax_type <> v_tax_type THEN RAISE EXCEPTION 'Expense PPh tax type must match the selected period'; END IF;
      IF v_old_period_id IS NULL AND v_doc_date IS NOT NULL THEN
        SELECT id INTO v_old_period_id FROM public.tax_periods WHERE tax_type = v_tax_type AND v_doc_date BETWEEN period_start AND period_end;
      END IF;

    WHEN 'payment_voucher' THEN
      SELECT tax_period_id, pph_code_id, voucher_date INTO v_old_period_id, v_tax_code_id, v_doc_date
        FROM public.payment_vouchers WHERE id=p_document_id FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'Payment voucher % not found', p_document_id; END IF;
      SELECT tax_type INTO v_tax_type FROM public.tax_codes WHERE id=v_tax_code_id;
      IF v_tax_type IS NULL OR v_target.tax_type <> v_tax_type THEN RAISE EXCEPTION 'Payment voucher PPh tax type must match the selected period'; END IF;
      IF v_old_period_id IS NULL AND v_doc_date IS NOT NULL THEN
        SELECT id INTO v_old_period_id FROM public.tax_periods WHERE tax_type = v_tax_type AND v_doc_date BETWEEN period_start AND period_end;
      END IF;

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

  IF v_old_period_id IS NOT NULL AND v_old_period_id <> p_tax_period_id THEN
    PERFORM public.compute_period_ppn(v_old_period_id);
  END IF;
  PERFORM public.compute_period_ppn(p_tax_period_id);
END;
$$;

-- 4. Update trigger function to listen to pph_tax_period_id and tax_period_id
CREATE OR REPLACE FUNCTION public.trg_recompute_from_expense()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF COALESCE(OLD.pph_amount, 0) > 0
       OR COALESCE(OLD.pib_pph_amount, 0) > 0
       OR OLD.expense_category = 'pph_import' THEN
      IF OLD.pph_tax_period_id IS NOT NULL THEN
        PERFORM public.compute_period_ppn(OLD.pph_tax_period_id);
      END IF;
      PERFORM public.recompute_pph_periods_for_date(COALESCE(OLD.due_date, OLD.expense_date));
      IF OLD.expense_date IS NOT NULL THEN
        PERFORM public.recompute_pph_periods_for_date(OLD.expense_date);
      END IF;
    END IF;
    IF OLD.tax_period_id IS NOT NULL THEN
      PERFORM public.compute_period_ppn(OLD.tax_period_id);
    END IF;

  ELSIF TG_OP = 'INSERT' THEN
    IF COALESCE(NEW.pph_amount, 0) > 0
       OR COALESCE(NEW.pib_pph_amount, 0) > 0
       OR NEW.expense_category = 'pph_import' THEN
      IF NEW.pph_tax_period_id IS NOT NULL THEN
        PERFORM public.compute_period_ppn(NEW.pph_tax_period_id);
      END IF;
      PERFORM public.recompute_pph_periods_for_date(public.get_expense_pph_period_date(NEW.id));
    END IF;
    IF NEW.tax_period_id IS NOT NULL THEN
      PERFORM public.compute_period_ppn(NEW.tax_period_id);
    END IF;

  ELSIF TG_OP = 'UPDATE' THEN
    IF (
      NEW.pph_amount IS DISTINCT FROM OLD.pph_amount OR
      NEW.pib_pph_amount IS DISTINCT FROM OLD.pib_pph_amount OR
      NEW.ppn_amount IS DISTINCT FROM OLD.ppn_amount OR
      NEW.pib_ppn_amount IS DISTINCT FROM OLD.pib_ppn_amount OR
      NEW.expense_date IS DISTINCT FROM OLD.expense_date OR
      NEW.due_date IS DISTINCT FROM OLD.due_date OR
      NEW.expense_category IS DISTINCT FROM OLD.expense_category OR
      NEW.approval_status IS DISTINCT FROM OLD.approval_status OR
      NEW.pph_code_id IS DISTINCT FROM OLD.pph_code_id OR
      NEW.pph_tax_period_id IS DISTINCT FROM OLD.pph_tax_period_id OR
      NEW.tax_period_id IS DISTINCT FROM OLD.tax_period_id
    ) THEN
      IF NEW.pph_tax_period_id IS NOT NULL THEN
        PERFORM public.compute_period_ppn(NEW.pph_tax_period_id);
      END IF;
      IF OLD.pph_tax_period_id IS NOT NULL AND OLD.pph_tax_period_id IS DISTINCT FROM NEW.pph_tax_period_id THEN
        PERFORM public.compute_period_ppn(OLD.pph_tax_period_id);
      END IF;
      IF NEW.tax_period_id IS NOT NULL THEN
        PERFORM public.compute_period_ppn(NEW.tax_period_id);
      END IF;
      IF OLD.tax_period_id IS NOT NULL AND OLD.tax_period_id IS DISTINCT FROM NEW.tax_period_id THEN
        PERFORM public.compute_period_ppn(OLD.tax_period_id);
      END IF;

      IF COALESCE(NEW.pph_amount, 0) > 0
         OR COALESCE(NEW.pib_pph_amount, 0) > 0
         OR NEW.expense_category = 'pph_import' THEN
        PERFORM public.recompute_pph_periods_for_date(public.get_expense_pph_period_date(NEW.id));
      END IF;
      IF COALESCE(OLD.pph_amount, 0) > 0
         OR COALESCE(OLD.pib_pph_amount, 0) > 0
         OR OLD.expense_category = 'pph_import' THEN
        PERFORM public.recompute_pph_periods_for_date(COALESCE(OLD.due_date, OLD.expense_date));
        IF OLD.expense_date IS DISTINCT FROM NEW.expense_date THEN
          PERFORM public.recompute_pph_periods_for_date(OLD.expense_date);
        END IF;
      END IF;
    END IF;
  END IF;
  RETURN NULL;
END;
$function$;

-- 5. Recompute current stored totals for June and July 2026 periods
SELECT public.compute_period_ppn(id)
  FROM public.tax_periods
 WHERE fiscal_year = 2026 AND period_month IN (6, 7) AND tax_type <> 'PPN';

NOTIFY pgrst, 'reload schema';
COMMIT;
