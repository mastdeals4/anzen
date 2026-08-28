import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../src/components/finance/BankLedger.tsx', import.meta.url), 'utf8');
assert.match(source, /Reconciled Bank Movement/);
assert.match(source, /Unreconciled Bank Transactions/);
assert.match(source, /Bank vs GL Difference/);
assert.match(source, /opening balance \/ posting cut-off \/ statement population/);
assert.match(source, /canonically allocated bank lines as unreconciled/);
assert.match(source, /bank_statement_allocations/);

console.log('bank ledger reconciliation summary checks passed');
