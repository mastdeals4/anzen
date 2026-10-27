-- Migration: 20261023170000_fix_receipt_voucher_settlement_rounding.sql
-- Description: Fix Receipt Voucher allocation and posting workflow for rounding differences
-- Supports Sales Order advance settlements, records rounding adjustments to account 4900/6900,
-- prevents arbitrary unallocated over/underpayment beyond tolerance, and guarantees idempotency.

-- 1. Schema enhancement on invoice_rounding_adjustments to support sales orders
ALTER TABLE public.invoice_rounding_adjustments
  ADD COLUMN IF NOT EXISTS sales_order_id uuid REFERENCES public.sales_orders(id) ON DELETE CASCADE;

-- 1b. Fix voucher_allocations_check to permit Receipt -> Sales Order (Advance) allocations
ALTER TABLE public.voucher_allocations
  DROP CONSTRAINT IF EXISTS voucher_allocations_check;

ALTER TABLE public.voucher_allocations
  ADD CONSTRAINT voucher_allocations_check CHECK (
    (voucher_type = 'receipt' AND receipt_voucher_id IS NOT NULL AND (
      (sales_invoice_id IS NOT NULL AND sales_order_id IS NULL) OR
      (sales_order_id IS NOT NULL AND sales_invoice_id IS NULL)
    )) OR
    (voucher_type = 'payment' AND payment_voucher_id IS NOT NULL AND (
      (purchase_invoice_id IS NOT NULL AND finance_expense_id IS NULL) OR
      (finance_expense_id IS NOT NULL AND purchase_invoice_id IS NULL)
    ))
  );

ALTER TABLE public.invoice_rounding_adjustments
  DROP CONSTRAINT IF EXISTS chk_invoice_rounding_adjustments_target;

ALTER TABLE public.invoice_rounding_adjustments
  ADD CONSTRAINT chk_invoice_rounding_adjustments_target
  CHECK (
    (sales_invoice_id IS NOT NULL AND purchase_invoice_id IS NULL AND sales_order_id IS NULL) OR
    (purchase_invoice_id IS NOT NULL AND sales_invoice_id IS NULL AND sales_order_id IS NULL) OR
    (sales_order_id IS NOT NULL AND sales_invoice_id IS NULL AND purchase_invoice_id IS NULL)
  );

CREATE UNIQUE INDEX IF NOT EXISTS invoice_rounding_adjustments_one_per_so
  ON public.invoice_rounding_adjustments (sales_order_id)
  WHERE sales_order_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_invoice_rounding_adjustments_so
  ON public.invoice_rounding_adjustments (sales_order_id)
  WHERE sales_order_id IS NOT NULL;

-- 2. Helper function to get Sales Order rounding adjustment amount
CREATE OR REPLACE FUNCTION public.get_sales_order_rounding_adjustment_amount(p_sales_order_id uuid)
RETURNS numeric
LANGUAGE sql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(SUM(adjustment_amount), 0)
  FROM public.invoice_rounding_adjustments
  WHERE sales_order_id = p_sales_order_id;
$$;

REVOKE ALL ON FUNCTION public.get_sales_order_rounding_adjustment_amount(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_sales_order_rounding_adjustment_amount(uuid) TO authenticated, service_role;

-- 3. Update update_so_advance_status trigger function to include rounding adjustments and tolerance
CREATE OR REPLACE FUNCTION public.update_so_advance_status()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_sales_order_id UUID;
  v_total_advance DECIMAL(18,2);
  v_order_total DECIMAL(18,2);
  v_total_adj DECIMAL(18,2) := 0;
  v_tolerance DECIMAL(18,2) := 100;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_sales_order_id := OLD.sales_order_id;
  ELSE
    v_sales_order_id := NEW.sales_order_id;
  END IF;

  IF v_sales_order_id IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  SELECT COALESCE(SUM(va.allocated_amount), 0)
    INTO v_total_advance
    FROM public.voucher_allocations va
   WHERE va.sales_order_id = v_sales_order_id
     AND va.voucher_type = 'receipt';

  SELECT total_amount INTO v_order_total
    FROM public.sales_orders
   WHERE id = v_sales_order_id;

  SELECT COALESCE(SUM(ira.adjustment_amount), 0)
    INTO v_total_adj
    FROM public.invoice_rounding_adjustments ira
   WHERE ira.sales_order_id = v_sales_order_id;

  SELECT COALESCE(rounding_tolerance_amount, 100)
    INTO v_tolerance
    FROM public.app_settings
   LIMIT 1;

  UPDATE public.sales_orders
  SET 
    advance_payment_amount = v_total_advance,
    advance_payment_status = CASE
      WHEN v_total_advance = 0 AND v_total_adj = 0 THEN 'none'
      WHEN (v_total_advance + v_total_adj) >= v_order_total 
           OR (v_order_total - v_total_advance) <= v_tolerance THEN 'full'
      ELSE 'partial'
    END,
    updated_at = now()
  WHERE id = v_sales_order_id;

  RETURN COALESCE(NEW, OLD);
END;
$$;

-- 4. Function for Sales Order settlement rounding adjustments
CREATE OR REPLACE FUNCTION public.apply_so_allocation_rounding_adjustment(
  p_so_id uuid,
  p_receipt_voucher_id uuid,
  p_adjustment_type text DEFAULT 'rounding',
  p_reason text DEFAULT 'invoice_rounding_tolerance',
  p_amount numeric DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_so RECORD;
  v_tolerance numeric;
  v_existing RECORD;
  v_allocated numeric;
  v_residual numeric;
  v_target_rv_id uuid;
  v_has_posted_allocations boolean := false;
  v_adj_amount numeric(18,2);
  v_adj_type text;
  v_adj_reason text;
  v_voucher_date date;
  v_ar_account_id uuid;
  v_adjustment_account_id uuid;
  v_user_id uuid;
  v_entry_number text;
  v_entry_id uuid;
BEGIN
  SELECT *
  INTO v_so
  FROM public.sales_orders
  WHERE id = p_so_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT COALESCE(rounding_tolerance_amount, 100)
  INTO v_tolerance
  FROM public.app_settings
  LIMIT 1;
  v_tolerance := COALESCE(v_tolerance, 100);

  SELECT *
  INTO v_existing
  FROM public.invoice_rounding_adjustments
  WHERE sales_order_id = p_so_id
  LIMIT 1;

  SELECT COALESCE(SUM(allocated_amount), 0)
  INTO v_allocated
  FROM public.voucher_allocations
  WHERE sales_order_id = p_so_id
    AND voucher_type = 'receipt';

  SELECT EXISTS (
    SELECT 1 
    FROM public.voucher_allocations va
    JOIN public.receipt_vouchers rv ON rv.id = va.receipt_voucher_id
    WHERE va.sales_order_id = p_so_id
      AND va.voucher_type = 'receipt'
      AND rv.is_posted = true
  ) INTO v_has_posted_allocations;

  IF p_receipt_voucher_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.receipt_vouchers WHERE id = p_receipt_voucher_id AND is_posted = true
  ) THEN
    v_target_rv_id := p_receipt_voucher_id;
  ELSIF v_has_posted_allocations THEN
    SELECT rv.id INTO v_target_rv_id
    FROM public.voucher_allocations va
    JOIN public.receipt_vouchers rv ON rv.id = va.receipt_voucher_id
    WHERE va.sales_order_id = p_so_id
      AND va.voucher_type = 'receipt'
      AND rv.is_posted = true
    ORDER BY rv.created_at DESC
    LIMIT 1;
  ELSE
    v_target_rv_id := NULL;
  END IF;

  IF v_target_rv_id IS NOT NULL THEN
    SELECT voucher_date INTO v_voucher_date
    FROM public.receipt_vouchers
    WHERE id = v_target_rv_id;
  END IF;

  v_residual := ROUND(COALESCE(v_so.total_amount, 0) - COALESCE(v_allocated, 0), 2);

  IF p_amount IS NOT NULL AND p_amount <> 0 THEN
    v_adj_amount := ROUND(p_amount, 2);
    v_adj_type := COALESCE(p_adjustment_type, 'rounding');
    v_adj_reason := COALESCE(NULLIF(p_reason, ''), 'settlement_adjustment');
  ELSE
    IF ABS(v_residual) > 0 AND ABS(v_residual) <= v_tolerance THEN
      v_adj_amount := v_residual;
      v_adj_type := COALESCE(p_adjustment_type, 'rounding');
      v_adj_reason := COALESCE(NULLIF(p_reason, ''), 'invoice_rounding_tolerance');
    ELSE
      v_adj_amount := 0;
      v_adj_type := 'rounding';
      v_adj_reason := 'none';
    END IF;
  END IF;

  IF v_adj_type = 'rounding' AND ABS(v_adj_amount) > v_tolerance THEN
    RAISE EXCEPTION 'Rounding adjustment % exceeds configured tolerance %', v_adj_amount, v_tolerance;
  END IF;

  IF ABS(v_adj_amount) > 0 AND v_has_posted_allocations THEN
    IF v_existing.id IS NOT NULL 
       AND v_existing.adjustment_amount = v_adj_amount 
       AND v_existing.adjustment_type = v_adj_type THEN
      IF v_existing.journal_entry_id IS NOT NULL AND v_voucher_date IS NOT NULL THEN
        UPDATE public.journal_entries
        SET entry_date = v_voucher_date
        WHERE id = v_existing.journal_entry_id AND entry_date <> v_voucher_date;
      END IF;
      RETURN;
    END IF;

    IF v_existing.journal_entry_id IS NOT NULL THEN
      DELETE FROM public.journal_entry_lines WHERE journal_entry_id = v_existing.journal_entry_id;
      DELETE FROM public.journal_entries WHERE id = v_existing.journal_entry_id;
    END IF;
    IF v_existing.id IS NOT NULL THEN
      DELETE FROM public.invoice_rounding_adjustments WHERE id = v_existing.id;
    END IF;

    -- AR / Advance Account 1120
    SELECT id INTO v_ar_account_id
    FROM public.chart_of_accounts
    WHERE code = '1120'
    LIMIT 1;

    IF v_adj_type = 'rounding' THEN
      IF v_adj_amount > 0 THEN
        -- Short payment under tolerance: write-off expense
        SELECT COALESCE(
          (SELECT rounding_writeoff_account_id FROM public.app_settings LIMIT 1),
          (SELECT id FROM public.chart_of_accounts WHERE code = '6900' LIMIT 1)
        ) INTO v_adjustment_account_id;
      ELSE
        -- Overpayment under tolerance: rounding gain
        SELECT COALESCE(
          (SELECT rounding_gain_account_id FROM public.app_settings LIMIT 1),
          (SELECT id FROM public.chart_of_accounts WHERE code = '4900' LIMIT 1)
        ) INTO v_adjustment_account_id;
      END IF;
    ELSIF v_adj_type IN ('discount', 'write_off') THEN
      SELECT COALESCE(
        (SELECT id FROM public.chart_of_accounts WHERE code = '4200' LIMIT 1),
        (SELECT id FROM public.chart_of_accounts WHERE code = '6900' LIMIT 1)
      ) INTO v_adjustment_account_id;
    END IF;

    IF v_ar_account_id IS NULL OR v_adjustment_account_id IS NULL THEN
      RAISE EXCEPTION 'Missing COA setup for sales order settlement adjustment';
    END IF;

    v_user_id := COALESCE(auth.uid(), v_so.created_by);
    v_entry_number := public.next_journal_entry_number();

    INSERT INTO public.journal_entries (
      entry_number, entry_date, source_module, reference_id, reference_number,
      description, total_debit, total_credit, is_posted, posted_by, created_by
    ) VALUES (
      v_entry_number,
      COALESCE(v_voucher_date, CURRENT_DATE),
      'sales_order_rounding',
      v_so.id,
      v_so.so_number,
      'Receipt settlement ' || v_adj_type || ' adjustment: ' || v_so.so_number,
      ABS(v_adj_amount),
      ABS(v_adj_amount),
      true,
      v_user_id,
      v_user_id
    )
    RETURNING id INTO v_entry_id;

    IF v_adj_amount > 0 THEN
      -- Customer underpaid: Debit Rounding Expense (6900) or Discount (4200), Credit AR (1120)
      INSERT INTO public.journal_entry_lines (journal_entry_id, line_number, account_id, description, debit, credit, customer_id)
      VALUES
        (v_entry_id, 1, v_adjustment_account_id, INITCAP(v_adj_type) || ' - ' || v_so.so_number, ABS(v_adj_amount), 0, v_so.customer_id),
        (v_entry_id, 2, v_ar_account_id, 'SO advance clearance - ' || v_so.so_number, 0, ABS(v_adj_amount), v_so.customer_id);
    ELSE
      -- Customer overpaid: Debit AR (1120), Credit Rounding Gain (4900)
      INSERT INTO public.journal_entry_lines (journal_entry_id, line_number, account_id, description, debit, credit, customer_id)
      VALUES
        (v_entry_id, 1, v_ar_account_id, 'SO advance clearance - ' || v_so.so_number, ABS(v_adj_amount), 0, v_so.customer_id),
        (v_entry_id, 2, v_adjustment_account_id, INITCAP(v_adj_type) || ' - ' || v_so.so_number, 0, ABS(v_adj_amount), v_so.customer_id);
    END IF;

    INSERT INTO public.invoice_rounding_adjustments (
      receipt_voucher_id, sales_order_id, adjustment_amount, adjustment_type, reason, journal_entry_id, created_by
    ) VALUES (
      v_target_rv_id, p_so_id, v_adj_amount, v_adj_type, v_adj_reason, v_entry_id, v_user_id
    );
  ELSE
    IF v_existing.journal_entry_id IS NOT NULL THEN
      DELETE FROM public.journal_entry_lines WHERE journal_entry_id = v_existing.journal_entry_id;
      DELETE FROM public.journal_entries WHERE id = v_existing.journal_entry_id;
    END IF;
    IF v_existing.id IS NOT NULL THEN
      DELETE FROM public.invoice_rounding_adjustments WHERE id = v_existing.id;
    END IF;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.apply_so_allocation_rounding_adjustment(uuid, uuid, text, text, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apply_so_allocation_rounding_adjustment(uuid, uuid, text, text, numeric) TO authenticated, service_role;

-- 5. Update save_invoice_settlement_adjustment to support sales orders and invoices
CREATE OR REPLACE FUNCTION public.save_invoice_settlement_adjustment(
  p_document_type text,
  p_invoice_id uuid,
  p_voucher_id uuid DEFAULT NULL::uuid,
  p_adjustment_amount numeric DEFAULT NULL::numeric,
  p_adjustment_type text DEFAULT 'rounding',
  p_reason text DEFAULT 'invoice_rounding_tolerance'
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM public._sec_check_finance_role();

  IF p_document_type = 'purchase' THEN
    PERFORM public.apply_payment_allocation_rounding_adjustment(
      p_invoice_id,
      p_voucher_id,
      p_adjustment_type,
      p_reason,
      p_adjustment_amount
    );
  ELSIF p_document_type IN ('sales', 'sales_invoice') THEN
    IF EXISTS (SELECT 1 FROM public.sales_invoices WHERE id = p_invoice_id) THEN
      PERFORM public.apply_receipt_allocation_rounding_adjustment(
        p_invoice_id,
        p_voucher_id,
        p_adjustment_type,
        p_reason,
        p_adjustment_amount
      );
    ELSIF EXISTS (SELECT 1 FROM public.sales_orders WHERE id = p_invoice_id) THEN
      PERFORM public.apply_so_allocation_rounding_adjustment(
        p_invoice_id,
        p_voucher_id,
        p_adjustment_type,
        p_reason,
        p_adjustment_amount
      );
    ELSE
      RAISE EXCEPTION 'Target sales document % not found', p_invoice_id;
    END IF;
  ELSIF p_document_type = 'sales_order' THEN
    PERFORM public.apply_so_allocation_rounding_adjustment(
      p_invoice_id,
      p_voucher_id,
      p_adjustment_type,
      p_reason,
      p_adjustment_amount
    );
  ELSE
    RAISE EXCEPTION 'Invalid document type % for settlement adjustment', p_document_type;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.save_invoice_settlement_adjustment(text, uuid, uuid, numeric, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_invoice_settlement_adjustment(text, uuid, uuid, numeric, text, text) TO authenticated, service_role;

-- 6. Canonical post_receipt_voucher supporting sales orders, rounding tolerance, and exact accounting
CREATE OR REPLACE FUNCTION public.post_receipt_voucher(p_rv_id uuid, p_posted_by uuid DEFAULT NULL::uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_rv                 RECORD;
  v_je_id              UUID;
  v_je_number          TEXT;
  v_debit_account_id   UUID;
  v_credit_account_id  UUID;
  v_fx_loss_id         UUID;
  v_fx_gain_id         UUID;
  v_rounding_loss_id   UUID;
  v_rounding_gain_id   UUID;
  v_actual_poster      UUID;
  v_rate               NUMERIC := 1;
  v_actual_received    NUMERIC;
  v_carrying_ar        NUMERIC;
  v_total_allocated    NUMERIC := 0;
  v_diff               NUMERIC := 0;
  v_total_debit        NUMERIC;
  v_total_credit       NUMERIC;
  v_line               INTEGER := 1;
  v_tolerance          NUMERIC := 100;
  v_currency           TEXT;
  v_target_si_id       UUID;
  v_target_so_id       UUID;
BEGIN
  PERFORM public._sec_check_finance_role();
  v_actual_poster := COALESCE(auth.uid(), p_posted_by);

  SELECT * INTO v_rv FROM receipt_vouchers WHERE id = p_rv_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Receipt voucher % not found', p_rv_id; END IF;
  IF v_rv.is_posted THEN RAISE EXCEPTION 'Receipt voucher % is already posted', v_rv.voucher_number; END IF;

  IF v_rv.bank_account_id IS NOT NULL THEN
    SELECT coa_id INTO v_debit_account_id FROM bank_accounts WHERE id = v_rv.bank_account_id;
  ELSIF v_rv.payment_method = 'cash' THEN
    SELECT id INTO v_debit_account_id FROM chart_of_accounts WHERE code = '1101' LIMIT 1;
  END IF;
  IF v_debit_account_id IS NULL THEN
    SELECT id INTO v_debit_account_id FROM chart_of_accounts WHERE code = '1111' LIMIT 1;
  END IF;

  IF v_rv.coa_account_id IS NOT NULL THEN
    v_credit_account_id := v_rv.coa_account_id;
  ELSE
    SELECT id INTO v_credit_account_id FROM chart_of_accounts WHERE code = '1120' LIMIT 1;
  END IF;

  SELECT id INTO v_fx_loss_id FROM chart_of_accounts WHERE code = '7300' LIMIT 1;
  SELECT id INTO v_fx_gain_id FROM chart_of_accounts WHERE code = '4930' LIMIT 1;

  SELECT COALESCE(
    (SELECT rounding_writeoff_account_id FROM public.app_settings LIMIT 1),
    (SELECT id FROM public.chart_of_accounts WHERE code = '6900' LIMIT 1)
  ) INTO v_rounding_loss_id;

  SELECT COALESCE(
    (SELECT rounding_gain_account_id FROM public.app_settings LIMIT 1),
    (SELECT id FROM public.chart_of_accounts WHERE code = '4900' LIMIT 1)
  ) INTO v_rounding_gain_id;

  IF v_debit_account_id IS NULL OR v_credit_account_id IS NULL THEN
    RAISE EXCEPTION 'Cannot post: required chart of accounts entries missing';
  END IF;

  SELECT COALESCE(rounding_tolerance_amount, 100)
    INTO v_tolerance
    FROM public.app_settings
   LIMIT 1;
  v_tolerance := COALESCE(v_tolerance, 100);

  v_currency := UPPER(COALESCE(v_rv.payment_currency, v_rv.transaction_currency, 'IDR'));
  v_rate := COALESCE(v_rv.exchange_rate, 1);
  IF v_rate <= 0 THEN v_rate := 1; END IF;

  -- Actual received in functional currency (IDR)
  v_actual_received := COALESCE(v_rv.settlement_amount, v_rv.amount * v_rate);
  v_carrying_ar := v_actual_received;

  -- Load total allocations across both sales invoices and sales orders
  SELECT COALESCE(SUM(va.allocated_amount), 0)
    INTO v_total_allocated
    FROM public.voucher_allocations va
   WHERE va.receipt_voucher_id = p_rv_id;

  IF v_total_allocated > 0 THEN
    v_carrying_ar := v_total_allocated;
  END IF;

  -- Difference between actual bank receipt and carrying AR allocation
  v_diff := v_actual_received - v_carrying_ar;

  -- Enforce rounding tolerance on IDR transactions
  IF v_currency = 'IDR' AND v_total_allocated > 0 AND ABS(v_diff) > 0 THEN
    IF ABS(v_diff) > v_tolerance THEN
      RAISE EXCEPTION 'Receipt allocation difference % exceeds configured rounding tolerance %', ABS(v_diff), v_tolerance;
    END IF;
  END IF;

  IF v_currency = 'IDR' THEN
    -- In IDR: v_diff is Rounding Adjustment
    v_total_debit := v_actual_received + CASE WHEN v_diff < 0 THEN ABS(v_diff) ELSE 0 END;
    v_total_credit := v_carrying_ar + CASE WHEN v_diff > 0 THEN v_diff ELSE 0 END;
  ELSE
    -- Foreign currency: v_diff is Realized FX
    v_total_debit := v_actual_received + CASE WHEN v_diff < 0 THEN ABS(v_diff) ELSE 0 END;
    v_total_credit := v_carrying_ar + CASE WHEN v_diff > 0 THEN v_diff ELSE 0 END;
  END IF;

  v_je_number := next_journal_entry_number();

  INSERT INTO journal_entries (
    entry_number, entry_date, source_module, reference_id, reference_number,
    description, total_debit, total_credit, is_posted, posted_by,
    transaction_currency, functional_currency, exchange_rate
  ) VALUES (
    v_je_number, v_rv.voucher_date, 'receipt', v_rv.id, v_rv.voucher_number,
    'Receipt Voucher: ' || v_rv.voucher_number,
    v_total_debit, v_total_credit, TRUE, v_actual_poster,
    COALESCE(v_rv.payment_currency, 'IDR'), 'IDR', v_rate
  ) RETURNING id INTO v_je_id;

  -- Line 1: Debit Bank/Cash with Actual IDR received
  INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, description, debit, credit, customer_id)
  VALUES (v_je_id, v_line, v_debit_account_id, 'Cash Receipt - ' || v_rv.voucher_number, v_actual_received, 0, v_rv.customer_id);
  v_line := v_line + 1;

  -- Line 2: Debit Loss/Write-off if Received Less than Carrying
  IF v_diff < 0 THEN
    IF v_currency = 'IDR' THEN
      INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, description, debit, credit, customer_id)
      VALUES (v_je_id, v_line, v_rounding_loss_id, 'Receipt settlement rounding write-off - ' || v_rv.voucher_number, ABS(v_diff), 0, v_rv.customer_id);
      v_line := v_line + 1;
    ELSIF v_fx_loss_id IS NOT NULL THEN
      INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, description, debit, credit, customer_id)
      VALUES (v_je_id, v_line, v_fx_loss_id, 'Realized FX loss - ' || v_rv.voucher_number, ABS(v_diff), 0, v_rv.customer_id);
      v_line := v_line + 1;
    END IF;
  END IF;

  -- Line 3: Credit AR with Carrying Value (the allocated document amounts)
  INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, description, debit, credit, customer_id)
  VALUES (v_je_id, v_line, v_credit_account_id, 'Receipt - ' || v_rv.voucher_number, 0, v_carrying_ar, v_rv.customer_id);
  v_line := v_line + 1;

  -- Line 4: Credit Gain if Received More than Carrying
  IF v_diff > 0 THEN
    IF v_currency = 'IDR' THEN
      INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, description, debit, credit, customer_id)
      VALUES (v_je_id, v_line, v_rounding_gain_id, 'Receipt settlement rounding gain - ' || v_rv.voucher_number, 0, v_diff, v_rv.customer_id);
      v_line := v_line + 1;
    ELSIF v_fx_gain_id IS NOT NULL THEN
      INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, description, debit, credit, customer_id)
      VALUES (v_je_id, v_line, v_fx_gain_id, 'Realized FX gain - ' || v_rv.voucher_number, 0, v_diff, v_rv.customer_id);
      v_line := v_line + 1;
    END IF;
  END IF;

  -- Audit entry in invoice_rounding_adjustments for IDR rounding differences
  IF v_currency = 'IDR' AND v_total_allocated > 0 AND ABS(v_diff) > 0 THEN
    SELECT va.sales_invoice_id, va.sales_order_id
      INTO v_target_si_id, v_target_so_id
      FROM public.voucher_allocations va
     WHERE va.receipt_voucher_id = p_rv_id
     ORDER BY va.allocated_amount DESC
     LIMIT 1;

    IF NOT EXISTS (SELECT 1 FROM public.invoice_rounding_adjustments WHERE receipt_voucher_id = p_rv_id) THEN
      INSERT INTO public.invoice_rounding_adjustments (
        receipt_voucher_id,
        sales_invoice_id,
        sales_order_id,
        adjustment_amount,
        adjustment_type,
        reason,
        journal_entry_id,
        created_by
      ) VALUES (
        p_rv_id,
        v_target_si_id,
        v_target_so_id,
        v_diff,
        'rounding',
        CASE WHEN v_diff > 0 THEN 'Receipt settlement rounding gain' ELSE 'Receipt settlement rounding write-off' END,
        v_je_id,
        v_actual_poster
      );
    ELSE
      UPDATE public.invoice_rounding_adjustments
      SET journal_entry_id = v_je_id,
          sales_order_id = COALESCE(sales_order_id, v_target_so_id),
          sales_invoice_id = COALESCE(sales_invoice_id, v_target_si_id),
          adjustment_amount = v_diff
      WHERE receipt_voucher_id = p_rv_id;
    END IF;

    -- Ensure SO advance status reflects settlement
    IF v_target_so_id IS NOT NULL THEN
      UPDATE public.sales_orders
      SET advance_payment_status = 'full',
          updated_at = now()
      WHERE id = v_target_so_id;
    END IF;
  END IF;

  UPDATE receipt_vouchers
  SET is_posted = TRUE, journal_entry_id = v_je_id
  WHERE id = p_rv_id;

  INSERT INTO audit_logs (table_name, record_id, action_type, old_values, new_values, user_id)
  VALUES (
    'receipt_vouchers', p_rv_id, 'update',
    jsonb_build_object('is_posted', FALSE),
    jsonb_build_object('is_posted', TRUE, 'journal_entry_id', v_je_id, 'journal_entry_number', v_je_number, 'posted_by', v_actual_poster),
    v_actual_poster
  );
END;
$$;

REVOKE ALL ON FUNCTION public.post_receipt_voucher(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.post_receipt_voucher(uuid, uuid) TO authenticated, service_role;

-- 7. Update cancel_receipt_voucher_posting to clean up rounding adjustments
CREATE OR REPLACE FUNCTION public.cancel_receipt_voucher_posting(
  p_rv_id uuid,
  p_cancelled_by uuid DEFAULT NULL::uuid,
  p_reason text DEFAULT 'Posting cancelled by administrator'::text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_rv RECORD;
  v_je RECORD;
  v_actor uuid;
  v_alloc RECORD;
  v_line_ids uuid[] := ARRAY[]::uuid[];
  v_line_id uuid;
BEGIN
  PERFORM public._sec_check_finance_role();
  v_actor := COALESCE(auth.uid(), p_cancelled_by);

  SELECT * INTO v_rv FROM public.receipt_vouchers WHERE id = p_rv_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Receipt voucher % not found', p_rv_id;
  END IF;

  IF NOT v_rv.is_posted THEN
    RAISE EXCEPTION 'Receipt voucher % is not posted', COALESCE(v_rv.voucher_number, p_rv_id::TEXT);
  END IF;

  SELECT * INTO v_je FROM public.journal_entries WHERE id = v_rv.journal_entry_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No journal entry found for receipt voucher %', v_rv.voucher_number;
  END IF;

  -- Clean up any associated rounding adjustments
  DELETE FROM public.invoice_rounding_adjustments WHERE receipt_voucher_id = p_rv_id;

  -- Step 1: Identify all bank allocations associated with this receipt voucher or its journal entry
  FOR v_alloc IN
    SELECT bsa.id, bsa.bank_statement_line_id
    FROM public.bank_statement_allocations bsa
    WHERE (bsa.document_type = 'receipt' AND bsa.document_id = p_rv_id)
       OR (v_rv.journal_entry_id IS NOT NULL AND bsa.journal_entry_id = v_rv.journal_entry_id)
    FOR UPDATE
  LOOP
    IF NOT (v_alloc.bank_statement_line_id = ANY(v_line_ids)) THEN
      v_line_ids := array_append(v_line_ids, v_alloc.bank_statement_line_id);
    END IF;

    UPDATE public.finance_historical_repair_commands
    SET created_allocation_id = NULL
    WHERE created_allocation_id = v_alloc.id;

    PERFORM public.unmatch_bank_statement_allocation(v_alloc.id);
  END LOOP;

  -- Step 2: Identify any bank lines directly referencing this receipt or journal entry
  FOR v_line_id IN
    SELECT id FROM public.bank_statement_lines
    WHERE matched_receipt_id = p_rv_id
       OR (v_rv.journal_entry_id IS NOT NULL AND matched_entry_id = v_rv.journal_entry_id)
  LOOP
    IF NOT (v_line_id = ANY(v_line_ids)) THEN
      v_line_ids := array_append(v_line_ids, v_line_id);
    END IF;
  END LOOP;

  -- Step 3: Clear direct bank line references and refresh ownership and reconciliation status
  IF array_length(v_line_ids, 1) > 0 THEN
    UPDATE public.bank_statement_lines
    SET matched_receipt_id = NULL
    WHERE matched_receipt_id = p_rv_id;

    IF v_rv.journal_entry_id IS NOT NULL THEN
      UPDATE public.bank_statement_lines
      SET matched_entry_id = NULL
      WHERE matched_entry_id = v_rv.journal_entry_id;
    END IF;

    FOREACH v_line_id IN ARRAY v_line_ids LOOP
      PERFORM public.sync_bank_line_allocation_owner(v_line_id);
      PERFORM public.refresh_bank_statement_allocation_status(v_line_id);
    END LOOP;
  END IF;

  -- Step 4: Clear the FK reference FIRST so cancel_gl_posting can delete the JE row.
  UPDATE public.receipt_vouchers
  SET is_posted = FALSE, journal_entry_id = NULL
  WHERE id = p_rv_id;

  -- Step 5: Delete original receipt journal entry and record audit log via cancel_gl_posting
  PERFORM public.cancel_gl_posting(
    v_je.id,
    p_rv_id,
    'receipt_vouchers',
    v_actor,
    p_reason,
    jsonb_build_object(
      'voucher_number', v_rv.voucher_number,
      'amount',         v_rv.amount,
      'is_posted',      TRUE
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.cancel_receipt_voucher_posting(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_receipt_voucher_posting(uuid, uuid, text) TO authenticated, service_role;
