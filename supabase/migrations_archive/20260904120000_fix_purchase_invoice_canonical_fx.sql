-- Make the canonical Purchase Invoice save RPC apply the PI accounting FX
-- exactly once. No historical rows are modified.
DO $migration$
DECLARE d text; old text; new text;
BEGIN
  SELECT pg_get_functiondef('public.save_purchase_invoice(uuid,jsonb,jsonb)'::regprocedure) INTO d;
  old := '    v_po_id             UUID;';
  new := old || E'\n    v_currency          TEXT;\n    v_rate              NUMERIC;';
  IF position(old IN d)=0 THEN RAISE EXCEPTION 'save_purchase_invoice declaration anchor not found'; END IF;
  d:=replace(d,old,new);
  old := '    v_po_id             := NULLIF(p_invoice_data->>''purchase_order_id'', '''')::UUID;';
  new := old || E'\n    v_currency := upper(coalesce(p_invoice_data->>''currency'', ''IDR''));\n    v_rate := CASE WHEN v_currency = ''IDR'' THEN 1 ELSE NULLIF((p_invoice_data->>''exchange_rate'')::NUMERIC, 0) END;\n    IF v_currency <> ''IDR'' AND (v_rate IS NULL OR v_rate <= 1) THEN\n      RAISE EXCEPTION ''Purchase invoice % requires a valid exchange rate greater than 1'', v_invoice_number;\n    END IF;';
  IF position(old IN d)=0 THEN RAISE EXCEPTION 'save_purchase_invoice currency anchor not found'; END IF;
  d:=replace(d,old,new);
  d:=replace(d,'        0, v_total_amount, TRUE, v_created_by, v_created_by','        0, v_total_amount * v_rate, TRUE, v_created_by, v_created_by');
  d:=replace(d,'          total_credit     = v_total_amount','          total_credit     = v_total_amount * v_rate');
  d:=replace(d,'          v_line_total, 0, v_supplier_id','          v_line_total * v_rate, 0, v_supplier_id');
  d:=replace(d,'        v_tax_amount, 0, v_supplier_id','        v_tax_amount * v_rate, 0, v_supplier_id');
  d:=replace(d,'        v_stamp_duty_amount, 0, v_supplier_id','        v_stamp_duty_amount * v_rate, 0, v_supplier_id');
  d:=replace(d,'      0, v_total_amount, v_supplier_id','      0, v_total_amount * v_rate, v_supplier_id');
  old := '    -- Reconcile JE totals from actual inserted lines';
  new := E'    UPDATE journal_entries SET transaction_currency=v_currency, functional_currency=''IDR'', exchange_rate=v_rate, amounts_are_functional=true WHERE id=v_je_id;\n    UPDATE journal_entry_lines SET transaction_currency=v_currency, exchange_rate=v_rate, transaction_debit=CASE WHEN debit>0 THEN round(debit / v_rate, 2) ELSE 0 END, transaction_credit=CASE WHEN credit>0 THEN round(credit / v_rate, 2) ELSE 0 END WHERE journal_entry_id=v_je_id;\n\n' || old;
  IF position(old IN d)=0 THEN RAISE EXCEPTION 'save_purchase_invoice totals anchor not found'; END IF;
  d:=replace(d,old,new);
  EXECUTE d;
END;
$migration$;

-- The wrapper previously multiplied journals after save. The canonical RPC now
-- owns conversion, so remove that duplicate conversion while retaining its
-- PO/item preservation behavior.
DO $migration$
DECLARE d text; old text;
BEGIN
  SELECT pg_get_functiondef('public.save_purchase_invoice_with_receiving_details(uuid,uuid,jsonb,jsonb)'::regprocedure) INTO d;
  old := $old$
  IF v_ccy='USD' AND coalesce(v_rate,0)>1 THEN
    UPDATE journal_entry_lines l SET transaction_currency='USD',functional_currency='IDR',exchange_rate=v_rate,transaction_debit=CASE WHEN l.debit>0 THEN round(l.debit,2) ELSE 0 END,transaction_credit=CASE WHEN l.credit>0 THEN round(l.credit,2) ELSE 0 END,debit=round(l.debit*v_rate,2),credit=round(l.credit*v_rate,2) FROM purchase_invoices p WHERE p.id=v_id AND l.journal_entry_id=p.journal_entry_id;
    UPDATE journal_entries j SET transaction_currency='USD',functional_currency='IDR',exchange_rate=v_rate,amounts_are_functional=true,total_debit=(SELECT coalesce(sum(debit),0) FROM journal_entry_lines WHERE journal_entry_id=j.id),total_credit=(SELECT coalesce(sum(credit),0) FROM journal_entry_lines WHERE journal_entry_id=j.id) WHERE j.id=(SELECT journal_entry_id FROM purchase_invoices WHERE id=v_id);
  END IF;$old$;
  IF position(old IN d)=0 THEN RAISE EXCEPTION 'Purchase Invoice wrapper conversion anchor not found'; END IF;
  d:=replace(d,old,'');
  EXECUTE d;
END;
$migration$;

NOTIFY pgrst, 'reload schema';
