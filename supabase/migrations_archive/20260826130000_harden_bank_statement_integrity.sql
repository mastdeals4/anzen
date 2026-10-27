/*
  Bank statement / bank-ledger integrity hardening.

  Additive guards only.  No historical journal dates, amounts, statement rows,
  or allocations are rewritten.  Split allocations remain supported: one
  statement line may allocate to several documents, while each exact
  line/document/payment-kind relationship remains idempotent.
*/
BEGIN;

CREATE OR REPLACE FUNCTION public.validate_bank_statement_line_integrity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_currency text;
BEGIN
  SELECT upper(currency) INTO v_currency
    FROM public.bank_accounts WHERE id = NEW.bank_account_id;
  IF v_currency IS NULL THEN
    RAISE EXCEPTION 'Bank statement line requires an active bank account';
  END IF;
  IF upper(COALESCE(NEW.currency, '')) <> v_currency THEN
    RAISE EXCEPTION 'Bank statement currency % does not match bank account currency %', NEW.currency, v_currency
      USING ERRCODE = 'check_violation';
  END IF;
  IF COALESCE(NEW.debit_amount, 0) < 0 OR COALESCE(NEW.credit_amount, 0) < 0
     OR (COALESCE(NEW.debit_amount, 0) > 0 AND COALESCE(NEW.credit_amount, 0) > 0)
     OR (COALESCE(NEW.debit_amount, 0) = 0 AND COALESCE(NEW.credit_amount, 0) = 0) THEN
    RAISE EXCEPTION 'Bank statement line must have exactly one positive debit or credit amount'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_bank_statement_line_integrity ON public.bank_statement_lines;
CREATE TRIGGER trg_validate_bank_statement_line_integrity
BEFORE INSERT OR UPDATE OF bank_account_id, currency, debit_amount, credit_amount
ON public.bank_statement_lines
FOR EACH ROW EXECUTE FUNCTION public.validate_bank_statement_line_integrity();

CREATE OR REPLACE FUNCTION public.validate_bank_allocation_integrity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_line public.bank_statement_lines%rowtype;
  v_je public.journal_entries%rowtype;
  v_bank_coa uuid;
  v_bank_currency text;
  v_total numeric;
  v_allocated numeric;
  v_journal_debit numeric;
  v_journal_credit numeric;
  v_tx_debit numeric;
  v_tx_credit numeric;
  v_is_statement_debit boolean;
BEGIN
  SELECT * INTO v_line FROM public.bank_statement_lines
   WHERE id = NEW.bank_statement_line_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Bank statement line % not found', NEW.bank_statement_line_id; END IF;
  SELECT * INTO v_je FROM public.journal_entries
   WHERE id = NEW.journal_entry_id FOR UPDATE;
  IF NOT FOUND OR NOT v_je.is_posted OR COALESCE(v_je.is_reversed, false) THEN
    RAISE EXCEPTION 'Allocation requires an active posted journal';
  END IF;
  SELECT coa_id, upper(currency) INTO v_bank_coa, v_bank_currency
    FROM public.bank_accounts WHERE id = v_line.bank_account_id;
  IF v_bank_coa IS NULL THEN RAISE EXCEPTION 'Bank account has no COA'; END IF;
  IF upper(COALESCE(v_line.currency, '')) <> v_bank_currency THEN
    RAISE EXCEPTION 'Statement/account currency mismatch';
  END IF;
  v_total := COALESCE(NULLIF(v_line.debit_amount, 0), v_line.credit_amount, 0);
  SELECT COALESCE(sum(a.allocation_amount), 0) INTO v_allocated
    FROM public.bank_statement_allocations a
   WHERE a.bank_statement_line_id = NEW.bank_statement_line_id
     AND (TG_OP <> 'UPDATE' OR a.id <> NEW.id);
  IF v_allocated + NEW.allocation_amount > v_total + 0.01 THEN
    RAISE EXCEPTION 'Bank allocations exceed statement amount';
  END IF;
  SELECT COALESCE(sum(l.debit), 0), COALESCE(sum(l.credit), 0),
         COALESCE(sum(l.transaction_debit), 0), COALESCE(sum(l.transaction_credit), 0)
    INTO v_journal_debit, v_journal_credit, v_tx_debit, v_tx_credit
    FROM public.journal_entry_lines l
   WHERE l.journal_entry_id = NEW.journal_entry_id AND l.account_id = v_bank_coa;
  IF v_journal_debit = 0 AND v_journal_credit = 0 THEN
    RAISE EXCEPTION 'Allocated journal has no bank COA movement';
  END IF;
  v_is_statement_debit := COALESCE(v_line.debit_amount, 0) > 0;
  IF v_is_statement_debit AND v_journal_credit <= 0 THEN
    RAISE EXCEPTION 'Statement debit requires a journal bank credit';
  ELSIF NOT v_is_statement_debit AND v_journal_debit <= 0 THEN
    RAISE EXCEPTION 'Statement credit requires a journal bank debit';
  END IF;
  -- Journal headers are historically inconsistent (some valid USD bank
  -- postings carry IDR at header level).  Validate the linked bank COA lines,
  -- which are the canonical bank-side currency evidence, instead.
  IF v_bank_currency = 'USD' AND NOT EXISTS (
    SELECT 1
    FROM public.journal_entry_lines l
    WHERE l.journal_entry_id = NEW.journal_entry_id
      AND l.account_id = v_bank_coa
      AND l.transaction_currency = 'USD'
      AND l.functional_currency = 'IDR'
      AND COALESCE(l.exchange_rate, 0) > 0
      AND ((l.debit > 0 AND COALESCE(l.transaction_debit, 0) > 0)
        OR (l.credit > 0 AND COALESCE(l.transaction_credit, 0) > 0))
  ) THEN
    RAISE EXCEPTION 'USD bank allocation requires valid USD metadata on the bank COA line';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_bank_allocation_integrity ON public.bank_statement_allocations;
CREATE TRIGGER trg_validate_bank_allocation_integrity
BEFORE INSERT OR UPDATE OF bank_statement_line_id, journal_entry_id, allocation_amount
ON public.bank_statement_allocations
FOR EACH ROW EXECUTE FUNCTION public.validate_bank_allocation_integrity();

CREATE OR REPLACE FUNCTION public.prevent_active_fund_transfer_statement_reuse()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.status IN ('cancelled', 'reversed') THEN RETURN NEW; END IF;
  IF NEW.from_bank_statement_line_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.fund_transfers ft
     WHERE ft.id <> NEW.id AND ft.status NOT IN ('cancelled', 'reversed')
       AND ft.from_bank_statement_line_id = NEW.from_bank_statement_line_id
  ) THEN
    RAISE EXCEPTION 'Active bank statement line is already used by another fund transfer';
  END IF;
  IF NEW.to_bank_statement_line_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.fund_transfers ft
     WHERE ft.id <> NEW.id AND ft.status NOT IN ('cancelled', 'reversed')
       AND ft.to_bank_statement_line_id = NEW.to_bank_statement_line_id
  ) THEN
    RAISE EXCEPTION 'Active bank statement line is already used by another fund transfer';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_active_fund_transfer_statement_reuse ON public.fund_transfers;
CREATE TRIGGER trg_prevent_active_fund_transfer_statement_reuse
BEFORE INSERT OR UPDATE OF status, from_bank_statement_line_id, to_bank_statement_line_id
ON public.fund_transfers
FOR EACH ROW EXECUTE FUNCTION public.prevent_active_fund_transfer_statement_reuse();

CREATE UNIQUE INDEX IF NOT EXISTS uq_active_fund_transfer_from_statement
  ON public.fund_transfers(from_bank_statement_line_id)
  WHERE from_bank_statement_line_id IS NOT NULL
    AND status NOT IN ('cancelled', 'reversed');
CREATE UNIQUE INDEX IF NOT EXISTS uq_active_fund_transfer_to_statement
  ON public.fund_transfers(to_bank_statement_line_id)
  WHERE to_bank_statement_line_id IS NOT NULL
    AND status NOT IN ('cancelled', 'reversed');

-- Retrying a normal posting may reuse an already reversed document only
-- through its explicit undo flow; it may never create a second active JE.
CREATE UNIQUE INDEX IF NOT EXISTS uq_active_bank_document_journal
  ON public.journal_entries(source_module, reference_id)
  WHERE reference_id IS NOT NULL
    AND is_posted = true
    AND COALESCE(is_reversed, false) = false
    -- Explicit reversal JEs use their generated JE number as both entry and
    -- reference number. They share the source document id by design.
    AND reference_number IS DISTINCT FROM entry_number
    AND source_module IN ('expenses', 'payment', 'receipt', 'petty_cash',
                          'fund_transfers', 'tax_payment');

CREATE OR REPLACE FUNCTION public.validate_usd_bank_journal_line()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_is_usd boolean;
  v_rate numeric;
BEGIN
  SELECT upper(ba.currency) = 'USD' INTO v_is_usd
    FROM public.bank_accounts ba WHERE ba.coa_id = NEW.account_id AND ba.is_active = true
    LIMIT 1;
  IF NOT COALESCE(v_is_usd, false) THEN RETURN NEW; END IF;
  -- Canonical posters insert lines before the document-row synchronization
  -- trigger fills their currency metadata.  Enforce strictly once bank
  -- evidence is allocated, and on every later mutation of that bank line.
  IF NOT EXISTS (
    SELECT 1 FROM public.bank_statement_allocations a
    WHERE a.journal_entry_id = NEW.journal_entry_id
  ) THEN
    RETURN NEW;
  END IF;
  v_rate := COALESCE(NEW.exchange_rate, 0);
  IF NEW.transaction_currency IS DISTINCT FROM 'USD'
     OR NEW.functional_currency IS DISTINCT FROM 'IDR'
     OR v_rate <= 0
     OR (COALESCE(NEW.transaction_debit, 0) = 0 AND COALESCE(NEW.transaction_credit, 0) = 0)
     OR abs(COALESCE(NEW.debit, 0) - COALESCE(NEW.transaction_debit, 0) * v_rate) > 0.01
     OR abs(COALESCE(NEW.credit, 0) - COALESCE(NEW.transaction_credit, 0) * v_rate) > 0.01
     OR (NEW.debit > 0 AND NEW.transaction_credit > 0)
     OR (NEW.credit > 0 AND NEW.transaction_debit > 0) THEN
    RAISE EXCEPTION 'USD bank journal line has inconsistent transaction/functional currency metadata'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_usd_bank_journal_line ON public.journal_entry_lines;
CREATE TRIGGER trg_validate_usd_bank_journal_line
BEFORE INSERT OR UPDATE OF account_id, debit, credit, transaction_currency,
  transaction_debit, transaction_credit, functional_currency, exchange_rate
ON public.journal_entry_lines
FOR EACH ROW EXECUTE FUNCTION public.validate_usd_bank_journal_line();

-- Keep exactly one ordinary expense-posting path.  The newer insert/update
-- pair calls auto_post_expense_accounting; the generic and old approval
-- triggers were a duplicate path.  Broker expenses use their dedicated
-- canonical broker poster.
DROP TRIGGER IF EXISTS trigger_auto_post_expense_accounting ON public.finance_expenses;
DROP TRIGGER IF EXISTS trigger_post_expense_on_approval ON public.finance_expenses;
DROP TRIGGER IF EXISTS trigger_auto_post_expense_accounting_insert ON public.finance_expenses;
DROP TRIGGER IF EXISTS trigger_auto_post_expense_accounting_update ON public.finance_expenses;
CREATE TRIGGER trigger_auto_post_expense_accounting_insert
AFTER INSERT ON public.finance_expenses
FOR EACH ROW WHEN (NEW.approval_status = 'approved'
  AND NEW.expense_category <> 'import_broker'
  AND COALESCE(current_setting('app.finance_historical_repair', true), 'off') <> 'on')
EXECUTE FUNCTION public.auto_post_expense_accounting();
CREATE TRIGGER trigger_auto_post_expense_accounting_update
AFTER UPDATE ON public.finance_expenses
FOR EACH ROW WHEN (NEW.approval_status = 'approved'
  AND NEW.expense_category <> 'import_broker'
  AND COALESCE(current_setting('app.finance_historical_repair', true), 'off') <> 'on'
  AND (OLD.approval_status IS DISTINCT FROM NEW.approval_status
    OR OLD.amount IS DISTINCT FROM NEW.amount
    OR OLD.expense_category IS DISTINCT FROM NEW.expense_category
    OR OLD.payment_method IS DISTINCT FROM NEW.payment_method
    OR OLD.bank_account_id IS DISTINCT FROM NEW.bank_account_id
    OR OLD.ppn_amount IS DISTINCT FROM NEW.ppn_amount
    OR OLD.pph_amount IS DISTINCT FROM NEW.pph_amount
    OR OLD.pph_code_id IS DISTINCT FROM NEW.pph_code_id
    OR OLD.stamp_duty_amount IS DISTINCT FROM NEW.stamp_duty_amount
    OR OLD.bank_charges_amount IS DISTINCT FROM NEW.bank_charges_amount
    OR OLD.fixed_asset_account_id IS DISTINCT FROM NEW.fixed_asset_account_id
    OR OLD.broker_items IS DISTINCT FROM NEW.broker_items
    OR OLD.description IS DISTINCT FROM NEW.description
    OR OLD.expense_date IS DISTINCT FROM NEW.expense_date))
EXECUTE FUNCTION public.auto_post_expense_accounting();

CREATE OR REPLACE FUNCTION public.prevent_unscoped_historical_repair_journal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.source_module = 'historical_repair'
     AND NOT public.historical_repair_context_active() THEN
    RAISE EXCEPTION 'Historical-repair journals require the guarded repair context';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_unscoped_historical_repair_journal ON public.journal_entries;
CREATE TRIGGER trg_prevent_unscoped_historical_repair_journal
BEFORE INSERT ON public.journal_entries
FOR EACH ROW EXECUTE FUNCTION public.prevent_unscoped_historical_repair_journal();

-- Include payment ownership in the legacy projection guard.  Canonical
-- allocations remain many-to-many; this only rejects conflicting legacy
-- matched_* ownership on one statement row.
CREATE OR REPLACE FUNCTION public.prevent_multiple_bank_line_document_owners()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF num_nonnulls(NEW.matched_expense_id, NEW.matched_receipt_id,
                  NEW.matched_payment_id, NEW.matched_petty_cash_id,
                  NEW.matched_fund_transfer_id, NEW.matched_tax_payment_id) > 1 THEN
    RAISE EXCEPTION 'Bank statement line % cannot be linked to more than one source document', NEW.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS prevent_multiple_bank_line_document_owners ON public.bank_statement_lines;
CREATE TRIGGER prevent_multiple_bank_line_document_owners
BEFORE INSERT OR UPDATE OF matched_expense_id, matched_receipt_id,
  matched_payment_id, matched_petty_cash_id, matched_fund_transfer_id,
  matched_tax_payment_id
ON public.bank_statement_lines
FOR EACH ROW EXECUTE FUNCTION public.prevent_multiple_bank_line_document_owners();

-- One canonical invocation of each legacy synchronization rule is enough.
DROP TRIGGER IF EXISTS trg_no_journal_only_bank_link ON public.bank_statement_lines;
DROP TRIGGER IF EXISTS z_bsl_sync_reconciliation_status ON public.bank_statement_lines;

-- Auto-matching must not run after any document owner has already been set.
DROP TRIGGER IF EXISTS trg_auto_match_bank_statement ON public.bank_statement_lines;
CREATE TRIGGER trg_auto_match_bank_statement
BEFORE INSERT OR UPDATE ON public.bank_statement_lines
FOR EACH ROW WHEN (
  NEW.matched_expense_id IS NULL
  AND NEW.matched_receipt_id IS NULL
  AND NEW.matched_payment_id IS NULL
  AND NEW.matched_petty_cash_id IS NULL
  AND NEW.matched_fund_transfer_id IS NULL
  AND NEW.matched_tax_payment_id IS NULL
  AND COALESCE(NEW.manually_unlinked, false) = false)
EXECUTE FUNCTION public.auto_match_bank_statement_line();

-- Historical repair commands are the supported audit boundary.  Emit a
-- standard insert audit action (the audit_logs table accepts only insert,
-- update, delete) without inventing a new action type.
CREATE OR REPLACE FUNCTION public.audit_historical_repair_command()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO public.audit_logs(table_name, action_type, record_id, old_values, new_values, user_id)
  VALUES ('finance_historical_repair_commands', 'insert', NEW.id, '{}'::jsonb,
          to_jsonb(NEW), NEW.requested_by);
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_audit_historical_repair_command ON public.finance_historical_repair_commands;
CREATE TRIGGER trg_audit_historical_repair_command
AFTER INSERT ON public.finance_historical_repair_commands
FOR EACH ROW EXECUTE FUNCTION public.audit_historical_repair_command();

COMMENT ON FUNCTION public.validate_bank_allocation_integrity() IS
  'Canonical bank allocation guard: active posted journal, currency/side validation, and no over-allocation.';
COMMENT ON FUNCTION public.prevent_active_fund_transfer_statement_reuse() IS
  'Prevents active fund transfers from reusing statement evidence owned by another active transfer; reversals release it.';
COMMENT ON FUNCTION public.validate_usd_bank_journal_line() IS
  'Requires mathematically consistent USD transaction and IDR functional metadata on USD bank COA lines.';

NOTIFY pgrst, 'reload schema';
COMMIT;
