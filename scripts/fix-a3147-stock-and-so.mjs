// Data fix portion of Issue 1: reverse the wrong -50 stock adjustment for
// batch 4001/1101/25/A-3147 and recompute delivered_quantity for the SO of
// the rejected DC DO-26-0010.
//
// Issue 2 logic fix (triggers, enum, RPCs) is delivered as a migration in
// supabase/migrations/20260603120000_fix_dc_rejection_cancellation_and_a3147_stock.sql
// and must be applied via the Supabase SQL editor (DDL is not reachable
// through PostgREST with the service role alone).

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

const env = readFileSync(new URL('./.env.local', import.meta.url), 'utf8');
for (const line of env.split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2];
}

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const BATCH_ID = 'cb5539e0-4c14-4086-ba30-92cf194d5db2';
const PRODUCT_ID = '4fd7e5b5-1226-4044-b9bd-e16e1e8a516a';
const REJECTED_DC_ID = '8f514b90-a2a2-4e03-932f-016f1797dee7'; // DO-26-0010
const SO_ID = 'd10814c2-cf69-4334-9bb2-b6e05f86d0fa';          // SO-2026-0014

async function main() {
  const { data: batch, error: bErr } = await sb
    .from('batches')
    .select('id, batch_number, current_stock, import_quantity')
    .eq('id', BATCH_ID).single();
  if (bErr) throw bErr;
  console.log('[before] batch', batch);

  // Approved DC sum sanity check
  const { data: approvedItems } = await sb
    .from('delivery_challan_items')
    .select('quantity, delivery_challans!inner(approval_status)')
    .eq('batch_id', BATCH_ID)
    .eq('delivery_challans.approval_status', 'approved');
  const approvedSum = (approvedItems || []).reduce((s, r) => s + Number(r.quantity), 0);
  console.log('[check] approved DC qty for batch =', approvedSum, '/ import =', batch.import_quantity);

  if (Number(batch.current_stock) === -50) {
    const { error: u1 } = await sb.from('batches').update({ current_stock: 0, updated_at: new Date().toISOString() }).eq('id', BATCH_ID);
    if (u1) throw u1;

    const { error: u2 } = await sb.from('inventory_transactions').insert({
      product_id: PRODUCT_ID,
      batch_id: BATCH_ID,
      transaction_type: 'adjustment',
      quantity: 50,
      transaction_date: new Date().toISOString().slice(0, 10),
      reference_number: 'HFR-260603-STOCK-REVERSAL',
      reference_type: 'historical_stock_adjustment_reversal',
      reference_id: BATCH_ID,
      notes: 'Reversal of incorrect HFR-260603-STOCK adjustment: rejected DC DO-26-0010 (50kg, "dubble entry") was wrongly counted as delivered. Approved DC total = import = 1000; correct current_stock = 0.',
      stock_before: -50,
      stock_after: 0,
      metadata: {
        reversal_of: '7372f0f6-b2a2-47ad-9627-428566832b7e',
        reason: 'rejected DC DO-26-0010 wrongly counted as delivered by HFR-260603',
      },
    });
    if (u2) throw u2;
    console.log('[fix] Reversed -50 -> 0 and inserted reversal txn');
  } else {
    console.log('[fix] Skipped: batch current_stock is not -50, no action taken.');
  }

  // Recompute delivered_quantity for the SO of the rejected DC
  const { data: soItems } = await sb
    .from('sales_order_items')
    .select('id, product_id, quantity, delivered_quantity')
    .eq('sales_order_id', SO_ID);

  for (const soi of soItems || []) {
    const { data: approvedForProduct } = await sb
      .from('delivery_challan_items')
      .select('quantity, delivery_challans!inner(sales_order_id, approval_status)')
      .eq('product_id', soi.product_id)
      .eq('delivery_challans.sales_order_id', SO_ID)
      .eq('delivery_challans.approval_status', 'approved');
    const delivered = (approvedForProduct || []).reduce((s, r) => s + Number(r.quantity), 0);
    if (Number(soi.delivered_quantity) !== delivered) {
      await sb.from('sales_order_items').update({ delivered_quantity: delivered }).eq('id', soi.id);
      console.log(`[recompute] SO item ${soi.id}: ${soi.delivered_quantity} -> ${delivered}`);
    }
  }

  const { data: soiAfter } = await sb.from('sales_order_items').select('quantity, delivered_quantity').eq('sales_order_id', SO_ID);
  const totalQty = soiAfter.reduce((s, r) => s + Number(r.quantity), 0);
  const totalDel = soiAfter.reduce((s, r) => s + Number(r.delivered_quantity), 0);
  let newStatus = 'pending_delivery';
  if (totalDel >= totalQty) newStatus = 'delivered';
  else if (totalDel > 0) newStatus = 'partially_delivered';
  const { data: soBefore } = await sb.from('sales_orders').select('status').eq('id', SO_ID).single();
  if (soBefore && !['closed', 'cancelled', 'rejected'].includes(soBefore.status) && soBefore.status !== newStatus) {
    await sb.from('sales_orders').update({ status: newStatus, updated_at: new Date().toISOString() }).eq('id', SO_ID);
    console.log(`[recompute] SO ${SO_ID} status: ${soBefore.status} -> ${newStatus}`);
  }

  // Verification
  const { data: bAfter } = await sb.from('batches').select('current_stock').eq('id', BATCH_ID).single();
  console.log('[after] batch current_stock =', bAfter.current_stock);

  const { data: txnsAfter } = await sb
    .from('inventory_transactions')
    .select('quantity, transaction_type, reference_number')
    .eq('batch_id', BATCH_ID);
  const txnSum = (txnsAfter || []).reduce((s, r) => s + Number(r.quantity), 0);
  console.log('[verify] inventory_transactions net sum for batch =', txnSum);
  console.log('[verify] conservation: net txns should equal final current_stock');
  if (txnSum !== Number(bAfter.current_stock)) {
    console.log(`[warn] txn net (${txnSum}) != current_stock (${bAfter.current_stock}); historical drift present from earlier corrections`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
