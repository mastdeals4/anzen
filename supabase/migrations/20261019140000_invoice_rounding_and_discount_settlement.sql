-- Migration: 20261019140000_invoice_rounding_and_discount_settlement.sql
-- Description: End-to-end settlement round-off and commercial discount handling for AP and AR
-- Reuses existing invoice_rounding_adjustments table with minimal schema additions

-- 1. Minimal schema update on invoice_rounding_adjustments
ALTER TABLE public.invoice_rounding_adjustments
  ALTER COLUMN sales_invoice_id DROP NOT NULL;

ALTER TABLE public.invoice_rounding_adjustments
  ADD COLUMN IF NOT EXISTS purchase_invoice_id uuid REFERENCES public.purchase_invoices(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS payment_voucher_id uuid REFERENCES public.payment_vouchers(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS adjustment_type text NOT NULL DEFAULT 'rounding';

-- Add check constraint for valid adjustment types if not present
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_invoice_rounding_adjustment_type'
  ) THEN
    ALTER TABLE public.invoice_rounding_adjustments
      ADD CONSTRAINT chk_invoice_rounding_adjustment_type
      CHECK (adjustment_type IN ('rounding', 'discount', 'write_off'));
  END IF;
END $$;

-- Ensure an adjustment row targets either sales invoice OR purchase invoice, never both
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_invoice_rounding_adjustments_target'
  ) THEN
    ALTER TABLE public.invoice_rounding_adjustments
      ADD CONSTRAINT chk_invoice_rounding_adjustments_target
      CHECK (
        (sales_invoice_id IS NOT NULL AND purchase_invoice_id IS NULL) OR
        (purchase_invoice_id IS NOT NULL AND sales_invoice_id IS NULL)
      );
  END IF;
END $$;

-- Indexes for performance and one adjustment per purchase invoice
CREATE UNIQUE INDEX IF NOT EXISTS invoice_rounding_adjustments_one_per_pi
  ON public.invoice_rounding_adjustments (purchase_invoice_id)
  WHERE purchase_invoice_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_invoice_rounding_adjustments_pv
  ON public.invoice_rounding_adjustments (payment_voucher_id)
  WHERE payment_voucher_id IS NOT NULL;

-- 2. Helper function to get purchase invoice adjustment amount
CREATE OR REPLACE FUNCTION public.get_purchase_invoice_rounding_adjustment_amount(p_purchase_invoice_id uuid)
RETURNS numeric
LANGUAGE sql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(SUM(ira.adjustment_amount), 0)
  FROM public.invoice_rounding_adjustments ira
  WHERE ira.purchase_invoice_id = p_purchase_invoice_id;
$$;

-- 3. Update recalculate_purchase_invoice_payment_state to include rounding adjustments
CREATE OR REPLACE FUNCTION public.recalculate_purchase_invoice_payment_state(p_purchase_invoice_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_invoice record;
  v_allocated numeric(18,2);
  v_adjustment numeric(18,2);
  v_paid numeric(18,2);
BEGIN
  IF p_purchase_invoice_id IS NULL THEN
    RETURN;
  END IF;

  SELECT id, total_amount
  INTO v_invoice
  FROM public.purchase_invoices
  WHERE id = p_purchase_invoice_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  -- Only count allocations whose parent payment voucher is POSTED to GL
  SELECT COALESCE(SUM(va.allocated_amount), 0)
  INTO v_allocated
  FROM public.voucher_allocations va
  JOIN public.payment_vouchers pv
    ON pv.id = va.payment_voucher_id
  WHERE va.purchase_invoice_id = p_purchase_invoice_id
    AND va.voucher_type = 'payment'
    AND pv.is_posted = TRUE;

  -- Include settlement rounding/discount adjustments
  v_adjustment := public.get_purchase_invoice_rounding_adjustment_amount(p_purchase_invoice_id);
  v_paid := v_allocated + v_adjustment;

  UPDATE public.purchase_invoices
  SET
    paid_amount = v_paid,
    status = CASE
      WHEN v_paid <= 0 THEN 'unpaid'
      WHEN v_paid >= COALESCE(v_invoice.total_amount, 0) THEN 'paid'
      ELSE 'partial'
    END
  WHERE id = p_purchase_invoice_id;
END;
$$;

-- 4. Create apply_payment_allocation_rounding_adjustment
CREATE OR REPLACE FUNCTION public.apply_payment_allocation_rounding_adjustment(
  p_invoice_id uuid,
  p_payment_voucher_id uuid DEFAULT NULL::uuid,
  p_adjustment_type text DEFAULT 'rounding',
  p_reason text DEFAULT 'invoice_rounding_tolerance',
  p_amount numeric DEFAULT NULL::numeric
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_invoice record;
  v_allocated numeric(18,2);
  v_residual numeric(18,2);
  v_tolerance numeric(18,2);
  v_existing record;
  v_entry_id uuid;
  v_entry_number text;
  v_ap_account_id uuid;
  v_adjustment_account_id uuid;
  v_user_id uuid;
  v_target_pv_id uuid;
  v_has_posted_allocations boolean := false;
  v_adj_amount numeric(18,2);
  v_adj_type text;
  v_adj_reason text;
BEGIN
  SELECT *
  INTO v_invoice
  FROM public.purchase_invoices
  WHERE id = p_invoice_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  -- Verify tolerance from settings
  SELECT COALESCE(rounding_tolerance_amount, 100)
  INTO v_tolerance
  FROM public.app_settings
  LIMIT 1;
  v_tolerance := COALESCE(v_tolerance, 100);

  -- Fetch existing adjustment for this purchase invoice
  SELECT *
  INTO v_existing
  FROM public.invoice_rounding_adjustments
  WHERE purchase_invoice_id = p_invoice_id
  LIMIT 1;

  -- Only POSTED payment voucher allocations count
  SELECT COALESCE(SUM(va.allocated_amount), 0)
  INTO v_allocated
  FROM public.voucher_allocations va
  JOIN public.payment_vouchers pv ON pv.id = va.payment_voucher_id
  WHERE va.purchase_invoice_id = p_invoice_id
    AND va.voucher_type = 'payment'
    AND pv.is_posted = true;

  SELECT EXISTS (
    SELECT 1
    FROM public.voucher_allocations va
    JOIN public.payment_vouchers pv ON pv.id = va.payment_voucher_id
    WHERE va.purchase_invoice_id = p_invoice_id
      AND va.voucher_type = 'payment'
      AND pv.is_posted = true
  ) INTO v_has_posted_allocations;

  -- Target PV selection
  IF p_payment_voucher_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.payment_vouchers WHERE id = p_payment_voucher_id AND is_posted = true
  ) THEN
    v_target_pv_id := p_payment_voucher_id;
  ELSIF v_has_posted_allocations THEN
    SELECT pv.id INTO v_target_pv_id
    FROM public.voucher_allocations va
    JOIN public.payment_vouchers pv ON pv.id = va.payment_voucher_id
    WHERE va.purchase_invoice_id = p_invoice_id
      AND va.voucher_type = 'payment'
      AND pv.is_posted = true
    ORDER BY pv.created_at DESC
    LIMIT 1;
  ELSE
    v_target_pv_id := NULL;
  END IF;

  v_residual := ROUND(COALESCE(v_invoice.total_amount, 0) - COALESCE(v_allocated, 0), 2);

  -- Determine adjustment amount and type
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

  -- Tolerance validation for rounding
  IF v_adj_type = 'rounding' AND ABS(v_adj_amount) > v_tolerance THEN
    RAISE EXCEPTION 'Rounding adjustment % exceeds configured tolerance %', v_adj_amount, v_tolerance;
  END IF;

  -- Reason validation for discount or write-off
  IF v_adj_type IN ('discount', 'write_off') AND (v_adj_reason IS NULL OR TRIM(v_adj_reason) = '' OR v_adj_reason = 'invoice_rounding_tolerance') THEN
    RAISE EXCEPTION 'A valid reason is required for discount or write-off settlement adjustments';
  END IF;

  -- Settle with posted payment activity
  IF ABS(v_adj_amount) > 0 AND v_has_posted_allocations THEN
    -- If already correctly adjusted with identical amount and type, just ensure state sync and return
    IF v_existing.id IS NOT NULL
       AND v_existing.adjustment_amount = v_adj_amount
       AND v_existing.adjustment_type = v_adj_type THEN
      PERFORM public.recalculate_purchase_invoice_payment_state(p_invoice_id);
      RETURN;
    END IF;

    -- Clean up previous adjustment journal and record before replacing
    IF v_existing.journal_entry_id IS NOT NULL THEN
      DELETE FROM public.journal_entry_lines WHERE journal_entry_id = v_existing.journal_entry_id;
      DELETE FROM public.journal_entries WHERE id = v_existing.journal_entry_id;
    END IF;
    IF v_existing.id IS NOT NULL THEN
      DELETE FROM public.invoice_rounding_adjustments WHERE id = v_existing.id;
    END IF;

    -- AP Account 2110
    SELECT id INTO v_ap_account_id
    FROM public.chart_of_accounts
    WHERE code = '2110'
    LIMIT 1;

    -- Adjustment account selection
    IF v_adj_type = 'rounding' THEN
      IF v_adj_amount > 0 THEN
        SELECT COALESCE(
          (SELECT rounding_gain_account_id FROM public.app_settings LIMIT 1),
          (SELECT id FROM public.chart_of_accounts WHERE code = '4900' LIMIT 1)
        ) INTO v_adjustment_account_id;
      ELSE
        SELECT COALESCE(
          (SELECT rounding_writeoff_account_id FROM public.app_settings LIMIT 1),
          (SELECT id FROM public.chart_of_accounts WHERE code = '6900' LIMIT 1)
        ) INTO v_adjustment_account_id;
      END IF;
    ELSIF v_adj_type IN ('discount', 'write_off') THEN
      IF v_adj_amount > 0 THEN
        -- Supplier discount reduces AP, credited to Other Income / Purchase Discount (4900 / 4910)
        SELECT COALESCE(
          (SELECT id FROM public.chart_of_accounts WHERE code = '4900' LIMIT 1),
          (SELECT id FROM public.chart_of_accounts WHERE code = '4910' LIMIT 1)
        ) INTO v_adjustment_account_id;
      ELSE
        SELECT id INTO v_adjustment_account_id
        FROM public.chart_of_accounts
        WHERE code = '6900'
        LIMIT 1;
      END IF;
    END IF;

    IF v_ap_account_id IS NULL OR v_adjustment_account_id IS NULL THEN
      RAISE EXCEPTION 'Missing COA setup for purchase invoice settlement adjustment';
    END IF;

    v_user_id := COALESCE(auth.uid(), v_invoice.created_by);
    v_entry_number := public.next_journal_entry_number();

    INSERT INTO public.journal_entries (
      entry_number, entry_date, source_module, reference_id, reference_number,
      description, total_debit, total_credit, is_posted, posted_by, created_by
    ) VALUES (
      v_entry_number,
      COALESCE(v_invoice.invoice_date, CURRENT_DATE),
      'purchase_invoice_rounding',
      v_invoice.id,
      v_invoice.invoice_number,
      'Payment settlement ' || v_adj_type || ' adjustment: ' || v_invoice.invoice_number,
      ABS(v_adj_amount),
      ABS(v_adj_amount),
      true,
      v_user_id,
      v_user_id
    )
    RETURNING id INTO v_entry_id;

    IF v_adj_amount > 0 THEN
      -- Debit AP (clearing payable), Credit Rounding Gain / Purchase Discount (4900)
      INSERT INTO public.journal_entry_lines (journal_entry_id, line_number, account_id, description, debit, credit, supplier_id)
      VALUES
        (v_entry_id, 1, v_ap_account_id, 'A/P settlement clearance - ' || v_invoice.invoice_number, ABS(v_adj_amount), 0, v_invoice.supplier_id),
        (v_entry_id, 2, v_adjustment_account_id, INITCAP(v_adj_type) || ' - ' || v_invoice.invoice_number, 0, ABS(v_adj_amount), v_invoice.supplier_id);
    ELSE
      -- Debit Expense / Write-off (6900), Credit AP
      INSERT INTO public.journal_entry_lines (journal_entry_id, line_number, account_id, description, debit, credit, supplier_id)
      VALUES
        (v_entry_id, 1, v_adjustment_account_id, INITCAP(v_adj_type) || ' - ' || v_invoice.invoice_number, ABS(v_adj_amount), 0, v_invoice.supplier_id),
        (v_entry_id, 2, v_ap_account_id, 'A/P settlement clearance - ' || v_invoice.invoice_number, 0, ABS(v_adj_amount), v_invoice.supplier_id);
    END IF;

    INSERT INTO public.invoice_rounding_adjustments (
      payment_voucher_id, purchase_invoice_id, adjustment_amount, adjustment_type, reason, journal_entry_id, created_by
    ) VALUES (
      v_target_pv_id, p_invoice_id, v_adj_amount, v_adj_type, v_adj_reason, v_entry_id, v_user_id
    );
  ELSE
    -- Residual is zero or exceeds tolerance or unposted: clear existing
    IF v_existing.journal_entry_id IS NOT NULL THEN
      DELETE FROM public.journal_entry_lines WHERE journal_entry_id = v_existing.journal_entry_id;
      DELETE FROM public.journal_entries WHERE id = v_existing.journal_entry_id;
    END IF;
    IF v_existing.id IS NOT NULL THEN
      DELETE FROM public.invoice_rounding_adjustments WHERE id = v_existing.id;
    END IF;
  END IF;

  PERFORM public.recalculate_purchase_invoice_payment_state(p_invoice_id);
END;
$$;

-- 5. Create clear_payment_allocation_rounding_adjustment
CREATE OR REPLACE FUNCTION public.clear_payment_allocation_rounding_adjustment(
  p_invoice_id uuid DEFAULT NULL::uuid,
  p_payment_voucher_id uuid DEFAULT NULL::uuid
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_existing record;
BEGIN
  FOR v_existing IN
    SELECT *
    FROM public.invoice_rounding_adjustments
    WHERE (p_invoice_id IS NOT NULL AND purchase_invoice_id = p_invoice_id)
       OR (p_payment_voucher_id IS NOT NULL AND payment_voucher_id = p_payment_voucher_id)
  LOOP
    IF v_existing.journal_entry_id IS NOT NULL THEN
      DELETE FROM public.journal_entry_lines WHERE journal_entry_id = v_existing.journal_entry_id;
      DELETE FROM public.journal_entries WHERE id = v_existing.journal_entry_id;
    END IF;

    DELETE FROM public.invoice_rounding_adjustments WHERE id = v_existing.id;
    IF v_existing.purchase_invoice_id IS NOT NULL THEN
      PERFORM public.recalculate_purchase_invoice_payment_state(v_existing.purchase_invoice_id);
    END IF;
  END LOOP;

  IF p_invoice_id IS NOT NULL THEN
    PERFORM public.recalculate_purchase_invoice_payment_state(p_invoice_id);
  END IF;
END;
$$;

-- 6. Update sync_purchase_invoice_payment_state_from_pv_posting trigger function
CREATE OR REPLACE FUNCTION public.sync_purchase_invoice_payment_state_from_pv_posting()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_invoice_id uuid;
BEGIN
  IF COALESCE(OLD.is_posted, FALSE) IS DISTINCT FROM COALESCE(NEW.is_posted, FALSE) THEN
    FOR v_invoice_id IN
      SELECT DISTINCT purchase_invoice_id
      FROM public.voucher_allocations
      WHERE payment_voucher_id = NEW.id
        AND voucher_type = 'payment'
        AND purchase_invoice_id IS NOT NULL
    LOOP
      IF NEW.is_posted = true THEN
        PERFORM public.apply_payment_allocation_rounding_adjustment(v_invoice_id, NEW.id);
      ELSE
        PERFORM public.clear_payment_allocation_rounding_adjustment(v_invoice_id, NEW.id);
      END IF;
    END LOOP;
  END IF;

  RETURN NEW;
END;
$$;

-- 7. Update cancel_payment_voucher_posting to cleanly clear adjustments
CREATE OR REPLACE FUNCTION public.cancel_payment_voucher_posting(
  p_pv_id uuid,
  p_cancelled_by uuid,
  p_reason text DEFAULT 'Posting cancelled by administrator'::text
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pv RECORD;
  v_je RECORD;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT * INTO v_pv FROM payment_vouchers WHERE id = p_pv_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payment voucher % not found', p_pv_id; END IF;
  IF NOT v_pv.is_posted THEN
    RAISE EXCEPTION 'Payment voucher % is not posted', COALESCE(v_pv.voucher_number, p_pv_id::TEXT);
  END IF;

  SELECT * INTO v_je FROM journal_entries WHERE id = v_pv.journal_entry_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No journal entry found for payment voucher %', v_pv.voucher_number;
  END IF;

  -- Clear any settlement adjustments linked to this payment voucher
  PERFORM public.clear_payment_allocation_rounding_adjustment(NULL, p_pv_id);

  -- Clear the FK reference FIRST so cancel_gl_posting can delete the JE row
  UPDATE payment_vouchers
  SET is_posted = FALSE, journal_entry_id = NULL
  WHERE id = p_pv_id;

  PERFORM cancel_gl_posting(
    v_je.id, p_pv_id, 'payment_vouchers', p_cancelled_by, p_reason,
    jsonb_build_object(
      'voucher_number', v_pv.voucher_number,
      'amount',         v_pv.amount,
      'is_posted',      TRUE
    )
  );
END;
$$;

-- 8. Enhance customer receipt rounding function to support discount/write_off distinction
CREATE OR REPLACE FUNCTION public.apply_receipt_allocation_rounding_adjustment(
  p_invoice_id uuid,
  p_receipt_voucher_id uuid DEFAULT NULL::uuid,
  p_adjustment_type text DEFAULT 'rounding',
  p_reason text DEFAULT 'invoice_rounding_tolerance',
  p_amount numeric DEFAULT NULL::numeric
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_invoice record;
  v_allocated numeric(18,2);
  v_residual numeric(18,2);
  v_tolerance numeric(18,2);
  v_existing record;
  v_entry_id uuid;
  v_entry_number text;
  v_ar_account_id uuid;
  v_adjustment_account_id uuid;
  v_user_id uuid;
  v_target_rv_id uuid;
  v_has_posted_allocations boolean := false;
  v_adj_amount numeric(18,2);
  v_adj_type text;
  v_adj_reason text;
BEGIN
  SELECT *
  INTO v_invoice
  FROM public.sales_invoices
  WHERE id = p_invoice_id
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
  WHERE sales_invoice_id = p_invoice_id
  LIMIT 1;

  v_allocated := public.get_invoice_allocation_amount(p_invoice_id, NULL);

  SELECT EXISTS (
    SELECT 1 
    FROM public.voucher_allocations va
    JOIN public.receipt_vouchers rv ON rv.id = va.receipt_voucher_id
    WHERE va.sales_invoice_id = p_invoice_id
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
    WHERE va.sales_invoice_id = p_invoice_id
      AND va.voucher_type = 'receipt'
      AND rv.is_posted = true
    ORDER BY rv.created_at DESC
    LIMIT 1;
  ELSE
    v_target_rv_id := NULL;
  END IF;

  v_residual := ROUND(COALESCE(v_invoice.total_amount, 0) - COALESCE(v_allocated, 0), 2);

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

  IF v_adj_type IN ('discount', 'write_off') AND (v_adj_reason IS NULL OR TRIM(v_adj_reason) = '' OR v_adj_reason = 'invoice_rounding_tolerance') THEN
    RAISE EXCEPTION 'A valid reason is required for discount or write-off settlement adjustments';
  END IF;

  IF ABS(v_adj_amount) > 0 AND v_has_posted_allocations THEN
    IF v_existing.id IS NOT NULL 
       AND v_existing.adjustment_amount = v_adj_amount 
       AND v_existing.adjustment_type = v_adj_type THEN
      PERFORM public.recalculate_sales_invoice_payment_state(p_invoice_id);
      RETURN;
    END IF;

    IF v_existing.journal_entry_id IS NOT NULL THEN
      DELETE FROM public.journal_entry_lines WHERE journal_entry_id = v_existing.journal_entry_id;
      DELETE FROM public.journal_entries WHERE id = v_existing.journal_entry_id;
    END IF;
    IF v_existing.id IS NOT NULL THEN
      DELETE FROM public.invoice_rounding_adjustments WHERE id = v_existing.id;
    END IF;

    -- AR Account 1120
    SELECT id INTO v_ar_account_id
    FROM public.chart_of_accounts
    WHERE code = '1120'
    LIMIT 1;

    IF v_adj_type = 'rounding' THEN
      IF v_adj_amount > 0 THEN
        -- Customer short payment under tolerance: write-off expense
        SELECT COALESCE(
          (SELECT rounding_writeoff_account_id FROM public.app_settings LIMIT 1),
          (SELECT id FROM public.chart_of_accounts WHERE code = '6900' LIMIT 1)
        ) INTO v_adjustment_account_id;
      ELSE
        -- Customer overpayment under tolerance: rounding gain
        SELECT COALESCE(
          (SELECT rounding_gain_account_id FROM public.app_settings LIMIT 1),
          (SELECT id FROM public.chart_of_accounts WHERE code = '4900' LIMIT 1)
        ) INTO v_adjustment_account_id;
      END IF;
    ELSIF v_adj_type IN ('discount', 'write_off') THEN
      IF v_adj_amount > 0 THEN
        -- Commercial sales discount granted: debit Sales Discounts (4200)
        SELECT COALESCE(
          (SELECT id FROM public.chart_of_accounts WHERE code = '4200' LIMIT 1),
          (SELECT id FROM public.chart_of_accounts WHERE code = '6900' LIMIT 1)
        ) INTO v_adjustment_account_id;
      ELSE
        SELECT id INTO v_adjustment_account_id
        FROM public.chart_of_accounts
        WHERE code = '4900'
        LIMIT 1;
      END IF;
    END IF;

    IF v_ar_account_id IS NULL OR v_adjustment_account_id IS NULL THEN
      RAISE EXCEPTION 'Missing COA setup for sales invoice settlement adjustment';
    END IF;

    v_user_id := COALESCE(auth.uid(), v_invoice.created_by);
    v_entry_number := public.next_journal_entry_number();

    INSERT INTO public.journal_entries (
      entry_number, entry_date, source_module, reference_id, reference_number,
      description, total_debit, total_credit, is_posted, posted_by, created_by
    ) VALUES (
      v_entry_number,
      COALESCE(v_invoice.invoice_date, CURRENT_DATE),
      'sales_invoice_rounding',
      v_invoice.id,
      v_invoice.invoice_number,
      'Receipt settlement ' || v_adj_type || ' adjustment: ' || v_invoice.invoice_number,
      ABS(v_adj_amount),
      ABS(v_adj_amount),
      true,
      v_user_id,
      v_user_id
    )
    RETURNING id INTO v_entry_id;

    IF v_adj_amount > 0 THEN
      -- Customer underpaid: Debit Sales Discount/Expense, Credit AR (1120)
      INSERT INTO public.journal_entry_lines (journal_entry_id, line_number, account_id, description, debit, credit, customer_id)
      VALUES
        (v_entry_id, 1, v_adjustment_account_id, INITCAP(v_adj_type) || ' - ' || v_invoice.invoice_number, ABS(v_adj_amount), 0, v_invoice.customer_id),
        (v_entry_id, 2, v_ar_account_id, 'A/R settlement clearance - ' || v_invoice.invoice_number, 0, ABS(v_adj_amount), v_invoice.customer_id);
    ELSE
      -- Customer overpaid: Debit AR (1120), Credit Gain
      INSERT INTO public.journal_entry_lines (journal_entry_id, line_number, account_id, description, debit, credit, customer_id)
      VALUES
        (v_entry_id, 1, v_ar_account_id, 'A/R settlement clearance - ' || v_invoice.invoice_number, ABS(v_adj_amount), 0, v_invoice.customer_id),
        (v_entry_id, 2, v_adjustment_account_id, INITCAP(v_adj_type) || ' - ' || v_invoice.invoice_number, 0, ABS(v_adj_amount), v_invoice.customer_id);
    END IF;

    INSERT INTO public.invoice_rounding_adjustments (
      receipt_voucher_id, sales_invoice_id, adjustment_amount, adjustment_type, reason, journal_entry_id, created_by
    ) VALUES (
      v_target_rv_id, p_invoice_id, v_adj_amount, v_adj_type, v_adj_reason, v_entry_id, v_user_id
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

  PERFORM public.recalculate_sales_invoice_payment_state(p_invoice_id);
END;
$$;

-- 9. Create unified RPC for settlement adjustments
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
  ELSIF p_document_type = 'sales' THEN
    PERFORM public.apply_receipt_allocation_rounding_adjustment(
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

-- 10. Grant permissions to authenticated and service_role
REVOKE ALL ON FUNCTION public.get_purchase_invoice_rounding_adjustment_amount(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_purchase_invoice_rounding_adjustment_amount(uuid) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.apply_payment_allocation_rounding_adjustment(uuid, uuid, text, text, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apply_payment_allocation_rounding_adjustment(uuid, uuid, text, text, numeric) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.clear_payment_allocation_rounding_adjustment(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.clear_payment_allocation_rounding_adjustment(uuid, uuid) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.sync_purchase_invoice_payment_state_from_pv_posting() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sync_purchase_invoice_payment_state_from_pv_posting() TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.save_invoice_settlement_adjustment(text, uuid, uuid, numeric, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_invoice_settlement_adjustment(text, uuid, uuid, numeric, text, text) TO authenticated, service_role;
