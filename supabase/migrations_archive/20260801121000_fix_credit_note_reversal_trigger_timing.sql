-- ERP V1 compatibility fix.
--
-- An approved Credit Note owns journal_entries through
-- credit_notes.journal_entry_id (ON DELETE SET NULL). Running the journal
-- deletion from a BEFORE UPDATE trigger causes PostgreSQL to update the same
-- credit_notes tuple through the FK action while that tuple is already being
-- updated. The result is SQLSTATE 27000 and the Credit Note cannot be reversed.
--
-- The existing trigger function and accounting rules are unchanged. Moving
-- only the trigger timing to AFTER lets the status update complete first; the
-- journal deletion then clears journal_entry_id through the existing FK.

BEGIN;

DROP TRIGGER IF EXISTS trg_reverse_credit_note ON public.credit_notes;

CREATE TRIGGER trg_reverse_credit_note
AFTER UPDATE OR DELETE ON public.credit_notes
FOR EACH ROW
EXECUTE FUNCTION public.reverse_credit_note_journal();

COMMIT;
