-- Migration: 20261008020000_fix_bank_statement_import_integrity_and_balance.sql
-- Description: Fix bank statement import integrity, drop duplicate-dropping unique constraint on transaction_hash,
--              preserve all legitimate statement lines, and compute bank statement balance from all imported lines.

BEGIN;

-- ============================================================================
-- 1. DROP THE OVERLY-STRICT UNIQUE CONSTRAINT ON TRANSACTION_HASH
-- ============================================================================
-- Real bank statements can legitimately have multiple identical transactions
-- on the same date (e.g. multiple Rp 2,500 bank fees, salary payments of same
-- amount to different people, or repeated transfers). The unique constraint
-- idx_bank_statement_lines_hash_unique was causing Postgres to silently drop
-- legitimate transactions when upsert with ignoreDuplicates was used, or error
-- when force-importing duplicate overrides.
DROP INDEX IF EXISTS public.idx_bank_statement_lines_hash_unique;

-- Maintain a performance index on transaction_hash for fast lookups
CREATE INDEX IF NOT EXISTS idx_bank_statement_lines_hash 
  ON public.bank_statement_lines (transaction_hash);

-- ============================================================================
-- 2. ENHANCE GENERATE_BANK_TRANSACTION_HASH TO INCLUDE REFERENCE AND FULL DESC
-- ============================================================================
CREATE OR REPLACE FUNCTION public.generate_bank_transaction_hash(
  p_bank_account_id UUID,
  p_transaction_date DATE,
  p_debit_amount NUMERIC,
  p_credit_amount NUMERIC,
  p_description TEXT,
  p_running_balance NUMERIC DEFAULT 0,
  p_upload_id UUID DEFAULT NULL::UUID,
  p_reference TEXT DEFAULT NULL::TEXT
) RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_normalized_desc TEXT;
  v_hash_input TEXT;
BEGIN
  -- Normalize description: lowercase, collapse extra spaces, trim (no arbitrary 100-char truncation)
  v_normalized_desc := LOWER(TRIM(REGEXP_REPLACE(COALESCE(p_description, ''), '\s+', ' ', 'g')));

  v_hash_input := p_bank_account_id::TEXT || '|' ||
                  p_transaction_date::TEXT || '|' ||
                  COALESCE(p_debit_amount, 0)::TEXT || '|' ||
                  COALESCE(p_credit_amount, 0)::TEXT || '|' ||
                  v_normalized_desc || '|' ||
                  COALESCE(p_running_balance, 0)::TEXT;

  -- Distinguish entries with reference if available
  IF p_reference IS NOT NULL AND TRIM(p_reference) <> '' THEN
    v_hash_input := v_hash_input || '|' || LOWER(TRIM(p_reference));
  END IF;

  -- If balance is 0 and upload_id is given, include it
  IF COALESCE(p_running_balance, 0) = 0 AND p_upload_id IS NOT NULL THEN
    v_hash_input := v_hash_input || '|' || p_upload_id::TEXT;
  END IF;

  RETURN md5(v_hash_input);
END;
$$;

-- Overload: 5 parameters (legacy compatibility)
CREATE OR REPLACE FUNCTION public.generate_bank_transaction_hash(
  p_bank_account_id UUID,
  p_transaction_date DATE,
  p_debit_amount NUMERIC,
  p_credit_amount NUMERIC,
  p_description TEXT
) RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  RETURN public.generate_bank_transaction_hash(
    p_bank_account_id, p_transaction_date, p_debit_amount, p_credit_amount, p_description, 0, NULL::UUID, NULL::TEXT
  );
END;
$$;

-- Overload: 7 parameters (baseline compatibility)
CREATE OR REPLACE FUNCTION public.generate_bank_transaction_hash(
  p_bank_account_id UUID,
  p_transaction_date DATE,
  p_debit_amount NUMERIC,
  p_credit_amount NUMERIC,
  p_description TEXT,
  p_running_balance NUMERIC,
  p_upload_id UUID
) RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  RETURN public.generate_bank_transaction_hash(
    p_bank_account_id, p_transaction_date, p_debit_amount, p_credit_amount, p_description, p_running_balance, p_upload_id, NULL::TEXT
  );
END;
$$;

-- ============================================================================
-- 3. TRIGGER: PRESERVE APPLICATION-PROVIDED TRANSACTION_HASH IF PRESENT
-- ============================================================================
CREATE OR REPLACE FUNCTION public.auto_generate_transaction_hash()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  -- If application already computed an explicit hash (or force-import token), preserve it
  IF NEW.transaction_hash IS NULL OR TRIM(NEW.transaction_hash) = '' THEN
    NEW.transaction_hash := public.generate_bank_transaction_hash(
      NEW.bank_account_id,
      NEW.transaction_date,
      NEW.debit_amount,
      NEW.credit_amount,
      NEW.description,
      NEW.running_balance,
      NEW.upload_id,
      NEW.reference
    );
  END IF;
  RETURN NEW;
END;
$$;

-- ============================================================================
-- 4. CANONICAL STATEMENT BALANCE IN GET_BANK_ACCOUNT_BALANCES
-- ============================================================================
-- Calculate Bank Statement Balance from ALL imported bank statement transactions
-- (opening_balance + total_credits - total_debits), not just recorded/reconciled entries.
CREATE OR REPLACE FUNCTION public.get_bank_account_balances(
  p_as_of_date date DEFAULT CURRENT_DATE
)
RETURNS TABLE (
  bank_account_id uuid,
  account_name text,
  bank_name text,
  account_number text,
  currency text,
  coa_id uuid,
  coa_code text,
  opening_balance numeric,
  opening_balance_date date,
  total_debits numeric,
  total_credits numeric,
  book_balance numeric,
  statement_balance numeric,
  as_of_date date
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  RETURN QUERY
  WITH stmt_aggregates AS (
    SELECT 
      bsl.bank_account_id,
      COALESCE(SUM(bsl.debit_amount), 0) AS stmt_debits,
      COALESCE(SUM(bsl.credit_amount), 0) AS stmt_credits
    FROM public.bank_statement_lines bsl
    WHERE bsl.transaction_date <= p_as_of_date
    GROUP BY bsl.bank_account_id
  ),
  latest_stmt AS (
    SELECT DISTINCT ON (bsl.bank_account_id)
      bsl.bank_account_id,
      bsl.running_balance,
      bsl.statement_balance
    FROM public.bank_statement_lines bsl
    WHERE bsl.transaction_date <= p_as_of_date
    ORDER BY bsl.bank_account_id, bsl.transaction_date DESC, bsl.id DESC
  )
  SELECT 
    ba.id AS bank_account_id,
    ba.account_name::text,
    ba.bank_name::text,
    ba.account_number::text,
    ba.currency::text,
    ba.coa_id,
    coa.code::text AS coa_code,
    COALESCE(ba.opening_balance, 0) AS opening_balance,
    ba.opening_balance_date,
    COALESCE(
      CASE WHEN ba.currency = 'USD' 
        THEN (SELECT SUM(COALESCE(NULLIF(jel.transaction_debit, 0), jel.debit, 0))
              FROM public.journal_entry_lines jel JOIN public.journal_entries je ON je.id = jel.journal_entry_id
              WHERE jel.account_id = ba.coa_id AND je.is_posted = true AND je.entry_date <= p_as_of_date)
        ELSE (SELECT SUM(jel.debit)
              FROM public.journal_entry_lines jel JOIN public.journal_entries je ON je.id = jel.journal_entry_id
              WHERE jel.account_id = ba.coa_id AND je.is_posted = true AND je.entry_date <= p_as_of_date)
      END, 0) AS total_debits,
    COALESCE(
      CASE WHEN ba.currency = 'USD' 
        THEN (SELECT SUM(COALESCE(NULLIF(jel.transaction_credit, 0), jel.credit, 0))
              FROM public.journal_entry_lines jel JOIN public.journal_entries je ON je.id = jel.journal_entry_id
              WHERE jel.account_id = ba.coa_id AND je.is_posted = true AND je.entry_date <= p_as_of_date)
        ELSE (SELECT SUM(jel.credit)
              FROM public.journal_entry_lines jel JOIN public.journal_entries je ON je.id = jel.journal_entry_id
              WHERE jel.account_id = ba.coa_id AND je.is_posted = true AND je.entry_date <= p_as_of_date)
      END, 0) AS total_credits,
    public.calculate_bank_account_book_balance(ba.id, p_as_of_date) AS book_balance,
    -- If latest statement row has an explicit positive balance, use it;
    -- otherwise dynamically compute: opening_balance + all statement credits - all statement debits
    COALESCE(
      NULLIF(COALESCE(ls.statement_balance, ls.running_balance, 0), 0),
      round(COALESCE(ba.opening_balance, 0) + COALESCE(sa.stmt_credits, 0) - COALESCE(sa.stmt_debits, 0), 2)
    ) AS statement_balance,
    p_as_of_date AS as_of_date
  FROM public.bank_accounts ba
  LEFT JOIN public.chart_of_accounts coa ON coa.id = ba.coa_id
  LEFT JOIN latest_stmt ls ON ls.bank_account_id = ba.id
  LEFT JOIN stmt_aggregates sa ON sa.bank_account_id = ba.id
  WHERE ba.is_active = true;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_bank_account_balances(date) TO authenticated, service_role;

COMMIT;
