/*
  # Backfill purchase invoice paid_amount from voucher_allocations

  ## Root cause
  PaymentVoucherManager (old code) updated paid_amount using a stale in-memory
  cached value:
    const newPaid = (invoice.paid_amount || 0) + alloc.amount;
  On edit/re-save this doubled the stored paid_amount, leaving balance_amount
  negative and status = 'paid' incorrectly.

  ## Confirmed bad rows (live examples at time of report)
    E0000311/2526:     total=33,600    stored paid=67,200    correct paid=33,600
    002/OR/SAPJ/IV/2026: total=10,514,070  stored paid=21,028,140  correct paid=10,514,070

  ## What this migration does
  1. CREATE OR REPLACE the recalculation function (idempotent — safe if 130000 already applied)
  2. Recreate the voucher_allocations trigger (idempotent)
  3. One-time backfill: recalculate paid_amount + status for ALL purchase invoices
     from SUM(voucher_allocations.allocated_amount) — the sole source of truth.
     balance_amount is GENERATED ALWAYS AS (total_amount - paid_amount) STORED,
     so it auto-corrects when paid_amount is fixed.

  ## Safety
  - No row is deleted. Only paid_amount and status are updated.
  - The UPDATE is idempotent: running it again produces the same result.
  - Do not touch payment_vouchers or voucher_allocations rows.
*/

-- ===========================================================================
-- 1. Recalculation function (idempotent)
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.recalculate_purchase_invoice_payment_state(p_purchase_invoice_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_invoice record;
  v_total_paid numeric(18,2);
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

  SELECT COALESCE(SUM(allocated_amount), 0)
  INTO v_total_paid
  FROM public.voucher_allocations
  WHERE purchase_invoice_id = p_purchase_invoice_id
    AND voucher_type = 'payment';

  UPDATE public.purchase_invoices
  SET
    paid_amount = v_total_paid,
    status = CASE
      WHEN v_total_paid <= 0 THEN 'unpaid'
      WHEN v_total_paid >= COALESCE(v_invoice.total_amount, 0) THEN 'paid'
      ELSE 'partial'
    END
  WHERE id = p_purchase_invoice_id;
END;
$$;

-- ===========================================================================
-- 2. Trigger function (idempotent via CREATE OR REPLACE)
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.sync_purchase_invoice_payment_state_from_allocations()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.purchase_invoice_id IS NOT NULL THEN
    PERFORM public.recalculate_purchase_invoice_payment_state(NEW.purchase_invoice_id);
  END IF;

  IF TG_OP IN ('UPDATE', 'DELETE') AND OLD.purchase_invoice_id IS NOT NULL THEN
    IF TG_OP = 'DELETE'
       OR OLD.purchase_invoice_id IS DISTINCT FROM NEW.purchase_invoice_id
       OR OLD.allocated_amount    IS DISTINCT FROM NEW.allocated_amount
       OR OLD.voucher_type        IS DISTINCT FROM NEW.voucher_type THEN
      PERFORM public.recalculate_purchase_invoice_payment_state(OLD.purchase_invoice_id);
    END IF;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_purchase_invoice_payment_state ON public.voucher_allocations;
CREATE TRIGGER trg_sync_purchase_invoice_payment_state
  AFTER INSERT OR UPDATE OR DELETE ON public.voucher_allocations
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_purchase_invoice_payment_state_from_allocations();

-- ===========================================================================
-- 3. PRE-FLIGHT: count invoices with stored paid_amount ≠ allocation sum
-- ===========================================================================
DO $$
DECLARE
  v_mismatched integer;
BEGIN
  SELECT COUNT(*)
  INTO v_mismatched
  FROM public.purchase_invoices pi
  JOIN (
    SELECT purchase_invoice_id, COALESCE(SUM(allocated_amount), 0) AS alloc_sum
    FROM public.voucher_allocations
    WHERE voucher_type = 'payment'
    GROUP BY purchase_invoice_id
  ) va ON va.purchase_invoice_id = pi.id
  WHERE ABS(pi.paid_amount - va.alloc_sum) > 0.009;

  RAISE NOTICE '[purchase_invoices] Invoices with paid_amount ≠ allocation sum before backfill: %', v_mismatched;
END $$;

-- ===========================================================================
-- 4. BACKFILL: recalculate paid_amount + status for ALL purchase invoices
--    from SUM(voucher_allocations) — the single source of truth.
--    balance_amount is GENERATED ALWAYS AS (total_amount - paid_amount) STORED
--    and auto-corrects without being touched directly.
-- ===========================================================================
UPDATE public.purchase_invoices pi
SET
  paid_amount = COALESCE(alloc.total_paid, 0),
  status = CASE
    WHEN COALESCE(alloc.total_paid, 0) <= 0             THEN 'unpaid'
    WHEN COALESCE(alloc.total_paid, 0) >= COALESCE(pi.total_amount, 0) THEN 'paid'
    ELSE 'partial'
  END
FROM (
  SELECT
    pi_inner.id,
    COALESCE(SUM(va.allocated_amount), 0) AS total_paid
  FROM public.purchase_invoices pi_inner
  LEFT JOIN public.voucher_allocations va
    ON  va.purchase_invoice_id = pi_inner.id
    AND va.voucher_type        = 'payment'
  GROUP BY pi_inner.id
) alloc
WHERE alloc.id = pi.id;

-- ===========================================================================
-- 5. POST-FLIGHT: confirm 0 mismatches remain
-- ===========================================================================
DO $$
DECLARE
  v_mismatched integer;
BEGIN
  SELECT COUNT(*)
  INTO v_mismatched
  FROM public.purchase_invoices pi
  JOIN (
    SELECT purchase_invoice_id, COALESCE(SUM(allocated_amount), 0) AS alloc_sum
    FROM public.voucher_allocations
    WHERE voucher_type = 'payment'
    GROUP BY purchase_invoice_id
  ) va ON va.purchase_invoice_id = pi.id
  WHERE ABS(pi.paid_amount - va.alloc_sum) > 0.009;

  RAISE NOTICE '[purchase_invoices] Invoices with paid_amount ≠ allocation sum after backfill: %  (must be 0)', v_mismatched;
END $$;

-- ===========================================================================
-- VERIFICATION SQL — run these after applying the migration
-- ===========================================================================

-- V1. Both reported bad invoices — should show paid_amount = total_amount, balance = 0
-- SELECT invoice_number, total_amount, paid_amount, balance_amount, status
-- FROM public.purchase_invoices
-- WHERE invoice_number IN ('E0000311/2526', '002/OR/SAPJ/IV/2026')
-- ORDER BY invoice_number;

-- V2. All invoices where stored paid_amount still differs from allocation sum (must be 0 rows)
-- SELECT
--   pi.invoice_number,
--   pi.total_amount,
--   pi.paid_amount                    AS stored_paid,
--   COALESCE(va.alloc_sum, 0)         AS correct_paid,
--   pi.paid_amount - COALESCE(va.alloc_sum, 0) AS delta,
--   pi.status
-- FROM public.purchase_invoices pi
-- LEFT JOIN (
--   SELECT purchase_invoice_id, SUM(allocated_amount) AS alloc_sum
--   FROM public.voucher_allocations
--   WHERE voucher_type = 'payment'
--   GROUP BY purchase_invoice_id
-- ) va ON va.purchase_invoice_id = pi.id
-- WHERE ABS(pi.paid_amount - COALESCE(va.alloc_sum, 0)) > 0.009
-- ORDER BY pi.invoice_number;

-- V3. Invoices with negative balance_amount (should return 0 rows after fix)
-- SELECT invoice_number, total_amount, paid_amount, balance_amount, status
-- FROM public.purchase_invoices
-- WHERE balance_amount < -0.009
-- ORDER BY balance_amount;

-- V4. Duplicate voucher_allocations check (same voucher + same invoice — should be 0 rows)
-- SELECT payment_voucher_id, purchase_invoice_id, COUNT(*) AS dup_count
-- FROM public.voucher_allocations
-- WHERE voucher_type = 'payment' AND purchase_invoice_id IS NOT NULL
-- GROUP BY payment_voucher_id, purchase_invoice_id
-- HAVING COUNT(*) > 1;
