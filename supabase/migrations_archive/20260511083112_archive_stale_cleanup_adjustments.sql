/*
  # Archive stale cleanup adjustments created by previous double-deduction patches

  ## Context
  Before the invoice trigger was fixed (previous migration), every DC-linked
  invoice wrote a duplicate `sale` row. Earlier, one-off cleanup migrations
  inserted counter-`adjustment` rows (e.g. reference_number '*-REVERSED') to
  cancel those duplicate sales and keep batch stock balanced.

  Now that the duplicate sale rows are archived (metadata.superseded=true),
  those counter-adjustments are themselves stale — they add phantom positive
  stock that makes the ledger diverge from the physical `batches.current_stock`.

  ## Fix
  Mark all stale counter-adjustment rows as superseded. Same archival pattern:
  nothing is deleted. Finance traceability preserved.

  Patterns archived:
  1. reference_number LIKE '%-REVERSED'           (bulk SAPJ reversal patches)
  2. reference_type = 'invoice_item_delete'       (logs-only rows from DC-linked invoice deletes)
  3. reference_type = 'dc_item_delete'            (reservation-release rows wrongly typed as adjustment)
  4. notes ILIKE 'Reversed delivery from deleted DC item'  (orphan DC-edit reversals)
*/

UPDATE inventory_transactions
SET metadata = COALESCE(metadata, '{}'::jsonb)
              || jsonb_build_object(
                   'superseded', 'true',
                   'superseded_reason', 'Legacy cleanup adjustment from pre-fix era; paired sale row is already archived',
                   'superseded_at', now()::text
                 )
WHERE transaction_type = 'adjustment'
  AND COALESCE(metadata->>'superseded','false') <> 'true'
  AND (
        reference_number LIKE '%-REVERSED'
     OR reference_type = 'invoice_item_delete'
     OR reference_type = 'dc_item_delete'
     OR notes ILIKE 'Reversed delivery from deleted DC item%'
  );
