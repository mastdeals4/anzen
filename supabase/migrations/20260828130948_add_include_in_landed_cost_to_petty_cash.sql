/*
# Add include_in_landed_cost to petty_cash_transactions

## Purpose
Allows the Import Container UI to control whether each petty cash
transaction participates in the container's landed-cost allocation.

## Safety
- No existing columns changed or removed.
- No historical data overwritten.
- NULL default preserves existing behaviour.
*/

ALTER TABLE petty_cash_transactions
  ADD COLUMN IF NOT EXISTS include_in_landed_cost BOOLEAN DEFAULT NULL;

COMMENT ON COLUMN petty_cash_transactions.include_in_landed_cost IS
  'Controls whether this petty cash transaction is included in its import container''s landed-cost allocation. NULL = not yet decided, TRUE = included, FALSE = excluded.';
