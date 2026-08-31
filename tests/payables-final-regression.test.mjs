import assert from 'node:assert/strict';
import fs from 'node:fs';

const migration = fs.readFileSync(new URL('../supabase/migrations/20260831230000_fix_payables_person_and_purchase_invoice_linkage.sql', import.meta.url), 'utf8');
const ui = fs.readFileSync(new URL('../src/components/finance/PayablesManager.tsx', import.meta.url), 'utf8');

assert.match(migration, /fe\.approval_status = 'approved'/);
assert.match(migration, /fe\.supplier_id IS NULL AND fe\.staff_id IS NULL/);
assert.match(migration, /regexp_replace/);
assert.match(migration, /coa\.code = '2110'/);
assert.match(migration, /CREATE OR REPLACE FUNCTION public\.get_outstanding_purchase_invoices/);
assert.doesNotMatch(migration, /JOIN public\.supplier_payables_view/);
assert.match(migration, /va\.purchase_invoice_id = pi\.id/);
assert.match(migration, /pv\.is_posted = true/);
assert.match(migration, /i\.total_amount > i\.paid_amount \+ 0\.01/);
assert.match(ui, /rpc\('get_outstanding_purchase_invoices'/);
assert.match(ui, /table: 'voucher_allocations'/);
assert.match(ui, /table: 'payment_vouchers'/);

console.log('final payables regression checks passed');
