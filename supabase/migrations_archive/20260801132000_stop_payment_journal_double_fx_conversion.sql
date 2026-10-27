-- post_payment_voucher already writes functional IDR debit/credit amounts and
-- per-line transaction currency metadata. The generic synchronizer must not
-- multiply mixed-currency bank and charge lines by the invoice FX rate again.
BEGIN;

CREATE OR REPLACE FUNCTION public.sync_payment_journal_currency()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public,pg_temp
AS $$
DECLARE
  v_invoice_currency text:=upper(COALESCE(NEW.invoice_currency,NEW.transaction_currency,NEW.currency_code,'IDR'));
  v_rate numeric:=COALESCE(NEW.exchange_rate,1);
BEGIN
  IF COALESCE(NEW.is_posted,false)=false OR NEW.journal_entry_id IS NULL THEN RETURN NEW; END IF;
  IF COALESCE(current_setting('app.finance_historical_repair',true),'off')='on' THEN RETURN NEW; END IF;
  IF v_invoice_currency NOT IN('IDR','USD') OR v_rate<=0 THEN
    RAISE EXCEPTION 'Posted payment has invalid currency metadata';
  END IF;

  -- The canonical poster owns the numerical amounts. Fill metadata only.
  UPDATE public.journal_entry_lines
     SET transaction_currency=COALESCE(transaction_currency,v_invoice_currency),
         transaction_debit=COALESCE(transaction_debit,
           CASE WHEN COALESCE(exchange_rate,1)>0 THEN debit/COALESCE(exchange_rate,1) ELSE debit END),
         transaction_credit=COALESCE(transaction_credit,
           CASE WHEN COALESCE(exchange_rate,1)>0 THEN credit/COALESCE(exchange_rate,1) ELSE credit END),
         functional_currency='IDR',
         exchange_rate=COALESCE(exchange_rate,CASE WHEN v_invoice_currency='USD' THEN v_rate ELSE 1 END)
   WHERE journal_entry_id=NEW.journal_entry_id;

  UPDATE public.journal_entries SET
    transaction_currency=v_invoice_currency,functional_currency='IDR',exchange_rate=v_rate,
    amounts_are_functional=true,
    total_debit=(SELECT COALESCE(sum(debit),0) FROM public.journal_entry_lines WHERE journal_entry_id=NEW.journal_entry_id),
    total_credit=(SELECT COALESCE(sum(credit),0) FROM public.journal_entry_lines WHERE journal_entry_id=NEW.journal_entry_id)
  WHERE id=NEW.journal_entry_id;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.sync_payment_journal_currency() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.sync_payment_journal_currency() TO service_role;
COMMIT;
