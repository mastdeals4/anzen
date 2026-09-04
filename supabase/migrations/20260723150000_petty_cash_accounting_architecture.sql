-- Petty Cash accounting architecture
--
-- 1. Petty Cash balance comes from posted GL movement on account 1102.
-- 2. Fund Transfers remain their own source document and no longer create
--    projection rows in petty_cash_transactions.
-- 3. Standalone Petty Cash inflows require a balancing source account.
-- 4. One standalone Petty Cash source row can create at most one journal.
-- 5. Posted Fund Transfer accounting fields are immutable.
-- 6. Sales can read sourcing recipients while writes remain manager/admin only.

ALTER TABLE public.petty_cash_transactions
  ADD COLUMN IF NOT EXISTS source_account_id uuid
    REFERENCES public.chart_of_accounts(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS bank_statement_line_id uuid
    REFERENCES public.bank_statement_lines(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_petty_cash_source_account
  ON public.petty_cash_transactions(source_account_id)
  WHERE source_account_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_petty_cash_bank_statement_line_unique
  ON public.petty_cash_transactions(bank_statement_line_id)
  WHERE bank_statement_line_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_petty_cash_single_source_journal
  ON public.journal_entries(source_module, reference_id)
  WHERE source_module = 'petty_cash' AND reference_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- GL-backed Petty Cash balances
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_petty_cash_balance()
RETURNS numeric
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT COALESCE(SUM(jel.debit - jel.credit), 0)
  FROM public.journal_entry_lines jel
  JOIN public.journal_entries je
    ON je.id = jel.journal_entry_id
  JOIN public.chart_of_accounts coa
    ON coa.id = jel.account_id
  WHERE coa.code = '1102'
    AND je.is_posted = true;
$$;

CREATE OR REPLACE FUNCTION public.get_petty_cash_balance_by_date(
  start_date date,
  end_date date
)
RETURNS numeric
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT COALESCE(SUM(jel.debit - jel.credit), 0)
  FROM public.journal_entry_lines jel
  JOIN public.journal_entries je
    ON je.id = jel.journal_entry_id
  JOIN public.chart_of_accounts coa
    ON coa.id = jel.account_id
  WHERE coa.code = '1102'
    AND je.is_posted = true
    AND je.entry_date BETWEEN start_date AND end_date;
$$;

GRANT EXECUTE ON FUNCTION public.get_petty_cash_balance() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_petty_cash_balance_by_date(date, date) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.get_petty_cash_balance() FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_petty_cash_balance_by_date(date, date) FROM anon;

-- ---------------------------------------------------------------------------
-- Strict, balanced, idempotent standalone Petty Cash posting
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.post_petty_cash_to_journal_fixed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_journal_id         uuid;
  v_petty_cash_account uuid;
  v_counter_account    uuid;
  v_expense_account    uuid;
  v_line_num           integer := 0;
  v_je_number          text;
  v_rows                integer;
BEGIN
  -- Historical Fund Transfer projection rows never own accounting.
  IF NEW.fund_transfer_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT id
    INTO v_journal_id
    FROM public.journal_entries
   WHERE source_module = 'petty_cash'
     AND reference_id = NEW.id
   LIMIT 1;

  IF v_journal_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT id
    INTO v_petty_cash_account
    FROM public.chart_of_accounts
   WHERE code = '1102'
     AND is_header = false
     AND is_active = true
   LIMIT 1;

  IF v_petty_cash_account IS NULL THEN
    RAISE EXCEPTION
      'Cannot post petty cash %: active posting account 1102 is missing',
      NEW.id;
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtext('pc_je_number_' || to_char(NEW.transaction_date, 'YYYYMMDD'))
  );

  SELECT 'JE-' || to_char(NEW.transaction_date, 'YYYYMMDD') || '-' ||
         lpad((count(*) + 1)::text, 4, '0')
    INTO v_je_number
    FROM public.journal_entries
   WHERE entry_date = NEW.transaction_date;

  INSERT INTO public.journal_entries (
    entry_number,
    entry_date,
    source_module,
    reference_id,
    reference_number,
    description,
    total_debit,
    total_credit,
    is_posted,
    created_by,
    posted_at
  ) VALUES (
    v_je_number,
    NEW.transaction_date,
    'petty_cash',
    NEW.id,
    NEW.transaction_number,
    'Petty cash ' || NEW.transaction_type || ': ' || NEW.description,
    NEW.amount,
    NEW.amount,
    true,
    NEW.created_by,
    now()
  )
  RETURNING id INTO v_journal_id;

  IF NEW.transaction_type = 'withdraw' THEN
    IF NEW.bank_account_id IS NOT NULL THEN
      SELECT coa_id
        INTO v_counter_account
        FROM public.bank_accounts
       WHERE id = NEW.bank_account_id;

      IF v_counter_account IS NULL THEN
        RAISE EXCEPTION
          'Cannot post petty cash inflow %: bank account % has no linked CoA',
          NEW.id, NEW.bank_account_id;
      END IF;
    ELSE
      v_counter_account := NEW.source_account_id;
    END IF;

    IF v_counter_account IS NULL THEN
      RAISE EXCEPTION
        'Cannot post petty cash inflow %: select a bank or offset GL account',
        NEW.id;
    END IF;

    IF v_counter_account = v_petty_cash_account THEN
      RAISE EXCEPTION
        'Cannot post petty cash inflow %: offset account cannot be Petty Cash 1102',
        NEW.id;
    END IF;

    INSERT INTO public.journal_entry_lines (
      journal_entry_id, line_number, account_id, debit, credit, description
    ) VALUES
      (v_journal_id, 1, v_petty_cash_account, NEW.amount, 0, 'Cash received into petty cash'),
      (v_journal_id, 2, v_counter_account, 0, NEW.amount, COALESCE(NULLIF(NEW.source, ''), 'Petty cash inflow source'));

  ELSIF NEW.transaction_type = 'expense' THEN
    -- Preserve the existing Petty Cash expense mapping exactly. This migration
    -- changes inflow accounting only.
    SELECT id
      INTO v_expense_account
      FROM public.chart_of_accounts
     WHERE account_type = 'expense'
       AND (
         CASE
           WHEN NEW.expense_category = 'Utilities'                    THEN code = '6300'
           WHEN NEW.expense_category = 'Office Supplies'              THEN code = '6310'
           WHEN NEW.expense_category = 'Transportation'               THEN code = '6320'
           WHEN NEW.expense_category = 'Meals & Entertainment'        THEN code = '6330'
           WHEN NEW.expense_category = 'Postage & Courier'            THEN code = '6340'
           WHEN NEW.expense_category = 'Cleaning & Maintenance'       THEN code = '6350'
           WHEN NEW.expense_category = 'Staff Salaries & Wages'       THEN code = '6360'
           WHEN NEW.expense_category = 'Staff Benefits & Allowances'  THEN code = '6370'
           WHEN NEW.expense_category = 'Printing & Stationery'        THEN code = '6380'
           WHEN NEW.expense_category = 'Telephone & Internet'         THEN code = '6390'
           WHEN NEW.expense_category = 'Bank Charges'                 THEN code = '6400'
           WHEN NEW.expense_category = 'Professional Fees'            THEN code = '6410'
           WHEN NEW.expense_category = 'Office Renovation & Shifting' THEN code = '6420'
           WHEN NEW.expense_category = 'Other Expenses'               THEN code = '6490'
           ELSE code = '5102'
         END
       )
     LIMIT 1;

    IF v_expense_account IS NULL THEN
      SELECT id
        INTO v_expense_account
        FROM public.chart_of_accounts
       WHERE code = '5102'
       LIMIT 1;
    END IF;

    IF v_expense_account IS NULL THEN
      RAISE EXCEPTION
        'Cannot post petty cash expense %: no expense account matched category % and fallback code 5102 is missing',
        NEW.id, NEW.expense_category;
    END IF;

    v_line_num := v_line_num + 1;
    INSERT INTO public.journal_entry_lines (
      journal_entry_id, line_number, account_id, debit, credit, description
    ) VALUES (
      v_journal_id,
      v_line_num,
      v_expense_account,
      NEW.amount,
      0,
      COALESCE(NEW.expense_category, 'General expense')
    );

    v_line_num := v_line_num + 1;
    INSERT INTO public.journal_entry_lines (
      journal_entry_id, line_number, account_id, debit, credit, description
    ) VALUES (
      v_journal_id,
      v_line_num,
      v_petty_cash_account,
      0,
      NEW.amount,
      'Cash expense'
    );
  ELSE
    RAISE EXCEPTION 'Unsupported petty cash transaction type: %', NEW.transaction_type;
  END IF;

  IF NEW.bank_statement_line_id IS NOT NULL THEN
    UPDATE public.bank_statement_lines
       SET matched_petty_cash_id = NEW.id,
           matched_entry_id = v_journal_id,
           reconciliation_status = 'matched',
           matched_at = now(),
           matched_by = COALESCE(NEW.approved_by, NEW.created_by),
           manually_unlinked = false,
           notes = 'Linked to Petty Cash ' || NEW.transaction_number
     WHERE id = NEW.bank_statement_line_id
       AND bank_account_id = NEW.bank_account_id
       AND matched_expense_id IS NULL
       AND matched_receipt_id IS NULL
       AND matched_fund_transfer_id IS NULL
       AND matched_tax_payment_id IS NULL
       AND (matched_petty_cash_id IS NULL OR matched_petty_cash_id = NEW.id)
       AND (matched_entry_id IS NULL OR matched_entry_id = v_journal_id);

    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION
        'Bank statement line % is unavailable or belongs to another bank account',
        NEW.bank_statement_line_id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- Cancellation and deletion also clear reconciliation links
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.cancel_petty_cash_posting(
  p_pct_id uuid,
  p_cancelled_by uuid,
  p_reason text DEFAULT 'Posting cancelled by administrator'
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_pct record;
  v_je  record;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT *
    INTO v_pct
    FROM public.petty_cash_transactions
   WHERE id = p_pct_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Petty cash transaction % not found', p_pct_id;
  END IF;

  IF v_pct.fund_transfer_id IS NOT NULL THEN
    RAISE EXCEPTION 'Fund Transfer activity must be reversed from the Contra screen';
  END IF;

  IF v_pct.approval_status <> 'approved' THEN
    RAISE EXCEPTION
      'Cannot cancel posting: transaction % is not approved (current: %)',
      COALESCE(v_pct.transaction_number, p_pct_id::text),
      v_pct.approval_status;
  END IF;

  SELECT *
    INTO v_je
    FROM public.journal_entries
   WHERE reference_id = p_pct_id
     AND source_module = 'petty_cash'
   LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No journal entry found for %', COALESCE(v_pct.transaction_number, p_pct_id::text);
  END IF;

  PERFORM public.cancel_gl_posting(
    v_je.id,
    p_pct_id,
    'petty_cash_transactions',
    p_cancelled_by,
    p_reason,
    jsonb_build_object(
      'transaction_number', v_pct.transaction_number,
      'amount', v_pct.amount,
      'approval_status', 'approved'
    )
  );

  UPDATE public.bank_statement_lines
     SET matched_petty_cash_id = NULL,
         matched_entry_id = NULL,
         reconciliation_status = 'unmatched',
         matched_at = NULL,
         matched_by = NULL,
         notes = NULL
   WHERE matched_petty_cash_id = p_pct_id
      OR matched_entry_id = v_je.id;

  UPDATE public.petty_cash_transactions
     SET approval_status = 'pending_approval',
         approved_by = NULL,
         approved_at = NULL,
         bank_statement_line_id = NULL
   WHERE id = p_pct_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.delete_petty_cash_journal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  UPDATE public.bank_statement_lines
     SET matched_petty_cash_id = NULL,
         matched_entry_id = NULL,
         reconciliation_status = 'unmatched',
         matched_at = NULL,
         matched_by = NULL,
         notes = NULL
   WHERE matched_petty_cash_id = OLD.id
      OR matched_entry_id IN (
        SELECT id
          FROM public.journal_entries
         WHERE source_module = 'petty_cash'
           AND reference_id = OLD.id
      );

  DELETE FROM public.journal_entry_lines
   WHERE journal_entry_id IN (
     SELECT id
       FROM public.journal_entries
      WHERE source_module = 'petty_cash'
        AND reference_id = OLD.id
   );

  DELETE FROM public.journal_entries
   WHERE source_module = 'petty_cash'
     AND reference_id = OLD.id;

  RETURN OLD;
END;
$$;

-- ---------------------------------------------------------------------------
-- Fund Transfers are displayed directly in Petty Cash; do not create copies
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.create_fund_transfer_with_posting(
  p_transfer_date date,
  p_from_amount numeric,
  p_to_amount numeric,
  p_from_account_type text,
  p_to_account_type text,
  p_description text DEFAULT NULL,
  p_from_bank_account_id uuid DEFAULT NULL,
  p_to_bank_account_id uuid DEFAULT NULL,
  p_from_bank_statement_line_id uuid DEFAULT NULL,
  p_to_bank_statement_line_id uuid DEFAULT NULL,
  p_exchange_rate numeric DEFAULT NULL,
  p_created_by uuid DEFAULT NULL
)
RETURNS public.fund_transfers
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_user_id uuid;
  v_transfer_number text;
  v_transfer public.fund_transfers;
BEGIN
  v_user_id := COALESCE(p_created_by, auth.uid());
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  v_transfer_number := public.generate_fund_transfer_number();

  INSERT INTO public.fund_transfers (
    transfer_number,
    transfer_date,
    amount,
    from_amount,
    to_amount,
    exchange_rate,
    from_account_type,
    to_account_type,
    from_bank_account_id,
    to_bank_account_id,
    from_bank_statement_line_id,
    to_bank_statement_line_id,
    description,
    created_by
  ) VALUES (
    v_transfer_number,
    p_transfer_date,
    p_from_amount,
    p_from_amount,
    p_to_amount,
    p_exchange_rate,
    p_from_account_type,
    p_to_account_type,
    CASE WHEN p_from_account_type = 'bank' THEN p_from_bank_account_id ELSE NULL END,
    CASE WHEN p_to_account_type = 'bank' THEN p_to_bank_account_id ELSE NULL END,
    p_from_bank_statement_line_id,
    p_to_bank_statement_line_id,
    NULLIF(p_description, ''),
    v_user_id
  )
  RETURNING * INTO v_transfer;

  RETURN v_transfer;
END;
$$;

-- Posted transfers may only receive reconciliation links or be reversed.
CREATE OR REPLACE FUNCTION public.protect_posted_fund_transfer_accounting()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF OLD.status = 'posted' AND (
       NEW.transfer_date IS DISTINCT FROM OLD.transfer_date
    OR NEW.amount IS DISTINCT FROM OLD.amount
    OR NEW.from_amount IS DISTINCT FROM OLD.from_amount
    OR NEW.to_amount IS DISTINCT FROM OLD.to_amount
    OR NEW.exchange_rate IS DISTINCT FROM OLD.exchange_rate
    OR NEW.from_account_type IS DISTINCT FROM OLD.from_account_type
    OR NEW.to_account_type IS DISTINCT FROM OLD.to_account_type
    OR NEW.from_bank_account_id IS DISTINCT FROM OLD.from_bank_account_id
    OR NEW.to_bank_account_id IS DISTINCT FROM OLD.to_bank_account_id
    OR NEW.description IS DISTINCT FROM OLD.description
    OR NEW.journal_entry_id IS DISTINCT FROM OLD.journal_entry_id
  ) THEN
    RAISE EXCEPTION
      'Posted Fund Transfer % is accounting-locked. Reverse it and create a replacement.',
      OLD.transfer_number;
  END IF;

  RETURN NEW;
END;
$$;

DROP POLICY IF EXISTS "sourcing_recipients_read"
  ON public.sourcing_email_recipients;

CREATE POLICY "sourcing_recipients_read"
  ON public.sourcing_email_recipients
  FOR SELECT TO authenticated
  USING (
    public.current_user_has_pricing_role(
      ARRAY['admin', 'manager', 'sales']
    )
  );

DROP TRIGGER IF EXISTS trg_protect_posted_fund_transfer_accounting
  ON public.fund_transfers;
CREATE TRIGGER trg_protect_posted_fund_transfer_accounting
  BEFORE UPDATE ON public.fund_transfers
  FOR EACH ROW
  EXECUTE FUNCTION public.protect_posted_fund_transfer_accounting();

GRANT EXECUTE ON FUNCTION public.create_fund_transfer_with_posting(
  date, numeric, numeric, text, text, text, uuid, uuid, uuid, uuid, numeric, uuid
) TO authenticated;

NOTIFY pgrst, 'reload schema';
