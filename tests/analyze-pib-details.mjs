import fs from 'fs';

const expenses = JSON.parse(fs.readFileSync('/tmp/container_expenses.json', 'utf8'));
const jeLines = JSON.parse(fs.readFileSync('/tmp/je_lines.json', 'utf8'));

const pibExpenses = expenses.filter(e => e.expense_category === 'pib_import');
console.log(`Found ${pibExpenses.length} PIB import expenses:`);

for (const pib of pibExpenses) {
  const lines = jeLines.filter(l => l.voucher_number === pib.voucher_number);
  console.log(`\n--------------------------------------------------`);
  console.log(`Voucher: ${pib.voucher_number} | Date: ${pib.expense_date} | Container: ${pib.container_ref}`);
  console.log(`Total Amount: ${Number(pib.amount).toLocaleString('id-ID')} | Paid by: ${pib.paid_by}`);
  console.log(`Fields -> BM: ${Number(pib.pib_bm_amount || 0).toLocaleString('id-ID')} | PPN: ${Number(pib.pib_ppn_amount || 0).toLocaleString('id-ID')} | PPh: ${Number(pib.pib_pph_amount || 0).toLocaleString('id-ID')}`);
  console.log(`include_in_landed_cost flag: ${pib.include_in_landed_cost}`);
  console.log(`Journal Lines:`);
  for (const l of lines) {
    console.log(`  ${l.account_code.padEnd(6)} ${l.account_name.padEnd(30)} Dr: ${Number(l.debit).toLocaleString('id-ID').padStart(15)} Cr: ${Number(l.credit).toLocaleString('id-ID').padStart(15)} | ${l.description || ''}`);
  }
}
