-- Salary advance issuance uses Staff Advances / Loans (1160), not AP.
DO $salary$
DECLARE v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p
   WHERE p.proname='post_payment_voucher' AND pg_get_function_identity_arguments(p.oid)='p_pv_id uuid, p_posted_by uuid';
  IF v_def IS NULL THEN RAISE EXCEPTION 'post_payment_voucher function not found'; END IF;
  v_def := replace(v_def,
    $$IF v_pv.payment_method = 'advance_adjustment' THEN$$,
    $$IF v_pv.payment_method = 'advance_adjustment' OR v_pv.payment_purpose = 'salary_advance' THEN$$);
  EXECUTE v_def;
END $salary$;

-- Ensure the actual UI save wrapper converts non-IDR PI journals after the
-- canonical save RPC creates/rebuilds them. Existing IDR behavior is unchanged.
CREATE OR REPLACE FUNCTION public.save_purchase_invoice_with_receiving_details(
  p_invoice_id uuid, p_purchase_order_id uuid, p_invoice_data jsonb, p_items jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_data jsonb:=coalesce(p_invoice_data,'{}'::jsonb); v_items jsonb:='[]'::jsonb; v_item jsonb; v_old public.purchase_invoice_items%rowtype; v_po uuid; v_result jsonb; v_id uuid; v_rate numeric; v_ccy text;
BEGIN
  IF p_invoice_id IS NOT NULL AND nullif(v_data->>'purchase_order_id','') IS NULL THEN SELECT purchase_order_id INTO v_po FROM purchase_invoices WHERE id=p_invoice_id; IF v_po IS NOT NULL THEN v_data:=jsonb_set(v_data,'{purchase_order_id}',to_jsonb(v_po),true); END IF; ELSIF p_invoice_id IS NULL AND p_purchase_order_id IS NOT NULL AND nullif(v_data->>'purchase_order_id','') IS NULL THEN v_data:=jsonb_set(v_data,'{purchase_order_id}',to_jsonb(p_purchase_order_id),true); END IF;
  FOR v_item IN SELECT value FROM jsonb_array_elements(coalesce(p_items,'[]'::jsonb)) LOOP
    IF p_invoice_id IS NOT NULL AND nullif(v_item->>'id','') IS NOT NULL THEN SELECT * INTO v_old FROM purchase_invoice_items WHERE id=(v_item->>'id')::uuid AND purchase_invoice_id=p_invoice_id; IF FOUND THEN
      IF nullif(v_item->>'purchase_order_item_id','') IS NULL AND v_old.purchase_order_item_id IS NOT NULL THEN v_item:=jsonb_set(v_item,'{purchase_order_item_id}',to_jsonb(v_old.purchase_order_item_id),true); END IF;
      IF nullif(v_item->>'receiving_make_id','') IS NULL AND v_old.receiving_make_id IS NOT NULL THEN v_item:=jsonb_set(v_item,'{receiving_make_id}',to_jsonb(v_old.receiving_make_id),true); END IF;
      IF nullif(v_item->>'receiving_batch_number','') IS NULL AND v_old.receiving_batch_number IS NOT NULL THEN v_item:=jsonb_set(v_item,'{receiving_batch_number}',to_jsonb(v_old.receiving_batch_number),true); END IF;
      IF nullif(v_item->>'receiving_expiry_date','') IS NULL AND v_old.receiving_expiry_date IS NOT NULL THEN v_item:=jsonb_set(v_item,'{receiving_expiry_date}',to_jsonb(v_old.receiving_expiry_date),true); END IF;
      IF nullif(v_item->>'receiving_import_container_id','') IS NULL AND v_old.receiving_import_container_id IS NOT NULL THEN v_item:=jsonb_set(v_item,'{receiving_import_container_id}',to_jsonb(v_old.receiving_import_container_id),true); END IF;
      IF nullif(v_item->>'receiving_notes','') IS NULL AND v_old.receiving_notes IS NOT NULL THEN v_item:=jsonb_set(v_item,'{receiving_notes}',to_jsonb(v_old.receiving_notes),true); END IF;
    END IF; END IF; v_items:=v_items||jsonb_build_array(v_item);
  END LOOP;
  v_result:=CASE WHEN p_invoice_id IS NOT NULL THEN save_purchase_invoice(p_invoice_id,v_data,v_items) WHEN p_purchase_order_id IS NOT NULL THEN create_purchase_invoice_from_po(p_purchase_order_id,v_data,v_items) ELSE save_purchase_invoice(NULL,v_data,v_items) END;
  v_id:=(v_result->>'invoice_id')::uuid; SELECT upper(currency),exchange_rate INTO v_ccy,v_rate FROM purchase_invoices WHERE id=v_id;
  IF v_ccy='USD' AND coalesce(v_rate,0)>1 THEN
    UPDATE journal_entry_lines l SET transaction_currency='USD',functional_currency='IDR',exchange_rate=v_rate,transaction_debit=CASE WHEN l.debit>0 THEN round(l.debit,2) ELSE 0 END,transaction_credit=CASE WHEN l.credit>0 THEN round(l.credit,2) ELSE 0 END,debit=round(l.debit*v_rate,2),credit=round(l.credit*v_rate,2) FROM purchase_invoices p WHERE p.id=v_id AND l.journal_entry_id=p.journal_entry_id;
    UPDATE journal_entries j SET transaction_currency='USD',functional_currency='IDR',exchange_rate=v_rate,amounts_are_functional=true,total_debit=(SELECT coalesce(sum(debit),0) FROM journal_entry_lines WHERE journal_entry_id=j.id),total_credit=(SELECT coalesce(sum(credit),0) FROM journal_entry_lines WHERE journal_entry_id=j.id) WHERE j.id=(SELECT journal_entry_id FROM purchase_invoices WHERE id=v_id);
  END IF; RETURN v_result;
END; $$;
