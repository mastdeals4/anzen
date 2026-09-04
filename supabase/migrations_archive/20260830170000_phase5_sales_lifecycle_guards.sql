/*
  Phase 5: lifecycle guards for stock-posted sales documents.

  This migration does not rewrite business data or inventory/accounting
  history.  It only closes direct edit/delete paths which can detach an
  already-posted Delivery Challan or Sales Invoice from its traceability.
*/

-- Once a Delivery Challan has posted stock, its business identity/header is
-- immutable.  The existing canonical approved -> rejected/cancelled status
-- transition remains available and continues to drive the stock reversal.
CREATE OR REPLACE FUNCTION public.guard_stock_posted_dc_header()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF OLD.approval_status = 'approved'
     AND (
       NEW.challan_number IS DISTINCT FROM OLD.challan_number
       OR NEW.customer_id IS DISTINCT FROM OLD.customer_id
       OR NEW.sales_order_id IS DISTINCT FROM OLD.sales_order_id
       OR NEW.challan_date IS DISTINCT FROM OLD.challan_date
       OR NEW.delivery_address IS DISTINCT FROM OLD.delivery_address
       OR NEW.vehicle_number IS DISTINCT FROM OLD.vehicle_number
       OR NEW.driver_name IS DISTINCT FROM OLD.driver_name
       OR NEW.notes IS DISTINCT FROM OLD.notes
     ) THEN
    RAISE EXCEPTION
      'Approved Delivery Challan header cannot be edited; cancel/reject through the canonical reversal path and create a corrected DC';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_stock_posted_dc_header
  ON public.delivery_challans;
CREATE TRIGGER guard_stock_posted_dc_header
BEFORE UPDATE ON public.delivery_challans
FOR EACH ROW
EXECUTE FUNCTION public.guard_stock_posted_dc_header();

-- Cancellation is appropriate only while no approved physical delivery
-- exists.  Do not relabel a delivered order as cancelled while keeping its
-- stock movement and Delivery Challan in place.
CREATE OR REPLACE FUNCTION public.fn_cancel_sales_order(
  p_so_id uuid,
  p_canceller_id uuid,
  p_reason text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_role text;
  v_status text;
BEGIN
  SELECT role INTO v_role
  FROM public.user_profiles
  WHERE id = auth.uid();

  IF v_role NOT IN ('admin', 'accounts', 'sales', 'manager') THEN
    RAISE EXCEPTION
      'Permission denied: role % cannot cancel sales orders', v_role;
  END IF;

  SELECT status::text INTO v_status
  FROM public.sales_orders
  WHERE id = p_so_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sales Order not found';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.delivery_challans dc
    WHERE dc.sales_order_id = p_so_id
      AND dc.approval_status = 'approved'
  ) THEN
    RAISE EXCEPTION
      'Sales Order has an approved Delivery Challan; reverse/cancel the Delivery Challan before cancelling the order';
  END IF;

  DELETE FROM public.import_requirements
  WHERE sales_order_id = p_so_id;

  PERFORM public.fn_release_stock_reservations(
    p_so_id,
    'SO cancelled: ' || p_reason,
    p_canceller_id
  );

  UPDATE public.sales_orders
  SET status = 'cancelled',
      updated_at = now()
  WHERE id = p_so_id;

  RETURN true;
END;
$$;

-- Direct deletion bypasses the canonical cancellation/release workflow.
-- Draft orders without downstream/reservation history remain deletable.
CREATE OR REPLACE FUNCTION public.guard_sales_order_delete_with_history()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF EXISTS (
       SELECT 1 FROM public.delivery_challans
       WHERE sales_order_id = OLD.id
     )
     OR EXISTS (
       SELECT 1 FROM public.stock_reservations
       WHERE sales_order_id = OLD.id
     )
     OR EXISTS (
       SELECT 1 FROM public.sales_invoices
       WHERE sales_order_id = OLD.id
     ) THEN
    RAISE EXCEPTION
      'Sales Order with reservation or downstream document history cannot be deleted; use the controlled cancellation workflow';
  END IF;

  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS guard_sales_order_delete_with_history
  ON public.sales_orders;
CREATE TRIGGER guard_sales_order_delete_with_history
BEFORE DELETE ON public.sales_orders
FOR EACH ROW
EXECUTE FUNCTION public.guard_sales_order_delete_with_history();

-- A posted invoice is an accounting/traceability document.  There is no
-- canonical invoice-void/reversal engine today, so deletion must fail closed
-- instead of cascading away its items/journal links while the DC stock history
-- remains.  An empty, unposted header created by a failed draft flow can still
-- be removed.
CREATE OR REPLACE FUNCTION public.guard_posted_sales_invoice_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF OLD.journal_entry_id IS NOT NULL
     OR EXISTS (
       SELECT 1 FROM public.sales_invoice_items
       WHERE invoice_id = OLD.id
     ) THEN
    RAISE EXCEPTION
      'Posted Sales Invoice cannot be deleted; a controlled accounting void/reversal workflow is required';
  END IF;

  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS guard_posted_sales_invoice_delete
  ON public.sales_invoices;
CREATE TRIGGER guard_posted_sales_invoice_delete
BEFORE DELETE ON public.sales_invoices
FOR EACH ROW
EXECUTE FUNCTION public.guard_posted_sales_invoice_delete();

