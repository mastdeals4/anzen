/* Reconcile Petty Cash by cash-movement dates and all valid legacy paths. */
BEGIN;
CREATE OR REPLACE FUNCTION public.get_petty_cash_balance_by_transaction_date(start_date date, end_date date)
RETURNS numeric LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
WITH events AS (
  SELECT pc.transaction_date movement_date, -pc.amount movement
  FROM public.petty_cash_transactions pc
  JOIN public.finance_expenses fe ON pc.source LIKE 'historical_expense:%' AND substring(pc.source from 20)::uuid = fe.id
  JOIN public.journal_entries je ON je.source_module='expenses' AND je.reference_id=fe.id AND je.is_posted AND NOT COALESCE(je.is_reversed,false)
  JOIN public.journal_entry_lines l ON l.journal_entry_id=je.id AND l.account_id=(SELECT id FROM public.chart_of_accounts WHERE code='1102' LIMIT 1) AND l.credit>0
  WHERE pc.approval_status='approved' AND abs(pc.amount-fe.amount)<=0.01
  UNION ALL
  SELECT pc.transaction_date, CASE WHEN pc.transaction_type='expense' THEN -pc.amount ELSE pc.amount END
  FROM public.petty_cash_transactions pc JOIN public.journal_entries je ON je.source_module='petty_cash' AND je.reference_id=pc.id AND je.is_posted AND NOT COALESCE(je.is_reversed,false)
  WHERE pc.approval_status='approved' AND COALESCE(pc.source,'') NOT LIKE 'historical_expense:%' AND pc.fund_transfer_id IS NULL
  UNION ALL
  SELECT ft.transfer_date, CASE WHEN ft.to_account_type='petty_cash' THEN ft.to_amount ELSE -ft.from_amount END
  FROM public.fund_transfers ft JOIN public.journal_entries je ON je.id=ft.journal_entry_id AND je.is_posted AND NOT COALESCE(je.is_reversed,false)
  WHERE ft.status='posted' AND (ft.to_account_type='petty_cash' OR ft.from_account_type='petty_cash')
)
SELECT COALESCE(sum(movement),0) FROM events WHERE movement_date BETWEEN start_date AND end_date;
$$;
COMMENT ON FUNCTION public.get_petty_cash_balance_by_transaction_date(date,date) IS 'Petty Cash balance by transaction/transfer date across canonical and verified legacy paths.';
NOTIFY pgrst,'reload schema';
COMMIT;
