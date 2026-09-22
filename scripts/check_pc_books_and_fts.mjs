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
  console.log('--- Checking petty_cash_books ---');
  console.log(runSql(`SELECT * FROM petty_cash_books;`));

  console.log('--- Checking all fund transfers involving petty cash ---');
  const fts = runSql(`
    SELECT transfer_number, transfer_date, amount, from_account_type, to_account_type, description, status, created_at
    FROM fund_transfers
    WHERE from_account_type = 'petty_cash' OR to_account_type = 'petty_cash'
    ORDER BY transfer_date;
  `);
  console.log(fts);
}

main().catch(console.error);
