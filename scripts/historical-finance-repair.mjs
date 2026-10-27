// Historical finance repair runner.
//
// Usage:
//   SUPABASE_URL='...' SUPABASE_SERVICE_ROLE_KEY='...' node scripts/historical-finance-repair.mjs
//   SUPABASE_URL='...' SUPABASE_SERVICE_ROLE_KEY='...' node scripts/historical-finance-repair.mjs --apply
//
// Generates:
//   finance-repair-output/historical-finance-repair-report-before.json
//   finance-repair-output/historical-finance-repair-report-after.json
//   finance-repair-output/historical-finance-repair.sql
//   finance-repair-output/historical-finance-rollback.sql

import { createClient } from '@supabase/supabase-js';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const APPLY = process.argv.includes('--apply');
const REPAIR_DATE = '2026-06-03';
const RUN_PREFIX = 'HFR-260603';
const OUT_DIR = 'finance-repair-output';

const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.');
  process.exit(1);
}

const sb = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

async function fetchAll(table, select = '*', build = q => q) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    let q = sb.from(table).select(select).range(from, from + 999);
    q = build(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    if (!data?.length) break;
    rows.push(...data);
    if (data.length < 1000) break;
  }
  return rows;
}

function n(value) {
  return Number(value || 0);
}

function money(value) {
  return Math.round(n(value) * 100) / 100;
}

function sqlString(value) {
  if (value === null || value === undefined) return 'NULL';
  return `'${String(value).replaceAll("'", "''")}'`;
}

function sqlNumber(value) {
  return Number.isFinite(Number(value)) ? String(Number(value)) : '0';
}

function sqlDate(value) {
  return sqlString(value);
}

function sqlUuid(value) {
  return value ? sqlString(value) : 'NULL';
}

function sqlJson(value) {
  return `${sqlString(JSON.stringify(value))}::jsonb`;
}

async function loadSnapshot() {
  const [coa, journalEntries, journalLines, invoices, invoiceItems, batches, products, dcItems] = await Promise.all([
    fetchAll('chart_of_accounts', 'id,code,name,account_type'),
    fetchAll('journal_entries', 'id,entry_number,entry_date,source_module,reference_id,reference_number,description,total_debit,total_credit,is_posted,created_by', q => q.eq('is_posted', true)),
    fetchAll('journal_entry_lines', 'id,journal_entry_id,line_number,account_id,description,debit,credit,customer_id,supplier_id,batch_id'),
    fetchAll('sales_invoices', 'id,invoice_number,invoice_date,payment_status,total_amount,journal_entry_id,is_draft,customer_id,created_by'),
    fetchAll('sales_invoice_items', 'id,invoice_id,batch_id,quantity,delivery_challan_item_id'),
    fetchAll('batches', 'id,batch_number,product_id,import_quantity,current_stock,landed_cost_per_unit,cost_per_unit,import_price,updated_at'),
    fetchAll('products', 'id,product_name,product_code,current_stock'),
    fetchAll('delivery_challan_items', 'id,batch_id,quantity'),
  ]);

  const byId = rows => new Map(rows.map(row => [row.id, row]));
  const coaByCode = new Map(coa.map(row => [row.code, row]));
  const coaById = byId(coa);
  const batchesById = byId(batches);
  const productsById = byId(products);
  const linesByJe = new Map();
  const itemsByInvoice = new Map();

  for (const line of journalLines) {
    if (!linesByJe.has(line.journal_entry_id)) linesByJe.set(line.journal_entry_id, []);
    linesByJe.get(line.journal_entry_id).push(line);
  }
  for (const item of invoiceItems) {
    if (!itemsByInvoice.has(item.invoice_id)) itemsByInvoice.set(item.invoice_id, []);
    itemsByInvoice.get(item.invoice_id).push(item);
  }

  return {
    coa, coaByCode, coaById, journalEntries, journalLines, invoices, invoiceItems,
    batches, batchesById, products, productsById, dcItems, linesByJe, itemsByInvoice,
  };
}

function computeReport(s) {
  const cogsAccount = s.coaByCode.get('5100');
  const inventoryAccount = s.coaByCode.get('1130');
  const prepaidAccount = s.coaByCode.get('1140');
  const cogsPostedByInvoice = new Map();

  for (const je of s.journalEntries) {
    if (!je.reference_id) continue;
    const lines = s.linesByJe.get(je.id) || [];
    const cogsDebit = lines
      .filter(line => line.account_id === cogsAccount?.id)
      .reduce((sum, line) => sum + n(line.debit) - n(line.credit), 0);
    if (cogsDebit > 0 || je.source_module === 'sales_invoice_cogs') {
      cogsPostedByInvoice.set(je.reference_id, n(cogsPostedByInvoice.get(je.reference_id)) + cogsDebit);
    }
  }

  const cogsIssues = [];
  for (const invoice of s.invoices) {
    if (invoice.is_draft || !['pending', 'partial', 'paid'].includes(String(invoice.payment_status || '').toLowerCase())) continue;

    let expectedCogs = 0;
    const evidence = [];
    for (const item of s.itemsByInvoice.get(invoice.id) || []) {
      const batch = s.batchesById.get(item.batch_id);
      if (!batch) continue;
      const cost = n(batch.landed_cost_per_unit ?? batch.cost_per_unit ?? 0);
      const quantity = n(item.quantity);
      const value = quantity * cost;
      const product = s.productsById.get(batch.product_id);
      expectedCogs += value;
      evidence.push({
        batch_id: batch.id,
        batch_number: batch.batch_number,
        product_name: product?.product_name,
        quantity,
        landed_cost_per_unit: cost,
        value: money(value),
      });
    }

    if (expectedCogs <= 0) continue;
    const postedCogs = n(cogsPostedByInvoice.get(invoice.id));
    const delta = money(expectedCogs - postedCogs);
    if (Math.abs(delta) > 0.01) {
      cogsIssues.push({
        invoice_id: invoice.id,
        invoice_number: invoice.invoice_number,
        invoice_date: invoice.invoice_date,
        customer_id: invoice.customer_id,
        created_by: invoice.created_by,
        expected_cogs: money(expectedCogs),
        posted_cogs: money(postedCogs),
        correction_amount: delta,
        is_test_invoice: invoice.invoice_number.startsWith('TEST-'),
        evidence,
      });
    }
  }

  const unbalanced = s.journalEntries
    .filter(je => Math.abs(n(je.total_debit) - n(je.total_credit)) > 0.01)
    .map(je => {
      const lines = (s.linesByJe.get(je.id) || []).map(line => ({
        id: line.id,
        line_number: line.line_number,
        account: `${s.coaById.get(line.account_id)?.code || '?'} ${s.coaById.get(line.account_id)?.name || ''}`.trim(),
        debit: n(line.debit),
        credit: n(line.credit),
        description: line.description,
      }));
      return {
        id: je.id,
        entry_number: je.entry_number,
        entry_date: je.entry_date,
        source_module: je.source_module,
        reference_id: je.reference_id,
        reference_number: je.reference_number,
        total_debit: n(je.total_debit),
        total_credit: n(je.total_credit),
        delta_debit_minus_credit: money(n(je.total_debit) - n(je.total_credit)),
        max_line_number: Math.max(0, ...lines.map(line => n(line.line_number))),
        lines,
      };
    });

  let inventoryGl = 0;
  for (const line of s.journalLines) {
    if (line.account_id !== inventoryAccount?.id) continue;
    const je = s.journalEntries.find(row => row.id === line.journal_entry_id);
    if (!je?.is_posted) continue;
    inventoryGl += n(line.debit) - n(line.credit);
  }

  const batchValuation = s.batches.reduce((sum, batch) => {
    const cost = n(batch.landed_cost_per_unit ?? batch.cost_per_unit ?? batch.import_price ?? 0);
    return sum + n(batch.current_stock) * cost;
  }, 0);

  const dcByBatch = new Map();
  const invoiceQtyByBatch = new Map();
  for (const item of s.dcItems) dcByBatch.set(item.batch_id, n(dcByBatch.get(item.batch_id)) + n(item.quantity));
  for (const item of s.invoiceItems) invoiceQtyByBatch.set(item.batch_id, n(invoiceQtyByBatch.get(item.batch_id)) + n(item.quantity));

  const stockTargets = ['4001/1101/25/A-3147', '250816w2'];
  const stockIssues = s.batches
    .filter(batch => stockTargets.includes(batch.batch_number))
    .map(batch => {
      const delivered = n(dcByBatch.get(batch.id));
      const invoiced = n(invoiceQtyByBatch.get(batch.id));
      const physicalExpectedStock = n(batch.import_quantity) - delivered;
      const adjustmentQuantity = physicalExpectedStock - n(batch.current_stock);
      const product = s.productsById.get(batch.product_id);
      return {
        batch_id: batch.id,
        batch_number: batch.batch_number,
        product_id: batch.product_id,
        product_name: product?.product_name,
        product_current_stock: n(product?.current_stock),
        import_quantity: n(batch.import_quantity),
        current_stock: n(batch.current_stock),
        delivered,
        invoiced,
        physical_expected_stock: physicalExpectedStock,
        adjustment_quantity: adjustmentQuantity,
        landed_cost_per_unit: n(batch.landed_cost_per_unit ?? batch.cost_per_unit ?? batch.import_price ?? 0),
        valuation_impact: money(adjustmentQuantity * n(batch.landed_cost_per_unit ?? batch.cost_per_unit ?? batch.import_price ?? 0)),
      };
    });

  const trialBalance = s.journalLines.reduce((sum, line) => sum + n(line.debit) - n(line.credit), 0);

  return {
    generated_at: new Date().toISOString(),
    accounts: {
      cogs_5100: cogsAccount,
      inventory_1130: inventoryAccount,
      prepaid_1140_used_for_missing_ppn_input: prepaidAccount,
      ppn_input_1150_exists: Boolean(s.coaByCode.get('1150')),
    },
    missing_cogs: {
      count: cogsIssues.length,
      total_expected_cogs: money(cogsIssues.reduce((sum, row) => sum + row.expected_cogs, 0)),
      total_posted_cogs_on_affected_invoices: money(cogsIssues.reduce((sum, row) => sum + row.posted_cogs, 0)),
      total_correction: money(cogsIssues.reduce((sum, row) => sum + row.correction_amount, 0)),
      test_invoice_correction_total: money(cogsIssues.filter(row => row.is_test_invoice).reduce((sum, row) => sum + row.correction_amount, 0)),
      issues: cogsIssues.sort((a, b) => Math.abs(b.correction_amount) - Math.abs(a.correction_amount)),
    },
    unbalanced_journals: {
      count: unbalanced.length,
      total_delta_debit_minus_credit: money(unbalanced.reduce((sum, row) => sum + row.delta_debit_minus_credit, 0)),
      issues: unbalanced,
    },
    inventory: {
      account_1130_gl: money(inventoryGl),
      batch_valuation: money(batchValuation),
      variance_gl_minus_batch: money(inventoryGl - batchValuation),
    },
    physical_stock_targets: stockIssues,
    trial_balance_delta_debit_minus_credit: money(trialBalance),
  };
}

function buildPlan(report) {
  const cogs = report.missing_cogs.issues.map((issue, index) => {
    const jeId = randomUUID();
    return {
      kind: 'cogs',
      issue,
      je: {
        id: jeId,
        entry_number: `${RUN_PREFIX}-COGS-${String(index + 1).padStart(3, '0')}`,
        entry_date: issue.invoice_date,
        source_module: 'historical_cogs_correction',
        reference_id: issue.invoice_id,
        reference_number: issue.invoice_number,
        description: `Historical COGS correction for ${issue.invoice_number}; additive repair ${RUN_PREFIX}`,
        total_debit: issue.correction_amount,
        total_credit: issue.correction_amount,
        is_posted: true,
        posted_at: new Date().toISOString(),
        created_by: issue.created_by,
      },
      lines: [
        {
          id: randomUUID(),
          journal_entry_id: jeId,
          line_number: 1,
          account_id: report.accounts.cogs_5100.id,
          description: `Historical COGS correction - ${issue.invoice_number}`,
          debit: issue.correction_amount,
          credit: 0,
          customer_id: issue.customer_id,
        },
        {
          id: randomUUID(),
          journal_entry_id: jeId,
          line_number: 2,
          account_id: report.accounts.inventory_1130.id,
          description: `Historical inventory credit for COGS correction - ${issue.invoice_number}`,
          debit: 0,
          credit: issue.correction_amount,
          customer_id: issue.customer_id,
        },
      ],
    };
  });

  const unbalancedByNumber = new Map(report.unbalanced_journals.issues.map(row => [row.entry_number, row]));
  const balanceSpecs = [
    {
      entry_number: 'JE-2511-0002',
      account_id: report.accounts.prepaid_1140_used_for_missing_ppn_input.id,
      description: `Corrective balancing debit for missing 11% PPN input; additive repair ${RUN_PREFIX}`,
    },
    {
      entry_number: 'JE-2510-0002',
      account_id: report.accounts.prepaid_1140_used_for_missing_ppn_input.id,
      description: `Corrective balancing debit for missing 11% PPN input; additive repair ${RUN_PREFIX}`,
    },
    {
      entry_number: 'JE-2509-0002',
      account_id: report.accounts.inventory_1130.id,
      description: `Corrective balancing credit for duplicate inventory debit; additive repair ${RUN_PREFIX}`,
    },
  ];

  const balancing = balanceSpecs.map(spec => {
    const issue = unbalancedByNumber.get(spec.entry_number);
    if (!issue) throw new Error(`Expected unbalanced journal not found: ${spec.entry_number}`);
    const delta = issue.delta_debit_minus_credit;
    const debit = delta < 0 ? Math.abs(delta) : 0;
    const credit = delta > 0 ? delta : 0;
    return {
      kind: 'balance_line',
      issue,
      line: {
        id: randomUUID(),
        journal_entry_id: issue.id,
        line_number: issue.max_line_number + 1,
        account_id: spec.account_id,
        description: spec.description,
        debit: money(debit),
        credit: money(credit),
      },
      headerUpdate: {
        id: issue.id,
        old_total_debit: issue.total_debit,
        old_total_credit: issue.total_credit,
        new_total_debit: money(issue.total_debit + debit),
        new_total_credit: money(issue.total_credit + credit),
      },
    };
  });

  const stock = report.physical_stock_targets
    .filter(issue => Math.abs(issue.adjustment_quantity) > 0.001)
    .map(issue => ({
      kind: 'stock',
      issue,
      transaction: {
        id: randomUUID(),
        batch_id: issue.batch_id,
        product_id: issue.product_id,
        transaction_type: 'adjustment',
        quantity: issue.adjustment_quantity,
        reference_type: 'historical_stock_adjustment',
        reference_id: issue.batch_id,
        reference_number: `${RUN_PREFIX}-STOCK`,
        transaction_date: REPAIR_DATE,
        notes: `Historical physical stock correction for batch ${issue.batch_number}; current ${issue.current_stock}, delivered ${issue.delivered}, import ${issue.import_quantity}; additive repair ${RUN_PREFIX}`,
        stock_before: issue.current_stock,
        stock_after: issue.physical_expected_stock,
        metadata: {
          repair_run: RUN_PREFIX,
          product_name: issue.product_name,
          batch_number: issue.batch_number,
          import_quantity: issue.import_quantity,
          delivered: issue.delivered,
          invoiced: issue.invoiced,
          valuation_impact: issue.valuation_impact,
        },
      },
      batchUpdate: {
        id: issue.batch_id,
        old_current_stock: issue.current_stock,
        new_current_stock: issue.physical_expected_stock,
      },
      productUpdate: {
        id: issue.product_id,
        old_current_stock: issue.product_current_stock,
        new_current_stock: issue.product_current_stock + issue.adjustment_quantity,
      },
    }));

  return { cogs, balancing, stock };
}

function renderRepairSql(plan) {
  const parts = [];
  parts.push('-- Historical finance repair SQL generated by scripts/historical-finance-repair.mjs');
  parts.push('-- Generated before live application. Do not rerun without checking for duplicate HFR-260603 rows.');
  parts.push('BEGIN;');

  for (const item of plan.cogs) {
    const je = item.je;
    parts.push(`
INSERT INTO journal_entries (id, entry_number, entry_date, source_module, reference_id, reference_number, description, total_debit, total_credit, is_posted, posted_at, created_by)
VALUES (${sqlUuid(je.id)}, ${sqlString(je.entry_number)}, ${sqlDate(je.entry_date)}, ${sqlString(je.source_module)}, ${sqlUuid(je.reference_id)}, ${sqlString(je.reference_number)}, ${sqlString(je.description)}, ${sqlNumber(je.total_debit)}, ${sqlNumber(je.total_credit)}, true, ${sqlString(je.posted_at)}, ${sqlUuid(je.created_by)});
`);
    for (const line of item.lines) {
      parts.push(`INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, description, debit, credit, customer_id)
VALUES (${sqlUuid(line.id)}, ${sqlUuid(line.journal_entry_id)}, ${sqlNumber(line.line_number)}, ${sqlUuid(line.account_id)}, ${sqlString(line.description)}, ${sqlNumber(line.debit)}, ${sqlNumber(line.credit)}, ${sqlUuid(line.customer_id)});`);
    }
  }

  for (const item of plan.balancing) {
    const line = item.line;
    parts.push(`
INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, description, debit, credit)
VALUES (${sqlUuid(line.id)}, ${sqlUuid(line.journal_entry_id)}, ${sqlNumber(line.line_number)}, ${sqlUuid(line.account_id)}, ${sqlString(line.description)}, ${sqlNumber(line.debit)}, ${sqlNumber(line.credit)});
UPDATE journal_entries
SET total_debit = ${sqlNumber(item.headerUpdate.new_total_debit)},
    total_credit = ${sqlNumber(item.headerUpdate.new_total_credit)}
WHERE id = ${sqlUuid(item.headerUpdate.id)};
`);
  }

  for (const item of plan.stock) {
    const tx = item.transaction;
    parts.push(`
INSERT INTO inventory_transactions (id, batch_id, product_id, transaction_type, quantity, reference_type, reference_id, reference_number, transaction_date, notes, stock_before, stock_after, metadata)
VALUES (${sqlUuid(tx.id)}, ${sqlUuid(tx.batch_id)}, ${sqlUuid(tx.product_id)}, ${sqlString(tx.transaction_type)}, ${sqlNumber(tx.quantity)}, ${sqlString(tx.reference_type)}, ${sqlUuid(tx.reference_id)}, ${sqlString(tx.reference_number)}, ${sqlDate(tx.transaction_date)}, ${sqlString(tx.notes)}, ${sqlNumber(tx.stock_before)}, ${sqlNumber(tx.stock_after)}, ${sqlJson(tx.metadata)});
UPDATE batches
SET current_stock = ${sqlNumber(item.batchUpdate.new_current_stock)},
    updated_at = now()
WHERE id = ${sqlUuid(item.batchUpdate.id)};
UPDATE products
SET current_stock = ${sqlNumber(item.productUpdate.new_current_stock)},
    updated_at = now()
WHERE id = ${sqlUuid(item.productUpdate.id)};
`);
  }

  parts.push('COMMIT;');
  return parts.join('\n');
}

function renderRollbackSql(plan) {
  const parts = [];
  parts.push('-- Rollback for HFR-260603 historical finance repair.');
  parts.push('-- Run only if the corresponding repair needs to be reversed.');
  parts.push('BEGIN;');

  for (const item of [...plan.stock].reverse()) {
    parts.push(`
UPDATE products
SET current_stock = ${sqlNumber(item.productUpdate.old_current_stock)},
    updated_at = now()
WHERE id = ${sqlUuid(item.productUpdate.id)};
UPDATE batches
SET current_stock = ${sqlNumber(item.batchUpdate.old_current_stock)},
    updated_at = now()
WHERE id = ${sqlUuid(item.batchUpdate.id)};
DELETE FROM inventory_transactions
WHERE id = ${sqlUuid(item.transaction.id)};
`);
  }

  for (const item of [...plan.balancing].reverse()) {
    parts.push(`
UPDATE journal_entries
SET total_debit = ${sqlNumber(item.headerUpdate.old_total_debit)},
    total_credit = ${sqlNumber(item.headerUpdate.old_total_credit)}
WHERE id = ${sqlUuid(item.headerUpdate.id)};
DELETE FROM journal_entry_lines
WHERE id = ${sqlUuid(item.line.id)};
`);
  }

  for (const item of [...plan.cogs].reverse()) {
    parts.push(`
DELETE FROM journal_entry_lines
WHERE journal_entry_id = ${sqlUuid(item.je.id)};
DELETE FROM journal_entries
WHERE id = ${sqlUuid(item.je.id)};
`);
  }

  parts.push('COMMIT;');
  return parts.join('\n');
}

async function ensureNotAlreadyApplied() {
  const { data, error } = await sb
    .from('journal_entries')
    .select('entry_number')
    .like('entry_number', `${RUN_PREFIX}-%`)
    .limit(1);
  if (error) throw new Error(`journal_entries duplicate guard: ${error.message}`);
  if (data?.length) throw new Error(`Repair appears already applied; found ${data[0].entry_number}`);

  const { data: txs, error: txError } = await sb
    .from('inventory_transactions')
    .select('reference_number')
    .eq('reference_number', `${RUN_PREFIX}-STOCK`)
    .limit(1);
  if (txError) throw new Error(`inventory_transactions duplicate guard: ${txError.message}`);
  if (txs?.length) throw new Error(`Stock repair appears already applied; found ${txs[0].reference_number}`);
}

async function insertOrThrow(table, rows) {
  const { error } = await sb.from(table).insert(rows);
  if (error) throw new Error(`${table} insert failed: ${error.message}`);
}

async function updateOrThrow(table, values, id) {
  const { error } = await sb.from(table).update(values).eq('id', id);
  if (error) throw new Error(`${table} update failed for ${id}: ${error.message}`);
}

async function applyPlan(plan) {
  await ensureNotAlreadyApplied();

  for (const item of plan.cogs) {
    await insertOrThrow('journal_entries', [item.je]);
    await insertOrThrow('journal_entry_lines', item.lines);
  }

  for (const item of plan.balancing) {
    await insertOrThrow('journal_entry_lines', [item.line]);
    await updateOrThrow('journal_entries', {
      total_debit: item.headerUpdate.new_total_debit,
      total_credit: item.headerUpdate.new_total_credit,
    }, item.headerUpdate.id);
  }

  for (const item of plan.stock) {
    await insertOrThrow('inventory_transactions', [item.transaction]);
    await updateOrThrow('batches', { current_stock: item.batchUpdate.new_current_stock, updated_at: new Date().toISOString() }, item.batchUpdate.id);
    await updateOrThrow('products', { current_stock: item.productUpdate.new_current_stock, updated_at: new Date().toISOString() }, item.productUpdate.id);
  }
}

function summarize(report, plan) {
  return {
    missing_cogs_correction_count: plan.cogs.length,
    missing_cogs_correction_total: report.missing_cogs.total_correction,
    unbalanced_journal_count: report.unbalanced_journals.count,
    unbalanced_journal_total_delta: report.unbalanced_journals.total_delta_debit_minus_credit,
    stock_adjustment_count: plan.stock.length,
    stock_valuation_impact: money(plan.stock.reduce((sum, item) => sum + item.issue.valuation_impact, 0)),
    inventory_gl: report.inventory,
    trial_balance_delta_debit_minus_credit: report.trial_balance_delta_debit_minus_credit,
  };
}

await mkdir(OUT_DIR, { recursive: true });
const beforeSnapshot = await loadSnapshot();
const beforeReport = computeReport(beforeSnapshot);
const plan = buildPlan(beforeReport);

await writeFile(`${OUT_DIR}/historical-finance-repair-report-before.json`, JSON.stringify({ summary: summarize(beforeReport, plan), report: beforeReport, plan }, null, 2));
await writeFile(`${OUT_DIR}/historical-finance-repair.sql`, renderRepairSql(plan));
await writeFile(`${OUT_DIR}/historical-finance-rollback.sql`, renderRollbackSql(plan));

console.log('BEFORE SUMMARY');
console.log(JSON.stringify(summarize(beforeReport, plan), null, 2));
console.log(`Generated ${OUT_DIR}/historical-finance-repair.sql`);
console.log(`Generated ${OUT_DIR}/historical-finance-rollback.sql`);

if (!APPLY) {
  console.log('Dry run only. Re-run with --apply to apply the repair.');
  process.exit(0);
}

await applyPlan(plan);

const afterSnapshot = await loadSnapshot();
const afterReport = computeReport(afterSnapshot);
await writeFile(`${OUT_DIR}/historical-finance-repair-report-after.json`, JSON.stringify({ summary: summarize(afterReport, { cogs: [], balancing: [], stock: [] }), report: afterReport }, null, 2));

console.log('AFTER SUMMARY');
console.log(JSON.stringify(summarize(afterReport, { cogs: [], balancing: [], stock: [] }), null, 2));
console.log('Applied historical finance repair.');
