import { execFileSync } from 'node:child_process';

function runSql(sql) {
  const stdout = execFileSync('supabase', ['db', 'query', '--linked', '--output-format', 'json', sql], {
    cwd: '/Users/Kunal/Documents/anzen-main',
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
  });
  const res = JSON.parse(stdout);
  if (res.error) throw new Error(res.error.message || JSON.stringify(res.error));
  return res.rows || [];
}

console.log('Applying database kernel hardening for automatic AR rounding...');

// 1. Update apply_receipt_allocation_rounding_adjustment:
// - Ensure it only considers POSTED receipts for rounding
// - If p_receipt_voucher_id is supplied, verify it is posted; if not posted, ignore it
// - If residual is within tolerance, create/update exactly one adjustment and journal idempotently
// - If residual is zero or exceeds tolerance, remove any existing adjustment and journal
runSql(`
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

  v_residual := ROUND(COALESCE(v_invoice.total_amount, 0) - COALESCE(v_allocated, 0), 2);

  -- Small residual within tolerance requires posted payment activity
  IF ABS(v_residual) > 0 AND ABS(v_residual) <= v_tolerance AND v_has_posted_allocations THEN
    -- If already correctly adjusted, just ensure payment state is synced and return
    IF v_existing.id IS NOT NULL AND v_existing.adjustment_amount = v_residual THEN
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
      COALESCE(v_invoice.invoice_date, CURRENT_DATE),
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
`);

console.log('✅ apply_receipt_allocation_rounding_adjustment hardened');

// 2. Update sync_si_state_on_rv_posting_change to call apply_receipt_allocation_rounding_adjustment
runSql(`
CREATE OR REPLACE FUNCTION public.sync_si_state_on_rv_posting_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_invoice_id uuid;
BEGIN
  IF COALESCE(OLD.is_posted, FALSE) IS DISTINCT FROM COALESCE(NEW.is_posted, FALSE) THEN
    FOR v_invoice_id IN
      SELECT DISTINCT sales_invoice_id
      FROM public.voucher_allocations
      WHERE receipt_voucher_id = NEW.id
        AND voucher_type = 'receipt'
        AND sales_invoice_id IS NOT NULL
    LOOP
      PERFORM public.apply_receipt_allocation_rounding_adjustment(v_invoice_id, NEW.id);
    END LOOP;
  END IF;

  RETURN NEW;
END;
$function$;
`);

console.log('✅ sync_si_state_on_rv_posting_change updated to handle automatic rounding lifecycle');
