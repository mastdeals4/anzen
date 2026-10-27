import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../src/components/finance/BankLedger.tsx', import.meta.url), 'utf8');
assert.match(source, /bank_statement_allocations/);
assert.match(source, /unreconciled_amount/);
assert.match(source, /showUnreconciledOnly/);
assert.match(source, /allocated_amount/);
assert.doesNotMatch(source, /matched_.*unreconciled/);

const unreconciled = (debit, credit, allocations) =>
  Math.max(0, Math.abs(Number(debit || 0) - Number(credit || 0)) - allocations.reduce((sum, n) => sum + n, 0));

assert.equal(unreconciled(100, 0, [100]), 0); // fully allocated
assert.equal(unreconciled(100, 0, [60]), 40); // partial allocation
assert.equal(unreconciled(100, 0, []), 100); // no allocation
assert.equal(unreconciled(3651500, 0, [3161000, 490500]), 0); // protected split
assert.equal(unreconciled(100, 0, []), 100); // legacy matched_* without canonical allocation
assert.equal(unreconciled(100, 0, [100]), 0); // IDR
assert.equal(unreconciled(100, 0, [40]), 60); // USD (unit-preserving; no conversion)

console.log('bank ledger unreconciled regression checks passed');
