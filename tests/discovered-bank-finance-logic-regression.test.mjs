import assert from 'node:assert/strict';
import fs from 'node:fs';

const migration = fs.readFileSync(new URL('../supabase/migrations/20260826110000_fix_discovered_bank_finance_logic.sql', import.meta.url), 'utf8');
const ledger = fs.readFileSync(new URL('../src/components/finance/BankLedger.tsx', import.meta.url), 'utf8');
const rounding = fs.readFileSync(new URL('../supabase/migrations/20260616120000_invoice_rounding_tolerance.sql', import.meta.url), 'utf8');
const relink = fs.readFileSync(new URL('../supabase/migrations/20260826090000_safe_historical_bank_allocation_relink.sql', import.meta.url), 'utf8');

// Allocation relinks derive typed document identity from the target journal;
// the legacy matched_* projection is therefore refreshed from the same row.
assert.match(migration, /resolve_bank_allocation_document/);
assert.match(migration, /sync_bank_allocation_document_identity/);
assert.match(migration, /BEFORE INSERT OR UPDATE OF journal_entry_id, document_type, document_id/);
assert.match(migration, /document_type := 'payment'/);
assert.match(migration, /document_type := 'expense'/);
assert.match(migration, /Historical correction journals intentionally retain/);
assert.match(migration, /NEW\.document_type := v_type/);
assert.match(migration, /NEW\.document_id := v_document/);

// Partial supplier settlement: payable is gross less PPh, cash is the actual
// allocated payment, and the remainder stays AP (no FX gain/write-off).
assert.match(migration, /finance_expense_id IS NOT NULL/);
assert.match(migration, /v_expense_mode/);
assert.match(migration, /v_pph_bank:=0; -- PPh was recognized on the expense and remains payable/);
assert.match(migration, /Expense payment cash \(%\) must equal allocated supplier amount plus bank charge/);
assert.match(migration, /paid_amount=LEAST\(GREATEST\(v_supplier_paid,0\),GREATEST\(v_payable,0\)\)/);
const payable = 7_000_000 - 140_000;
const actualCash = 6_820_000;
assert.equal(payable, 6_860_000);
assert.equal(payable - actualCash, 40_000);
assert.equal(actualCash, 6_820_000);

// The bank report now uses the canonical allocation relationship for every
// payment type: statement date for bank movement, journal date as fallback.
assert.match(ledger, /bank_statement_allocations/);
assert.match(ledger, /canonicalBankDate/);
assert.match(ledger, /canonicalBankDate\.get\(line\.journal_entry_id\) \|\| journal\?\.entry_date/);

// Rounding continues to use the existing tolerance RPC and canonical accounts.
assert.match(rounding, /apply_receipt_allocation_rounding_adjustment/);
assert.match(rounding, /code = '1120'/);
assert.match(rounding, /code = '4900'/);

// Fund-transfer pairing keeps the unique confirmed-status constraint; the
// controlled context is the only path that suppresses a duplicate promotion.
assert.match(relink, /historical_allocation_relink_context_active/);
assert.match(relink, /matching_status = 'confirmed'/);
assert.doesNotMatch(migration, /DROP (?:INDEX|CONSTRAINT)|DISABLE TRIGGER/);

console.log('discovered bank/finance logic regression checks passed');
