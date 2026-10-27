-- Canonical metadata/read-path normalization only. No journal amount, date,
-- bank statement, petty-cash amount or source document is changed.
BEGIN;

CREATE TEMP TABLE ar_party_identity_repairs ON COMMIT DROP AS
SELECT l.id AS line_id,
       l.journal_entry_id,
       si.customer_id
  FROM public.journal_entry_lines l
  JOIN public.journal_entries j ON j.id = l.journal_entry_id
  JOIN public.chart_of_accounts coa ON coa.id = l.account_id AND coa.code = '1120'
  JOIN public.sales_invoices si
    ON si.id = j.reference_id OR si.invoice_number = j.reference_number
 WHERE j.is_posted
   AND NOT COALESCE(j.is_reversed, false)
   AND l.customer_id IS NULL
   AND si.customer_id IS NOT NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT line_id FROM ar_party_identity_repairs GROUP BY line_id HAVING count(*) <> 1
  ) THEN
    RAISE EXCEPTION 'Ambiguous customer identity for active Accounts Receivable line';
  END IF;
END $$;

UPDATE public.journal_entry_lines l
   SET customer_id = r.customer_id
  FROM ar_party_identity_repairs r
 WHERE l.id = r.line_id
   AND l.customer_id IS NULL;

INSERT INTO public.audit_logs(table_name, record_id, action_type, old_values, new_values)
SELECT 'journal_entry_lines',
       r.line_id,
       'update',
       jsonb_build_object('customer_id', NULL, 'journal_entry_id', r.journal_entry_id),
       jsonb_build_object('customer_id', r.customer_id, 'reason', 'canonical_invoice_customer_identity')
  FROM ar_party_identity_repairs r;

DO $$
DECLARE
  v_control numeric;
  v_subledger numeric;
BEGIN
  SELECT COALESCE(sum(l.debit - l.credit), 0)
    INTO v_control
    FROM public.journal_entry_lines l
    JOIN public.journal_entries j ON j.id = l.journal_entry_id
    JOIN public.chart_of_accounts coa ON coa.id = l.account_id
   WHERE coa.code = '1120' AND j.is_posted AND NOT COALESCE(j.is_reversed, false);
  SELECT COALESCE(sum(receivable_balance), 0)
    INTO v_subledger
    FROM public.customer_receivables_view;
  IF abs(v_control - v_subledger) > 0.01 THEN
    RAISE EXCEPTION 'AR customer normalization did not reconcile control % to subledger %',
      v_control, v_subledger;
  END IF;
END $$;

-- The legacy bridge is valid when its source expense owns the effective
-- petty-cash credit. Such rows participate in the canonical monthly petty-cash
-- resolver and must not also be reported as missing journals.
CREATE OR REPLACE VIEW public.missing_petty_cash_links AS
SELECT pct.id AS petty_cash_transaction_id,
       pct.transaction_number,
       pct.transaction_date,
       pct.amount,
       pct.transaction_type,
       pct.description,
       direct_journal.id AS journal_entry_id
  FROM public.petty_cash_transactions pct
  LEFT JOIN public.journal_entries direct_journal
    ON direct_journal.source_module = 'petty_cash'
   AND direct_journal.reference_id = pct.id
   AND direct_journal.is_posted
   AND NOT COALESCE(direct_journal.is_reversed, false)
 WHERE pct.approval_status = 'approved'
   AND pct.fund_transfer_id IS NULL
   AND direct_journal.id IS NULL
   AND NOT (
     COALESCE(pct.source, '') LIKE 'historical_expense:%'
     AND EXISTS (
       SELECT 1
         FROM public.finance_expenses fe
         JOIN public.effective_expense_posting_state eps
           ON eps.expense_id = fe.id
          AND eps.effective_posting_state IN ('ACTIVE', 'REPLACED')
         JOIN public.journal_entry_lines l
           ON l.journal_entry_id = eps.effective_journal_id
         JOIN public.chart_of_accounts coa
           ON coa.id = l.account_id AND coa.code = '1102'
        WHERE fe.id = substring(pct.source FROM 20)::uuid
          AND abs(fe.amount - pct.amount) <= 0.01
          AND l.credit > 0
     )
   );

ALTER VIEW public.missing_petty_cash_links SET (security_invoker = true);
GRANT SELECT ON public.missing_petty_cash_links TO authenticated;

NOTIFY pgrst, 'reload schema';
COMMIT;
