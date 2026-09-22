import { execFileSync } from 'node:child_process';

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
  console.log('--- Search Bank for Nia ---');
  console.log(runSql(`SELECT transaction_date, debit_amount, credit_amount, description FROM bank_statement_lines WHERE description ILIKE '%nia%' ORDER BY transaction_date;`));

  console.log('--- Search Bank for Nico ---');
  console.log(runSql(`SELECT transaction_date, debit_amount, credit_amount, description FROM bank_statement_lines WHERE description ILIKE '%nico%' ORDER BY transaction_date;`));

  console.log('--- Search Bank for CDOB ---');
  console.log(runSql(`SELECT transaction_date, debit_amount, credit_amount, description FROM bank_statement_lines WHERE description ILIKE '%cdob%' ORDER BY transaction_date;`));

  console.log('--- Search Bank for Depkes / Menkes ---');
  console.log(runSql(`SELECT transaction_date, debit_amount, credit_amount, description FROM bank_statement_lines WHERE description ILIKE '%depkes%' OR description ILIKE '%menkes%' OR description ILIKE '%kemenkes%' ORDER BY transaction_date;`));

  console.log('--- Search Finance Expenses for Depkes / Menkes ---');
  console.log(runSql(`SELECT voucher_number, expense_date, amount, description, payment_method, paid_by FROM finance_expenses WHERE description ILIKE '%depkes%' OR description ILIKE '%menkes%' OR description ILIKE '%kemenkes%' ORDER BY expense_date;`));
}

main().catch(console.error);
