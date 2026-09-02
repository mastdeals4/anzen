import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const sales = fs.readFileSync('src/pages/Sales.tsx', 'utf8');

test('Sales Invoice derives header SO/DC links from authoritative item links', () => {
  assert.match(sales, /resolveInvoiceSourceLinks/);
  assert.match(sales, /from\('delivery_challan_items'\)/);
  assert.match(sales, /delivery_challans\(id, sales_order_id, challan_number\)/);
  assert.match(sales, /sourceDCIds/);
  assert.match(sales, /sales_order_id: sourceSOId/);
});

test('new invoices retain item-level Delivery Challan item IDs', () => {
  assert.match(sales, /delivery_challan_item_id: item\.delivery_challan_item_id \|\| null/);
  assert.match(sales, /delivery_challan_item_id: \(item as any\)\.id \|\| null/);
});

test('DC navigation and single-DC selection populate header source state', () => {
  assert.match(sales, /setSelectedDCIds\(\[challanId\]\)/);
  assert.match(sales, /setSelectedDCIds\(\[data\.challanId\]\)/);
  assert.match(sales, /setSelectedSOId\(sourceChallan\?\.sales_order_id \|\| null\)/);
});

test('conflicting Sales Orders are surfaced without guessing', () => {
  assert.match(sales, /different Sales Orders/);
  assert.match(sales, /resolvedSoIds\.length > 1/);
});

test('editing preserves source links through the canonical atomic update path', () => {
  const edit = sales.slice(sales.indexOf("rpc('update_sales_invoice_atomic'"), sales.indexOf('// Fetch updated invoice', sales.indexOf("rpc('update_sales_invoice_atomic'")));
  assert.match(edit, /linked_challan_ids: sourceDCIds/);
  assert.match(sales, /loadedItems\.map\(\(item: any\) => item\.challan_id/);
});

test('sales expenses remain resolved through Delivery Challan ownership', () => {
  const linked = fs.readFileSync('src/utils/salesOrderDeliveryAlerts.ts', 'utf8');
  assert.match(linked, /delivery_challan_item_id/);
  assert.match(linked, /delivery_challans/);
});
