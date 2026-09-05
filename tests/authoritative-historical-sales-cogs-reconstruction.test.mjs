import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const reconstructionSql = fs.readFileSync(
  'supabase/migrations/20260905230000_authoritative_historical_sales_cogs_reconstruction.sql',
  'utf8',
);
const productAttributionSql = fs.readFileSync(
  'supabase/migrations/20260905240000_single_product_invoice_cogs_attribution.sql',
  'utf8',
);
const sql = `${reconstructionSql}\n${productAttributionSql}`;
const ui = fs.readFileSync('src/pages/reports/CanonicalSalesProfitReport.tsx', 'utf8');

test('shared resolver has the authoritative historical COGS waterfall', () => {
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.get_authoritative_sales_line_cogs/i);
  assert.match(sql, /WHEN r\.snapshot_cogs IS NOT NULL THEN r\.snapshot_cogs/);
  assert.match(sql, /r\.invoice_line_count = 1 AND r\.invoice_posted_cogs IS NOT NULL/);
  assert.match(sql, /single_product_proven_allocation/);
  assert.match(sql, /multi_product_proven_allocation/);
  assert.match(sql, /ELSE 'unresolved'/);
});

test('multi-line reconstruction is constrained by a strict Rp1.00 accounting tolerance', () => {
  assert.match(sql, /Rp1\.00/);
  assert.match(sql, /ABS\(r\.unresolved_base_cost_total - r\.residual_posted_cogs\) <= 1\.00/g);
  assert.doesNotMatch(sql, /0\.5%/);
});

test('single-product multi-line invoices attribute posted COGS at product level', () => {
  assert.match(productAttributionSql, /MAX\(invoice_product_count\) = 1/);
  assert.match(productAttributionSql, /THEN MAX\(posted_invoice_cogs\)/);
});

test('company and monthly totals remain tied to active posted GL 5100 COGS', () => {
  assert.match(sql, /je\.source_module = 'sales_invoice_cogs'/);
  assert.match(sql, /je\.is_posted = true/);
  assert.match(sql, /NOT COALESCE\(je\.is_reversed, false\)/);
  assert.match(sql, /coa\.code = '5100'/);
});

test('every product and batch drilldown uses the shared resolver', () => {
  assert.match(sql, /get_sales_profitability_summary[\s\S]*get_authoritative_sales_line_cogs/);
  assert.match(sql, /get_sales_profitability_product_batches[\s\S]*get_authoritative_sales_line_cogs/);
  assert.match(sql, /get_sales_profitability_batch_orders[\s\S]*get_authoritative_sales_line_cogs/);
});

test('the migration is read-only with respect to historical accounting data', () => {
  assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE)\s+(?:INTO\s+)?public\.(?:journal_entries|journal_entry_lines|sales_invoices|sales_invoice_items|batches|inventory_transactions)/i);
  assert.match(ui, /Cost unavailable/);
  assert.match(ui, /Partial coverage/);
});

test('current batch costs are evidence only and never replace company or monthly posted COGS', () => {
  assert.match(reconstructionSql, /base_line_cost \* \(r\.residual_posted_cogs \/ r\.unresolved_base_cost_total\)/);
  assert.match(productAttributionSql, /COALESCE\(SUM\(posted_invoice_cogs\),0\) AS product_cost/);
});
