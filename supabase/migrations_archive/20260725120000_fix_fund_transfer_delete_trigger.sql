/*
  Fix Contra deletion rollback.

  The finance-role trigger covers INSERT, UPDATE and DELETE. Its previous
  implementation always returned NEW; for DELETE operations NEW is NULL,
  which silently cancels the row deletion. The safe-delete RPC then correctly
  sees the fund transfer still present and raises its post-delete integrity
  error, rolling back the whole transaction.

  Keep the existing atomic delete_fund_transfer RPC and accounting rules. Only
  return OLD for DELETE so the RPC can remove the transfer after unlinking its
  journals, ledger lines, bank links and petty-cash projections.
*/

CREATE OR REPLACE FUNCTION public.enforce_fund_transfer_role()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public._sec_check_finance_role();

  IF TG_OP = 'INSERT' AND auth.role() <> 'service_role' THEN
    NEW.created_by := COALESCE(auth.uid(), NEW.created_by);
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_fund_transfer_role_ins ON public.fund_transfers;
CREATE TRIGGER trg_enforce_fund_transfer_role_ins
  BEFORE INSERT OR UPDATE OR DELETE ON public.fund_transfers
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_fund_transfer_role();

NOTIFY pgrst, 'reload schema';
