import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const sales = fs.readFileSync('src/pages/Sales.tsx', 'utf8');

test('Sales Invoice derives header SO/DC links from authoritative item links', () => {
  assert.match(sales, /resolveInvoiceSourceLinks/);
  assert.match(sales, /from\('delivery_challan_items'\)/);
  assert.match(sales, /delivery_challans\(id, sales_order_id, challan_number/);
  assert.match(sales, /sourceDCIds/);
  assert.match(sales, /sales_order_id: sourceSOId/);
});

test('new invoices retain item-level Delivery Challan item IDs', () => {
  assert.match(sales, /delivery_challan_item_id: item\.delivery_challan_item_id \|\| null/);
  assert.match(sales, /delivery_challan_item_id: \(item as any\)\.id \|\| null/);
  assert.match(sales, /Every invoice line must have a source Delivery Challan item/);
});

test('new invoice item payload does not read an invoice header before atomic creation', () => {
  const creation = sales.slice(
    sales.indexOf('// Filter and map only valid items (with product_id)'),
    sales.indexOf("supabase.rpc('create_sales_invoice_atomic'"),
  );

  assert.doesNotMatch(creation, /invoice_id:\s*invoice\.id/);
  assert.match(creation, /delivery_challan_item_id: item\.delivery_challan_item_id/);
});

test('DC navigation and single-DC selection populate header source state', () => {
  assert.match(sales, /setSelectedDCIds\(\[challanId\]\)/);
  assert.match(sales, /setSelectedDCIds\(\[data\.challanId\]\)/);
  assert.match(sales, /setSelectedSOId\(sourceChallan\?\.sales_order_id \|\| null\)/);
  assert.match(sales, /loadPendingDCOptions\(data\.customerId\)/);
  assert.match(sales, /loadCustomerSalesOrders\(data\.customerId\)/);
});

test('DC-linked Sales Order PO number is carried into invoice creation', () => {
  assert.match(sales, /from\('sales_orders'\)/);
  assert.match(sales, /select\('po_number'\)/);
  assert.match(sales, /setFormData\(prev => \(\{ \.\.\.prev, po_number: linkedSO\.po_number \}\)\)/);
});

test('Sales Order selection carries PO number and requires Delivery Challans', () => {
  const soSelect = sales.slice(
    sales.indexOf('const handleSalesOrderSelect ='),
    sales.indexOf('const loadPendingDCOptions =', sales.indexOf('const handleSalesOrderSelect =')),
  );
  assert.match(soSelect, /salesOrder\?\.po_number/);
  assert.match(soSelect, /setFormData\(prev => \(\{ \.\.\.prev, po_number: salesOrder\.po_number/);
  assert.match(soSelect, /from\('delivery_challans'\)/);
  assert.match(soSelect, /eq\('sales_order_id', salesOrderId\)/);
  assert.match(soSelect, /eq\('approval_status', 'approved'\)/);
  assert.doesNotMatch(soSelect, /delivery_challan_item_id: null/);
});

test('Sales Order without a PO leaves manual invoice entry available', () => {
  assert.match(sales, /if \(linkedSO\?\.po_number\)/);
  assert.match(sales, /po_number: ''/);
});

test('conflicting Sales Orders are surfaced without guessing', () => {
  assert.match(sales, /different Sales Orders/);
  assert.match(sales, /resolvedSoIds\.length > 1/);
  assert.match(sales, /conflicting PO numbers/);
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
