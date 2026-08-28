-- Fix remaining ghost journal entries with zeroed-out lines.

-- JE2607-0023: References deleted test invoice __TEST_INV__. Orphan — delete.
DELETE FROM journal_entry_lines WHERE journal_entry_id = '7b78e08a-e623-47e6-b6c1-0ffbc72b51ed';
DELETE FROM journal_entries WHERE id = '7b78e08a-e623-47e6-b6c1-0ffbc72b51ed';

-- JE2602-0119: References expense EXP/26/089 (140,000 IDR, fully paid via bank).
-- Lines exist with correct accounts but zero amounts. Restore amounts.
-- Line 1: Dr Delivery Expenses (6510) 140,000
-- Line 2: Cr Bank BCA (111101) 140,000
UPDATE journal_entry_lines
SET debit = 140000, credit = 0
WHERE journal_entry_id = '91e00ea4-b417-478b-a3ce-87329f2d6c43'
  AND line_number = 1;

UPDATE journal_entry_lines
SET debit = 0, credit = 140000
WHERE journal_entry_id = '91e00ea4-b417-478b-a3ce-87329f2d6c43'
  AND line_number = 2;

-- Recalculate the JE header totals.
UPDATE journal_entries
SET total_debit = 140000, total_credit = 140000
WHERE id = '91e00ea4-b417-478b-a3ce-87329f2d6c43';