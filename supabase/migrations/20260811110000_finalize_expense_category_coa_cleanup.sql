/*
  Final expense-category/COA cleanup.

  This migration is deliberately non-destructive: historical expense and
  journal rows are never changed. Legacy master rows are deactivated for new
  entry only, and an unused COA is deactivated only when it has no journal or
  active-category reference.
*/

-- Existing Utilities transactions retain their stored category and posted
-- journals. New entries choose the useful utility leaves grouped below.
UPDATE public.expense_categories
SET is_active = false, updated_at = now()
WHERE category_key = 'utilities' AND is_active;

UPDATE public.expense_categories AS child
SET parent_id = parent.id,
    sort_order = CASE child.category_key
      WHEN 'electricity' THEN 421
      WHEN 'water' THEN 422
      WHEN 'internet_phone' THEN 423
      ELSE child.sort_order
    END,
    updated_at = now()
FROM public.expense_categories AS parent
WHERE parent.category_key = 'utilities'
  AND child.category_key IN ('electricity', 'water', 'internet_phone');

-- Keep one clear category for each of these concepts. These aliases are only
-- deactivated when unused, retaining historical master data where necessary.
UPDATE public.expense_categories AS c
SET is_active = false, updated_at = now()
WHERE c.category_key IN (
  'duty', 'duty_import', 'freight', 'office',
  'legal_professional', 'consulting_fees', 'accounting_audit', 'rent'
)
  AND NOT EXISTS (SELECT 1 FROM public.finance_expenses e WHERE e.expense_category = c.category_key)
  AND NOT EXISTS (SELECT 1 FROM public.petty_cash_transactions p WHERE p.expense_category = c.category_key);

-- Fumigation/pest control is an operating service. Reuse the existing
-- Cleaning & Maintenance posting account; no tax or COA architecture is added.
INSERT INTO public.expense_categories (
  category_key, name, parent_id, category_type, tax_behavior, description,
  coa_account_id, is_posting_category, is_active, sort_order
)
SELECT
  'facility_maintenance', 'Cleaning & Maintenance', operations.id,
  'operations', 'standard',
  'Cleaning, maintenance, fumigation and pest-control services.',
  coa.id, true, true, 440
FROM public.expense_categories operations
JOIN public.chart_of_accounts coa
  ON coa.code = '6350' AND coa.is_active AND NOT coa.is_header
WHERE operations.category_key = 'operations'
  AND NOT EXISTS (SELECT 1 FROM public.expense_categories WHERE category_key = 'facility_maintenance');

-- These accounts only backed deactivated, unused aliases. Do not deactivate
-- either if it has historical journal use or an active category reference.
UPDATE public.chart_of_accounts AS coa
SET is_active = false
WHERE coa.code IN ('5400', '6200')
  AND coa.is_active
  AND NOT EXISTS (SELECT 1 FROM public.journal_entry_lines line WHERE line.account_id = coa.id)
  AND NOT EXISTS (
    SELECT 1 FROM public.expense_categories c
    WHERE c.coa_account_id = coa.id AND c.is_active AND c.is_posting_category
  );

-- Active posting categories must always remain valid posting destinations.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.expense_categories c
    LEFT JOIN public.chart_of_accounts coa ON coa.id = c.coa_account_id
    WHERE c.is_active AND c.is_posting_category
      AND (coa.id IS NULL OR NOT coa.is_active OR coa.is_header OR coa.account_type NOT IN ('expense', 'asset'))
  ) THEN
    RAISE EXCEPTION 'Active posting expense category has an invalid COA mapping';
  END IF;
END $$;
