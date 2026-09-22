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

  // Get all users / staff in system
  const staff = runSql(`SELECT id, name, email, role, department FROM staff ORDER BY name;`);
  console.log('Staff list:', staff);

  // Check payroll / salary tables if any
  const tables = runSql(`
    SELECT table_name 
    FROM information_schema.tables 
    WHERE table_schema = 'public' 
      AND (table_name ILIKE '%salary%' OR table_name ILIKE '%payroll%' OR table_name ILIKE '%advance%' OR table_name ILIKE '%staff%' OR table_name ILIKE '%loan%');
  `);
  console.log('Relevant tables:', tables);
}

main().catch(console.error);
