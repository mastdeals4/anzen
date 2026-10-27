-- Repair only the explicitly identified PI journal after its source invoice
-- was corrected. The preconditions make this migration fail closed.
DO $repair$
DECLARE v_je uuid; v_rate numeric; v_total numeric; v_lines numeric;
BEGIN
  SELECT p.journal_entry_id,p.exchange_rate,p.total_amount INTO v_je,v_rate,v_total
    FROM purchase_invoices p WHERE p.invoice_number='E0000085/2627' AND p.currency='USD';
  IF v_je IS NULL OR v_rate <> 17750 OR v_total <> 41056.75 THEN
    RAISE EXCEPTION 'PI E0000085/2627 precondition failed';
  END IF;
  SELECT coalesce(sum(debit),0) INTO v_lines FROM journal_entry_lines WHERE journal_entry_id=v_je;
  IF v_lines <> 41056.75 THEN RAISE EXCEPTION 'JE-2606-0002 source lines precondition failed'; END IF;
  UPDATE journal_entry_lines SET
    transaction_currency='USD', functional_currency='IDR', exchange_rate=v_rate,
    transaction_debit=CASE WHEN debit>0 THEN debit ELSE 0 END,
    transaction_credit=CASE WHEN credit>0 THEN credit ELSE 0 END,
    debit=round(debit*v_rate,2), credit=round(credit*v_rate,2)
  WHERE journal_entry_id=v_je;
  UPDATE journal_entries SET transaction_currency='USD',functional_currency='IDR',exchange_rate=v_rate,amounts_are_functional=true,
    total_debit=(SELECT coalesce(sum(debit),0) FROM journal_entry_lines WHERE journal_entry_id=v_je),
    total_credit=(SELECT coalesce(sum(credit),0) FROM journal_entry_lines WHERE journal_entry_id=v_je)
  WHERE id=v_je;
END $repair$;
