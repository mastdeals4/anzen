import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const migration = fs.readFileSync('supabase/migrations/20260903150000_fix_sales_profitability_effective_cogs.sql', 'utf8');
const reports = fs.readFileSync('src/pages/reports/Reports.tsx', 'utf8');

test('sales profitability uses purchase cost for local batches and landed cost for imports', () => {
  assert.match(migration, /WHEN b\.import_container_id IS NULL\s+THEN NULLIF\(b\.import_price_per_unit, 0\)/);
  assert.match(migration, /WHEN b\.landed_cost_per_unit > 0\s+THEN b\.landed_cost_per_unit/);
  assert.doesNotMatch(migration, /COALESCE\(b\.landed_cost_per_unit, b\.import_price_per_unit\)/);
});

test('all profitability report RPCs expose line coverage and use the shared cost rule', () => {
  for (const fn of ['get_sales_profit_summary', 'get_sales_profit_drilldown', 'get_monthly_sales_report', 'get_product_performance_report', 'get_customer_sales_report', 'get_expense_vs_profit_report']) {
    assert.match(migration, new RegExp(`CREATE OR REPLACE FUNCTION public\\.${fn}`));
  }
  assert.match(migration, /costed_lines, total_lines/);
  assert.match(reports, /Cost coverage: \{costed\} \/ \{total\} lines/);
});
