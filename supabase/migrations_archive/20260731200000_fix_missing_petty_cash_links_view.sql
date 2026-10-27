-- The integrity view must not classify pending documents or Fund Transfer
-- child withdrawals as missing Petty Cash journals.

BEGIN;

CREATE OR REPLACE VIEW public.missing_petty_cash_links AS
SELECT
  pct.id AS petty_cash_transaction_id,
  pct.transaction_number,
  pct.transaction_date,
  pct.amount,
  pct.transaction_type,
  pct.description,
  je.id AS journal_entry_id
FROM public.petty_cash_transactions pct
LEFT JOIN public.journal_entries je
  ON je.source_module = 'petty_cash'
 AND je.reference_id = pct.id
 AND je.is_posted = true
 AND COALESCE(je.is_reversed, false) = false
WHERE pct.approval_status = 'approved'
  AND pct.fund_transfer_id IS NULL
  AND je.id IS NULL;

ALTER VIEW public.missing_petty_cash_links SET (security_invoker = true);
REVOKE ALL ON public.missing_petty_cash_links FROM PUBLIC, anon;
GRANT SELECT ON public.missing_petty_cash_links TO authenticated, service_role;

COMMENT ON VIEW public.missing_petty_cash_links IS
'Approved standalone Petty Cash transactions that require, but do not have,
an active posted Petty Cash journal. Pending approvals and Fund Transfer child
withdrawals are intentionally excluded because they must not own duplicate
journals.';

NOTIFY pgrst, 'reload schema';

COMMIT;
