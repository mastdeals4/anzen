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

async function audit25() {
  const rows = JSON.parse(readFileSync('/tmp/pc25_audit.json', 'utf8'));

  // Get all bank statement lines before 2025-11-01
  const bankLines = runSql(`
    SELECT 
      id, transaction_date, debit_amount, credit_amount, 
      description, reference, reconciliation_status, matched_entry_id, matched_expense_id, matched_petty_cash_id
    FROM bank_statement_lines
    WHERE transaction_date < '2025-11-01'
    ORDER BY transaction_date;
  `);
  console.log(`Found ${bankLines.length} historical bank statement lines before 2025-11-01.`);

  // Get all finance expenses before 2025-11-01
  const finExpenses = runSql(`
    SELECT 
      id, voucher_number, expense_date, amount, payment_method, 
      expense_category, description, approval_status, paid_by, bank_account_id
    FROM finance_expenses
    WHERE expense_date < '2025-11-01'
    ORDER BY expense_date;
  `);
  console.log(`Found ${finExpenses.length} finance expenses before 2025-11-01.`);

  // Check fund transfers before 2025-11-01
  const fundTransfers = runSql(`
    SELECT 
      id, transfer_number, transfer_date, amount, from_account_type, to_account_type, description, status
    FROM fund_transfers
    WHERE transfer_date < '2025-11-01'
    ORDER BY transfer_date;
  `);
  console.log(`Found ${fundTransfers.length} historical fund transfers before 2025-11-01.`);

  const results = [];

  for (const r of rows) {
    // Check if matching bank line exists by exact or close amount
    const matchingBankLines = bankLines.filter(b => 
      Number(b.debit_amount) === Number(r.amount) ||
      Number(b.credit_amount) === Number(r.amount)
    );

    // Check matching finance expenses
    const matchingFinExp = finExpenses.filter(f =>
      Number(f.amount) === Number(r.amount)
    );

    results.push({
      pc: r,
      matchingBankLines,
      matchingFinExp
    });
  }

  writeFileSync('/tmp/pc25_forensic_results.json', JSON.stringify(results, null, 2));
  console.log('Saved forensic results to /tmp/pc25_forensic_results.json');
}

audit25().catch(console.error);
