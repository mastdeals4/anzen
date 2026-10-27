import fs from 'fs';

const expenses = JSON.parse(fs.readFileSync('/tmp/container_expenses.json', 'utf8'));
const jeLines = JSON.parse(fs.readFileSync('/tmp/je_lines.json', 'utf8'));
const petty = JSON.parse(fs.readFileSync('/tmp/container_petty.json', 'utf8'));
const containers = JSON.parse(fs.readFileSync('/tmp/containers.json', 'utf8'));

// Build map of voucher -> journal entry lines
const voucherJeMap = {};
for (const line of jeLines) {
  if (!voucherJeMap[line.voucher_number]) {
    voucherJeMap[line.voucher_number] = [];
  }
  voucherJeMap[line.voucher_number].push(line);
}

// 1. Group expenses by include_in_landed_cost status
console.log('=== 1. BREAKDOWN BY include_in_landed_cost ===');
const byFlag = {
  true: [],
  false: [],
  null: []
};

for (const exp of expenses) {
  const flag = exp.include_in_landed_cost === true ? 'true' : exp.include_in_landed_cost === false ? 'false' : 'null';
  byFlag[flag].push(exp);
}

console.log(`Explicit TRUE: ${byFlag.true.length} expenses, total amount: ${byFlag.true.reduce((s, e) => s + Number(e.amount), 0)}`);
console.log(`Explicit FALSE: ${byFlag.false.length} expenses, total amount: ${byFlag.false.reduce((s, e) => s + Number(e.amount), 0)}`);
console.log(`NULL: ${byFlag.null.length} expenses, total amount: ${byFlag.null.reduce((s, e) => s + Number(e.amount), 0)}`);

// Let us analyze which of these expenses were actually drawn into the costing pool
// In calculate_container_landed_cost_pool:
// - is_capitalizable_landed_cost_category(fe.expense_category)
// - COALESCE(fe.include_in_landed_cost, true) = true
// - approval_status not in ('cancelled', 'rejected')
const capitalizableCategories = new Set([
  'duty_customs', 'duty', 'duty_import',
  'freight_import', 'freight', 'clearing_forwarding',
  'container_handling', 'loading_import', 'port_charges',
  'transport_import', 'import_broker', 'other_import'
]);

console.log('\n=== 2. EXPENSES DRAWN INTO COSTING POOL ===');
const poolExpenses = [];
const nonPoolExpenses = [];

for (const exp of expenses) {
  const isCap = capitalizableCategories.has(exp.expense_category?.toLowerCase().replace(/ /g, '_'));
  const inc = exp.include_in_landed_cost !== false; // COALESCE(include_in_landed_cost, true)
  if (isCap && inc) {
    poolExpenses.push(exp);
  } else {
    nonPoolExpenses.push({ ...exp, reason: !isCap ? `category ${exp.expense_category} not in capitalizable list` : 'include_in_landed_cost is false' });
  }
}

console.log(`Pool expenses count: ${poolExpenses.length}`);
console.log(`Non-pool expenses count: ${nonPoolExpenses.length}`);

// For pool expenses, let's see how much each contributed to the pool
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

const poolDetailed = poolExpenses.map(exp => {
  const cost = calculateCostContribution(exp);
  const lines = voucherJeMap[exp.voucher_number] || [];
  const debitAccounts = [...new Set(lines.filter(l => Number(l.debit) > 0).map(l => `${l.account_code} (${l.account_name})`))];
  const debit1130 = lines.filter(l => l.account_code === '1130').reduce((s, l) => s + Number(l.debit), 0);
  const debitExpense = lines.filter(l => l.account_code.startsWith('5') || l.account_code.startsWith('6')).reduce((s, l) => s + Number(l.debit), 0);
  
  return {
    voucher: exp.voucher_number,
    date: exp.expense_date,
    container: exp.container_ref,
    category: exp.expense_category,
    amount: Number(exp.amount),
    cost_in_pool: cost,
    include_in_landed_cost: exp.include_in_landed_cost,
    je_number: exp.je_number,
    debitAccounts: debitAccounts.join('; '),
    debit1130,
    debitExpense,
    description: exp.description,
    payee: exp.paid_by
  };
});

fs.writeFileSync('/tmp/pool_detailed.json', JSON.stringify(poolDetailed, null, 2));

console.log('\n=== POOL DETAILED SUMMARY BY include_in_landed_cost ===');
const poolByFlag = {
  true: poolDetailed.filter(p => p.include_in_landed_cost === true),
  null: poolDetailed.filter(p => p.include_in_landed_cost === null),
  false: poolDetailed.filter(p => p.include_in_landed_cost === false)
};
console.log(`Explicit TRUE in pool: count=${poolByFlag.true.length}, cost_sum=${poolByFlag.true.reduce((s, p) => s + p.cost_in_pool, 0)}`);
console.log(`NULL in pool: count=${poolByFlag.null.length}, cost_sum=${poolByFlag.null.reduce((s, p) => s + p.cost_in_pool, 0)}`);

console.log('\n=== 3. NON-POOL EXPENSES (WHY WERE THEY EXCLUDED?) ===');
const nonPoolGrouped = {};
for (const np of nonPoolExpenses) {
  const cat = np.expense_category;
  if (!nonPoolGrouped[cat]) nonPoolGrouped[cat] = { count: 0, total_amount: 0, vouchers: [] };
  nonPoolGrouped[cat].count++;
  nonPoolGrouped[cat].total_amount += Number(np.amount);
  nonPoolGrouped[cat].vouchers.push({ voucher: np.voucher_number, amount: Number(np.amount), reason: np.reason, flag: np.include_in_landed_cost });
}
console.log(JSON.stringify(nonPoolGrouped, null, 2));

console.log('\n=== 4. CONTAINER HEADERS & other_import_costs ===');
const headersWithCosts = containers.filter(c => Number(c.other_import_costs || 0) > 0 || Number(c.duty_bm || 0) > 0 || Number(c.total_import_expenses || 0) > 0);
console.log(JSON.stringify(headersWithCosts.map(c => ({
  container_ref: c.container_ref,
  status: c.status,
  other_import_costs: Number(c.other_import_costs || 0),
  duty_bm: Number(c.duty_bm || 0),
  freight_charges: Number(c.freight_charges || 0),
  clearing_forwarding: Number(c.clearing_forwarding || 0),
  total_import_expenses: Number(c.total_import_expenses || 0),
  notes: c.notes
})), null, 2));

console.log('\n=== 5. PETTY CASH IN POOL ===');
const pettyInPool = petty.filter(p => capitalizableCategories.has(p.expense_category?.toLowerCase().replace(/ /g, '_')) && p.include_in_landed_cost !== false);
console.log(JSON.stringify(pettyInPool.map(p => ({
  date: p.transaction_date,
  container: p.container_ref,
  category: p.expense_category,
  amount: Number(p.amount),
  include_in_landed_cost: p.include_in_landed_cost,
  description: p.description
})), null, 2));
