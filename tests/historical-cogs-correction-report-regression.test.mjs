import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const sql = readFileSync(new URL('../supabase/migrations/20260905260000_include_active_historical_cogs_corrections.sql', import.meta.url), 'utf8');
const ui = readFileSync(new URL('../src/pages/reports/CanonicalSalesProfitReport.tsx', import.meta.url), 'utf8');

test('effective invoice COGS includes active posted historical correction evidence', () => {
  assert.match(sql, /je\.source_module = 'sales_invoice_cogs'/);
  assert.match(sql, /historical_cogs_correction/);
  assert.match(sql, /historical_cogs_final_correction/);
  assert.match(sql, /je\.is_posted = true/);
  assert.match(sql, /NOT COALESCE\(je\.is_reversed, false\)/);
  assert.match(sql, /SUM\(cogs_amount\) AS posted_invoice_cogs/);
});

test('single-product attribution uses the complete active invoice evidence', () => {
  assert.match(sql, /r\.invoice_line_count = 1 AND r\.invoice_posted_cogs IS NOT NULL/);
  assert.match(sql, /r\.posted_item_cogs IS NOT NULL THEN r\.posted_item_cogs/);
  assert.match(sql, /ABS\(r\.unresolved_base_cost_total - r\.residual_posted_cogs\) <= 1\.00/);
});

test('unresolved lines remain NULL and do not fabricate zero cost', () => {
  assert.match(sql, /ELSE NULL END AS authoritative_cogs/);
  assert.match(sql, /SUM\(COALESCE\(posted_item_cogs, snapshot_cogs\)\)/);
  assert.doesNotMatch(sql, /COALESCE\(r\.authoritative_cogs, 0\)/);
});

test('report correction is read-only and does not modify accounting data', () => {
  assert.doesNotMatch(sql, /INSERT INTO|UPDATE public\.|DELETE FROM/i);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.get_authoritative_sales_line_cogs/);
});

test('partial products display known proven COGS without fabricating a margin', () => {
  assert.match(ui, /Known COGS \{formatCurrency\(p\.product_cost \?\? 0\)\}/);
  assert.match(ui, /Partial coverage/);
  assert.match(ui, /hasFullCostCoverage \? formatCurrency\(p\.profit_per_unit\) : '—'/);
  assert.match(ui, /p\.costed_lines === p\.total_lines \? p\.profit_margin_pct : null/);
});
