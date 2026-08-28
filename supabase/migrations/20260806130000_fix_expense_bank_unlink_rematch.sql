-- Keep Delivery Challan approval on the canonical Inventory V1 path. A live
-- Bolt workaround attempted to rebuild a missing reservation during approval
-- and could release reservations owned by other Sales Orders. The application
-- now prevents the SO line replacement that caused the reservation FK cascade,
-- so approval must only consume the reservation already owned by this SO/batch.

CREATE OR REPLACE FUNCTION public.trg_dc_approval_deduct_stock()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_item record;
BEGIN
  IF NEW.approval_status = 'approved'
     AND OLD.approval_status IS DISTINCT FROM 'approved' THEN
    IF NEW.approval_operation_id IS NULL THEN
      RAISE EXCEPTION 'approval_operation_id is required for DC approval';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM public.inventory_transactions
      WHERE reference_type = 'delivery_challan_reversal'
        AND reference_id = NEW.id
        AND metadata->>'canonical_engine_version' = '1.0'
    ) THEN
      RAISE EXCEPTION 'Reversed Delivery Challan cannot be re-approved; create a new DC';
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM public.delivery_challan_items
      WHERE challan_id = NEW.id
    ) THEN
      RAISE EXCEPTION 'Cannot approve Delivery Challan % without items',
        NEW.challan_number;
    END IF;

    FOR v_item IN
      SELECT *
      FROM public.delivery_challan_items
      WHERE challan_id = NEW.id
      ORDER BY id
    LOOP
      PERFORM public.inventory_v1_consume_reservation(
        NEW.sales_order_id,
        v_item.product_id,
        v_item.batch_id,
        v_item.quantity,
        NEW.approved_by
      );

      PERFORM public.post_inventory_movement(
        public.uuid_from_text(
          'inventory-v1:dc:' || NEW.approval_operation_id || ':' || v_item.id
        ),
        v_item.product_id,
        v_item.batch_id,
        'delivery_challan',
        -v_item.quantity,
        NEW.challan_date,
        NEW.challan_number,
        'delivery_challan',
        NEW.id,
        'Canonical Delivery Challan approval: ' || NEW.challan_number,
        NEW.approved_by,
        NULL,
        NULL
      );
    END LOOP;

    IF NEW.sales_order_id IS NOT NULL THEN
      PERFORM public.fn_recompute_so_delivered(NEW.sales_order_id);
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_dc_approval_deduct_stock
ON public.delivery_challans;

CREATE TRIGGER trigger_dc_approval_deduct_stock
AFTER UPDATE OF approval_status ON public.delivery_challans
FOR EACH ROW
EXECUTE FUNCTION public.trg_dc_approval_deduct_stock();

REVOKE ALL ON FUNCTION public.trg_dc_approval_deduct_stock()
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trg_dc_approval_deduct_stock()
TO service_role;

-- Restore the canonical unlink command after a live Bolt migration replaced it
-- with a version that did not set manually_unlinked.  Without this guard the
-- BEFORE UPDATE auto-match trigger links the same bank line again inside the
-- unlink UPDATE, so the RPC reports success while nothing is visibly changed.

CREATE OR REPLACE FUNCTION public.unmatch_bank_line(p_bank_line_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_expense_id uuid;
BEGIN
  PERFORM public._sec_check_finance_role();

  SELECT matched_expense_id
    INTO v_expense_id
  FROM public.bank_statement_lines
  WHERE id = p_bank_line_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Bank statement line not found';
  END IF;

  UPDATE public.bank_statement_lines
  SET matched_expense_id = NULL,
      matched_receipt_id = NULL,
      matched_payment_id = NULL,
      matched_fund_transfer_id = NULL,
      matched_petty_cash_id = NULL,
      matched_tax_payment_id = NULL,
      matched_entry_id = NULL,
      matching_status = 'none',
      reconciliation_status = 'unmatched',
      matched_at = NULL,
      matched_by = NULL,
      notes = NULL,
      manually_unlinked = true,
      payment_kind = 'supplier'
  WHERE id = p_bank_line_id;

  IF v_expense_id IS NOT NULL THEN
    PERFORM public.recalculate_expense_payment_state(v_expense_id);
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'bank_line_id', p_bank_line_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.unmatch_bank_line(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.unmatch_bank_line(uuid)
TO authenticated, service_role;
