// Read-only finance-audit verification using PostgREST + service role.
// Run:
//   SUPABASE_URL='...' SUPABASE_SERVICE_ROLE_KEY='...' node scripts/finance-audit-verify-rest.mjs
// No writes. Credentials stay in env — never logged, never written.

import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.');
  process.exit(1);
}

const sb = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

const banner = (id, label) => console.log(`\n=== §${id}  ${label} ===`);
const ok = (msg) => console.log(`  ${msg}`);
const err = (msg) => console.log(`  [error] ${msg}`);
const fmt = (v) => v === null || v === undefined ? '∅' : (typeof v === 'object' ? JSON.stringify(v) : String(v));
function row(r) { return Object.entries(r).map(([k,v]) => `${k}=${fmt(v)}`).join('  '); }

// ---------------------------------------------------------------------------
// §0 quick sanity — what tables can we see?
banner('0', 'Sanity: can we reach the API as service role?');
{
  const { data, error } = await sb.from('journal_entries').select('id', { count: 'exact', head: true });
  if (error) err(error.message);
  else ok(`journal_entries: reachable (HEAD ok)`);
}

// ---------------------------------------------------------------------------
// §1.2 Unbalanced posted journals
banner('1.2', 'Unbalanced posted journals  |Σdr − Σcr| > 0.01');
{
  // PostgREST doesn't support ABS(col-col) in filters; fetch only is_posted=true and compute in JS.
  const { data, error, count } = await sb
    .from('journal_entries')
    .select('id, entry_number, entry_date, source_module, total_debit, total_credit, is_posted', { count: 'exact' })
    .eq('is_posted', true);
  if (error) { err(error.message); }
  else {
    const bad = (data || []).filter(r => Math.abs((r.total_debit||0) - (r.total_credit||0)) > 0.01);
    ok(`posted journals scanned: ${count}; unbalanced: ${bad.length}`);
    for (const r of bad.slice(0, 15)) {
      console.log('   ', row({
        entry_number: r.entry_number, entry_date: r.entry_date, source_module: r.source_module,
        dr: r.total_debit, cr: r.total_credit, delta: ((r.total_debit||0) - (r.total_credit||0)).toFixed(2),
      }));
    }
  }
}

// ---------------------------------------------------------------------------
// §1.4 Sales invoices missing journal_entry_id (non-draft, non-cancelled)
banner('1.4', 'Non-draft sales invoices with journal_entry_id IS NULL');
{
  const { data, error, count } = await sb
    .from('sales_invoices')
    .select('id, invoice_number, status, total_amount, created_at, is_draft, journal_entry_id', { count: 'exact' })
    .is('journal_entry_id', null);
  if (error) { err(error.message); }
  else {
    const bad = (data || []).filter(r => !r.is_draft && !['draft','cancelled','void'].includes((r.status||'').toLowerCase()));
    ok(`total invoices with NULL journal_entry_id: ${count}; non-draft & non-cancelled: ${bad.length}`);
    for (const r of bad.slice(0, 15)) {
      console.log('   ', row({ invoice_number: r.invoice_number, status: r.status, total: r.total_amount, created: r.created_at }));
    }
  }
}

// ---------------------------------------------------------------------------
// §1.6 duplicate JE per (source_module, reference_id)
banner('1.6', 'Duplicate posted JE per (source_module, reference_id)');
{
  const { data, error } = await sb
    .from('journal_entries')
    .select('id, source_module, reference_id, is_posted')
    .eq('is_posted', true)
    .not('reference_id', 'is', null);
  if (error) err(error.message);
  else {
    const map = new Map();
    for (const r of data || []) {
      const k = `${r.source_module}::${r.reference_id}`;
      map.set(k, (map.get(k) || 0) + 1);
    }
    const dupes = [...map.entries()].filter(([,n]) => n > 1).sort((a,b)=>b[1]-a[1]);
    ok(`duplicate keys: ${dupes.length}`);
    for (const [k, n] of dupes.slice(0, 15)) console.log('   ', `key=${k}  count=${n}`);
  }
}

// ---------------------------------------------------------------------------
// §1.10 orphan journal_entry_lines
banner('1.10', 'journal_entry_lines whose journal_entry_id has no parent');
{
  const { data: lines, error: e1 } = await sb.from('journal_entry_lines').select('id, journal_entry_id');
  if (e1) { err(e1.message); }
  else {
    const jeIds = new Set();
    {
      // Fetch the full set of JE ids (paginate if huge)
      let from = 0; const page = 5000;
      while (true) {
        const { data, error } = await sb.from('journal_entries').select('id').range(from, from + page - 1);
        if (error) { err(error.message); break; }
        if (!data || data.length === 0) break;
        for (const r of data) jeIds.add(r.id);
        if (data.length < page) break;
        from += page;
      }
    }
    const orphans = (lines || []).filter(l => !jeIds.has(l.journal_entry_id));
    ok(`journal_entry_lines: ${lines?.length ?? 0}; orphans: ${orphans.length}`);
  }
}

// ---------------------------------------------------------------------------
// §3.2a sales invoices with paid > total
banner('3.2a', 'Sales invoices over-paid (paid_amount > total_amount + 0.01)');
{
  const { data, error } = await sb.from('sales_invoices').select('id, invoice_number, total_amount, paid_amount');
  if (error) err(error.message);
  else {
    const bad = (data || []).filter(r => (r.paid_amount||0) > (r.total_amount||0) + 0.01);
    ok(`over-paid: ${bad.length}`);
    for (const r of bad.slice(0, 15)) console.log('   ', row({ invoice_number: r.invoice_number, total: r.total_amount, paid: r.paid_amount, over: (r.paid_amount - r.total_amount).toFixed(2) }));
  }
}

// §3.2b purchase invoices with paid > total
banner('3.2b', 'Purchase invoices over-paid');
{
  const { data, error } = await sb.from('purchase_invoices').select('id, invoice_number, total_amount, paid_amount');
  if (error) err(error.message);
  else {
    const bad = (data || []).filter(r => (r.paid_amount||0) > (r.total_amount||0) + 0.01);
    ok(`over-paid: ${bad.length}`);
    for (const r of bad.slice(0, 15)) console.log('   ', row({ invoice_number: r.invoice_number, total: r.total_amount, paid: r.paid_amount, over: (r.paid_amount - r.total_amount).toFixed(2) }));
  }
}

// ---------------------------------------------------------------------------
// §3.12 stale partial PIs (paid ≈ total, status=partial)
banner('3.12', 'Stale partial purchase invoices (status=partial, balance ≤ 0.99)');
{
  const { data, error } = await sb.from('purchase_invoices').select('id, invoice_number, status, total_amount, paid_amount').eq('status', 'partial');
  if (error) err(error.message);
  else {
    const bad = (data || []).filter(r => ((r.total_amount||0) - (r.paid_amount||0)) <= 0.99);
    ok(`stale: ${bad.length}`);
    for (const r of bad.slice(0, 15)) console.log('   ', row({ invoice_number: r.invoice_number, total: r.total_amount, paid: r.paid_amount, bal: (r.total_amount - r.paid_amount).toFixed(2) }));
  }
}

// ---------------------------------------------------------------------------
// §4.9a negative current_stock
banner('4.9a', 'batches with current_stock < 0');
{
  const { data, error } = await sb.from('batches').select('id, batch_number, current_stock, product_id').lt('current_stock', 0);
  if (error) err(error.message);
  else {
    ok(`negative stock rows: ${data?.length ?? 0}`);
    for (const r of (data || []).slice(0, 15)) console.log('   ', row(r));
  }
}

// ---------------------------------------------------------------------------
// §4.8 inventory_transactions with NULL operation_id
banner('4.8', 'inventory_transactions with NULL operation_id');
{
  const { count: total, error: e1 } = await sb.from('inventory_transactions').select('id', { count: 'exact', head: true });
  const { count: nulls, error: e2 } = await sb.from('inventory_transactions').select('id', { count: 'exact', head: true }).is('operation_id', null);
  if (e1 || e2) err((e1||e2).message);
  else ok(`total=${total}  null_operation_id=${nulls}  ratio=${total ? (nulls/total*100).toFixed(1) : 0}%`);
}

// §4.8b duplicate operation_id
banner('4.8b', 'inventory_transactions with duplicate operation_id (should be 0)');
{
  const { data, error } = await sb.from('inventory_transactions').select('operation_id').not('operation_id','is', null);
  if (error) err(error.message);
  else {
    const map = new Map();
    for (const r of data || []) map.set(r.operation_id, (map.get(r.operation_id)||0)+1);
    const dupes = [...map.entries()].filter(([,n]) => n > 1);
    ok(`duplicate operation_ids: ${dupes.length}`);
    for (const [oid, n] of dupes.slice(0, 10)) console.log('   ', `operation_id=${oid}  count=${n}`);
  }
}

// ---------------------------------------------------------------------------
// §3.3 orphan JEs (voucher row deleted)
banner('3.3', 'JEs whose voucher row was deleted');
{
  const wantedModules = ['payment_voucher','receipt_voucher','fund_transfer','expense','petty_cash'];
  const { data: jes, error } = await sb
    .from('journal_entries')
    .select('id, source_module, reference_id')
    .in('source_module', wantedModules)
    .not('reference_id', 'is', null);
  if (error) { err(error.message); }
  else {
    const buckets = { payment_voucher:'payment_vouchers', receipt_voucher:'receipt_vouchers',
                      fund_transfer:'fund_transfers', expense:'finance_expenses', petty_cash:'petty_cash_transactions' };
    const summary = {};
    for (const mod of wantedModules) {
      const refs = (jes || []).filter(j => j.source_module === mod).map(j => j.reference_id);
      if (refs.length === 0) { summary[mod] = 0; continue; }
      const tbl = buckets[mod];
      // batch in chunks (PostgREST .in() limit ≈ 1000)
      const present = new Set();
      for (let i = 0; i < refs.length; i += 500) {
        const chunk = refs.slice(i, i+500);
        const { data, error: e } = await sb.from(tbl).select('id').in('id', chunk);
        if (e) { err(`${tbl}: ${e.message}`); break; }
        for (const r of data || []) present.add(r.id);
      }
      summary[mod] = refs.filter(r => !present.has(r)).length;
    }
    for (const [k,v] of Object.entries(summary)) console.log('   ', `${k}: ${v} orphan JEs`);
  }
}

// ---------------------------------------------------------------------------
// §4.7 purchase invoices with >1 posted JE (GRN + PI double-credit risk)
banner('4.7', 'Purchase invoices with >1 posted JE');
{
  const { data, error } = await sb
    .from('journal_entries')
    .select('id, reference_id, source_module, is_posted')
    .in('source_module', ['purchase_invoice','grn','goods_receipt_note'])
    .eq('is_posted', true)
    .not('reference_id', 'is', null);
  if (error) err(error.message);
  else {
    const map = new Map();
    for (const r of data || []) map.set(r.reference_id, (map.get(r.reference_id)||0)+1);
    const dupes = [...map.entries()].filter(([,n]) => n > 1).sort((a,b)=>b[1]-a[1]);
    ok(`reference_ids with >1 JE: ${dupes.length}`);
    for (const [rid, n] of dupes.slice(0, 15)) console.log('   ', `purchase_invoice_id=${rid}  je_count=${n}`);
  }
}

// ---------------------------------------------------------------------------
// §4.11 stock conservation: current_stock + delivered + invoiced =? import_quantity
banner('4.11', 'Stock-flow conservation: current_stock + delivered + invoiced =?= import_quantity');
{
  // Fetch batches once
  const batches = [];
  for (let from=0; ; from += 5000) {
    const { data, error } = await sb.from('batches').select('id, batch_number, import_quantity, current_stock, product_id').range(from, from+4999);
    if (error) { err(error.message); break; }
    if (!data || data.length === 0) break;
    batches.push(...data);
    if (data.length < 5000) break;
  }
  const dcQty = new Map(), invQty = new Map();
  // Aggregate delivery_challan_items
  for (let from=0; ; from += 5000) {
    const { data, error } = await sb.from('delivery_challan_items').select('batch_id, quantity').range(from, from+4999);
    if (error) { err('dc: '+error.message); break; }
    if (!data || data.length === 0) break;
    for (const r of data) if (r.batch_id) dcQty.set(r.batch_id, (dcQty.get(r.batch_id)||0) + Number(r.quantity || 0));
    if (data.length < 5000) break;
  }
  // Aggregate sales_invoice_items
  for (let from=0; ; from += 5000) {
    const { data, error } = await sb.from('sales_invoice_items').select('batch_id, quantity').range(from, from+4999);
    if (error) { err('si: '+error.message); break; }
    if (!data || data.length === 0) break;
    for (const r of data) if (r.batch_id) invQty.set(r.batch_id, (invQty.get(r.batch_id)||0) + Number(r.quantity || 0));
    if (data.length < 5000) break;
  }
  const errors = [];
  for (const b of batches) {
    const dq = dcQty.get(b.id) || 0;
    const iq = invQty.get(b.id) || 0;
    const lhs = Number(b.current_stock||0) + dq + iq;
    const rhs = Number(b.import_quantity||0);
    if (Math.abs(lhs - rhs) > 0.001) {
      errors.push({ batch_number: b.batch_number, import_quantity: rhs, current_stock: b.current_stock, delivered: dq, invoiced: iq, error: (lhs - rhs).toFixed(3) });
    }
  }
  ok(`batches scanned: ${batches.length}; conservation errors: ${errors.length}`);
  errors.sort((a,b) => Math.abs(parseFloat(b.error)) - Math.abs(parseFloat(a.error)));
  for (const r of errors.slice(0, 15)) console.log('   ', row(r));
}

// ---------------------------------------------------------------------------
// §4.5 inventory GL vs Σ(batch * cost) parity
banner('4.5', 'GL inventory account (1130) balance vs Σ(batches.current_stock × cost)');
{
  // a) GL: SUM(debit-credit) where coa.code='1130' AND je.is_posted
  const { data: coa, error: e1 } = await sb.from('chart_of_accounts').select('id, code').eq('code', '1130');
  if (e1) { err(e1.message); }
  else if (!coa || coa.length === 0) {
    ok('no chart_of_accounts row with code=1130 — GL parity check skipped');
  } else {
    const acctId = coa[0].id;
    let gl = 0;
    for (let from=0; ; from += 5000) {
      const { data, error } = await sb.from('journal_entry_lines')
        .select('debit, credit, journal_entry_id')
        .eq('account_id', acctId).range(from, from+4999);
      if (error) { err(error.message); break; }
      if (!data || data.length === 0) break;
      // need to filter by posted parent
      const jeIds = [...new Set(data.map(d => d.journal_entry_id))];
      const posted = new Set();
      for (let i = 0; i < jeIds.length; i += 500) {
        const { data: p, error: pe } = await sb.from('journal_entries').select('id').in('id', jeIds.slice(i,i+500)).eq('is_posted', true);
        if (pe) { err(pe.message); break; }
        for (const r of p || []) posted.add(r.id);
      }
      for (const d of data) {
        if (posted.has(d.journal_entry_id)) gl += Number(d.debit || 0) - Number(d.credit || 0);
      }
      if (data.length < 5000) break;
    }
    // b) batches: SUM(current_stock * COALESCE(landed_cost_per_unit, cost_per_unit, import_price))
    let batchValue = 0;
    for (let from=0; ; from += 5000) {
      const { data, error } = await sb.from('batches')
        .select('current_stock, landed_cost_per_unit, cost_per_unit, import_price')
        .range(from, from+4999);
      if (error) { err(error.message); break; }
      if (!data || data.length === 0) break;
      for (const b of data) {
        const cost = Number(b.landed_cost_per_unit ?? b.cost_per_unit ?? b.import_price ?? 0);
        batchValue += Number(b.current_stock || 0) * cost;
      }
      if (data.length < 5000) break;
    }
    ok(`gl_inventory=${gl.toFixed(2)}  batch_value=${batchValue.toFixed(2)}  variance=${(gl - batchValue).toFixed(2)}`);
  }
}

// ---------------------------------------------------------------------------
// Final: notes on what we couldn't verify without DB URL
console.log('\n--- NOT VERIFIED (need direct DB URL for pg_catalog) ---');
console.log('  §1.1   existence of IntegrityMonitor views');
console.log('  §1.5   assert_posting_allowed function + call sites');
console.log('  §0.1   orphan src/*.sql functions (manual_journal_recompute, centralize_approved_journal_posting)');
console.log('  §1.11  journal_entries currency column');
console.log('  §2.1   trial_balance_view date filter');
console.log('  §4.9b  NOT VALID constraint state on batches / inventory_transactions');

console.log('\nDone.');
