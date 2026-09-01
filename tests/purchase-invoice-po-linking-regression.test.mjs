import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const source = await readFile('src/components/finance/PurchaseInvoiceManager.tsx', 'utf8');
assert.ok(source.includes('editingInvoice ? {} : { notes:'));
assert.ok(!source.includes('invoice_number: po.po_number'));
assert.ok(source.includes('purchase_order_id: effectivePurchaseOrderId'));
console.log('PI PO linking regression checks passed');
