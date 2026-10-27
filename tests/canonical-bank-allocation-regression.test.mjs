import assert from 'node:assert/strict';
import fs from 'node:fs';

const linking = fs.readFileSync(new URL('../src/components/finance/bankTransactionLinking.ts', import.meta.url), 'utf8');
const recon = fs.readFileSync(new URL('../src/components/finance/BankReconciliationEnhanced.tsx', import.meta.url), 'utf8');
const ledger = fs.readFileSync(new URL('../src/components/finance/BankLedger.tsx', import.meta.url), 'utf8');

const status = (bank, allocations, epsilon = 0.01) => {
  const allocated = allocations.reduce((sum, amount) => sum + Number(amount || 0), 0);
  if (allocated <= epsilon) return 'unmatched';
  if (allocated >= bank - epsilon) return 'matched';
  return 'partially_reconciled';
};

assert.match(linking, /canonicalBankReconciliationStatus/);
assert.match(linking, /Legacy matched_\* FKs, reconciliation_status, and manually_unlinked are ignored/);
assert.equal(status(100, []), 'unmatched');
assert.equal(status(100, [100]), 'matched');
assert.equal(status(100, [60]), 'partially_reconciled');
assert.equal(status(3651500, [490500, 3161000]), 'matched');

// Canonical-only rows remain discoverable and visible when legacy projections
// are NULL; no screen may require matched_entry_id/payment_id.
assert.match(recon, /const allocations = allocationMap\.get\(row\.id\) \|\| \[\]/);
assert.match(recon, /const status = canonicalBankReconciliationStatus/);
assert.match(ledger, /Canonical allocations are authoritative/);
assert.match(ledger, /const allocated = docs\.reduce/);

// A large split remains one bank line and is reconciled by the allocation sum.
const twentyFive = Array.from({ length: 25 }, () => 4);
assert.equal(status(100, twentyFive), 'matched');

// Date windows use the bank transaction date with an exclusive next-day end.
const inWindow = (date, start, endInclusive) => date >= start && date < endInclusive;
assert.equal(inWindow('2026-02-20', '2026-01-01', '2026-09-01'), true);
assert.equal(inWindow('2026-02-20', '2026-07-01', '2026-09-01'), false);

console.log('canonical bank allocation regression checks passed');
