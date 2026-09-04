
/*
  # Fix Journal Entry Data Issues

  1. Fix rounding error in JE2601-0051
     - Expense 129d69a4 has amount = 525000.00 (correct)
     - Journal entry JE2601-0051 and its lines have 524999.98 (wrong - old bad data)
     - Correct all to 525000.00

  2. Delete ghost journal entry JE2601-0165
     - This entry references expense 197de957 (a Rp 2,500 bank charge from Feb 16)
     - But records Rp 10,000,000 on Jan 28 - clearly corrupted/orphaned data
     - The real transaction for that 10M on Jan 28 was fund transfer FT2602-0001 (JE2602-0082)
     - Removing this prevents the double-counting on Bank IDR account ledger
*/

-- Fix #1: Correct the rounding error in JE2601-0051
UPDATE journal_entries
SET total_debit = 525000.00,
    total_credit = 525000.00
WHERE entry_number = 'JE2601-0051'
AND total_debit = 524999.98;

UPDATE journal_entry_lines
SET debit = 525000.00
WHERE journal_entry_id = (SELECT id FROM journal_entries WHERE entry_number = 'JE2601-0051')
AND debit = 524999.98;

UPDATE journal_entry_lines
SET credit = 525000.00
WHERE journal_entry_id = (SELECT id FROM journal_entries WHERE entry_number = 'JE2601-0051')
AND credit = 524999.98;

-- Fix #2: Delete the ghost journal entry JE2601-0165
-- This entry has wrong reference (points to a 2500 Rp expense from Feb 16)
-- but records 10M on Jan 28, causing a false double-debit on Bank IDR
DELETE FROM journal_entry_lines
WHERE journal_entry_id = (SELECT id FROM journal_entries WHERE entry_number = 'JE2601-0165');

DELETE FROM journal_entries
WHERE entry_number = 'JE2601-0165';
