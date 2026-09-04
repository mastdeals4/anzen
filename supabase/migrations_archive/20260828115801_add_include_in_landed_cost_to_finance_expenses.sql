/*
# Add include_in_landed_cost Column to finance_expenses

## Purpose
Adds a nullable boolean column `include_in_landed_cost` to the `finance_expenses`
table. This column lets the user control whether each linked expense participates
in the landed-cost allocation for its import container.

## Column
- `include_in_landed_cost` (boolean, nullable, default NULL)
  - NULL  → not yet decided (treated as "not included" in allocation sums)
  - TRUE  → this actual expense is included in the container's landed-cost pool
  - FALSE → this actual expense is excluded from the container's landed-cost pool
  The expense itself remains a valid finance expense regardless of this flag.

## Safety
- No existing columns changed or removed.
- No historical data overwritten.
- NULL default preserves existing behaviour (expenses are not auto-included).
*/

ALTER TABLE finance_expenses
  ADD COLUMN IF NOT EXISTS include_in_landed_cost BOOLEAN DEFAULT NULL;

COMMENT ON COLUMN finance_expenses.include_in_landed_cost IS
  'Controls whether this expense is included in its import container''s landed-cost allocation. NULL = not yet decided, TRUE = included, FALSE = excluded.';
