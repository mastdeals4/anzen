-- Preserve an auditable distinction between current withholding sources and
-- verified historical government remittances whose original source documents
-- were deliberately removed.  The existing tax_payment, journal and bank
-- allocation remain the single accounting/payment architecture.
BEGIN;

ALTER TABLE public.tax_payments
  ADD COLUMN IF NOT EXISTS historical_source_status text NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS historical_source_document_type text,
  ADD COLUMN IF NOT EXISTS historical_source_document_id uuid,
  ADD COLUMN IF NOT EXISTS historical_source_reference text,
  ADD COLUMN IF NOT EXISTS historical_source_note text;

ALTER TABLE public.tax_payments
  DROP CONSTRAINT IF EXISTS tax_payments_historical_source_status_check;
ALTER TABLE public.tax_payments
  ADD CONSTRAINT tax_payments_historical_source_status_check
  CHECK (historical_source_status IN ('none','missing_source_verified'));

-- A declared exception is valid only when the existing tax payment has a
-- live posted journal and a full canonical bank allocation to its matched
-- tax-payment line. It cannot manufacture a liability without cash evidence.
CREATE OR REPLACE FUNCTION public.validate_historical_pph_payment_exception()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.historical_source_status = 'missing_source_verified' THEN
    IF NEW.tax_type NOT IN ('PPh21','PPh22','PPh23','PPh4(2)')
       OR NULLIF(btrim(COALESCE(NEW.historical_source_reference,'')), '') IS NULL
       OR NEW.journal_entry_id IS NULL
       OR NOT EXISTS (
         SELECT 1 FROM public.journal_entries je
          WHERE je.id=NEW.journal_entry_id AND je.is_posted AND NOT COALESCE(je.is_reversed,false)
       )
       OR NOT EXISTS (
         SELECT 1
           FROM public.bank_statement_allocations a
           JOIN public.bank_statement_lines bsl ON bsl.id=a.bank_statement_line_id
          WHERE a.document_type='tax_payment' AND a.document_id=NEW.id
            AND a.journal_entry_id=NEW.journal_entry_id
            AND bsl.matched_tax_payment_id=NEW.id
            AND abs(COALESCE(a.allocation_amount,0)-NEW.amount)<0.01
       ) THEN
      RAISE EXCEPTION 'Historical PPh exception requires matching posted journal, full canonical bank allocation, and source reference';
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_validate_historical_pph_payment_exception ON public.tax_payments;
CREATE TRIGGER trg_validate_historical_pph_payment_exception
  BEFORE INSERT OR UPDATE OF historical_source_status, historical_source_reference,
    journal_entry_id, amount ON public.tax_payments
  FOR EACH ROW EXECUTE FUNCTION public.validate_historical_pph_payment_exception();

-- Audited conversions: Oct/Nov former expenses were explicitly replaced by
-- these tax payments; February has bank/NTPN/journal evidence but its original
-- pre-system source document is unavailable. No expense or journal is created.
UPDATE public.tax_payments SET
  historical_source_status='missing_source_verified',
  historical_source_document_type='finance_expense',
  historical_source_document_id=NULL,
  historical_source_reference='Historical source unavailable (bank/NTPN supported)',
  historical_source_note='Original historical PPh4(2) source is unavailable; verified by reconciled bank allocation, tax-payment journal and NTPN.'
WHERE id='dc6b0860-8ed2-47d3-9baf-d05c2ea2167b';

UPDATE public.tax_payments SET
  historical_source_status='missing_source_verified',
  historical_source_document_type='finance_expense',
  historical_source_document_id='c3e028b0-8bd7-44e6-860f-327286d565dd',
  historical_source_reference='EXP/25/136',
  historical_source_note='Expense was deliberately replaced by this tax payment; audit log records original journal df034d89-4a45-4a8f-b66c-47c511809064.'
WHERE id='f7baee78-f324-42d4-8494-458525934a30';

UPDATE public.tax_payments SET
  historical_source_status='missing_source_verified',
  historical_source_document_type='finance_expense',
  historical_source_document_id='09e1febd-fee1-46b2-b392-984369754c1c',
  historical_source_reference='EXP/25/217',
  historical_source_note='Expense was deliberately replaced by this tax payment; audit log records original journal 0ab485e3-6883-4143-8bfa-a876388e9400.'
WHERE id='b5f2299b-a737-432c-9a24-85ede0a5f97a';

CREATE OR REPLACE FUNCTION public.compute_period_ppn(p_period_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_period public.tax_periods%rowtype; v_pph_total numeric(18,2);
BEGIN
  PERFORM public.compute_period_ppn_pre_posted_register(p_period_id);
  SELECT * INTO v_period FROM public.tax_periods WHERE id=p_period_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Tax period % not found',p_period_id; END IF;
  IF v_period.tax_type='PPN' THEN RETURN; END IF;
  SELECT COALESCE((SELECT sum(fe.pph_amount) FROM public.finance_expenses fe LEFT JOIN public.tax_codes tc ON tc.id=fe.pph_code_id
    WHERE (fe.pph_tax_period_id=v_period.id OR (fe.pph_tax_period_id IS NULL AND extract(year from public.get_expense_pph_period_date(fe.id))::int=v_period.fiscal_year AND extract(month from public.get_expense_pph_period_date(fe.id))::int=v_period.period_month))
      AND fe.approval_status='approved' AND fe.pph_amount>0 AND coalesce(fe.expense_category,'') NOT IN ('pib_import','pph_import') AND (v_period.tax_type='PPh_Unifikasi' OR tc.tax_type=v_period.tax_type)),0)
    + COALESCE((SELECT sum(pv.pph_amount) FROM public.payment_vouchers pv LEFT JOIN public.tax_codes tc ON tc.id=pv.pph_code_id
    WHERE (pv.tax_period_id=v_period.id OR (pv.tax_period_id IS NULL AND extract(year from pv.voucher_date)::int=v_period.fiscal_year AND extract(month from pv.voucher_date)::int=v_period.period_month))
      AND coalesce(pv.is_posted,false) AND pv.pph_amount>0 AND (v_period.tax_type='PPh_Unifikasi' OR tc.tax_type=v_period.tax_type)),0)
    + CASE WHEN v_period.tax_type IN ('PPh22','PPh_Unifikasi') THEN COALESCE((SELECT sum(case when fe.expense_category='pib_import' then fe.pib_pph_amount else fe.amount end) FROM public.finance_expenses fe
    WHERE fe.expense_category IN ('pib_import','pph_import') AND (fe.pph_tax_period_id=v_period.id OR (fe.pph_tax_period_id IS NULL AND extract(year from public.get_expense_pph_period_date(fe.id))::int=v_period.fiscal_year AND extract(month from public.get_expense_pph_period_date(fe.id))::int=v_period.period_month)) AND fe.approval_status='approved'),0) ELSE 0 END
    + COALESCE((SELECT sum(tp.amount) FROM public.tax_payments tp
    WHERE tp.tax_period_id=v_period.id AND tp.tax_type=v_period.tax_type AND tp.historical_source_status='missing_source_verified'),0)
  INTO v_pph_total;
  UPDATE public.tax_periods SET pph_total=v_pph_total,updated_at=now() WHERE id=p_period_id;
END $$;

REVOKE ALL ON FUNCTION public.finance_staff_master_sync_salary_gl() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.prevent_unsafe_settled_salary_edit() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.validate_historical_pph_payment_exception() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.compute_period_ppn(uuid) TO authenticated, service_role;

DO $$ DECLARE p uuid; BEGIN FOR p IN SELECT id FROM public.tax_periods WHERE tax_type<>'PPN' LOOP PERFORM public.compute_period_ppn(p); END LOOP; END $$;
NOTIFY pgrst,'reload schema';
COMMIT;
