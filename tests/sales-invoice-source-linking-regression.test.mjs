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
  assert.match(sales, /select\('customer_po_number'\)/);
  assert.match(sales, /setFormData\(prev => \(\{ \.\.\.prev, po_number: linkedSO\.customer_po_number \}\)\)/);
});

test('Sales Order selection carries PO number and requires Delivery Challans', () => {
  const soSelect = sales.slice(
    sales.indexOf('const handleSalesOrderSelect ='),
    sales.indexOf('const loadPendingDCOptions =', sales.indexOf('const handleSalesOrderSelect =')),
  );
  assert.match(soSelect, /salesOrder\?\.customer_po_number/);
  assert.match(soSelect, /from\('delivery_challans'\)/);
  assert.match(soSelect, /eq\('sales_order_id', salesOrderId\)/);
  assert.match(soSelect, /eq\('approval_status', 'approved'\)/);
  assert.doesNotMatch(soSelect, /delivery_challan_item_id: null/);
});

test('Sales Order without a PO leaves manual invoice entry available', () => {
  assert.match(sales, /if \(linkedSO\?\.customer_po_number\)/);
  assert.match(sales, /po_number: ''/);
});

test('Delivery Challan items inherit agreed unit price and customer PO from linked SO', () => {
  assert.match(sales, /sales_orders\(id, so_number, customer_po_number, sales_order_items\(id, product_id, unit_price, tax_percent\)\)/);
  assert.match(sales, /sales_order_items\(id, unit_price, tax_percent, product_id\)/);
  assert.match(sales, /soItem\?\.unit_price != null/);
  assert.match(sales, /unitPrice = Number\(soItem\.unit_price\)/);
});

test('conflicting Sales Orders are surfaced without guessing', () => {
  assert.match(sales, /different Sales Orders/);
  assert.match(sales, /resolvedSoIds\.length > 1/);
  assert.match(sales, /conflicting customer PO numbers/);
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

test('DC hydration replaces obsolete placeholder and unlinked manual items', () => {
  assert.match(
    sales,
    /const retained = previous\.filter\(item => Boolean\(item\.delivery_challan_item_id\)\);/,
    'Must only retain items with valid delivery_challan_item_id when loading DC items'
  );
  assert.doesNotMatch(
    sales,
    /previous\.filter\(item => \(item\.product_id && item\.product_id\.trim\(\) !== ''\) \|\| item\.delivery_challan_item_id\)/,
    'Must not retain unlinked product lines when authoritative DC items are loaded'
  );
});

test('validate_sales_invoice_so_link explicitly casts linked_challan_ids to uuid[]', () => {
  const migration = fs.readFileSync('supabase/migrations/20260903173000_fix_validate_sales_invoice_so_link_uuid_cast.sql', 'utf8');
  assert.match(
    migration,
    /WHERE dc\.id = ANY\(NEW\.linked_challan_ids::uuid\[\]\)/,
    'Must explicitly cast text array to uuid[] when comparing against delivery_challans.id'
  );
  assert.doesNotMatch(
    migration,
    /WHERE dc\.id = ANY\(NEW\.linked_challan_ids\)(?!::uuid\[\])/,
    'Must not compare uuid against uncast text array'
  );
});

test('post_sales_invoice_cogs is SECURITY DEFINER with fixed search_path', () => {
  const migration = fs.readFileSync('supabase/migrations/20260903174500_set_post_sales_invoice_cogs_security_definer.sql', 'utf8');
  assert.match(
    migration,
    /CREATE OR REPLACE FUNCTION public\.post_sales_invoice_cogs\(\)\s+RETURNS trigger\s+LANGUAGE plpgsql\s+SECURITY DEFINER\s+SET search_path = public, pg_temp/m,
    'post_sales_invoice_cogs must be SECURITY DEFINER with search_path = public, pg_temp'
  );
});



