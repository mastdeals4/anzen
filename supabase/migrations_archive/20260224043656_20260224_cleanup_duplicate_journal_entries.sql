/*
  # Clean Up Duplicate Journal Entries

  ## What This Does
  1. Removes the 2 extra journal entries for FT2601-0003 (fund transfer posted 3 times instead of 1)
  2. Removes the 1 extra journal entry for RV2601-0004 (receipt voucher posted 2 times instead of 1)
  3. Each record already points to the CORRECT (latest) journal_entry_id, so we only delete orphaned duplicates

  ## Root Cause
  The fund transfer and receipt voucher triggers had no idempotency guard - if the record
  was updated/saved multiple times, the trigger fired multiple times creating duplicate JEs.

  ## Safety
  - We only delete journal entries that are NOT referenced by their source record's journal_entry_id
  - The source records (fund_transfers, receipt_vouchers) already point to the correct (last) entry
*/

-- Delete the 2 older duplicate JEs for FT2601-0003 (the fund_transfers record points to the last one)
DELETE FROM journal_entries
WHERE id IN ('24b519fe-b7ff-448e-8783-a90240c0f190', '40e65398-536b-4f2b-9aaa-87d788c9cfca')
  AND reference_number = 'FT2601-0003'
  AND id NOT IN (SELECT COALESCE(journal_entry_id, '00000000-0000-0000-0000-000000000000'::uuid) FROM fund_transfers WHERE transfer_number = 'FT2601-0003');

-- Delete the older duplicate JE for RV2601-0004 (the receipt_vouchers record points to the last one)
DELETE FROM journal_entries
WHERE reference_number = 'RV2601-0004'
  AND id NOT IN (SELECT COALESCE(journal_entry_id, '00000000-0000-0000-0000-000000000000'::uuid) FROM receipt_vouchers WHERE voucher_number = 'RV2601-0004');
