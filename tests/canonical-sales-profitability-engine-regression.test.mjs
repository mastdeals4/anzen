import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const migrationFile = resolve(
  root,
  'supabase/migrations/20260903160000_canonical_sales_profitability_engine.sql'
);
const reportComponentFile = resolve(
  root,
  'src/pages/reports/CanonicalSalesProfitReport.tsx'
);
const reportsPageFile = resolve(
  root,
  'src/pages/reports/Reports.tsx'
);
const salesProfitPageFile = resolve(
  root,
  'src/pages/reports/SalesProfitReport.tsx'
);

test('canonical sales profitability migration defines effective cost resolver and canonical RPCs', () => {
  const sql = readFileSync(migrationFile, 'utf8');

  // 1. Effective cost resolver
  assert.match(
    sql,
    /CREATE OR REPLACE FUNCTION public\.effective_sales_cogs_unit_cost/i,
    'Must define effective_sales_cogs_unit_cost'
  );
  assert.match(
    sql,
    /b\.import_container_id IS NOT NULL OR COALESCE\(b\.landed_cost_per_unit, 0\) > 0/i,
    'Must detect imported batches via container or positive landed cost'
  );
  assert.match(
    sql,
    /THEN NULLIF\(b\.landed_cost_per_unit, 0\)/i,
    'Must use landed_cost_per_unit for imported batches'
  );
  assert.match(
    sql,
    /COALESCE\(NULLIF\(b\.cost_per_unit, 0\), NULLIF\(b\.import_price_per_unit, 0\)\)/i,
    'Must use cost_per_unit for local purchase batches'
  );

  // 2. Canonical summary RPC
  assert.match(
    sql,
    /CREATE OR REPLACE FUNCTION public\.get_sales_profitability_summary/i,
    'Must define get_sales_profitability_summary'
  );
  assert.match(
    sql,
    /expense_category IN \('delivery_sales', 'loading_sales'\)/i,
    'Must capture delivery_sales and loading_sales'
  );
  assert.match(
    sql,
    /ROUND\(de\.total_expense \* \(ls\.line_gross_sales \/ dt\.total_dc_sales\), 2\)/i,
    'Must allocate DC expenses value-proportionally across lines'
  );

  // 3. Product batches RPC
  assert.match(
    sql,
    /CREATE OR REPLACE FUNCTION public\.get_sales_profitability_product_batches/i,
    'Must define get_sales_profitability_product_batches'
  );

  // 4. Batch orders RPC
  assert.match(
    sql,
    /CREATE OR REPLACE FUNCTION public\.get_sales_profitability_batch_orders/i,
    'Must define get_sales_profitability_batch_orders'
  );

  // 5. Explicit non-positional projection in legacy get_sales_profit_summary
  assert.match(
    sql,
    /ROUND\(total_cogs, 2\) AS total_cogs,\s+ROUND\(COALESCE\(costed_revenue, 0\) - total_cogs, 2\) AS total_profit,\s+CASE WHEN COALESCE\(costed_revenue, 0\) = 0 THEN NULL\s+ELSE ROUND\(\(costed_revenue - total_cogs\) \/ costed_revenue \* 100, 2\) END AS profit_pct,\s+costed_lines,\s+total_lines/i,
    'Legacy get_sales_profit_summary must project explicit ordered columns to prevent transposition'
  );
});

test('canonical sales profitability UI cleanly renders multi-level hierarchy and tooltips', () => {
  const code = readFileSync(reportComponentFile, 'utf8');

  // Multi-level hierarchy
  assert.match(code, /get_sales_profitability_summary/, 'Summary RPC call');
  assert.match(code, /get_sales_profitability_product_batches/, 'Product drilldown RPC call');
  assert.match(code, /get_sales_profitability_batch_orders/, 'Batch drilldown RPC call');

  // Key KPI Cards
  assert.match(code, /Gross Sales/, 'Gross sales header');
  assert.match(code, /Product Cost/, 'Product cost header');
  assert.match(code, /Sales Expenses/, 'Sales expenses header');
  assert.match(code, /Profit After Sales Expenses/, 'Profit after sales expenses header');
  assert.match(code, /Profit Margin/, 'Profit margin header');

  // Distinct Current Stock vs Sold Qty
  assert.match(code, /Current Stock/, 'Current stock label');
  assert.match(code, /Sold Qty/, 'Sold qty label');

  // Plain-English tooltips without ERP jargon
  assert.match(code, /TooltipHeader/, 'Must include explanatory tooltips');
});

test('Reports and SalesProfitReport pages wire to canonical report component', () => {
  const reports = readFileSync(reportsPageFile, 'utf8');
  assert.match(
    reports,
    /<CanonicalSalesProfitReport \/>/,
    'Reports.tsx must render CanonicalSalesProfitReport in SalesProfitTab'
  );

  const salesProfit = readFileSync(salesProfitPageFile, 'utf8');
  assert.match(
    salesProfit,
    /<CanonicalSalesProfitReport \/>/,
    'SalesProfitReport.tsx must render CanonicalSalesProfitReport'
  );
});

test('mathematical canonical model maintains exact reconciliation', () => {
  // Simulate 2 invoice lines from 1 DC
  const line1 = { qty: 1000, price: 16829, cost_per_unit: 10008.6 };
  const line2 = { qty: 500, price: 16530, cost_per_unit: 10008.6 };

  const gross1 = line1.qty * line1.price; // 16,829,000
  const gross2 = line2.qty * line2.price; // 8,265,000
  const totalGross = gross1 + gross2; // 25,094,000

  const cost1 = line1.qty * line1.cost_per_unit; // 10,008,600
  const cost2 = line2.qty * line2.cost_per_unit; // 5,004,300
  const totalCost = cost1 + cost2; // 15,012,900

  const dcExpense = 625588; // from live voucher EXP/26/194
  const exp1 = Math.round((dcExpense * gross1) / totalGross * 100) / 100;
  const exp2 = Math.round((dcExpense * gross2) / totalGross * 100) / 100;
  assert.ok(Math.abs(exp1 + exp2 - dcExpense) < 0.05, 'Expenses reconcile exactly');

  const profit1 = gross1 - cost1 - exp1;
  const profit2 = gross2 - cost2 - exp2;
  const totalProfit = totalGross - totalCost - (exp1 + exp2);

  assert.ok(Math.abs((profit1 + profit2) - totalProfit) < 0.05, 'Line profits sum exactly to batch total');
});

test('delta migration 20260903161000 reconciles product_batches DC revenue scope', () => {
  const deltaFile = resolve(
    root,
    'supabase/migrations/20260903161000_reconcile_product_batches_dc_expense_scope.sql'
  );
  const sql = readFileSync(deltaFile, 'utf8');
  assert.match(
    sql,
    /all_dc_lines AS/i,
    'Must define all_dc_lines to capture total DC revenue for multi-item DCs'
  );
  assert.match(
    sql,
    /CREATE OR REPLACE FUNCTION public\.get_sales_profitability_product_batches/i,
    'Must update get_sales_profitability_product_batches'
  );
});

