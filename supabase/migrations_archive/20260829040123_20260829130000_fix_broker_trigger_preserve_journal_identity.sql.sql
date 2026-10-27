/*
# Fix: Customs broker trigger must preserve journal identity during edit

## Problem
The `post_customs_broker_canonical()` trigger function (fired on UPDATE of an
approved `import_broker` expense) DELETES the existing journal entry and creates
a brand-new one with a different ID. This breaks `edit_approved_finance_expense_atomic`,
which captures the journal ID before the UPDATE, then checks after the UPDATE
that the same journal still exists. Since the trigger replaced it, the guard
raises "Expense journal identity changed during edit" and the save fails.

## Fix
Rewrite `post_customs_broker_canonical()` to reuse the existing journal header
via `upsert_expense_journal_header_in_place()` (the same helper used by
`auto_post_expense_accounting`). This keeps the journal entry ID stable across
edits, only rebuilding the lines. If no active journal exists yet (first
approval), it creates one as before.

## Security
- Function remains SECURITY DEFINER, search_path = public, pg_temp.
- EXECUTE revoked from PUBLIC/anon, granted to authenticated,service_role.
- No new tables or columns.
- No production data is modified.
*/

CREATE OR REPLACE FUNCTION public.post_customs_broker_canonical()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
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
  v_expense_total numeric;
  v_pph numeric := COALESCE(NEW.pph_amount,0);
  v_credit_total numeric;
  v_outstanding boolean := NEW.payment_method IS NULL OR NEW.payment_method='outstanding';
BEGIN
  IF NEW.expense_category <> 'import_broker' THEN RETURN NEW; END IF;

  -- Find the existing active journal (if any) so we can preserve its identity.
  SELECT id INTO v_je
    FROM public.journal_entries
   WHERE source_module IN ('expense','expenses')
     AND (reference_id = NEW.id OR reference_number = 'EXP-'||NEW.id::text)
     AND is_posted = true
     AND NOT COALESCE(is_reversed, false)
   ORDER BY created_at DESC, id DESC
   LIMIT 1;

  -- Delete old lines (header is reused or replaced in-place).
  IF v_je IS NOT NULL THEN
    DELETE FROM public.journal_entry_lines WHERE journal_entry_id = v_je;
  END IF;

  SELECT id INTO v_expense_account FROM public.chart_of_accounts WHERE code='5300' LIMIT 1;
  SELECT id INTO v_ppn_account      FROM public.chart_of_accounts WHERE code='1150' LIMIT 1;
  SELECT id INTO v_pph_account      FROM public.chart_of_accounts WHERE code='2132' LIMIT 1;
  SELECT id INTO v_stamp_account     FROM public.chart_of_accounts WHERE code='6950' LIMIT 1;
  SELECT id INTO v_ap_account        FROM public.chart_of_accounts WHERE code='2110' LIMIT 1;

  IF NEW.payment_method='cash' THEN
    SELECT id INTO v_cash_account FROM public.chart_of_accounts WHERE code='1101' LIMIT 1;
  ELSIF NEW.payment_method='petty_cash' THEN
    SELECT id INTO v_cash_account FROM public.chart_of_accounts WHERE code='1102' LIMIT 1;
  ELSIF NEW.payment_method='bank_transfer' AND NEW.bank_account_id IS NOT NULL THEN
    SELECT coa_id INTO v_cash_account FROM public.bank_accounts WHERE id=NEW.bank_account_id;
  ELSE
    SELECT id INTO v_cash_account FROM public.chart_of_accounts WHERE code='1101' LIMIT 1;
  END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(COALESCE(NEW.broker_items,'[]'::jsonb)) LOOP
    v_reimbursement := v_reimbursement + public.broker_reimbursement_line_total(v_item);
  END LOOP;

  v_expense_total := COALESCE(NEW.amount,0) + v_reimbursement + COALESCE(NEW.stamp_duty_amount,0);
  v_credit_total := v_expense_total;

  -- Upsert the journal header in place (preserves ID if v_je is not null).
  v_je := public.upsert_expense_journal_header_in_place(
    v_je, NEW.id, NEW.expense_date,
    COALESCE(NEW.description, 'Customs Broker Invoice'),
    'import_broker', v_credit_total, NEW.created_by
  );

  v_line_total := COALESCE(NEW.amount,0) - COALESCE(NEW.ppn_amount,0);
  IF v_line_total <> 0 THEN
    INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,description,debit,credit,supplier_id)
    VALUES(v_je,v_line_no,v_expense_account,'Broker service expense',v_line_total,0,NEW.supplier_id);
    v_line_no := v_line_no + 1;
  END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(COALESCE(NEW.broker_items,'[]'::jsonb)) LOOP
    v_supplier := COALESCE(NULLIF(v_item->>'supplier_id','')::uuid, NEW.supplier_id);
    v_line_total := public.broker_reimbursement_expense_base(v_item);
    IF v_line_total <> 0 THEN
      INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,description,debit,credit,supplier_id)
      VALUES(v_je,v_line_no,v_expense_account,'Reimbursement expense',v_line_total,0,v_supplier);
      v_line_no := v_line_no + 1;
    END IF;
  END LOOP;

  IF COALESCE(NEW.ppn_amount,0) > 0 THEN
    INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,description,debit,credit,supplier_id)
    VALUES(v_je,v_line_no,v_ppn_account,'Recoverable PPN - broker invoice',NEW.ppn_amount,0,NEW.supplier_id);
    v_line_no := v_line_no + 1;
  END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(COALESCE(NEW.broker_items,'[]'::jsonb)) LOOP
    v_supplier := COALESCE(NULLIF(v_item->>'supplier_id','')::uuid, NEW.supplier_id);
    v_line_ppn := COALESCE((v_item->>'ppn_amount')::numeric,0);
    IF v_line_ppn > 0 THEN
      INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,description,debit,credit,supplier_id)
      VALUES(v_je,v_line_no,v_ppn_account,'Recoverable PPN - reimbursement',v_line_ppn,0,v_supplier);
      v_line_no := v_line_no + 1;
    END IF;
  END LOOP;

  IF COALESCE(NEW.stamp_duty_amount,0) > 0 THEN
    INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,description,debit,credit,supplier_id)
    VALUES(v_je,v_line_no,v_stamp_account,'Stamp duty',NEW.stamp_duty_amount,0,NEW.supplier_id);
    v_line_no := v_line_no + 1;
  END IF;

  IF v_pph > 0 THEN
    INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,description,debit,credit,supplier_id)
    VALUES(v_je,v_line_no,v_pph_account,'PPh23 withheld',0,v_pph,NEW.supplier_id);
    v_line_no := v_line_no + 1;
  END IF;

  v_line_total := v_expense_total - v_pph;
  IF v_line_total <> 0 THEN
    INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,description,debit,credit,supplier_id)
    VALUES(v_je,v_line_no,
      CASE WHEN v_outstanding THEN v_ap_account ELSE v_cash_account END,
      CASE WHEN v_outstanding THEN 'Supplier payable - customs broker' ELSE 'Cash payment - customs broker' END,
      0, v_line_total, NEW.supplier_id);
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.post_customs_broker_canonical() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.post_customs_broker_canonical() TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
