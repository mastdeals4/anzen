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
  const rows = JSON.parse(readFileSync('/tmp/pc25_audit.json', 'utf8'));

  // Trace each row
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    console.log(`\n================ ROW ${i + 1} / 25 ================`);
    console.log(`ID: ${r.id}`);
    console.log(`Date: ${r.transaction_date} | Num: ${r.transaction_number} | Amount: Rp ${Number(r.amount).toLocaleString('id-ID')}`);
    console.log(`Cat: ${r.expense_category} | Desc: ${r.description}`);
    console.log(`Journal: ${r.entry_number} (${r.journal_id})`);

    // Check if there are journal lines
    const lines = runSql(`
      SELECT jl.id, coa.code, coa.name, jl.debit, jl.credit, jl.description
      FROM journal_entry_lines jl
      JOIN chart_of_accounts coa ON coa.id = jl.account_id
      WHERE jl.journal_entry_id = '${r.journal_id}';
    `);
    console.log('Current Journal Lines:', lines.map(l => `${l.code} ${l.name} | Dr: ${l.debit} | Cr: ${l.credit}`));
  }
}

main().catch(console.error);
