import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const sales = fs.readFileSync('src/pages/Sales.tsx', 'utf8');
const snapshotMigration = fs.readFileSync('supabase/migrations/20260827110000_enforce_canonical_new_document_snapshots.sql', 'utf8');
const invoiceDisplay = fs.readFileSync('src/utils/invoiceItemDisplay.ts', 'utf8');

test('invoice creation refuses an empty product table and verifies inserted rows', () => {
  assert.match(sales, /Invoice cannot be saved because its product table is empty/);
  assert.match(sales, /invoiceItemsData\.length === 0/);
  assert.match(sales, /Invoice product rows were empty; no invoice was created/);
  assert.match(sales, /create_sales_invoice_atomic/);
});

test('invoice PDF read path hydrates authoritative invoice items, products, batches and DCs', () => {
  assert.match(invoiceDisplay, /sales_invoice_items/);
  assert.match(invoiceDisplay, /delivery_challan_item_id/);
  assert.match(invoiceDisplay, /products/);
  assert.match(invoiceDisplay, /batches/);
  assert.match(invoiceDisplay, /challans/);
});

test('new documents always snapshot the effective company profile', () => {
  assert.match(snapshotMigration, /NEW\.company_snapshot := public\.get_current_company_profile\(\)/);
  assert.match(snapshotMigration, /no effective company profile exists/);
  assert.doesNotMatch(snapshotMigration, /UPDATE public\./);
});

test('invoice list detects financially populated invoices with missing product rows', () => {
  assert.match(sales, /item_integrity_status/);
  assert.match(sales, /missing_product_rows/);
});

test('customer/SO/DC source fields remain part of invoice creation', () => {
  assert.match(sales, /sales_order_id: selectedSOId/);
  assert.match(sales, /linked_challan_ids: selectedDCIds/);
  assert.match(sales, /delivery_challan_item_id: item\.delivery_challan_item_id/);
});
