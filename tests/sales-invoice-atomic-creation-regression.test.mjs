import assert from 'node:assert/strict';
import fs from 'node:fs';

const sql = fs.readFileSync('supabase/migrations/20260827130000_atomic_sales_invoice_creation.sql', 'utf8');
const sales = fs.readFileSync('src/pages/Sales.tsx', 'utf8');

assert.match(sql, /CREATE OR REPLACE FUNCTION public\.create_sales_invoice_atomic/);
assert.match(sql, /INSERT INTO public\.sales_invoices/);
assert.match(sql, /INSERT INTO public\.sales_invoice_items/);
assert.match(sql, /v_subtotal := v_subtotal/);
assert.match(sql, /Invoice totals do not match persisted product lines/);
assert.match(sql, /EXCEPTION|RAISE EXCEPTION/);
assert.match(sql, /REVOKE ALL ON FUNCTION public\.create_sales_invoice_atomic/);
assert.match(sales, /supabase\.rpc\('create_sales_invoice_atomic'/);
assert.doesNotMatch(sales, /from\('sales_invoices'\)\s*\.insert\(\[\{/s);

console.log('atomic sales invoice creation regression checks passed');
