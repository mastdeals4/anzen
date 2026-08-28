/*
  Customs broker accounting correction.

  The existing expense trigger remains the compatibility path for all other
  expense categories. This late, idempotent broker trigger replaces the
  temporary standard posting with one balanced posting containing:
    Dr service/reimbursement expense (excluding recoverable PPN)
    Dr PPN Masukan
    Dr stamp duty expense
    Cr PPh23 payable
    Cr supplier AP (or cash for an immediately paid bill)

  Reimbursement journal lines retain their supplier_id, so Party Ledger,
  Supplier Ledger and AP can identify each sub-supplier without changing the
  document workflow or duplicating the invoice.
*/

CREATE OR REPLACE FUNCTION public.post_customs_broker_accounting()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_je uuid;
  v_expense_account uuid;
  v_ppn_account uuid;
  v_pph_account uuid;
  v_stamp_account uuid;
  v_cash_account uuid;
  v_ap_account uuid;
  v_line_no int := 1;
  v_expense numeric(18,2) := COALESCE(NEW.amount, 0);
  v_reimbursement numeric(18,2) := 0;
  v_reimbursement_ppn numeric(18,2) := 0;
  v_header_ppn numeric(18,2) := COALESCE(NEW.ppn_amount, 0);
  v_pph numeric(18,2) := COALESCE(NEW.pph_amount, 0);
  v_stamp numeric(18,2) := COALESCE(NEW.stamp_duty_amount, 0);
  v_total_ppn numeric(18,2);
  v_cash numeric(18,2);
  v_entry_number text;
  v_item jsonb;
  v_item_amount numeric(18,2);
  v_item_ppn numeric(18,2);
  v_item_supplier uuid;
  v_supplier_total numeric(18,2);
  v_is_outstanding boolean := NEW.payment_method IS NULL OR NEW.payment_method = 'outstanding';
BEGIN
  IF NEW.expense_category <> 'import_broker' THEN
    RETURN NEW;
  END IF;

  -- Replace the standard compatibility posting. The reference is unique to
  -- the source expense, so the final transaction has exactly one JE.
  DELETE FROM journal_entry_lines WHERE journal_entry_id IN
    (SELECT id FROM journal_entries WHERE reference_number = 'EXP-' || NEW.id::text);
  DELETE FROM journal_entries WHERE reference_number = 'EXP-' || NEW.id::text;

  SELECT id INTO v_expense_account FROM chart_of_accounts WHERE code = '5300' LIMIT 1;
  SELECT id INTO v_ppn_account FROM chart_of_accounts WHERE code = '1150' LIMIT 1;
  SELECT id INTO v_pph_account FROM chart_of_accounts WHERE code = '2132' LIMIT 1;
  SELECT id INTO v_stamp_account FROM chart_of_accounts WHERE code = '6950' LIMIT 1;
  SELECT id INTO v_ap_account FROM chart_of_accounts WHERE code = '2110' LIMIT 1;
  IF NEW.payment_method = 'cash' THEN
    SELECT id INTO v_cash_account FROM chart_of_accounts WHERE code = '1101' LIMIT 1;
  ELSIF NEW.payment_method = 'petty_cash' THEN
    SELECT id INTO v_cash_account FROM chart_of_accounts WHERE code = '1102' LIMIT 1;
  ELSIF NEW.payment_method = 'bank_transfer' AND NEW.bank_account_id IS NOT NULL THEN
    SELECT coa_id INTO v_cash_account FROM bank_accounts WHERE id = NEW.bank_account_id;
  ELSE
    SELECT id INTO v_cash_account FROM chart_of_accounts WHERE code = '1101' LIMIT 1;
  END IF;

  IF v_expense_account IS NULL OR v_ppn_account IS NULL OR v_ap_account IS NULL THEN
    RAISE EXCEPTION 'Customs broker posting requires accounts 5300, 1150 and 2110';
  END IF;
  IF v_is_outstanding = false AND v_cash_account IS NULL THEN
    RAISE EXCEPTION 'Customs broker posting requires a cash/bank account';
  END IF;
  IF v_pph > 0 AND v_pph_account IS NULL THEN
    RAISE EXCEPTION 'Customs broker posting requires PPh23 payable account 2132';
  END IF;
  IF v_stamp > 0 AND v_stamp_account IS NULL THEN
    RAISE EXCEPTION 'Customs broker posting requires stamp duty account 6950';
  END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(COALESCE(NEW.broker_items, '[]'::jsonb)) LOOP
    v_item_amount := COALESCE((v_item->>'amount')::numeric, 0);
    v_item_ppn := COALESCE((v_item->>'ppn_amount')::numeric, 0);
    -- An inclusive line stores the gross reimbursement amount; recoverable
    -- PPN is removed from expense. Excluded lines store the taxable amount.
    v_item_amount := CASE WHEN v_item->>'ppn_treatment' = 'included'
      THEN GREATEST(v_item_amount - v_item_ppn, 0) ELSE v_item_amount END;
    v_reimbursement := v_reimbursement + v_item_amount;
    v_reimbursement_ppn := v_reimbursement_ppn + v_item_ppn;
  END LOOP;
  v_expense := v_expense + v_reimbursement + v_stamp;
  v_total_ppn := v_header_ppn + v_reimbursement_ppn;
  v_cash := v_expense + v_total_ppn - v_pph;

  SELECT 'JE' || to_char(NEW.expense_date, 'YYMM') || '-' || lpad((
    COALESCE(max(CAST(substring(entry_number FROM '-([0-9]+)$') AS int)), 0) + 1
  )::text, 4, '0') INTO v_entry_number
  FROM journal_entries WHERE entry_number LIKE 'JE' || to_char(NEW.expense_date, 'YYMM') || '-%';

  INSERT INTO journal_entries(entry_number, entry_date, source_module, reference_id,
    reference_number, description, transaction_category, total_debit, total_credit,
    is_posted, posted_at, created_by)
  VALUES(v_entry_number, NEW.expense_date, 'expenses', NEW.id, 'EXP-' || NEW.id::text,
    COALESCE(NEW.description, 'Customs Broker Invoice'), 'import_broker',
    v_expense + v_total_ppn, v_expense + v_total_ppn, true, now(), NEW.created_by)
  RETURNING id INTO v_je;

  INSERT INTO journal_entry_lines(journal_entry_id,line_number,account_id,description,debit,credit,supplier_id)
  VALUES(v_je,v_line_no,v_expense_account,'Broker service expense',COALESCE(NEW.amount,0),0,NEW.supplier_id);
  v_line_no := v_line_no + 1;

  FOR v_item IN SELECT value FROM jsonb_array_elements(COALESCE(NEW.broker_items, '[]'::jsonb)) LOOP
    v_item_amount := COALESCE((v_item->>'amount')::numeric, 0);
    v_item_ppn := COALESCE((v_item->>'ppn_amount')::numeric, 0);
    v_item_supplier := NULLIF(v_item->>'supplier_id','')::uuid;
    v_item_amount := CASE WHEN v_item->>'ppn_treatment' = 'included'
      THEN GREATEST(v_item_amount - v_item_ppn, 0) ELSE v_item_amount END;
    IF v_item_amount > 0 THEN
      INSERT INTO journal_entry_lines(journal_entry_id,line_number,account_id,description,debit,credit,supplier_id)
      VALUES(v_je,v_line_no,v_expense_account,'Reimbursement - ' || COALESCE(v_item->>'description','line'),v_item_amount,0,COALESCE(v_item_supplier,NEW.supplier_id));
      v_line_no := v_line_no + 1;
    END IF;
    IF v_item_ppn > 0 THEN
      INSERT INTO journal_entry_lines(journal_entry_id,line_number,account_id,description,debit,credit,supplier_id)
      VALUES(v_je,v_line_no,v_ppn_account,'PPN Masukan - reimbursement',v_item_ppn,0,COALESCE(v_item_supplier,NEW.supplier_id));
      v_line_no := v_line_no + 1;
    END IF;
  END LOOP;

  IF v_header_ppn > 0 THEN
    INSERT INTO journal_entry_lines(journal_entry_id,line_number,account_id,description,debit,credit,supplier_id)
    VALUES(v_je,v_line_no,v_ppn_account,'PPN Masukan - broker invoice',v_header_ppn,0,NEW.supplier_id);
    v_line_no := v_line_no + 1;
  END IF;
  IF v_stamp > 0 THEN
    INSERT INTO journal_entry_lines(journal_entry_id,line_number,account_id,description,debit,credit,supplier_id)
    VALUES(v_je,v_line_no,v_stamp_account,'Bea Meterai',v_stamp,0,NEW.supplier_id);
    v_line_no := v_line_no + 1;
  END IF;
  IF v_pph > 0 THEN
    INSERT INTO journal_entry_lines(journal_entry_id,line_number,account_id,description,debit,credit,supplier_id)
    VALUES(v_je,v_line_no,v_pph_account,'PPh23 Payable',0,v_pph,NEW.supplier_id);
    v_line_no := v_line_no + 1;
  END IF;

  IF v_is_outstanding THEN
    -- One AP credit per supplier: broker service and every reimbursement
    -- supplier remain independently visible in Supplier/Party Ledger.
    v_supplier_total := COALESCE(NEW.amount,0) + v_header_ppn + v_stamp - v_pph;
    IF v_supplier_total <> 0 THEN
      INSERT INTO journal_entry_lines(journal_entry_id,line_number,account_id,description,debit,credit,supplier_id)
      VALUES(v_je,v_line_no,v_ap_account,'A/P - broker supplier',0,v_supplier_total,NEW.supplier_id);
      v_line_no := v_line_no + 1;
    END IF;
    FOR v_item IN SELECT value FROM jsonb_array_elements(COALESCE(NEW.broker_items, '[]'::jsonb)) LOOP
      v_item_amount := COALESCE((v_item->>'amount')::numeric, 0);
      v_item_ppn := COALESCE((v_item->>'ppn_amount')::numeric, 0);
      v_item_supplier := NULLIF(v_item->>'supplier_id','')::uuid;
      v_item_amount := CASE WHEN v_item->>'ppn_treatment' = 'included' THEN GREATEST(v_item_amount-v_item_ppn,0) ELSE v_item_amount END;
      IF v_item_amount + v_item_ppn > 0 THEN
        INSERT INTO journal_entry_lines(journal_entry_id,line_number,account_id,description,debit,credit,supplier_id)
        VALUES(v_je,v_line_no,v_ap_account,'A/P - reimbursement supplier',0,v_item_amount+v_item_ppn,COALESCE(v_item_supplier,NEW.supplier_id));
        v_line_no := v_line_no + 1;
      END IF;
    END LOOP;
  ELSE
    INSERT INTO journal_entry_lines(journal_entry_id,line_number,account_id,description,debit,credit,supplier_id)
    VALUES(v_je,v_line_no,v_cash_account,'Cash payment - customs broker',0,v_cash,NEW.supplier_id);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS zzz_post_customs_broker_accounting ON public.finance_expenses;
CREATE TRIGGER zzz_post_customs_broker_accounting
AFTER INSERT OR UPDATE ON public.finance_expenses
FOR EACH ROW EXECUTE FUNCTION public.post_customs_broker_accounting();

