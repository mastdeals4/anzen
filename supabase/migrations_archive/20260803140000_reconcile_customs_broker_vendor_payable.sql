-- Customs Broker reimbursements are paid to the broker named on the expense.
-- Source suppliers remain attached to expense/Input-PPN debit lines for tax
-- provenance, but AP/cash credits reconcile to the broker Payment Voucher.

BEGIN;

CREATE OR REPLACE FUNCTION public.post_customs_broker_canonical()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_je uuid; v_expense_account uuid; v_ppn_account uuid; v_pph_account uuid;
  v_stamp_account uuid; v_ap_account uuid; v_cash_account uuid; v_item jsonb;
  v_supplier uuid; v_line_total numeric; v_line_ppn numeric; v_line_no int := 1;
  v_reimbursement numeric := 0; v_expense_total numeric;
  v_pph numeric := COALESCE(NEW.pph_amount,0); v_credit_total numeric;
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
  IF NEW.payment_method='cash' THEN SELECT id INTO v_cash_account FROM chart_of_accounts WHERE code='1101' LIMIT 1;
  ELSIF NEW.payment_method='petty_cash' THEN SELECT id INTO v_cash_account FROM chart_of_accounts WHERE code='1102' LIMIT 1;
  ELSIF NEW.payment_method='bank_transfer' AND NEW.bank_account_id IS NOT NULL THEN SELECT coa_id INTO v_cash_account FROM bank_accounts WHERE id=NEW.bank_account_id;
  ELSE SELECT id INTO v_cash_account FROM chart_of_accounts WHERE code='1101' LIMIT 1; END IF;
  FOR v_item IN SELECT value FROM jsonb_array_elements(COALESCE(NEW.broker_items,'[]'::jsonb)) LOOP
    v_reimbursement := v_reimbursement + public.broker_reimbursement_line_total(v_item);
  END LOOP;
  v_expense_total := COALESCE(NEW.amount,0)+v_reimbursement+COALESCE(NEW.stamp_duty_amount,0);
  v_credit_total := v_expense_total;
  SELECT 'JE'||to_char(NEW.expense_date,'YYMM')||'-'||lpad((COALESCE(max(CAST(substring(entry_number FROM '-([0-9]+)$') AS int)),0)+1)::text,4,'0')
    INTO v_entry_number FROM journal_entries WHERE entry_number LIKE 'JE'||to_char(NEW.expense_date,'YYMM')||'-%';
  INSERT INTO journal_entries(entry_number,entry_date,source_module,reference_id,reference_number,description,transaction_category,total_debit,total_credit,is_posted,posted_at,created_by)
  VALUES(v_entry_number,NEW.expense_date,'expenses',NEW.id,'EXP-'||NEW.id::text,COALESCE(NEW.description,'Customs Broker Invoice'),'import_broker',v_credit_total,v_credit_total,true,now(),NEW.created_by) RETURNING id INTO v_je;
  v_line_total := COALESCE(NEW.amount,0)-COALESCE(NEW.ppn_amount,0);
  IF v_line_total<>0 THEN INSERT INTO journal_entry_lines(journal_entry_id,line_number,account_id,description,debit,credit,supplier_id) VALUES(v_je,v_line_no,v_expense_account,'Broker service expense',v_line_total,0,NEW.supplier_id); v_line_no:=v_line_no+1; END IF;
  FOR v_item IN SELECT value FROM jsonb_array_elements(COALESCE(NEW.broker_items,'[]'::jsonb)) LOOP
    v_supplier:=COALESCE(NULLIF(v_item->>'supplier_id','')::uuid,NEW.supplier_id); v_line_total:=public.broker_reimbursement_expense_base(v_item);
    IF v_line_total<>0 THEN INSERT INTO journal_entry_lines(journal_entry_id,line_number,account_id,description,debit,credit,supplier_id) VALUES(v_je,v_line_no,v_expense_account,'Reimbursement expense',v_line_total,0,v_supplier); v_line_no:=v_line_no+1; END IF;
  END LOOP;
  IF COALESCE(NEW.ppn_amount,0)>0 THEN INSERT INTO journal_entry_lines(journal_entry_id,line_number,account_id,description,debit,credit,supplier_id) VALUES(v_je,v_line_no,v_ppn_account,'Recoverable PPN - broker invoice',NEW.ppn_amount,0,NEW.supplier_id); v_line_no:=v_line_no+1; END IF;
  FOR v_item IN SELECT value FROM jsonb_array_elements(COALESCE(NEW.broker_items,'[]'::jsonb)) LOOP
    v_supplier:=COALESCE(NULLIF(v_item->>'supplier_id','')::uuid,NEW.supplier_id); v_line_ppn:=COALESCE((v_item->>'ppn_amount')::numeric,0);
    IF v_line_ppn>0 THEN INSERT INTO journal_entry_lines(journal_entry_id,line_number,account_id,description,debit,credit,supplier_id) VALUES(v_je,v_line_no,v_ppn_account,'Recoverable PPN - reimbursement',v_line_ppn,0,v_supplier); v_line_no:=v_line_no+1; END IF;
  END LOOP;
  IF COALESCE(NEW.stamp_duty_amount,0)>0 THEN INSERT INTO journal_entry_lines(journal_entry_id,line_number,account_id,description,debit,credit,supplier_id) VALUES(v_je,v_line_no,v_stamp_account,'Stamp duty',NEW.stamp_duty_amount,0,NEW.supplier_id); v_line_no:=v_line_no+1; END IF;
  IF v_pph>0 THEN INSERT INTO journal_entry_lines(journal_entry_id,line_number,account_id,description,debit,credit,supplier_id) VALUES(v_je,v_line_no,v_pph_account,'PPh23 withheld',0,v_pph,NEW.supplier_id); v_line_no:=v_line_no+1; END IF;
  v_line_total:=v_expense_total-v_pph;
  IF v_line_total<>0 THEN INSERT INTO journal_entry_lines(journal_entry_id,line_number,account_id,description,debit,credit,supplier_id)
    VALUES(v_je,v_line_no,CASE WHEN v_outstanding THEN v_ap_account ELSE v_cash_account END,CASE WHEN v_outstanding THEN 'Supplier payable - customs broker' ELSE 'Cash payment - customs broker' END,0,v_line_total,NEW.supplier_id); END IF;
  RETURN NEW;
END;
$$;

NOTIFY pgrst, 'reload schema';
COMMIT;
