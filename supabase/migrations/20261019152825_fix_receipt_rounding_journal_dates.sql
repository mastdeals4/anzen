-- Migration: 20261019152825_fix_receipt_rounding_journal_dates.sql
-- Description: Align settlement rounding adjustment journal dates with payment/receipt voucher dates
-- Accounting Rule: Settlement adjustment journals must reflect the date of the payment or receipt transaction,
--                  never backdated to the original invoice date.
-- Fallback Rule: If the voucher date is genuinely unavailable, fallback to CURRENT_DATE, never backdated to invoice_date.

-- ============================================================================
-- 1. Overload 1: apply_receipt_allocation_rounding_adjustment(uuid, uuid)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.apply_receipt_allocation_rounding_adjustment(
  p_invoice_id uuid,
  p_receipt_voucher_id uuid DEFAULT NULL::uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
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
  v_voucher_date date;
BEGIN
  SELECT *
  INTO v_invoice
  FROM public.sales_invoices
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

  -- Fetch existing rounding adjustment for this invoice
  SELECT *
  INTO v_existing
  FROM public.invoice_rounding_adjustments
  WHERE sales_invoice_id = p_invoice_id
  LIMIT 1;

  -- Only POSTED receipt voucher allocations count
  v_allocated := public.get_invoice_allocation_amount(p_invoice_id, NULL);

  -- Check if any posted receipt allocation exists for this invoice
  SELECT EXISTS (
    SELECT 1 
    FROM public.voucher_allocations va
    JOIN public.receipt_vouchers rv ON rv.id = va.receipt_voucher_id
    WHERE va.sales_invoice_id = p_invoice_id
      AND va.voucher_type = 'receipt'
      AND rv.is_posted = true
  ) INTO v_has_posted_allocations;

  -- If p_receipt_voucher_id is supplied, ensure it is posted; otherwise select latest posted RV
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

  -- Resolve receipt voucher date (fall back to CURRENT_DATE if genuinely unavailable; never invoice_date)
  IF v_target_rv_id IS NOT NULL THEN
    SELECT voucher_date INTO v_voucher_date
    FROM public.receipt_vouchers
    WHERE id = v_target_rv_id;
  END IF;

  v_residual := ROUND(COALESCE(v_invoice.total_amount, 0) - COALESCE(v_allocated, 0), 2);

  -- Small residual within tolerance requires posted payment activity
  IF ABS(v_residual) > 0 AND ABS(v_residual) <= v_tolerance AND v_has_posted_allocations THEN
    -- If already correctly adjusted, just ensure payment state is synced and return
    IF v_existing.id IS NOT NULL AND v_existing.adjustment_amount = v_residual THEN
      IF v_existing.journal_entry_id IS NOT NULL AND v_voucher_date IS NOT NULL THEN
        UPDATE public.journal_entries
        SET entry_date = v_voucher_date
        WHERE id = v_existing.journal_entry_id AND entry_date <> v_voucher_date;
      END IF;
      PERFORM public.recalculate_sales_invoice_payment_state(p_invoice_id);
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

    SELECT id INTO v_ar_account_id
    FROM public.chart_of_accounts
    WHERE code = '1120'
    LIMIT 1;

    IF v_residual > 0 THEN
      SELECT COALESCE(
        (SELECT rounding_writeoff_account_id FROM public.app_settings LIMIT 1),
        (SELECT id FROM public.chart_of_accounts WHERE code = '6900' LIMIT 1)
      )
      INTO v_adjustment_account_id;
    ELSE
      SELECT COALESCE(
        (SELECT rounding_gain_account_id FROM public.app_settings LIMIT 1),
        (SELECT id FROM public.chart_of_accounts WHERE code = '4900' LIMIT 1)
      )
      INTO v_adjustment_account_id;
    END IF;

    IF v_ar_account_id IS NULL OR v_adjustment_account_id IS NULL THEN
      RAISE EXCEPTION 'Missing account setup for invoice rounding adjustment';
    END IF;

    v_user_id := COALESCE(auth.uid(), v_invoice.created_by);
    v_entry_number := public.next_journal_entry_number();

    INSERT INTO public.journal_entries (
      entry_number, entry_date, source_module, reference_id, reference_number,
      description, total_debit, total_credit, is_posted, posted_by, created_by
    ) VALUES (
      v_entry_number,
      COALESCE(v_voucher_date, CURRENT_DATE),
      'sales_invoice_rounding',
      v_invoice.id,
      v_invoice.invoice_number,
      'Receipt allocation rounding adjustment: ' || v_invoice.invoice_number,
      ABS(v_residual),
      ABS(v_residual),
      true,
      v_user_id,
      v_user_id
    )
    RETURNING id INTO v_entry_id;

    IF v_residual > 0 THEN
      INSERT INTO public.journal_entry_lines (journal_entry_id, line_number, account_id, description, debit, credit, customer_id)
      VALUES
        (v_entry_id, 1, v_adjustment_account_id, 'Rounding write-off - ' || v_invoice.invoice_number, ABS(v_residual), 0, v_invoice.customer_id),
        (v_entry_id, 2, v_ar_account_id, 'A/R rounding clearance - ' || v_invoice.invoice_number, 0, ABS(v_residual), v_invoice.customer_id);
    ELSE
      INSERT INTO public.journal_entry_lines (journal_entry_id, line_number, account_id, description, debit, credit, customer_id)
      VALUES
        (v_entry_id, 1, v_ar_account_id, 'A/R rounding clearance - ' || v_invoice.invoice_number, ABS(v_residual), 0, v_invoice.customer_id),
        (v_entry_id, 2, v_adjustment_account_id, 'Rounding gain - ' || v_invoice.invoice_number, 0, ABS(v_residual), v_invoice.customer_id);
    END IF;

    INSERT INTO public.invoice_rounding_adjustments (
      receipt_voucher_id, sales_invoice_id, adjustment_amount, journal_entry_id, created_by
    ) VALUES (
      v_target_rv_id, p_invoice_id, v_residual, v_entry_id, v_user_id
    );
  ELSE
    -- Residual is zero or exceeds tolerance or no posted payments: clear any existing rounding
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
$function$;


-- ============================================================================
-- 2. Overload 2: apply_receipt_allocation_rounding_adjustment(uuid, uuid, text, text, numeric)
-- ============================================================================
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
  v_voucher_date date;
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

  -- Resolve receipt voucher date (fall back to CURRENT_DATE if genuinely unavailable; never invoice_date)
  IF v_target_rv_id IS NOT NULL THEN
    SELECT voucher_date INTO v_voucher_date
    FROM public.receipt_vouchers
    WHERE id = v_target_rv_id;
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
      IF v_existing.journal_entry_id IS NOT NULL AND v_voucher_date IS NOT NULL THEN
        UPDATE public.journal_entries
        SET entry_date = v_voucher_date
        WHERE id = v_existing.journal_entry_id AND entry_date <> v_voucher_date;
      END IF;
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
      COALESCE(v_voucher_date, CURRENT_DATE),
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


-- ============================================================================
-- 3. Purchase function: apply_payment_allocation_rounding_adjustment
-- ============================================================================
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
  v_voucher_date date;
BEGIN
  SELECT *
  INTO v_invoice
  FROM public.purchase_invoices
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
  WHERE purchase_invoice_id = p_invoice_id
  LIMIT 1;

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

  -- Resolve payment voucher date (fall back to CURRENT_DATE if unavailable; never invoice_date)
  IF v_target_pv_id IS NOT NULL THEN
    SELECT voucher_date INTO v_voucher_date
    FROM public.payment_vouchers
    WHERE id = v_target_pv_id;
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
      IF v_existing.journal_entry_id IS NOT NULL AND v_voucher_date IS NOT NULL THEN
        UPDATE public.journal_entries
        SET entry_date = v_voucher_date
        WHERE id = v_existing.journal_entry_id AND entry_date <> v_voucher_date;
      END IF;
      PERFORM public.recalculate_purchase_invoice_payment_state(p_invoice_id);
      RETURN;
    END IF;

    IF v_existing.journal_entry_id IS NOT NULL THEN
      DELETE FROM public.journal_entry_lines WHERE journal_entry_id = v_existing.journal_entry_id;
      DELETE FROM public.journal_entries WHERE id = v_existing.journal_entry_id;
    END IF;
    IF v_existing.id IS NOT NULL THEN
      DELETE FROM public.invoice_rounding_adjustments WHERE id = v_existing.id;
    END IF;

    -- Accounts Payable: Account 2110
    SELECT id INTO v_ap_account_id
    FROM public.chart_of_accounts
    WHERE code = '2110'
    LIMIT 1;

    IF v_adj_type = 'rounding' THEN
      IF v_adj_amount > 0 THEN
        -- Residual balance settled as Rounding Gain (4900)
        SELECT COALESCE(
          (SELECT rounding_gain_account_id FROM public.app_settings LIMIT 1),
          (SELECT id FROM public.chart_of_accounts WHERE code = '4900' LIMIT 1)
        ) INTO v_adjustment_account_id;
      ELSE
        -- Overpayment under tolerance absorbed as Rounding Write-off (6900)
        SELECT COALESCE(
          (SELECT rounding_writeoff_account_id FROM public.app_settings LIMIT 1),
          (SELECT id FROM public.chart_of_accounts WHERE code = '6900' LIMIT 1)
        ) INTO v_adjustment_account_id;
      END IF;
    ELSIF v_adj_type IN ('discount', 'write_off') THEN
      IF v_adj_amount > 0 THEN
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
      COALESCE(v_voucher_date, CURRENT_DATE),
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
      INSERT INTO public.journal_entry_lines (journal_entry_id, line_number, account_id, description, debit, credit, supplier_id)
      VALUES
        (v_entry_id, 1, v_ap_account_id, 'A/P settlement clearance - ' || v_invoice.invoice_number, ABS(v_adj_amount), 0, v_invoice.supplier_id),
        (v_entry_id, 2, v_adjustment_account_id, INITCAP(v_adj_type) || ' - ' || v_invoice.invoice_number, 0, ABS(v_adj_amount), v_invoice.supplier_id);
    ELSE
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


-- ============================================================================
-- 4. Idempotent historical sales rounding journal date reconciliation
-- ============================================================================
-- Aligns the 4 historical sales rounding journals with their triggering receipt voucher dates.
-- Guarded with entry_date <> target_date so re-running this migration is a zero-row no-op and never creates duplicates.
UPDATE public.journal_entries
SET entry_date = '2026-01-15'
WHERE entry_number = 'JE2608-0157' AND entry_date <> '2026-01-15';

UPDATE public.journal_entries
SET entry_date = '2026-06-10'
WHERE entry_number = 'JE2609-0450' AND entry_date <> '2026-06-10';

UPDATE public.journal_entries
SET entry_date = '2026-07-23'
WHERE entry_number = 'JE2607-0036' AND entry_date <> '2026-07-23';

UPDATE public.journal_entries
SET entry_date = '2026-08-24'
WHERE entry_number = 'JE2608-0065' AND entry_date <> '2026-08-24';
