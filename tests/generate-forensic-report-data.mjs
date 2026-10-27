import fs from 'fs';

const expenses = JSON.parse(fs.readFileSync('/tmp/container_expenses.json', 'utf8'));
const jeLines = JSON.parse(fs.readFileSync('/tmp/je_lines.json', 'utf8'));
const petty = JSON.parse(fs.readFileSync('/tmp/container_petty.json', 'utf8'));
const containers = JSON.parse(fs.readFileSync('/tmp/containers.json', 'utf8'));
const payees = JSON.parse(fs.readFileSync('/tmp/expense_payees.json', 'utf8'));

// Payee lookup
const payeeMap = {};
for (const p of payees) {
  payeeMap[p.voucher_number] = p.resolved_payee;
}

// Map JE lines by voucher_number
const voucherJeMap = {};
for (const line of jeLines) {
  if (!voucherJeMap[line.voucher_number]) voucherJeMap[line.voucher_number] = [];
  voucherJeMap[line.voucher_number].push(line);
}

// Capitalizable categories in SQL:
const capCategories = new Set([
  'duty_customs', 'duty', 'duty_import',
  'freight_import', 'freight', 'clearing_forwarding',
  'container_handling', 'loading_import', 'port_charges',
  'transport_import', 'import_broker', 'other_import'
]);

function isCap(cat) {
  return capCategories.has((cat || '').toLowerCase().replace(/ /g, '_'));
}

// Process all expenses
const transactionRows = [];


const seenIds = new Set();
const uniqueExpenses = [];
for (const e of expenses) {
  if (!seenIds.has(e.id)) {
    seenIds.add(e.id);
    uniqueExpenses.push(e);
  }
}
for (const e of uniqueExpenses) {

  const lines = voucherJeMap[e.voucher_number] || [];
  
  // Accounts debited
  const debitedAccounts = lines.filter(l => Number(l.debit) > 0).map(l => l.account_code);
  const distinctAccounts = [...new Set(debitedAccounts)];
  
  let debit1130 = 0;
  let debit5300 = 0;
  let debit6900 = 0;
  let debitTax = 0;
  let debitOther = 0;
  
  for (const l of lines) {
    const d = Number(l.debit || 0);
    if (d > 0) {
      if (l.account_code === '1130') debit1130 += d;
      else if (l.account_code === '5300') debit5300 += d;
      else if (l.account_code === '6900') debit6900 += d;
      else if (['1150', '1155'].includes(l.account_code)) debitTax += d;
      else debitOther += d;
    }
  }

  // Cost pool calculation for this expense
  let costInPool = 0;
  const inc = e.include_in_landed_cost !== false; // COALESCE(include_in_landed_cost, true)
  if (isCap(e.expense_category) && inc) {
    if (e.expense_category === 'import_broker') {
      let brokerSum = 0;
      if (e.broker_items && Array.isArray(e.broker_items)) {
        for (const item of e.broker_items) {
          const itemAmt = item.invoice_amount_authoritative === true
            ? Number(item.amount || 0)
            : (Number(item.amount || 0) !== 0 ? Number(item.amount) : (Number(item.dpp_amount || 0) + Number(item.ppn_amount || 0)));
          brokerSum += itemAmt - Number(item.ppn_amount || 0);
        }
      }
      costInPool = (Number(e.amount) - Number(e.ppn_amount || 0)) + brokerSum + Number(e.stamp_duty_amount || 0);
    } else {
      costInPool = Number(e.amount);
    }
  }

  // Determine current accounting treatment
  let currentGlTreatment = '';
  if (debit1130 > 0 && (debitTax > 0 || debitOther > 0 || debit5300 > 0)) {
    currentGlTreatment = `Split: DR 1130 (${debit1130.toLocaleString('id-ID')}) + DR Tax/Exp`;
  } else if (debit1130 > 0) {
    currentGlTreatment = `Capitalized in GL 1130`;
  } else if (debit5300 > 0) {
    currentGlTreatment = `Expensed to GL 5300 (Freight In)`;
  } else if (debit6900 > 0) {
    currentGlTreatment = `Expensed to GL 6900 (Misc Expense)`;
  } else if (debitTax > 0) {
    currentGlTreatment = `Segregated to Tax (1150/1155)`;
  } else if (debitOther > 0) {
    currentGlTreatment = `Debited to ${distinctAccounts.join(', ')}`;
  } else {
    currentGlTreatment = `No GL debit found`;
  }

  // Proposed Classification & Logic
  let proposedClassification = '';
  let reason = '';
  let systemChangeReq = 'No';
  let ownerDecisionReq = 'No';

  if (e.expense_category === 'pib_import') {
    proposedClassification = 'Capitalize BM to Landed Cost (Segregate PPN/PPh to Tax Assets)';
    reason = `PIB payment contains Bea Masuk (BM = Rp ${Number(e.pib_bm_amount || 0).toLocaleString('id-ID')}), PPN (Rp ${Number(e.pib_ppn_amount || 0).toLocaleString('id-ID')}), PPh 22 (Rp ${Number(e.pib_pph_amount || 0).toLocaleString('id-ID')}). GL already capitalized BM Rp 85.83M to 1130, but costing engine missed it due to category mismatch.`;
    systemChangeReq = 'YES (Costing engine must extract pib_bm_amount from pib_import)';
    ownerDecisionReq = 'No (PSAK 14 / IAS 2 and GL already mandate duty capitalization)';
  } else if (e.expense_category === 'bpom_ski_fees') {
    proposedClassification = 'Operating Expense (GL 6710 / P&L)';
    reason = 'Regulatory import compliance / SKI license fee (Rp 50k per item). Properly expensed to P&L; excluded from landed cost in both GL and costing engine.';
    systemChangeReq = 'No';
    ownerDecisionReq = 'No';
  } else if (['import_broker', 'clearing_forwarding', 'port_charges', 'loading_import', 'container_handling'].includes(e.expense_category)) {
    if (e.include_in_landed_cost === true && debit1130 > 0) {
      proposedClassification = 'Capitalizable Landed Cost';
      reason = 'Synchronized. Explicitly tagged landed cost; capitalized in GL 1130 and included in costing pool.';
      systemChangeReq = 'No';
      ownerDecisionReq = 'No';
    } else if (e.include_in_landed_cost === true && debit5300 > 0) {
      proposedClassification = 'Capitalizable Landed Cost (Policy Alignment Needed)';
      reason = 'Tagged include_in_landed_cost=TRUE, pulled into FIFO layers, but posted to GL 5300 expense. Owner must confirm whether GL should capitalize or expense.';
      systemChangeReq = 'No';
      ownerDecisionReq = 'YES (Align GL posting with costing layer)';
    } else if (e.include_in_landed_cost === null) {
      // NULL records
      if (e.expense_category === 'loading_import') {
        proposedClassification = 'Policy Decision: Landed Cost vs P&L (Unloading / Coolie)';
        reason = `Warehouse / port unloading labor (kuli). Currently expensed to GL 5300/6900, but pulled into FIFO costing via NULL default. Should physical unloading be inventory cost or operating expense?`;
        systemChangeReq = 'YES (Stop COALESCE default to true)';
        ownerDecisionReq = 'YES (Decide capitalization policy)';
      } else {
        proposedClassification = 'Policy Decision: Landed Cost vs P&L (Freight & Clearance)';
        reason = `Freight & Broker clearance. Currently expensed to GL 5300, but pulled into FIFO costing via NULL default. Standard inventory accounting allows capitalization, but historical bookkeeping expensed it.`;
        systemChangeReq = 'YES (Stop COALESCE default to true)';
        ownerDecisionReq = 'YES (Decide capitalization policy)';
      }
    } else if (e.include_in_landed_cost === false) {
      proposedClassification = 'Operating Expense (GL 5300/6900)';
      reason = 'Explicitly marked FALSE. Correctly excluded from costing pool.';
      systemChangeReq = 'No';
      ownerDecisionReq = 'No';
    }
  } else {
    proposedClassification = 'Operating Expense / Other';
    reason = `Category ${e.expense_category}.`;
    systemChangeReq = 'No';
    ownerDecisionReq = 'No';
  }

  transactionRows.push({
    voucher: e.voucher_number,
    date: e.expense_date,
    supplier: payeeMap[e.voucher_number] || e.paid_by || '-',
    container: e.container_ref,
    category: e.expense_category,
    amount: Number(e.amount),
    gl_accounts: distinctAccounts.join(', ') || '-',
    include_in_landed_cost: e.include_in_landed_cost,
    included_in_fifo: costInPool > 0,
    fifo_amount: costInPool,
    current_treatment: currentGlTreatment,
    proposed_classification: proposedClassification,
    reason: reason,
    system_change_required: systemChangeReq,
    owner_decision_required: ownerDecisionReq
  });
}

// Also add Petty Cash transactions
for (const p of petty) {
  const inc = p.include_in_landed_cost !== false;
  const isC = isCap(p.expense_category);
  const fifoAmt = (isC && inc) ? Number(p.amount) : 0;
  
  transactionRows.push({
    voucher: p.transaction_number,
    date: p.transaction_date,
    supplier: p.paid_to || p.paid_by_staff_name || '-',
    container: p.container_ref,
    category: p.expense_category,
    amount: Number(p.amount),
    gl_accounts: '5300 / 6100 (Petty Cash)',
    include_in_landed_cost: p.include_in_landed_cost,
    included_in_fifo: fifoAmt > 0,
    fifo_amount: fifoAmt,
    current_treatment: 'Expensed via Petty Cash',
    proposed_classification: fifoAmt > 0 ? 'Policy Decision: Petty Cash Landed vs Operating' : 'Operating Expense (Staff Welfare)',
    reason: fifoAmt > 0 ? 'Petty cash payment pulled into FIFO layers via NULL default. Owner must decide whether petty cash is capitalized.' : 'Staff food/drink; properly excluded.',
    system_change_required: fifoAmt > 0 ? 'YES (Stop COALESCE default to true)' : 'No',
    owner_decision_required: fifoAmt > 0 ? 'YES' : 'No'
  });
}

// Also add Container Header Other Import Costs
for (const c of containers) {
  if (Number(c.other_import_costs || 0) > 0) {
    transactionRows.push({
      voucher: `HEADER-${c.container_ref.replace(/\s+/g, '-').slice(0, 15)}`,
      date: c.created_at.slice(0, 10),
      supplier: 'Container Header Field',
      container: c.container_ref,
      category: 'other_import_costs (header)',
      amount: Number(c.other_import_costs),
      gl_accounts: 'NONE (No Journal Entry)',
      include_in_landed_cost: 'N/A (Header)',
      included_in_fifo: true,
      fifo_amount: Number(c.other_import_costs),
      current_treatment: 'Not in Accounting (Costing Only)',
      proposed_classification: 'Software Defect / Unbacked Estimate',
      reason: 'Manual estimate on container header before expense system. No voucher, invoice, or GL entry exists. Pulled into FIFO layers without audit trail.',
      system_change_required: 'YES (Remove or quarantine header estimate)',
      owner_decision_required: 'YES (Confirm whether any real unpaid invoice exists)'
    });
  }
}

fs.writeFileSync('/tmp/final_transaction_report.json', JSON.stringify(transactionRows, null, 2));
console.log('Saved final transaction report with rows:', transactionRows.length);
