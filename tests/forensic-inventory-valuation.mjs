import { execSync } from 'child_process';
import fs from 'fs';

function runSql(sql) {
  fs.writeFileSync('/tmp/forensic_inv.sql', sql);
  const out = execSync('npx supabase db query --linked --file /tmp/forensic_inv.sql --output-format json', { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  const jsonStart = out.indexOf('{');
  return jsonStart !== -1 ? JSON.parse(out.slice(jsonStart)).rows : [];
}

console.log('=== PART 1: ALL EXPENSES LINKED TO IMPORT CONTAINERS ===');
const containerExpensesSql = `
SELECT 
  fe.id,
  fe.voucher_number,
  fe.expense_date,
  fe.amount,
  fe.expense_category,
  fe.include_in_landed_cost,
  fe.import_container_id,
  ic.container_ref,
  fe.paid_by,
  fe.description,
  fe.pib_bm_amount,
  fe.pib_ppn_amount,
  fe.pib_pph_amount,
  fe.ppn_amount,
  fe.pph_amount,
  fe.stamp_duty_amount,
  fe.broker_items,
  je.id as journal_entry_id,
  je.entry_number as je_number,
  je.is_posted as je_posted
FROM finance_expenses fe
LEFT JOIN import_containers ic ON ic.id = fe.import_container_id
LEFT JOIN journal_entries je ON (je.reference_id = fe.id OR je.reference_number = fe.voucher_number) AND je.source_module = 'expenses'
WHERE fe.import_container_id IS NOT NULL
ORDER BY ic.container_ref, fe.expense_date;
`;
const expenses = runSql(containerExpensesSql);
console.log(`Found ${expenses.length} container expenses.`);
fs.writeFileSync('/tmp/container_expenses.json', JSON.stringify(expenses, null, 2));

console.log('\n=== PART 2: JOURNAL ENTRY LINES FOR THESE EXPENSES ===');
const jeLinesSql = `
SELECT 
  fe.voucher_number,
  je.entry_number,
  coa.code as account_code,
  coa.name as account_name,
  jel.debit,
  jel.credit,
  jel.description
FROM finance_expenses fe
JOIN journal_entries je ON (je.reference_id = fe.id OR je.reference_number = fe.voucher_number) AND je.source_module = 'expenses'
JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
JOIN chart_of_accounts coa ON coa.id = jel.account_id
WHERE fe.import_container_id IS NOT NULL
ORDER BY fe.voucher_number, jel.debit DESC;
`;
const jeLines = runSql(jeLinesSql);
console.log(`Found ${jeLines.length} journal entry lines.`);
fs.writeFileSync('/tmp/je_lines.json', JSON.stringify(jeLines, null, 2));

console.log('\n=== PART 3: ALL PETTY CASH LINKED TO CONTAINERS ===');
const pettySql = `
SELECT 
  pc.*,
  ic.container_ref
FROM petty_cash_transactions pc
LEFT JOIN import_containers ic ON ic.id = pc.import_container_id
WHERE pc.import_container_id IS NOT NULL;
`;
const petty = runSql(pettySql);
console.log(`Found ${petty.length} container petty cash rows.`);
fs.writeFileSync('/tmp/container_petty.json', JSON.stringify(petty, null, 2));

console.log('\n=== PART 4: CONTAINER HEADERS ===');
const containerHeadersSql = `
SELECT 
  id,
  container_ref,
  status,
  other_import_costs,
  duty_bm,
  ppn_import,
  pph_import,
  freight_charges,
  clearing_forwarding,
  port_charges,
  container_handling,
  transportation,
  loading_import,
  bpom_ski_fees,
  total_import_expenses,
  notes,
  created_at
FROM import_containers
ORDER BY container_ref;
`;
const containers = runSql(containerHeadersSql);
console.log(`Found ${containers.length} containers.`);
fs.writeFileSync('/tmp/containers.json', JSON.stringify(containers, null, 2));

console.log('\nData dump complete.');
