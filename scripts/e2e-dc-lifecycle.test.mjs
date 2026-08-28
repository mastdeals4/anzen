// End-to-end DC lifecycle test for stock conservation.
//
// Asserts:
//  1. create DC -> approve -> reject:   stock returns exactly to original.
//  2. create DC -> approve -> cancel:   stock returns exactly to original.
//  3. create DC -> reject (no approve): stock returns exactly to original.
//
// Requires migration 20260603120000 to be applied (adds 'cancelled' to
// dc_approval_status, fixes rejection trigger to reverse approved deductions,
// adds cancellation trigger, makes update_so_delivered_quantity_atomic a
// recompute, recomputes SO delivered_quantity from approved DCs only).
//
// Uses an isolated test batch + product (no real data touched).

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

const SUFFIX = `TEST-${Date.now()}`;
let productId, batchId, customerId, soId;
const cleanup = [];

function fail(msg) { throw new Error(msg); }
function assertEq(actual, expected, label) {
  if (Number(actual) !== Number(expected)) {
    fail(`[ASSERT] ${label}: expected ${expected}, got ${actual}`);
  }
  console.log(`  ok ${label} = ${actual}`);
}

async function getBatchStock() {
  const { data, error } = await sb.from('batches').select('current_stock, reserved_stock').eq('id', batchId).single();
  if (error) throw error;
  return { current: Number(data.current_stock), reserved: Number(data.reserved_stock || 0) };
}
async function getSoiDelivered() {
  const { data } = await sb.from('sales_order_items').select('delivered_quantity').eq('sales_order_id', soId).single();
  return Number(data.delivered_quantity || 0);
}

async function setup() {
  console.log('--- setup ---');
  // Use an existing auth user (with admin role) as the actor for fk columns
  const users = await sb.auth.admin.listUsers({ perPage: 50 });
  const adminUser = users.data.users.find(u => /aanvi|kunal/i.test(u.email || '')) || users.data.users[0];
  const adminId = adminUser?.id;
  if (!adminId) fail('no auth user available as actor');

  const { data: prod, error: prodErr } = await sb.from('products').insert({
    product_name: `e2e-product-${SUFFIX}`,
    product_code: `SKU-${SUFFIX}`,
    unit: 'kg',
    category: 'api',
    is_active: true,
    created_by: adminId,
  }).select().single();
  if (prodErr) throw prodErr;
  productId = prod.id;
  cleanup.push(() => sb.from('products').delete().eq('id', productId));

  const { data: cust, error: custErr } = await sb.from('customers').insert({
    company_name: `e2e-customer-${SUFFIX}`,
    is_active: true,
    created_by: adminId,
  }).select().single();
  if (custErr) throw custErr;
  customerId = cust.id;
  cleanup.push(() => sb.from('customers').delete().eq('id', customerId));

  const { data: batch, error: batchErr } = await sb.from('batches').insert({
    product_id: productId,
    batch_number: `e2e-${SUFFIX}`,
    import_date: '2026-01-01',
    import_quantity: 100,
    current_stock: 100,
    import_price: 100,
    expiry_date: '2030-01-01',
    is_active: true,
    created_by: adminId,
    reserved_stock: 0,
  }).select().single();
  if (batchErr) throw batchErr;
  batchId = batch.id;
  cleanup.push(() => sb.from('batches').delete().eq('id', batchId));

  const { data: so, error: soErr } = await sb.from('sales_orders').insert({
    so_number: `e2e-SO-${SUFFIX}`,
    customer_id: customerId,
    customer_po_number: `PO-${SUFFIX}`,
    customer_po_date: '2026-06-03',
    so_date: '2026-06-03',
    status: 'pending_delivery',
    subtotal_amount: 0, tax_amount: 0, total_amount: 0,
    created_by: adminId,
  }).select().single();
  if (soErr) throw soErr;
  soId = so.id;
  cleanup.push(() => sb.from('sales_orders').delete().eq('id', soId));

  const { error: soiErr } = await sb.from('sales_order_items').insert({
    sales_order_id: soId,
    product_id: productId,
    quantity: 30,
    delivered_quantity: 0,
    unit_price: 100,
    line_total: 3000,
  });
  if (soiErr) throw soiErr;

  return { adminId };
}

async function createDc(adminId, qty) {
  const { data: dc, error: dcErr } = await sb.from('delivery_challans').insert({
    challan_number: `e2e-DO-${SUFFIX}-${Date.now()}`,
    customer_id: customerId,
    challan_date: '2026-06-03',
    sales_order_id: soId,
    approval_status: 'pending_approval',
    created_by: adminId,
    delivery_address: 'e2e test',
  }).select().single();
  if (dcErr) throw dcErr;
  const { error: itemErr } = await sb.from('delivery_challan_items').insert({
    challan_id: dc.id,
    product_id: productId,
    batch_id: batchId,
    quantity: qty,
  });
  if (itemErr) throw itemErr;
  cleanup.push(() => sb.from('delivery_challan_items').delete().eq('challan_id', dc.id));
  cleanup.push(() => sb.from('delivery_challans').delete().eq('id', dc.id));
  // Also call the atomic update RPC the way the UI does
  const { error: rpcErr } = await sb.rpc('update_so_delivered_quantity_atomic', {
    p_sales_order_id: soId,
    p_dc_items: [{ product_id: productId, quantity: qty }],
  });
  if (rpcErr) throw rpcErr;
  return dc;
}

async function approveDc(dc, adminId) {
  const { error } = await sb.from('delivery_challans').update({
    approval_status: 'approved',
    approved_by: adminId,
    approved_at: new Date().toISOString(),
  }).eq('id', dc.id);
  if (error) throw error;
}

async function rejectDc(dc, adminId) {
  const { error } = await sb.from('delivery_challans').update({
    approval_status: 'rejected',
    rejected_by: adminId,
    rejected_at: new Date().toISOString(),
    rejection_reason: 'e2e test',
  }).eq('id', dc.id);
  if (error) throw error;
}

async function cancelDc(dc, adminId) {
  const { error } = await sb.from('delivery_challans').update({
    approval_status: 'cancelled',
    rejected_by: adminId,
    rejected_at: new Date().toISOString(),
    rejection_reason: 'e2e cancel',
  }).eq('id', dc.id);
  if (error) throw error;
}

async function runScenario(label, run, adminId) {
  console.log(`\n--- scenario: ${label} ---`);
  const before = await getBatchStock();
  const soiBefore = await getSoiDelivered();
  console.log('  before:', before, 'so_delivered=', soiBefore);
  await run(adminId);
  const after = await getBatchStock();
  const soiAfter = await getSoiDelivered();
  console.log('  after :', after, 'so_delivered=', soiAfter);
  assertEq(after.current, before.current, `${label}: current_stock restored`);
  assertEq(after.reserved, before.reserved, `${label}: reserved_stock restored`);
  assertEq(soiAfter, soiBefore, `${label}: SO delivered_quantity restored`);
}

async function main() {
  const { adminId } = await setup();

  // Scenario 1: create -> approve -> reject
  await runScenario('create -> approve -> reject', async (a) => {
    const dc = await createDc(a, 10);
    await approveDc(dc, a);
    await rejectDc(dc, a);
  }, adminId);

  // Scenario 2: create -> approve -> cancel
  await runScenario('create -> approve -> cancel', async (a) => {
    const dc = await createDc(a, 10);
    await approveDc(dc, a);
    await cancelDc(dc, a);
  }, adminId);

  // Scenario 3: create -> reject (no approve)
  await runScenario('create -> reject (no approve)', async (a) => {
    const dc = await createDc(a, 10);
    await rejectDc(dc, a);
  }, adminId);

  console.log('\nALL SCENARIOS PASSED');
}

try {
  await main();
} catch (e) {
  console.error('\nFAIL:', e.message);
  process.exitCode = 1;
} finally {
  console.log('\n--- cleanup ---');
  for (const fn of cleanup.reverse()) {
    try { await fn(); } catch (e) { console.error('cleanup err:', e.message); }
  }
}
