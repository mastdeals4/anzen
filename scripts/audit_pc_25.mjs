import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const runSql = (sql) => {
  const stdout = execFileSync('supabase', ['db', 'query', '--linked', '--output-format', 'json', sql], {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    maxBuffer: 100 * 1024 * 1024,
  });
  const response = JSON.parse(stdout);
  if (response.error) throw new Error(response.error.message ?? JSON.stringify(response.error));
  return response.rows ?? [];
};

async function main() {
  console.log('--- Checking GL 1102 Balance ---');
  const gl1102 = runSql(`
    SELECT 
      c.code, c.name,
      COUNT(jl.id) as line_count,
      COALESCE(SUM(jl.debit), 0) as total_debit,
      COALESCE(SUM(jl.credit), 0) as total_credit,
      COALESCE(SUM(jl.debit - jl.credit), 0) as net_balance
    FROM chart_of_accounts c
    LEFT JOIN journal_entry_lines jl ON jl.account_id = c.id
    LEFT JOIN journal_entries je ON je.id = jl.journal_entry_id
    WHERE c.code = '1102' AND je.is_posted = true AND COALESCE(je.is_reversed, false) = false
    GROUP BY c.code, c.name;
  `);
  console.log('GL 1102 ledger:', JSON.stringify(gl1102, null, 2));

  console.log('--- Checking vw_petty_cash_balance ---');
  const vwBalance = runSql(`SELECT * FROM vw_petty_cash_balance;`);
  console.log('vw_petty_cash_balance:', JSON.stringify(vwBalance, null, 2));

  console.log('--- Checking 25 historical petty cash transactions (< 2025-11-01) ---');
  const pc25 = runSql(`
    SELECT 
      pct.id,
      pct.transaction_date,
      pct.transaction_number,
      pct.transaction_type,
      pct.expense_category,
      pct.amount,
      pct.paid_by,
      pct.description,
      pct.approval_status,
      pct.source,
      pct.include_in_landed_cost,
      je.id as journal_id,
      je.entry_number,
      je.entry_date,
      je.is_posted,
      je.is_reversed,
      je.source_module,
      je.description as je_desc
    FROM petty_cash_transactions pct
    LEFT JOIN journal_entries je ON (je.reference_id = pct.id OR je.reference_number = pct.transaction_number)
    WHERE pct.transaction_date < '2025-11-01'
    ORDER BY pct.transaction_date, pct.transaction_number;
  `);
  console.log(`Found ${pc25.length} historical transactions.`);
  writeFileSync('/tmp/pc25_audit.json', JSON.stringify(pc25, null, 2));

  console.log('--- Monthly summary of 25 historical rows ---');
  const monthly = runSql(`
    SELECT 
      to_char(transaction_date, 'YYYY-MM') as month,
      count(*) as count,
      sum(amount) as total_amount
    FROM petty_cash_transactions
    WHERE transaction_date < '2025-11-01'
    GROUP BY to_char(transaction_date, 'YYYY-MM')
    ORDER BY month;
  `);
  console.log('Monthly breakdown:', JSON.stringify(monthly, null, 2));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
