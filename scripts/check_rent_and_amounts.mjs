import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const runSql = (sql) => {
  const stdout = execFileSync('supabase', ['db', 'query', '--linked', '--output-format', 'json', sql], {
    cwd: process.cwd(),
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
  });
  const res = JSON.parse(stdout);
  if (res.error) throw new Error(res.error.message || JSON.stringify(res.error));
  return res.rows || [];
};

async function main() {
  console.log('=== Checking All Rent/Ruko/Gudang Expenses in 2025 ===');
  const rentExp = runSql(`
    SELECT 
      id, voucher_number, expense_date, amount, description, payment_method, paid_by
    FROM finance_expenses
    WHERE (description ILIKE '%rent%' OR description ILIKE '%gudang%' OR description ILIKE '%ruko%')
      AND expense_date >= '2025-01-01' AND expense_date < '2026-01-01'
    ORDER BY expense_date;
  `);
  console.log(rentExp);

  console.log('=== Checking All Bank Lines with 8M, 7M, 3.5M, 10M in 2025 ===');
  const bankAmounts = runSql(`
    SELECT 
      transaction_date, debit_amount, credit_amount, description, reference, reconciliation_status, matched_expense_id
    FROM bank_statement_lines
    WHERE (debit_amount IN (8000000, 7000000, 3500000, 10000000, 5850000, 2000000, 823500, 776500)
       OR credit_amount IN (8000000, 7000000, 3500000, 10000000, 5850000, 2000000, 823500, 776500))
      AND transaction_date >= '2025-01-01' AND transaction_date < '2025-11-01'
    ORDER BY transaction_date;
  `);
  console.log(bankAmounts);
}

main().catch(console.error);
