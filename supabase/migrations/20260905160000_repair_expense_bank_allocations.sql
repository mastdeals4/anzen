/* Repair seven historical expense allocations that incorrectly pointed at the
   recognition journal.  This is deliberately a data-only, owner-context
   migration: the finance-role guard is not bypassed or changed. */
BEGIN;

DO $repair$
DECLARE
  r record;
  v_old public.bank_statement_allocations%rowtype;
  v_line public.bank_statement_lines%rowtype;
  v_exp public.finance_expenses%rowtype;
  v_recognition uuid;
  v_payment uuid;
  v_alloc uuid;
  v_ap uuid;
  v_bank_coa uuid;
  v_period uuid;
  v_entry text;
  v_bank_amount numeric;
  v_existing_count integer;
  v_old_exists boolean;
  v_created integer := 0;
  v_total numeric := 0;
BEGIN
  SELECT id INTO v_ap FROM public.chart_of_accounts WHERE code='2110' LIMIT 1;
  IF v_ap IS NULL THEN RAISE EXCEPTION 'Accounts Payable account 2110 is missing'; END IF;

  FOR r IN
    SELECT * FROM (VALUES
      ('EXP/25/227'::text,'f050e64d-c8ee-4d31-b726-f93101f18534'::uuid,'be239431-66ff-4703-829a-a90905237455'::uuid,'d3cbbb03-695e-448f-a246-4efdaddca11a'::uuid,50000::numeric),
      ('EXP/25/228','5e783951-f807-40c4-bfa1-772164fffb0c','9c3ba69b-1964-417e-9f04-90c8e6c4b4b7','6a2af0c0-03bf-403f-9868-7cb64a2f24c7',50000),
      ('EXP/25/229','4bd7d777-6d53-4d8e-bf6f-aa32215ad4e7','4ce923d7-e9f7-4c8d-9456-d0fb67b61d5c','6dd90c44-7dd4-4734-a8ee-cb1302249d13',100000),
      ('EXP/25/235','c926c49c-ebe3-41cb-bae7-7b47a0b1b886','96846c46-9fd8-4105-9ad8-4ff0721aa04f','4f8a3ffb-87fe-4edc-b15c-28e888856a82',50000),
      ('EXP/25/292','638dc395-4e46-47b7-a949-735c2ed4aa05','500138e9-c169-47b6-a937-a933345864e0','e815213b-ed01-473f-88c9-d96c75b57f7d',100000),
      ('EXP/26-26/136','e221d031-be7c-4921-ad06-f26360d9779a','6ceff658-4591-43ba-9a63-76e125c4b4ff','00898dc1-4fe4-406e-b3ad-fb1b066b6ca5',50000),
      ('EXP/26-26/137','47dd1d03-39a8-4a64-864f-0fea27396d56','8dc272a0-3238-4ecf-a76a-4d89bb643591','62741aab-2c1b-4393-98c5-f754758c4896',50000)
    ) AS x(voucher,expense_id,allocation_id,bank_line_id,amount)
  LOOP
    SELECT * INTO v_exp FROM public.finance_expenses WHERE id=r.expense_id FOR UPDATE;
    IF NOT FOUND OR v_exp.voucher_number IS DISTINCT FROM r.voucher THEN RAISE EXCEPTION 'Unexpected expense state for %',r.voucher; END IF;
    SELECT * INTO v_line FROM public.bank_statement_lines WHERE id=r.bank_line_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Bank line missing for %',r.voucher; END IF;
    v_bank_amount := COALESCE(NULLIF(v_line.debit_amount,0),v_line.credit_amount,0);
    IF abs(v_bank_amount-r.amount)>0.01 THEN RAISE EXCEPTION 'Bank amount mismatch for %',r.voucher; END IF;

    SELECT je.id INTO v_recognition
      FROM public.journal_entries je
     WHERE je.source_module IN ('expense','expenses') AND je.reference_id=r.expense_id
       AND je.is_posted AND NOT COALESCE(je.is_reversed,false)
     ORDER BY je.created_at DESC,je.id DESC LIMIT 1;
    IF v_recognition IS NULL THEN RAISE EXCEPTION 'Recognition journal missing for %',r.voucher; END IF;

    SELECT * INTO v_old FROM public.bank_statement_allocations WHERE id=r.allocation_id FOR UPDATE;
    v_old_exists := FOUND;
    IF v_old_exists THEN
      IF v_old.bank_statement_line_id<>r.bank_line_id OR v_old.document_type<>'expense' OR v_old.document_id<>r.expense_id
         OR v_old.journal_entry_id<>v_recognition OR abs(v_old.allocation_amount-r.amount)>0.01 OR v_old.payment_kind<>'supplier'
      THEN RAISE EXCEPTION 'Old allocation differs from expected state for %',r.voucher; END IF;
    END IF;

    SELECT count(*) INTO v_existing_count
      FROM public.bank_statement_allocations a JOIN public.journal_entries je ON je.id=a.journal_entry_id
     WHERE a.bank_statement_line_id=r.bank_line_id AND a.document_type='expense' AND a.document_id=r.expense_id
       AND a.payment_kind='supplier' AND je.source_module='expense_payment';
    IF v_existing_count>1 THEN RAISE EXCEPTION 'Duplicate proper payments already exist for %',r.voucher; END IF;
    IF v_existing_count=1 THEN
      IF v_old_exists THEN RAISE EXCEPTION 'Both old and proper allocations exist for %',r.voucher; END IF;
      SELECT a.id INTO v_alloc FROM public.bank_statement_allocations a JOIN public.journal_entries je ON je.id=a.journal_entry_id
       WHERE a.bank_statement_line_id=r.bank_line_id AND a.document_type='expense' AND a.document_id=r.expense_id AND a.payment_kind='supplier' AND je.source_module='expense_payment';
      IF FOUND AND (SELECT allocation_amount FROM public.bank_statement_allocations WHERE id=v_alloc)<>r.amount THEN RAISE EXCEPTION 'Existing payment amount mismatch for %',r.voucher; END IF;
      PERFORM public.recalculate_expense_payment_state(r.expense_id); v_total := v_total + r.amount; CONTINUE;
    END IF;
    IF NOT v_old_exists THEN RAISE EXCEPTION 'Expected old allocation % missing for %',r.allocation_id,r.voucher; END IF;

    SELECT coa_id INTO v_bank_coa FROM public.bank_accounts WHERE id=v_line.bank_account_id;
    IF v_bank_coa IS NULL THEN RAISE EXCEPTION 'Bank GL account missing for %',r.voucher; END IF;
    SELECT id INTO v_period FROM public.accounting_periods WHERE start_date<=v_line.transaction_date AND end_date>=v_line.transaction_date ORDER BY start_date DESC LIMIT 1;
    v_entry := public.next_journal_entry_number();
    DELETE FROM public.bank_statement_allocations WHERE id=r.allocation_id;
    INSERT INTO public.journal_entries(entry_number,entry_date,period_id,source_module,reference_id,reference_number,description,total_debit,total_credit,is_posted,posted_at)
    VALUES(v_entry,v_line.transaction_date,v_period,'expense_payment',r.expense_id,'EXP-PAY-'||r.allocation_id,'Expense bank payment: '||r.voucher,r.amount,r.amount,true,now()) RETURNING id INTO v_payment;
    INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,description,debit,credit,transaction_currency,transaction_debit,transaction_credit,functional_currency,exchange_rate,supplier_id)
    VALUES (v_payment,1,v_ap,'Expense settlement - '||r.voucher,r.amount,0,'IDR',r.amount,0,'IDR',1,v_exp.supplier_id),
           (v_payment,2,v_bank_coa,'Bank payment - '||r.voucher,0,r.amount,'IDR',0,r.amount,'IDR',1,v_exp.supplier_id);
    INSERT INTO public.bank_statement_allocations(id,bank_statement_line_id,document_type,document_id,journal_entry_id,allocation_amount,payment_kind)
    VALUES(r.allocation_id,r.bank_line_id,'expense',r.expense_id,v_payment,r.amount,'supplier');
    PERFORM public.recalculate_expense_payment_state(r.expense_id);
    v_created := v_created + 1; v_total := v_total + r.amount;
  END LOOP;

  IF v_total <> 450000 THEN RAISE EXCEPTION 'Repair total mismatch: %',v_total; END IF;
  IF (SELECT count(*) FROM public.bank_statement_allocations a JOIN public.journal_entries je ON je.id=a.journal_entry_id
      WHERE a.id IN ('be239431-66ff-4703-829a-a90905237455','9c3ba69b-1964-417e-9f04-90c8e6c4b4b7','4ce923d7-e9f7-4c8d-9456-d0fb67b61d5c','96846c46-9fd8-4105-9ad8-4ff0721aa04f','500138e9-c169-47b6-a937-a933345864e0','6ceff658-4591-43ba-9a63-76e125c4b4ff','8dc272a0-3238-4ecf-a76a-4d89bb643591') AND je.source_module='expense_payment')<>7 THEN RAISE EXCEPTION 'Expected exactly seven repaired allocations'; END IF;
  IF EXISTS (SELECT 1 FROM public.bank_statement_allocations a JOIN public.journal_entries je ON je.id=a.journal_entry_id
      WHERE a.id IN ('be239431-66ff-4703-829a-a90905237455','9c3ba69b-1964-417e-9f04-90c8e6c4b4b7','4ce923d7-e9f7-4c8d-9456-d0fb67b61d5c','96846c46-9fd8-4105-9ad8-4ff0721aa04f','500138e9-c169-47b6-a937-a933345864e0','6ceff658-4591-43ba-9a63-76e125c4b4ff','8dc272a0-3238-4ecf-a76a-4d89bb643591')
        AND (SELECT COALESCE(sum(l.debit),0) FROM public.journal_entry_lines l WHERE l.journal_entry_id=je.id AND l.account_id=v_ap)<>a.allocation_amount) THEN RAISE EXCEPTION 'AP debit assertion failed'; END IF;
END;
$repair$;

COMMIT;
