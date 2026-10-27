-- Critical integrity hardening: Make-aware DC validation and RPC-only writes.

CREATE OR REPLACE FUNCTION public.validate_dc_item_product_reservation_v2()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_dc record; v_reserved numeric; v_pending numeric; v_so_make uuid; v_batch_make uuid;
BEGIN
  SELECT dc.sales_order_id,dc.approval_status INTO v_dc FROM public.delivery_challans dc WHERE dc.id=NEW.challan_id;
  IF NOT FOUND OR NEW.sales_order_item_id IS NULL THEN RAISE EXCEPTION 'DC item requires a canonical SO item'; END IF;
  SELECT soi.make_id INTO v_so_make FROM public.sales_order_items soi
   WHERE soi.id=NEW.sales_order_item_id AND soi.sales_order_id=v_dc.sales_order_id AND soi.product_id=NEW.product_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'DC product does not match its SO item'; END IF;
  SELECT b.make_id INTO v_batch_make FROM public.batches b
   WHERE b.id=NEW.batch_id AND b.product_id=NEW.product_id AND b.is_active
     AND (b.expiry_date IS NULL OR b.expiry_date>CURRENT_DATE);
  IF NOT FOUND THEN RAISE EXCEPTION 'Selected DC batch is not eligible for this product'; END IF;
  -- NULL Make preserves historical records; known Make must match exactly.
  IF v_so_make IS NOT NULL AND v_batch_make IS DISTINCT FROM v_so_make THEN
    RAISE EXCEPTION 'Selected DC batch Make does not match the Sales Order Make';
  END IF;
  SELECT COALESCE(reserved_quantity,0) INTO v_reserved FROM public.so_product_reservations
    WHERE sales_order_item_id=NEW.sales_order_item_id AND status='active';
  SELECT COALESCE(sum(dci.quantity),0) INTO v_pending
  FROM public.delivery_challan_items dci JOIN public.delivery_challans dc ON dc.id=dci.challan_id
  WHERE dci.sales_order_item_id=NEW.sales_order_item_id AND dc.approval_status='pending_approval'
    AND dci.id IS DISTINCT FROM NEW.id;
  IF v_pending+NEW.quantity>v_reserved THEN RAISE EXCEPTION 'DC quantities exceed remaining SO product reservation'; END IF;
  RETURN NEW;
END; $$;

-- Inventory transactions are readable by authenticated users but writable only
-- by SECURITY DEFINER canonical movement functions.
DROP POLICY IF EXISTS "Admin, warehouse, and sales can insert inventory transactions" ON public.inventory_transactions;
DROP POLICY IF EXISTS "Authenticated users can insert transactions" ON public.inventory_transactions;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.inventory_transactions FROM anon, authenticated;

-- Allocation rows are readable, but can only be inserted by the receiving RPC.
ALTER TABLE public.purchase_invoice_receiving_allocations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS purchase_invoice_receiving_allocations_read ON public.purchase_invoice_receiving_allocations;
CREATE POLICY purchase_invoice_receiving_allocations_read
  ON public.purchase_invoice_receiving_allocations FOR SELECT TO authenticated USING (true);
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.purchase_invoice_receiving_allocations FROM anon, authenticated;
