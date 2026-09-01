import assert from 'node:assert/strict';
import fs from 'node:fs';

const component = fs.readFileSync('src/components/finance/PurchaseInvoiceManager.tsx', 'utf8');
const migration = fs.readFileSync('supabase/migrations/20260901040000_harden_purchase_invoice_edit_relationship_preservation.sql', 'utf8');

for (const field of ['purchase_order_item_id', 'receiving_make_id', 'receiving_batch_number', 'receiving_expiry_date', 'receiving_import_container_id']) {
  assert.match(component, new RegExp(field), `PI edit payload must include ${field}`);
  assert.match(migration, new RegExp(field), `PI edit RPC must preserve ${field}`);
}
assert.match(component, /effectivePurchaseOrderId/);
assert.match(migration, /save_purchase_invoice\(p_invoice_id, v_data, v_items\)/);
console.log('purchase invoice edit persistence regression passed');
