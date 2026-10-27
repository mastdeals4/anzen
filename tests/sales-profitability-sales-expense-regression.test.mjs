import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const sql = fs.readFileSync('supabase/migrations/20260905270000_restore_sales_expense_profitability.sql', 'utf8');

test('sales expense resolver uses approved delivery and loading expenses', () => {
  assert.match(sql, /get_sales_profitability_line_expenses/);
  assert.match(sql, /expense_category IN \('delivery_sales', 'loading_sales'\)/);
  assert.match(sql, /approval_status = 'approved'/);
});

test('linked sales expenses are allocated from complete delivery-challan evidence', () => {
  assert.match(sql, /dc_totals/);
  assert.match(sql, /total_sales/);
  assert.match(sql, /ROUND\(e\.total_expense \* s\.line_sales \/ d\.total_sales, 2\)/);
  assert.match(sql, /WHEN d\.total_qty > 0/);
});

test('company and monthly profitability expose allocated and unallocated expenses', () => {
  assert.match(sql, /'sales_expenses',c\.sales_expenses/);
  assert.match(sql, /'unallocated_sales_expenses',c\.unallocated_sales_expenses/);
  assert.match(sql, /SUM\(sales_expense\) sales_expenses/);
  assert.match(sql, /fe\.expense_date BETWEEN p_start_date AND p_end_date/);
});

test('drilldowns use the same line expense resolver', () => {
  assert.match(sql, /get_sales_profitability_product_batches/);
  assert.match(sql, /get_sales_profitability_batch_orders/);
  assert.match(sql, /LEFT JOIN public\.get_sales_profitability_line_expenses/);
  assert.match(sql, /line_sales_expense/);
});

test('migration is report-only', () => {
  assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE)\s+INTO\s+(public\.)?(finance_expenses|journal_entries|journal_entry_lines|sales_invoices|sales_invoice_items|batches)\b/i);
});
