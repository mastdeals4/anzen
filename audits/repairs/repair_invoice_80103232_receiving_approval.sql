-- ============================================================================
-- AUDIT REPAIR SCRIPT (UNAPPLIED — REQUIRES EXPLICIT USER AUTHORIZATION)
-- Target: Purchase Invoice 80103232 (UUID: f71fc7e1-f666-4a61-8eaa-7edf42127238)
-- Supplier: Menjangan Sakti
-- PO: PO-2610-0001 (UUID: 5a523c05-f269-4710-9344-793d96ef8f03)
-- Journal Entry: e9bec20a-6e46-4b11-bf61-6796182751ed
--
-- Incident B Cause:
-- Invoice was validly approved on 19-Oct-2026 by user 1075a773-bb55-4296-bc71-af2eab9a0780.
-- During inward receiving on 26-Oct-2026 (500 kg received), receive_purchase_invoice_item()
-- updated purchase_invoice_items.batch_id. The unconstrained trigger
-- trg_reset_receiving_approval_on_item_change inadvertently reset receiving_approval_status
-- to 'pending_approval' while leaving historical approval timestamps intact.
--
-- This script safely reconciles receiving_approval_status back to 'approved'.
-- DO NOT EXECUTE DIRECTLY AS PART OF CODE IMPLEMENTATION.
-- ============================================================================

BEGIN;

DO $$
DECLARE
  v_inv public.purchase_invoices%ROWTYPE;
  v_alloc_count integer;
  v_alloc_qty numeric;
BEGIN
  -- 1. Verify invoice existence and current inconsistent state
  SELECT * INTO v_inv
    FROM public.purchase_invoices
   WHERE id = 'f71fc7e1-f666-4a61-8eaa-7edf42127238'
     AND invoice_number = '80103232'
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Purchase Invoice 80103232 not found with specified UUID';
  END IF;

  IF v_inv.receiving_approval_status <> 'pending_approval' THEN
    RAISE EXCEPTION 'Precondition failed: Expected status pending_approval, found %', v_inv.receiving_approval_status;
  END IF;

  IF v_inv.receiving_approved_at IS NULL OR v_inv.receiving_approved_by IS NULL THEN
    RAISE EXCEPTION 'Precondition failed: Missing historical approval metadata';
  END IF;

  -- 2. Verify receiving allocation integrity
  SELECT count(*), COALESCE(sum(received_quantity), 0)
    INTO v_alloc_count, v_alloc_qty
    FROM public.purchase_invoice_receiving_allocations
   WHERE purchase_invoice_id = v_inv.id;

  IF v_alloc_count = 0 OR v_alloc_qty <= 0 THEN
    RAISE EXCEPTION 'Precondition failed: No receiving allocations found for received invoice';
  END IF;

  -- 3. Verify no outstanding rejection exists
  IF EXISTS (SELECT 1 FROM public.purchase_invoice_inward_rejections WHERE purchase_invoice_id = v_inv.id) THEN
    RAISE EXCEPTION 'Precondition failed: Rejection record exists for invoice';
  END IF;

  -- 4. Audit the reconciliation
  INSERT INTO public.purchase_invoice_receiving_approval_audit (
    purchase_invoice_id,
    action,
    previous_status,
    new_status,
    approved_by,
    approved_at,
    reason,
    actor_id
  ) VALUES (
    v_inv.id,
    'reconciled_after_trigger_fix',
    'pending_approval',
    'approved',
    v_inv.receiving_approved_by,
    v_inv.receiving_approved_at,
    'Reconcile receiving_approval_status demoted by legacy operational item update trigger',
    auth.uid()
  );

  -- 5. Restore approved status
  UPDATE public.purchase_invoices
     SET receiving_approval_status = 'approved',
         receiving_rejection_reason = NULL,
         updated_at = now()
   WHERE id = v_inv.id;

  RAISE NOTICE 'Successfully reconciled Purchase Invoice 80103232 to approved (Received Qty: % across % allocation(s))', v_alloc_qty, v_alloc_count;
END;
$$;

-- Verification
-- SELECT id, invoice_number, receiving_approval_status, receiving_approved_at, receiving_approved_by, status
-- FROM public.purchase_invoices WHERE id = 'f71fc7e1-f666-4a61-8eaa-7edf42127238';

COMMIT;

-- ============================================================================
-- ROLLBACK STATEMENT (If needed)
-- ============================================================================
-- UPDATE public.purchase_invoices
--    SET receiving_approval_status = 'pending_approval'
--  WHERE id = 'f71fc7e1-f666-4a61-8eaa-7edf42127238';

