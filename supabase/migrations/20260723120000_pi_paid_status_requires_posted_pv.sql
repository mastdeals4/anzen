/*
  Fix: Purchase Invoice was marked "Paid" as soon as a Payment Voucher was
  SAVED (with allocations totalling the invoice), even when the PV had
  never been posted to the GL. Bank Reconciliation then correctly refused
  to link that PV because it has no journal_entry_id, giving the
  internally inconsistent experience:

      PI = Paid    PV = Not Posted    BankRec = Cannot reconcile

  Root cause:
    recalculate_purchase_invoice_payment_state() (mig 20260619130000)
    summed voucher_allocations.allocated_amount without checking whether
    the parent payment_voucher is posted. So the paid-status flipped at
    Save time — not at Post time — decoupling PI.status from PV.is_posted.

  Smallest safe fix (this migration):

    1. Replace recalculate_purchase_invoice_payment_state() so its SUM
       joins payment_vouchers and requires is_posted = TRUE. Nothing else
       in the function changes.

    2. Add an AFTER UPDATE trigger on payment_vouchers that re-runs the
       recalc for every PI allocated by that PV whenever is_posted
       transitions (FALSE → TRUE on Post, TRUE → FALSE on Cancel-Post).
       Without this, the new filter would only take effect the next time
       an allocation was edited.

    3. Backfill: replay the (now-fixed) recalc for every PI that has any
       payment allocation, so the live DB immediately reflects correct
       Paid / Partial / Unpaid states.

  Explicitly NOT changed:

    - BEFORE INSERT trigger `trg_post_payment_voucher` and its function
      `post_payment_voucher_journal` — untouched. Existing posted PVs
      whose journal_entry_id points at a trigger-created JE keep working
      identically. No journal entries are deleted, orphaned, or created
      by this migration.

    - RPCs post_payment_voucher, cancel_payment_voucher_posting,
      save_payment_voucher_with_allocations,
      delete_payment_voucher_with_allocations — untouched. The new
      is_posted trigger fires no matter which path flips the column,
      including any future path, so no RPC needs to know about the
      recalc.

    - Chart of accounts, journal_entries, journal_entry_lines,
      voucher_allocations, bank_statement_lines — untouched.

    - Reports, ledgers, dashboards — untouched. They already read
      purchase_invoices.status and payment_vouchers.is_posted, both of
      which continue to have the same semantics; only the derivation of
      status is corrected.

  Data consequence to expect after apply:
    Purchase invoices whose only allocations are from *unposted* PVs
    will revert from 'paid' → 'unpaid' (or 'partial') on the backfill
    line below. To restore them to 'paid', Post the underlying PV via
    PaymentVoucherManager. This is the intended accounting behaviour.
*/

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

  -- Only count allocations whose parent payment voucher is POSTED to GL.
  -- A saved-but-unposted PV is a draft: its allocations represent intent,
  -- not a completed payment. Was the sole diff vs. the previous version.
  SELECT COALESCE(SUM(va.allocated_amount), 0)
  INTO v_total_paid
  FROM public.voucher_allocations va
  JOIN public.payment_vouchers pv
    ON pv.id = va.payment_voucher_id
  WHERE va.purchase_invoice_id = p_purchase_invoice_id
    AND va.voucher_type = 'payment'
    AND pv.is_posted = TRUE;

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


-- Re-derive PI paid-status whenever a PV's posting state flips.
-- Fires only on real transitions (FALSE→TRUE on Post, TRUE→FALSE on Cancel).
CREATE OR REPLACE FUNCTION public.sync_pi_state_on_pv_posting_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
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
      PERFORM public.recalculate_purchase_invoice_payment_state(v_invoice_id);
    END LOOP;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_pi_state_on_pv_posting_change ON public.payment_vouchers;
CREATE TRIGGER trg_sync_pi_state_on_pv_posting_change
  AFTER UPDATE OF is_posted ON public.payment_vouchers
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_pi_state_on_pv_posting_change();


-- Backfill: replay recalc on every PI touched by any payment allocation
-- so the live DB immediately reflects the corrected derivation. Idempotent —
-- safe to re-run.
DO $$
DECLARE
  v_invoice_id uuid;
BEGIN
  FOR v_invoice_id IN
    SELECT DISTINCT purchase_invoice_id
    FROM public.voucher_allocations
    WHERE voucher_type = 'payment'
      AND purchase_invoice_id IS NOT NULL
  LOOP
    PERFORM public.recalculate_purchase_invoice_payment_state(v_invoice_id);
  END LOOP;
END $$;


REVOKE ALL ON FUNCTION public.recalculate_purchase_invoice_payment_state(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.recalculate_purchase_invoice_payment_state(uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.sync_pi_state_on_pv_posting_change() FROM PUBLIC;
