import { execFileSync } from 'node:child_process';

const testSql = `
BEGIN;

-- 1. Reverse duplicate journal entries
UPDATE journal_entries je
SET is_reversed = true,
    description = COALESCE(je.description, '') || ' [REVERSED: Duplicate of bank-reconciled finance expense]'
FROM petty_cash_transactions pct
WHERE je.source_module = 'petty_cash'
  AND je.reference_id = pct.id
  AND pct.transaction_number IN ('PCMIG-2507-0001', 'PCMIG-2509-0002', 'PCMIG-2510-0004')
  AND NOT COALESCE(je.is_reversed, false);

UPDATE petty_cash_transactions pct
SET approval_status = 'rejected',
    rejection_reason = CASE 
      WHEN pct.transaction_number = 'PCMIG-2507-0001' THEN 'Duplicate of bank-reconciled expense EXP/25/088'
      WHEN pct.transaction_number = 'PCMIG-2509-0002' THEN 'Duplicate of bank-reconciled expense EXP/25/130'
      WHEN pct.transaction_number = 'PCMIG-2510-0004' THEN 'Duplicate of bank-reconciled expense EXP/25/314'
    END,
    source = CASE 
      WHEN pct.transaction_number = 'PCMIG-2507-0001' THEN 'historical_expense:' || (SELECT id FROM finance_expenses WHERE voucher_number = 'EXP/25/088')
      WHEN pct.transaction_number = 'PCMIG-2509-0002' THEN 'historical_expense:' || (SELECT id FROM finance_expenses WHERE voucher_number = 'EXP/25/130')
      WHEN pct.transaction_number = 'PCMIG-2510-0004' THEN 'historical_expense:' || (SELECT id FROM finance_expenses WHERE voucher_number = 'EXP/25/314')
    END,
    voucher_number = CASE 
      WHEN pct.transaction_number = 'PCMIG-2507-0001' THEN 'EXP/25/088'
      WHEN pct.transaction_number = 'PCMIG-2509-0002' THEN 'EXP/25/130'
      WHEN pct.transaction_number = 'PCMIG-2510-0004' THEN 'EXP/25/314'
    END
WHERE pct.transaction_number IN ('PCMIG-2507-0001', 'PCMIG-2509-0002', 'PCMIG-2510-0004');

-- 2. Director/Owner items -> 2105
UPDATE journal_entry_lines jl
SET account_id = (SELECT id FROM chart_of_accounts WHERE code = '2105' LIMIT 1),
    description = COALESCE(jl.description, '') || ' [Reclassified from 1102 to 2105: Owner/Director out-of-pocket funding]'
FROM journal_entries je
JOIN petty_cash_transactions pct ON pct.id = je.reference_id
WHERE jl.journal_entry_id = je.id
  AND je.source_module = 'petty_cash'
  AND jl.account_id = (SELECT id FROM chart_of_accounts WHERE code = '1102' LIMIT 1)
  AND pct.transaction_number IN (
    'PCMIG-2506-0005', 'PCMIG-2506-0006', 'PCMIG-2506-0007', 'PCMIG-2506-0008',
    'PCMIG-2507-0002', 'PCMIG-2507-0003', 'PCMIG-2507-0004',
    'PCMIG-2508-0001', 'PCMIG-2508-0002',
    'PCMIG-2509-0001', 'PCMIG-2509-0003', 'PCMIG-2509-0004', 'PCMIG-2509-0005',
    'PCFIX-2510-0002', 'PCFIX-2510-0003'
  );

UPDATE petty_cash_transactions pct
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

-- 3. Staff Out-of-Pocket items -> 2120
UPDATE journal_entry_lines jl
SET account_id = (SELECT id FROM chart_of_accounts WHERE code = '2120' LIMIT 1),
    description = COALESCE(jl.description, '') || ' [Reclassified from 1102 to 2120: Staff out-of-pocket payable]'
FROM journal_entries je
JOIN petty_cash_transactions pct ON pct.id = je.reference_id
WHERE jl.journal_entry_id = je.id
  AND je.source_module = 'petty_cash'
  AND jl.account_id = (SELECT id FROM chart_of_accounts WHERE code = '1102' LIMIT 1)
  AND pct.transaction_number IN (
    'PCFIX-2506-0001', 'PCMIG-2506-0001', 'PCMIG-2506-0002', 'PCMIG-2506-0003',
    'PCMIG-2506-0004', 'PCMIG-2510-0001', 'PCMIG-2510-0003'
  );

UPDATE petty_cash_transactions pct
SET approval_status = 'rejected',
    rejection_reason = 'Reclassified to Accrued Expenses (2120) - Staff out-of-pocket payable',
    source = 'historical_expense:reclassified:' || pct.id
WHERE pct.transaction_number IN (
  'PCFIX-2506-0001', 'PCMIG-2506-0001', 'PCMIG-2506-0002', 'PCMIG-2506-0003',
  'PCMIG-2506-0004', 'PCMIG-2510-0001', 'PCMIG-2510-0003'
);

-- Complete Invariant Checks inside transaction
SELECT 
  (SELECT COALESCE(SUM(debit - credit), 0) FROM journal_entry_lines jl JOIN journal_entries je ON je.id = jl.journal_entry_id JOIN chart_of_accounts coa ON coa.id = jl.account_id WHERE coa.code = '1102' AND je.is_posted AND NOT COALESCE(je.is_reversed, false)) as gl_1102_balance,
  (SELECT current_balance FROM vw_petty_cash_balance) as vw_balance,
  (SELECT COALESCE(SUM(inflow - outflow), 0) FROM vw_petty_cash_statement) as statement_net,
  (SELECT count(*) FROM missing_petty_cash_links) as missing_links_count,
  (SELECT COALESCE(SUM(debit - credit), 0) FROM journal_entry_lines jl JOIN journal_entries je ON je.id = jl.journal_entry_id JOIN chart_of_accounts coa ON coa.id = jl.account_id WHERE coa.code = '1130' AND je.is_posted AND NOT COALESCE(je.is_reversed, false)) as gl_1130_inventory,
  (SELECT COALESCE(SUM(debit - credit), 0) FROM journal_entry_lines jl JOIN journal_entries je ON je.id = jl.journal_entry_id JOIN chart_of_accounts coa ON coa.id = jl.account_id WHERE coa.code = '5100' AND je.is_posted AND NOT COALESCE(je.is_reversed, false)) as gl_5100_cogs,
  (SELECT COALESCE(SUM(debit - credit), 0) FROM journal_entry_lines jl JOIN journal_entries je ON je.id = jl.journal_entry_id JOIN chart_of_accounts coa ON coa.id = jl.account_id WHERE coa.code = '111101' AND je.is_posted AND NOT COALESCE(je.is_reversed, false)) as gl_111101_bank;

ROLLBACK;
`;

const stdout = execFileSync('supabase', ['db', 'query', '--linked', '--output-format', 'json', testSql], {
  cwd: process.cwd(),
  encoding: 'utf8',
  maxBuffer: 50 * 1024 * 1024,
});
console.log('Complete Invariant Check Output:', stdout);
