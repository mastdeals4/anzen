/* Keep Sales Order reservations and Delivery Challan batches aligned. */

CREATE OR REPLACE FUNCTION public.realign_reservation_for_delivery_challan(
  p_challan_id uuid,
  p_confirmed boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_dc record;
  v_item record;
  v_so_item record;
  v_reserved numeric;
  v_on_batch numeric;
  v_need numeric;
  v_free numeric;
  v_move numeric;
  v_res record;
BEGIN
  IF NOT public.inventory_v1_actor_allowed(ARRAY['admin','accounts','manager','warehouse','sales']) THEN
    RAISE EXCEPTION 'Permission denied for reservation alignment';
  END IF;
  IF NOT p_confirmed THEN
    RAISE EXCEPTION 'Reservation alignment requires explicit confirmation';
  END IF;

  SELECT id, sales_order_id, approval_status INTO v_dc
  FROM public.delivery_challans WHERE id = p_challan_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Delivery Challan not found'; END IF;
  IF v_dc.sales_order_id IS NULL THEN RAISE EXCEPTION 'Delivery Challan requires a Sales Order'; END IF;
  IF v_dc.approval_status = 'approved' THEN RAISE EXCEPTION 'Approved Delivery Challan cannot change reservation'; END IF;

  FOR v_item IN
    SELECT dci.product_id, dci.batch_id, dci.quantity, dci.sales_order_item_id
    FROM public.delivery_challan_items dci
    WHERE dci.challan_id = p_challan_id
    FOR UPDATE
  LOOP
    SELECT soi.id, soi.sales_order_id, soi.product_id,
           GREATEST(soi.quantity - COALESCE(soi.delivered_quantity,0),0) AS remaining
      INTO v_so_item
    FROM public.sales_order_items soi
    WHERE soi.id = v_item.sales_order_item_id
      AND soi.sales_order_id = v_dc.sales_order_id
      AND soi.product_id = v_item.product_id
    FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Delivery Challan item is not a valid Sales Order item'; END IF;

    SELECT COALESCE(sum(sr.reserved_quantity),0),
           COALESCE(sum(sr.reserved_quantity) FILTER (WHERE sr.batch_id = v_item.batch_id),0)
      INTO v_reserved, v_on_batch
    FROM public.stock_reservations sr
    WHERE sr.sales_order_id = v_dc.sales_order_id
      AND sr.sales_order_item_id = v_so_item.id
      AND sr.status = 'active';

    IF v_on_batch >= v_item.quantity THEN CONTINUE; END IF;
    v_need := v_item.quantity - v_on_batch;

    SELECT GREATEST(b.current_stock - COALESCE(b.reserved_stock,0),0)
      INTO v_free FROM public.batches b
    WHERE b.id = v_item.batch_id AND b.product_id = v_item.product_id AND b.is_active
      AND (b.expiry_date IS NULL OR b.expiry_date > CURRENT_DATE)
    FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Selected batch is not eligible for this product'; END IF;
    IF v_free + v_on_batch < v_item.quantity THEN RAISE EXCEPTION 'Selected batch has insufficient available stock'; END IF;

    -- Move only the deficit from other active reservations, preserving history.
    FOR v_res IN
      SELECT id, reserved_quantity FROM public.stock_reservations
      WHERE sales_order_id = v_dc.sales_order_id AND sales_order_item_id = v_so_item.id
        AND status = 'active' AND batch_id <> v_item.batch_id
      ORDER BY reserved_at, id FOR UPDATE
    LOOP
      EXIT WHEN v_need <= 0;
      v_move := LEAST(v_need, v_res.reserved_quantity);
      IF v_move = v_res.reserved_quantity THEN
        UPDATE public.stock_reservations SET status='released', is_released=true,
          released_at=now(), released_by=auth.uid(), release_reason='Explicit DC batch alignment'
        WHERE id=v_res.id;
      ELSE
        UPDATE public.stock_reservations SET reserved_quantity=reserved_quantity-v_move WHERE id=v_res.id;
      END IF;
      v_need := v_need - v_move;
    END LOOP;

    IF v_need > 0 THEN
      INSERT INTO public.stock_reservations
        (sales_order_id,sales_order_item_id,batch_id,product_id,reserved_quantity,reserved_by,is_released,status)
      VALUES (v_dc.sales_order_id,v_so_item.id,v_item.batch_id,v_item.product_id,v_need,auth.uid(),false,'active');
    END IF;
  END LOOP;
  RETURN jsonb_build_object('success',true,'challan_id',p_challan_id);
END;
$$;

REVOKE ALL ON FUNCTION public.realign_reservation_for_delivery_challan(uuid,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.realign_reservation_for_delivery_challan(uuid,boolean) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.guard_delivery_challan_batch_reservation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_reserved numeric;
BEGIN
  IF NEW.approval_status = 'approved' AND OLD.approval_status IS DISTINCT FROM 'approved' AND NEW.sales_order_id IS NOT NULL THEN
    SELECT COALESCE(sum(sr.reserved_quantity),0) INTO v_reserved
    FROM public.stock_reservations sr
    JOIN public.delivery_challan_items dci ON dci.sales_order_item_id=sr.sales_order_item_id
      AND dci.product_id=sr.product_id AND dci.batch_id=sr.batch_id AND dci.challan_id=NEW.id
    WHERE sr.sales_order_id=NEW.sales_order_id AND sr.status='active';
    IF EXISTS (
      SELECT 1 FROM public.delivery_challan_items dci
      WHERE dci.challan_id=NEW.id
        AND (SELECT COALESCE(sum(sr.reserved_quantity),0) FROM public.stock_reservations sr
             WHERE sr.sales_order_id=NEW.sales_order_id AND sr.sales_order_item_id=dci.sales_order_item_id
               AND sr.product_id=dci.product_id AND sr.batch_id=dci.batch_id AND sr.status='active') < dci.quantity
    ) THEN
      RAISE EXCEPTION 'Selected batch differs from the Sales Order reservation. Align the reservation before approval.';
    END IF;
  END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_guard_dc_batch_reservation ON public.delivery_challans;
CREATE TRIGGER trg_guard_dc_batch_reservation
BEFORE UPDATE OF approval_status ON public.delivery_challans
FOR EACH ROW EXECUTE FUNCTION public.guard_delivery_challan_batch_reservation();
