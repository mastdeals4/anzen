-- Controlled historical-only repair for the 25 legacy 2025 cash expenses
-- already represented by PCMIG petty-cash rows.
--
-- The earlier migration created a second posted Petty Cash journal for each
-- row while leaving the original canonical Expense journal on Cash on Hand.
-- This transaction keeps the original Expense and its canonical journal,
-- changes only its payment-side account from 1101 to 1102, retains the
-- existing Petty Cash row as the historical operational representation, and
-- removes the duplicate petty-cash journal. No bank links are permitted.

BEGIN;

SELECT set_config('app.finance_historical_repair', 'on', true);

-- A durable, deterministic link for these historical rows. The contemporary
-- Petty Cash model intentionally has no expense FK; this source marker plus
-- the copied voucher is the historical link and is protected against reuse.
CREATE UNIQUE INDEX IF NOT EXISTS idx_petty_cash_historical_expense_source
  ON public.petty_cash_transactions(source)
  WHERE source LIKE 'historical_expense:%';

-- Do not allow a future re-approval of one of these historical marker rows to
-- recreate the duplicate petty-cash journal being removed below. This has no
-- effect on ordinary/current Petty Cash rows.
DROP TRIGGER IF EXISTS trigger_post_petty_cash_on_approval
  ON public.petty_cash_transactions;

CREATE TRIGGER trigger_post_petty_cash_on_approval
  AFTER UPDATE ON public.petty_cash_transactions
  FOR EACH ROW
  WHEN (
    OLD.approval_status IS DISTINCT FROM 'approved'
    AND NEW.approval_status = 'approved'
    AND COALESCE(NEW.source, '') NOT LIKE 'historical_expense:%'
  )
  EXECUTE FUNCTION public.post_petty_cash_to_journal_fixed();

CREATE TEMP TABLE _legacy_2025_cash_petty_pairs ON COMMIT DROP AS
SELECT
  fe.id AS expense_id,
  fe.voucher_number,
  fe.expense_date,
  fe.amount,
  fe.description AS expense_description,
  fe.expense_category,
  je.id AS expense_journal_id,
  cash_line.id AS cash_line_id,
  pc.id AS petty_cash_id,
  pc.transaction_number,
  pje.id AS duplicate_petty_cash_journal_id
FROM public.finance_expenses fe
JOIN public.journal_entries je
  ON je.reference_id = fe.id
 AND je.source_module = 'expenses'
 AND je.reference_number = 'EXP-' || fe.id::text
 AND je.is_posted = true
 AND NOT COALESCE(je.is_reversed, false)
JOIN LATERAL (
  SELECT jel.id
  FROM public.journal_entry_lines jel
  JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
  WHERE jel.journal_entry_id = je.id
    AND coa.code = '1101'
    AND jel.debit = 0
    AND jel.credit = fe.amount
) cash_line ON true
JOIN public.petty_cash_transactions pc
  ON pc.transaction_type = 'expense'
 AND pc.transaction_date = fe.expense_date
 AND pc.amount = fe.amount
 AND pc.expense_category = fe.expense_category
 AND regexp_replace(lower(trim(pc.description)), '^\[[^]]+\]\s*', '')
       = lower(trim(fe.description))
JOIN public.journal_entries pje
  ON pje.source_module = 'petty_cash'
 AND pje.reference_id = pc.id
 AND pje.is_posted = true
 AND NOT COALESCE(pje.is_reversed, false)
WHERE fe.expense_date >= DATE '2025-01-01'
  AND fe.expense_date < DATE '2026-01-01'
  AND fe.payment_method = 'cash'
  AND fe.bank_account_id IS NULL
  AND fe.approval_status = 'approved'
  AND pc.approval_status = 'approved'
  AND pc.source IS NULL
  AND pc.voucher_number IS NULL
  -- One canonical expense journal and one duplicate petty-cash journal only.
  AND 1 = (SELECT count(*) FROM public.journal_entries x
           WHERE x.reference_id = fe.id AND x.source_module = 'expenses'
             AND x.reference_number = 'EXP-' || fe.id::text
             AND x.is_posted AND NOT COALESCE(x.is_reversed, false))
  AND 1 = (SELECT count(*) FROM public.journal_entries x
           WHERE x.reference_id = pc.id AND x.source_module = 'petty_cash'
             AND x.is_posted AND NOT COALESCE(x.is_reversed, false))
  -- Preserve only an unambiguous payment-side replacement.
  AND 1 = (SELECT count(*) FROM public.journal_entry_lines jel
           JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
           WHERE jel.journal_entry_id = je.id AND coa.code = '1101'
             AND jel.debit = 0 AND jel.credit = fe.amount)
  AND NOT EXISTS (SELECT 1 FROM public.journal_entry_lines jel
                  JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
                  WHERE jel.journal_entry_id = je.id AND coa.code = '1102')
  AND 2 = (SELECT count(*) FROM public.journal_entry_lines
           WHERE journal_entry_id = pje.id)
  AND 1 = (SELECT count(*) FROM public.journal_entry_lines jel
           JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
           WHERE jel.journal_entry_id = pje.id AND coa.code = '1102'
             AND jel.debit = 0 AND jel.credit = pc.amount)
  AND COALESCE((SELECT sum(debit) FROM public.journal_entry_lines
                WHERE journal_entry_id = je.id), 0)
      = COALESCE((SELECT sum(credit) FROM public.journal_entry_lines
                  WHERE journal_entry_id = je.id), 0)
  AND COALESCE((SELECT sum(debit) FROM public.journal_entry_lines
                WHERE journal_entry_id = pje.id), 0)
      = COALESCE((SELECT sum(credit) FROM public.journal_entry_lines
                  WHERE journal_entry_id = pje.id), 0)
  -- This migration must never change a reconciled/allocated record.
  AND NOT EXISTS (SELECT 1 FROM public.bank_statement_allocations a
                  WHERE (a.document_type = 'expense' AND a.document_id = fe.id)
                     OR (a.document_type = 'petty_cash' AND a.document_id = pc.id)
                     OR a.journal_entry_id IN (je.id, pje.id))
  AND NOT EXISTS (SELECT 1 FROM public.bank_statement_lines b
                  WHERE b.matched_expense_id = fe.id
                     OR b.matched_petty_cash_id = pc.id
                     OR b.matched_entry_id IN (je.id, pje.id));

DO $$
DECLARE
  v_run_id uuid;
  v_pair_count integer;
  v_pair_total numeric;
  v_strict_cash_count integer;
  v_updated integer;
  v_deleted integer;
BEGIN
  -- Lock every source row before making the all-or-nothing decision.
  PERFORM 1 FROM public.finance_expenses fe
    JOIN _legacy_2025_cash_petty_pairs p ON p.expense_id = fe.id
    FOR UPDATE;
  PERFORM 1 FROM public.petty_cash_transactions pc
    JOIN _legacy_2025_cash_petty_pairs p ON p.petty_cash_id = pc.id
    FOR UPDATE;
  PERFORM 1 FROM public.journal_entries je
    JOIN _legacy_2025_cash_petty_pairs p
      ON je.id IN (p.expense_journal_id, p.duplicate_petty_cash_journal_id)
    FOR UPDATE;

  SELECT count(*), COALESCE(sum(amount), 0)
    INTO v_pair_count, v_pair_total
  FROM _legacy_2025_cash_petty_pairs;

  -- This is deliberately exact: a changed live universe must be reviewed,
  -- not partly repaired by an old migration.
  IF v_pair_count <> 25 OR v_pair_total <> 71662000 THEN
    RAISE EXCEPTION
      'Historical petty-cash repair aborted: expected 25 pairs totaling 71662000, found % totaling %',
      v_pair_count, v_pair_total;
  END IF;

  -- Every otherwise-safe legacy Cash-on-Hand expense must be one of the
  -- proven pairs above. This rejects unrepresented or ambiguous records.
  SELECT count(*) INTO v_strict_cash_count
  FROM public.finance_expenses fe
  JOIN public.journal_entries je
    ON je.reference_id = fe.id AND je.source_module = 'expenses'
   AND je.reference_number = 'EXP-' || fe.id::text
   AND je.is_posted AND NOT COALESCE(je.is_reversed, false)
  WHERE fe.expense_date >= DATE '2025-01-01'
    AND fe.expense_date < DATE '2026-01-01'
    AND fe.payment_method = 'cash'
    AND fe.bank_account_id IS NULL
    AND fe.approval_status = 'approved'
    AND 1 = (SELECT count(*) FROM public.journal_entries x
             WHERE x.reference_id = fe.id AND x.source_module = 'expenses'
               AND x.reference_number = 'EXP-' || fe.id::text
               AND x.is_posted AND NOT COALESCE(x.is_reversed, false))
    AND 1 = (SELECT count(*) FROM public.journal_entry_lines jel
             JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
             WHERE jel.journal_entry_id = je.id AND coa.code = '1101'
               AND jel.debit = 0 AND jel.credit = fe.amount)
    AND NOT EXISTS (SELECT 1 FROM public.journal_entry_lines jel
                    JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
                    WHERE jel.journal_entry_id = je.id AND coa.code = '1102')
    AND COALESCE((SELECT sum(debit) FROM public.journal_entry_lines
                  WHERE journal_entry_id = je.id), 0)
        = COALESCE((SELECT sum(credit) FROM public.journal_entry_lines
                    WHERE journal_entry_id = je.id), 0)
    AND NOT EXISTS (SELECT 1 FROM public.bank_statement_allocations a
                    WHERE (a.document_type = 'expense' AND a.document_id = fe.id)
                       OR a.journal_entry_id = je.id)
    AND NOT EXISTS (SELECT 1 FROM public.bank_statement_lines b
                    WHERE b.matched_expense_id = fe.id OR b.matched_entry_id = je.id);

  IF v_strict_cash_count <> v_pair_count THEN
    RAISE EXCEPTION
      'Historical petty-cash repair aborted: % safe Cash-on-Hand expenses but only % proven Petty Cash pairs',
      v_strict_cash_count, v_pair_count;
  END IF;

  INSERT INTO public.finance_historical_repair_runs(notes)
  VALUES ('2025 legacy Cash-on-Hand to Petty Cash representation repair; preserves canonical expense journal, removes duplicate petty-cash journal')
  RETURNING id INTO v_run_id;

  INSERT INTO public.finance_historical_repair_items(
    run_id, document_type, document_id, document_number, repaired_fields,
    old_metadata, new_metadata, repair_reason
  )
  SELECT
    v_run_id,
    'expense', p.expense_id, p.voucher_number,
    ARRAY['journal_entry_lines.account_id', 'petty_cash_transactions.source',
          'petty_cash_transactions.voucher_number', 'duplicate_petty_cash_journal'],
    jsonb_build_object(
      'expense_journal_id', p.expense_journal_id,
      'payment_account_code', '1101',
      'petty_cash_transaction_id', p.petty_cash_id,
      'petty_cash_transaction_number', p.transaction_number,
      'duplicate_petty_cash_journal_id', p.duplicate_petty_cash_journal_id
    ),
    jsonb_build_object(
      'expense_journal_id', p.expense_journal_id,
      'payment_account_code', '1102',
      'petty_cash_transaction_id', p.petty_cash_id,
      'petty_cash_transaction_number', p.transaction_number,
      'petty_cash_source', 'historical_expense:' || p.expense_id::text,
      'duplicate_petty_cash_journal_removed', p.duplicate_petty_cash_journal_id
    ),
    'Exact date, amount, category and normalized description prove existing PCMIG representation; both journals are balanced, unreconciled and unallocated'
  FROM _legacy_2025_cash_petty_pairs p;

  UPDATE public.petty_cash_transactions pc
     SET source = 'historical_expense:' || p.expense_id::text,
         voucher_number = p.voucher_number
    FROM _legacy_2025_cash_petty_pairs p
   WHERE pc.id = p.petty_cash_id
     AND pc.source IS NULL
     AND pc.voucher_number IS NULL;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated <> v_pair_count THEN
    RAISE EXCEPTION 'Historical petty-cash repair aborted: linked % Petty Cash rows, expected %',
      v_updated, v_pair_count;
  END IF;

  UPDATE public.journal_entry_lines jel
     SET account_id = (SELECT id FROM public.chart_of_accounts
                       WHERE code = '1102' AND is_active = true AND is_header = false)
    FROM _legacy_2025_cash_petty_pairs p
   WHERE jel.id = p.cash_line_id
     AND jel.account_id = (SELECT id FROM public.chart_of_accounts
                           WHERE code = '1101' AND is_active = true AND is_header = false);
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated <> v_pair_count THEN
    RAISE EXCEPTION 'Historical petty-cash repair aborted: updated % canonical payment lines, expected %',
      v_updated, v_pair_count;
  END IF;

  DELETE FROM public.journal_entry_lines jel
   USING _legacy_2025_cash_petty_pairs p
   WHERE jel.journal_entry_id = p.duplicate_petty_cash_journal_id;

  DELETE FROM public.journal_entries je
   USING _legacy_2025_cash_petty_pairs p
   WHERE je.id = p.duplicate_petty_cash_journal_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  IF v_deleted <> v_pair_count THEN
    RAISE EXCEPTION 'Historical petty-cash repair aborted: removed % duplicate Petty Cash journals, expected %',
      v_deleted, v_pair_count;
  END IF;

  -- Post-repair integrity checks: one linked PC row, one balanced canonical
  -- expense journal on 1102, no duplicate PC journal and no bank linkage.
  IF EXISTS (
    SELECT 1
    FROM _legacy_2025_cash_petty_pairs p
    WHERE NOT EXISTS (
            SELECT 1 FROM public.petty_cash_transactions pc
            WHERE pc.id = p.petty_cash_id
              AND pc.source = 'historical_expense:' || p.expense_id::text
              AND pc.voucher_number = p.voucher_number
          )
       OR EXISTS (SELECT 1 FROM public.journal_entries x
                  WHERE x.source_module = 'petty_cash' AND x.reference_id = p.petty_cash_id)
       OR 1 <> (SELECT count(*) FROM public.journal_entry_lines jel
                JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
                WHERE jel.journal_entry_id = p.expense_journal_id
                  AND coa.code = '1102' AND jel.debit = 0 AND jel.credit = p.amount)
       OR COALESCE((SELECT sum(debit) FROM public.journal_entry_lines
                    WHERE journal_entry_id = p.expense_journal_id), 0)
          <> COALESCE((SELECT sum(credit) FROM public.journal_entry_lines
                       WHERE journal_entry_id = p.expense_journal_id), 0)
       OR EXISTS (SELECT 1 FROM public.bank_statement_allocations a
                  WHERE (a.document_type = 'expense' AND a.document_id = p.expense_id)
                     OR (a.document_type = 'petty_cash' AND a.document_id = p.petty_cash_id)
                     OR a.journal_entry_id = p.expense_journal_id)
       OR EXISTS (SELECT 1 FROM public.bank_statement_lines b
                  WHERE b.matched_expense_id = p.expense_id
                     OR b.matched_petty_cash_id = p.petty_cash_id
                     OR b.matched_entry_id = p.expense_journal_id)
  ) THEN
    RAISE EXCEPTION 'Historical petty-cash repair post-validation failed; transaction rolled back';
  END IF;

  UPDATE public.finance_historical_repair_runs
     SET completed_at = now(),
         total_records_scanned = v_pair_count,
         records_repaired = v_pair_count,
         records_partially_repaired = 0,
         records_manual_review = 0,
         records_skipped = 0
   WHERE id = v_run_id;
END $$;

COMMIT;
