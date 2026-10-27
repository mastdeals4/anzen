import fs from 'fs';

const containers = JSON.parse(fs.readFileSync('/tmp/containers.json', 'utf8'));
const expenses = JSON.parse(fs.readFileSync('/tmp/container_expenses.json', 'utf8'));

const targetRefs = ['1st  Air Shipment', '1st 20MT FCL NOV 25', '2nd Air shipment'];

for (const ref of targetRefs) {
  const c = containers.find(x => x.container_ref === ref);
  const exps = expenses.filter(x => x.container_ref === ref);
  console.log(`\n======================================================`);
  console.log(`CONTAINER: ${c.container_ref}`);
  console.log(`Created at: ${c.created_at} | Status: ${c.status}`);
  console.log(`HEADER FIELDS:`);
  console.log(`  other_import_costs:    ${Number(c.other_import_costs || 0).toLocaleString('id-ID')}`);
  console.log(`  duty_bm:               ${Number(c.duty_bm || 0).toLocaleString('id-ID')}`);
  console.log(`  freight_charges:       ${Number(c.freight_charges || 0).toLocaleString('id-ID')}`);
  console.log(`  clearing_forwarding:   ${Number(c.clearing_forwarding || 0).toLocaleString('id-ID')}`);
  console.log(`  port_charges:          ${Number(c.port_charges || 0).toLocaleString('id-ID')}`);
  console.log(`  container_handling:    ${Number(c.container_handling || 0).toLocaleString('id-ID')}`);
  console.log(`  transportation:        ${Number(c.transportation || 0).toLocaleString('id-ID')}`);
  console.log(`  loading_import:        ${Number(c.loading_import || 0).toLocaleString('id-ID')}`);
  console.log(`  bpom_ski_fees:         ${Number(c.bpom_ski_fees || 0).toLocaleString('id-ID')}`);
  console.log(`  total_import_expenses: ${Number(c.total_import_expenses || 0).toLocaleString('id-ID')}`);
  console.log(`  notes:                 ${c.notes || '(none)'}`);
  
  console.log(`\nACTUAL EXPENSES ENTERED FOR THIS CONTAINER:`);
  let expSum = 0;
  for (const e of exps) {
    console.log(`  Voucher: ${e.voucher_number} | Date: ${e.expense_date} | Cat: ${e.expense_category.padEnd(16)} | Amt: ${Number(e.amount).toLocaleString('id-ID').padStart(14)} | ${e.description || ''}`);
    expSum += Number(e.amount);
  }
  console.log(`  TOTAL EXPENSES SUM: ${expSum.toLocaleString('id-ID')}`);
}
