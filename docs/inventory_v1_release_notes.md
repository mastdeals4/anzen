# Inventory Version 1.0 Release Notes

Release date: 1 August 2026

## Delivered

- One signed, locked, idempotent physical stock engine.
- Canonical Batch Create/Edit and zero-stock archive.
- FEFO Sales Order reservation with expired-batch exclusion.
- Delivery Challan-only normal stock OUT.
- Reversal/repost for approved DC edit and cancellation.
- Sales Invoice validation-only inventory behavior.
- Material Return, Credit Note, Stock Rejection, and Stock Adjustment lifecycle
  posting and reversal.
- Direct stock/movement write guards.
- Canonical Stock Summary and Inventory Movement report sources.
- Forward certification RPC and rollback regression suite.
- Anonymous access removed from Inventory `SECURITY DEFINER` functions.
- Three mathematically proven duplicate legacy movement rows marked superseded
  without quantity or document changes.

## Historical status

Pre-repair authenticated reconciliation:

- Verified: 16
- Legacy Verified: 17
- Repair Required: 2
- Manual Review: 3

The two repair-required batches received metadata-only, precondition-gated
repairs. The three ambiguous batches remain unchanged.

## Migrations

- `20260801120000_inventory_v1_canonical_stock_engine.sql`
- `20260801121000_fix_credit_note_reversal_trigger_timing.sql`
- `20260801122000_inventory_v1_provable_legacy_metadata_repairs.sql`
- `20260801123000_revoke_anon_inventory_security_definer.sql`
- `20260801124000_revoke_public_inventory_security_definer.sql`
- `20260801125000_exclude_expired_stock_from_available_summary.sql`

## Compatibility

Finance Version 1.0 accounting rules were not changed. The Credit Note
compatibility migration changes trigger timing only and retains the existing
journal reversal function. Finance release regression must remain green.
