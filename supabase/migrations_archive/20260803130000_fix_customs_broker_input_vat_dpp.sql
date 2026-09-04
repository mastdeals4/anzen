-- Approved Customs Broker follow-up: preserve source-document DPP in the
-- journal-native Input VAT report without changing payable or posting logic.
-- PPN remains sourced from posted account 1150 journal lines.

BEGIN;

CREATE OR REPLACE VIEW public.vw_input_ppn_report AS
WITH tax_lines AS (
  SELECT je.id AS journal_id, je.entry_date, je.source_module, je.reference_id,
    je.reference_number, je.description, je.created_at, je.total_debit,
    SUM(jel.debit - jel.credit) AS ppn_amount
  FROM public.journal_entries je
  JOIN public.journal_entry_lines jel ON jel.journal_entry_id = je.id
  JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
  WHERE je.is_posted = true
    AND COALESCE(je.is_reversed, false) = false
    AND coa.code = '1150'
  GROUP BY je.id
  HAVING SUM(jel.debit - jel.credit) > 0
)
SELECT
  date_trunc('month', t.entry_date::timestamptz) AS month,
  t.entry_date AS expense_date,
  CASE
    WHEN t.source_module = 'purchase_invoice' THEN 'Purchase Invoice'
    WHEN fe.expense_category = 'pib_import' THEN 'PIB Import'
    WHEN fe.expense_category = 'ppn_import' THEN 'PPN Import (Legacy)'
    ELSE 'Supplier Invoice'
  END::text AS document_type,
  COALESCE(pi.invoice_number, fe.invoice_number, fe.voucher_number,
    t.reference_number, t.journal_id::text)::varchar AS reference,
  COALESCE(s.company_name, '-')::varchar AS supplier,
  COALESCE(s.npwp, '-')::varchar AS supplier_npwp,
  CASE
    WHEN fe.expense_category = 'import_broker' THEN
      COALESCE(fe.dpp_amount, 0)
      + COALESCE((
          SELECT SUM(COALESCE(NULLIF(item->>'dpp_amount', '')::numeric, 0))
          FROM jsonb_array_elements(COALESCE(fe.broker_items, '[]'::jsonb)) item
        ), 0)
    ELSE GREATEST(t.total_debit - t.ppn_amount, 0)
  END::numeric AS dpp_amount,
  t.ppn_amount::numeric AS ppn_amount,
  COALESCE(fe.description, pi.notes, t.description)::text AS description,
  t.created_at
FROM tax_lines t
LEFT JOIN public.finance_expenses fe
  ON t.source_module IN ('expense', 'expenses') AND fe.id = t.reference_id
LEFT JOIN public.purchase_invoices pi
  ON t.source_module = 'purchase_invoice' AND pi.id = t.reference_id
LEFT JOIN public.suppliers s ON s.id = COALESCE(fe.supplier_id, pi.supplier_id)
ORDER BY t.entry_date DESC;

COMMENT ON VIEW public.vw_input_ppn_report IS
  'Input PPN from active posted account 1150 journal lines. Customs Broker DPP uses stored header and reimbursement-line tax bases; DPP never affects payable.';

NOTIFY pgrst, 'reload schema';

COMMIT;
