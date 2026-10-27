import assert from 'node:assert/strict';
import { loadInvoiceDisplayItems } from '../src/utils/invoiceItemDisplay.ts';

const rows = {
  sales_invoice_items: [{
    id: 'invoice-item-1', invoice_id: 'invoice-1', product_id: 'product-1',
    batch_id: 'batch-1', quantity: 125, unit_price: 46855, tax_rate: 11,
    tax_amount: 644256.25, line_total: 6501131.25,
    delivery_challan_item_id: 'dc-item-1',
  }],
  products: [{ id: 'product-1', product_name: 'Reference Product', product_code: 'REF-1', unit: 'Kg' }],
  batches: [{ id: 'batch-1', batch_number: '250816w2', expiry_date: '2030-08-16' }],
  delivery_challan_items: [{ id: 'dc-item-1', challan_id: 'dc-1' }],
  delivery_challans: [{ id: 'dc-1', challan_number: 'DO-26-0042' }],
};

const client = {
  from(table) {
    const query = {
      select() { return query; },
      eq() { return Promise.resolve({ data: rows[table], error: null }); },
      in() { return Promise.resolve({ data: rows[table], error: null }); },
    };
    return query;
  },
};

const [item] = await loadInvoiceDisplayItems(client, 'invoice-1');
assert.equal(item.products?.product_name, 'Reference Product');
assert.equal(item.batches?.batch_number, '250816w2');
assert.equal(item.batches?.expiry_date, '2030-08-16');
assert.equal(item.quantity, 125);
assert.equal(item.products?.unit, 'Kg');
assert.equal(item.unit_price, 46855);
assert.equal(item.tax_amount, 644256.25);
assert.equal(item.line_total, 6501131.25);
assert.equal(item.delivery_challan_item_id, 'dc-item-1');
assert.equal(item.challan_id, 'dc-1');
assert.equal(item.dc_number, 'DO-26-0042');

console.log('invoice item display regression passed');
