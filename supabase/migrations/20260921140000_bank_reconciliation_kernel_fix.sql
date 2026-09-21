-- Migration: 20260921140000_bank_reconciliation_kernel_fix.sql
-- Description: Bank Reconciliation Kernel Fix — Step 1
--              1. Canonical Bank Book Balance (calculate_bank_account_book_balance, get_bank_account_balances)
--              2. Database-level expense payment overpayment protection (voucher_allocations & bank_statement_allocations)
--              3. Support for multiple bank statement lines per expense (canonical bank_statement_allocations ownership)
--              4. Strong match validation in confirm_bank_match()
--              5. True allocation-derived reconciliation and matching status calculations
--              6. Expanded payment_kind check constraints

BEGIN;

-- ============================================================================
-- 1. CANONICAL BANK BOOK BALANCE FUNCTIONS
-- ============================================================================

CREATE OR REPLACE FUNCTION public.calculate_bank_account_book_balance(
  p_bank_account_id uuid,
  p_as_of_date date DEFAULT CURRENT_DATE
)
RETURNS numeric
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_opening numeric := 0;
  v_coa_id uuid;
  v_currency text;
  v_debits numeric := 0;
  v_credits numeric := 0;
BEGIN
  SELECT COALESCE(opening_balance, 0), coa_id, currency
    INTO v_opening, v_coa_id, v_currency
    FROM public.bank_accounts
   WHERE id = p_bank_account_id;

  IF v_coa_id IS NULL THEN
    RETURN v_opening;
  END IF;

  -- For USD accounts, use transaction debit/credit if recorded, falling back to debit/credit
  IF v_currency = 'USD' THEN
    SELECT 
      COALESCE(SUM(COALESCE(NULLIF(jel.transaction_debit, 0), jel.debit, 0)), 0),
      COALESCE(SUM(COALESCE(NULLIF(jel.transaction_credit, 0), jel.credit, 0)), 0)
      INTO v_debits, v_credits
      FROM public.journal_entry_lines jel
      JOIN public.journal_entries je ON je.id = jel.journal_entry_id
     WHERE jel.account_id = v_coa_id
       AND je.is_posted = true
       AND je.entry_date <= p_as_of_date;
  ELSE
    SELECT 
      COALESCE(SUM(jel.debit), 0),
      COALESCE(SUM(jel.credit), 0)
      INTO v_debits, v_credits
      FROM public.journal_entry_lines jel
      JOIN public.journal_entries je ON je.id = jel.journal_entry_id
     WHERE jel.account_id = v_coa_id
       AND je.is_posted = true
       AND je.entry_date <= p_as_of_date;
  END IF;

  RETURN round(v_opening + v_debits - v_credits, 2);
END;
$$;

COMMENT ON FUNCTION public.calculate_bank_account_book_balance(uuid, date) IS 
'Authoritative dynamic book balance for a bank account: opening_balance + posted debits - posted credits. Does not filter is_reversed.';

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
  WITH latest_stmt AS (
    SELECT DISTINCT ON (bsl.bank_account_id)
      bsl.bank_account_id,
      COALESCE(bsl.statement_balance, bsl.running_balance, 0) as last_stmt_bal
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
    COALESCE(ls.last_stmt_bal, COALESCE(ba.opening_balance, 0)) AS statement_balance,
    p_as_of_date AS as_of_date
  FROM public.bank_accounts ba
  LEFT JOIN public.chart_of_accounts coa ON coa.id = ba.coa_id
  LEFT JOIN latest_stmt ls ON ls.bank_account_id = ba.id
  WHERE ba.is_active = true;
END;
$$;

GRANT EXECUTE ON FUNCTION public.calculate_bank_account_book_balance(uuid, date) TO authenticated, service_role, anon;
GRANT EXECUTE ON FUNCTION public.get_bank_account_balances(date) TO authenticated, service_role, anon;

-- ============================================================================
-- 2. EXPAND PAYMENT_KIND CONSTRAINTS ON BANK TABLES
-- ============================================================================

ALTER TABLE public.bank_statement_lines DROP CONSTRAINT IF EXISTS bank_statement_lines_payment_kind_check;
ALTER TABLE public.bank_statement_lines ALTER COLUMN payment_kind DROP NOT NULL;
ALTER TABLE public.bank_statement_lines ALTER COLUMN payment_kind SET DEFAULT 'unclassified';
ALTER TABLE public.bank_statement_lines ADD CONSTRAINT bank_statement_lines_payment_kind_check 
  CHECK (payment_kind IS NULL OR payment_kind = ANY (ARRAY[
    'supplier'::text, 'pph23'::text, 'salary'::text, 'tax'::text, 
    'petty_cash'::text, 'capital'::text, 'admin_expense'::text, 
    'customer_receipt'::text, 'fund_transfer'::text, 'other'::text, 'unclassified'::text
  ]));

ALTER TABLE public.bank_statement_allocations DROP CONSTRAINT IF EXISTS bank_statement_allocations_payment_kind_check;
ALTER TABLE public.bank_statement_allocations ALTER COLUMN payment_kind DROP NOT NULL;
ALTER TABLE public.bank_statement_allocations ALTER COLUMN payment_kind SET DEFAULT 'unclassified';
ALTER TABLE public.bank_statement_allocations ADD CONSTRAINT bank_statement_allocations_payment_kind_check 
  CHECK (payment_kind IS NULL OR payment_kind = ANY (ARRAY[
    'supplier'::text, 'pph23'::text, 'salary'::text, 'tax'::text, 
    'petty_cash'::text, 'capital'::text, 'admin_expense'::text, 
    'customer_receipt'::text, 'fund_transfer'::text, 'other'::text, 'unclassified'::text
  ]));

-- ============================================================================
-- 3. EXPENSE OVERPAYMENT PROTECTION (VOUCHER_ALLOCATIONS)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.prevent_expense_payment_overallocation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_exp RECORD;
  v_payable numeric := 0;
  v_settled_va numeric := 0;
  v_settled_bsa numeric := 0;
  v_settled_bsl numeric := 0;
  v_total_settled numeric := 0;
  v_remaining numeric := 0;
  v_kind text;
BEGIN
  IF NEW.finance_expense_id IS NULL OR NEW.voucher_type <> 'payment' THEN
    RETURN NEW;
  END IF;

  v_kind := COALESCE(NEW.payment_kind, 'supplier');

  -- Lock the finance_expense row inside the same transaction
  SELECT * INTO v_exp 
    FROM public.finance_expenses 
   WHERE id = NEW.finance_expense_id 
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Referenced finance_expense % does not exist', NEW.finance_expense_id;
  END IF;

  -- Determine total payable for this payment kind
  IF v_kind = 'pph23' THEN
    v_payable := COALESCE(v_exp.pph_amount, 0);
  ELSE
    v_payable := COALESCE(public.calculate_finance_expense_payable(v_exp.id), 0);
  END IF;

  -- Existing posted settlements from voucher_allocations (excluding current row on update)
  SELECT COALESCE(SUM(va.allocated_amount), 0) INTO v_settled_va
    FROM public.voucher_allocations va
    JOIN public.payment_vouchers pv ON pv.id = va.payment_voucher_id
   WHERE va.finance_expense_id = v_exp.id
     AND COALESCE(va.payment_kind, 'supplier') = v_kind
     AND COALESCE(pv.payment_purpose, 'general') NOT IN ('salary_advance', 'salary_advance_settlement')
     AND (TG_OP <> 'UPDATE' OR va.id <> NEW.id);

  -- Existing posted settlements from bank_statement_allocations
  SELECT COALESCE(SUM(bsa.allocation_amount), 0) INTO v_settled_bsa
    FROM public.bank_statement_allocations bsa
   WHERE bsa.document_type = 'expense'
     AND bsa.document_id = v_exp.id
     AND COALESCE(bsa.payment_kind, 'supplier') = v_kind;

  -- Existing legacy settlements from bank_statement_lines without allocations
  SELECT COALESCE(SUM(COALESCE(NULLIF(bsl.debit_amount, 0), bsl.credit_amount, 0)), 0) INTO v_settled_bsl
    FROM public.bank_statement_lines bsl
   WHERE bsl.matched_expense_id = v_exp.id
     AND COALESCE(bsl.payment_kind, 'supplier') = v_kind
     AND NOT EXISTS (
       SELECT 1 FROM public.bank_statement_allocations a 
        WHERE a.bank_statement_line_id = bsl.id
     );

  v_total_settled := v_settled_va + v_settled_bsa + v_settled_bsl;
  v_remaining := round(v_payable - v_total_settled, 2);

  IF NEW.allocated_amount > (v_remaining + 0.01) THEN
    RAISE EXCEPTION 'Expense payment allocation (%) exceeds remaining payable (%) for expense % (Total Payable: %, Already Settled: %)',
      NEW.allocated_amount, v_remaining, COALESCE(v_exp.voucher_number, v_exp.id::text), v_payable, v_total_settled;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_expense_payment_overallocation ON public.voucher_allocations;
CREATE TRIGGER trg_prevent_expense_payment_overallocation
  BEFORE INSERT OR UPDATE OF allocated_amount, finance_expense_id, payment_kind, voucher_type
  ON public.voucher_allocations
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_expense_payment_overallocation();

-- ============================================================================
-- 4. EXPENSE OVERPAYMENT & ALLOCATION CAP (BANK_STATEMENT_ALLOCATIONS)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.validate_expense_bank_allocation_against_journal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_exp RECORD;
  v_payable numeric := 0;
  v_settled_va numeric := 0;
  v_settled_bsa numeric := 0;
  v_settled_bsl numeric := 0;
  v_total_settled numeric := 0;
  v_remaining numeric := 0;
  v_kind text;
  v_bank_line RECORD;
  v_bank_amount numeric := 0;
  v_other_allocations numeric := 0;
BEGIN
  -- 1. Bank Statement Line Allocation Cap Check (applies to ALL document types)
  SELECT bsl.*, ba.coa_id AS bank_coa_id, ba.currency AS bank_currency
    INTO v_bank_line
    FROM public.bank_statement_lines bsl
    JOIN public.bank_accounts ba ON ba.id = bsl.bank_account_id
   WHERE bsl.id = NEW.bank_statement_line_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Bank statement line % does not exist', NEW.bank_statement_line_id;
  END IF;

  v_bank_amount := COALESCE(NULLIF(v_bank_line.debit_amount, 0), v_bank_line.credit_amount, 0);

  SELECT COALESCE(SUM(allocation_amount), 0) INTO v_other_allocations
    FROM public.bank_statement_allocations
   WHERE bank_statement_line_id = NEW.bank_statement_line_id
     AND (TG_OP <> 'UPDATE' OR id <> NEW.id);

  IF (v_other_allocations + NEW.allocation_amount) > (v_bank_amount + 0.01) THEN
    RAISE EXCEPTION 'Total bank allocations (%) exceed bank statement line amount (%) on line %',
      (v_other_allocations + NEW.allocation_amount), v_bank_amount, NEW.bank_statement_line_id;
  END IF;

  -- 2. If document is expense, enforce aggregate expense payable limits
  IF NEW.document_type = 'expense' THEN
    v_kind := COALESCE(NEW.payment_kind, 'supplier');

    -- Lock the finance_expenses row inside the same transaction
    SELECT * INTO v_exp
      FROM public.finance_expenses
     WHERE id = NEW.document_id
       FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Referenced finance_expense % does not exist', NEW.document_id;
    END IF;

    IF v_kind = 'pph23' THEN
      v_payable := COALESCE(v_exp.pph_amount, 0);
    ELSE
      v_payable := COALESCE(public.calculate_finance_expense_payable(v_exp.id), 0);
    END IF;

    -- Settlements from voucher_allocations
    SELECT COALESCE(SUM(va.allocated_amount), 0) INTO v_settled_va
      FROM public.voucher_allocations va
      JOIN public.payment_vouchers pv ON pv.id = va.payment_voucher_id
     WHERE va.finance_expense_id = v_exp.id
       AND COALESCE(va.payment_kind, 'supplier') = v_kind
       AND COALESCE(pv.payment_purpose, 'general') NOT IN ('salary_advance', 'salary_advance_settlement');

    -- Settlements from other bank_statement_allocations
    SELECT COALESCE(SUM(bsa.allocation_amount), 0) INTO v_settled_bsa
      FROM public.bank_statement_allocations bsa
     WHERE bsa.document_type = 'expense'
       AND bsa.document_id = v_exp.id
       AND COALESCE(bsa.payment_kind, 'supplier') = v_kind
       AND (TG_OP <> 'UPDATE' OR bsa.id <> NEW.id);

    -- Settlements from unallocated legacy bank lines
    SELECT COALESCE(SUM(COALESCE(NULLIF(bsl.debit_amount, 0), bsl.credit_amount, 0)), 0) INTO v_settled_bsl
      FROM public.bank_statement_lines bsl
     WHERE bsl.matched_expense_id = v_exp.id
       AND COALESCE(bsl.payment_kind, 'supplier') = v_kind
       AND bsl.id <> NEW.bank_statement_line_id
       AND NOT EXISTS (
         SELECT 1 FROM public.bank_statement_allocations a 
          WHERE a.bank_statement_line_id = bsl.id
       );

    v_total_settled := v_settled_va + v_settled_bsa + v_settled_bsl;
    v_remaining := round(v_payable - v_total_settled, 2);

    IF NEW.allocation_amount > (v_remaining + 0.01) THEN
      RAISE EXCEPTION 'Bank allocation (%) exceeds remaining payable (%) for expense % (Total Payable: %, Already Settled: %)',
        NEW.allocation_amount, v_remaining, COALESCE(v_exp.voucher_number, v_exp.id::text), v_payable, v_total_settled;
    END IF;
  END IF;

  -- 3. If journal entry is attached, validate journal bank lines
  IF NEW.journal_entry_id IS NOT NULL THEN
    PERFORM 1 FROM public.journal_entries 
     WHERE id = NEW.journal_entry_id AND is_posted = true;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Attached journal entry % is either missing or not posted', NEW.journal_entry_id;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM public.journal_entry_lines
       WHERE journal_entry_id = NEW.journal_entry_id
         AND account_id = v_bank_line.bank_coa_id
    ) THEN
      RAISE EXCEPTION 'Journal entry % does not contain the bank account COA %',
        NEW.journal_entry_id, v_bank_line.bank_coa_id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- ============================================================================
-- 5. CANONICAL RECONCILIATION OWNERSHIP (SYNC_BANK_LINE_ALLOCATION_OWNER)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.sync_bank_line_allocation_owner(p_bank_line_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_count integer;
  v_only public.bank_statement_allocations%ROWTYPE;
  v_target_expense_id uuid;
  v_target_receipt_id uuid;
  v_target_payment_id uuid;
  v_target_ft_id uuid;
  v_target_pc_id uuid;
  v_target_tax_id uuid;
  v_target_entry_id uuid;
  v_target_kind text;
BEGIN
  SELECT count(*) INTO v_count
    FROM public.bank_statement_allocations
   WHERE bank_statement_line_id = p_bank_line_id;

  IF v_count = 1 THEN
    SELECT * INTO v_only
      FROM public.bank_statement_allocations
     WHERE bank_statement_line_id = p_bank_line_id;

    -- Multiple bank statement lines can settle the same expense; do NOT enforce artificial 1:1 exclusivity
    v_target_expense_id := CASE WHEN v_only.document_type = 'expense' THEN v_only.document_id END;
    v_target_receipt_id := CASE WHEN v_only.document_type = 'receipt' THEN v_only.document_id END;
    v_target_payment_id := CASE WHEN v_only.document_type = 'payment' THEN v_only.document_id END;
    v_target_ft_id := CASE WHEN v_only.document_type = 'fund_transfer' THEN v_only.document_id END;
    v_target_pc_id := CASE WHEN v_only.document_type = 'petty_cash' THEN v_only.document_id END;
    v_target_tax_id := CASE WHEN v_only.document_type = 'tax_payment' THEN v_only.document_id END;
    v_target_entry_id := v_only.journal_entry_id;
    v_target_kind := COALESCE(v_only.payment_kind,
      CASE v_only.document_type
        WHEN 'expense' THEN 'supplier'
        WHEN 'receipt' THEN 'customer_receipt'
        WHEN 'tax_payment' THEN 'tax'
        WHEN 'petty_cash' THEN 'petty_cash'
        WHEN 'fund_transfer' THEN 'fund_transfer'
        ELSE 'other'
      END
    );

    UPDATE public.bank_statement_lines SET
      matched_expense_id = v_target_expense_id,
      matched_receipt_id = v_target_receipt_id,
      matched_payment_id = v_target_payment_id,
      matched_fund_transfer_id = v_target_ft_id,
      matched_petty_cash_id = v_target_pc_id,
      matched_tax_payment_id = v_target_tax_id,
      matched_entry_id = v_target_entry_id,
      payment_kind = v_target_kind
    WHERE id = p_bank_line_id
      AND (
        matched_expense_id IS DISTINCT FROM v_target_expense_id OR
        matched_receipt_id IS DISTINCT FROM v_target_receipt_id OR
        matched_payment_id IS DISTINCT FROM v_target_payment_id OR
        matched_fund_transfer_id IS DISTINCT FROM v_target_ft_id OR
        matched_petty_cash_id IS DISTINCT FROM v_target_pc_id OR
        matched_tax_payment_id IS DISTINCT FROM v_target_tax_id OR
        matched_entry_id IS DISTINCT FROM v_target_entry_id OR
        payment_kind IS DISTINCT FROM v_target_kind
      );
  ELSE
    UPDATE public.bank_statement_lines SET
      matched_expense_id = NULL,
      matched_receipt_id = NULL,
      matched_payment_id = NULL,
      matched_fund_transfer_id = NULL,
      matched_petty_cash_id = NULL,
      matched_tax_payment_id = NULL,
      matched_entry_id = NULL
    WHERE id = p_bank_line_id
      AND (
        matched_expense_id IS NOT NULL OR
        matched_receipt_id IS NOT NULL OR
        matched_payment_id IS NOT NULL OR
        matched_fund_transfer_id IS NOT NULL OR
        matched_petty_cash_id IS NOT NULL OR
        matched_tax_payment_id IS NOT NULL OR
        matched_entry_id IS NOT NULL
      );
  END IF;
END;
$$;

-- ============================================================================
-- 6. STRONG MATCH VALIDATION IN CONFIRM_BANK_MATCH()
-- ============================================================================

CREATE OR REPLACE FUNCTION public.confirm_bank_match(
  p_bank_line_id uuid,
  p_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_line RECORD;
  v_bank_acct RECORD;
  v_alloc RECORD;
  v_total_alloc numeric := 0;
  v_line_amount numeric := 0;
  v_journal RECORD;
  v_role text;
  v_alloc_count integer := 0;
BEGIN
  -- Permission check
  SELECT role INTO v_role FROM public.user_profiles WHERE id = auth.uid();
  IF v_role IS NOT NULL AND v_role NOT IN ('admin', 'accounts') THEN
    RAISE EXCEPTION 'Permission denied: role % cannot confirm bank matches', v_role;
  END IF;

  SELECT * INTO v_line 
    FROM public.bank_statement_lines 
   WHERE id = p_bank_line_id 
     FOR UPDATE;

  IF NOT FOUND THEN 
    RETURN jsonb_build_object('success', false, 'error', 'Bank statement line not found'); 
  END IF;

  SELECT * INTO v_bank_acct 
    FROM public.bank_accounts 
   WHERE id = v_line.bank_account_id;

  IF NOT FOUND THEN 
    RETURN jsonb_build_object('success', false, 'error', 'Bank account not found'); 
  END IF;

  v_line_amount := COALESCE(NULLIF(v_line.debit_amount, 0), v_line.credit_amount, 0);

  -- Count allocations
  SELECT count(*), COALESCE(sum(allocation_amount), 0)
    INTO v_alloc_count, v_total_alloc
    FROM public.bank_statement_allocations
   WHERE bank_statement_line_id = p_bank_line_id;

  -- Case A: Line has allocations
  IF v_alloc_count > 0 THEN
    IF v_total_alloc > v_line_amount + 0.01 THEN
      RETURN jsonb_build_object('success', false, 'error', 'Total allocations (' || v_total_alloc || ') exceed bank line amount (' || v_line_amount || ')');
    END IF;

    -- Validate each allocation
    FOR v_alloc IN 
      SELECT bsa.*, je.is_posted, je.transaction_currency
        FROM public.bank_statement_allocations bsa
        LEFT JOIN public.journal_entries je ON je.id = bsa.journal_entry_id
       WHERE bsa.bank_statement_line_id = p_bank_line_id
    LOOP
      -- 1. Must have journal entry
      IF v_alloc.journal_entry_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'Allocation has no journal entry attached');
      END IF;

      -- 2. Active posted journal
      IF COALESCE(v_alloc.is_posted, false) = false THEN
        RETURN jsonb_build_object('success', false, 'error', 'Journal entry ' || v_alloc.journal_entry_id || ' is not posted');
      END IF;

      -- 3. Journal must contain the bank account COA
      IF NOT EXISTS (
        SELECT 1 FROM public.journal_entry_lines 
         WHERE journal_entry_id = v_alloc.journal_entry_id 
           AND account_id = v_bank_acct.coa_id
      ) THEN
        RETURN jsonb_build_object('success', false, 'error', 'Journal entry does not contain bank account COA');
      END IF;

      -- 4. Direction match:
      -- Bank statement debit (money out) -> GL bank line credit
      -- Bank statement credit (money in) -> GL bank line debit
      IF v_line.debit_amount > 0 THEN
        IF NOT EXISTS (
          SELECT 1 FROM public.journal_entry_lines
           WHERE journal_entry_id = v_alloc.journal_entry_id 
             AND account_id = v_bank_acct.coa_id 
             AND credit > 0
        ) THEN
          RETURN jsonb_build_object('success', false, 'error', 'Journal direction mismatch: statement debit requires GL bank credit');
        END IF;
      ELSIF v_line.credit_amount > 0 THEN
        IF NOT EXISTS (
          SELECT 1 FROM public.journal_entry_lines
           WHERE journal_entry_id = v_alloc.journal_entry_id 
             AND account_id = v_bank_acct.coa_id 
             AND debit > 0
        ) THEN
          RETURN jsonb_build_object('success', false, 'error', 'Journal direction mismatch: statement credit requires GL bank debit');
        END IF;
      END IF;

      -- 5. Currency check
      IF v_bank_acct.currency = 'USD' AND v_alloc.transaction_currency IS NOT NULL AND v_alloc.transaction_currency <> 'USD' THEN
        RETURN jsonb_build_object('success', false, 'error', 'Currency mismatch between journal and bank account');
      END IF;

      -- 6. Document settlement validity if expense
      IF v_alloc.document_type = 'expense' THEN
        IF NOT EXISTS (
          SELECT 1 FROM public.finance_expenses WHERE id = v_alloc.document_id
        ) THEN
          RETURN jsonb_build_object('success', false, 'error', 'Referenced finance expense does not exist');
        END IF;
      END IF;
    END LOOP;

  -- Case B: Direct matched journal without allocations
  ELSIF v_line.matched_entry_id IS NOT NULL THEN
    SELECT * INTO v_journal 
      FROM public.journal_entries 
     WHERE id = v_line.matched_entry_id;

    IF NOT FOUND OR COALESCE(v_journal.is_posted, false) = false THEN
      RETURN jsonb_build_object('success', false, 'error', 'Direct matched journal is missing or unposted');
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM public.journal_entry_lines 
       WHERE journal_entry_id = v_journal.id 
         AND account_id = v_bank_acct.coa_id
    ) THEN
      RETURN jsonb_build_object('success', false, 'error', 'Journal does not contain bank account COA');
    END IF;

    IF v_line.debit_amount > 0 THEN
      IF NOT EXISTS (
        SELECT 1 FROM public.journal_entry_lines
         WHERE journal_entry_id = v_journal.id AND account_id = v_bank_acct.coa_id AND credit > 0
      ) THEN
        RETURN jsonb_build_object('success', false, 'error', 'Journal direction mismatch: statement debit requires GL credit');
      END IF;
    ELSIF v_line.credit_amount > 0 THEN
      IF NOT EXISTS (
        SELECT 1 FROM public.journal_entry_lines
         WHERE journal_entry_id = v_journal.id AND account_id = v_bank_acct.coa_id AND debit > 0
      ) THEN
        RETURN jsonb_build_object('success', false, 'error', 'Journal direction mismatch: statement credit requires GL debit');
      END IF;
    END IF;
  ELSE
    RETURN jsonb_build_object('success', false, 'error', 'Cannot confirm match: line has no valid allocation or posted journal entry');
  END IF;

  -- Perform the confirmation
  UPDATE public.bank_statement_lines
     SET matching_status = 'confirmed',
         reconciliation_status = CASE
           WHEN v_alloc_count > 0 AND v_total_alloc < v_line_amount - 0.01 THEN 'partially_reconciled'
           ELSE 'matched'
         END,
         matched_at = now(),
         matched_by = COALESCE(p_user_id, auth.uid()),
         notes = COALESCE(notes, 'User confirmed match')
   WHERE id = p_bank_line_id;

  RETURN jsonb_build_object('success', true, 'message', 'Match confirmed successfully');
END;
$$;

-- ============================================================================
-- 7. ALLOCATION-DERIVED STATUS SYNCHRONIZATION
-- ============================================================================

CREATE OR REPLACE FUNCTION public.bsl_sync_reconciliation_status()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_allocated numeric := 0;
  v_total numeric := 0;
  v_alloc_count integer := 0;
BEGIN
  v_total := COALESCE(NULLIF(NEW.debit_amount, 0), NEW.credit_amount, 0);

  SELECT count(*), COALESCE(sum(allocation_amount), 0)
    INTO v_alloc_count, v_allocated
    FROM public.bank_statement_allocations
   WHERE bank_statement_line_id = NEW.id;

  -- 1. If line has no allocations and no matched journal entry:
  IF v_alloc_count = 0 AND NEW.matched_entry_id IS NULL THEN
    IF NEW.matching_status = 'confirmed' AND (TG_OP = 'INSERT' OR OLD.matching_status IS DISTINCT FROM 'confirmed') THEN
      RAISE EXCEPTION 'Bank statement line % cannot be marked confirmed without an allocation or posted journal', NEW.id;
    END IF;
    NEW.reconciliation_status := 'unmatched';
    NEW.matching_status := 'none';
    NEW.matched_at := NULL;
    NEW.matched_by := NULL;

  -- 2. Line has allocations: derive status from allocation amounts
  ELSIF v_alloc_count > 0 THEN
    IF v_allocated <= 0.01 THEN
      NEW.reconciliation_status := 'unmatched';
    ELSIF v_allocated < v_total - 0.01 THEN
      NEW.reconciliation_status := 'partially_reconciled';
    ELSE
      NEW.reconciliation_status := 'matched';
    END IF;

  -- 3. Line has direct matched_entry_id without allocations
  ELSIF NEW.matched_entry_id IS NOT NULL THEN
    IF NEW.reconciliation_status IS NULL OR NEW.reconciliation_status = 'unmatched' THEN
      NEW.reconciliation_status := 'matched';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_bsl_sync_reconciliation_status ON public.bank_statement_lines;
CREATE TRIGGER trg_bsl_sync_reconciliation_status
  BEFORE INSERT OR UPDATE OF
    reconciliation_status,
    matching_status,
    matched_expense_id,
    matched_receipt_id,
    matched_payment_id,
    matched_fund_transfer_id,
    matched_petty_cash_id,
    matched_tax_payment_id,
    matched_entry_id
  ON public.bank_statement_lines
  FOR EACH ROW
  EXECUTE FUNCTION public.bsl_sync_reconciliation_status();

CREATE OR REPLACE FUNCTION public.refresh_bank_statement_allocation_status(p_bank_line_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_total numeric;
  v_allocated numeric;
  v_existing_status text;
  v_existing_matching_status text;
  v_new_matching_status text;
  v_new_recon_status text;
BEGIN
  SELECT COALESCE(NULLIF(debit_amount, 0), credit_amount, 0),
         reconciliation_status, matching_status
    INTO v_total, v_existing_status, v_existing_matching_status
    FROM public.bank_statement_lines
   WHERE id = p_bank_line_id
   FOR UPDATE;

  SELECT COALESCE(sum(allocation_amount), 0)
    INTO v_allocated
    FROM public.bank_statement_allocations
   WHERE bank_statement_line_id = p_bank_line_id;

  IF v_allocated <= 0.01 THEN
    v_new_recon_status := 'unmatched';
    v_new_matching_status := 'none';
  ELSIF v_allocated < v_total - 0.01 THEN
    v_new_recon_status := 'partially_reconciled';
    v_new_matching_status := CASE WHEN v_existing_matching_status = 'confirmed' THEN 'confirmed' ELSE 'suggested' END;
  ELSE
    v_new_recon_status := 'matched';
    v_new_matching_status := CASE WHEN v_existing_matching_status = 'confirmed' THEN 'confirmed' ELSE 'suggested' END;
  END IF;

  UPDATE public.bank_statement_lines
     SET reconciliation_status = v_new_recon_status,
         matching_status = v_new_matching_status,
         matched_at = CASE WHEN v_allocated <= 0.01 THEN NULL ELSE COALESCE(matched_at, now()) END,
         matched_by = CASE WHEN v_allocated <= 0.01 THEN NULL ELSE COALESCE(matched_by, auth.uid()) END
   WHERE id = p_bank_line_id;
END;
$$;

COMMIT;
