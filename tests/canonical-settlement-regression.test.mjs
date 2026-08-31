import assert from 'node:assert/strict';
import fs from 'node:fs';

const migration = fs.readFileSync(new URL('../supabase/migrations/20260831240000_fix_salary_advance_settlement_and_bank_link_candidates.sql', import.meta.url), 'utf8');
const voucher = fs.readFileSync(new URL('../src/components/finance/PaymentVoucherManager.tsx', import.meta.url), 'utf8');

assert.match(migration, /salary_advance_applications/);
assert.match(migration, /settlement\.is_posted = true/);
assert.match(migration, /allocated_paid_amount/);
assert.match(migration, /p\.payable_amount > p\.current_paid_amount \+ 0\.01/);
assert.match(voucher, /documentDate=\{viewingVoucher\.voucher_date\}/);
assert.match(voucher, /documentOutstanding=\{Number\(viewingVoucher\.actual_bank_debit/);
assert.match(voucher, /documentLabel=\{\[viewingVoucher\.voucher_number, viewingVoucher\.reference_number\]/);

console.log('canonical settlement regression checks passed');
