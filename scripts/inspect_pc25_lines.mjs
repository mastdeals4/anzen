import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const rows = JSON.parse(readFileSync('/tmp/pc25_audit.json', 'utf8'));
const jeIds = rows.map(r => `'${r.journal_id}'`).join(',');

const sql = `
  SELECT 
    jl.id as line_id,
    jl.journal_entry_id,
    je.entry_number,
    je.entry_date,
    je.source_module,
    je.reference_id,
    jl.account_id,
    coa.code as account_code,
    coa.name as account_name,
    jl.debit,
    jl.credit,
    jl.description as line_desc
  FROM journal_entry_lines jl
  JOIN journal_entries je ON je.id = jl.journal_entry_id
  JOIN chart_of_accounts coa ON coa.id = jl.account_id
  WHERE je.id IN (${jeIds})
  ORDER BY je.entry_date, je.entry_number, jl.debit DESC;
`;

const stdout = execFileSync('supabase', ['db', 'query', '--linked', '--output-format', 'json', sql], {
  cwd: process.cwd(),
  encoding: 'utf8',
  maxBuffer: 50 * 1024 * 1024,
});

const res = JSON.parse(stdout);
writeFileSync('/tmp/pc25_je_lines.json', JSON.stringify(res.rows, null, 2));
console.log(`Fetched ${res.rows.length} lines for the 25 journal entries.`);

// Print summary of accounts debited and credited
const debits = {};
const credits = {};
for (const line of res.rows) {
  if (Number(line.debit) > 0) {
    debits[line.account_code] = debits[line.account_code] || { name: line.account_name, amount: 0 };
    debits[line.account_code].amount += Number(line.debit);
  }
  if (Number(line.credit) > 0) {
    credits[line.account_code] = credits[line.account_code] || { name: line.account_name, amount: 0 };
    credits[line.account_code].amount += Number(line.credit);
  }
}
console.log('Debited accounts:', debits);
console.log('Credited accounts:', credits);
