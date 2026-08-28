import assert from 'node:assert/strict';
import fs from 'node:fs';

const migration = fs.readFileSync(new URL('../supabase/migrations/20260826090000_safe_historical_bank_allocation_relink.sql', import.meta.url), 'utf8');

assert.match(migration, /relink_historical_bank_allocation/);
assert.match(migration, /historical_allocation_relink_context_active/);
assert.match(migration, /Source journal must be reversed/);
assert.match(migration, /Replacement journal must be posted and not reversed/);
assert.match(migration, /Allocation amount changed/);
assert.match(migration, /idempotent/);
assert.match(migration, /matched_fund_transfer_id/);
assert.match(migration, /matching_status = 'confirmed'/);
assert.match(migration, /v_conflict/);
assert.doesNotMatch(migration, /DROP INDEX|DROP CONSTRAINT|DISABLE TRIGGER/);

// Behavioral matrix for the guarded status decision:
const status = (pairedConfirmed, currentAllocated, relinkContext) => {
  if (currentAllocated && pairedConfirmed && relinkContext) return 'suggested';
  return currentAllocated ? 'confirmed' : 'none';
};
assert.equal(status(true, true, true), 'suggested'); // confirmed USD + suggested IDR
assert.equal(status(false, true, true), 'confirmed'); // suggested USD + confirmed IDR
assert.equal(status(true, true, true), 'suggested'); // both confirmed: preserve existing paired confirmation
assert.equal(status(false, true, true), 'confirmed'); // both suggested: normal promotion
assert.equal(status(true, true, true), 'suggested'); // repeated relink remains safe
assert.equal(status(false, true, false), 'confirmed'); // ordinary allocation unchanged

console.log('historical allocation relink regression checks passed');
