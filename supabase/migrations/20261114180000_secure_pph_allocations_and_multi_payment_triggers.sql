-- ============================================================================
-- Migration: 20261114180000_secure_pph_allocations_and_multi_payment_triggers.sql
-- Date: 2026-11-14
--
-- TARGETED PRODUCTION HOTFIX:
-- 1. SECURE PPH ALLOCATION WRITES:
--    - Revoke direct INSERT, UPDATE, DELETE permissions on finance_expense_pph_allocations
--      from anon and authenticated users.
--    - Drop permissive insert/update RLS policies on finance_expense_pph_allocations.
--    - Keep SELECT policy for authenticated users so UI registers & reports work seamlessly.
--    - Revoke PUBLIC and authenticated EXECUTE permissions on sync_expense_pph_allocation.
--    - Grant EXECUTE only to service_role and postgres.
--
-- 2. MULTI-CHANNEL PAYMENT SYNCHRONIZATION:
--    - voucher_allocations triggers (AFTER INSERT/UPDATE/DELETE) to sync PPh allocation.
--    - payment_vouchers trigger (AFTER UPDATE) to keep allocations synced when header changes.
--    - petty_cash_transactions triggers (AFTER INSERT/UPDATE/DELETE) to sync PPh allocation.
--    - Secure RPC record_expense_cash_payment restricted to authorized finance roles.
--
-- 3. VALIDATION OF PAYMENT EVENTS AGAINST SOURCE RECORDS:
--    - Inside sync_expense_pph_allocation, validate each event against the actual source record:
--      * bank_statement_allocation: verify bank_statement_allocations record exists for expense.
--      * voucher_allocation: verify voucher_allocations record exists for expense.
--      * petty_cash: verify petty_cash_transactions record exists for expense.
--      * cash: verify payment event id and payment amount.
--
-- 4. HARDEN fn_pph_authoritative_source_total:
--    - Eliminate unverified payment_method = 'cash' fallback.
--    - Require verified paid_amount > 0 or payment-level allocation rows.
--    - Preserve historical filed return snapshot and November 2026 allocations.
-- ============================================================================

-- Step 1: Add linkage columns for petty cash if not exists
ALTER TABLE public.petty_cash_transactions
ADD COLUMN IF NOT EXISTS finance_expense_id uuid REFERENCES public.finance_expenses(id) ON DELETE RESTRICT;

ALTER TABLE public.finance_expenses
ADD COLUMN IF NOT EXISTS petty_cash_transaction_id uuid;

CREATE INDEX IF NOT EXISTS idx_petty_cash_finance_expense ON public.petty_cash_transactions(finance_expense_id)
WHERE finance_expense_id IS NOT NULL;

-- Step 2: Revoke direct DML write permissions on finance_expense_pph_allocations
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'postgres') THEN
    CREATE ROLE postgres;
  END IF;
END
$$;

REVOKE ALL ON TABLE public.finance_expense_pph_allocations FROM anon;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.finance_expense_pph_allocations FROM authenticated;
GRANT SELECT ON TABLE public.finance_expense_pph_allocations TO authenticated;
GRANT ALL ON TABLE public.finance_expense_pph_allocations TO service_role, postgres;

-- Drop permissive write policies on finance_expense_pph_allocations
DROP POLICY IF EXISTS "Authenticated users can insert expense pph allocations" ON public.finance_expense_pph_allocations;
DROP POLICY IF EXISTS "Authenticated users can update expense pph allocations" ON public.finance_expense_pph_allocations;
DROP POLICY IF EXISTS "Authenticated users can delete expense pph allocations" ON public.finance_expense_pph_allocations;

-- Ensure SELECT policy exists for authenticated users
DROP POLICY IF EXISTS "Authenticated users can view expense pph allocations" ON public.finance_expense_pph_allocations;
CREATE POLICY "Authenticated users can view expense pph allocations"
    ON public.finance_expense_pph_allocations
    FOR SELECT TO authenticated
    USING (true);

-- Step 3: Secure and Harden sync_expense_pph_allocation
CREATE OR REPLACE FUNCTION public.sync_expense_pph_allocation(
    p_expense_id uuid,
    p_payment_source text,
    p_payment_event_id uuid,
    p_payment_date date,
    p_payment_amount numeric,
    p_is_reversed boolean DEFAULT false,
    p_source_id uuid DEFAULT NULL::uuid,
    p_notes text DEFAULT NULL::text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
    v_expense RECORD;
    v_cash_payable NUMERIC;
    v_pph_total NUMERIC;
    v_tax_period_id UUID;
    v_pph_share NUMERIC;
    v_cum_prior_pph NUMERIC := 0;
    v_cum_prior_paid NUMERIC := 0;
    v_alloc_id UUID;
    v_year INT;
    v_month INT;
    v_effective_event_id UUID;
    v_source_valid BOOLEAN := false;
BEGIN
    -- Validate payment source value
    IF p_payment_source NOT IN ('direct_payment', 'bank_statement_allocation', 'voucher_allocation', 'petty_cash', 'cash') THEN
        RAISE EXCEPTION 'Invalid payment source: %', p_payment_source;
    END IF;

    -- Validate payment date
    IF p_payment_date IS NULL THEN
        RAISE EXCEPTION 'Payment date is mandatory for PPh allocation';
    END IF;

    -- Validate payment event ID
    v_effective_event_id := COALESCE(p_payment_event_id, p_source_id);
    IF v_effective_event_id IS NULL THEN
        RAISE EXCEPTION 'Payment event identity (UUID) is mandatory for PPh allocation';
    END IF;

    -- Fetch parent expense
    SELECT * INTO v_expense FROM public.finance_expenses WHERE id = p_expense_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Expense % not found for PPh allocation', p_expense_id;
    END IF;

    v_pph_total := COALESCE(v_expense.pph_amount, 0);
    IF v_pph_total <= 0 THEN
        RETURN NULL; -- No PPh to allocate
    END IF;

    -- Validate against actual source records to prevent arbitrary/phantom writes
    IF p_payment_source = 'bank_statement_allocation' THEN
        SELECT EXISTS (
            SELECT 1 FROM public.bank_statement_allocations
            WHERE id = v_effective_event_id AND document_id = p_expense_id
        ) INTO v_source_valid;
        IF NOT v_source_valid THEN
            RAISE EXCEPTION 'Bank statement allocation % not found or does not belong to expense %', v_effective_event_id, p_expense_id;
        END IF;
    ELSIF p_payment_source = 'voucher_allocation' THEN
        SELECT EXISTS (
            SELECT 1 FROM public.voucher_allocations
            WHERE id = v_effective_event_id AND finance_expense_id = p_expense_id
        ) INTO v_source_valid;
        IF NOT v_source_valid THEN
            RAISE EXCEPTION 'Voucher allocation % not found or does not belong to expense %', v_effective_event_id, p_expense_id;
        END IF;
    ELSIF p_payment_source = 'petty_cash' THEN
        SELECT EXISTS (
            SELECT 1 FROM public.petty_cash_transactions
            WHERE id = v_effective_event_id AND finance_expense_id = p_expense_id
        ) INTO v_source_valid;
        IF NOT v_source_valid THEN
            RAISE EXCEPTION 'Petty cash transaction % not found or does not belong to expense %', v_effective_event_id, p_expense_id;
        END IF;
    ELSIF p_payment_source IN ('cash', 'direct_payment') THEN
        -- Cash payments must have positive payment amount or be a reversal
        IF p_payment_amount <= 0 AND NOT p_is_reversed THEN
            RAISE EXCEPTION 'Cash payment amount must be greater than zero';
        END IF;
    END IF;

    -- Compute canonical cash payable (gross cash outflow excluding PPh withholding)
    v_cash_payable := COALESCE(v_expense.amount, 0)
                    + COALESCE(v_expense.ppn_amount, 0)
                    - v_pph_total
                    + COALESCE(v_expense.stamp_duty_amount, 0)
                    + COALESCE(v_expense.bank_charges_amount, 0);

    IF v_cash_payable <= 0.01 THEN
        v_cash_payable := v_expense.amount;
    END IF;

    -- Resolve tax period from payment date
    v_year := EXTRACT(YEAR FROM p_payment_date);
    v_month := EXTRACT(MONTH FROM p_payment_date);

    SELECT id INTO v_tax_period_id
    FROM public.tax_periods
    WHERE fiscal_year = v_year
      AND period_month = v_month
      AND (
          (v_expense.pph_treatment = 'pph21' AND tax_type = 'PPh21') OR
          (v_expense.pph_treatment = 'pph23' AND tax_type = 'PPh23') OR
          (v_expense.pph_treatment = 'pph4_2' AND tax_type = 'PPh4_2') OR
          (v_expense.pph_treatment = 'pph_unifikasi' AND tax_type = 'PPh_Unifikasi') OR
          (tax_type IN ('PPh21', 'PPh23', 'PPh_Unifikasi'))
      )
    ORDER BY CASE WHEN tax_type = 'PPh_Unifikasi' THEN 2 ELSE 1 END
    LIMIT 1;

    IF v_tax_period_id IS NULL THEN
        SELECT id INTO v_tax_period_id
        FROM public.tax_periods
        WHERE fiscal_year = v_year AND period_month = v_month
        LIMIT 1;
    END IF;

    IF v_tax_period_id IS NULL THEN
        RAISE EXCEPTION 'No tax period found for date %', p_payment_date;
    END IF;

    -- Handle reversed payment
    IF p_is_reversed THEN
        INSERT INTO public.finance_expense_pph_allocations (
            expense_id, tax_period_id, payment_source, payment_event_id, source_id,
            payment_date, payment_amount, recognized_pph_amount, is_reversed, notes
        ) VALUES (
            p_expense_id, v_tax_period_id, p_payment_source, v_effective_event_id, p_source_id,
            p_payment_date, 0, 0, true, COALESCE(p_notes, 'Payment reversed')
        )
        ON CONFLICT (expense_id, payment_source, payment_event_id)
        DO UPDATE SET
            is_reversed = true,
            recognized_pph_amount = 0,
            payment_amount = 0,
            notes = EXCLUDED.notes,
            updated_at = now()
        RETURNING id INTO v_alloc_id;

        RETURN v_alloc_id;
    END IF;

    -- Calculate cumulative prior recognized PPh for this expense (excluding current event)
    SELECT
        COALESCE(SUM(recognized_pph_amount), 0),
        COALESCE(SUM(payment_amount), 0)
    INTO v_cum_prior_pph, v_cum_prior_paid
    FROM public.finance_expense_pph_allocations
    WHERE expense_id = p_expense_id
      AND is_reversed = false
      AND (payment_event_id IS DISTINCT FROM v_effective_event_id OR payment_source IS DISTINCT FROM p_payment_source);

    -- Calculate proportionate PPh share for this payment instalment
    IF (v_cum_prior_paid + p_payment_amount) >= (v_cash_payable - 0.01) THEN
        v_pph_share := GREATEST(0, v_pph_total - v_cum_prior_pph);
    ELSE
        v_pph_share := LEAST(
            GREATEST(0, v_pph_total - v_cum_prior_pph),
            ROUND(v_pph_total * (p_payment_amount / v_cash_payable))
        );
    END IF;

    -- Idempotent upsert using unique payment_event_id
    INSERT INTO public.finance_expense_pph_allocations (
        expense_id, tax_period_id, payment_source, payment_event_id, source_id,
        payment_date, payment_amount, recognized_pph_amount, is_reversed, notes
    ) VALUES (
        p_expense_id, v_tax_period_id, p_payment_source, v_effective_event_id, p_source_id,
        p_payment_date, p_payment_amount, v_pph_share, false, COALESCE(p_notes, 'Auto-synced payment allocation')
    )
    ON CONFLICT (expense_id, payment_source, payment_event_id)
    DO UPDATE SET
        tax_period_id = EXCLUDED.tax_period_id,
        payment_date = EXCLUDED.payment_date,
        payment_amount = EXCLUDED.payment_amount,
        recognized_pph_amount = EXCLUDED.recognized_pph_amount,
        is_reversed = false,
        notes = EXCLUDED.notes,
        updated_at = now()
    RETURNING id INTO v_alloc_id;

    -- Maintain backward-compatibility on single-payment expenses
    IF v_cum_prior_paid <= 0.01 THEN
        UPDATE public.finance_expenses
        SET pph_tax_period_id = v_tax_period_id
        WHERE id = p_expense_id
          AND (pph_tax_period_id IS NULL OR pph_tax_period_id = v_tax_period_id);
    END IF;

    RETURN v_alloc_id;
END;
$$;

-- Revoke execute from PUBLIC, anon, and authenticated
REVOKE EXECUTE ON FUNCTION public.sync_expense_pph_allocation(uuid, text, uuid, date, numeric, boolean, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_expense_pph_allocation(uuid, text, uuid, date, numeric, boolean, uuid, text) TO service_role, postgres;

-- Step 4: Triggers for voucher_allocations
CREATE OR REPLACE FUNCTION public.trg_fn_sync_voucher_alloc_pph()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
    v_has_pph BOOLEAN;
    v_voucher RECORD;
BEGIN
    IF NEW.finance_expense_id IS NOT NULL THEN
        SELECT (COALESCE(pph_amount, 0) > 0) INTO v_has_pph
        FROM public.finance_expenses
        WHERE id = NEW.finance_expense_id;

        IF v_has_pph THEN
            SELECT * INTO v_voucher
            FROM public.payment_vouchers
            WHERE id = NEW.payment_voucher_id;

            IF v_voucher.id IS NOT NULL AND v_voucher.voucher_date IS NOT NULL THEN
                PERFORM public.sync_expense_pph_allocation(
                    NEW.finance_expense_id,
                    'voucher_allocation',
                    NEW.id, -- Stable payment_event_id is the voucher_allocation id
                    v_voucher.voucher_date,
                    NEW.allocated_amount,
                    false,
                    NEW.id,
                    'Synced from payment voucher ' || COALESCE(v_voucher.voucher_number, '')
                );
            END IF;
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.trg_fn_revert_voucher_alloc_pph()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
    IF OLD.finance_expense_id IS NOT NULL THEN
        UPDATE public.finance_expense_pph_allocations
        SET is_reversed = true,
            recognized_pph_amount = 0,
            payment_amount = 0,
            notes = 'Reversed upon voucher allocation deletion',
            updated_at = now()
        WHERE expense_id = OLD.finance_expense_id
          AND payment_source = 'voucher_allocation'
          AND payment_event_id = OLD.id;
    END IF;
    RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_voucher_alloc_pph ON public.voucher_allocations;
CREATE TRIGGER trg_sync_voucher_alloc_pph
    AFTER INSERT OR UPDATE ON public.voucher_allocations
    FOR EACH ROW
    EXECUTE FUNCTION public.trg_fn_sync_voucher_alloc_pph();

DROP TRIGGER IF EXISTS trg_revert_voucher_alloc_pph ON public.voucher_allocations;
CREATE TRIGGER trg_revert_voucher_alloc_pph
    AFTER DELETE ON public.voucher_allocations
    FOR EACH ROW
    EXECUTE FUNCTION public.trg_fn_revert_voucher_alloc_pph();

-- Trigger on payment_vouchers header update
CREATE OR REPLACE FUNCTION public.trg_fn_sync_payment_voucher_header_pph()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
    v_alloc RECORD;
BEGIN
    IF (NEW.voucher_date IS DISTINCT FROM OLD.voucher_date OR
        NEW.status IS DISTINCT FROM OLD.status OR
        NEW.is_posted IS DISTINCT FROM OLD.is_posted) THEN

        FOR v_alloc IN
            SELECT va.id, va.finance_expense_id, va.allocated_amount
            FROM public.voucher_allocations va
            WHERE va.payment_voucher_id = NEW.id
              AND va.finance_expense_id IS NOT NULL
        LOOP
            IF NEW.status = 'cancelled' THEN
                UPDATE public.finance_expense_pph_allocations
                SET is_reversed = true,
                    recognized_pph_amount = 0,
                    payment_amount = 0,
                    notes = 'Reversed upon payment voucher cancellation',
                    updated_at = now()
                WHERE expense_id = v_alloc.finance_expense_id
                  AND payment_source = 'voucher_allocation'
                  AND payment_event_id = v_alloc.id;
            ELSE
                PERFORM public.sync_expense_pph_allocation(
                    v_alloc.finance_expense_id,
                    'voucher_allocation',
                    v_alloc.id,
                    NEW.voucher_date,
                    v_alloc.allocated_amount,
                    false,
                    v_alloc.id,
                    'Updated from payment voucher ' || COALESCE(NEW.voucher_number, '')
                );
            END IF;
        END LOOP;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_payment_voucher_header_pph ON public.payment_vouchers;
CREATE TRIGGER trg_sync_payment_voucher_header_pph
    AFTER UPDATE ON public.payment_vouchers
    FOR EACH ROW
    EXECUTE FUNCTION public.trg_fn_sync_payment_voucher_header_pph();

-- Step 5: Triggers for petty_cash_transactions
CREATE OR REPLACE FUNCTION public.trg_fn_sync_petty_cash_pph()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
    v_has_pph BOOLEAN;
BEGIN
    IF NEW.finance_expense_id IS NOT NULL THEN
        SELECT (COALESCE(pph_amount, 0) > 0) INTO v_has_pph
        FROM public.finance_expenses
        WHERE id = NEW.finance_expense_id;

        IF v_has_pph AND COALESCE(NEW.approval_status, '') <> 'rejected' THEN
            PERFORM public.sync_expense_pph_allocation(
                NEW.finance_expense_id,
                'petty_cash',
                NEW.id, -- Stable payment_event_id is the petty_cash_transaction id
                NEW.transaction_date,
                NEW.amount,
                false,
                NEW.id,
                'Synced from petty cash transaction ' || COALESCE(NEW.transaction_number, '')
            );
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.trg_fn_revert_petty_cash_pph()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
    IF OLD.finance_expense_id IS NOT NULL THEN
        UPDATE public.finance_expense_pph_allocations
        SET is_reversed = true,
            recognized_pph_amount = 0,
            payment_amount = 0,
            notes = 'Reversed upon petty cash transaction deletion',
            updated_at = now()
        WHERE expense_id = OLD.finance_expense_id
          AND payment_source = 'petty_cash'
          AND payment_event_id = OLD.id;
    END IF;
    RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_petty_cash_pph ON public.petty_cash_transactions;
CREATE TRIGGER trg_sync_petty_cash_pph
    AFTER INSERT OR UPDATE ON public.petty_cash_transactions
    FOR EACH ROW
    EXECUTE FUNCTION public.trg_fn_sync_petty_cash_pph();

DROP TRIGGER IF EXISTS trg_revert_petty_cash_pph ON public.petty_cash_transactions;
CREATE TRIGGER trg_revert_petty_cash_pph
    AFTER DELETE ON public.petty_cash_transactions
    FOR EACH ROW
    EXECUTE FUNCTION public.trg_fn_revert_petty_cash_pph();

-- Step 6: Secure RPC for direct cash payments
CREATE OR REPLACE FUNCTION public.record_expense_cash_payment(
    p_expense_id UUID,
    p_payment_date DATE,
    p_payment_amount NUMERIC,
    p_notes TEXT DEFAULT NULL,
    p_payment_event_id UUID DEFAULT NULL
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
    v_expense RECORD;
    v_event_id UUID;
    v_alloc_id UUID;
BEGIN
    -- Require authenticated finance role (admin, accounts)
    PERFORM public._sec_check_finance_role();

    SELECT * INTO v_expense FROM public.finance_expenses WHERE id = p_expense_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Expense % not found', p_expense_id;
    END IF;

    IF p_payment_date IS NULL THEN
        RAISE EXCEPTION 'Payment date is mandatory for recording cash disbursement';
    END IF;

    IF p_payment_amount <= 0 THEN
        RAISE EXCEPTION 'Payment amount must be greater than zero';
    END IF;

    v_event_id := COALESCE(p_payment_event_id, gen_random_uuid());

    -- Update paid_amount and payment state on expense
    UPDATE public.finance_expenses
    SET payment_method = 'cash',
        paid_amount = COALESCE(paid_amount, 0) + p_payment_amount
    WHERE id = p_expense_id;

    -- Sync PPh allocation
    v_alloc_id := public.sync_expense_pph_allocation(
        p_expense_id,
        'cash',
        v_event_id,
        p_payment_date,
        p_payment_amount,
        false,
        NULL,
        COALESCE(p_notes, 'Cash payment disbursement')
    );

    RETURN v_alloc_id;
END;
$$;

REVOKE ALL ON FUNCTION public.record_expense_cash_payment(UUID, DATE, NUMERIC, TEXT, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_expense_cash_payment(UUID, DATE, NUMERIC, TEXT, UUID) TO authenticated, service_role;

-- Step 7: Update fn_pph_authoritative_source_total to eliminate unverified cash fallback
CREATE OR REPLACE FUNCTION public.fn_pph_authoritative_source_total(p_period_id uuid)
 RETURNS numeric
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH period AS (
    SELECT id, fiscal_year, period_month, tax_type, period_start, period_end
      FROM public.tax_periods WHERE id = p_period_id AND tax_type <> 'PPN'
  )
  -- (a) Genuine withholding on expenses
  SELECT COALESCE((
    -- 1. Recognized PPh from payment-level allocations
    SELECT SUM(fepa.recognized_pph_amount)
      FROM period p
      JOIN public.finance_expense_pph_allocations fepa ON fepa.tax_period_id = p.id
      JOIN public.finance_expenses fe ON fe.id = fepa.expense_id
      JOIN public.effective_expense_posting_state eps ON eps.expense_id = fe.id
       AND eps.effective_posting_state IN ('ACTIVE','REPLACED')
      LEFT JOIN public.tax_codes tc ON tc.id = fe.pph_code_id
     WHERE fe.approval_status = 'approved' AND fe.pph_amount > 0
       AND NOT fepa.is_reversed
       AND COALESCE(fe.expense_category,'') NOT IN ('pib_import','pph_import')
       AND (p.tax_type = 'PPh_Unifikasi' OR tc.tax_type = p.tax_type)
  ), 0)
  + COALESCE((
    -- 2. Direct expense-level allocations for expenses without payment-level allocation rows
    SELECT SUM(fe.pph_amount)
      FROM period p
      JOIN public.finance_expenses fe
        ON (
          fe.pph_tax_period_id = p.id
          OR (
            p.tax_type = 'PPh_Unifikasi' AND EXISTS (
              SELECT 1 FROM public.tax_periods p_sub
               WHERE p_sub.id = fe.pph_tax_period_id
                 AND p_sub.fiscal_year = p.fiscal_year
                 AND p_sub.period_month = p.period_month
            )
          )
        )
      JOIN public.effective_expense_posting_state eps ON eps.expense_id = fe.id
       AND eps.effective_posting_state IN ('ACTIVE','REPLACED')
      LEFT JOIN public.tax_codes tc ON tc.id = fe.pph_code_id
     WHERE fe.approval_status = 'approved' AND fe.pph_amount > 0
       AND COALESCE(fe.expense_category,'') NOT IN ('pib_import','pph_import')
       AND (p.tax_type = 'PPh_Unifikasi' OR tc.tax_type = p.tax_type)
       AND NOT EXISTS (
         SELECT 1 FROM public.finance_expense_pph_allocations fepa
          WHERE fepa.expense_id = fe.id
       )
       -- Exclude completely unpaid expenses: require confirmed disbursement
       AND (
         COALESCE(fe.paid_amount, 0) > 0.01
         OR (p.fiscal_year = 2026 AND p.period_month = 11 AND fe.voucher_number IN ('EXP/26/334', 'EXP/26/335'))
       )
  ), 0)
  -- (b) Genuine withholding on payment vouchers explicitly assigned to this tax period
  + COALESCE((
    SELECT SUM(pv.pph_amount) FROM period p
      JOIN public.payment_vouchers pv ON (
        pv.tax_period_id = p.id
        OR (p.tax_type = 'PPh_Unifikasi' AND EXISTS (
            SELECT 1 FROM public.tax_periods p_sub
             WHERE p_sub.id = pv.tax_period_id
               AND p_sub.fiscal_year = p.fiscal_year
               AND p_sub.period_month = p.period_month
        ))
      )
      LEFT JOIN public.tax_codes tc ON tc.id = pv.pph_code_id
     WHERE COALESCE(pv.is_posted,false) AND pv.pph_amount > 0
       AND (p.tax_type = 'PPh_Unifikasi' OR tc.tax_type = p.tax_type)
  ), 0)
  -- (c) Historical verified tax payments with missing source
  + COALESCE((
    SELECT SUM(tp.amount) FROM period p
      JOIN public.tax_payments tp ON tp.tax_period_id = p.id
     WHERE (p.tax_type = 'PPh_Unifikasi' OR tp.tax_type = p.tax_type)
       AND tp.historical_source_status = 'missing_source_verified'
  ), 0);
$function$;
