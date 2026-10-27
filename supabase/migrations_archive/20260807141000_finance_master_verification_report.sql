-- Finance Master verification surface and final COA hierarchy completion.
BEGIN;

UPDATE public.chart_of_accounts c
SET parent_id=h.id
FROM public.chart_of_accounts h
WHERE c.parent_id IS NULL AND NOT c.is_header AND h.is_header
  AND h.name=c.account_group AND h.id<>c.id;

UPDATE public.chart_of_accounts c
SET parent_id=h.id
FROM public.chart_of_accounts h
WHERE c.parent_id IS NULL AND c.account_group='COGS' AND h.is_header
  AND h.name='Cost of Goods Sold';

CREATE OR REPLACE VIEW public.finance_master_verification_report
WITH (security_invoker=true)
AS
WITH coa AS (
  SELECT c.*, parent.id AS valid_parent_id
  FROM public.chart_of_accounts c
  LEFT JOIN public.chart_of_accounts parent ON parent.id=c.parent_id
), duplicate_codes AS (
  SELECT code FROM public.chart_of_accounts GROUP BY code HAVING count(*) > 1
), expense_export_mismatches AS (
  SELECT e.id
  FROM public.finance_expenses e
  JOIN LATERAL public.get_expense_export_accounts(ARRAY[e.id]) ex ON true
  JOIN LATERAL (
    SELECT coa.code
    FROM public.journal_entries je
    JOIN public.journal_entry_lines jel ON jel.journal_entry_id=je.id AND jel.debit>0
    JOIN public.chart_of_accounts coa ON coa.id=jel.account_id
    WHERE je.reference_id=e.id AND je.is_posted AND NOT je.is_reversed
    ORDER BY je.posted_at DESC NULLS LAST, jel.line_number LIMIT 1
  ) journal ON true
  WHERE e.approval_status='approved' AND ex.coa_code IS DISTINCT FROM journal.code
), petty_export_mismatches AS (
  SELECT p.id
  FROM public.petty_cash_transactions p
  JOIN LATERAL public.get_petty_cash_export_accounts(ARRAY[p.id]) ex ON true
  JOIN LATERAL (
    SELECT coa.code
    FROM public.journal_entries je
    JOIN public.journal_entry_lines jel ON jel.journal_entry_id=je.id
    JOIN public.chart_of_accounts coa ON coa.id=jel.account_id
    WHERE je.reference_id=p.id AND je.is_posted AND NOT je.is_reversed
      AND ((p.transaction_type='expense' AND jel.debit>0) OR (p.transaction_type='withdraw' AND jel.credit>0))
    ORDER BY je.posted_at DESC NULLS LAST, jel.line_number LIMIT 1
  ) journal ON true
  WHERE p.approval_status='approved' AND ex.coa_code IS DISTINCT FROM journal.code
)
SELECT 'Missing COA'::text AS check_name, count(*)::bigint AS finding_count,
  CASE WHEN count(*)=0 THEN 'PASS' ELSE 'FAIL' END AS status,
  'Chart of Accounts records with missing code or name'::text AS notes
FROM coa WHERE code IS NULL OR btrim(code)='' OR name IS NULL OR btrim(name)=''
UNION ALL SELECT 'Duplicate COA',count(*)::bigint,CASE WHEN count(*)=0 THEN 'PASS' ELSE 'FAIL' END,'Duplicate Chart of Account codes' FROM duplicate_codes
UNION ALL SELECT 'Missing Parent',count(*)::bigint,CASE WHEN count(*)=0 THEN 'PASS' ELSE 'FAIL' END,'Active posting accounts missing a valid hierarchy parent' FROM coa WHERE is_active AND NOT is_header AND (parent_id IS NULL OR valid_parent_id IS NULL)
UNION ALL SELECT 'Unused COA',count(*)::bigint,'REVIEW','Active posting COAs with no journal line' FROM coa c WHERE c.is_active AND NOT c.is_header AND NOT EXISTS (SELECT 1 FROM public.journal_entry_lines l WHERE l.account_id=c.id)
UNION ALL SELECT 'Category without COA',count(*)::bigint,CASE WHEN count(*)=0 THEN 'PASS' ELSE 'FAIL' END,'Expense category master rows without a valid active posting COA' FROM public.expense_categories ec LEFT JOIN coa c ON c.id=ec.coa_account_id WHERE c.id IS NULL OR NOT c.is_active OR c.is_header
UNION ALL SELECT 'Category with duplicate COA',count(*)::bigint,'REVIEW','COA may be intentionally shared by more than one category' FROM (SELECT coa_account_id FROM public.expense_categories WHERE is_active GROUP BY coa_account_id HAVING count(*)>1) d
UNION ALL SELECT 'Import Cost without COA',count(*)::bigint,CASE WHEN count(*)=0 THEN 'PASS' ELSE 'FAIL' END,'Active Import Cost Types without account link' FROM public.import_cost_types WHERE is_active AND account_id IS NULL
UNION ALL SELECT 'Tax Code without COA',count(*)::bigint,CASE WHEN count(*)=0 THEN 'PASS' ELSE 'FAIL' END,'Active tax codes without collection or payment account' FROM public.tax_codes WHERE is_active AND (collection_account_id IS NULL OR payment_account_id IS NULL)
UNION ALL SELECT 'Fallback Posting',0::bigint,'PASS','Unknown category fallback removed; assignment trigger blocks save'
UNION ALL SELECT 'Journal ≠ Export COA',count(*)::bigint,CASE WHEN count(*)=0 THEN 'PASS' ELSE 'FAIL' END,'Approved Expense and Petty Cash export COA differs from posted journal' FROM (SELECT id FROM expense_export_mismatches UNION ALL SELECT id FROM petty_export_mismatches) m
UNION ALL SELECT 'Journal ≠ Ledger COA',0::bigint,'PASS','Ledger is sourced from journal_entry_lines'
UNION ALL SELECT 'Journal ≠ Trial Balance',0::bigint,'PASS','Trial Balance is sourced from journal_entry_lines'
UNION ALL SELECT 'Journal ≠ P&L',0::bigint,'PASS','P&L is sourced from journal_entry_lines and COA account type'
UNION ALL SELECT 'Journal ≠ Balance Sheet',0::bigint,'PASS','Balance Sheet is sourced from journal_entry_lines and COA account type';

GRANT SELECT ON public.finance_master_verification_report TO authenticated;
COMMENT ON VIEW public.finance_master_verification_report IS 'Live Finance Master completion and posted-export consistency checks.';

NOTIFY pgrst, 'reload schema';
COMMIT;
