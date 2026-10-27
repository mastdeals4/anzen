-- Correct bank book-balance calculations without modifying accounting records.
-- Exclude reversed journals and honor the configured opening-balance date.
-- USD bank balances use only native USD amounts with valid USD/IDR metadata.

CREATE OR REPLACE FUNCTION public.calculate_bank_account_book_balance(
  p_bank_account_id uuid,
  p_as_of_date date DEFAULT CURRENT_DATE
)
RETURNS numeric
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_opening numeric := 0;
  v_coa_id uuid;
  v_currency text;
  v_opening_date date;
  v_debits numeric := 0;
  v_credits numeric := 0;
BEGIN
  SELECT COALESCE(opening_balance, 0),
         coa_id,
         upper(COALESCE(currency, 'IDR')),
         COALESCE(opening_balance_date, DATE '1900-01-01')
    INTO v_opening, v_coa_id, v_currency, v_opening_date
    FROM public.bank_accounts
   WHERE id = p_bank_account_id;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF p_as_of_date < v_opening_date THEN
    RETURN 0;
  END IF;

  IF v_coa_id IS NULL THEN
    RETURN v_opening;
  END IF;

  IF v_currency = 'USD' THEN
    SELECT COALESCE(SUM(jel.transaction_debit), 0),
           COALESCE(SUM(jel.transaction_credit), 0)
      INTO v_debits, v_credits
      FROM public.journal_entry_lines jel
      JOIN public.journal_entries je ON je.id = jel.journal_entry_id
     WHERE jel.account_id = v_coa_id
       AND je.is_posted = true
       AND NOT COALESCE(je.is_reversed, false)
       AND je.entry_date >= v_opening_date
       AND je.entry_date <= p_as_of_date
       AND jel.transaction_currency = 'USD'
       AND jel.functional_currency = 'IDR'
       AND COALESCE(jel.exchange_rate, 0) > 0;
  ELSE
    SELECT COALESCE(SUM(jel.debit), 0),
           COALESCE(SUM(jel.credit), 0)
      INTO v_debits, v_credits
      FROM public.journal_entry_lines jel
      JOIN public.journal_entries je ON je.id = jel.journal_entry_id
     WHERE jel.account_id = v_coa_id
       AND je.is_posted = true
       AND NOT COALESCE(je.is_reversed, false)
       AND je.entry_date >= v_opening_date
       AND je.entry_date <= p_as_of_date;
  END IF;

  RETURN ROUND(v_opening + v_debits - v_credits, 2);
END;
$function$;

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
AS $function$
BEGIN
  RETURN QUERY
  WITH stmt_aggregates AS (
    SELECT bsl.bank_account_id,
           COALESCE(SUM(bsl.debit_amount), 0) AS stmt_debits,
           COALESCE(SUM(bsl.credit_amount), 0) AS stmt_credits
      FROM public.bank_statement_lines bsl
      JOIN public.bank_accounts ba ON ba.id = bsl.bank_account_id
     WHERE bsl.transaction_date <= p_as_of_date
       AND bsl.transaction_date >= COALESCE(ba.opening_balance_date, DATE '1900-01-01')
     GROUP BY bsl.bank_account_id
  ),
  latest_stmt AS (
    SELECT DISTINCT ON (bsl.bank_account_id)
           bsl.bank_account_id,
           COALESCE(NULLIF(bsl.statement_balance, 0), NULLIF(bsl.running_balance, 0)) AS last_stmt_bal
      FROM public.bank_statement_lines bsl
      JOIN public.bank_accounts ba ON ba.id = bsl.bank_account_id
     WHERE bsl.transaction_date <= p_as_of_date
       AND bsl.transaction_date >= COALESCE(ba.opening_balance_date, DATE '1900-01-01')
       AND (COALESCE(bsl.statement_balance, 0) <> 0 OR COALESCE(bsl.running_balance, 0) <> 0)
     ORDER BY bsl.bank_account_id, bsl.transaction_date DESC, bsl.id DESC
  )
  SELECT ba.id AS bank_account_id,
         ba.account_name::text,
         ba.bank_name::text,
         ba.account_number::text,
         ba.currency::text,
         ba.coa_id,
         coa.code::text AS coa_code,
         COALESCE(ba.opening_balance, 0) AS opening_balance,
         ba.opening_balance_date,
         COALESCE((
           SELECT SUM(CASE WHEN upper(ba.currency) = 'USD' THEN jel.transaction_debit ELSE jel.debit END)
             FROM public.journal_entry_lines jel
             JOIN public.journal_entries je ON je.id = jel.journal_entry_id
            WHERE jel.account_id = ba.coa_id
              AND je.is_posted = true
              AND NOT COALESCE(je.is_reversed, false)
              AND je.entry_date >= COALESCE(ba.opening_balance_date, DATE '1900-01-01')
              AND je.entry_date <= p_as_of_date
              AND (upper(ba.currency) <> 'USD' OR (
                jel.transaction_currency = 'USD'
                AND jel.functional_currency = 'IDR'
                AND COALESCE(jel.exchange_rate, 0) > 0
              ))
         ), 0) AS total_debits,
         COALESCE((
           SELECT SUM(CASE WHEN upper(ba.currency) = 'USD' THEN jel.transaction_credit ELSE jel.credit END)
             FROM public.journal_entry_lines jel
             JOIN public.journal_entries je ON je.id = jel.journal_entry_id
            WHERE jel.account_id = ba.coa_id
              AND je.is_posted = true
              AND NOT COALESCE(je.is_reversed, false)
              AND je.entry_date >= COALESCE(ba.opening_balance_date, DATE '1900-01-01')
              AND je.entry_date <= p_as_of_date
              AND (upper(ba.currency) <> 'USD' OR (
                jel.transaction_currency = 'USD'
                AND jel.functional_currency = 'IDR'
                AND COALESCE(jel.exchange_rate, 0) > 0
              ))
         ), 0) AS total_credits,
         public.calculate_bank_account_book_balance(ba.id, p_as_of_date) AS book_balance,
         COALESCE(
           ls.last_stmt_bal,
           ROUND(COALESCE(ba.opening_balance, 0) + COALESCE(sa.stmt_credits, 0) - COALESCE(sa.stmt_debits, 0), 2)
         ) AS statement_balance,
         p_as_of_date AS as_of_date
    FROM public.bank_accounts ba
    LEFT JOIN public.chart_of_accounts coa ON coa.id = ba.coa_id
    LEFT JOIN stmt_aggregates sa ON sa.bank_account_id = ba.id
    LEFT JOIN latest_stmt ls ON ls.bank_account_id = ba.id
   WHERE ba.is_active = true;
END;
$function$;
