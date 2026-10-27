-- Prevent foreign-currency purchase invoices from posting raw transaction
-- amounts into functional-currency journal columns. No historical rows are
-- changed; this only affects future trigger executions.
CREATE OR REPLACE FUNCTION public.post_purchase_invoice_journal()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public','pg_temp' AS $function$
DECLARE
  v_je_id uuid; v_ap uuid; v_ppn uuid; v_account uuid; v_line int := 1;
  v_item record; v_currency text := upper(coalesce(NEW.currency,'IDR'));
  v_rate numeric := case when v_currency='IDR' then 1 else coalesce(NEW.exchange_rate,0) end;
  v_items numeric := 0; v_tax numeric := coalesce(NEW.tax_amount,0);
  v_total numeric := coalesce(NEW.total_amount,0);
BEGIN
  IF NEW.journal_entry_id IS NOT NULL THEN RETURN NEW; END IF;
  IF NOT (TG_OP='INSERT' OR (TG_OP='UPDATE' AND OLD.journal_entry_id IS NULL AND NEW.status IN ('unpaid','partial','paid'))) THEN RETURN NEW; END IF;
  IF v_currency <> 'IDR' AND v_rate <= 1 THEN
    RAISE EXCEPTION 'Purchase invoice % requires a valid exchange rate', NEW.invoice_number;
  END IF;
  SELECT id INTO v_ap FROM chart_of_accounts WHERE code='2110' LIMIT 1;
  SELECT id INTO v_ppn FROM chart_of_accounts WHERE code='1150' LIMIT 1;
  IF v_ap IS NULL THEN RETURN NEW; END IF;
  SELECT coalesce(sum(line_total),0) INTO v_items FROM purchase_invoice_items WHERE purchase_invoice_id=NEW.id;
  IF EXISTS (SELECT 1 FROM purchase_invoice_items WHERE purchase_invoice_id=NEW.id)
     AND abs((v_items + v_tax) - v_total) > 0.01 THEN
    RAISE EXCEPTION 'Purchase invoice % totals do not reconcile: item lines + tax (%) != header total (%)', NEW.invoice_number, v_items + v_tax, v_total;
  END IF;
  INSERT INTO journal_entries(entry_number,entry_date,source_module,reference_id,reference_number,description,total_debit,total_credit,is_posted,posted_by,created_by,transaction_currency,functional_currency,exchange_rate,amounts_are_functional)
  VALUES ('JE-'||to_char(NEW.invoice_date,'YYMM')||'-'||lpad(((select coalesce(max(cast(substring(entry_number from '(\\d+)$') as int)),0)+1 from journal_entries where entry_number like 'JE-'||to_char(NEW.invoice_date,'YYMM')||'-%'))::text,4,'0'),NEW.invoice_date,'purchase_invoice',NEW.id,NEW.invoice_number,'Purchase Invoice: '||NEW.invoice_number,v_total*v_rate,v_total*v_rate,true,NEW.created_by,NEW.created_by,v_currency,'IDR',v_rate,true) RETURNING id INTO v_je_id;
  FOR v_item IN SELECT * FROM purchase_invoice_items WHERE purchase_invoice_id=NEW.id ORDER BY id LOOP
    v_account := CASE WHEN v_item.item_type='inventory' THEN (select id from chart_of_accounts where code='1130' limit 1)
      WHEN v_item.item_type='fixed_asset' THEN coalesce(v_item.asset_account_id,(select id from chart_of_accounts where code='1200' limit 1))
      ELSE coalesce(v_item.expense_account_id,(select id from chart_of_accounts where code='5100' limit 1)) END;
    IF v_account IS NOT NULL THEN
      INSERT INTO journal_entry_lines(journal_entry_id,line_number,account_id,description,debit,credit,supplier_id,batch_id,transaction_currency,transaction_debit,transaction_credit,functional_currency,exchange_rate)
      VALUES(v_je_id,v_line,v_account,coalesce(left(v_item.description,100),'Purchase - '||NEW.invoice_number),v_item.line_total*v_rate,0,NEW.supplier_id,v_item.batch_id,v_currency,v_item.line_total,0,'IDR',v_rate); v_line:=v_line+1;
    END IF;
  END LOOP;
  IF v_tax > 0 AND v_ppn IS NOT NULL THEN
    INSERT INTO journal_entry_lines(journal_entry_id,line_number,account_id,description,debit,credit,supplier_id,transaction_currency,transaction_debit,transaction_credit,functional_currency,exchange_rate)
    VALUES(v_je_id,v_line,v_ppn,'PPN Input - '||NEW.invoice_number,v_tax*v_rate,0,NEW.supplier_id,v_currency,v_tax,0,'IDR',v_rate); v_line:=v_line+1;
  END IF;
  INSERT INTO journal_entry_lines(journal_entry_id,line_number,account_id,description,debit,credit,supplier_id,transaction_currency,transaction_debit,transaction_credit,functional_currency,exchange_rate)
  VALUES(v_je_id,v_line,v_ap,'A/P - '||NEW.invoice_number,0,v_total*v_rate,NEW.supplier_id,v_currency,0,v_total,'IDR',v_rate);
  NEW.journal_entry_id:=v_je_id; RETURN NEW;
END; $function$;
