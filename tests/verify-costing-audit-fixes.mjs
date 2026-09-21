#!/usr/bin/env node
/**
 * Apply the costing engine audit fix migration directly via Supabase Management API
 * and run verification checks.
 */
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envContent = readFileSync(join(__dirname, '..', '.env'), 'utf8');
const env = Object.fromEntries(
  envContent.split('\n')
    .filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => { const [k, ...v] = l.split('='); return [k.trim(), v.join('=').trim()]; })
);

const SUPABASE_URL = env.VITE_SUPABASE_URL;
const ANON_KEY = env.VITE_SUPABASE_ANON_KEY;

// Get service role key from env if available
const SERVICE_KEY = env.VITE_SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_ROLE_KEY || ANON_KEY;

async function runSQL(sql) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/exec_sql`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SERVICE_KEY,
      'Authorization': `Bearer ${SERVICE_KEY}`,
    },
    body: JSON.stringify({ sql }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    return { error: text };
  }
  return { data: await resp.json() };
}

// Use Supabase client approach with individual RPCs
import { createClient } from '@supabase/supabase-js';
const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

console.log('='.repeat(60));
console.log('COSTING ENGINE AUDIT FIX — APPLY & VERIFY');
console.log('Supabase URL:', SUPABASE_URL);
console.log('='.repeat(60));
console.log();

// ===== CHECK 1: pib_import capitalizable =====
console.log('CHECK 1: pib_import recognised as capitalizable...');
const { data: pibCheck, error: pibErr } = await supabase
  .rpc('is_capitalizable_landed_cost_category', { p_category: 'pib_import' });
if (pibErr) {
  console.log('  ⚠  RPC not yet updated (migration not applied):', pibErr.message);
  console.log('  → The migration file is ready to apply:');
  console.log('    supabase/migrations/20260921220000_fix_costing_engine_pib_null_and_stale_costs.sql');
} else {
  const pass = pibCheck === true;
  console.log(`  is_capitalizable_landed_cost_category('pib_import') = ${pibCheck}  →  ${pass ? 'PASS ✓' : 'FAIL ✗ (migration not applied?)'}`);
}

// ===== CHECK 2: Stale other_import_costs =====
console.log('\nCHECK 2: Stale other_import_costs header estimates...');
const { data: staleData, error: staleErr } = await supabase
  .from('import_containers')
  .select('id, container_number, other_import_costs')
  .gt('other_import_costs', 0);
if (staleErr) {
  console.log('  ERROR:', staleErr.message);
} else if (!staleData || staleData.length === 0) {
  console.log('  PASS ✓  No containers with other_import_costs > 0');
} else {
  const total = staleData.reduce((s, c) => s + Number(c.other_import_costs), 0);
  console.log(`  ⚠  ${staleData.length} container(s) still have other_import_costs (total: Rp ${total.toLocaleString('id-ID', {minimumFractionDigits: 2})}):`);
  staleData.forEach(c => console.log(`    Container ${c.container_number}: Rp ${Number(c.other_import_costs).toLocaleString('id-ID', {minimumFractionDigits: 2})}`));
  console.log('  → These will be zeroed when migration is applied.');
}

// ===== CHECK 3: NULL include_in_landed_cost on capitalizable + container =====
console.log('\nCHECK 3: NULL include_in_landed_cost on capitalizable expenses with containers...');
const capitalizableCategories = [
  'duty_customs','duty','duty_import','freight_import','freight','clearing_forwarding',
  'container_handling','loading_import','port_charges','transport_import','import_broker',
  'other_import','pib_import'
];
const { data: nullData, error: nullErr } = await supabase
  .from('finance_expenses')
  .select('id, expense_category, import_container_id, include_in_landed_cost')
  .is('include_in_landed_cost', null)
  .not('import_container_id', 'is', null)
  .in('expense_category', capitalizableCategories);
if (nullErr) {
  console.log('  ERROR:', nullErr.message);
} else if (!nullData || nullData.length === 0) {
  console.log('  PASS ✓  No unresolved NULL include_in_landed_cost on capitalizable expenses with containers');
} else {
  console.log(`  ⚠  ${nullData.length} expense(s) have NULL include_in_landed_cost (will be fixed by migration):`);
  const byCategory = {};
  nullData.forEach(e => { byCategory[e.expense_category] = (byCategory[e.expense_category] || 0) + 1; });
  Object.entries(byCategory).forEach(([cat, count]) => console.log(`    ${cat}: ${count} rows`));
}

// ===== CHECK 4: PIB expenses status =====
console.log('\nCHECK 4: PIB import expenses breakdown...');
const { data: pibExpenses, error: pibExpErr } = await supabase
  .from('finance_expenses')
  .select('id, amount, pib_bm_amount, pib_ppn_amount, pib_pph_amount, import_container_id, include_in_landed_cost, approval_status')
  .eq('expense_category', 'pib_import');
if (pibExpErr) {
  console.log('  ERROR:', pibExpErr.message);
} else if (!pibExpenses || pibExpenses.length === 0) {
  console.log('  INFO  No pib_import expenses found');
} else {
  const totalAmount = pibExpenses.reduce((s, e) => s + Number(e.amount || 0), 0);
  const totalBm = pibExpenses.reduce((s, e) => s + Number(e.pib_bm_amount || 0), 0);
  const totalPpn = pibExpenses.reduce((s, e) => s + Number(e.pib_ppn_amount || 0), 0);
  const totalPph = pibExpenses.reduce((s, e) => s + Number(e.pib_pph_amount || 0), 0);
  const withContainer = pibExpenses.filter(e => e.import_container_id).length;
  const includedTrue = pibExpenses.filter(e => e.include_in_landed_cost === true).length;
  console.log(`  ${pibExpenses.length} PIB expense(s), ${withContainer} linked to containers`);
  console.log(`  Total PIB payment (full amount):        Rp ${totalAmount.toLocaleString('id-ID', {minimumFractionDigits: 2})}`);
  console.log(`  BM only (→ should go to inventory 1130): Rp ${totalBm.toLocaleString('id-ID', {minimumFractionDigits: 2})}`);
  console.log(`  PPN (→ stays in 1150):                  Rp ${totalPpn.toLocaleString('id-ID', {minimumFractionDigits: 2})}`);
  console.log(`  PPh (→ stays in 1155):                  Rp ${totalPph.toLocaleString('id-ID', {minimumFractionDigits: 2})}`);
  console.log(`  include_in_landed_cost = TRUE:          ${includedTrue}/${pibExpenses.length}`);
  if (Math.abs(totalAmount - totalBm - totalPpn - totalPph) > 1) {
    console.log(`  WARN ⚠  BM+PPN+PPh (${(totalBm+totalPpn+totalPph).toLocaleString('id-ID')}) != total (${totalAmount.toLocaleString('id-ID')})`);
  }
}

// ===== CHECK 5: FIFO ending inventory =====
console.log('\nCHECK 5: FIFO ending inventory value (purchase_batch_cost_layers)...');
const { data: fifoData, error: fifoErr } = await supabase
  .from('purchase_batch_cost_layers')
  .select('quantity, final_functional_unit_cost, batch_id');
if (fifoErr) {
  console.log('  ERROR:', fifoErr.message);
} else {
  const fifoValue = (fifoData || []).reduce((sum, l) =>
    sum + Number(l.quantity || 0) * Number(l.final_functional_unit_cost || 0), 0
  );
  console.log(`  FIFO ending inventory: Rp ${fifoValue.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
}

// ===== CHECK 6: GL 1130 balance =====
console.log('\nCHECK 6: GL 1130 (Inventory) balance...');
const { data: coaData, error: coaErr } = await supabase
  .from('chart_of_accounts')
  .select('id, code, name')
  .eq('code', '1130')
  .single();

if (coaErr || !coaData) {
  console.log('  ERROR finding account 1130:', coaErr?.message);
} else {
  // Get all JE lines for 1130, paginated
  let allLines = [];
  let page = 0;
  const pageSize = 1000;
  while (true) {
    const { data: lines, error: lineErr } = await supabase
      .from('journal_entry_lines')
      .select('debit, credit, journal_entry_id')
      .eq('account_id', coaData.id)
      .range(page * pageSize, (page + 1) * pageSize - 1);
    if (lineErr) { console.log('  ERROR:', lineErr.message); break; }
    if (!lines || lines.length === 0) break;
    allLines = allLines.concat(lines);
    if (lines.length < pageSize) break;
    page++;
  }

  // Get posted, non-reversed JEs
  const jeIds = [...new Set(allLines.map(l => l.journal_entry_id))];
  let postedSet = new Set();
  for (let i = 0; i < jeIds.length; i += 500) {
    const chunk = jeIds.slice(i, i + 500);
    const { data: jes } = await supabase
      .from('journal_entries')
      .select('id')
      .in('id', chunk)
      .eq('is_posted', true)
      .or('is_reversed.is.null,is_reversed.eq.false');
    (jes || []).forEach(j => postedSet.add(j.id));
  }

  const gl1130 = allLines
    .filter(l => postedSet.has(l.journal_entry_id))
    .reduce((sum, l) => sum + Number(l.debit || 0) - Number(l.credit || 0), 0);
  console.log(`  GL 1130 (${coaData.name}) balance: Rp ${gl1130.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
}

console.log('\n' + '='.repeat(60));
console.log('VERIFICATION COMPLETE');
console.log('='.repeat(60));
