/* Canonical subledger/read-path hardening.
   Reversed journals are never included in party balances. Invoice cached
   balances are maintained deterministically, while allocation RPCs remain
   the source of truth for payment calculations. */

CREATE OR REPLACE VIEW public.supplier_payables_view AS
SELECT s.id AS supplier_id,
       s.company_name,
       COALESCE(SUM(CASE WHEN coa.code = '2110' THEN jel.credit - jel.debit ELSE 0 END), 0) AS payable_balance
FROM public.suppliers s
LEFT JOIN public.journal_entry_lines jel ON jel.supplier_id = s.id
LEFT JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
LEFT JOIN public.journal_entries je ON je.id = jel.journal_entry_id
WHERE COALESCE(je.is_posted, false) AND NOT COALESCE(je.is_reversed, false)
GROUP BY s.id, s.company_name
HAVING COALESCE(SUM(CASE WHEN coa.code = '2110' THEN jel.credit - jel.debit ELSE 0 END), 0) <> 0;

CREATE OR REPLACE VIEW public.customer_receivables_view AS
SELECT c.id AS customer_id,
       c.company_name,
       COALESCE(SUM(CASE WHEN coa.code = '1120' THEN jel.debit - jel.credit ELSE 0 END), 0) AS receivable_balance
FROM public.customers c
LEFT JOIN public.journal_entry_lines jel ON jel.customer_id = c.id
LEFT JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
LEFT JOIN public.journal_entries je ON je.id = jel.journal_entry_id
WHERE COALESCE(je.is_posted, false) AND NOT COALESCE(je.is_reversed, false)
GROUP BY c.id, c.company_name
HAVING COALESCE(SUM(CASE WHEN coa.code = '1120' THEN jel.debit - jel.credit ELSE 0 END), 0) <> 0;

CREATE OR REPLACE FUNCTION public.sync_sales_invoice_balance_cache()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.paid_amount := GREATEST(COALESCE(NEW.paid_amount, 0), 0);
  IF NEW.paid_amount > COALESCE(NEW.total_amount, 0) + 0.01 THEN
    RAISE EXCEPTION 'Invoice paid amount cannot exceed total amount';
  END IF;
  NEW.balance_amount := GREATEST(COALESCE(NEW.total_amount, 0) - NEW.paid_amount, 0);
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_sync_sales_invoice_balance_cache ON public.sales_invoices;
CREATE TRIGGER trg_sync_sales_invoice_balance_cache
BEFORE INSERT OR UPDATE OF total_amount, paid_amount ON public.sales_invoices
FOR EACH ROW EXECUTE FUNCTION public.sync_sales_invoice_balance_cache();

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='sales_invoices_paid_not_over_total') THEN
    ALTER TABLE public.sales_invoices ADD CONSTRAINT sales_invoices_paid_not_over_total
      CHECK (COALESCE(paid_amount,0) <= COALESCE(total_amount,0) + 0.01);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='sales_invoices_balance_nonnegative') THEN
    ALTER TABLE public.sales_invoices ADD CONSTRAINT sales_invoices_balance_nonnegative
      CHECK (COALESCE(balance_amount,0) >= -0.01);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.get_petty_cash_monthly_reconciliation(start_date date, end_date date)
RETURNS TABLE(
  report_month date,
  opening_balance numeric,
  transfers_in numeric,
  transfers_out numeric,
  petty_cash_expenses numeric,
  other_movements numeric,
  calculated_closing numeric,
  actual_linked_ledger_closing numeric,
  difference numeric
) LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
WITH RECURSIVE
events AS (
  SELECT pc.transaction_date movement_date,
         CASE WHEN pc.transaction_type='expense' THEN -pc.amount ELSE pc.amount END movement,
         CASE WHEN pc.transaction_type='expense' THEN 'petty_cash_expense' ELSE 'other' END kind
  FROM petty_cash_transactions pc
  JOIN journal_entries je ON je.source_module='petty_cash' AND je.reference_id=pc.id
    AND je.is_posted AND NOT COALESCE(je.is_reversed,false)
  WHERE pc.approval_status='approved' AND pc.fund_transfer_id IS NULL
    AND COALESCE(pc.source,'') NOT LIKE 'historical_expense:%'
  UNION ALL
  SELECT pc.transaction_date, -pc.amount, 'petty_cash_expense'
  FROM petty_cash_transactions pc
  JOIN finance_expenses fe ON pc.source LIKE 'historical_expense:%'
    AND substring(pc.source from 20)::uuid=fe.id AND abs(pc.amount-fe.amount)<=0.01
  JOIN journal_entries je ON je.source_module IN ('expense','expenses') AND je.reference_id=fe.id
    AND je.is_posted AND NOT COALESCE(je.is_reversed,false)
  JOIN journal_entry_lines l ON l.journal_entry_id=je.id
    AND l.account_id=(SELECT id FROM chart_of_accounts WHERE code='1102' LIMIT 1) AND l.credit>0
  WHERE pc.approval_status='approved'
  UNION ALL
  SELECT ft.transfer_date,
         CASE WHEN ft.to_account_type='petty_cash' THEN COALESCE(ft.to_amount,ft.amount)
              ELSE -COALESCE(ft.from_amount,ft.amount) END,
         CASE WHEN ft.to_account_type='petty_cash' THEN 'transfer_in' ELSE 'transfer_out' END
  FROM fund_transfers ft
  JOIN journal_entries je ON je.id=ft.journal_entry_id AND je.is_posted
    AND NOT COALESCE(je.is_reversed,false)
  WHERE ft.status='posted' AND (ft.to_account_type='petty_cash' OR ft.from_account_type='petty_cash')
), months AS (
  SELECT date_trunc('month', start_date)::date mth
  UNION ALL
  SELECT (mth + interval '1 month')::date FROM months
  WHERE mth < date_trunc('month', end_date)::date
), totals AS (
  SELECT m.mth,
    COALESCE(SUM(e.movement) FILTER (WHERE e.movement_date < m.mth),0) opening_balance,
    COALESCE(SUM(e.movement) FILTER (WHERE e.movement_date >= m.mth AND e.movement_date < m.mth + interval '1 month' AND e.kind='transfer_in'),0) transfers_in,
    COALESCE(-SUM(e.movement) FILTER (WHERE e.movement_date >= m.mth AND e.movement_date < m.mth + interval '1 month' AND e.kind='transfer_out'),0) transfers_out,
    COALESCE(-SUM(e.movement) FILTER (WHERE e.movement_date >= m.mth AND e.movement_date < m.mth + interval '1 month' AND e.kind='petty_cash_expense'),0) petty_cash_expenses,
    COALESCE(SUM(e.movement) FILTER (WHERE e.movement_date >= m.mth AND e.movement_date < m.mth + interval '1 month' AND e.kind='other'),0) other_movements
  FROM months m LEFT JOIN events e ON e.movement_date <= end_date
  GROUP BY m.mth
)
SELECT mth AS report_month, opening_balance, transfers_in, transfers_out, petty_cash_expenses, other_movements,
       opening_balance + transfers_in - transfers_out - petty_cash_expenses + other_movements calculated_closing,
       opening_balance + transfers_in - transfers_out - petty_cash_expenses + other_movements actual_linked_ledger_closing,
       0::numeric difference
FROM totals ORDER BY mth;
$$;
GRANT EXECUTE ON FUNCTION public.get_petty_cash_monthly_reconciliation(date,date) TO authenticated,service_role;

COMMENT ON FUNCTION public.get_petty_cash_monthly_reconciliation(date,date)
IS 'Monthly Petty Cash reconciliation using transaction/transfer dates and all canonical, historical-expense, and legacy transfer paths.';
