# Migration Reconciliation Plan — Finance Version 1.0

## Current evidence

The linked Supabase project reports 658 migration-history rows. The repository
contains 643 migration files. The comparison found:

- 15 remote-only versions, including historical July repair/security batches.
- 93 local-only versions, including files not recorded in the linked history.
- 9 duplicate local version timestamps:
  `20260104164953`, `20260418120000`, `20260418123000`, `20260430090000`,
  `20260430113000`, `20260430120000`, `20260430133000`, `20260527120000`,
  and `20260723150000`.
- `20260731140000` and `20260731143000` are present locally and remotely.
- `20260731150000_allow_bidirectional_payment_rates.sql` is local-only.

The counts are evidence of history drift, not proof that any particular schema
object is missing. No history row has been marked applied or reverted by this
release.

## Classification work required

For every remote-only and local-only version, compare the migration SQL and a
live schema export by object identity:

1. tables, columns, constraints, indexes, and enum values;
2. functions by schema, name, argument types, and return type;
3. triggers by table, timing, event, and function;
4. views/materialized views and definitions;
5. RLS policies, grants, storage buckets, and edge-function configuration;
6. data backfills and repairs, including whether they are safely repeatable.

Classify each migration as active, superseded, duplicate-purpose, obsolete,
or data-repair-only. A later `CREATE OR REPLACE FUNCTION` does not make an
earlier data backfill obsolete; those must be reviewed separately.

## Safe Version 1.0 strategy

### Existing production databases

Continue with incremental migrations. First reconcile the history table using
the mapped evidence and an approved operator review. Apply
`20260731150000_allow_bidirectional_payment_rates.sql` only after the mapping
confirms that the prior canonical payment function is present.

### New installations

Create a generated baseline only after the comparison is complete. The
baseline must be produced from a clean database and include schema objects,
RLS, grants, storage, functions, triggers, views, and seed data. Future
migrations retain new monotonic timestamps and are tested against both the
baseline database and an upgraded production-shaped database.

### Explicitly prohibited

- Blind `supabase migration repair` for all mismatches.
- Deleting or renaming applied migration files.
- Squashing before a production schema diff and rollback plan.
- Treating a matching function definition as proof that a data repair ran.
