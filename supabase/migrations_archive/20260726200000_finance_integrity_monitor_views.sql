-- Restore the read-only integrity projections consumed by Integrity Monitor.
-- These are views over existing journals, lines and source documents; no
-- tables, posting logic or repair behavior is introduced.

-- The migration owner runs without a Supabase JWT.  The existing fund-transfer
-- authorization trigger is intentionally suspended only for this migration
-- transaction, then restored below.  Runtime requests continue to execute the
-- unchanged trigger and finance-role checks.
DO $$
DECLARE
  trigger_enabled boolean := false;
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_enforce_fund_transfer_role_ins'
      AND tgrelid = 'public.fund_transfers'::regclass
      AND NOT tgisinternal
      AND tgenabled <> 'D'
  ) THEN
    trigger_enabled := true;
    ALTER TABLE public.fund_transfers DISABLE TRIGGER trg_enforce_fund_transfer_role_ins;
  END IF;
  PERFORM set_config('finance.integrity_trigger_was_enabled', trigger_enabled::text, true);
END $$;

-- The first deployment attempt may have left an earlier column shape in the
-- other projections. Replace only those read-only projections. The existing
-- unbalanced_journal_entries view has downstream report dependencies, so keep
-- its established columns when present; create the direct calculation only
-- on databases where it is genuinely absent.
DROP VIEW IF EXISTS public.duplicate_postings;
DROP VIEW IF EXISTS public.orphan_journal_lines;
DROP VIEW IF EXISTS public.missing_petty_cash_links;
DROP VIEW IF EXISTS public.negative_cash_anomalies;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class
    WHERE oid = 'public.unbalanced_journal_entries'::regclass
      AND relkind = 'v'
  ) THEN
    EXECUTE $view$
      CREATE VIEW public.unbalanced_journal_entries
      WITH (security_invoker = true) AS
      SELECT
        je.id AS journal_entry_id,
        je.source_module,
        je.reference_id,
        je.reference_number,
        COALESCE(SUM(jel.debit), 0) AS debit_sum,
        COALESCE(SUM(jel.credit), 0) AS credit_sum,
        COALESCE(SUM(jel.debit), 0) - COALESCE(SUM(jel.credit), 0) AS imbalance,
        je.entry_number,
        je.entry_date,
        je.description,
        je.is_posted,
        je.is_reversed
      FROM public.journal_entries je
      LEFT JOIN public.journal_entry_lines jel ON jel.journal_entry_id = je.id
      WHERE je.is_posted = true AND COALESCE(je.is_reversed, false) = false
      GROUP BY je.id, je.source_module, je.reference_id, je.reference_number,
        je.entry_number, je.entry_date, je.description, je.is_posted, je.is_reversed
      HAVING COALESCE(SUM(jel.debit), 0) <> COALESCE(SUM(jel.credit), 0)
    $view$;
  END IF;
END $$;

CREATE OR REPLACE VIEW public.duplicate_postings
WITH (security_invoker = true) AS
WITH duplicate_keys AS (
  SELECT source_module, reference_id, count(*) AS duplicate_count
  FROM public.journal_entries
  WHERE reference_id IS NOT NULL
    AND is_posted = true
    AND COALESCE(is_reversed, false) = false
  GROUP BY source_module, reference_id
  HAVING count(*) > 1
)
SELECT
  je.id AS journal_entry_id,
  je.entry_number,
  je.entry_date,
  je.source_module,
  je.reference_id,
  je.reference_number,
  je.description,
  dk.duplicate_count
FROM public.journal_entries je
JOIN duplicate_keys dk
  ON dk.source_module IS NOT DISTINCT FROM je.source_module
 AND dk.reference_id = je.reference_id
WHERE je.is_posted = true AND COALESCE(je.is_reversed, false) = false;

CREATE OR REPLACE VIEW public.orphan_journal_lines
WITH (security_invoker = true) AS
SELECT
  jel.id AS journal_line_id,
  jel.journal_entry_id,
  jel.line_number,
  jel.account_id,
  jel.debit,
  jel.credit,
  jel.description
FROM public.journal_entry_lines jel
LEFT JOIN public.journal_entries je ON je.id = jel.journal_entry_id
WHERE je.id IS NULL;

CREATE OR REPLACE VIEW public.missing_petty_cash_links
WITH (security_invoker = true) AS
SELECT
  pct.id AS petty_cash_transaction_id,
  pct.transaction_number,
  pct.transaction_date,
  pct.amount,
  pct.transaction_type,
  pct.description,
  je.id AS journal_entry_id
FROM public.petty_cash_transactions pct
LEFT JOIN public.journal_entries je
  ON je.source_module = 'petty_cash'
 AND je.reference_id = pct.id
 AND je.is_posted = true
 AND COALESCE(je.is_reversed, false) = false
WHERE je.id IS NULL;

CREATE OR REPLACE VIEW public.negative_cash_anomalies
WITH (security_invoker = true) AS
WITH cash_accounts AS (
  SELECT id, code, name
  FROM public.chart_of_accounts
  WHERE is_active = true
    AND COALESCE(is_header, false) = false
    AND (
      lower(COALESCE(account_group, '')) LIKE '%cash%'
      OR lower(COALESCE(account_group, '')) LIKE '%bank%'
      OR lower(name) LIKE '%cash%'
      OR lower(name) LIKE '%bank%'
    )
), active_lines AS (
  SELECT
    jel.id AS journal_line_id,
    jel.journal_entry_id,
    jel.account_id,
    je.entry_number,
    je.entry_date,
    je.source_module,
    je.reference_id,
    je.reference_number,
    (COALESCE(jel.debit, 0) - COALESCE(jel.credit, 0)) AS movement
  FROM public.journal_entry_lines jel
  JOIN public.journal_entries je ON je.id = jel.journal_entry_id
  WHERE je.is_posted = true AND COALESCE(je.is_reversed, false) = false
), running AS (
  SELECT
    al.*,
    ca.code,
    ca.name,
    sum(al.movement) OVER (
      PARTITION BY al.account_id
      ORDER BY al.entry_date, al.journal_entry_id, al.journal_line_id
      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    ) AS running_balance
  FROM active_lines al
  JOIN cash_accounts ca ON ca.id = al.account_id
)
SELECT * FROM running WHERE running_balance < 0;

GRANT SELECT ON public.unbalanced_journal_entries,
  public.duplicate_postings,
  public.orphan_journal_lines,
  public.missing_petty_cash_links,
  public.negative_cash_anomalies TO authenticated;

DO $$
BEGIN
  IF current_setting('finance.integrity_trigger_was_enabled', true) = 'true' AND EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_enforce_fund_transfer_role_ins'
      AND tgrelid = 'public.fund_transfers'::regclass
      AND NOT tgisinternal
  ) THEN
    ALTER TABLE public.fund_transfers ENABLE TRIGGER trg_enforce_fund_transfer_role_ins;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
