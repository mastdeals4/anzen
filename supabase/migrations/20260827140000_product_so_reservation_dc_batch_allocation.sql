/*
 * Phase 2 only: product-level SO commitments and DC batch allocations.
 * This migration deliberately contains no legacy stock_reservations data move.
 */

CREATE TABLE IF NOT EXISTS public.so_product_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sales_order_id uuid NOT NULL REFERENCES public.sales_orders(id) ON DELETE RESTRICT,
  sales_order_item_id uuid NOT NULL REFERENCES public.sales_order_items(id) ON DELETE RESTRICT,
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE RESTRICT,
  reserved_quantity numeric NOT NULL CHECK (reserved_quantity >= 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','released','consumed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  close_reason text,
  legacy_reservation_ids uuid[] NOT NULL DEFAULT '{}',
  CHECK (status <> 'active' OR reserved_quantity > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_so_product_reservation_active_item
  ON public.so_product_reservations(sales_order_item_id) WHERE status='active';
CREATE INDEX IF NOT EXISTS idx_so_product_reservation_product_active
  ON public.so_product_reservations(product_id) WHERE status='active';

CREATE TABLE IF NOT EXISTS public.so_product_reservation_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reservation_id uuid NOT NULL REFERENCES public.so_product_reservations(id) ON DELETE RESTRICT,
  sales_order_id uuid NOT NULL REFERENCES public.sales_orders(id) ON DELETE RESTRICT,
  sales_order_item_id uuid NOT NULL REFERENCES public.sales_order_items(id) ON DELETE RESTRICT,
  event_type text NOT NULL CHECK (event_type IN ('created','increased','decreased','released','consumed')),
  quantity_delta numeric NOT NULL CHECK (quantity_delta <> 0),
  quantity_after numeric NOT NULL CHECK (quantity_after >= 0),
  delivery_challan_item_id uuid REFERENCES public.delivery_challan_items(id) ON DELETE RESTRICT,
  reason text NOT NULL,
  actor_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.dc_batch_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_challan_id uuid NOT NULL REFERENCES public.delivery_challans(id) ON DELETE RESTRICT,
  delivery_challan_item_id uuid NOT NULL REFERENCES public.delivery_challan_items(id) ON DELETE RESTRICT,
  sales_order_item_id uuid NOT NULL REFERENCES public.sales_order_items(id) ON DELETE RESTRICT,
  reservation_id uuid NOT NULL REFERENCES public.so_product_reservations(id) ON DELETE RESTRICT,
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE RESTRICT,
  batch_id uuid NOT NULL REFERENCES public.batches(id) ON DELETE RESTRICT,
  allocated_quantity numeric NOT NULL CHECK (allocated_quantity > 0),
  status text NOT NULL DEFAULT 'consumed' CHECK (status IN ('consumed','reversed')),
  operation_id uuid NOT NULL,
  inventory_transaction_id uuid REFERENCES public.inventory_transactions(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  reversed_at timestamptz,
  reversal_reason text
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_dc_batch_allocation_active_item
  ON public.dc_batch_allocations(delivery_challan_item_id) WHERE status='consumed';
CREATE UNIQUE INDEX IF NOT EXISTS uq_dc_batch_allocation_operation
  ON public.dc_batch_allocations(operation_id,delivery_challan_item_id);

ALTER TABLE public.so_product_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.so_product_reservation_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dc_batch_allocations ENABLE ROW LEVEL SECURITY;
CREATE POLICY so_product_reservations_read ON public.so_product_reservations FOR SELECT TO authenticated USING (true);
CREATE POLICY so_product_reservation_events_read ON public.so_product_reservation_events FOR SELECT TO authenticated USING (true);
CREATE POLICY dc_batch_allocations_read ON public.dc_batch_allocations FOR SELECT TO authenticated USING (true);

CREATE OR REPLACE FUNCTION public.product_available_to_promise(
  p_product_id uuid,
  p_exclude_sales_order_item_id uuid DEFAULT NULL
) RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT GREATEST(
    COALESCE((SELECT sum(b.current_stock) FROM public.batches b
      WHERE b.product_id=p_product_id AND b.is_active=true
        AND (b.expiry_date IS NULL OR b.expiry_date>CURRENT_DATE)),0)
    - COALESCE((SELECT sum(r.reserved_quantity) FROM public.so_product_reservations r
      WHERE r.product_id=p_product_id AND r.status='active'
        AND (p_exclude_sales_order_item_id IS NULL OR r.sales_order_item_id<>p_exclude_sales_order_item_id)),0)
    - COALESCE((SELECT sum(sr.reserved_quantity) FROM public.stock_reservations sr
      WHERE sr.product_id=p_product_id AND sr.status='active' AND NOT sr.is_released
        AND (p_exclude_sales_order_item_id IS NULL OR sr.sales_order_item_id<>p_exclude_sales_order_item_id)
        AND NOT EXISTS (SELECT 1 FROM public.so_product_reservations migrated
          WHERE sr.id=ANY(migrated.legacy_reservation_ids))),0),0);
$$;

CREATE OR REPLACE FUNCTION public.reconcile_so_product_reservation_v2(
  p_sales_order_item_id uuid,
  p_reason text DEFAULT 'SO state reconciliation'
) RETURNS numeric
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  v_item record; v_res public.so_product_reservations%ROWTYPE;
  v_delivered numeric; v_required numeric; v_delta numeric; v_atp numeric;
BEGIN
  SELECT soi.*,so.status::text so_status INTO v_item
  FROM public.sales_order_items soi JOIN public.sales_orders so ON so.id=soi.sales_order_id
  WHERE soi.id=p_sales_order_item_id FOR UPDATE OF soi,so;
  IF NOT FOUND THEN RAISE EXCEPTION 'Sales Order item not found'; END IF;

  -- Serialize ATP decisions for the product. Row locks on different SO items
  -- alone do not prevent two concurrent approvals from both observing the
  -- same ATP and over-committing it.
  PERFORM pg_advisory_xact_lock(hashtextextended(v_item.product_id::text,0));

  SELECT COALESCE(sum(dci.quantity),0) INTO v_delivered
  FROM public.delivery_challan_items dci JOIN public.delivery_challans dc ON dc.id=dci.challan_id
  WHERE dci.sales_order_item_id=v_item.id AND dc.approval_status='approved';
  IF v_delivered>v_item.quantity THEN RAISE EXCEPTION 'Delivered quantity exceeds ordered quantity'; END IF;
  v_required := CASE WHEN v_item.so_status IN ('approved','stock_reserved','pending_delivery','partially_delivered')
    THEN v_item.quantity-v_delivered ELSE 0 END;

  SELECT * INTO v_res FROM public.so_product_reservations
  WHERE sales_order_item_id=v_item.id AND status='active' FOR UPDATE;
  IF v_required=0 THEN
    IF FOUND THEN
      UPDATE public.so_product_reservations SET reserved_quantity=0,status='released',closed_at=now(),updated_at=now(),
        close_reason=p_reason WHERE id=v_res.id;
      INSERT INTO public.so_product_reservation_events(reservation_id,sales_order_id,sales_order_item_id,event_type,quantity_delta,quantity_after,reason,actor_id)
      VALUES(v_res.id,v_item.sales_order_id,v_item.id,'released',-v_res.reserved_quantity,0,p_reason,auth.uid());
    END IF;
    RETURN 0;
  END IF;

  IF NOT FOUND THEN
    v_atp:=public.product_available_to_promise(v_item.product_id,NULL);
    IF v_required>v_atp THEN RAISE EXCEPTION 'Insufficient product ATP: available %, required %',v_atp,v_required; END IF;
    INSERT INTO public.so_product_reservations(sales_order_id,sales_order_item_id,product_id,reserved_quantity,created_by)
    VALUES(v_item.sales_order_id,v_item.id,v_item.product_id,v_required,auth.uid()) RETURNING * INTO v_res;
    INSERT INTO public.so_product_reservation_events(reservation_id,sales_order_id,sales_order_item_id,event_type,quantity_delta,quantity_after,reason,actor_id)
    VALUES(v_res.id,v_item.sales_order_id,v_item.id,'created',v_required,v_required,p_reason,auth.uid());
  ELSE
    IF v_res.product_id<>v_item.product_id THEN RAISE EXCEPTION 'Cannot change product on an actively reserved SO item'; END IF;
    v_delta:=v_required-v_res.reserved_quantity;
    IF v_delta>0 THEN
      v_atp:=public.product_available_to_promise(v_item.product_id,v_item.id);
      IF v_required>v_atp THEN RAISE EXCEPTION 'Insufficient product ATP: available %, required %',v_atp,v_required; END IF;
    END IF;
    IF v_delta<>0 THEN
      UPDATE public.so_product_reservations SET reserved_quantity=v_required,updated_at=now() WHERE id=v_res.id;
      INSERT INTO public.so_product_reservation_events(reservation_id,sales_order_id,sales_order_item_id,event_type,quantity_delta,quantity_after,reason,actor_id)
      VALUES(v_res.id,v_item.sales_order_id,v_item.id,CASE WHEN v_delta>0 THEN 'increased' ELSE 'decreased' END,v_delta,v_required,p_reason,auth.uid());
    END IF;
  END IF;
  RETURN v_required;
END; $$;

CREATE OR REPLACE FUNCTION public.approve_sales_order_product_reservation_v2(p_so_id uuid,p_approved_by uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r record;
BEGIN
  IF NOT public.inventory_v1_actor_allowed(ARRAY['admin','accounts','manager','warehouse']) THEN
    RAISE EXCEPTION 'Permission denied for SO product reservation approval';
  END IF;
  PERFORM 1 FROM public.sales_orders WHERE id=p_so_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Sales Order not found'; END IF;
  PERFORM set_config('app.canonical_reservation_engine','on',true);
  UPDATE public.sales_orders SET status='approved',approved_by=COALESCE(p_approved_by,auth.uid()),approved_at=now() WHERE id=p_so_id;
  FOR r IN SELECT id FROM public.sales_order_items WHERE sales_order_id=p_so_id ORDER BY product_id,id LOOP
    PERFORM public.reconcile_so_product_reservation_v2(r.id,'SO approval/re-approval');
  END LOOP;
  UPDATE public.sales_orders SET status='stock_reserved',updated_at=now() WHERE id=p_so_id;
END; $$;

CREATE OR REPLACE FUNCTION public.release_so_product_reservations_v2(p_so_id uuid,p_reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r public.so_product_reservations%ROWTYPE;
BEGIN
  IF NOT public.inventory_v1_actor_allowed(ARRAY['admin','accounts','manager','warehouse','sales'])
     AND current_setting('app.canonical_reservation_engine',true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'Permission denied for reservation release';
  END IF;
  FOR r IN SELECT * FROM public.so_product_reservations WHERE sales_order_id=p_so_id AND status='active' ORDER BY id FOR UPDATE LOOP
    UPDATE public.so_product_reservations SET reserved_quantity=0,status='released',closed_at=now(),updated_at=now(),close_reason=p_reason WHERE id=r.id;
    INSERT INTO public.so_product_reservation_events(reservation_id,sales_order_id,sales_order_item_id,event_type,quantity_delta,quantity_after,reason,actor_id)
    VALUES(r.id,r.sales_order_id,r.sales_order_item_id,'released',-r.reserved_quantity,0,p_reason,auth.uid());
  END LOOP;
END; $$;

-- Legacy batch re-reservation must become inert once product commitments are
-- authoritative. A physical batch arrival changes ATP but must never create an
-- SO batch reservation.
CREATE OR REPLACE FUNCTION public.fn_auto_rereserve_on_batch_arrival()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  RETURN NEW;
END; $$;

-- Keep old callers safe during the staged rollout. They retain the historical
-- return contract, but route to the product-level approval transaction and do
-- not write stock_reservations.
CREATE OR REPLACE FUNCTION public.fn_reserve_stock_for_so_v2(p_so_id uuid)
RETURNS TABLE(success boolean,message text,shortage_items jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  PERFORM public.approve_sales_order_product_reservation_v2(p_so_id,auth.uid());
  RETURN QUERY SELECT true,'Product quantity fully reserved'::text,'[]'::jsonb;
END; $$;

-- The prior controlled-alignment RPC writes legacy batch reservations. Batch
-- choice is now a DC allocation concern, so retaining that write path would
-- recreate the architecture this migration removes.
CREATE OR REPLACE FUNCTION public.realign_reservation_for_delivery_challan(
  p_challan_id uuid,p_confirmed boolean DEFAULT false
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'Batch reservation alignment is retired; select an eligible DC batch against the SO product reservation';
END; $$;

CREATE OR REPLACE FUNCTION public.trg_release_so_product_reservation_status_v2()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF NEW.status::text IN ('rejected','cancelled','closed','delivered')
     AND OLD.status::text IS DISTINCT FROM NEW.status::text THEN
    PERFORM public.release_so_product_reservations_v2(NEW.id,'SO status changed to '||NEW.status::text);
  END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trigger_auto_release_on_so_status ON public.sales_orders;
CREATE TRIGGER trigger_auto_release_on_so_status AFTER UPDATE OF status ON public.sales_orders
FOR EACH ROW EXECUTE FUNCTION public.trg_release_so_product_reservation_status_v2();

CREATE OR REPLACE FUNCTION public.trg_reconcile_active_so_item_v2()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_status text;
BEGIN
  IF TG_OP='DELETE' THEN
    IF EXISTS(SELECT 1 FROM public.so_product_reservations WHERE sales_order_item_id=OLD.id) THEN
      RAISE EXCEPTION 'Sales Order item has reservation history and cannot be deleted; cancel/void the order or adjust quantity';
    END IF;
    RETURN OLD;
  END IF;
  SELECT status::text INTO v_status FROM public.sales_orders WHERE id=NEW.sales_order_id;
  IF v_status IN ('approved','stock_reserved','pending_delivery','partially_delivered') THEN
    PERFORM public.reconcile_so_product_reservation_v2(NEW.id,'Approved SO item changed');
  END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_reconcile_active_so_item_v2 ON public.sales_order_items;
CREATE TRIGGER trg_reconcile_active_so_item_v2
AFTER INSERT OR UPDATE OF product_id,quantity ON public.sales_order_items
FOR EACH ROW EXECUTE FUNCTION public.trg_reconcile_active_so_item_v2();
DROP TRIGGER IF EXISTS trg_guard_so_item_reservation_history_v2 ON public.sales_order_items;
CREATE TRIGGER trg_guard_so_item_reservation_history_v2
BEFORE DELETE ON public.sales_order_items
FOR EACH ROW EXECUTE FUNCTION public.trg_reconcile_active_so_item_v2();

CREATE OR REPLACE FUNCTION public.validate_dc_item_product_reservation_v2()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_dc record; v_reserved numeric; v_pending numeric;
BEGIN
  SELECT dc.sales_order_id,dc.approval_status INTO v_dc FROM public.delivery_challans dc WHERE dc.id=NEW.challan_id;
  IF NOT FOUND OR NEW.sales_order_item_id IS NULL THEN RAISE EXCEPTION 'DC item requires a canonical SO item'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.sales_order_items soi WHERE soi.id=NEW.sales_order_item_id
    AND soi.sales_order_id=v_dc.sales_order_id AND soi.product_id=NEW.product_id) THEN
    RAISE EXCEPTION 'DC product does not match its SO item';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.batches b WHERE b.id=NEW.batch_id AND b.product_id=NEW.product_id AND b.is_active
    AND (b.expiry_date IS NULL OR b.expiry_date>CURRENT_DATE)) THEN RAISE EXCEPTION 'Selected DC batch is not eligible for this product'; END IF;
  SELECT COALESCE(reserved_quantity,0) INTO v_reserved FROM public.so_product_reservations
    WHERE sales_order_item_id=NEW.sales_order_item_id AND status='active';
  SELECT COALESCE(sum(dci.quantity),0) INTO v_pending
  FROM public.delivery_challan_items dci JOIN public.delivery_challans dc ON dc.id=dci.challan_id
  WHERE dci.sales_order_item_id=NEW.sales_order_item_id AND dc.approval_status='pending_approval'
    AND dci.id IS DISTINCT FROM NEW.id;
  IF v_pending+NEW.quantity>v_reserved THEN RAISE EXCEPTION 'DC quantities exceed remaining SO product reservation'; END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_validate_dc_item_product_reservation_v2 ON public.delivery_challan_items;
CREATE TRIGGER trg_validate_dc_item_product_reservation_v2 BEFORE INSERT OR UPDATE OF sales_order_item_id,product_id,batch_id,quantity
ON public.delivery_challan_items FOR EACH ROW EXECUTE FUNCTION public.validate_dc_item_product_reservation_v2();

CREATE OR REPLACE FUNCTION public.consume_so_product_reservation_v2(
  p_dc_item_id uuid,p_operation_id uuid,p_actor uuid
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v record; v_res public.so_product_reservations%ROWTYPE; v_tx uuid; v_after numeric;
BEGIN
  SELECT dci.*,dc.id dc_id,dc.sales_order_id,dc.challan_number,dc.challan_date INTO v
  FROM public.delivery_challan_items dci JOIN public.delivery_challans dc ON dc.id=dci.challan_id
  WHERE dci.id=p_dc_item_id FOR UPDATE OF dci,dc;
  IF NOT FOUND OR v.sales_order_item_id IS NULL THEN RAISE EXCEPTION 'DC item has no canonical SO item'; END IF;
  SELECT * INTO v_res FROM public.so_product_reservations
  WHERE sales_order_item_id=v.sales_order_item_id AND product_id=v.product_id AND status='active' FOR UPDATE;
  IF NOT FOUND OR v_res.reserved_quantity<v.quantity THEN RAISE EXCEPTION 'DC quantity exceeds remaining SO product reservation'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.batches b WHERE b.id=v.batch_id AND b.product_id=v.product_id
      AND b.is_active AND b.current_stock>=v.quantity AND (b.expiry_date IS NULL OR b.expiry_date>CURRENT_DATE)) THEN
    RAISE EXCEPTION 'Selected batch is invalid, expired, or has insufficient physical stock';
  END IF;
  IF EXISTS(SELECT 1 FROM public.dc_batch_allocations WHERE delivery_challan_item_id=v.id AND status='consumed') THEN
    RAISE EXCEPTION 'Delivery Challan item reservation is already consumed';
  END IF;
  v_tx:=public.post_inventory_movement(public.uuid_from_text('inventory-v2:dc:'||p_operation_id||':'||v.id),v.product_id,v.batch_id,
    'delivery_challan',-v.quantity,v.challan_date,v.challan_number,'delivery_challan',v.dc_id,
    'Product reservation consumed against DC batch',COALESCE(p_actor,auth.uid()),NULL,NULL);
  v_after:=v_res.reserved_quantity-v.quantity;
  UPDATE public.so_product_reservations SET reserved_quantity=v_after,
    status=CASE WHEN v_after=0 THEN 'consumed' ELSE 'active' END,closed_at=CASE WHEN v_after=0 THEN now() END,
    close_reason=CASE WHEN v_after=0 THEN 'Fully delivered' END,updated_at=now() WHERE id=v_res.id;
  INSERT INTO public.so_product_reservation_events(reservation_id,sales_order_id,sales_order_item_id,event_type,quantity_delta,quantity_after,delivery_challan_item_id,reason,actor_id)
  VALUES(v_res.id,v.sales_order_id,v.sales_order_item_id,'consumed',-v.quantity,v_after,v.id,'DC approval',COALESCE(p_actor,auth.uid()));
  INSERT INTO public.dc_batch_allocations(delivery_challan_id,delivery_challan_item_id,sales_order_item_id,reservation_id,product_id,batch_id,allocated_quantity,operation_id,inventory_transaction_id,created_by)
  VALUES(v.dc_id,v.id,v.sales_order_item_id,v_res.id,v.product_id,v.batch_id,v.quantity,p_operation_id,v_tx,COALESCE(p_actor,auth.uid()));
  RETURN v_tx;
END; $$;

CREATE OR REPLACE FUNCTION public.trg_dc_approval_product_reservation_v2()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r record;
BEGIN
  IF NEW.approval_status='approved' AND OLD.approval_status IS DISTINCT FROM 'approved' THEN
    IF NEW.approval_operation_id IS NULL THEN RAISE EXCEPTION 'approval_operation_id is required'; END IF;
    IF NOT EXISTS(SELECT 1 FROM public.delivery_challan_items WHERE challan_id=NEW.id) THEN
      RAISE EXCEPTION 'Cannot approve Delivery Challan % without items',NEW.challan_number;
    END IF;
    FOR r IN SELECT id FROM public.delivery_challan_items WHERE challan_id=NEW.id ORDER BY id LOOP
      PERFORM public.consume_so_product_reservation_v2(r.id,NEW.approval_operation_id,NEW.approved_by);
    END LOOP;
    PERFORM public.fn_recompute_so_delivered(NEW.sales_order_id);
  END IF;
  RETURN NEW;
END; $$;

CREATE OR REPLACE FUNCTION public.trg_dc_reverse_product_reservation_v2()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r record;
BEGIN
  IF OLD.approval_status='approved' AND NEW.approval_status IN ('rejected','cancelled') THEN
    IF EXISTS(SELECT 1 FROM public.sales_invoice_items sii JOIN public.delivery_challan_items dci ON dci.id=sii.delivery_challan_item_id WHERE dci.challan_id=NEW.id)
      THEN RAISE EXCEPTION 'Approved Delivery Challan already invoiced; reverse invoice first'; END IF;
    FOR r IN SELECT dci.*,a.id allocation_id FROM public.delivery_challan_items dci
      JOIN public.dc_batch_allocations a ON a.delivery_challan_item_id=dci.id AND a.status='consumed'
      WHERE dci.challan_id=NEW.id ORDER BY dci.id FOR UPDATE OF a LOOP
      PERFORM public.post_inventory_movement(public.uuid_from_text('inventory-v2:dc-reversal:'||NEW.id||':'||r.id),r.product_id,r.batch_id,
        'adjustment',r.quantity,CURRENT_DATE,NEW.challan_number,'delivery_challan_reversal',NEW.id,
        'Reversal of product-reservation DC batch allocation',COALESCE(NEW.rejected_by,auth.uid()),NULL,NULL);
      UPDATE public.dc_batch_allocations SET status='reversed',reversed_at=now(),reversal_reason=NEW.approval_status WHERE id=r.allocation_id;
    END LOOP;
    PERFORM public.fn_recompute_so_delivered(NEW.sales_order_id);
    FOR r IN SELECT DISTINCT sales_order_item_id FROM public.delivery_challan_items WHERE challan_id=NEW.id LOOP
      PERFORM public.reconcile_so_product_reservation_v2(r.sales_order_item_id,'DC reversal');
    END LOOP;
  END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_guard_dc_batch_reservation ON public.delivery_challans;
DROP TRIGGER IF EXISTS trigger_dc_approval_deduct_stock ON public.delivery_challans;
CREATE TRIGGER trigger_dc_approval_deduct_stock AFTER UPDATE OF approval_status ON public.delivery_challans
FOR EACH ROW EXECUTE FUNCTION public.trg_dc_approval_product_reservation_v2();
DROP TRIGGER IF EXISTS trigger_dc_inventory_v1_reversal ON public.delivery_challans;
CREATE TRIGGER trigger_dc_inventory_v1_reversal AFTER UPDATE OF approval_status ON public.delivery_challans
FOR EACH ROW EXECUTE FUNCTION public.trg_dc_reverse_product_reservation_v2();

CREATE OR REPLACE VIEW public.so_product_reservation_status AS
SELECT soi.id sales_order_item_id,soi.sales_order_id,soi.product_id,soi.quantity ordered_quantity,
  COALESCE((SELECT sum(dci.quantity) FROM public.delivery_challan_items dci JOIN public.delivery_challans dc ON dc.id=dci.challan_id
    WHERE dci.sales_order_item_id=soi.id AND dc.approval_status='approved'),0) delivered_quantity,
  COALESCE(r.reserved_quantity,0) reserved_quantity,
  GREATEST(soi.quantity-COALESCE((SELECT sum(dci.quantity) FROM public.delivery_challan_items dci JOIN public.delivery_challans dc ON dc.id=dci.challan_id
    WHERE dci.sales_order_item_id=soi.id AND dc.approval_status='approved'),0),0) remaining_quantity
FROM public.sales_order_items soi LEFT JOIN public.so_product_reservations r ON r.sales_order_item_id=soi.id AND r.status='active';

GRANT SELECT ON public.so_product_reservations,public.so_product_reservation_events,public.dc_batch_allocations,public.so_product_reservation_status TO authenticated;
REVOKE ALL ON FUNCTION public.reconcile_so_product_reservation_v2(uuid,text),public.consume_so_product_reservation_v2(uuid,uuid,uuid),public.approve_sales_order_product_reservation_v2(uuid,uuid),public.release_so_product_reservations_v2(uuid,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.approve_sales_order_product_reservation_v2(uuid,uuid),public.release_so_product_reservations_v2(uuid,text),public.product_available_to_promise(uuid,uuid) TO authenticated,service_role;

-- No INSERT/UPDATE/DELETE against legacy stock_reservations appears here.
-- Production conversion is intentionally deferred to an explicitly approved migration.
