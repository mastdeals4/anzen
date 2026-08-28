-- Finance hardening and backfill migration
-- Goals:
-- 1) Remove orphan journal lines
-- 2) Remove duplicate journal headers by (source_module, reference_id)
-- 3) Surface unbalanced journals for manual repair (no auto-fix)
-- 4) Recreate missing petty cash journals
-- 5) Backfill petty cash transactions from fund transfers, then post journals

-- 1) Remove orphan journal lines
DELETE FROM journal_entry_lines jel
WHERE NOT EXISTS (
  SELECT 1
  FROM journal_entries je
  WHERE je.id = jel.journal_entry_id
);

-- 2) Fix duplicate postings (keep latest by created_at/id for same source+reference)
WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY source_module, reference_id
      ORDER BY created_at DESC NULLS LAST, id DESC
    ) AS rn
  FROM journal_entries
  WHERE reference_id IS NOT NULL
)
DELETE FROM journal_entries je
USING ranked r
WHERE je.id = r.id
  AND r.rn > 1;

-- 3) Identify unbalanced journals (DO NOT auto-fix)
-- This view is intentionally left for operations to inspect and re-post from source.
CREATE OR REPLACE VIEW vw_unbalanced_journals AS
SELECT
  je.id AS journal_entry_id,
  je.source_module,
  je.reference_id,
  je.reference_number,
  COALESCE(SUM(jel.debit), 0) AS debit_sum,
  COALESCE(SUM(jel.credit), 0) AS credit_sum,
  (COALESCE(SUM(jel.debit), 0) - COALESCE(SUM(jel.credit), 0)) AS imbalance
FROM journal_entries je
LEFT JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
GROUP BY je.id, je.source_module, je.reference_id, je.reference_number
HAVING COALESCE(SUM(jel.debit), 0) <> COALESCE(SUM(jel.credit), 0);

COMMENT ON VIEW vw_unbalanced_journals IS
  'Operational queue of journals where debit != credit. Repair by tracing source_module/reference_id and re-posting from source; no auto-fix performed.';

-- 4) Recreate missing petty cash journals by forcing trigger re-post
DO $$
DECLARE
  v_row RECORD;
BEGIN
  FOR v_row IN
    SELECT pct.id
    FROM petty_cash_transactions pct
    LEFT JOIN journal_entries je
      ON je.source_module = 'petty_cash'
     AND je.reference_id = pct.id
    WHERE je.id IS NULL
  LOOP
    -- Trigger function post_petty_cash_to_journal() is attached to petty_cash_transactions updates.
    UPDATE petty_cash_transactions
    SET updated_at = NOW()
    WHERE id = v_row.id;
  END LOOP;
END $$;

-- 5) Backfill missing petty cash transactions from fund transfers involving petty cash,
-- then post missing journals via post_fund_transfer_journal().
DO $$
DECLARE
  v_transfer RECORD;
BEGIN
  -- create synthetic petty cash transactions only when one does not already exist
  FOR v_transfer IN
    SELECT ft.*
    FROM fund_transfers ft
    WHERE (ft.from_account_type = 'petty_cash' OR ft.to_account_type = 'petty_cash')
      AND NOT EXISTS (
        SELECT 1
        FROM petty_cash_transactions pct
        WHERE pct.transaction_number = ft.transfer_number
      )
  LOOP
    INSERT INTO petty_cash_transactions (
      transaction_number,
      transaction_date,
      transaction_type,
      amount,
      description,
      created_by,
      created_at,
      updated_at
    ) VALUES (
      v_transfer.transfer_number,
      v_transfer.transfer_date,
      CASE WHEN v_transfer.to_account_type = 'petty_cash' THEN 'withdraw' ELSE 'expense' END,
      v_transfer.amount,
      'Fund transfer linkage: ' || COALESCE(v_transfer.description, v_transfer.transfer_number),
      v_transfer.created_by,
      NOW(),
      NOW()
    );
  END LOOP;

  -- post journals for transfers still missing journal linkage
  FOR v_transfer IN
    SELECT ft.*
    FROM fund_transfers ft
    WHERE ft.journal_entry_id IS NULL
  LOOP
    PERFORM post_fund_transfer_journal(v_transfer.id, v_transfer.created_by);
  END LOOP;
END $$;

-- Enforce ongoing posting integrity
CREATE UNIQUE INDEX IF NOT EXISTS uq_journal_entries_source_reference
  ON journal_entries (source_module, reference_id)
  WHERE reference_id IS NOT NULL;
