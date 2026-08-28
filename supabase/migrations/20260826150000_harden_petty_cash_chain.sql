/* Petty Cash chain hardening.  Historical/legacy rows are observed only;
   accounting dates and amounts are never rewritten. */
BEGIN;

CREATE OR REPLACE FUNCTION public.validate_petty_cash_chain_integrity()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_ft public.fund_transfers%rowtype;
  v_je public.journal_entries%rowtype;
  v_pc_account uuid;
  v_pc_debit numeric := 0;
  v_pc_credit numeric := 0;
  v_expense_account uuid;
BEGIN
  IF NEW.fund_transfer_id IS NOT NULL THEN
    SELECT * INTO v_ft FROM public.fund_transfers WHERE id=NEW.fund_transfer_id FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Petty Cash % references missing fund transfer',NEW.id; END IF;
    IF NEW.transaction_type <> 'withdraw' OR v_ft.to_account_type <> 'petty_cash'
       OR abs(NEW.amount-COALESCE(v_ft.to_amount,v_ft.amount)) > 0.01 THEN
      RAISE EXCEPTION 'Petty Cash % amount/direction does not match Fund Transfer %',NEW.id,v_ft.transfer_number USING ERRCODE='check_violation';
    END IF;
  END IF;

  SELECT id INTO v_pc_account FROM public.chart_of_accounts WHERE code='1102' AND is_header=false AND is_active=true LIMIT 1;
  IF NEW.approval_status='approved' AND COALESCE(NEW.source,'') NOT LIKE 'historical_expense:%'
     AND NEW.transaction_type='expense' THEN
    SELECT je.* INTO v_je FROM public.journal_entries je
     WHERE je.source_module='petty_cash' AND je.reference_id=NEW.id AND je.is_posted AND NOT COALESCE(je.is_reversed,false);
    IF NOT FOUND THEN RAISE EXCEPTION 'Approved Petty Cash expense % has no active canonical journal',NEW.transaction_number; END IF;
    SELECT COALESCE(sum(l.debit),0),COALESCE(sum(l.credit),0) INTO v_pc_debit,v_pc_credit
      FROM public.journal_entry_lines l WHERE l.journal_entry_id=v_je.id AND l.account_id=v_pc_account;
    IF abs(v_pc_credit-NEW.amount)>0.01 OR v_pc_debit>0.01 THEN
      RAISE EXCEPTION 'Petty Cash expense % journal amount/direction mismatch',NEW.transaction_number USING ERRCODE='check_violation';
    END IF;
    v_expense_account:=public.get_expense_account_id(NEW.expense_category);
    IF NOT EXISTS (SELECT 1 FROM public.journal_entry_lines l WHERE l.journal_entry_id=v_je.id AND l.account_id=v_expense_account AND abs(l.debit-NEW.amount)<=0.01 AND l.credit=0) THEN
      RAISE EXCEPTION 'Petty Cash expense % journal account/category mismatch',NEW.transaction_number USING ERRCODE='check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_petty_cash_chain_integrity ON public.petty_cash_transactions;
CREATE CONSTRAINT TRIGGER trg_validate_petty_cash_chain_integrity
AFTER INSERT OR UPDATE OF amount,approval_status,transaction_type,expense_category,fund_transfer_id
ON public.petty_cash_transactions DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.validate_petty_cash_chain_integrity();

CREATE OR REPLACE FUNCTION public.validate_petty_cash_transfer_commit()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF NEW.status='posted' AND NEW.to_account_type='petty_cash'
     AND NOT EXISTS (SELECT 1 FROM public.petty_cash_transactions pc WHERE pc.fund_transfer_id=NEW.id) THEN
    RAISE EXCEPTION 'Posted Fund Transfer % to Petty Cash requires one canonical Petty Cash transaction',NEW.transfer_number USING ERRCODE='check_violation';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_validate_petty_cash_transfer_commit ON public.fund_transfers;
CREATE CONSTRAINT TRIGGER trg_validate_petty_cash_transfer_commit
AFTER INSERT OR UPDATE OF status,to_account_type,to_amount,amount
ON public.fund_transfers DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.validate_petty_cash_transfer_commit();

CREATE OR REPLACE FUNCTION public.validate_petty_cash_journal_reference()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF NEW.source_module='petty_cash' AND NEW.is_posted AND NEW.reference_id IS NULL THEN
    RAISE EXCEPTION 'Posted Petty Cash journal requires a canonical transaction reference' USING ERRCODE='check_violation';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_validate_petty_cash_journal_reference ON public.journal_entries;
CREATE TRIGGER trg_validate_petty_cash_journal_reference
BEFORE INSERT OR UPDATE OF source_module,reference_id,is_posted ON public.journal_entries
FOR EACH ROW EXECUTE FUNCTION public.validate_petty_cash_journal_reference();

COMMENT ON FUNCTION public.validate_petty_cash_chain_integrity() IS 'Deferred Petty Cash amount, direction, canonical journal and category guard; historical_expense rows are explicitly legacy.';
COMMENT ON FUNCTION public.validate_petty_cash_transfer_commit() IS 'Deferred guard requiring a canonical Petty Cash transaction for newly posted transfers into Petty Cash.';
NOTIFY pgrst,'reload schema';
COMMIT;
