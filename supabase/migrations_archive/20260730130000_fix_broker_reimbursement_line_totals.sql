/*
  Broker reimbursement line-total correction.
  Older broker rows may have amount = 0 while DPP/PPN contain the invoice
  values. Rebuild the existing broker JE incrementally so it remains unique.
*/

CREATE OR REPLACE FUNCTION public.broker_reimbursement_line_total(p_item jsonb)
RETURNS numeric
LANGUAGE sql IMMUTABLE
AS $$
  SELECT COALESCE((p_item->>'amount')::numeric, 0)
       + COALESCE((p_item->>'dpp_amount')::numeric, 0)
       + COALESCE((p_item->>'ppn_amount')::numeric, 0)
$$;

CREATE OR REPLACE FUNCTION public.broker_reimbursement_expense_base(p_item jsonb)
RETURNS numeric
LANGUAGE sql IMMUTABLE
AS $$
  SELECT COALESCE((p_item->>'amount')::numeric, 0)
       + COALESCE((p_item->>'dpp_amount')::numeric, 0)
       - CASE
           WHEN COALESCE((p_item->>'dpp_amount')::numeric, 0) > 0 THEN 0
           WHEN p_item->>'ppn_treatment' = 'included'
             THEN COALESCE((p_item->>'ppn_amount')::numeric, 0)
           ELSE 0
         END
$$;

CREATE OR REPLACE FUNCTION public.correct_customs_broker_reimbursement_totals()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_je uuid;
  v_expense_account uuid;
  v_ap_account uuid;
  v_cash_account uuid;
  v_item jsonb;
  v_supplier uuid;
  v_amount numeric;
  v_old_base numeric;
  v_delta numeric;
  v_balance numeric;
  v_debit numeric;
  v_credit numeric;
  v_line_no int;
  v_outstanding boolean := NEW.payment_method IS NULL OR NEW.payment_method = 'outstanding';
BEGIN
  IF NEW.expense_category <> 'import_broker' THEN RETURN NEW; END IF;

  SELECT id INTO v_je FROM journal_entries WHERE reference_number = 'EXP-' || NEW.id::text LIMIT 1;
  IF v_je IS NULL THEN RETURN NEW; END IF;
  -- The legacy expense trigger can leave its generic PPh narration behind;
  -- broker posting owns the PPh23 line and must not duplicate withholding.
  DELETE FROM journal_entry_lines
   WHERE journal_entry_id = v_je
     AND description LIKE 'PPh Ditahan - %';
  SELECT id INTO v_expense_account FROM chart_of_accounts WHERE code = '5300' LIMIT 1;
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

  FOR v_item IN SELECT value FROM jsonb_array_elements(COALESCE(NEW.broker_items, '[]'::jsonb)) LOOP
    v_supplier := NULLIF(v_item->>'supplier_id', '')::uuid;
    v_old_base := CASE WHEN v_item->>'ppn_treatment' = 'included'
      THEN GREATEST(COALESCE((v_item->>'amount')::numeric,0) - COALESCE((v_item->>'ppn_amount')::numeric,0),0)
      ELSE COALESCE((v_item->>'amount')::numeric,0) END;
    v_delta := public.broker_reimbursement_expense_base(v_item) - v_old_base;
    IF v_delta = 0 THEN CONTINUE; END IF;

    SELECT COALESCE(max(line_number),0) + 1 INTO v_line_no
      FROM journal_entry_lines WHERE journal_entry_id = v_je;
    INSERT INTO journal_entry_lines(journal_entry_id,line_number,account_id,description,debit,credit,supplier_id)
    VALUES(v_je,v_line_no,v_expense_account,'Reimbursement correction - DPP/PPN line total',v_delta,0,COALESCE(v_supplier,NEW.supplier_id));

    IF v_outstanding THEN
      INSERT INTO journal_entry_lines(journal_entry_id,line_number,account_id,description,debit,credit,supplier_id)
      VALUES(v_je,v_line_no+1,v_ap_account,'A/P correction - reimbursement line total',0,v_delta,COALESCE(v_supplier,NEW.supplier_id));
    ELSE
      INSERT INTO journal_entry_lines(journal_entry_id,line_number,account_id,description,debit,credit,supplier_id)
      VALUES(v_je,v_line_no+1,v_cash_account,'Cash correction - reimbursement line total',0,v_delta,NEW.supplier_id);
    END IF;
    UPDATE journal_entries
       SET total_debit = total_debit + v_delta,
           total_credit = total_credit + v_delta
     WHERE id = v_je;
  END LOOP;
  SELECT COALESCE(SUM(debit),0), COALESCE(SUM(credit),0)
    INTO v_debit, v_credit
    FROM journal_entry_lines WHERE journal_entry_id = v_je;
  v_balance := v_debit - v_credit;
  IF v_balance <> 0 THEN
    SELECT COALESCE(max(line_number),0) + 1 INTO v_line_no
      FROM journal_entry_lines WHERE journal_entry_id = v_je;
    IF v_balance > 0 THEN
      INSERT INTO journal_entry_lines(journal_entry_id,line_number,account_id,description,debit,credit,supplier_id)
      VALUES(v_je,v_line_no, v_cash_account, 'Cash balancing - broker reimbursement total',0,v_balance,NEW.supplier_id);
    ELSE
      INSERT INTO journal_entry_lines(journal_entry_id,line_number,account_id,description,debit,credit,supplier_id)
      VALUES(v_je,v_line_no, v_expense_account, 'Expense balancing - broker reimbursement total',-v_balance,0,NEW.supplier_id);
    END IF;
  END IF;
  UPDATE journal_entries je
     SET total_debit = totals.debit,
         total_credit = totals.credit
    FROM (
      SELECT COALESCE(SUM(debit),0) AS debit, COALESCE(SUM(credit),0) AS credit
        FROM journal_entry_lines WHERE journal_entry_id = v_je
    ) totals
   WHERE je.id = v_je;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS zzzz_correct_customs_broker_reimbursement_totals ON public.finance_expenses;
CREATE TRIGGER zzzz_correct_customs_broker_reimbursement_totals
AFTER INSERT OR UPDATE ON public.finance_expenses
FOR EACH ROW EXECUTE FUNCTION public.correct_customs_broker_reimbursement_totals();
