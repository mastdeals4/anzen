/**
 * COST LAYER AUDIT — Read-only forensic analysis
 *
 * Audits the current state of purchase_batch_cost_layers vs batches vs PI data
 * to identify the multi-receipt/multi-price cost-layer defect.
 *
 * Usage:
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/cost-layer-audit.mjs
 */
import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY;
if (!url || !key) { console.error('Missing SUPABASE_URL/VITE_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY/VITE_SUPABASE_ANON_KEY.'); process.exit(1); }
console.log(`Connecting to: ${url} (key type: ${process.env.SUPABASE_SERVICE_ROLE_KEY ? 'service_role' : 'anon'})`);
const sb = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

async function query(table, select, filters = {}) {
  let q = sb.from(table).select(select);
  for (const [k, v] of Object.entries(filters)) q = q.eq(k, v);
  const { data, error } = await q;
  if (error) throw new Error(`${table}: ${error.message}`);
  return data || [];
}

async function main() {
  console.log('='.repeat(80));
  console.log('COST LAYER AUDIT — READ-ONLY FORENSIC ANALYSIS');
  console.log('='.repeat(80));

  // 1. Load all cost layers
  const layers = await query('purchase_batch_cost_layers', '*');
  console.log(`\n1. Total purchase_batch_cost_layers: ${layers.length}`);

  // 2. Load all batches
  const batches = await query('batches', 'id,batch_number,product_id,import_quantity,current_stock,import_price,import_price_usd,import_price_per_unit,cost_per_unit,landed_cost_per_unit,final_landed_cost,import_cost_allocated,exchange_rate_usd_to_idr,import_container_id,cost_locked,is_active');
  console.log(`2. Total batches: ${batches.length}`);

  // 3. Load all PI receiving allocations
  const allocations = await query('purchase_invoice_receiving_allocations', '*');
  console.log(`3. Total receiving allocations: ${allocations.length}`);

  // 4. Load all PI inventory items
  const piItems = await query('purchase_invoice_items', 'id,purchase_invoice_id,product_id,quantity,unit_price,unit,item_type,receiving_batch_number,batch_id');
  const inventoryItems = piItems.filter(i => i.item_type === 'inventory');
  console.log(`4. Total PI inventory items: ${inventoryItems.length}`);

  // 5. Load PIs
  const pis = await query('purchase_invoices', 'id,invoice_number,currency,exchange_rate,supplier_id,receiving_approval_status');
  const piMap = new Map(pis.map(p => [p.id, p]));
  console.log(`5. Total purchase invoices: ${pis.length}`);

  // ── ANALYSIS: Batches with multiple cost layers ──
  console.log('\n' + '='.repeat(80));
  console.log('ANALYSIS A: Batches with multiple cost layers');
  console.log('='.repeat(80));

  const layersByBatch = new Map();
  for (const l of layers) {
    if (!layersByBatch.has(l.batch_id)) layersByBatch.set(l.batch_id, []);
    layersByBatch.get(l.batch_id).push(l);
  }

  const multiLayerBatches = [];
  for (const [batchId, batchLayers] of layersByBatch) {
    if (batchLayers.length > 1) {
      const batch = batches.find(b => b.id === batchId);
      multiLayerBatches.push({ batch, layers: batchLayers });
    }
  }

  console.log(`\nBatches with multiple cost layers: ${multiLayerBatches.length}`);
  for (const { batch, layers: bls } of multiLayerBatches) {
    console.log(`\n  Batch: ${batch?.batch_number || '???'} (${batch?.id})`);
    console.log(`    import_quantity=${batch?.import_quantity}, current_stock=${batch?.current_stock}`);
    console.log(`    import_price=${batch?.import_price}, cost_per_unit=${batch?.cost_per_unit}, landed_cost_per_unit=${batch?.landed_cost_per_unit}`);
    const totalLayerQty = bls.reduce((s, l) => s + Number(l.quantity), 0);
    console.log(`    Layer total qty: ${totalLayerQty}`);
    for (const l of bls) {
      const pi = piMap.get(l.purchase_invoice_id);
      console.log(`    Layer: qty=${l.quantity} ${l.currency} tx_unit=${l.transaction_unit_cost} fx=${l.exchange_rate} func_unit=${l.functional_unit_cost} landed=${l.landed_cost_amount} final_unit=${l.final_functional_unit_cost} PI=${pi?.invoice_number || l.purchase_invoice_id}`);
    }
  }

  // ── ANALYSIS: Batches with multiple receiving allocations but single/no cost layer ──
  console.log('\n' + '='.repeat(80));
  console.log('ANALYSIS B: Receiving allocations vs cost layers');
  console.log('='.repeat(80));

  const allocsByBatch = new Map();
  for (const a of allocations) {
    if (!allocsByBatch.has(a.batch_id)) allocsByBatch.set(a.batch_id, []);
    allocsByBatch.get(a.batch_id).push(a);
  }

  const multiAllocBatches = [];
  for (const [batchId, batchAllocs] of allocsByBatch) {
    if (batchAllocs.length > 1) {
      const batch = batches.find(b => b.id === batchId);
      const batchLayers = layersByBatch.get(batchId) || [];
      multiAllocBatches.push({ batch, allocs: batchAllocs, layers: batchLayers });
    }
  }

  console.log(`\nBatches with multiple receiving allocations: ${multiAllocBatches.length}`);
  for (const { batch, allocs, layers: bls } of multiAllocBatches) {
    const allocsByPI = new Map();
    for (const a of allocs) {
      if (!allocsByPI.has(a.purchase_invoice_id)) allocsByPI.set(a.purchase_invoice_id, []);
      allocsByPI.get(a.purchase_invoice_id).push(a);
    }
    const distinctPIs = allocsByPI.size;
    console.log(`\n  Batch: ${batch?.batch_number || '???'}`);
    console.log(`    Receiving allocs: ${allocs.length}, Distinct PIs: ${distinctPIs}, Cost layers: ${bls.length}`);
    console.log(`    Batch import_price=${batch?.import_price}, cost_per_unit=${batch?.cost_per_unit}, landed=${batch?.landed_cost_per_unit}`);
    if (distinctPIs > 1 || bls.length !== allocs.length) {
      console.log(`    ⚠️  MISMATCH: ${distinctPIs} PIs, ${allocs.length} allocs, ${bls.length} cost layers`);
      for (const a of allocs) {
        const pi = piMap.get(a.purchase_invoice_id);
        const hasLayer = bls.some(l => l.receiving_allocation_id === a.id);
        console.log(`      Alloc: qty=${a.received_quantity} ${a.currency || '?'} func_unit=${a.functional_unit_cost} fx=${a.exchange_rate} PI=${pi?.invoice_number || a.purchase_invoice_id} hasLayer=${hasLayer}`);
      }
    }
  }

  // ── ANALYSIS C: Known cases ──
  console.log('\n' + '='.repeat(80));
  console.log('ANALYSIS C: Known multi-receipt batches');
  console.log('='.repeat(80));

  const knownBatches = ['XMEP250178', 'DFS/126010052', 'DFS/126030158', 'XMAL260006'];
  for (const bn of knownBatches) {
    const batch = batches.find(b => b.batch_number === bn);
    if (!batch) { console.log(`\n  ${bn}: NOT FOUND`); continue; }
    const bls = layersByBatch.get(batch.id) || [];
    const allocs = allocsByBatch.get(batch.id) || [];
    console.log(`\n  ${bn}:`);
    console.log(`    import_qty=${batch.import_quantity}, current_stock=${batch.current_stock}, import_price=${batch.import_price}`);
    console.log(`    cost_per_unit=${batch.cost_per_unit}, landed=${batch.landed_cost_per_unit}, import_price_usd=${batch.import_price_usd}`);
    console.log(`    cost_locked=${batch.cost_locked}, container_id=${batch.import_container_id}`);
    console.log(`    Receiving allocs: ${allocs.length}, Cost layers: ${bls.length}`);
    for (const a of allocs) {
      const pi = piMap.get(a.purchase_invoice_id);
      console.log(`    Alloc: qty=${a.received_quantity} ${a.currency} func_unit=${a.functional_unit_cost} fx=${a.exchange_rate} PI=${pi?.invoice_number}`);
    }
    for (const l of bls) {
      const pi = piMap.get(l.purchase_invoice_id);
      console.log(`    Layer: qty=${l.quantity} ${l.currency} tx_unit=${l.transaction_unit_cost} func_unit=${l.functional_unit_cost} landed=${l.landed_cost_amount} final=${l.final_functional_unit_cost} PI=${pi?.invoice_number}`);
    }
  }

  // ── ANALYSIS D: PI inventory items with receiving_batch_number but no batch_id ──
  console.log('\n' + '='.repeat(80));
  console.log('ANALYSIS D: PI items with receiving_batch_number but no batch_id');
  console.log('='.repeat(80));

  const orphanedItems = inventoryItems.filter(i => i.receiving_batch_number && !i.batch_id);
  console.log(`\n  Items with batch_number but no batch_id: ${orphanedItems.length}`);
  for (const item of orphanedItems.slice(0, 20)) {
    const pi = piMap.get(item.purchase_invoice_id);
    console.log(`    PI=${pi?.invoice_number || item.purchase_invoice_id} qty=${item.quantity} price=${item.unit_price} unit=${item.unit} batch_num=${item.receiving_batch_number}`);
  }

  // ── ANALYSIS E: Batches with allocs from different PIs at different prices ──
  console.log('\n' + '='.repeat(80));
  console.log('ANALYSIS E: Multi-price batch summary');
  console.log('='.repeat(80));

  let multiPriceCount = 0;
  for (const { batch, allocs } of multiAllocBatches) {
    const prices = new Set(allocs.map(a => Number(a.functional_unit_cost)));
    if (prices.size > 1) {
      multiPriceCount++;
      const totalAllocQty = allocs.reduce((s, a) => s + Number(a.received_quantity), 0);
      const weightedAvg = allocs.reduce((s, a) => s + Number(a.received_quantity) * Number(a.functional_unit_cost), 0) / totalAllocQty;
      console.log(`\n  ${batch?.batch_number}: ${prices.size} distinct prices, total_qty=${totalAllocQty}, weighted_avg=${weightedAvg.toFixed(2)}, batch cost_per_unit=${batch?.cost_per_unit}, landed=${batch?.landed_cost_per_unit}`);
      for (const a of allocs) {
        const pi = piMap.get(a.purchase_invoice_id);
        console.log(`    qty=${a.received_quantity} @ ${a.functional_unit_cost} (PI: ${pi?.invoice_number})`);
      }
    }
  }
  console.log(`\n  Total multi-price batches: ${multiPriceCount}`);

  // ── ANALYSIS F: Batches with layers vs batch-level cost comparison ──
  console.log('\n' + '='.repeat(80));
  console.log('ANALYSIS F: Layer-derived cost vs batch-level cost');
  console.log('='.repeat(80));

  let layerMismatchCount = 0;
  for (const [batchId, batchLayers] of layersByBatch) {
    const batch = batches.find(b => b.id === batchId);
    if (!batch) continue;
    const totalQty = batchLayers.reduce((s, l) => s + Number(l.quantity), 0);
    const weightedFinal = totalQty > 0
      ? batchLayers.reduce((s, l) => s + Number(l.quantity) * Number(l.final_functional_unit_cost), 0) / totalQty
      : 0;
    const batchCost = Number(batch.landed_cost_per_unit || batch.cost_per_unit || batch.import_price || 0);
    const diff = Math.abs(weightedFinal - batchCost);
    if (diff > 1) {
      layerMismatchCount++;
      if (layerMismatchCount <= 10) {
        console.log(`  ${batch.batch_number}: layer-derived=${weightedFinal.toFixed(2)}, batch=${batchCost.toFixed(2)}, diff=${diff.toFixed(2)}`);
      }
    }
  }
  console.log(`\n  Batches where layer cost ≠ batch cost (>Rp1 diff): ${layerMismatchCount}`);

  // ── ANALYSIS G: Sales that consumed multi-layer batches ──
  console.log('\n' + '='.repeat(80));
  console.log('ANALYSIS G: Sales consuming multi-layer batches');
  console.log('='.repeat(80));

  const multiLayerBatchIds = new Set(multiLayerBatches.map(m => m.batch.id));
  const { data: salesItems, error: siErr } = await sb.from('sales_invoice_items')
    .select('id,invoice_id,batch_id,quantity,cogs_unit_cost,cogs_total_cost,sales_invoices(invoice_number,invoice_date,is_draft)')
    .in('batch_id', Array.from(multiLayerBatchIds));
  if (siErr) console.error('Sales query error:', siErr.message);
  const salesFromMultiLayer = (salesItems || []).filter(s => !s.sales_invoices?.is_draft);
  console.log(`\n  Sales invoice items from multi-layer batches: ${salesFromMultiLayer.length}`);
  for (const s of salesFromMultiLayer.slice(0, 10)) {
    const batch = batches.find(b => b.id === s.batch_id);
    console.log(`    ${s.sales_invoices?.invoice_number} qty=${s.quantity} cogs_unit=${s.cogs_unit_cost} cogs_total=${s.cogs_total_cost} batch=${batch?.batch_number}`);
  }

  console.log('\n' + '='.repeat(80));
  console.log('AUDIT COMPLETE');
  console.log('='.repeat(80));
}

main().catch(e => { console.error(e); process.exit(1); });
