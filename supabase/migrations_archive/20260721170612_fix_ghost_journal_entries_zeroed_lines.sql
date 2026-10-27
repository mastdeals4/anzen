-- Fix ghost journal entries with zeroed-out lines.
-- These JEs were posted but their line amounts were corrupted to 0.
-- Root cause: likely a failed edit/re-post cycle that zeroed the lines
-- without deleting the JE header.

-- JE2603-0037: PV was deleted, JE is orphaned with zero lines. Delete it.
DELETE FROM journal_entry_lines WHERE journal_entry_id = 'c12faea7-2f14-49db-bba6-112354e8e4da';
DELETE FROM journal_entries WHERE id = 'c12faea7-2f14-49db-bba6-112354e8e4da';

-- JE2603-0036: PV/25-26/002 still exists and is posted (amount 5,200,000).
-- Restore the correct line amounts.
-- Line 1: Dr Accounts Payable (2110) 5,200,000
-- Line 3: Cr Bank BCA (111101) 5,200,000
UPDATE journal_entry_lines
SET debit = 5200000, credit = 0
WHERE journal_entry_id = '1a1d6287-328f-4610-9d40-e12db3a4b574'
  AND line_number = 1;

UPDATE journal_entry_lines
SET debit = 0, credit = 5200000
WHERE journal_entry_id = '1a1d6287-328f-4610-9d40-e12db3a4b574'
  AND line_number = 3;

-- Recalculate the JE header totals (the AFTER trigger on journal_entry_lines
-- will fire from the UPDATEs above, but set them explicitly to be safe).
UPDATE journal_entries
SET total_debit = 5200000, total_credit = 5200000
WHERE id = '1a1d6287-328f-4610-9d40-e12db3a4b574';