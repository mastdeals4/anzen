/*
  Root cause
  ----------
  enforce_sales_invoice_write_scope() guards against direct payment_status flips
  to 'paid' by checking:

      SELECT COALESCE(SUM(allocated_amount), 0)
      FROM voucher_allocations
      WHERE sales_invoice_id = NEW.id

  That sum excludes invoice_rounding_adjustments. However,
  recalculate_sales_invoice_payment_state() — called from
  apply_receipt_allocation_rounding_adjustment() inside the voucher_allocations
  trigger — correctly sets payment_status = 'paid' when:

      SUM(voucher_allocations) + SUM(invoice_rounding_adjustments) >= total_amount

  For an invoice of Rp 26,004,525 with Rp 26,004,500 allocated and a Rp 25
  rounding adjustment, recalculate_sales_invoice_payment_state sets
  payment_status = 'paid', then enforce_sales_invoice_write_scope fires and
  RAISES EXCEPTION because it sees only 26,004,500 < 26,004,525.

  The UI (ReceiptVoucherManager) and Sales.tsx already use the correct formula
  (allocation + rounding). The enforcement trigger was the only outlier.

  Fix
  ---
  Replace the manual SUM in enforce_sales_invoice_write_scope with a call to
  get_invoice_paid_amount(NEW.id), which is the canonical function used
  everywhere else:

      get_invoice_paid_amount(id) =
        get_invoice_allocation_amount(id, NULL)          -- voucher_allocations
        + get_invoice_rounding_adjustment_amount(id)     -- invoice_rounding_adjustments

  All three callers now use an identical formula. The security intent is
  preserved: an admin still cannot flip payment_status to 'paid' unless
  real cash received (allocations) plus an auditable rounding adjustment
  equals the invoice total.

  No regressions
  --------------
  - When there is no rounding adjustment: get_invoice_rounding_adjustment_amount
    returns 0, so get_invoice_paid_amount = SUM(voucher_allocations), identical
    to the old behaviour.
  - The pg_trigger_depth() > 1 bypass for cascading trigger chains is unchanged.
  - The role-based column-write guard (non-admin cannot touch payment_status,
    paid_amount, total_amount, customer_id) is unchanged.
  - get_invoice_paid_amount is SECURITY DEFINER with search_path = public,
    safe to call from inside a SECURITY DEFINER trigger.

  Not touched
  -----------
  - recalculate_sales_invoice_payment_state()
  - recalculate_invoice_payment_status()
  - apply_receipt_allocation_rounding_adjustment()
  - voucher_allocations, invoice_rounding_adjustments, receipt_vouchers tables
  - post_receipt_voucher RPC
  - Any report or ledger view
*/

CREATE OR REPLACE FUNCTION public.enforce_sales_invoice_write_scope()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role        text;
  v_paid_actual numeric;
BEGIN
  -- Cascading updates from other triggers (e.g. recalculate_invoice_payment_
  -- status on voucher_allocations) are trusted.
  IF pg_trigger_depth() > 1 THEN RETURN NEW; END IF;

  IF auth.role() = 'service_role' THEN RETURN NEW; END IF;

  SELECT role INTO v_role FROM public.user_profiles WHERE id = auth.uid();

  IF v_role NOT IN ('admin','accounts') THEN
    IF NEW.payment_status IS DISTINCT FROM OLD.payment_status
       OR NEW.paid_amount    IS DISTINCT FROM OLD.paid_amount
       OR NEW.total_amount   IS DISTINCT FROM OLD.total_amount
       OR NEW.customer_id    IS DISTINCT FROM OLD.customer_id THEN
      RAISE EXCEPTION 'Sales/warehouse cannot modify invoice financial fields (payment_status, paid_amount, total_amount, customer_id)';
    END IF;
  END IF;

  -- Guard against direct payment_status flip to 'paid' without matching funds.
  -- Uses get_invoice_paid_amount() = voucher_allocations + rounding_adjustments,
  -- the same formula used by recalculate_sales_invoice_payment_state() to SET
  -- the status. Both sides now use one identical calculation.
  IF NEW.payment_status = 'paid' AND NEW.payment_status IS DISTINCT FROM OLD.payment_status THEN
    SELECT public.get_invoice_paid_amount(NEW.id) INTO v_paid_actual;
    IF v_paid_actual < COALESCE(NEW.total_amount, 0) THEN
      RAISE EXCEPTION 'Cannot mark invoice paid: collected amount (%) < total (%). Allocate the remaining balance or apply a rounding adjustment within the configured tolerance.',
        v_paid_actual, NEW.total_amount;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- Re-attach the trigger (drop-recreate is idempotent).
DROP TRIGGER IF EXISTS trg_enforce_sales_invoice_write_scope ON public.sales_invoices;
CREATE TRIGGER trg_enforce_sales_invoice_write_scope
  BEFORE UPDATE ON public.sales_invoices
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_sales_invoice_write_scope();

DO $$
BEGIN
  RAISE NOTICE '============================================================';
  RAISE NOTICE 'Migration 20260723140000 applied:';
  RAISE NOTICE '  enforce_sales_invoice_write_scope() now uses';
  RAISE NOTICE '  get_invoice_paid_amount() (allocation + rounding_adjustment)';
  RAISE NOTICE '  instead of SUM(voucher_allocations) alone.';
  RAISE NOTICE '============================================================';
END $$;
