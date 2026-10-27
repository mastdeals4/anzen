-- Keep the existing dashboard's business explanation specific for the one
-- post-cutover manual exception. No source or accounting data is changed.
UPDATE public.finance_historical_repair_exceptions
SET reason =
      'Post-cutover USD-source Contra retains the retired functional-column FX posting method; accountant review is required'
WHERE document_type = 'fund_transfer'
  AND document_number = 'FT2601-0024'
  AND status = 'manual_review';

NOTIFY pgrst, 'reload schema';
