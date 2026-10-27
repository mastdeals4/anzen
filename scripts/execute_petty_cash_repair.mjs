import { execFileSync } from 'node:child_process';

const sql = `
BEGIN;

-- =========================================================================
-- HISTORICAL PETTY CASH FORENSIC REPAIR
-- End-to-end idempotent fix for the 25 historical pre-Nov 2025 transactions
-- =========================================================================

-- 1. Reverse the 3 PROVEN DUPLICATE journal entries (Rp 9,051,500)
-- PCMIG-2507-0001 (8,000,000) duplicate of EXP/25/088
-- PCMIG-2509-0002 (776,500) duplicate of EXP/25/130
-- PCMIG-2510-0004 (275,000) duplicate of EXP/25/314

UPDATE public.journal_entries je
SET is_reversed = true,
    description = COALESCE(je.description, '') || ' [REVERSED: Duplicate of bank-reconciled finance expense]'
FROM public.petty_cash_transactions pct
WHERE je.source_module = 'petty_cash'
  AND je.reference_id = pct.id
  AND pct.transaction_number IN ('PCMIG-2507-0001', 'PCMIG-2509-0002', 'PCMIG-2510-0004')
  AND NOT COALESCE(je.is_reversed, false);

-- Update the 3 duplicate petty cash transactions to link them and remove from active outflows
UPDATE public.petty_cash_transactions pct
SET approval_status = 'rejected',
    rejection_reason = CASE 
      WHEN pct.transaction_number = 'PCMIG-2507-0001' THEN 'Duplicate of bank-reconciled expense EXP/25/088'
      WHEN pct.transaction_number = 'PCMIG-2509-0002' THEN 'Duplicate of bank-reconciled expense EXP/25/130'
      WHEN pct.transaction_number = 'PCMIG-2510-0004' THEN 'Duplicate of bank-reconciled expense EXP/25/314'
    END,
    source = CASE 
      WHEN pct.transaction_number = 'PCMIG-2507-0001' THEN 'historical_expense:' || (SELECT id FROM public.finance_expenses WHERE voucher_number = 'EXP/25/088')
      WHEN pct.transaction_number = 'PCMIG-2509-0002' THEN 'historical_expense:' || (SELECT id FROM public.finance_expenses WHERE voucher_number = 'EXP/25/130')
      WHEN pct.transaction_number = 'PCMIG-2510-0004' THEN 'historical_expense:' || (SELECT id FROM public.finance_expenses WHERE voucher_number = 'EXP/25/314')
    END,
    voucher_number = CASE 
      WHEN pct.transaction_number = 'PCMIG-2507-0001' THEN 'EXP/25/088'
      WHEN pct.transaction_number = 'PCMIG-2509-0002' THEN 'EXP/25/130'
      WHEN pct.transaction_number = 'PCMIG-2510-0004' THEN 'EXP/25/314'
    END
WHERE pct.transaction_number IN ('PCMIG-2507-0001', 'PCMIG-2509-0002', 'PCMIG-2510-0004');

-- 2. Reclassify the 15 Director/Owner out-of-pocket transactions to 2105 (Rp 71,400,000)
UPDATE public.journal_entry_lines jl
SET account_id = (SELECT id FROM public.chart_of_accounts WHERE code = '2105' LIMIT 1),
    description = COALESCE(jl.description, '') || ' [Reclassified from 1102 to 2105: Owner/Director out-of-pocket funding]'
FROM public.journal_entries je
JOIN public.petty_cash_transactions pct ON pct.id = je.reference_id
WHERE jl.journal_entry_id = je.id
  AND je.source_module = 'petty_cash'
  AND jl.account_id = (SELECT id FROM public.chart_of_accounts WHERE code = '1102' LIMIT 1)
  AND pct.transaction_number IN (
    'PCMIG-2506-0005', 'PCMIG-2506-0006', 'PCMIG-2506-0007', 'PCMIG-2506-0008',
    'PCMIG-2507-0002', 'PCMIG-2507-0003', 'PCMIG-2507-0004',
    'PCMIG-2508-0001', 'PCMIG-2508-0002',
    'PCMIG-2509-0001', 'PCMIG-2509-0003', 'PCMIG-2509-0004', 'PCMIG-2509-0005',
    'PCFIX-2510-0002', 'PCFIX-2510-0003'
  );

UPDATE public.petty_cash_transactions pct
SET approval_status = 'rejected',
    rejection_reason = 'Reclassified to Director Loan (2105) - Owner out-of-pocket funding',
    source = 'historical_expense:reclassified:' || pct.id
WHERE pct.transaction_number IN (
  'PCMIG-2506-0005', 'PCMIG-2506-0006', 'PCMIG-2506-0007', 'PCMIG-2506-0008',
  'PCMIG-2507-0002', 'PCMIG-2507-0003', 'PCMIG-2507-0004',
  'PCMIG-2508-0001', 'PCMIG-2508-0002',
  'PCMIG-2509-0001', 'PCMIG-2509-0003', 'PCMIG-2509-0004', 'PCMIG-2509-0005',
  'PCFIX-2510-0002', 'PCFIX-2510-0003'
);

-- 3. Reclassify the 7 Staff Out-of-Pocket transactions to 2120 (Rp 5,979,500)
UPDATE public.journal_entry_lines jl
SET account_id = (SELECT id FROM public.chart_of_accounts WHERE code = '2120' LIMIT 1),
    description = COALESCE(jl.description, '') || ' [Reclassified from 1102 to 2120: Staff out-of-pocket payable]'
FROM public.journal_entries je
JOIN public.petty_cash_transactions pct ON pct.id = je.reference_id
WHERE jl.journal_entry_id = je.id
  AND je.source_module = 'petty_cash'
  AND jl.account_id = (SELECT id FROM public.chart_of_accounts WHERE code = '1102' LIMIT 1)
  AND pct.transaction_number IN (
    'PCFIX-2506-0001', 'PCMIG-2506-0001', 'PCMIG-2506-0002', 'PCMIG-2506-0003',
    'PCMIG-2506-0004', 'PCMIG-2510-0001', 'PCMIG-2510-0003'
  );

UPDATE public.petty_cash_transactions pct
SET approval_status = 'rejected',
    rejection_reason = 'Reclassified to Accrued Expenses (2120) - Staff out-of-pocket payable',
    source = 'historical_expense:reclassified:' || pct.id
WHERE pct.transaction_number IN (
  'PCFIX-2506-0001', 'PCMIG-2506-0001', 'PCMIG-2506-0002', 'PCMIG-2506-0003',
  'PCMIG-2506-0004', 'PCMIG-2510-0001', 'PCMIG-2510-0003'
);

COMMIT;
`;

console.log('Executing historical petty cash forensic repair on linked Supabase database...');
const stdout = execFileSync('supabase', ['db', 'query', '--linked', '--output-format', 'json', sql], {
  cwd: process.cwd(),
  encoding: 'utf8',
  maxBuffer: 50 * 1024 * 1024,
});
console.log('Repair output:', stdout);
