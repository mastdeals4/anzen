-- ==============================================================================
-- Migration: 20261102000000_enable_shipment_specific_ski_fee_capitalization.sql
-- Description: Enable Shipment-Specific BPOM / SKI Fee Landed Cost Capitalization
--   1. Whitelist 'bpom_ski_fees' in is_capitalizable_landed_cost_category
--   2. Update auto_post_expense_accounting to post to 1130 (Inventory) when
--      shipment-specific and included in landed cost, or 5410 (Operational) otherwise
--   3. Extend trigger_auto_post_expense_accounting_update to trigger on
--      include_in_landed_cost and import_container_id changes
--   4. Realign existing EXP/26/192 (CEFIXIME) journal from 5410 to 1130
--   5. Reallocate container E0000167/2627 and propagate batch XMAL260006 COGS
-- ==============================================================================

BEGIN;

-- 1. Whitelist bpom_ski_fees in is_capitalizable_landed_cost_category
CREATE OR REPLACE FUNCTION public.is_capitalizable_landed_cost_category(p_category text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT lower(replace(COALESCE(p_category, ''), ' ', '_')) IN (
    'duty_customs', 'duty', 'duty_import',
    'freight_import', 'freight', 'clearing_forwarding',
    'container_handling', 'loading_import', 'port_charges',
    'transport_import', 'import_broker', 'other_import',
    'pib_import',
    'bpom_ski_fees'   -- Shipment-specific SKI fees eligible for landed cost
  );
$$;

COMMENT ON FUNCTION public.is_capitalizable_landed_cost_category(text) IS
'Authoritative landed-cost capitalization whitelist.
 Includes bpom_ski_fees when linked to import container with include_in_landed_cost = true.
 PPN (1150) and PPh (1155) remain on balance-sheet tax accounts, never inventory.';

-- 2. Update auto_post_expense_accounting
CREATE OR REPLACE FUNCTION public.auto_post_expense_accounting()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_expense_account_id uuid;
  v_tax_benefit_account_id uuid;
  v_payment_account_id uuid;
  v_journal_id uuid;
  v_active_count integer;
  v_description text;
  v_credit_desc text;
  v_category_label text;
  v_bm_account_id uuid;
  v_ppn_account_id uuid;
  v_pph_account_id uuid;
  v_stamp_duty_account_id uuid;
  v_bank_charge_acc_id uuid;
  v_line_num integer;
  v_net_payment numeric(18,2);
  v_total numeric(18,2);
  v_bank_charges numeric(18,2);
  v_pph_treatment text;
BEGIN
  IF current_setting('app.finance_metadata_repair', true) = 'on' THEN
    RETURN NEW;
  END IF;

  IF NEW.approval_status <> 'approved' THEN RETURN NEW; END IF;

  IF TG_OP='UPDATE' AND OLD.approval_status='approved' THEN
    IF ROW(
      OLD.amount,OLD.expense_category,OLD.expense_date,OLD.description,
      OLD.payment_method,OLD.bank_account_id,OLD.pib_bm_amount,OLD.pib_ppn_amount,
      OLD.pib_pph_amount,OLD.ppn_amount,OLD.pph_amount,OLD.pph_code_id,
      COALESCE(OLD.pph_treatment,'deduct'),OLD.stamp_duty_amount,
      OLD.fixed_asset_account_id,COALESCE(OLD.bank_charges_amount,0),
      OLD.transaction_currency,OLD.exchange_rate,OLD.supplier_id,OLD.payee_id,
      OLD.include_in_landed_cost,OLD.import_container_id
    ) IS NOT DISTINCT FROM ROW(
      NEW.amount,NEW.expense_category,NEW.expense_date,NEW.description,
      NEW.payment_method,NEW.bank_account_id,NEW.pib_bm_amount,NEW.pib_ppn_amount,
      NEW.pib_pph_amount,NEW.ppn_amount,NEW.pph_amount,NEW.pph_code_id,
      COALESCE(NEW.pph_treatment,'deduct'),NEW.stamp_duty_amount,
      NEW.fixed_asset_account_id,COALESCE(NEW.bank_charges_amount,0),
      NEW.transaction_currency,NEW.exchange_rate,NEW.supplier_id,NEW.payee_id,
      NEW.include_in_landed_cost,NEW.import_container_id
    ) THEN
      RETURN NEW;
    END IF;
  END IF;

  SELECT count(*), (array_agg(id ORDER BY created_at DESC,id DESC))[1]
    INTO v_active_count,v_journal_id
    FROM public.journal_entries
   WHERE source_module IN('expense','expenses')
     AND (reference_id=NEW.id OR reference_number='EXP-'||NEW.id::text)
     AND is_posted=true AND NOT COALESCE(is_reversed,false);

  IF v_active_count>1 THEN
    RAISE EXCEPTION 'Expense % has multiple active journals; edit is blocked',NEW.id;
  END IF;
  IF TG_OP='UPDATE' AND OLD.approval_status='approved' AND v_active_count<>1 THEN
    RAISE EXCEPTION 'Approved expense % must have exactly one active journal before edit',NEW.id;
  END IF;
  IF v_journal_id IS NOT NULL THEN
    PERFORM 1 FROM public.journal_entries WHERE id=v_journal_id FOR UPDATE;
    DELETE FROM public.journal_entry_lines WHERE journal_entry_id=v_journal_id;
  END IF;

  IF NEW.payment_method='cash' THEN
    SELECT id INTO v_payment_account_id FROM public.chart_of_accounts WHERE code='1101' LIMIT 1;
  ELSIF NEW.payment_method='petty_cash' THEN
    SELECT id INTO v_payment_account_id FROM public.chart_of_accounts WHERE code='1102' LIMIT 1;
  ELSIF NEW.payment_method = 'bank_transfer' THEN
    SELECT id INTO v_payment_account_id FROM public.chart_of_accounts WHERE code='2110' LIMIT 1;
  ELSIF NEW.payment_method IS NOT NULL AND NEW.bank_account_id IS NOT NULL THEN
    SELECT coa_id INTO v_payment_account_id FROM public.bank_accounts WHERE id=NEW.bank_account_id;
  ELSIF NEW.payment_method IS NULL OR NEW.payment_method = 'outstanding' THEN
    SELECT id INTO v_payment_account_id FROM public.chart_of_accounts WHERE code='2110' LIMIT 1;
  END IF;
  IF v_payment_account_id IS NULL THEN
    RAISE EXCEPTION 'Cannot post expense %: the selected payment/AP account is not configured',NEW.id;
  END IF;

  IF NEW.expense_category='pib_import' THEN
    v_bm_account_id:=public.get_expense_account_id('duty_customs');
    v_ppn_account_id:=public.get_expense_account_id('ppn_import');
    v_pph_account_id:=public.get_expense_account_id('pph_import');
    IF COALESCE(NEW.pib_bm_amount,0)>0 AND v_bm_account_id IS NULL THEN RAISE EXCEPTION 'Import Duty account is missing'; END IF;
    IF COALESCE(NEW.pib_ppn_amount,0)>0 AND v_ppn_account_id IS NULL THEN RAISE EXCEPTION 'PPN Import account is missing'; END IF;
    IF COALESCE(NEW.pib_pph_amount,0)>0 AND v_pph_account_id IS NULL THEN RAISE EXCEPTION 'PPh Import account is missing'; END IF;
    v_total:=NEW.amount;
    v_journal_id:=public.upsert_expense_journal_header_in_place(
      v_journal_id,NEW.id,NEW.expense_date,COALESCE(NEW.description,'PIB Import Payment'),
      'pib_import',v_total,NEW.created_by);
    v_line_num:=1;
    IF COALESCE(NEW.pib_bm_amount,0)>0 THEN
      INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,debit,credit,description,supplier_id,payee_id)
      VALUES(v_journal_id,v_line_num,v_bm_account_id,NEW.pib_bm_amount,0,'Bea Masuk - '||COALESCE(NEW.description,'PIB'),NEW.supplier_id,NEW.payee_id);
      v_line_num:=v_line_num+1;
    END IF;
    IF COALESCE(NEW.pib_ppn_amount,0)>0 THEN
      INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,debit,credit,description,supplier_id,payee_id)
      VALUES(v_journal_id,v_line_num,v_ppn_account_id,NEW.ppn_amount,0,'PPN Import (Pajak Masukan) - '||COALESCE(NEW.description,'PIB'),NEW.supplier_id,NEW.payee_id);
      v_line_num:=v_line_num+1;
    END IF;
    IF COALESCE(NEW.pib_pph_amount,0)>0 THEN
      INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,debit,credit,description,supplier_id,payee_id)
      VALUES(v_journal_id,v_line_num,v_pph_account_id,NEW.pph_amount,0,'PPh 22 Import (Uang Muka Pajak) - '||COALESCE(NEW.description,'PIB'),NEW.supplier_id,NEW.payee_id);
      v_line_num:=v_line_num+1;
    END IF;
    INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,debit,credit,description,supplier_id,payee_id)
    VALUES(v_journal_id,v_line_num,v_payment_account_id,0,v_total,'Bank payment - '||COALESCE(NEW.description,'PIB Import Payment'),NEW.supplier_id,NEW.payee_id);
    RETURN NEW;
  END IF;

  -- AUTHORITATIVE POSTING ACCOUNT RESOLUTION:
  -- 1. bpom_ski_fees: 1130 (Inventory) if shipment-specific & included in landed cost; 5410 (Operational) otherwise.
  -- 2. other capitalizable: 1130 (Inventory) if include_in_landed_cost is not false; master COA otherwise.
  -- 3. non-capitalizable: master COA.
  v_expense_account_id := CASE 
    WHEN NEW.expense_category = 'bpom_ski_fees' THEN
      CASE 
        WHEN NEW.import_container_id IS NOT NULL AND NEW.include_in_landed_cost = true 
        THEN (SELECT id FROM public.chart_of_accounts WHERE code='1130' LIMIT 1)
        ELSE (SELECT id FROM public.chart_of_accounts WHERE code='5410' LIMIT 1)
      END
    WHEN public.is_capitalizable_landed_cost_category(NEW.expense_category) 
      AND (NEW.include_in_landed_cost IS NOT FALSE)
    THEN (SELECT id FROM public.chart_of_accounts WHERE code='1130' LIMIT 1)
    ELSE public.get_expense_account_id(NEW.expense_category) 
  END;

  IF v_expense_account_id IS NULL THEN RAISE EXCEPTION 'No expense account is mapped for %',NEW.expense_category; END IF;
  v_category_label:=initcap(replace(NEW.expense_category,'_',' '));
  v_description:=COALESCE(NEW.description,NEW.expense_category);
  v_credit_desc:=COALESCE(substring(NEW.description FROM '^[^\n\r]+'),NEW.expense_category)||' ['||v_category_label||']';
  
  SELECT id INTO v_ppn_account_id FROM public.chart_of_accounts WHERE code='1150' LIMIT 1;
  SELECT id INTO v_stamp_duty_account_id FROM public.chart_of_accounts WHERE code='6950' LIMIT 1;
  IF COALESCE(NEW.ppn_amount,0)>0 AND v_ppn_account_id IS NULL THEN RAISE EXCEPTION 'PPN Masukan account 1150 is missing'; END IF;
  IF COALESCE(NEW.stamp_duty_amount,0)>0 AND v_stamp_duty_account_id IS NULL THEN RAISE EXCEPTION 'Stamp Duty account 6950 is missing'; END IF;

  IF COALESCE(NEW.pph_amount, 0) > 0 THEN
    IF NEW.pph_code_id IS NULL THEN
      RAISE EXCEPTION 'Cannot post expense %: Withholding tax amount % exists but pph_code_id is NULL', 
        NEW.id, NEW.pph_amount;
    END IF;

    v_pph_account_id := public.fn_pph_payable_account_id(NEW.pph_code_id);

    IF v_pph_account_id IS NULL THEN
      RAISE EXCEPTION 'Cannot post expense %: Tax code % has no valid GL liability account configured', 
        NEW.id, NEW.pph_code_id;
    END IF;
  END IF;

  v_bank_charges:=COALESCE(NEW.bank_charges_amount,0);
  IF v_bank_charges>0 THEN
    v_bank_charge_acc_id:=public.get_expense_account_id('bank_charges');
    IF v_bank_charge_acc_id IS NULL THEN RAISE EXCEPTION 'Bank Charges account is missing'; END IF;
  END IF;

  v_pph_treatment := COALESCE(NEW.pph_treatment, 'deduct');

  IF v_pph_treatment = 'add' THEN
    v_net_payment := NEW.amount + COALESCE(NEW.ppn_amount,0) + COALESCE(NEW.stamp_duty_amount,0) + v_bank_charges;
    v_total := NEW.amount + COALESCE(NEW.ppn_amount,0) + COALESCE(NEW.stamp_duty_amount,0) + v_bank_charges + COALESCE(NEW.pph_amount,0);
  ELSE
    v_net_payment := NEW.amount + COALESCE(NEW.ppn_amount,0) - COALESCE(NEW.pph_amount,0) + COALESCE(NEW.stamp_duty_amount,0) + v_bank_charges;
    v_total := NEW.amount + COALESCE(NEW.ppn_amount,0) + COALESCE(NEW.stamp_duty_amount,0) + v_bank_charges;
  END IF;

  v_journal_id:=public.upsert_expense_journal_header_in_place(
    v_journal_id,NEW.id,NEW.expense_date,v_description,NEW.expense_category,v_total,NEW.created_by);
  v_line_num:=1;

  -- 1. Debit underlying expense/inventory
  INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,debit,credit,description,supplier_id,payee_id)
  VALUES(v_journal_id,v_line_num,v_expense_account_id,NEW.amount,0,v_description,NEW.supplier_id,NEW.payee_id);
  v_line_num:=v_line_num+1;

  -- 2. Debit PPN (if applicable)
  IF COALESCE(NEW.ppn_amount,0)>0 THEN
    INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,debit,credit,description,supplier_id,payee_id)
    VALUES(v_journal_id,v_line_num,v_ppn_account_id,NEW.ppn_amount,0,'PPN Masukan - '||v_description,NEW.supplier_id,NEW.payee_id);
    v_line_num:=v_line_num+1;
  END IF;

  -- 3. Debit Stamp duty (if applicable)
  IF COALESCE(NEW.stamp_duty_amount,0)>0 THEN
    INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,debit,credit,description,supplier_id,payee_id)
    VALUES(v_journal_id,v_line_num,v_stamp_duty_account_id,NEW.stamp_duty_amount,0,'Bea Meterai - '||v_description,NEW.supplier_id,NEW.payee_id);
    v_line_num:=v_line_num+1;
  END IF;

  -- 4. Debit Bank charges (if applicable)
  IF v_bank_charges>0 THEN
    INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,debit,credit,description,supplier_id,payee_id)
    VALUES(v_journal_id,v_line_num,v_bank_charge_acc_id,v_bank_charges,0,'Bank charges ['||v_category_label||']',NEW.supplier_id,NEW.payee_id);
    v_line_num:=v_line_num+1;
  END IF;

  -- 5. Add-on PPh Borne
  IF v_pph_treatment = 'add' AND COALESCE(NEW.pph_amount,0) > 0 THEN
    SELECT id INTO v_tax_benefit_account_id FROM public.chart_of_accounts WHERE code='6940' LIMIT 1;
    IF v_tax_benefit_account_id IS NULL THEN
      v_tax_benefit_account_id := v_expense_account_id;
    END IF;
    INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,debit,credit,description,supplier_id,payee_id)
    VALUES(v_journal_id,v_line_num,v_tax_benefit_account_id,NEW.pph_amount,0,'PPh Borne (Add-on) - '||v_description,NEW.supplier_id,NEW.payee_id);
    v_line_num:=v_line_num+1;
  END IF;

  -- 6. Credit PPh Withholding liability
  IF COALESCE(NEW.pph_amount,0)>0 THEN
    INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,debit,credit,description,supplier_id,payee_id)
    VALUES(v_journal_id,v_line_num,v_pph_account_id,0,NEW.pph_amount,'PPh Ditahan - '||v_description,NEW.supplier_id,NEW.payee_id);
    v_line_num:=v_line_num+1;
  END IF;

  -- 7. Credit Payment account / AP
  INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,debit,credit,description,supplier_id,payee_id)
  VALUES(v_journal_id,v_line_num,v_payment_account_id,0,v_net_payment,v_credit_desc,NEW.supplier_id,NEW.payee_id);

  RETURN NEW;
END;
$function$;

-- 3. Update trigger to react to include_in_landed_cost and import_container_id
DROP TRIGGER IF EXISTS trigger_auto_post_expense_accounting_update ON public.finance_expenses;
CREATE TRIGGER trigger_auto_post_expense_accounting_update AFTER UPDATE ON public.finance_expenses FOR EACH ROW WHEN (
  (new.approval_status = 'approved'::text) AND
  (new.expense_category <> 'import_broker'::text) AND
  (COALESCE(current_setting('app.finance_historical_repair'::text, true), 'off'::text) <> 'on'::text) AND (
    (old.approval_status IS DISTINCT FROM new.approval_status) OR
    (old.amount IS DISTINCT FROM new.amount) OR
    (old.expense_category IS DISTINCT FROM new.expense_category) OR
    ((old.payment_method)::text IS DISTINCT FROM (new.payment_method)::text) OR
    (old.bank_account_id IS DISTINCT FROM new.bank_account_id) OR
    (old.ppn_amount IS DISTINCT FROM new.ppn_amount) OR
    (old.pph_amount IS DISTINCT FROM new.pph_amount) OR
    (old.pph_code_id IS DISTINCT FROM new.pph_code_id) OR
    (old.pph_treatment IS DISTINCT FROM new.pph_treatment) OR
    (old.stamp_duty_amount IS DISTINCT FROM new.stamp_duty_amount) OR
    (old.bank_charges_amount IS DISTINCT FROM new.bank_charges_amount) OR
    (old.fixed_asset_account_id IS DISTINCT FROM new.fixed_asset_account_id) OR
    (old.broker_items IS DISTINCT FROM new.broker_items) OR
    (old.description IS DISTINCT FROM new.description) OR
    (old.expense_date IS DISTINCT FROM new.expense_date) OR
    (old.include_in_landed_cost IS DISTINCT FROM new.include_in_landed_cost) OR
    (old.import_container_id IS DISTINCT FROM new.import_container_id)
  )
) EXECUTE FUNCTION auto_post_expense_accounting();

-- 4. Realign existing EXP/26/192 (CEFIXIME) journal debit line from 5410 to 1130
UPDATE public.journal_entry_lines jel
   SET account_id = (SELECT id FROM public.chart_of_accounts WHERE code = '1130' LIMIT 1)
  FROM public.journal_entries je
 WHERE jel.journal_entry_id = je.id
   AND je.reference_id = '524167bf-3fd0-4215-a3b3-ca7a847f8912'
   AND jel.line_number = 1
   AND jel.account_id = (SELECT id FROM public.chart_of_accounts WHERE code = '5410' LIMIT 1);

-- 5. Reallocate container E0000167/2627 and propagate batch XMAL260006 COGS
SELECT public.reallocate_container_costs('d0967b1d-907f-4cd9-adb3-b3ea5c666a42'::uuid);

COMMIT;
