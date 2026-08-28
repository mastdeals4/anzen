-- Keep tax remittances at their actual value in the register and allow a
-- reporting-period correction without touching the source date or journal.
-- This extends the existing tax_periods/tax_period_id model; it creates no
-- payment allocation or accounting subsystem.
BEGIN;

-- An expense can carry both PPN and PPh. tax_period_id remains the established
-- PPN attribution; this companion reference is only the existing PPh period
-- selection, so changing either reporting period never changes the document or
-- accounting date.
ALTER TABLE public.finance_expenses
  ADD COLUMN IF NOT EXISTS pph_tax_period_id uuid REFERENCES public.tax_periods(id);

CREATE INDEX IF NOT EXISTS idx_finance_expenses_pph_tax_period
  ON public.finance_expenses(pph_tax_period_id);

-- Existing documents retain their present derived PPh reporting period when
-- possible. This is attribution metadata only; no amount/date/journal changes.
UPDATE public.finance_expenses fe
   SET pph_tax_period_id = tp.id
  FROM public.tax_periods tp
 WHERE fe.pph_tax_period_id IS NULL
   AND COALESCE(fe.pph_amount, 0) > 0
   AND tp.fiscal_year = EXTRACT(YEAR FROM public.get_expense_pph_period_date(fe.id))::int
   AND tp.period_month = EXTRACT(MONTH FROM public.get_expense_pph_period_date(fe.id))::int
   AND tp.tax_type = COALESCE((SELECT tc.tax_type FROM public.tax_codes tc WHERE tc.id = fe.pph_code_id), '');

-- PPh liabilities now honour the selected existing PPh period when present;
-- rows that predate the field continue to use their established payment/due
-- date attribution. PPN computation remains delegated to the existing engine.
CREATE OR REPLACE FUNCTION public.compute_period_ppn(p_period_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_period public.tax_periods%ROWTYPE;
  v_pph_total numeric(18,2);
BEGIN
  PERFORM public.compute_period_ppn_pre_posted_register(p_period_id);

  SELECT * INTO v_period FROM public.tax_periods WHERE id = p_period_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Tax period % not found', p_period_id; END IF;
  IF v_period.tax_type = 'PPN' THEN RETURN; END IF;

  SELECT
    COALESCE((
      SELECT SUM(fe.pph_amount)
        FROM public.finance_expenses fe
        LEFT JOIN public.tax_codes tc ON tc.id = fe.pph_code_id
       WHERE (fe.pph_tax_period_id = v_period.id OR (
                fe.pph_tax_period_id IS NULL
            AND EXTRACT(YEAR FROM public.get_expense_pph_period_date(fe.id))::int = v_period.fiscal_year
            AND EXTRACT(MONTH FROM public.get_expense_pph_period_date(fe.id))::int = v_period.period_month
             ))
         AND fe.pph_amount > 0
         AND COALESCE(fe.expense_category, '') NOT IN ('pib_import', 'pph_import')
         AND (v_period.tax_type = 'PPh_Unifikasi' OR tc.tax_type = v_period.tax_type)
         AND EXISTS (
           SELECT 1 FROM public.journal_entries je
            WHERE je.reference_id = fe.id AND je.source_module IN ('expense', 'expenses')
              AND je.is_posted = true AND COALESCE(je.is_reversed, false) = false
         )
    ), 0)
    + COALESCE((
      SELECT SUM(pv.pph_amount)
        FROM public.payment_vouchers pv
        LEFT JOIN public.tax_codes tc ON tc.id = pv.pph_code_id
       WHERE (pv.tax_period_id = v_period.id OR (
                pv.tax_period_id IS NULL
            AND EXTRACT(YEAR FROM pv.voucher_date)::int = v_period.fiscal_year
            AND EXTRACT(MONTH FROM pv.voucher_date)::int = v_period.period_month
             ))
         AND pv.pph_amount > 0
         AND (v_period.tax_type = 'PPh_Unifikasi' OR tc.tax_type = v_period.tax_type)
         AND EXISTS (
           SELECT 1 FROM public.journal_entries je
            WHERE je.reference_id = pv.id AND je.source_module IN ('payment', 'payments', 'payment_voucher')
              AND je.is_posted = true AND COALESCE(je.is_reversed, false) = false
         )
    ), 0)
    + CASE WHEN v_period.tax_type IN ('PPh22', 'PPh_Unifikasi') THEN COALESCE((
      SELECT SUM(CASE WHEN fe.expense_category = 'pib_import' THEN fe.pib_pph_amount ELSE fe.amount END)
        FROM public.finance_expenses fe
       WHERE fe.expense_category IN ('pib_import', 'pph_import')
         AND (fe.pph_tax_period_id = v_period.id OR (
                fe.pph_tax_period_id IS NULL
            AND EXTRACT(YEAR FROM public.get_expense_pph_period_date(fe.id))::int = v_period.fiscal_year
            AND EXTRACT(MONTH FROM public.get_expense_pph_period_date(fe.id))::int = v_period.period_month
             ))
         AND EXISTS (
           SELECT 1 FROM public.journal_entries je
            WHERE je.reference_id = fe.id AND je.source_module IN ('expense', 'expenses')
              AND je.is_posted = true AND COALESCE(je.is_reversed, false) = false
         )
    ), 0) ELSE 0 END
  INTO v_pph_total;

  UPDATE public.tax_periods SET pph_total = v_pph_total, updated_at = now() WHERE id = p_period_id;
END;
$$;

-- The source-specific command is deliberately narrow: it changes only an
-- existing period reference, enforces matching tax type and both lifecycle
-- locks, then refreshes the existing period snapshots.
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
BEGIN
  SELECT * INTO v_target FROM public.tax_periods WHERE id = p_tax_period_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Tax period % not found', p_tax_period_id; END IF;
  IF v_target.status IN ('closed', 'filed') OR v_target.filing_status = 'filed' THEN
    RAISE EXCEPTION 'Tax period % is filed or closed and cannot be selected', p_tax_period_id;
  END IF;

  CASE p_source
    WHEN 'purchase_invoice' THEN
      SELECT tax_period_id INTO v_old_period_id FROM public.purchase_invoices WHERE id = p_document_id FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'Purchase invoice % not found', p_document_id; END IF;
      IF v_target.tax_type <> 'PPN' THEN RAISE EXCEPTION 'Purchase invoices require a PPN tax period'; END IF;
      UPDATE public.purchase_invoices SET tax_period_id = p_tax_period_id WHERE id = p_document_id;
    WHEN 'sales_invoice' THEN
      SELECT tax_period_id INTO v_old_period_id FROM public.sales_invoices WHERE id = p_document_id FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'Sales invoice % not found', p_document_id; END IF;
      IF v_target.tax_type <> 'PPN' THEN RAISE EXCEPTION 'Sales invoices require a PPN tax period'; END IF;
      UPDATE public.sales_invoices SET tax_period_id = p_tax_period_id WHERE id = p_document_id;
      UPDATE public.faktur_pajak SET tax_period_id = p_tax_period_id WHERE sales_invoice_id = p_document_id;
    WHEN 'credit_note' THEN
      SELECT tax_period_id INTO v_old_period_id FROM public.credit_notes WHERE id = p_document_id FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'Credit note % not found', p_document_id; END IF;
      IF v_target.tax_type <> 'PPN' THEN RAISE EXCEPTION 'Credit notes require a PPN tax period'; END IF;
      UPDATE public.credit_notes SET tax_period_id = p_tax_period_id WHERE id = p_document_id;
    WHEN 'finance_expense_ppn' THEN
      SELECT tax_period_id INTO v_old_period_id FROM public.finance_expenses WHERE id = p_document_id FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'Expense % not found', p_document_id; END IF;
      IF v_target.tax_type <> 'PPN' THEN RAISE EXCEPTION 'Expenses require a PPN tax period for PPN reporting'; END IF;
      UPDATE public.finance_expenses SET tax_period_id = p_tax_period_id WHERE id = p_document_id;
    WHEN 'finance_expense_pph' THEN
      SELECT fe.pph_tax_period_id, tc.tax_type INTO v_old_period_id, v_tax_type
        FROM public.finance_expenses fe LEFT JOIN public.tax_codes tc ON tc.id = fe.pph_code_id
       WHERE fe.id = p_document_id FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'Expense % not found', p_document_id; END IF;
      IF v_tax_type IS NULL OR v_target.tax_type <> v_tax_type THEN RAISE EXCEPTION 'Expense PPh tax type must match the selected period'; END IF;
      UPDATE public.finance_expenses SET pph_tax_period_id = p_tax_period_id WHERE id = p_document_id;
    WHEN 'payment_voucher' THEN
      SELECT pv.tax_period_id, tc.tax_type INTO v_old_period_id, v_tax_type
        FROM public.payment_vouchers pv LEFT JOIN public.tax_codes tc ON tc.id = pv.pph_code_id
       WHERE pv.id = p_document_id FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'Payment voucher % not found', p_document_id; END IF;
      IF v_tax_type IS NULL OR v_target.tax_type <> v_tax_type THEN RAISE EXCEPTION 'Payment voucher PPh tax type must match the selected period'; END IF;
      UPDATE public.payment_vouchers SET tax_period_id = p_tax_period_id WHERE id = p_document_id;
    ELSE RAISE EXCEPTION 'Unsupported tax document source %', p_source;
  END CASE;

  IF v_old_period_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.tax_periods WHERE id = v_old_period_id AND (status IN ('closed', 'filed') OR filing_status = 'filed')
  ) THEN
    RAISE EXCEPTION 'The current tax period is filed or closed; reopen it before changing this document';
  END IF;

  IF p_source IN ('purchase_invoice', 'sales_invoice', 'credit_note', 'finance_expense_ppn') THEN
    IF v_old_period_id IS NOT NULL THEN PERFORM public.compute_period_ppn(v_old_period_id); END IF;
    PERFORM public.compute_period_ppn(p_tax_period_id);
  ELSE
    IF v_old_period_id IS NOT NULL THEN PERFORM public.compute_period_ppn(v_old_period_id); END IF;
    PERFORM public.compute_period_ppn(p_tax_period_id);
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.reassign_tax_document_period(text, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reassign_tax_document_period(text, uuid, uuid) TO authenticated, service_role;

-- Preserve the historical paid/outstanding columns, but make paid the actual
-- settlement amount and append net/credit fields for every consumer.
CREATE OR REPLACE VIEW public.vw_pph_by_period_type AS
SELECT
  tp.id AS tax_period_id, tp.fiscal_year, tp.period_month, tp.tax_type, tp.pph_total,
  (public.fn_tax_payments_paid(tp.id) + public.fn_settled_import_pph22(tp.fiscal_year, tp.period_month, tp.tax_type)) AS pph_paid_total,
  GREATEST(tp.pph_total - (public.fn_tax_payments_paid(tp.id) + public.fn_settled_import_pph22(tp.fiscal_year, tp.period_month, tp.tax_type)), 0) AS pph_outstanding,
  tp.status, tp.payment_due_date, tp.filing_due_date,
  public.fn_period_payment_status(tp.status, GREATEST(tp.pph_total - (public.fn_tax_payments_paid(tp.id) + public.fn_settled_import_pph22(tp.fiscal_year, tp.period_month, tp.tax_type)), 0), tp.payment_due_date) AS payment_status,
  public.fn_period_payment_source(tp.pph_total, public.fn_tax_payments_paid(tp.id), public.fn_settled_import_pph22(tp.fiscal_year, tp.period_month, tp.tax_type)) AS payment_source,
  (tp.pph_total - (public.fn_tax_payments_paid(tp.id) + public.fn_settled_import_pph22(tp.fiscal_year, tp.period_month, tp.tax_type))) AS pph_net_position,
  GREATEST((public.fn_tax_payments_paid(tp.id) + public.fn_settled_import_pph22(tp.fiscal_year, tp.period_month, tp.tax_type)) - tp.pph_total, 0) AS pph_overpaid
FROM public.tax_periods tp WHERE tp.tax_type <> 'PPN';

ALTER VIEW public.vw_pph_by_period_type SET (security_invoker = true);
GRANT SELECT ON public.vw_pph_by_period_type TO authenticated;

CREATE OR REPLACE VIEW public.vw_outstanding_tax AS
SELECT tp.id AS tax_period_id, tp.fiscal_year, tp.period_month, tp.tax_type, tp.status, tp.payment_due_date,
  GREATEST((CASE WHEN tp.tax_type = 'PPN' THEN tp.net_ppn ELSE tp.pph_total END) - (public.fn_tax_payments_paid(tp.id) + public.fn_settled_import_pph22(tp.fiscal_year, tp.period_month, tp.tax_type)), 0) AS outstanding_amount,
  (public.fn_tax_payments_paid(tp.id) + public.fn_settled_import_pph22(tp.fiscal_year, tp.period_month, tp.tax_type)) AS actual_payment_amount,
  GREATEST((public.fn_tax_payments_paid(tp.id) + public.fn_settled_import_pph22(tp.fiscal_year, tp.period_month, tp.tax_type)) - (CASE WHEN tp.tax_type = 'PPN' THEN tp.net_ppn ELSE tp.pph_total END), 0) AS overpaid_amount
FROM public.tax_periods tp WHERE tp.status NOT IN ('paid', 'closed');

ALTER VIEW public.vw_outstanding_tax SET (security_invoker = true);
GRANT SELECT ON public.vw_outstanding_tax TO authenticated;

CREATE OR REPLACE VIEW public.vw_tax_period_status AS
SELECT tp.id, tp.fiscal_year, tp.period_month, tp.tax_type, tp.status, tp.filing_status, tp.payment_due_date, tp.filing_due_date,
  tp.net_ppn, tp.pph_total,
  (SELECT COUNT(*) FROM public.tax_payments WHERE tax_period_id = tp.id AND status = 'reconciled') AS reconciled_payments_count,
  (SELECT COUNT(*) FROM public.tax_payments WHERE tax_period_id = tp.id AND status IN ('draft', 'posted')) AS unreconciled_payments_count,
  (SELECT COUNT(*) FROM public.sales_invoices si WHERE si.tax_period_id = tp.id AND (si.faktur_pajak_number IS NULL OR si.faktur_pajak_number = '') AND si.tax_amount > 0) AS missing_faktur_count,
  (public.fn_tax_payments_paid(tp.id) + public.fn_settled_import_pph22(tp.fiscal_year, tp.period_month, tp.tax_type)) AS paid_amount,
  GREATEST((CASE WHEN tp.tax_type = 'PPN' THEN tp.net_ppn ELSE tp.pph_total END) - (public.fn_tax_payments_paid(tp.id) + public.fn_settled_import_pph22(tp.fiscal_year, tp.period_month, tp.tax_type)), 0) AS outstanding_amount,
  public.fn_period_payment_status(tp.status, GREATEST((CASE WHEN tp.tax_type = 'PPN' THEN tp.net_ppn ELSE tp.pph_total END) - (public.fn_tax_payments_paid(tp.id) + public.fn_settled_import_pph22(tp.fiscal_year, tp.period_month, tp.tax_type)), 0), tp.payment_due_date) AS payment_status,
  public.fn_period_payment_source(CASE WHEN tp.tax_type = 'PPN' THEN tp.net_ppn ELSE tp.pph_total END, public.fn_tax_payments_paid(tp.id), public.fn_settled_import_pph22(tp.fiscal_year, tp.period_month, tp.tax_type)) AS payment_source,
  ((CASE WHEN tp.tax_type = 'PPN' THEN tp.net_ppn ELSE tp.pph_total END) - (public.fn_tax_payments_paid(tp.id) + public.fn_settled_import_pph22(tp.fiscal_year, tp.period_month, tp.tax_type))) AS net_position,
  GREATEST((public.fn_tax_payments_paid(tp.id) + public.fn_settled_import_pph22(tp.fiscal_year, tp.period_month, tp.tax_type)) - (CASE WHEN tp.tax_type = 'PPN' THEN tp.net_ppn ELSE tp.pph_total END), 0) AS overpaid_amount
FROM public.tax_periods tp;

ALTER VIEW public.vw_tax_period_status SET (security_invoker = true);
GRANT SELECT ON public.vw_tax_period_status TO authenticated;

DO $$ DECLARE p uuid; BEGIN
  FOR p IN SELECT id FROM public.tax_periods WHERE tax_type <> 'PPN' LOOP PERFORM public.compute_period_ppn(p); END LOOP;
END $$;

NOTIFY pgrst, 'reload schema';
COMMIT;
