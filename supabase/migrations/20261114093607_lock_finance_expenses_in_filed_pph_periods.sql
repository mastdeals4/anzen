-- ============================================================================
-- Migration: 20261114150000_lock_finance_expenses_in_filed_pph_periods.sql
-- Description:
--   Refines the row-level lock trigger enforce_tax_period_lock:
--   1. Protects expenses assigned to filed PPh tax periods (pph_tax_period_id)
--      as well as general tax periods (tax_period_id).
--   2. Blocks all tax-affecting changes (amount, pph_amount, pph_code_id,
--      pph_tax_period_id, pph_treatment, ppn_amount, deletion, reassigning).
--   3. Permits harmless non-tax metadata updates (description, notes,
--      document_urls, payment_reference, batch_id).
--   4. Recognizes filing_status = 'filed', status IN ('filed', 'closed'),
--      or filed_at IS NOT NULL as locked states.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.enforce_tax_period_lock()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_is_locked boolean;
BEGIN
  -- Service role bypass for authorized migrations/seeds
  IF (current_setting('request.jwt.claim.role', true) = 'service_role') THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- ========================================================================
  -- 1. DELETE OPERATIONS
  -- ========================================================================
  IF TG_OP = 'DELETE' THEN
    -- Check general tax_period_id
    IF OLD.tax_period_id IS NOT NULL THEN
      SELECT (filing_status = 'filed' OR status IN ('filed', 'closed') OR filed_at IS NOT NULL)
        INTO v_is_locked
        FROM public.tax_periods WHERE id = OLD.tax_period_id;
      IF v_is_locked IS TRUE THEN
        RAISE EXCEPTION 'Tax period % is filed/closed; cannot delete records from it', OLD.tax_period_id
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;

    -- Check PPh tax period on finance_expenses
    IF TG_TABLE_NAME = 'finance_expenses' AND OLD.pph_tax_period_id IS NOT NULL THEN
      SELECT (filing_status = 'filed' OR status IN ('filed', 'closed') OR filed_at IS NOT NULL)
        INTO v_is_locked
        FROM public.tax_periods WHERE id = OLD.pph_tax_period_id;
      IF v_is_locked IS TRUE THEN
        RAISE EXCEPTION 'PPh tax period % is filed/closed; cannot delete records from it', OLD.pph_tax_period_id
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;

    RETURN OLD;
  END IF;

  -- ========================================================================
  -- 2. INSERT OPERATIONS
  -- ========================================================================
  IF TG_OP = 'INSERT' THEN
    IF NEW.tax_period_id IS NOT NULL THEN
      SELECT (filing_status = 'filed' OR status IN ('filed', 'closed') OR filed_at IS NOT NULL)
        INTO v_is_locked
        FROM public.tax_periods WHERE id = NEW.tax_period_id;
      IF v_is_locked IS TRUE THEN
        RAISE EXCEPTION 'Tax period % is filed/closed; cannot assign new rows to it', NEW.tax_period_id
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;

    IF TG_TABLE_NAME = 'finance_expenses' AND NEW.pph_tax_period_id IS NOT NULL THEN
      SELECT (filing_status = 'filed' OR status IN ('filed', 'closed') OR filed_at IS NOT NULL)
        INTO v_is_locked
        FROM public.tax_periods WHERE id = NEW.pph_tax_period_id;
      IF v_is_locked IS TRUE THEN
        RAISE EXCEPTION 'PPh tax period % is filed/closed; cannot assign new rows to it', NEW.pph_tax_period_id
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;

    RETURN NEW;
  END IF;

  -- ========================================================================
  -- 3. UPDATE OPERATIONS
  -- ========================================================================
  IF TG_OP = 'UPDATE' THEN
    IF TG_TABLE_NAME = 'finance_expenses' THEN
      -- Determine if the expense currently belongs to a locked period
      v_is_locked := false;
      IF OLD.tax_period_id IS NOT NULL THEN
        SELECT (filing_status = 'filed' OR status IN ('filed', 'closed') OR filed_at IS NOT NULL)
          INTO v_is_locked
          FROM public.tax_periods WHERE id = OLD.tax_period_id;
      END IF;

      IF (v_is_locked IS NOT TRUE) AND OLD.pph_tax_period_id IS NOT NULL THEN
        SELECT (filing_status = 'filed' OR status IN ('filed', 'closed') OR filed_at IS NOT NULL)
          INTO v_is_locked
          FROM public.tax_periods WHERE id = OLD.pph_tax_period_id;
      END IF;

      IF v_is_locked IS TRUE THEN
        -- If old period is locked, BLOCK any tax-affecting changes:
        IF (
          NEW.amount IS DISTINCT FROM OLD.amount OR
          NEW.pph_amount IS DISTINCT FROM OLD.pph_amount OR
          NEW.pph_code_id IS DISTINCT FROM OLD.pph_code_id OR
          NEW.pph_tax_period_id IS DISTINCT FROM OLD.pph_tax_period_id OR
          NEW.pph_treatment IS DISTINCT FROM OLD.pph_treatment OR
          NEW.ppn_amount IS DISTINCT FROM OLD.ppn_amount OR
          NEW.pib_pph_amount IS DISTINCT FROM OLD.pib_pph_amount OR
          NEW.pib_ppn_amount IS DISTINCT FROM OLD.pib_ppn_amount OR
          NEW.tax_period_id IS DISTINCT FROM OLD.tax_period_id OR
          NEW.expense_date IS DISTINCT FROM OLD.expense_date OR
          NEW.due_date IS DISTINCT FROM OLD.due_date OR
          NEW.approval_status IS DISTINCT FROM OLD.approval_status OR
          NEW.paid_amount IS DISTINCT FROM OLD.paid_amount
        ) THEN
          RAISE EXCEPTION 'Expense % belongs to a filed/closed tax period; tax-affecting modifications and period reassignments are blocked',
            OLD.voucher_number
            USING ERRCODE = 'check_violation';
        END IF;

        -- Non-tax metadata edits (description, notes, document_urls, payment_reference, batch_id, etc.)
        -- are safely allowed through.
      END IF;

      -- Prevent reassigning an expense into a locked period
      IF NEW.tax_period_id IS DISTINCT FROM OLD.tax_period_id AND NEW.tax_period_id IS NOT NULL THEN
        SELECT (filing_status = 'filed' OR status IN ('filed', 'closed') OR filed_at IS NOT NULL)
          INTO v_is_locked
          FROM public.tax_periods WHERE id = NEW.tax_period_id;
        IF v_is_locked IS TRUE THEN
          RAISE EXCEPTION 'Cannot reassign expense to filed/closed tax period %', NEW.tax_period_id
            USING ERRCODE = 'check_violation';
        END IF;
      END IF;

      IF NEW.pph_tax_period_id IS DISTINCT FROM OLD.pph_tax_period_id AND NEW.pph_tax_period_id IS NOT NULL THEN
        SELECT (filing_status = 'filed' OR status IN ('filed', 'closed') OR filed_at IS NOT NULL)
          INTO v_is_locked
          FROM public.tax_periods WHERE id = NEW.pph_tax_period_id;
        IF v_is_locked IS TRUE THEN
          RAISE EXCEPTION 'Cannot reassign expense to filed/closed PPh tax period %', NEW.pph_tax_period_id
            USING ERRCODE = 'check_violation';
        END IF;
      END IF;

    ELSE
      -- Generic check for other tables (faktur_pajak, purchase_invoices, sales_invoices, payment_vouchers, tax_payments)
      IF OLD.tax_period_id IS NOT NULL THEN
        SELECT (filing_status = 'filed' OR status IN ('filed', 'closed') OR filed_at IS NOT NULL)
          INTO v_is_locked
          FROM public.tax_periods WHERE id = OLD.tax_period_id;
        IF v_is_locked IS TRUE THEN
          RAISE EXCEPTION 'Tax period % is filed/closed; cannot modify % on %',
            OLD.tax_period_id, TG_OP, TG_TABLE_NAME
            USING ERRCODE = 'check_violation';
        END IF;
      END IF;

      IF NEW.tax_period_id IS NOT NULL AND NEW.tax_period_id IS DISTINCT FROM OLD.tax_period_id THEN
        SELECT (filing_status = 'filed' OR status IN ('filed', 'closed') OR filed_at IS NOT NULL)
          INTO v_is_locked
          FROM public.tax_periods WHERE id = NEW.tax_period_id;
        IF v_is_locked IS TRUE THEN
          RAISE EXCEPTION 'Tax period % is filed/closed; cannot assign rows to it', NEW.tax_period_id
            USING ERRCODE = 'check_violation';
        END IF;
      END IF;
    END IF;

    RETURN NEW;
  END IF;

  RETURN COALESCE(NEW, OLD);
END $$;

GRANT EXECUTE ON FUNCTION public.enforce_tax_period_lock() TO authenticated, service_role;

COMMIT;

