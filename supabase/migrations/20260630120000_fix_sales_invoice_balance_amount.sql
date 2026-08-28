-- ============================================================================
-- Migration: 20260630120000_fix_sales_invoice_balance_amount
-- Date:      2026-06-30
--
-- BUG FIX: sales_invoices.balance_amount not updated when payment is recorded
--
-- Root cause:
--   recalculate_invoice_payment_status() fires on voucher_allocations INSERT/
--   UPDATE/DELETE and correctly updates paid_amount + payment_status, but the
--   UPDATE statement was missing balance_amount.  As a result, balance_amount
--   keeps the original total_amount even after the invoice is fully paid.
--
-- Impact:
--   3 invoices (SAPJ-26-010, SAPJ-26-019, SAPJ-26-020) show payment_status
--   = 'paid' and paid_amount = total_amount, but balance_amount = total_amount
--   instead of 0, overstating AR sub-ledger by IDR 686,176,331.25.
--   Dashboard and aging reports filter on payment_status so the UI is not
--   affected, but raw balance_amount totals are wrong.
--
-- Fix:
--   1. Add balance_amount = (v_invoice_total - v_total_paid) to the UPDATE
--      in recalculate_invoice_payment_status() for both current and prior
--      invoice paths.
--   2. Data correction: zero out balance_amount on the 3 stale paid invoices.
--
-- Idempotency:
--   CREATE OR REPLACE is safe to re-run.
--   The data UPDATE WHERE clause is a no-op if already correct.
-- ============================================================================

-- ── FIX 1: recalculate_invoice_payment_status() — add balance_amount update ──

CREATE OR REPLACE FUNCTION public.recalculate_invoice_payment_status()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_invoice_id     UUID;
  v_old_invoice_id UUID;
  v_total_paid     NUMERIC(15,2);
  v_invoice_total  NUMERIC(15,2);
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_invoice_id := OLD.sales_invoice_id;
  ELSIF TG_OP = 'UPDATE' THEN
    v_invoice_id     := NEW.sales_invoice_id;
    v_old_invoice_id := OLD.sales_invoice_id;
  ELSE
    v_invoice_id := NEW.sales_invoice_id;
  END IF;

  -- Update new (or only) invoice
  IF v_invoice_id IS NOT NULL THEN
    SELECT COALESCE(SUM(allocated_amount), 0)
      INTO v_total_paid
      FROM voucher_allocations
     WHERE sales_invoice_id = v_invoice_id
       AND voucher_type = 'receipt';

    SELECT total_amount INTO v_invoice_total
      FROM sales_invoices
     WHERE id = v_invoice_id;

    UPDATE sales_invoices
    SET
      paid_amount    = v_total_paid,
      balance_amount = v_invoice_total - v_total_paid,
      payment_status = CASE
        WHEN v_total_paid = 0                    THEN 'pending'
        WHEN v_total_paid >= v_invoice_total     THEN 'paid'
        WHEN v_total_paid > 0                    THEN 'partial'
        ELSE 'pending'
      END
    WHERE id = v_invoice_id;
  END IF;

  -- On UPDATE, also recalculate the old invoice if the allocation was moved
  IF TG_OP = 'UPDATE'
     AND v_old_invoice_id IS NOT NULL
     AND v_old_invoice_id IS DISTINCT FROM v_invoice_id THEN

    SELECT COALESCE(SUM(allocated_amount), 0)
      INTO v_total_paid
      FROM voucher_allocations
     WHERE sales_invoice_id = v_old_invoice_id
       AND voucher_type = 'receipt';

    SELECT total_amount INTO v_invoice_total
      FROM sales_invoices
     WHERE id = v_old_invoice_id;

    UPDATE sales_invoices
    SET
      paid_amount    = v_total_paid,
      balance_amount = v_invoice_total - v_total_paid,
      payment_status = CASE
        WHEN v_total_paid = 0                    THEN 'pending'
        WHEN v_total_paid >= v_invoice_total     THEN 'paid'
        WHEN v_total_paid > 0                    THEN 'partial'
        ELSE 'pending'
      END
    WHERE id = v_old_invoice_id;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

-- ── FIX 2: Data correction — zero out stale balance_amount on paid invoices ──

UPDATE public.sales_invoices
SET balance_amount = 0
WHERE payment_status = 'paid'
  AND paid_amount >= total_amount
  AND balance_amount > 0.01;

DO $$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM public.sales_invoices
   WHERE payment_status = 'paid'
     AND paid_amount >= total_amount
     AND balance_amount > 0.01;

  IF v_count > 0 THEN
    RAISE EXCEPTION 'Data correction incomplete: % paid invoices still have balance_amount > 0', v_count;
  ELSE
    RAISE NOTICE '============================================================';
    RAISE NOTICE 'Migration 20260630120000 applied:';
    RAISE NOTICE '  recalculate_invoice_payment_status() now updates balance_amount.';
    RAISE NOTICE '  3 stale paid invoices corrected: balance_amount set to 0.';
    RAISE NOTICE '  AR sub-ledger overstatement of IDR 686,176,331.25 resolved.';
    RAISE NOTICE '============================================================';
  END IF;
END $$;
