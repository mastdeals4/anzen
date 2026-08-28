import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const customerValidation = fs.readFileSync('src/utils/customerValidation.ts', 'utf8');
const customersPage = fs.readFileSync('src/pages/Customers.tsx', 'utf8');
const dcPage = fs.readFileSync('src/pages/DeliveryChallan.tsx', 'utf8');
const migration = fs.readFileSync('supabase/migrations/20260827090000_customer_identity_and_dc_source_traceability.sql', 'utf8');

test('customer identity matching uses strong evidence and does not fuzzy-merge', () => {
  assert.match(customerValidation, /normalizeCustomerTaxId/);
  assert.match(customerValidation, /same NPWP\/tax ID/);
  assert.match(customerValidation, /same normalized legal name/);
  assert.match(customersPage, /Possible existing customer found/);
  assert.match(customersPage, /Use existing/);
  assert.doesNotMatch(customerValidation, /calculateSimilarity\(.*existing/);
});

test('database protects exact active customer identity duplicates', () => {
  assert.match(migration, /prevent_active_customer_identity_duplicate/);
  assert.match(migration, /uq_active_customer_normalized_name/);
  assert.match(migration, /uq_active_customer_normalized_npwp/);
});

test('Delivery Challan items retain Sales Order source identity', () => {
  assert.match(dcPage, /sales_order_item_id/);
  assert.match(dcPage, /selected Sales Order/);
  assert.match(dcPage, /sourceMap/);
  assert.match(migration, /sales_order_item_id uuid/);
  assert.match(migration, /validate_delivery_challan_source_item/);
});

test('Delivery Challan validation blocks customer mismatch and excess quantity', () => {
  assert.match(dcPage, /Customer does not match the selected Sales Order/);
  assert.match(dcPage, /exceeds the remaining Sales Order quantity/);
  assert.match(migration, /Delivery Challan customer must match Sales Order customer/);
  assert.match(migration, /Delivery quantity exceeds remaining Sales Order quantity/);
});

test('legacy rows remain compatible while new SO-linked rows are strict', () => {
  assert.match(migration, /Unlinked Delivery Challan cannot reference/);
  assert.match(migration, /requires sales_order_item_id/);
  assert.match(migration, /ALTER TABLE public.delivery_challan_items/);
});
