import { execSync } from "child_process";
import fs from "fs";

function queryDb(sql) {
  const cleanSql = sql.replace(/\n/g, " ").replace(/"/g, '\\"');
  const res = execSync(`npx supabase db query --linked -o json "${cleanSql}"`, {
    encoding: "utf8",
    maxBuffer: 30 * 1024 * 1024
  });
  return JSON.parse(res).rows || [];
}

console.log("Starting Forensic Audit queries...");

// 1. Bank Accounts Audit
const bankAccountsSql = `
SELECT 
  ba.id,
  ba.account_name,
  ba.bank_name,
  ba.account_number,
  ba.currency,
  coa.code AS coa_code,
  ba.opening_balance,
  ba.current_balance,
  public.calculate_bank_account_book_balance(ba.id, '2026-09-10') AS book_balance_10sep,
  public.calculate_bank_account_book_balance(ba.id, CURRENT_DATE) AS book_balance_current,
  (SELECT MAX(transaction_date) FROM bank_statement_lines WHERE bank_account_id = ba.id) AS latest_statement_date,
  (SELECT MAX(je.entry_date) FROM journal_entry_lines jel JOIN journal_entries je ON je.id = jel.journal_entry_id WHERE jel.account_id = ba.coa_id AND je.is_posted = true) AS latest_posted_journal_date,
  (SELECT COALESCE(SUM(credit_amount - debit_amount), 0) FROM bank_statement_lines WHERE bank_account_id = ba.id AND transaction_date <= '2026-09-10') AS net_statement_10sep,
  (SELECT COALESCE(SUM(credit_amount - debit_amount), 0) FROM bank_statement_lines WHERE bank_account_id = ba.id) AS net_statement_all
FROM bank_accounts ba
LEFT JOIN chart_of_accounts coa ON coa.id = ba.coa_id
ORDER BY ba.currency DESC;
`;
const bankAccounts = queryDb(bankAccountsSql);

// 2. Reversals Audit
const reversalsSql = `
SELECT 
  je.id,
  je.entry_number,
  je.entry_date,
  je.is_posted,
  je.is_reversed,
  je.reversed_by_id,
  je.source_module,
  je.description,
  jel.account_id,
  coa.code AS coa_code,
  jel.debit,
  jel.credit
FROM journal_entries je
JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
JOIN chart_of_accounts coa ON coa.id = jel.account_id
WHERE coa.code IN ('111101', '111102')
  AND (
    je.is_reversed = true 
    OR je.reversed_by_id IS NOT NULL
    OR je.source_module LIKE '%revers%'
    OR je.entry_number IN ('JE2606-0120', 'JE2608-0168')
    OR je.description ILIKE '%revers%'
  )
ORDER BY je.entry_date, je.entry_number;
`;
const reversals = queryDb(reversalsSql);

// 3. Known EXP/26/239 Audit
const exp239Sql = `
SELECT 
  fe.id,
  fe.voucher_number,
  fe.expense_date,
  fe.amount,
  fe.ppn_amount,
  fe.pph_amount,
  fe.approval_status,
  fe.paid_amount,
  fe.settlement_amount,
  fe.payment_method
FROM finance_expenses fe
WHERE fe.id = '72be55fd-f275-41ec-9549-03ae91f2ff06' OR fe.voucher_number = 'EXP/26/239';
`;
const exp239 = queryDb(exp239Sql);

const exp239JournalsSql = `
SELECT 
  je.id,
  je.entry_number,
  je.entry_date,
  je.source_module,
  je.reference_number,
  je.reference_id,
  je.is_posted,
  je.is_reversed,
  je.created_at,
  jel.line_number,
  coa.code AS coa_code,
  coa.name AS coa_name,
  jel.debit,
  jel.credit
FROM journal_entries je
JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
JOIN chart_of_accounts coa ON coa.id = jel.account_id
WHERE je.entry_number IN ('JE2609-0133', 'JE2609-0134', 'JE2609-0135', 'JE2609-0136')
   OR je.reference_id = '72be55fd-f275-41ec-9549-03ae91f2ff06'
   OR je.description ILIKE '%EXP/26/239%'
ORDER BY je.entry_number, jel.line_number;
`;
const exp239Journals = queryDb(exp239JournalsSql);

const exp239AllocationsSql = `
SELECT 
  va.id AS va_id,
  va.payment_voucher_id,
  pv.voucher_number AS pv_number,
  pv.voucher_date AS pv_date,
  pv.amount AS pv_amount,
  pv.is_posted AS pv_is_posted,
  va.allocated_amount,
  va.payment_kind
FROM voucher_allocations va
JOIN payment_vouchers pv ON pv.id = va.payment_voucher_id
WHERE va.finance_expense_id = '72be55fd-f275-41ec-9549-03ae91f2ff06';
`;
const exp239Allocations = queryDb(exp239AllocationsSql);

const exp239BankAllocationsSql = `
SELECT 
  bsa.id,
  bsa.bank_statement_line_id,
  bsl.transaction_date,
  bsl.description AS bsl_desc,
  bsl.debit_amount,
  bsl.credit_amount,
  bsa.allocation_amount,
  bsa.document_type,
  bsa.document_id,
  bsa.journal_entry_id,
  bsa.payment_kind
FROM bank_statement_allocations bsa
JOIN bank_statement_lines bsl ON bsl.id = bsa.bank_statement_line_id
WHERE bsa.document_id = '72be55fd-f275-41ec-9549-03ae91f2ff06'
   OR bsl.matched_expense_id = '72be55fd-f275-41ec-9549-03ae91f2ff06';
`;
const exp239BankAllocations = queryDb(exp239BankAllocationsSql);

// 4. Five False Matches Audit
const fiveLinesSql = `
SELECT 
  bsl.id,
  bsl.transaction_date,
  bsl.description,
  bsl.debit_amount,
  bsl.credit_amount,
  bsl.currency,
  bsl.payment_kind,
  bsl.reconciliation_status,
  bsl.matching_status,
  bsl.matched_entry_id,
  bsl.matched_expense_id,
  bsl.matched_receipt_id,
  bsl.matched_payment_id,
  bsl.matched_fund_transfer_id,
  bsl.matched_petty_cash_id,
  bsl.matched_tax_payment_id,
  bsl.matched_at,
  (
    SELECT jsonb_agg(jsonb_build_object(
      'allocation_id', bsa.id,
      'document_type', bsa.document_type,
      'document_id', bsa.document_id,
      'journal_entry_id', bsa.journal_entry_id,
      'allocation_amount', bsa.allocation_amount,
      'payment_kind', bsa.payment_kind
    ))
    FROM bank_statement_allocations bsa
    WHERE bsa.bank_statement_line_id = bsl.id
  ) AS allocations
FROM bank_statement_lines bsl
WHERE (bsl.transaction_date = '2026-02-20' AND bsl.debit_amount = 3651500)
   OR (bsl.transaction_date = '2026-08-07' AND bsl.debit_amount = 28898697)
   OR (bsl.transaction_date = '2026-08-31' AND bsl.debit_amount = 80000)
   OR (bsl.transaction_date = '2026-08-31' AND bsl.debit_amount = 9750000)
   OR (bsl.transaction_date = '2026-09-08' AND bsl.debit_amount = 10649560)
ORDER BY bsl.transaction_date;
`;
const fiveLines = queryDb(fiveLinesSql);

// 5. Globelink Issue Audit
const globelinkSql = `
SELECT 
  bsl.id AS bsl_id,
  bsl.transaction_date,
  bsl.description AS bsl_desc,
  bsl.debit_amount,
  bsl.credit_amount,
  bsl.reconciliation_status,
  bsl.matching_status,
  bsl.matched_entry_id,
  bsl.matched_expense_id,
  bsa.id AS bsa_id,
  bsa.document_type,
  bsa.document_id,
  bsa.allocation_amount,
  bsa.journal_entry_id,
  fe.id AS expense_id,
  fe.voucher_number AS expense_voucher,
  fe.amount AS expense_amount,
  fe.paid_amount,
  fe.settlement_amount
FROM bank_statement_lines bsl
LEFT JOIN bank_statement_allocations bsa ON bsa.bank_statement_line_id = bsl.id
LEFT JOIN finance_expenses fe ON fe.id = bsa.document_id OR fe.id = bsl.matched_expense_id
WHERE bsl.transaction_date = '2026-06-17' AND bsl.debit_amount = 11211444;
`;
const globelink = queryDb(globelinkSql);

const globelinkJeSql = `
SELECT 
  je.id,
  je.entry_number,
  je.entry_date,
  je.source_module,
  je.description,
  jel.line_number,
  coa.code AS coa_code,
  coa.name AS coa_name,
  jel.debit,
  jel.credit
FROM journal_entries je
JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
JOIN chart_of_accounts coa ON coa.id = jel.account_id
WHERE je.id = 'f1b90b6f-b9f5-4b13-82d9-105cfcc27d34' OR je.entry_number = 'JE2606-0046'
ORDER BY jel.line_number;
`;
const globelinkJe = queryDb(globelinkJeSql);

// 6. Statement Import Uploads Audit
const uploadsSql = `
SELECT 
  u.id AS upload_id,
  u.file_url,
  u.statement_period,
  u.statement_start_date,
  u.statement_end_date,
  u.opening_balance,
  u.closing_balance,
  u.total_credits,
  u.total_debits,
  u.transaction_count,
  (SELECT MIN(transaction_date) FROM bank_statement_lines WHERE upload_id = u.id) AS actual_first_date,
  (SELECT MAX(transaction_date) FROM bank_statement_lines WHERE upload_id = u.id) AS actual_last_date,
  (SELECT COUNT(*) FROM bank_statement_lines WHERE upload_id = u.id) AS actual_count,
  (SELECT COALESCE(SUM(debit_amount), 0) FROM bank_statement_lines WHERE upload_id = u.id) AS actual_debits,
  (SELECT COALESCE(SUM(credit_amount), 0) FROM bank_statement_lines WHERE upload_id = u.id) AS actual_credits,
  ROUND(u.opening_balance + (SELECT COALESCE(SUM(credit_amount - debit_amount), 0) FROM bank_statement_lines WHERE upload_id = u.id), 2) AS calculated_closing_balance
FROM bank_statement_uploads u
WHERE u.bank_account_id = 'bfe79829-07d1-48ed-8965-ff9d367d758e'
ORDER BY u.statement_start_date;
`;
const uploads = queryDb(uploadsSql);

// 7. Payment Kind Audit
const paymentKindSql = `
SELECT 
  COALESCE(payment_kind, 'unclassified') AS payment_kind,
  COUNT(*) AS count,
  COALESCE(SUM(debit_amount), 0) AS total_debit,
  COALESCE(SUM(credit_amount), 0) AS total_credit
FROM bank_statement_lines
WHERE bank_account_id = 'bfe79829-07d1-48ed-8965-ff9d367d758e'
  AND transaction_date <= '2026-09-10'
GROUP BY COALESCE(payment_kind, 'unclassified')
ORDER BY count DESC;
`;
const paymentKindSummary = queryDb(paymentKindSql);

// Save everything into scratch/audit_data.json
const allData = {
  bankAccounts,
  reversals,
  exp239,
  exp239Journals,
  exp239Allocations,
  exp239BankAllocations,
  fiveLines,
  globelink,
  globelinkJe,
  uploads,
  paymentKindSummary
};

fs.writeFileSync("/Users/Kunal/.gemini/antigravity-ide/brain/73556c95-1acf-43fd-9f69-2089a61e6410/scratch/audit_data.json", JSON.stringify(allData, null, 2));
console.log("Forensic Audit data successfully gathered and written to scratch/audit_data.json");
