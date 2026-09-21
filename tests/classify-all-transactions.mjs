import fs from 'fs';

const expenses = JSON.parse(fs.readFileSync('/tmp/container_expenses.json', 'utf8'));
const jeLines = JSON.parse(fs.readFileSync('/tmp/je_lines.json', 'utf8'));
const petty = JSON.parse(fs.readFileSync('/tmp/container_petty.json', 'utf8'));

// Categories in costing engine
const capitalizableCategories = new Set([
  'duty_customs', 'duty', 'duty_import',
  'freight_import', 'freight', 'clearing_forwarding',
  'container_handling', 'loading_import', 'port_charges',
  'transport_import', 'import_broker', 'other_import'
]);

function calculateCostContribution(exp) {
  if (exp.expense_category === 'import_broker') {
    let brokerTotal = Number(exp.amount) - Number(exp.ppn_amount || 0);
    if (exp.broker_items && Array.isArray(exp.broker_items) && exp.broker_items.length > 0) {
      const itemsSum = exp.broker_items.reduce((s, x) => {
        const amt = x.invoice_amount_authoritative ? Number(x.amount || 0) : (Number(x.amount || 0) || (Number(x.dpp_amount || 0) + Number(x.ppn_amount || 0)));
        return s + (amt - Number(x.ppn_amount || 0));
      }, 0);
      brokerTotal += itemsSum;
    }
    brokerTotal += Number(exp.stamp_duty_amount || 0);
    return brokerTotal;
  }
  return Number(exp.amount);
}

// Build transaction report
const transactionReport = [];

for (const exp of expenses) {
  const isCap = capitalizableCategories.has(exp.expense_category?.toLowerCase().replace(/ /g, '_'));
  const incInFifo = isCap && exp.include_in_landed_cost !== false;
  const poolCost = incInFifo ? calculateCostContribution(exp) : 0;
  const lines = jeLines.filter(l => l.voucher_number === exp.voucher_number);
  
  const debit1130 = lines.filter(l => l.account_code === '1130').reduce((s, l) => s + Number(l.debit), 0);
  const debit5300 = lines.filter(l => l.account_code === '5300').reduce((s, l) => s + Number(l.debit), 0);
  const debit6900 = lines.filter(l => l.account_code === '6900').reduce((s, l) => s + Number(l.debit), 0);
  const debitTax = lines.filter(l => l.account_code === '1150' || l.account_code === '1155').reduce((s, l) => s + Number(l.debit), 0);
  const debitOther = lines.filter(l => !['1130', '5300', '6900', '1150', '1155'].includes(l.account_code) && Number(l.debit) > 0).reduce((s, l) => s + Number(l.debit), 0);
  
  const glAccounts = [...new Set(lines.filter(l => Number(l.debit) > 0).map(l => l.account_code))];
  
  let currentGlTreatment = '';
  if (debit1130 > 0 && debitTax > 0) currentGlTreatment = `Capitalized BM (1130: ${debit1130.toLocaleString('id-ID')}) + Tax Receivable (${debitTax.toLocaleString('id-ID')})`;
  else if (debit1130 > 0) currentGlTreatment = `Capitalized into 1130 Inventory (${debit1130.toLocaleString('id-ID')})`;
  else if (debit5300 > 0) currentGlTreatment = `Expensed to 5300 Freight In (${debit5300.toLocaleString('id-ID')})`;
  else if (debit6900 > 0) currentGlTreatment = `Expensed to 6900 Misc Expense (${debit6900.toLocaleString('id-ID')})`;
  else if (debitTax > 0) currentGlTreatment = `Tax Asset 1150/1155 (${debitTax.toLocaleString('id-ID')})`;
  else if (lines.length === 0) currentGlTreatment = 'No Journal Posted';
  else currentGlTreatment = `Debited to ${glAccounts.join(', ')}`;

  transactionReport.push({
    voucher: exp.voucher_number,
    date: exp.expense_date,
    payee: exp.paid_by || '-',
    container: exp.container_ref,
    category: exp.expense_category,
    amount: Number(exp.amount),
    cost_in_pool: poolCost,
    include_in_landed_cost: exp.include_in_landed_cost,
    included_in_fifo: incInFifo,
    gl_accounts: glAccounts.join(', ') || 'None',
    debit1130,
    debit5300,
    debit6900,
    debitTax,
    debitOther,
    currentGlTreatment,
    description: exp.description
  });
}

// Add Petty Cash rows
for (const p of petty) {
  const isCap = capitalizableCategories.has(p.expense_category?.toLowerCase().replace(/ /g, '_'));
  const incInFifo = isCap && p.include_in_landed_cost !== false;
  transactionReport.push({
    voucher: `PC-${p.id.slice(0, 8)}`,
    date: p.transaction_date,
    payee: p.recipient || '-',
    container: p.container_ref,
    category: p.expense_category,
    amount: Number(p.amount),
    cost_in_pool: incInFifo ? Number(p.amount) : 0,
    include_in_landed_cost: p.include_in_landed_cost,
    included_in_fifo: incInFifo,
    gl_accounts: '5300',
    debit1130: 0,
    debit5300: Number(p.amount),
    debit6900: 0,
    debitTax: 0,
    debitOther: 0,
    currentGlTreatment: `Petty cash expensed to 5300 Freight In (${Number(p.amount).toLocaleString('id-ID')})`,
    description: p.description
  });
}

fs.writeFileSync('/tmp/all_transaction_report.json', JSON.stringify(transactionReport, null, 2));

// Summary statistics
console.log('=== SUMMARY OF TRANSACTION REPORT ===');
console.log(`Total transactions: ${transactionReport.length}`);
const inFifo = transactionReport.filter(t => t.included_in_fifo);
console.log(`Included in FIFO Costing: ${inFifo.length} transactions, total costing: ${inFifo.reduce((s, t) => s + t.cost_in_pool, 0).toLocaleString('id-ID')}`);

const in1130 = transactionReport.filter(t => t.debit1130 > 0);
console.log(`Debited to GL 1130: ${in1130.length} transactions, total debit 1130: ${in1130.reduce((s, t) => s + t.debit1130, 0).toLocaleString('id-ID')}`);

const in5300 = transactionReport.filter(t => t.debit5300 > 0);
console.log(`Debited to GL 5300: ${in5300.length} transactions, total debit 5300: ${in5300.reduce((s, t) => s + t.debit5300, 0).toLocaleString('id-ID')}`);

const in6900 = transactionReport.filter(t => t.debit6900 > 0);
console.log(`Debited to GL 6900: ${in6900.length} transactions, total debit 6900: ${in6900.reduce((s, t) => s + t.debit6900, 0).toLocaleString('id-ID')}`);

// Break down the FIFO costing pool by GL destination
console.log('\n=== BREAKDOWN OF FIFO COSTING POOL (Rp 184.61M) BY GL TREATMENT ===');
const fifoIn1130 = inFifo.filter(t => t.debit1130 > 0);
const fifoIn5300 = inFifo.filter(t => t.debit5300 > 0);
const fifoIn6900 = inFifo.filter(t => t.debit6900 > 0);
const fifoInOther = inFifo.filter(t => t.debit1130 === 0 && t.debit5300 === 0 && t.debit6900 === 0);

console.log(`Costing Pool Items in GL 1130: ${fifoIn1130.reduce((s, t) => s + t.cost_in_pool, 0).toLocaleString('id-ID')} (${fifoIn1130.map(t => t.voucher).join(', ')})`);
console.log(`Costing Pool Items in GL 5300: ${fifoIn5300.reduce((s, t) => s + t.cost_in_pool, 0).toLocaleString('id-ID')} (${fifoIn5300.length} vouchers)`);
console.log(`Costing Pool Items in GL 6900: ${fifoIn6900.reduce((s, t) => s + t.cost_in_pool, 0).toLocaleString('id-ID')} (${fifoIn6900.map(t => t.voucher).join(', ')})`);
console.log(`Costing Pool Items with other/no GL: ${fifoInOther.reduce((s, t) => s + t.cost_in_pool, 0).toLocaleString('id-ID')}`);
