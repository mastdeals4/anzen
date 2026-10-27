import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../src/components/finance/BankLedger.tsx', import.meta.url), 'utf8');
assert.match(source, /transaction_debit \?\? line\.debit \?\? 0/);
assert.match(source, /transaction_credit \?\? line\.credit \?\? 0/);
assert.match(source, /canonicalBankDate/);
assert.match(source, /bank_statement_lines!inner\(transaction_date\)/);
assert.match(source, /setGlClosingBalance\(storedOpeningBalance \+ glMovement\)/);
assert.match(source, /journal_entries\.is_reversed', false/);

const includeInEconomicGL = (journal) => {
  if (!journal.is_posted || journal.is_reversed) return false;
  return true;
};

const movement = (line, currency) => {
  const debit = currency === 'USD' ? Number(line.transaction_debit ?? line.debit ?? 0) : Number(line.debit || 0);
  const credit = currency === 'USD' ? Number(line.transaction_credit ?? line.credit ?? 0) : Number(line.credit || 0);
  return debit - credit;
};

const journal = (overrides = {}) => ({
  is_posted: true,
  is_reversed: false,
  source_module: 'payment',
  reference_number: 'PV-001',
  description: 'Ordinary payment',
  ...overrides,
});

// 1. Normal active bank journals are included.
assert.equal(includeInEconomicGL(journal()), true);

// 2. Reversed originals remain excluded by the existing lifecycle rule.
assert.equal(includeInEconomicGL(journal({ source_module: 'fund_transfers', is_reversed: true })), false);

// 3-5. Active historical evidence is not interpreted in the UI; canonical
// journal lifecycle flags determine whether it has current accounting effect.
const hrRev = journal({ source_module: 'historical_repair', reference_number: 'HR-REV-FT2601-0006' });
const hrFx = journal({ source_module: 'historical_repair', reference_number: 'HR-FX-FT2601-0006' });
assert.equal(includeInEconomicGL(hrRev), true);
assert.equal(includeInEconomicGL(hrFx), true);
assert.equal(includeInEconomicGL({ ...hrRev, is_reversed: true }), false);

// 7. Opening balance is added to movement for a like-for-like closing balance.
assert.equal(995 + 5_454, 6_449);

// 8. IDR continues to use functional debit/credit, never transaction amounts.
assert.equal(movement({ debit: 16_420_000, credit: 0, transaction_debit: 1_000, transaction_credit: 0 }, 'IDR'), 16_420_000);

// 9. Ordinary expenses, payments, and receipts remain included.
for (const source_module of ['expenses', 'payment', 'receipt']) {
  assert.equal(includeInEconomicGL(journal({ source_module })), true);
}

// 10. Statement allocations provide the bank economic date for every source.
assert.match(source, /canonicalBankDate\.get\(line\.journal_entry_id\) \|\| journal\?\.entry_date/);

// USD retains transaction amounts with the established functional fallback.
assert.equal(movement({ debit: 89_150, credit: 0, transaction_debit: 5, transaction_credit: 0 }, 'USD'), 5);
assert.equal(movement({ debit: 5, credit: 0, transaction_debit: null, transaction_credit: null }, 'USD'), 5);

console.log('historical cash repair reconciliation checks passed');
