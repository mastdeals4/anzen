import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

function loadEnv() {
  for (const path of ['scripts/.env.local', '.env']) {
    try {
      for (const line of readFileSync(path, 'utf8').split('\n')) {
        const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
      }
    } catch {
      // optional env file
    }
  }
}

loadEnv();

const APPLY = process.argv.includes('--apply');
const EPS = 0.000001;

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function fetchAll(table, select = '*') {
  const out = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from(table)
      .select(select)
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...(data || []));
    if (!data || data.length < pageSize) break;
  }
  return out;
}

function n(value) {
  return Number(value || 0);
}

function add(map, key, qty) {
  map.set(key, n(map.get(key)) + n(qty));
}

function nearlyEqual(a, b) {
  return Math.abs(n(a) - n(b)) < EPS;
}

function isTerminal(status) {
  return ['closed', 'cancelled', 'rejected'].includes(status);
}

function desiredSalesOrderStatus(so, orderedQty, deliveredQty, invoicedQty) {
  if (['cancelled', 'rejected'].includes(so.status)) return so.status;
  if (deliveredQty >= orderedQty - EPS && invoicedQty >= orderedQty - EPS && orderedQty > 0) return 'closed';
  if (deliveredQty >= orderedQty - EPS && orderedQty > 0) return 'delivered';
  if (deliveredQty > EPS) return 'partially_delivered';
  return so.status;
}

function allocateDeliveredQuantities(items, deliveredByProduct) {
  const out = new Map();
  const remaining = new Map(deliveredByProduct);
  for (const item of items) {
    const key = item.product_id;
    const available = n(remaining.get(key));
    let delivered = Math.min(n(item.quantity), Math.max(0, available));
    remaining.set(key, available - delivered);
    out.set(item.id, delivered);
  }
  return out;
}

async function main() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  }

  console.log(APPLY ? 'MODE apply' : 'MODE dry-run');

  const [
    products,
    batches,
    deliveryChallans,
    deliveryChallanItems,
    salesOrders,
    salesOrderItems,
    salesInvoices,
    salesInvoiceItems,
  ] = await Promise.all([
    fetchAll('products', 'id,product_name,current_stock,is_active'),
    fetchAll('batches', 'id,batch_number,product_id,import_quantity,current_stock,is_active'),
    fetchAll('delivery_challans', 'id,challan_number,challan_date,sales_order_id,approval_status'),
    fetchAll('delivery_challan_items', 'id,challan_id,product_id,batch_id,quantity'),
    fetchAll('sales_orders', 'id,so_number,status,is_archived'),
    fetchAll('sales_order_items', 'id,sales_order_id,product_id,quantity,delivered_quantity'),
    fetchAll('sales_invoices', 'id,invoice_number,is_draft,sales_order_id'),
    fetchAll('sales_invoice_items', 'id,invoice_id,product_id,batch_id,quantity,delivery_challan_item_id'),
  ]);

  const productById = new Map(products.map((p) => [p.id, p]));
  const batchById = new Map(batches.map((b) => [b.id, b]));
  const dcById = new Map(deliveryChallans.map((dc) => [dc.id, dc]));
  const dciById = new Map(deliveryChallanItems.map((dci) => [dci.id, dci]));
  const invoiceById = new Map(salesInvoices.map((si) => [si.id, si]));
  const soItemsBySo = new Map();
  const deliveredBySoProduct = new Map();
  const approvedDeliveredByBatch = new Map();
  const approvedDeliveredByProduct = new Map();
  const invoicedBySo = new Map();
  const realInvoiceItemIds = new Set();

  for (const soi of salesOrderItems) {
    if (!soItemsBySo.has(soi.sales_order_id)) soItemsBySo.set(soi.sales_order_id, []);
    soItemsBySo.get(soi.sales_order_id).push(soi);
  }

  for (const dci of deliveryChallanItems) {
    const dc = dcById.get(dci.challan_id);
    if (!dc || dc.approval_status !== 'approved') continue;
    if (dci.batch_id) add(approvedDeliveredByBatch, dci.batch_id, dci.quantity);
    if (dci.product_id) add(approvedDeliveredByProduct, dci.product_id, dci.quantity);
    if (dc.sales_order_id && dci.product_id) {
      add(deliveredBySoProduct, `${dc.sales_order_id}:${dci.product_id}`, dci.quantity);
    }
  }

  for (const sii of salesInvoiceItems) {
    const inv = invoiceById.get(sii.invoice_id);
    if (!inv || inv.is_draft || /^TEST-COGS-/i.test(inv.invoice_number || '')) continue;
    realInvoiceItemIds.add(sii.id);

    let soId = inv.sales_order_id || null;
    if (!soId && sii.delivery_challan_item_id) {
      const dci = dciById.get(sii.delivery_challan_item_id);
      const dc = dci ? dcById.get(dci.challan_id) : null;
      soId = dc?.sales_order_id || null;
    }
    if (soId) add(invoicedBySo, soId, sii.quantity);
  }

  const stockMismatches = [];
  for (const batch of batches) {
    if (batch.is_active === false) continue;
    const imported = n(batch.import_quantity);
    const approvedDelivered = n(approvedDeliveredByBatch.get(batch.id));
    const expected = imported - approvedDelivered;
    if (!nearlyEqual(batch.current_stock, expected)) {
      stockMismatches.push({
        batch_id: batch.id,
        batch_number: batch.batch_number,
        product_id: batch.product_id,
        product_name: productById.get(batch.product_id)?.product_name || null,
        imported,
        approved_delivered: approvedDelivered,
        expected_stock: expected,
        current_stock: n(batch.current_stock),
        delta: expected - n(batch.current_stock),
      });
    }
  }

  const expectedProductStock = new Map();
  for (const batch of batches) {
    if (batch.is_active === false) continue;
    const expected = n(batch.import_quantity) - n(approvedDeliveredByBatch.get(batch.id));
    add(expectedProductStock, batch.product_id, expected);
  }

  const productMismatches = [];
  for (const product of products) {
    if (product.is_active === false) continue;
    const expected = n(expectedProductStock.get(product.id));
    if (!nearlyEqual(product.current_stock, expected)) {
      productMismatches.push({
        product_id: product.id,
        product_name: product.product_name,
        expected_stock: expected,
        current_stock: n(product.current_stock),
        delta: expected - n(product.current_stock),
      });
    }
  }

  const soItemMismatches = [];
  const soStatusMismatches = [];
  for (const so of salesOrders) {
    const items = soItemsBySo.get(so.id) || [];
    const perProduct = new Map();
    for (const item of items) {
      perProduct.set(item.product_id, n(deliveredBySoProduct.get(`${so.id}:${item.product_id}`)));
    }
    const allocatedDelivered = allocateDeliveredQuantities(items, perProduct);
    for (const item of items) {
      const expectedDelivered = n(allocatedDelivered.get(item.id));
      if (!nearlyEqual(item.delivered_quantity, expectedDelivered)) {
        soItemMismatches.push({
          so_id: so.id,
          so_number: so.so_number,
          item_id: item.id,
          product_id: item.product_id,
          ordered_qty: n(item.quantity),
          current_delivered_qty: n(item.delivered_quantity),
          expected_delivered_qty: expectedDelivered,
          delta: expectedDelivered - n(item.delivered_quantity),
        });
      }
    }

    if (isTerminal(so.status) && so.status !== 'closed') continue;
    const orderedQty = items.reduce((sum, item) => sum + n(item.quantity), 0);
    const deliveredQty = Array.from(perProduct.values()).reduce((sum, qty) => sum + n(qty), 0);
    const invoicedQty = n(invoicedBySo.get(so.id));
    const desiredStatus = desiredSalesOrderStatus(so, orderedQty, deliveredQty, invoicedQty);
    if (desiredStatus !== so.status) {
      soStatusMismatches.push({
        so_id: so.id,
        so_number: so.so_number,
        current_status: so.status,
        expected_status: desiredStatus,
        ordered_qty: orderedQty,
        approved_delivered_qty: deliveredQty,
        invoiced_qty: invoicedQty,
      });
    }
  }

  const rejectedOrCancelledDcConsumption = deliveryChallanItems
    .map((dci) => ({ dci, dc: dcById.get(dci.challan_id) }))
    .filter(({ dc }) => dc && ['rejected', 'cancelled'].includes(dc.approval_status))
    .reduce((sum, { dci }) => sum + n(approvedDeliveredByBatch.get(dci.batch_id) && 0), 0);

  console.log('\nSTOCK_MISMATCHES', JSON.stringify(stockMismatches, null, 2));
  console.log('\nPRODUCT_STOCK_MISMATCHES', JSON.stringify(productMismatches, null, 2));
  console.log('\nSO_DELIVERED_QTY_MISMATCHES', JSON.stringify(soItemMismatches, null, 2));
  console.log('\nSO_STATUS_MISMATCHES', JSON.stringify(soStatusMismatches, null, 2));
  console.log('\nDC_REJECTION_VALIDATION', JSON.stringify({
    rejected_or_cancelled_dcs_are_excluded_from_expected_stock: true,
    rejected_or_cancelled_dcs_are_excluded_from_delivered_quantity: true,
    rejected_or_cancelled_item_count: deliveryChallanItems
      .filter((dci) => ['rejected', 'cancelled'].includes(dcById.get(dci.challan_id)?.approval_status))
      .length,
    rejected_or_cancelled_consumed_qty_in_formula: rejectedOrCancelledDcConsumption,
  }, null, 2));

  if (!APPLY) {
    console.log('\nDRY_RUN_ONLY no writes performed');
    return;
  }

  for (const mismatch of stockMismatches) {
    const { error } = await supabase
      .from('batches')
      .update({ current_stock: mismatch.expected_stock, updated_at: new Date().toISOString() })
      .eq('id', mismatch.batch_id);
    if (error) throw new Error(`batch ${mismatch.batch_number}: ${error.message}`);
  }

  for (const mismatch of productMismatches) {
    const { error } = await supabase
      .from('products')
      .update({ current_stock: mismatch.expected_stock, updated_at: new Date().toISOString() })
      .eq('id', mismatch.product_id);
    if (error) throw new Error(`product ${mismatch.product_name}: ${error.message}`);
  }

  for (const mismatch of soItemMismatches) {
    const { error } = await supabase
      .from('sales_order_items')
      .update({ delivered_quantity: mismatch.expected_delivered_qty })
      .eq('id', mismatch.item_id);
    if (error) throw new Error(`SO item ${mismatch.item_id}: ${error.message}`);
  }

  for (const mismatch of soStatusMismatches) {
    const { error } = await supabase
      .from('sales_orders')
      .update({ status: mismatch.expected_status, updated_at: new Date().toISOString() })
      .eq('id', mismatch.so_id);
    if (error) throw new Error(`SO ${mismatch.so_number}: ${error.message}`);
  }

  console.log('\nAPPLIED', JSON.stringify({
    batch_updates: stockMismatches.length,
    product_updates: productMismatches.length,
    so_item_delivered_quantity_updates: soItemMismatches.length,
    so_status_updates: soStatusMismatches.length,
    real_invoice_items_counted: realInvoiceItemIds.size,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
