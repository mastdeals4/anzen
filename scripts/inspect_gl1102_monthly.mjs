import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const sql = `
  SELECT 
    je.entry_date,
    je.source_module,
    je.reference_id,
    je.entry_number,
    jl.debit,
    jl.credit,
    jl.description
  FROM journal_entry_lines jl
  JOIN journal_entries je ON je.id = jl.journal_entry_id
  JOIN chart_of_accounts coa ON coa.id = jl.account_id
  WHERE coa.code = '1102' AND je.is_posted = true AND COALESCE(je.is_reversed, false) = false
  ORDER BY je.entry_date, je.entry_number;
`;

const stdout = execFileSync('supabase', ['db', 'query', '--linked', '--output-format', 'json', sql], {
  cwd: process.cwd(),
  encoding: 'utf8',
  maxBuffer: 50 * 1024 * 1024,
});

const res = JSON.parse(stdout);
console.log(`Total GL 1102 lines: ${res.rows.length}`);

// Group by month and whether debit or credit
const byMonth = {};
let runningBalance = 0;

for (const r of res.rows) {
  const month = r.entry_date.substring(0, 7);
  byMonth[month] = byMonth[month] || { debit: 0, credit: 0, count: 0 };
  const d = Number(r.debit);
  const c = Number(r.credit);
  byMonth[month].debit += d;
  byMonth[month].credit += c;
  byMonth[month].count += 1;
  runningBalance += (d - c);
}

console.log('Monthly summary of GL 1102:');
for (const [m, data] of Object.entries(byMonth)) {
  console.log(`${m}: Debit ${data.debit.toLocaleString('id-ID')}, Credit ${data.credit.toLocaleString('id-ID')}, Net ${(data.debit - data.credit).toLocaleString('id-ID')}, Lines: ${data.count}`);
}
console.log('Final balance:', runningBalance.toLocaleString('id-ID'));
