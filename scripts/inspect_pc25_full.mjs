import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const sql = `
  SELECT 
    pct.*,
    u.email as created_by_email
  FROM petty_cash_transactions pct
  LEFT JOIN auth.users u ON u.id = pct.created_by
  WHERE pct.transaction_date < '2025-11-01'
  ORDER BY pct.transaction_date, pct.transaction_number;
`;

const stdout = execFileSync('supabase', ['db', 'query', '--linked', '--output-format', 'json', sql], {
  cwd: process.cwd(),
  encoding: 'utf8',
  maxBuffer: 50 * 1024 * 1024,
});

const res = JSON.parse(stdout);
writeFileSync('/tmp/pc25_full_details.json', JSON.stringify(res.rows, null, 2));
console.log(`Saved ${res.rows.length} rows to /tmp/pc25_full_details.json`);
for (const r of res.rows) {
  console.log({
    date: r.transaction_date,
    num: r.transaction_number,
    amt: r.amount,
    cat: r.expense_category,
    desc: r.description,
    source: r.source,
    paid_by: r.paid_by,
    created_at: r.created_at,
    metadata: r.metadata
  });
}
