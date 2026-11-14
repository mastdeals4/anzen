-- ============================================================================
-- Migration: 20261114170000_multi_period_pph_allocations_and_cash_strictness.sql
-- Date: 2026-11-14
--
-- 1. Multi-Period PPh Allocation:
--    Supports one expense paid through multiple partial instalments in different months.
--    Recognizes PPh proportionately in each payment month without assigning the entire
--    PPh to one month or moving previous months' recognized withholding.
--
-- 2. Audit History & Deletion Protection:
--    Uses ON DELETE RESTRICT so that an expense cannot be deleted while
--    payment-level tax allocations exist. Reversals must be explicit and auditable.
--
-- 3. Stable Unique Payment-Event Identity:
--    Uses payment_event_id UUID NOT NULL.
--    - For bank allocations: payment_event_id is the bank_statement_allocations.id
--    - For voucher allocations: payment_event_id is the voucher_allocations.id
--    - For petty cash: payment_event_id is the petty_cash_transactions.id
--    - For cash / direct payments: payment_event_id is a persisted unique payment event UUID.
--    - Two cash payments on the same day receive distinct payment_event_ids.
--    - A retried payment reuses the same payment_event_id.
--    Constraint: UNIQUE (expense_id, payment_source, payment_event_id).
--
-- 4. Filed-Period Protection & Server-Authorized Amendment:
--    Row-level trigger enforce_pph_allocation_period_lock blocks any unauthorized
--    INSERT, UPDATE, DELETE, or reversal affecting a filed/closed tax period.
--    Overrides require a server-authorized administrative record in
--    public.tax_period_amendment_authorizations with reason and expiry.
-- ============================================================================

-- Step 1: Create administrative amendment authorizations table
CREATE TABLE IF NOT EXISTS public.tax_period_amendment_authorizations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tax_period_id UUID NOT NULL REFERENCES public.tax_periods(id) ON DELETE CASCADE,
    authorized_by UUID NOT NULL,
    reason TEXT NOT NULL,
    approved_at TIMESTAMPTZ DEFAULT now() NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    is_consumed BOOLEAN DEFAULT false NOT NULL,
    consumed_at TIMESTAMPTZ,
    notes JSONB
);

CREATE INDEX IF NOT EXISTS idx_tax_period_amendment_lookup
ON public.tax_period_amendment_authorizations (tax_period_id, expires_at, is_consumed);

-- Enable RLS
ALTER TABLE public.tax_period_amendment_authorizations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can manage tax period amendments" ON public.tax_period_amendment_authorizations;
CREATE POLICY "Admins can manage tax period amendments"
ON public.tax_period_amendment_authorizations
FOR ALL TO authenticated
USING (
    EXISTS (
        SELECT 1 FROM public.user_profiles up
        WHERE up.id = auth.uid() AND up.role IN ('admin', 'super_admin')
    ) OR (current_setting('request.jwt.claim.role', true) = 'service_role')
);

-- Admin authorization RPC
CREATE OR REPLACE FUNCTION public.authorize_tax_period_amendment(
    p_tax_period_id UUID,
    p_reason TEXT,
    p_duration_minutes INT DEFAULT 15
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
    v_auth_id UUID;
    v_is_admin BOOLEAN := false;
BEGIN
    -- Verify administrator privilege
    IF (current_setting('request.jwt.claim.role', true) = 'service_role') THEN
        v_is_admin := true;
    ELSIF auth.uid() IS NOT NULL THEN
        SELECT EXISTS (
            SELECT 1 FROM public.user_profiles up
            WHERE up.id = auth.uid() AND up.role IN ('admin', 'super_admin')
        ) INTO v_is_admin;
    END IF;

    IF NOT v_is_admin THEN
        RAISE EXCEPTION 'Unauthorized: Only system administrators can authorize amendments to filed tax periods.'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF TRIM(COALESCE(p_reason, '')) = '' THEN
        RAISE EXCEPTION 'An explicit justification reason is required to authorize a tax period amendment.'
            USING ERRCODE = 'check_violation';
    END IF;

    INSERT INTO public.tax_period_amendment_authorizations (
        tax_period_id, authorized_by, reason, expires_at
    ) VALUES (
        p_tax_period_id,
        COALESCE(auth.uid(), '00000000-0000-0000-0000-000000000000'::uuid),
        p_reason,
        now() + (GREATEST(1, LEAST(120, p_duration_minutes)) || ' minutes')::interval
    ) RETURNING id INTO v_auth_id;

    RETURN v_auth_id;
END;
$$;

-- Step 2: Create finance_expense_pph_allocations table
CREATE TABLE IF NOT EXISTS public.finance_expense_pph_allocations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    expense_id UUID NOT NULL REFERENCES public.finance_expenses(id) ON DELETE RESTRICT,
    tax_period_id UUID NOT NULL REFERENCES public.tax_periods(id) ON DELETE RESTRICT,
    payment_source TEXT NOT NULL CHECK (payment_source IN ('direct_payment', 'bank_statement_allocation', 'voucher_allocation', 'petty_cash', 'cash')),
    payment_event_id UUID NOT NULL DEFAULT gen_random_uuid(),
    source_id UUID,
    payment_date DATE NOT NULL,
    payment_amount NUMERIC(18,2) NOT NULL,
    recognized_pph_amount NUMERIC(18,2) NOT NULL,
    is_reversed BOOLEAN DEFAULT false NOT NULL,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT now() NOT NULL,
    CONSTRAINT uq_expense_pph_alloc_event UNIQUE (expense_id, payment_source, payment_event_id)
);

CREATE INDEX IF NOT EXISTS idx_fe_pph_alloc_expense ON public.finance_expense_pph_allocations(expense_id);
CREATE INDEX IF NOT EXISTS idx_fe_pph_alloc_period ON public.finance_expense_pph_allocations(tax_period_id);
CREATE INDEX IF NOT EXISTS idx_fe_pph_alloc_date ON public.finance_expense_pph_allocations(payment_date);

-- Enable RLS
ALTER TABLE public.finance_expense_pph_allocations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated users can view expense pph allocations" ON public.finance_expense_pph_allocations;
CREATE POLICY "Authenticated users can view expense pph allocations"
    ON public.finance_expense_pph_allocations
    FOR SELECT TO authenticated
    USING (true);

DROP POLICY IF EXISTS "Authenticated users can insert expense pph allocations" ON public.finance_expense_pph_allocations;
CREATE POLICY "Authenticated users can insert expense pph allocations"
    ON public.finance_expense_pph_allocations
    FOR INSERT TO authenticated
    WITH CHECK (true);

DROP POLICY IF EXISTS "Authenticated users can update expense pph allocations" ON public.finance_expense_pph_allocations;
CREATE POLICY "Authenticated users can update expense pph allocations"
    ON public.finance_expense_pph_allocations
    FOR UPDATE TO authenticated
    USING (true)
    WITH CHECK (true);

-- Step 3: Filed-period protection on finance_expense_pph_allocations
CREATE OR REPLACE FUNCTION public.enforce_pph_allocation_period_lock()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
    v_is_locked boolean := false;
    v_amendment_id UUID;
BEGIN
    -- Service role bypass for authorized migrations/seeds
    IF (current_setting('request.jwt.claim.role', true) = 'service_role') THEN
        RETURN COALESCE(NEW, OLD);
    END IF;

    -- 1. DELETE OPERATIONS
    IF TG_OP = 'DELETE' THEN
        SELECT (filing_status = 'filed' OR status IN ('filed', 'closed') OR filed_at IS NOT NULL)
        INTO v_is_locked
        FROM public.tax_periods
        WHERE id = OLD.tax_period_id;

        IF v_is_locked IS TRUE THEN
            -- Check for active administrator amendment authorization
            SELECT id INTO v_amendment_id
            FROM public.tax_period_amendment_authorizations
            WHERE tax_period_id = OLD.tax_period_id
              AND expires_at > now()
              AND is_consumed = false
            LIMIT 1;

            IF v_amendment_id IS NOT NULL THEN
                UPDATE public.tax_period_amendment_authorizations
                SET is_consumed = true, consumed_at = now()
                WHERE id = v_amendment_id;
                RETURN OLD;
            END IF;

            RAISE EXCEPTION 'PPh tax period % is filed/closed; physical deletion of tax allocations is prohibited. Use an audited reversal or authorized amendment instead.', OLD.tax_period_id
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN OLD;
    END IF;

    -- 2. INSERT OPERATIONS
    IF TG_OP = 'INSERT' THEN
        SELECT (filing_status = 'filed' OR status IN ('filed', 'closed') OR filed_at IS NOT NULL)
        INTO v_is_locked
        FROM public.tax_periods
        WHERE id = NEW.tax_period_id;

        IF v_is_locked IS TRUE THEN
            -- Check for active administrator amendment authorization
            SELECT id INTO v_amendment_id
            FROM public.tax_period_amendment_authorizations
            WHERE tax_period_id = NEW.tax_period_id
              AND expires_at > now()
              AND is_consumed = false
            LIMIT 1;

            IF v_amendment_id IS NOT NULL THEN
                UPDATE public.tax_period_amendment_authorizations
                SET is_consumed = true, consumed_at = now()
                WHERE id = v_amendment_id;
                RETURN NEW;
            END IF;

            RAISE EXCEPTION 'PPh tax period % is filed/closed; cannot assign new PPh allocations to it.', NEW.tax_period_id
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
    END IF;

    -- 3. UPDATE OPERATIONS
    IF TG_OP = 'UPDATE' THEN
        -- Identity immutability: expense_id and payment_event_id can NEVER be reassigned to another expense/event
        IF (NEW.expense_id IS DISTINCT FROM OLD.expense_id) THEN
            RAISE EXCEPTION 'Cannot modify expense identity (expense_id) on an existing PPh allocation.'
                USING ERRCODE = 'check_violation';
        END IF;

        IF (NEW.payment_source IS DISTINCT FROM OLD.payment_source OR NEW.payment_event_id IS DISTINCT FROM OLD.payment_event_id) THEN
            RAISE EXCEPTION 'Cannot modify payment event identity on an existing PPh allocation.'
                USING ERRCODE = 'check_violation';
        END IF;

        -- Check if current period (OLD) is filed/closed
        SELECT (filing_status = 'filed' OR status IN ('filed', 'closed') OR filed_at IS NOT NULL)
        INTO v_is_locked
        FROM public.tax_periods
        WHERE id = OLD.tax_period_id;

        IF v_is_locked IS TRUE THEN
            -- Check if any protected field changed
            IF (NEW.tax_period_id IS DISTINCT FROM OLD.tax_period_id OR
                NEW.expense_id IS DISTINCT FROM OLD.expense_id OR
                NEW.payment_source IS DISTINCT FROM OLD.payment_source OR
                NEW.payment_event_id IS DISTINCT FROM OLD.payment_event_id OR
                NEW.source_id IS DISTINCT FROM OLD.source_id OR
                NEW.payment_date IS DISTINCT FROM OLD.payment_date OR
                NEW.payment_amount IS DISTINCT FROM OLD.payment_amount OR
                NEW.recognized_pph_amount IS DISTINCT FROM OLD.recognized_pph_amount OR
                NEW.is_reversed IS DISTINCT FROM OLD.is_reversed) THEN

                -- Check for active administrator amendment authorization
                SELECT id INTO v_amendment_id
                FROM public.tax_period_amendment_authorizations
                WHERE tax_period_id = OLD.tax_period_id
                  AND expires_at > now()
                  AND is_consumed = false
                LIMIT 1;

                IF v_amendment_id IS NOT NULL THEN
                    UPDATE public.tax_period_amendment_authorizations
                    SET is_consumed = true, consumed_at = now()
                    WHERE id = v_amendment_id;
                    RETURN NEW;
                END IF;

                IF (NEW.tax_period_id IS DISTINCT FROM OLD.tax_period_id) THEN
                    RAISE EXCEPTION 'PPh tax period % is filed/closed; cannot reassign allocations out of a filed period.', OLD.tax_period_id
                        USING ERRCODE = 'check_violation';
                ELSIF (NEW.expense_id IS DISTINCT FROM OLD.expense_id) THEN
                    RAISE EXCEPTION 'PPh tax period % is filed/closed; cannot reassign allocation to another expense.', OLD.tax_period_id
                        USING ERRCODE = 'check_violation';
                ELSE
                    RAISE EXCEPTION 'PPh tax period % is filed/closed; cannot modify or reverse allocations in a filed period.', OLD.tax_period_id
                        USING ERRCODE = 'check_violation';
                END IF;
            END IF;
        END IF;

        -- Check if target period (NEW) is filed/closed when reassigning period
        IF (NEW.tax_period_id IS DISTINCT FROM OLD.tax_period_id) THEN
            SELECT (filing_status = 'filed' OR status IN ('filed', 'closed') OR filed_at IS NOT NULL)
            INTO v_is_locked
            FROM public.tax_periods
            WHERE id = NEW.tax_period_id;

            IF v_is_locked IS TRUE THEN
                SELECT id INTO v_amendment_id
                FROM public.tax_period_amendment_authorizations
                WHERE tax_period_id = NEW.tax_period_id
                  AND expires_at > now()
                  AND is_consumed = false
                LIMIT 1;

                IF v_amendment_id IS NOT NULL THEN
                    UPDATE public.tax_period_amendment_authorizations
                    SET is_consumed = true, consumed_at = now()
                    WHERE id = v_amendment_id;
                    RETURN NEW;
                END IF;

                RAISE EXCEPTION 'Target PPh tax period % is filed/closed; cannot reassign allocations into a filed period.', NEW.tax_period_id
                    USING ERRCODE = 'check_violation';
            END IF;
        END IF;

        RETURN NEW;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_lock_finance_expense_pph_allocations ON public.finance_expense_pph_allocations;
CREATE TRIGGER trg_lock_finance_expense_pph_allocations
    BEFORE INSERT OR UPDATE OR DELETE ON public.finance_expense_pph_allocations
    FOR EACH ROW
    EXECUTE FUNCTION public.enforce_pph_allocation_period_lock();

-- Step 4: Idempotent PPh allocation sync function
CREATE OR REPLACE FUNCTION public.sync_expense_pph_allocation(
    p_expense_id UUID,
    p_payment_source TEXT,
    p_payment_event_id UUID,
    p_payment_date DATE,
    p_payment_amount NUMERIC,
    p_is_reversed BOOLEAN DEFAULT false,
    p_source_id UUID DEFAULT NULL,
    p_notes TEXT DEFAULT NULL
) RETURNS UUID AS $$
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
BEGIN
    -- Fetch parent expense
    SELECT * INTO v_expense FROM public.finance_expenses WHERE id = p_expense_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Expense % not found for PPh allocation', p_expense_id;
    END IF;

    v_pph_total := COALESCE(v_expense.pph_amount, 0);
    IF v_pph_total <= 0 THEN
        RETURN NULL; -- No PPh to allocate
    END IF;

    v_effective_event_id := COALESCE(p_payment_event_id, p_source_id, gen_random_uuid());

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
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Step 5: Trigger to automatically sync PPh allocations from bank_statement_allocations
CREATE OR REPLACE FUNCTION public.trg_fn_sync_bank_alloc_pph()
RETURNS TRIGGER AS $$
DECLARE
    v_tx_date DATE;
    v_has_pph BOOLEAN;
BEGIN
    IF NEW.document_type = 'expense' THEN
        SELECT (COALESCE(pph_amount, 0) > 0) INTO v_has_pph
        FROM public.finance_expenses
        WHERE id = NEW.document_id;

        IF v_has_pph THEN
            SELECT transaction_date INTO v_tx_date
            FROM public.bank_statement_lines
            WHERE id = NEW.bank_statement_line_id;

            IF v_tx_date IS NOT NULL THEN
                PERFORM public.sync_expense_pph_allocation(
                    NEW.document_id,
                    'bank_statement_allocation',
                    NEW.id, -- Use allocation UUID as the stable payment_event_id
                    v_tx_date,
                    NEW.allocation_amount,
                    false,
                    NEW.id,
                    'Synced from bank statement allocation'
                );
            END IF;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_sync_bank_alloc_pph ON public.bank_statement_allocations;
CREATE TRIGGER trg_sync_bank_alloc_pph
    AFTER INSERT OR UPDATE ON public.bank_statement_allocations
    FOR EACH ROW
    EXECUTE FUNCTION public.trg_fn_sync_bank_alloc_pph();

-- Trigger for bank statement allocation deletion (reversal)
CREATE OR REPLACE FUNCTION public.trg_fn_revert_bank_alloc_pph()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.document_type = 'expense' THEN
        UPDATE public.finance_expense_pph_allocations
        SET is_reversed = true,
            recognized_pph_amount = 0,
            payment_amount = 0,
            notes = 'Reversed upon bank statement allocation deletion',
            updated_at = now()
        WHERE expense_id = OLD.document_id
          AND payment_source = 'bank_statement_allocation'
          AND payment_event_id = OLD.id;
    END IF;
    RETURN OLD;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_revert_bank_alloc_pph ON public.bank_statement_allocations;
CREATE TRIGGER trg_revert_bank_alloc_pph
    AFTER DELETE ON public.bank_statement_allocations
    FOR EACH ROW
    EXECUTE FUNCTION public.trg_fn_revert_bank_alloc_pph();

-- Step 6: Update fn_pph_authoritative_source_total to recognize payment-level allocations
CREATE OR REPLACE FUNCTION public.fn_pph_authoritative_source_total(p_period_id uuid)
RETURNS numeric LANGUAGE sql STABLE SET search_path = public AS $$
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
       -- Exclude completely unpaid expenses
       AND (COALESCE(fe.payment_method, '') = 'cash' OR COALESCE(fe.paid_amount, 0) > 0.01)
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
$$;

GRANT EXECUTE ON FUNCTION public.fn_pph_authoritative_source_total(uuid) TO authenticated, service_role, anon;
