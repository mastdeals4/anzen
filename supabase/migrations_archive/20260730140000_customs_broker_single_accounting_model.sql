/*
  Canonical Customs Broker Invoice accounting model.

  All broker consumers use these derived values; broker_items is the only
  source document detail and no nullable stored total is used:
    reimbursement_line_total = amount + dpp_amount + ppn_amount
    reimbursement_total      = SUM(reimbursement_line_total)
    expense_total            = broker_invoice_amount + reimbursement_total + stamp
    recoverable_input_ppn    = header_ppn + SUM(line_ppn)
    final_cash_payable       = expense_total + recoverable_input_ppn - pph23
*/

CREATE OR REPLACE FUNCTION public.broker_reimbursement_line_total(p_item jsonb)
RETURNS numeric LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE((p_item->>'amount')::numeric,0)
       + COALESCE((p_item->>'dpp_amount')::numeric,0)
       + COALESCE((p_item->>'ppn_amount')::numeric,0)
$$;

CREATE OR REPLACE FUNCTION public.calculate_customs_broker_invoice(p_expense_id uuid)
RETURNS TABLE (
  reimbursement_total numeric,
  broker_invoice_amount numeric,
  expense_total numeric,
  recoverable_input_ppn numeric,
  pph23_withheld numeric,
  final_cash_payable numeric,
  line_totals jsonb
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT
    COALESCE((SELECT SUM(public.broker_reimbursement_line_total(i))
      FROM jsonb_array_elements(COALESCE(fe.broker_items,'[]'::jsonb)) i),0),
    COALESCE(fe.amount,0),
    COALESCE(fe.amount,0)
      + COALESCE((SELECT SUM(public.broker_reimbursement_line_total(i))
        FROM jsonb_array_elements(COALESCE(fe.broker_items,'[]'::jsonb)) i),0)
      + COALESCE(fe.stamp_duty_amount,0),
    COALESCE(fe.ppn_amount,0) + COALESCE((SELECT SUM(COALESCE((i->>'ppn_amount')::numeric,0))
      FROM jsonb_array_elements(COALESCE(fe.broker_items,'[]'::jsonb)) i),0),
    COALESCE(fe.pph_amount,0),
    COALESCE(fe.amount,0)
      + COALESCE((SELECT SUM(public.broker_reimbursement_line_total(i))
        FROM jsonb_array_elements(COALESCE(fe.broker_items,'[]'::jsonb)) i),0)
      + COALESCE(fe.stamp_duty_amount,0)
      + COALESCE(fe.ppn_amount,0)
      + COALESCE((SELECT SUM(COALESCE((i->>'ppn_amount')::numeric,0))
        FROM jsonb_array_elements(COALESCE(fe.broker_items,'[]'::jsonb)) i),0)
      - COALESCE(fe.pph_amount,0),
    COALESCE((SELECT jsonb_agg(public.broker_reimbursement_line_total(i) ORDER BY ord)
      FROM jsonb_array_elements(COALESCE(fe.broker_items,'[]'::jsonb)) WITH ORDINALITY x(i,ord)),'[]'::jsonb)
  FROM finance_expenses fe
  WHERE fe.id = p_expense_id AND fe.expense_category = 'import_broker'
$$;

CREATE OR REPLACE VIEW public.vw_customs_broker_accounting AS
SELECT fe.id AS expense_id,
       fe.voucher_number,
       fe.invoice_number,
       fe.expense_date,
       fe.due_date,
       fe.supplier_id,
       fe.payment_method,
       fe.paid_amount,
       c.reimbursement_total,
       c.broker_invoice_amount,
       c.expense_total,
       c.recoverable_input_ppn,
       c.pph23_withheld,
       c.final_cash_payable,
       c.line_totals
  FROM finance_expenses fe
  CROSS JOIN LATERAL public.calculate_customs_broker_invoice(fe.id) c
 WHERE fe.expense_category = 'import_broker';
GRANT SELECT ON public.vw_customs_broker_accounting TO authenticated;
GRANT EXECUTE ON FUNCTION public.calculate_customs_broker_invoice(uuid) TO authenticated;

-- Canonical final posting. It runs after the legacy compatibility triggers and
-- replaces their journal atomically, leaving one balanced JE per broker bill.
CREATE OR REPLACE FUNCTION public.post_customs_broker_canonical()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_je uuid;
  v_expense_account uuid;
  v_ppn_account uuid;
  v_pph_account uuid;
  v_stamp_account uuid;
  v_ap_account uuid;
  v_cash_account uuid;
  v_item jsonb;
  v_supplier uuid;
  v_line_total numeric;
  v_line_ppn numeric;
  v_line_no int := 1;
  v_reimbursement numeric := 0;
  v_reimbursement_ppn numeric := 0;
  v_expense_total numeric;
  v_recoverable numeric;
  v_pph numeric := COALESCE(NEW.pph_amount,0);
  v_credit_total numeric;
  v_entry_number text;
  v_outstanding boolean := NEW.payment_method IS NULL OR NEW.payment_method='outstanding';
BEGIN
  IF NEW.expense_category <> 'import_broker' THEN RETURN NEW; END IF;

  DELETE FROM journal_entry_lines WHERE journal_entry_id IN
    (SELECT id FROM journal_entries WHERE reference_number='EXP-'||NEW.id::text);
  DELETE FROM journal_entries WHERE reference_number='EXP-'||NEW.id::text;

  SELECT id INTO v_expense_account FROM chart_of_accounts WHERE code='5300' LIMIT 1;
  SELECT id INTO v_ppn_account FROM chart_of_accounts WHERE code='1150' LIMIT 1;
  SELECT id INTO v_pph_account FROM chart_of_accounts WHERE code='2132' LIMIT 1;
  SELECT id INTO v_stamp_account FROM chart_of_accounts WHERE code='6950' LIMIT 1;
  SELECT id INTO v_ap_account FROM chart_of_accounts WHERE code='2110' LIMIT 1;
  IF NEW.payment_method='cash' THEN
    SELECT id INTO v_cash_account FROM chart_of_accounts WHERE code='1101' LIMIT 1;
  ELSIF NEW.payment_method='petty_cash' THEN
    SELECT id INTO v_cash_account FROM chart_of_accounts WHERE code='1102' LIMIT 1;
  ELSIF NEW.payment_method='bank_transfer' AND NEW.bank_account_id IS NOT NULL THEN
    SELECT coa_id INTO v_cash_account FROM bank_accounts WHERE id=NEW.bank_account_id;
  ELSE
    SELECT id INTO v_cash_account FROM chart_of_accounts WHERE code='1101' LIMIT 1;
  END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(COALESCE(NEW.broker_items,'[]'::jsonb)) LOOP
    v_line_total := public.broker_reimbursement_line_total(v_item);
    v_line_ppn := COALESCE((v_item->>'ppn_amount')::numeric,0);
    v_reimbursement := v_reimbursement + v_line_total;
    v_reimbursement_ppn := v_reimbursement_ppn + v_line_ppn;
  END LOOP;
  v_expense_total := COALESCE(NEW.amount,0) + v_reimbursement + COALESCE(NEW.stamp_duty_amount,0);
  v_recoverable := COALESCE(NEW.ppn_amount,0) + v_reimbursement_ppn;
  v_credit_total := v_expense_total + v_recoverable;

  SELECT 'JE'||to_char(NEW.expense_date,'YYMM')||'-'||lpad((
    COALESCE(max(CAST(substring(entry_number FROM '-([0-9]+)$') AS int)),0)+1)::text,4,'0')
    INTO v_entry_number FROM journal_entries
   WHERE entry_number LIKE 'JE'||to_char(NEW.expense_date,'YYMM')||'-%';
  INSERT INTO journal_entries(entry_number,entry_date,source_module,reference_id,reference_number,
    description,transaction_category,total_debit,total_credit,is_posted,posted_at,created_by)
  VALUES(v_entry_number,NEW.expense_date,'expenses',NEW.id,'EXP-'||NEW.id::text,
    COALESCE(NEW.description,'Customs Broker Invoice'),'import_broker',v_credit_total,v_credit_total,true,now(),NEW.created_by)
  RETURNING id INTO v_je;

  INSERT INTO journal_entry_lines(journal_entry_id,line_number,account_id,description,debit,credit,supplier_id)
  VALUES(v_je,v_line_no,v_expense_account,'Broker service expense',COALESCE(NEW.amount,0),0,NEW.supplier_id);
  v_line_no := v_line_no+1;
  FOR v_item IN SELECT value FROM jsonb_array_elements(COALESCE(NEW.broker_items,'[]'::jsonb)) LOOP
    v_supplier := COALESCE(NULLIF(v_item->>'supplier_id','')::uuid,NEW.supplier_id);
    v_line_total := public.broker_reimbursement_line_total(v_item);
    IF v_line_total > 0 THEN
      INSERT INTO journal_entry_lines(journal_entry_id,line_number,account_id,description,debit,credit,supplier_id)
      VALUES(v_je,v_line_no,v_expense_account,'Reimbursement line total',v_line_total,0,v_supplier);
      v_line_no := v_line_no+1;
    END IF;
  END LOOP;
  IF COALESCE(NEW.ppn_amount,0)>0 THEN
    INSERT INTO journal_entry_lines(journal_entry_id,line_number,account_id,description,debit,credit,supplier_id)
    VALUES(v_je,v_line_no,v_ppn_account,'Recoverable PPN - broker invoice',NEW.ppn_amount,0,NEW.supplier_id);
    v_line_no := v_line_no+1;
  END IF;
  FOR v_item IN SELECT value FROM jsonb_array_elements(COALESCE(NEW.broker_items,'[]'::jsonb)) LOOP
    v_supplier := COALESCE(NULLIF(v_item->>'supplier_id','')::uuid,NEW.supplier_id);
    v_line_ppn := COALESCE((v_item->>'ppn_amount')::numeric,0);
    IF v_line_ppn>0 THEN
      INSERT INTO journal_entry_lines(journal_entry_id,line_number,account_id,description,debit,credit,supplier_id)
      VALUES(v_je,v_line_no,v_ppn_account,'Recoverable PPN - reimbursement',v_line_ppn,0,v_supplier);
      v_line_no := v_line_no+1;
    END IF;
  END LOOP;
  IF COALESCE(NEW.stamp_duty_amount,0)>0 THEN
    INSERT INTO journal_entry_lines(journal_entry_id,line_number,account_id,description,debit,credit,supplier_id)
    VALUES(v_je,v_line_no,v_stamp_account,'Stamp duty',NEW.stamp_duty_amount,0,NEW.supplier_id);
    v_line_no := v_line_no+1;
  END IF;
  IF v_pph>0 THEN
    INSERT INTO journal_entry_lines(journal_entry_id,line_number,account_id,description,debit,credit,supplier_id)
    VALUES(v_je,v_line_no,v_pph_account,'PPh23 withheld',0,v_pph,NEW.supplier_id);
    v_line_no := v_line_no+1;
  END IF;

  -- The broker's own payable is reduced by PPh23; reimbursement suppliers are
  -- paid at their derived line total plus their recoverable PPN.
  v_line_total := COALESCE(NEW.amount,0)+COALESCE(NEW.ppn_amount,0)-v_pph;
  IF v_line_total<>0 THEN
    INSERT INTO journal_entry_lines(journal_entry_id,line_number,account_id,description,debit,credit,supplier_id)
    VALUES(v_je,v_line_no,CASE WHEN v_outstanding THEN v_ap_account ELSE v_cash_account END,
      CASE WHEN v_outstanding THEN 'Supplier payable - broker' ELSE 'Cash payment - broker' END,0,v_line_total,NEW.supplier_id);
    v_line_no := v_line_no+1;
  END IF;
  FOR v_item IN SELECT value FROM jsonb_array_elements(COALESCE(NEW.broker_items,'[]'::jsonb)) LOOP
    v_supplier := COALESCE(NULLIF(v_item->>'supplier_id','')::uuid,NEW.supplier_id);
    v_line_total := public.broker_reimbursement_line_total(v_item)+COALESCE((v_item->>'ppn_amount')::numeric,0);
    IF v_line_total>0 THEN
      INSERT INTO journal_entry_lines(journal_entry_id,line_number,account_id,description,debit,credit,supplier_id)
      VALUES(v_je,v_line_no,CASE WHEN v_outstanding THEN v_ap_account ELSE v_cash_account END,
        CASE WHEN v_outstanding THEN 'Supplier payable - reimbursement' ELSE 'Cash payment - reimbursement' END,0,v_line_total,v_supplier);
      v_line_no := v_line_no+1;
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS zzzzz_post_customs_broker_canonical ON public.finance_expenses;
CREATE TRIGGER zzzzz_post_customs_broker_canonical AFTER INSERT OR UPDATE ON public.finance_expenses
FOR EACH ROW EXECUTE FUNCTION public.post_customs_broker_canonical();

-- AP consumers receive the same derived cash payable model, not raw amount.
DROP FUNCTION IF EXISTS public.get_outstanding_expense_bills(date);
CREATE OR REPLACE FUNCTION public.get_outstanding_expense_bills(p_as_of_date date DEFAULT current_date)
RETURNS TABLE(id uuid,supplier_id uuid,supplier_name text,staff_id uuid,staff_name text,invoice_number text,invoice_date date,due_date date,
  expense_category text,description text,amount numeric,paid_amount numeric,balance_amount numeric,days_overdue integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  RETURN QUERY
  SELECT fe.id,fe.supplier_id,s.company_name::text,fe.staff_id,sm.full_name::text,fe.invoice_number::text,fe.expense_date,fe.due_date,
    fe.expense_category::text,fe.description::text,
    CASE WHEN fe.expense_category='import_broker' THEN c.final_cash_payable ELSE fe.amount END,
    COALESCE(fe.paid_amount,0),
    CASE WHEN fe.expense_category='import_broker' THEN c.final_cash_payable-COALESCE(fe.paid_amount,0)
         ELSE fe.amount-COALESCE(fe.paid_amount,0) END,
    CASE WHEN fe.due_date IS NOT NULL AND fe.due_date<p_as_of_date THEN (p_as_of_date-fe.due_date)::integer ELSE 0 END
  FROM finance_expenses fe LEFT JOIN suppliers s ON s.id=fe.supplier_id
  LEFT JOIN finance_staff_master sm ON sm.id=fe.staff_id
  LEFT JOIN vw_customs_broker_accounting c ON c.expense_id=fe.id
  WHERE fe.payment_method IS NULL AND fe.expense_date<=p_as_of_date
    AND CASE WHEN fe.expense_category='import_broker' THEN c.final_cash_payable ELSE fe.amount END > COALESCE(fe.paid_amount,0)
  ORDER BY COALESCE(fe.due_date,fe.expense_date);
END; $$;
