-- Finance stabilization: make the existing loan and capital document models
-- the canonical source for Bank Reconciliation record actions.

-- Superseded legacy implementation: it created standalone
-- source_module='bank_reconciliation' journals and duplicated account mapping,
-- numbering and posting logic. All callers now use shared Finance commands.
DROP FUNCTION IF EXISTS public.record_non_customer_bank_receipt(uuid,text,text);

ALTER TABLE public.loans
  ADD COLUMN IF NOT EXISTS transaction_currency text,
  ADD COLUMN IF NOT EXISTS functional_currency text,
  ADD COLUMN IF NOT EXISTS exchange_rate numeric,
  ADD COLUMN IF NOT EXISTS bank_account_currency text,
  ADD COLUMN IF NOT EXISTS bank_statement_line_id uuid REFERENCES public.bank_statement_lines(id);

ALTER TABLE public.loan_transactions
  ADD COLUMN IF NOT EXISTS transaction_currency text,
  ADD COLUMN IF NOT EXISTS functional_currency text,
  ADD COLUMN IF NOT EXISTS exchange_rate numeric,
  ADD COLUMN IF NOT EXISTS bank_account_currency text;

ALTER TABLE public.capital_contributions
  ALTER COLUMN director_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS transaction_currency text,
  ADD COLUMN IF NOT EXISTS functional_currency text,
  ADD COLUMN IF NOT EXISTS exchange_rate numeric,
  ADD COLUMN IF NOT EXISTS bank_account_currency text,
  ADD COLUMN IF NOT EXISTS bank_statement_line_id uuid REFERENCES public.bank_statement_lines(id);

CREATE UNIQUE INDEX IF NOT EXISTS loans_bank_statement_line_unique
  ON public.loans(bank_statement_line_id) WHERE bank_statement_line_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS loan_transactions_bank_statement_line_unique
  ON public.loan_transactions(bank_statement_line_id) WHERE bank_statement_line_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS capital_contributions_bank_statement_line_unique
  ON public.capital_contributions(bank_statement_line_id) WHERE bank_statement_line_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.next_loan_number(p_date date)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_prefix text := 'LN' || to_char(p_date,'YYMM'); v_seq integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('loan-number:' || v_prefix));
  SELECT COALESCE(max((regexp_match(loan_number,'([0-9]+)$'))[1]::integer),0)+1 INTO v_seq
  FROM public.loans WHERE loan_number LIKE v_prefix || '-%';
  RETURN v_prefix || '-' || lpad(v_seq::text,4,'0');
END $$;

CREATE OR REPLACE FUNCTION public.next_loan_transaction_number(p_date date)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_prefix text := 'LP' || to_char(p_date,'YYMM'); v_seq integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('loan-transaction-number:' || v_prefix));
  SELECT COALESCE(max((regexp_match(transaction_number,'([0-9]+)$'))[1]::integer),0)+1 INTO v_seq
  FROM public.loan_transactions WHERE transaction_number LIKE v_prefix || '-%';
  RETURN v_prefix || '-' || lpad(v_seq::text,4,'0');
END $$;

CREATE OR REPLACE FUNCTION public.next_capital_contribution_number(p_date date)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_prefix text := 'CC' || to_char(p_date,'YYMM'); v_seq integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('capital-contribution-number:' || v_prefix));
  SELECT COALESCE(max((regexp_match(voucher_number,'([0-9]+)$'))[1]::integer),0)+1 INTO v_seq
  FROM public.capital_contributions WHERE voucher_number LIKE v_prefix || '-%';
  RETURN v_prefix || '-' || lpad(v_seq::text,4,'0');
END $$;

CREATE OR REPLACE FUNCTION public.auto_post_loan_journal()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  v_je_id uuid; v_bank_coa_id uuid; v_loan_coa_id uuid; v_description text;
  v_currency text; v_bank_currency text; v_rate numeric; v_functional_amount numeric;
BEGIN
  IF COALESCE(current_setting('app.finance_metadata_repair',true),'off')='on' THEN RETURN NEW; END IF;
  SELECT coa_id,upper(currency) INTO v_bank_coa_id,v_bank_currency
  FROM public.bank_accounts WHERE id=NEW.bank_account_id AND is_active=true;
  IF v_bank_coa_id IS NULL THEN RAISE EXCEPTION 'Loan bank account is missing or has no active GL account'; END IF;
  v_currency:=upper(COALESCE(NEW.transaction_currency,NEW.currency,v_bank_currency,'IDR'));
  v_rate:=CASE WHEN v_currency='IDR' THEN 1 ELSE NEW.exchange_rate END;
  IF v_currency NOT IN('IDR','USD') OR v_rate IS NULL OR v_rate<=0 OR (v_currency='USD' AND v_rate<=1) THEN
    RAISE EXCEPTION 'Loan currency or exchange rate is invalid';
  END IF;
  IF v_bank_currency<>v_currency THEN RAISE EXCEPTION 'Loan currency % does not match bank currency %',v_currency,v_bank_currency; END IF;
  v_loan_coa_id:=NEW.coa_id;
  IF v_loan_coa_id IS NULL THEN
    SELECT id INTO v_loan_coa_id FROM public.chart_of_accounts
    WHERE code=CASE WHEN NEW.loan_type='taken' THEN '2210' ELSE '1310' END
      AND is_active=true AND COALESCE(is_header,false)=false LIMIT 1;
  END IF;
  IF v_loan_coa_id IS NULL THEN RAISE EXCEPTION 'Loan control account is not configured'; END IF;
  NEW.transaction_currency:=v_currency; NEW.currency:=v_currency; NEW.functional_currency:='IDR';
  NEW.bank_account_currency:=v_bank_currency; NEW.exchange_rate:=v_rate;
  NEW.outstanding_balance:=NEW.principal_amount;
  v_functional_amount:=round(NEW.principal_amount*v_rate,2);
  v_description:=COALESCE(NULLIF(NEW.description,''),CASE WHEN NEW.loan_type='taken' THEN 'Loan received from ' ELSE 'Loan given to ' END||NEW.counterparty_name);
  INSERT INTO public.journal_entries(entry_number,entry_date,source_module,reference_id,reference_number,description,
    total_debit,total_credit,is_posted,posted_at,posted_by,created_by,transaction_currency,functional_currency,exchange_rate,amounts_are_functional)
  VALUES(public.generate_journal_entry_number(),NEW.loan_date,'loans',NEW.id,NEW.loan_number,v_description,
    v_functional_amount,v_functional_amount,true,now(),NEW.created_by,NEW.created_by,v_currency,'IDR',v_rate,true)
  RETURNING id INTO v_je_id;
  IF NEW.loan_type='taken' THEN
    INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,description,debit,credit,
      transaction_currency,transaction_debit,transaction_credit,functional_currency,exchange_rate)
    VALUES(v_je_id,1,v_bank_coa_id,v_description,v_functional_amount,0,v_currency,NEW.principal_amount,0,'IDR',v_rate),
          (v_je_id,2,v_loan_coa_id,v_description,0,v_functional_amount,v_currency,0,NEW.principal_amount,'IDR',v_rate);
  ELSE
    INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,description,debit,credit,
      transaction_currency,transaction_debit,transaction_credit,functional_currency,exchange_rate)
    VALUES(v_je_id,1,v_loan_coa_id,v_description,v_functional_amount,0,v_currency,NEW.principal_amount,0,'IDR',v_rate),
          (v_je_id,2,v_bank_coa_id,v_description,0,v_functional_amount,v_currency,0,NEW.principal_amount,'IDR',v_rate);
  END IF;
  NEW.journal_entry_id:=v_je_id;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.auto_post_loan_transaction_journal()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  v_loan public.loans%ROWTYPE; v_je_id uuid; v_bank_coa_id uuid; v_bank_currency text;
  v_loan_coa_id uuid; v_interest_coa_id uuid; v_currency text; v_rate numeric;
  v_amount numeric; v_principal numeric; v_interest numeric; v_description text; v_line integer:=0;
BEGIN
  IF COALESCE(current_setting('app.finance_metadata_repair',true),'off')='on' THEN RETURN NEW; END IF;
  SELECT * INTO v_loan FROM public.loans WHERE id=NEW.loan_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Loan not found'; END IF;
  SELECT coa_id,upper(currency) INTO v_bank_coa_id,v_bank_currency FROM public.bank_accounts
    WHERE id=COALESCE(NEW.bank_account_id,v_loan.bank_account_id) AND is_active=true;
  IF v_bank_coa_id IS NULL THEN RAISE EXCEPTION 'Repayment bank account is missing or has no active GL account'; END IF;
  v_currency:=upper(COALESCE(NEW.transaction_currency,v_loan.transaction_currency,v_loan.currency,'IDR'));
  v_rate:=CASE WHEN v_currency='IDR' THEN 1 ELSE COALESCE(NEW.exchange_rate,v_loan.exchange_rate) END;
  IF v_currency<>upper(COALESCE(v_loan.transaction_currency,v_loan.currency)) OR v_currency<>v_bank_currency THEN
    RAISE EXCEPTION 'Repayment, loan and bank currencies must match';
  END IF;
  IF v_rate IS NULL OR v_rate<=0 OR (v_currency='USD' AND v_rate<=1) THEN RAISE EXCEPTION 'Repayment exchange rate is invalid'; END IF;
  IF NEW.transaction_type IN('repayment','interest_payment') AND NEW.principal_amount>v_loan.outstanding_balance THEN
    RAISE EXCEPTION 'Principal repayment exceeds outstanding balance';
  END IF;
  IF abs(NEW.amount-(NEW.principal_amount+NEW.interest_amount))>0.01 THEN RAISE EXCEPTION 'Principal plus interest must equal repayment amount'; END IF;
  v_loan_coa_id:=v_loan.coa_id;
  IF v_loan_coa_id IS NULL THEN SELECT id INTO v_loan_coa_id FROM public.chart_of_accounts WHERE code=CASE WHEN v_loan.loan_type='taken' THEN '2210' ELSE '1310' END AND is_active=true AND COALESCE(is_header,false)=false LIMIT 1; END IF;
  v_interest_coa_id:=v_loan.interest_coa_id;
  IF v_interest_coa_id IS NULL THEN SELECT id INTO v_interest_coa_id FROM public.chart_of_accounts WHERE code=CASE WHEN v_loan.loan_type='taken' THEN '7200' ELSE '4920' END AND is_active=true AND COALESCE(is_header,false)=false LIMIT 1; END IF;
  v_amount:=round(NEW.amount*v_rate,2); v_principal:=round(NEW.principal_amount*v_rate,2); v_interest:=round(NEW.interest_amount*v_rate,2);
  v_description:=COALESCE(NULLIF(NEW.description,''),'Loan repayment - '||v_loan.counterparty_name);
  NEW.transaction_currency:=v_currency; NEW.functional_currency:='IDR'; NEW.bank_account_currency:=v_bank_currency; NEW.exchange_rate:=v_rate; NEW.status:='posted';
  INSERT INTO public.journal_entries(entry_number,entry_date,source_module,reference_id,reference_number,description,total_debit,total_credit,
    is_posted,posted_at,posted_by,created_by,transaction_currency,functional_currency,exchange_rate,amounts_are_functional)
  VALUES(public.generate_journal_entry_number(),NEW.transaction_date,'loan_transactions',NEW.id,NEW.transaction_number,v_description,v_amount,v_amount,
    true,now(),NEW.created_by,NEW.created_by,v_currency,'IDR',v_rate,true) RETURNING id INTO v_je_id;
  IF v_loan.loan_type='taken' THEN
    IF NEW.principal_amount>0 THEN v_line:=v_line+1; INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,description,debit,credit,transaction_currency,transaction_debit,transaction_credit,functional_currency,exchange_rate) VALUES(v_je_id,v_line,v_loan_coa_id,v_description,v_principal,0,v_currency,NEW.principal_amount,0,'IDR',v_rate); END IF;
    IF NEW.interest_amount>0 THEN v_line:=v_line+1; INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,description,debit,credit,transaction_currency,transaction_debit,transaction_credit,functional_currency,exchange_rate) VALUES(v_je_id,v_line,v_interest_coa_id,v_description,v_interest,0,v_currency,NEW.interest_amount,0,'IDR',v_rate); END IF;
    v_line:=v_line+1; INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,description,debit,credit,transaction_currency,transaction_debit,transaction_credit,functional_currency,exchange_rate) VALUES(v_je_id,v_line,v_bank_coa_id,v_description,0,v_amount,v_currency,0,NEW.amount,'IDR',v_rate);
  ELSE
    v_line:=v_line+1; INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,description,debit,credit,transaction_currency,transaction_debit,transaction_credit,functional_currency,exchange_rate) VALUES(v_je_id,v_line,v_bank_coa_id,v_description,v_amount,0,v_currency,NEW.amount,0,'IDR',v_rate);
    IF NEW.principal_amount>0 THEN v_line:=v_line+1; INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,description,debit,credit,transaction_currency,transaction_debit,transaction_credit,functional_currency,exchange_rate) VALUES(v_je_id,v_line,v_loan_coa_id,v_description,0,v_principal,v_currency,0,NEW.principal_amount,'IDR',v_rate); END IF;
    IF NEW.interest_amount>0 THEN v_line:=v_line+1; INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,description,debit,credit,transaction_currency,transaction_debit,transaction_credit,functional_currency,exchange_rate) VALUES(v_je_id,v_line,v_interest_coa_id,v_description,0,v_interest,v_currency,0,NEW.interest_amount,'IDR',v_rate); END IF;
  END IF;
  NEW.journal_entry_id:=v_je_id;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.post_capital_contribution_journal()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  v_je_id uuid; v_bank_coa_id uuid; v_capital_account_id uuid; v_bank_currency text;
  v_currency text; v_rate numeric; v_functional_amount numeric; v_description text;
BEGIN
  IF COALESCE(current_setting('app.finance_metadata_repair',true),'off')='on' THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND OLD.journal_entry_id IS NOT NULL THEN RETURN NEW; END IF;
  SELECT coa_id,upper(currency) INTO v_bank_coa_id,v_bank_currency FROM public.bank_accounts WHERE id=NEW.bank_account_id AND is_active=true;
  IF v_bank_coa_id IS NULL THEN RAISE EXCEPTION 'Capital contribution bank account is missing or has no active GL account'; END IF;
  IF NEW.director_id IS NOT NULL THEN SELECT capital_account_id INTO v_capital_account_id FROM public.directors WHERE id=NEW.director_id; END IF;
  IF v_capital_account_id IS NULL THEN SELECT id INTO v_capital_account_id FROM public.chart_of_accounts WHERE code='3100' AND is_active=true AND COALESCE(is_header,false)=false LIMIT 1; END IF;
  IF v_capital_account_id IS NULL THEN RAISE EXCEPTION 'Owner Capital account 3100 is not configured'; END IF;
  v_currency:=upper(COALESCE(NEW.transaction_currency,v_bank_currency,'IDR'));
  v_rate:=CASE WHEN v_currency='IDR' THEN 1 ELSE NEW.exchange_rate END;
  IF v_currency<>v_bank_currency OR v_rate IS NULL OR v_rate<=0 OR (v_currency='USD' AND v_rate<=1) THEN RAISE EXCEPTION 'Capital currency or exchange rate is invalid for the selected bank'; END IF;
  NEW.transaction_currency:=v_currency; NEW.functional_currency:='IDR'; NEW.bank_account_currency:=v_bank_currency; NEW.exchange_rate:=v_rate;
  v_functional_amount:=round(NEW.amount*v_rate,2); v_description:=COALESCE(NULLIF(NEW.description,''),'Capital Contribution: '||NEW.voucher_number);
  INSERT INTO public.journal_entries(entry_number,entry_date,source_module,reference_id,reference_number,description,total_debit,total_credit,
    is_posted,posted_at,posted_by,created_by,transaction_currency,functional_currency,exchange_rate,amounts_are_functional)
  VALUES(public.generate_journal_entry_number(),NEW.voucher_date,'capital_contribution',NEW.id,NEW.voucher_number,v_description,v_functional_amount,v_functional_amount,
    true,now(),NEW.created_by,NEW.created_by,v_currency,'IDR',v_rate,true) RETURNING id INTO v_je_id;
  INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,description,debit,credit,transaction_currency,transaction_debit,transaction_credit,functional_currency,exchange_rate)
  VALUES(v_je_id,1,v_bank_coa_id,v_description,v_functional_amount,0,v_currency,NEW.amount,0,'IDR',v_rate),
        (v_je_id,2,v_capital_account_id,v_description,0,v_functional_amount,v_currency,0,NEW.amount,'IDR',v_rate);
  NEW.journal_entry_id:=v_je_id;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public._link_native_bank_document(p_line_id uuid,p_journal_id uuid,p_label text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  UPDATE public.bank_statement_lines SET matched_entry_id=p_journal_id,reconciliation_status='recorded',matching_status='confirmed',
    matched_at=now(),matched_by=auth.uid(),manually_unlinked=false,notes=p_label
  WHERE id=p_line_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Bank statement line not found'; END IF;
END $$;

CREATE OR REPLACE FUNCTION public.save_finance_loan(p_payload jsonb,p_bank_statement_line_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_id uuid:=gen_random_uuid(); v_number text; v_je uuid; v_coa uuid; v_line public.bank_statement_lines%ROWTYPE; v_amount numeric; v_date date;
BEGIN
  PERFORM public._sec_check_finance_role();
  v_date:=(p_payload->>'loan_date')::date; v_amount:=(p_payload->>'principal_amount')::numeric;
  IF NULLIF(trim(p_payload->>'counterparty_name'),'') IS NULL OR v_amount<=0 THEN RAISE EXCEPTION 'Loan counterparty and positive principal are required'; END IF;
  IF p_payload->>'liability_kind'='director_owner' THEN SELECT id INTO v_coa FROM public.chart_of_accounts WHERE code='2220' AND is_active=true AND COALESCE(is_header,false)=false LIMIT 1;
  ELSE SELECT id INTO v_coa FROM public.chart_of_accounts WHERE code='2210' AND is_active=true AND COALESCE(is_header,false)=false LIMIT 1; END IF;
  IF v_coa IS NULL THEN RAISE EXCEPTION 'Required loan liability account is not configured'; END IF;
  IF p_bank_statement_line_id IS NOT NULL THEN
    SELECT * INTO v_line FROM public.bank_statement_lines WHERE id=p_bank_statement_line_id FOR UPDATE;
    IF NOT FOUND OR COALESCE(v_line.credit_amount,0)<>v_amount OR v_line.bank_account_id<>(p_payload->>'bank_account_id')::uuid THEN RAISE EXCEPTION 'Bank statement line does not exactly match this loan'; END IF;
    IF v_line.matched_entry_id IS NOT NULL THEN RAISE EXCEPTION 'Bank statement line is already linked'; END IF;
  END IF;
  v_number:=public.next_loan_number(v_date);
  INSERT INTO public.loans(id,loan_number,loan_type,counterparty_name,counterparty_type,principal_amount,interest_rate,loan_date,
    bank_account_id,coa_id,currency,transaction_currency,functional_currency,exchange_rate,bank_account_currency,description,created_by,bank_statement_line_id)
  VALUES(v_id,v_number,'taken',trim(p_payload->>'counterparty_name'),COALESCE(NULLIF(p_payload->>'counterparty_type',''),'person'),v_amount,0,v_date,
    (p_payload->>'bank_account_id')::uuid,v_coa,upper(p_payload->>'transaction_currency'),upper(p_payload->>'transaction_currency'),'IDR',(p_payload->>'exchange_rate')::numeric,
    upper(p_payload->>'transaction_currency'),COALESCE(p_payload->>'description',''),COALESCE(NULLIF(p_payload->>'created_by','')::uuid,auth.uid()),p_bank_statement_line_id)
  RETURNING journal_entry_id INTO v_je;
  IF p_bank_statement_line_id IS NOT NULL THEN PERFORM public._link_native_bank_document(p_bank_statement_line_id,v_je,'Loan - '||v_number); END IF;
  RETURN jsonb_build_object('id',v_id,'loan_number',v_number,'journal_entry_id',v_je);
END $$;

CREATE OR REPLACE FUNCTION public.save_finance_loan_repayment(p_payload jsonb,p_bank_statement_line_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_id uuid:=gen_random_uuid(); v_number text; v_je uuid; v_line public.bank_statement_lines%ROWTYPE; v_amount numeric; v_date date;
BEGIN
  PERFORM public._sec_check_finance_role();
  v_date:=(p_payload->>'transaction_date')::date; v_amount:=COALESCE((p_payload->>'principal_amount')::numeric,0)+COALESCE((p_payload->>'interest_amount')::numeric,0);
  IF p_bank_statement_line_id IS NOT NULL THEN
    SELECT * INTO v_line FROM public.bank_statement_lines WHERE id=p_bank_statement_line_id FOR UPDATE;
    IF NOT FOUND OR COALESCE(v_line.debit_amount,0)<>v_amount OR v_line.bank_account_id<>(p_payload->>'bank_account_id')::uuid THEN RAISE EXCEPTION 'Bank statement line does not exactly match this repayment'; END IF;
    IF v_line.matched_entry_id IS NOT NULL THEN RAISE EXCEPTION 'Bank statement line is already linked'; END IF;
  END IF;
  v_number:=public.next_loan_transaction_number(v_date);
  INSERT INTO public.loan_transactions(id,transaction_number,loan_id,transaction_type,transaction_date,amount,principal_amount,interest_amount,
    bank_account_id,bank_statement_line_id,description,created_by,transaction_currency,functional_currency,exchange_rate,bank_account_currency)
  VALUES(v_id,v_number,(p_payload->>'loan_id')::uuid,'repayment',v_date,v_amount,(p_payload->>'principal_amount')::numeric,
    COALESCE((p_payload->>'interest_amount')::numeric,0),(p_payload->>'bank_account_id')::uuid,p_bank_statement_line_id,
    COALESCE(p_payload->>'description',''),COALESCE(NULLIF(p_payload->>'created_by','')::uuid,auth.uid()),upper(p_payload->>'transaction_currency'),'IDR',
    (p_payload->>'exchange_rate')::numeric,upper(p_payload->>'transaction_currency')) RETURNING journal_entry_id INTO v_je;
  IF p_bank_statement_line_id IS NOT NULL THEN PERFORM public._link_native_bank_document(p_bank_statement_line_id,v_je,'Loan Repayment - '||v_number); END IF;
  RETURN jsonb_build_object('id',v_id,'transaction_number',v_number,'journal_entry_id',v_je);
END $$;

CREATE OR REPLACE FUNCTION public.save_finance_capital_contribution(p_payload jsonb,p_bank_statement_line_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_id uuid:=gen_random_uuid(); v_number text; v_je uuid; v_line public.bank_statement_lines%ROWTYPE; v_amount numeric; v_date date;
BEGIN
  PERFORM public._sec_check_finance_role();
  v_date:=(p_payload->>'voucher_date')::date; v_amount:=(p_payload->>'amount')::numeric;
  IF v_amount<=0 THEN RAISE EXCEPTION 'Capital contribution amount must be positive'; END IF;
  IF p_bank_statement_line_id IS NOT NULL THEN
    SELECT * INTO v_line FROM public.bank_statement_lines WHERE id=p_bank_statement_line_id FOR UPDATE;
    IF NOT FOUND OR COALESCE(v_line.credit_amount,0)<>v_amount OR v_line.bank_account_id<>(p_payload->>'bank_account_id')::uuid THEN RAISE EXCEPTION 'Bank statement line does not exactly match this capital contribution'; END IF;
    IF v_line.matched_entry_id IS NOT NULL THEN RAISE EXCEPTION 'Bank statement line is already linked'; END IF;
  END IF;
  v_number:=public.next_capital_contribution_number(v_date);
  INSERT INTO public.capital_contributions(id,voucher_number,voucher_date,director_id,contribution_type,bank_account_id,amount,description,created_by,
    transaction_currency,functional_currency,exchange_rate,bank_account_currency,bank_statement_line_id)
  VALUES(v_id,v_number,v_date,NULL,'bank_transfer',(p_payload->>'bank_account_id')::uuid,v_amount,COALESCE(p_payload->>'description',''),
    COALESCE(NULLIF(p_payload->>'created_by','')::uuid,auth.uid()),upper(p_payload->>'transaction_currency'),'IDR',(p_payload->>'exchange_rate')::numeric,
    upper(p_payload->>'transaction_currency'),p_bank_statement_line_id) RETURNING journal_entry_id INTO v_je;
  IF p_bank_statement_line_id IS NOT NULL THEN PERFORM public._link_native_bank_document(p_bank_statement_line_id,v_je,'Capital Contribution - '||v_number); END IF;
  RETURN jsonb_build_object('id',v_id,'voucher_number',v_number,'journal_entry_id',v_je);
END $$;

CREATE OR REPLACE FUNCTION public.enforce_no_journal_only_bank_link()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF NEW.matched_entry_id IS NULL OR NEW.matched_expense_id IS NOT NULL OR NEW.matched_receipt_id IS NOT NULL
    OR NEW.matched_payment_id IS NOT NULL OR NEW.matched_fund_transfer_id IS NOT NULL OR NEW.matched_petty_cash_id IS NOT NULL
    OR NEW.matched_tax_payment_id IS NOT NULL THEN RETURN NEW; END IF;
  -- Link Existing Journal remains a supported Finance action. Eligibility is
  -- not based on source_module: it is based on an active posted journal that
  -- actually contains this statement line's bank GL account. The shared link
  -- RPC additionally verifies matching side and transaction amount.
  PERFORM 1 FROM public.journal_entries je
  JOIN public.journal_entry_lines jel ON jel.journal_entry_id=je.id
  JOIN public.bank_accounts ba ON ba.coa_id=jel.account_id
  WHERE je.id=NEW.matched_entry_id AND je.is_posted=true AND COALESCE(je.is_reversed,false)=false
    AND ba.id=NEW.bank_account_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Direct journal-to-bank reconciliation is not allowed. Use a supported Finance document.' USING ERRCODE='check_violation'; END IF;
  RETURN NEW;
END $$;

-- Atomic bridge for Bank Reconciliation actions whose native source document
-- is a Manual Journal (other income/refund and Owner Withdrawal). Journal
-- numbering, currency conversion, validation and posting remain delegated to
-- save_finance_journal; reconciliation remains delegated to
-- link_bank_statement_line.
CREATE OR REPLACE FUNCTION public.save_bank_linked_finance_journal(
  p_bank_line_id uuid,
  p_description text,
  p_counter_account_code text,
  p_bank_side text,
  p_transaction_currency text,
  p_exchange_rate numeric
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  v_line public.bank_statement_lines%ROWTYPE; v_bank_coa uuid; v_counter_coa uuid;
  v_amount numeric; v_journal uuid; v_lines jsonb; v_result jsonb;
BEGIN
  PERFORM public._sec_check_finance_role();
  SELECT * INTO v_line FROM public.bank_statement_lines WHERE id=p_bank_line_id FOR UPDATE;
  IF NOT FOUND OR v_line.matched_entry_id IS NOT NULL THEN RAISE EXCEPTION 'Bank statement line is missing or already linked'; END IF;
  SELECT coa_id INTO v_bank_coa FROM public.bank_accounts WHERE id=v_line.bank_account_id AND is_active=true AND upper(currency)=upper(p_transaction_currency);
  SELECT id INTO v_counter_coa FROM public.chart_of_accounts WHERE code=p_counter_account_code AND is_active=true AND COALESCE(is_header,false)=false;
  IF v_bank_coa IS NULL OR v_counter_coa IS NULL THEN RAISE EXCEPTION 'Bank or counter account is not configured'; END IF;
  IF p_bank_side='debit' THEN v_amount:=COALESCE(v_line.credit_amount,0);
  ELSIF p_bank_side='credit' THEN v_amount:=COALESCE(v_line.debit_amount,0);
  ELSE RAISE EXCEPTION 'Bank side must be debit or credit'; END IF;
  IF v_amount<=0 THEN RAISE EXCEPTION 'Bank statement direction does not match this journal action'; END IF;
  v_lines:=CASE WHEN p_bank_side='debit' THEN jsonb_build_array(
      jsonb_build_object('account_id',v_bank_coa,'description',p_description,'debit',v_amount,'credit',0),
      jsonb_build_object('account_id',v_counter_coa,'description',p_description,'debit',0,'credit',v_amount))
    ELSE jsonb_build_array(
      jsonb_build_object('account_id',v_counter_coa,'description',p_description,'debit',v_amount,'credit',0),
      jsonb_build_object('account_id',v_bank_coa,'description',p_description,'debit',0,'credit',v_amount)) END;
  v_journal:=public.save_finance_journal(NULL,v_line.transaction_date,p_description,v_lines,upper(p_transaction_currency),p_exchange_rate);
  v_result:=public.link_bank_statement_line(p_bank_line_id,'journal',v_journal,'supplier');
  RETURN jsonb_build_object('document_id',v_journal,'journal_entry_id',v_journal,'link',v_result);
END $$;

REVOKE ALL ON FUNCTION public.save_finance_loan(jsonb,uuid),public.save_finance_loan_repayment(jsonb,uuid),public.save_finance_capital_contribution(jsonb,uuid) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.save_bank_linked_finance_journal(uuid,text,text,text,text,numeric) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public._link_native_bank_document(uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.save_finance_loan(jsonb,uuid),public.save_finance_loan_repayment(jsonb,uuid),public.save_finance_capital_contribution(jsonb,uuid) TO authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.save_bank_linked_finance_journal(uuid,text,text,text,text,numeric) TO authenticated,service_role;

-- Legacy journal-only loan receipts are not converted without a counterparty.
-- Record them in the existing exception system instead of guessing.
CREATE OR REPLACE FUNCTION public.audit_legacy_bank_reconciliation_source_documents(p_run_id uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_count integer;
DECLARE r record; v_capital_id uuid; v_voucher text;
BEGIN
  -- A posted bank receipt whose sole counter-entry is Owner Capital is already
  -- an explicit operator classification. Create only the missing native source
  -- document and point the existing journal to it; never repost or alter lines.
  FOR r IN
    SELECT je.id journal_id,je.entry_number,je.entry_date,je.description,je.transaction_currency,je.exchange_rate,
      b.id bank_line_id,b.bank_account_id,upper(COALESCE(b.currency,ba.currency,'IDR')) currency,b.credit_amount,upper(ba.currency) bank_currency
    FROM public.journal_entries je
    JOIN public.bank_statement_lines b ON b.id=je.reference_id AND b.matched_entry_id=je.id
    JOIN public.bank_accounts ba ON ba.id=b.bank_account_id
    WHERE je.source_module='bank_reconciliation' AND je.is_posted=true AND COALESCE(je.is_reversed,false)=false
      AND (SELECT count(*) FROM public.journal_entry_lines x WHERE x.journal_entry_id=je.id)=2
      AND EXISTS(SELECT 1 FROM public.journal_entry_lines x JOIN public.chart_of_accounts c ON c.id=x.account_id
        WHERE x.journal_entry_id=je.id AND x.credit>0 AND c.code='3100')
      AND NOT EXISTS(SELECT 1 FROM public.capital_contributions cc WHERE cc.bank_statement_line_id=b.id)
  LOOP
    v_capital_id:=gen_random_uuid(); v_voucher:=public.next_capital_contribution_number(r.entry_date);
    PERFORM set_config('app.finance_metadata_repair','on',true);
    INSERT INTO public.capital_contributions(id,voucher_number,voucher_date,director_id,contribution_type,bank_account_id,amount,description,
      journal_entry_id,created_by,transaction_currency,functional_currency,exchange_rate,bank_account_currency,bank_statement_line_id)
    SELECT v_capital_id,v_voucher,r.entry_date,NULL,'bank_transfer',r.bank_account_id,r.credit_amount,r.description,r.journal_id,
      je.created_by,r.currency,'IDR',CASE WHEN r.currency='IDR' THEN 1 ELSE r.exchange_rate END,r.bank_currency,r.bank_line_id
    FROM public.journal_entries je WHERE je.id=r.journal_id;
    PERFORM set_config('app.finance_metadata_repair','off',true);
    UPDATE public.journal_entries SET source_module='capital_contribution',reference_id=v_capital_id,reference_number=v_voucher WHERE id=r.journal_id;
    INSERT INTO public.finance_historical_repair_items(run_id,document_type,document_id,document_number,repaired_fields,old_metadata,new_metadata,repair_reason)
    VALUES(p_run_id,'capital_contribution',v_capital_id,v_voucher,ARRAY['source document','source_module','reference_id','reference_number'],
      jsonb_build_object('journal_source_module','bank_reconciliation','journal_reference_id',r.bank_line_id),
      jsonb_build_object('journal_source_module','capital_contribution','journal_reference_id',v_capital_id,'bank_statement_line_id',r.bank_line_id),
      'The posted two-line bank receipt and sole Owner Capital counter-entry prove the missing Capital Contribution source document');
    IF r.currency='USD' AND r.exchange_rate IS NULL THEN
      INSERT INTO public.finance_historical_repair_exceptions(run_id,document_type,document_id,document_number,inconsistent_fields,reason,manual_information_required,status)
      VALUES(p_run_id,'capital_contribution',v_capital_id,v_voucher,ARRAY['exchange_rate'],
        'Legacy USD capital contribution has no authoritative historical exchange rate; accounting amounts were preserved unchanged',
        'Authoritative USD-to-IDR rate and rate source for the contribution date','manual_review');
    END IF;
  END LOOP;

  INSERT INTO public.finance_historical_repair_exceptions(run_id,document_type,document_id,document_number,inconsistent_fields,reason,manual_information_required,status)
  SELECT p_run_id,'journal',je.id,je.entry_number,ARRAY['source_module','reference_id'],
    CASE WHEN coa.code='2220' THEN 'Legacy Bank Reconciliation Director/Owner Loan journal has no native Loan source document'
         ELSE 'Legacy Bank Reconciliation loan journal has no native Loan source document' END,
    'Counterparty name and type, loan terms, and accountant confirmation that this receipt opens a loan; then manually relink to the native Loan document',
    'manual_review'
  FROM public.journal_entries je
  JOIN public.journal_entry_lines jel ON jel.journal_entry_id=je.id AND jel.credit>0
  JOIN public.chart_of_accounts coa ON coa.id=jel.account_id AND coa.code IN('2210','2220')
  WHERE je.source_module='bank_reconciliation' AND je.is_posted=true AND COALESCE(je.is_reversed,false)=false
    AND NOT EXISTS(SELECT 1 FROM public.finance_historical_repair_exceptions e WHERE e.run_id=p_run_id AND e.document_type='journal' AND e.document_id=je.id);
  GET DIAGNOSTICS v_count=ROW_COUNT;
  UPDATE public.finance_historical_repair_runs SET
    total_records_scanned=(SELECT count(*) FROM public.finance_expenses)+(SELECT count(*) FROM public.receipt_vouchers)
      +(SELECT count(*) FROM public.payment_vouchers)+(SELECT count(*) FROM public.fund_transfers)
      +(SELECT count(*) FROM public.journal_entries)+(SELECT count(*) FROM public.bank_statement_lines)
      +(SELECT count(*) FROM public.loans)+(SELECT count(*) FROM public.loan_transactions)+(SELECT count(*) FROM public.capital_contributions),
    records_repaired=(SELECT count(DISTINCT (i.document_type,i.document_id)) FROM public.finance_historical_repair_items i WHERE i.run_id=p_run_id
      AND NOT EXISTS(SELECT 1 FROM public.finance_historical_repair_exceptions e WHERE e.run_id=p_run_id AND e.status='manual_review'
        AND e.document_type=i.document_type AND e.document_id=i.document_id)),
    records_partially_repaired=(SELECT count(DISTINCT (i.document_type,i.document_id)) FROM public.finance_historical_repair_items i WHERE i.run_id=p_run_id
      AND EXISTS(SELECT 1 FROM public.finance_historical_repair_exceptions e WHERE e.run_id=p_run_id AND e.status='manual_review' AND e.document_type=i.document_type AND e.document_id=i.document_id)),
    records_manual_review=(
    SELECT count(DISTINCT (document_type,document_id)) FROM public.finance_historical_repair_exceptions WHERE run_id=p_run_id AND status='manual_review'
  ) WHERE id=p_run_id;
  RETURN v_count;
END $$;
