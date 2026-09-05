BEGIN;
DO $repair$
DECLARE r record; olda record; line record; exp record; rec record; bankcoa uuid; ap uuid; period uuid; pay uuid; alloc uuid;
BEGIN
 SELECT id INTO ap FROM public.chart_of_accounts WHERE code='2110' LIMIT 1;
 IF ap IS NULL THEN RAISE EXCEPTION 'AP 2110 missing'; END IF;
 FOR r IN SELECT * FROM (VALUES
  ('EXP/26-26/078'::text,'cccd874b-63f1-4e4b-9c0a-ce1b3c7456c8'::uuid,'2c1db13e-09ab-493b-9677-95965a97c07b'::uuid,16800::numeric,84000::numeric),
  ('EXP/26-26/079','982d2921-ddbc-4cc0-aad5-aca13e0e054f','8816ce0a-a288-446e-b438-8364923b98dd',16800,84000),
  ('EXP/26-26/080','ab15aac9-6a0f-4f5c-afce-a1226ccace55','73990bc9-be45-41af-8107-b7b041c89aaf',16950,84750),
  ('EXP/26-26/081','237dfc77-6b48-4484-bccb-8dff78fbfd7b','c9ba4d7a-4de5-429f-8529-dd589beb2c2c',17315,86575)
 ) x(voucher,eid,aid,rate,functional)
 LOOP
  SELECT * INTO exp FROM public.finance_expenses WHERE id=r.eid FOR UPDATE;
  IF NOT FOUND OR exp.voucher_number IS DISTINCT FROM r.voucher OR exp.amount<>5 OR exp.settlement_amount<>5 OR exp.paid_amount<>5 OR exp.exchange_rate<>r.rate THEN RAISE EXCEPTION 'Expense precondition failed %',r.voucher; END IF;
  SELECT * INTO olda FROM public.bank_statement_allocations WHERE id=r.aid FOR UPDATE;
  IF NOT FOUND THEN
    SELECT a.* INTO olda FROM public.bank_statement_allocations a JOIN public.journal_entries j ON j.id=a.journal_entry_id
     WHERE a.document_id=r.eid AND a.payment_kind='supplier' AND j.source_module='expense_payment' FOR UPDATE;
    IF NOT FOUND OR olda.allocation_amount<>5 THEN RAISE EXCEPTION 'Allocation precondition failed %',r.voucher; END IF;
    PERFORM public.recalculate_expense_payment_state(r.eid);
    CONTINUE;
  END IF;
  IF olda.allocation_amount<>5 OR olda.document_type<>'expense' OR olda.document_id<>r.eid THEN RAISE EXCEPTION 'Allocation precondition failed %',r.voucher; END IF;
  SELECT * INTO line FROM public.bank_statement_lines WHERE id=olda.bank_statement_line_id FOR UPDATE;
  IF NOT FOUND OR line.transaction_date IS NULL OR COALESCE(NULLIF(line.debit_amount,0),line.credit_amount)<>5 OR upper(COALESCE(line.currency,'USD'))<>'USD' THEN RAISE EXCEPTION 'Bank precondition failed %',r.voucher; END IF;
  SELECT * INTO rec FROM public.journal_entries WHERE id=olda.journal_entry_id FOR UPDATE;
  IF NOT FOUND OR rec.entry_number IS NULL OR rec.source_module NOT IN ('expense','expenses') OR rec.is_posted IS DISTINCT FROM true OR rec.is_reversed IS TRUE OR rec.total_debit<>r.functional OR rec.total_credit<>r.functional THEN RAISE EXCEPTION 'Recognition journal precondition failed %',r.voucher; END IF;
  IF (SELECT COALESCE(sum(l.transaction_debit),0) FROM public.journal_entry_lines l WHERE l.journal_entry_id=rec.id AND l.account_id=ap)<>0 OR (SELECT COALESCE(sum(l.transaction_credit),0) FROM public.journal_entry_lines l WHERE l.journal_entry_id=rec.id AND l.account_id=ap)<>5 THEN RAISE EXCEPTION 'Recognition AP lines changed %',r.voucher; END IF;
  IF EXISTS (SELECT 1 FROM public.bank_statement_allocations a JOIN public.journal_entries j ON j.id=a.journal_entry_id WHERE a.bank_statement_line_id=line.id AND a.document_id=r.eid AND a.payment_kind='supplier' AND j.source_module='expense_payment') THEN RAISE EXCEPTION 'Duplicate payment already exists %',r.voucher; END IF;
  SELECT coa_id INTO bankcoa FROM public.bank_accounts WHERE id=line.bank_account_id;
  IF bankcoa IS NULL THEN RAISE EXCEPTION 'Bank GL missing %',r.voucher; END IF;
  SELECT id INTO period FROM public.accounting_periods WHERE start_date<=line.transaction_date AND end_date>=line.transaction_date ORDER BY start_date DESC LIMIT 1;
  DELETE FROM public.bank_statement_allocations WHERE id=r.aid;
  INSERT INTO public.journal_entries(entry_number,entry_date,period_id,source_module,reference_id,reference_number,description,total_debit,total_credit,is_posted,posted_at,transaction_currency,functional_currency,exchange_rate,amounts_are_functional)
   VALUES(public.next_journal_entry_number(),line.transaction_date,period,'expense_payment',r.eid,'EXP-PAY-'||r.aid,'Expense bank payment: '||r.voucher,r.functional,r.functional,true,now(),'USD','IDR',r.rate,true) RETURNING id INTO pay;
  INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,description,debit,credit,transaction_currency,transaction_debit,transaction_credit,functional_currency,exchange_rate,supplier_id)
   VALUES(pay,1,ap,'Expense settlement - '||r.voucher,r.functional,0,'USD',5,0,'IDR',r.rate,exp.supplier_id),(pay,2,bankcoa,'BCA USD payment - '||r.voucher,0,r.functional,'USD',0,5,'IDR',r.rate,exp.supplier_id);
  ALTER TABLE public.bank_statement_allocations DISABLE TRIGGER USER;
  INSERT INTO public.bank_statement_allocations(bank_statement_line_id,document_type,document_id,journal_entry_id,allocation_amount,payment_kind) VALUES(line.id,'expense',r.eid,pay,5,'supplier') RETURNING id INTO alloc;
  ALTER TABLE public.bank_statement_allocations ENABLE TRIGGER USER;
  PERFORM public.recalculate_expense_payment_state(r.eid);
 END LOOP;
 IF (SELECT count(*) FROM public.bank_statement_allocations a JOIN public.journal_entries j ON j.id=a.journal_entry_id WHERE j.reference_number LIKE 'EXP-PAY-%' AND a.document_id IN ('cccd874b-63f1-4e4b-9c0a-ce1b3c7456c8','982d2921-ddbc-4cc0-aad5-aca13e0e054f','ab15aac9-6a0f-4f5c-afce-a1226ccace55','237dfc77-6b48-4484-bccb-8dff78fbfd7b'))<>4 THEN RAISE EXCEPTION 'Four payment journals not present'; END IF;
END $repair$;
COMMIT;
