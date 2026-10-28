-- Migration: 20261028050000_fix_dc_quantity_validation_and_trigger_exclusion.sql
-- Description:
-- 1. Updates validate_dc_item_product_reservation_v2 to:
--    a) Respect app.skip_dc_item_trigger during atomic RPC bulk updates.
--    b) Exclude the current Delivery Challan (NEW.challan_id) when calculating pending deliverable quantity from other challans.
--    c) Accurately sum other items on the same challan excluding the row being updated (NEW.id).
-- 2. Updates validate_delivery_challan_source_item to respect app.skip_dc_item_trigger.
-- 3. Updates edit_delivery_challan to:
--    a) Sum total requested quantity per Sales Order item across p_new_items before comparing against deliverable remaining.
--    b) Calculate other pending delivery quantities strictly excluding p_challan_id.
--    c) Reuse / match existing delivery challan item IDs when updating items so items are updated in-place rather than generating duplicate conflicting rows.
--    d) Ensure strict atomicity and complete rollback on any validation failure.

BEGIN;

-- 1. Update validate_dc_item_product_reservation_v2 trigger function
CREATE OR REPLACE FUNCTION public.validate_dc_item_product_reservation_v2()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_dc record;
  v_so_item public.sales_order_items%ROWTYPE;
  v_pending numeric;
  v_remaining numeric;
  v_so_make uuid;
  v_batch_make uuid;
  v_so_status text;
BEGIN
  -- Honor trigger bypass during atomic RPC bulk operations
  IF current_setting('app.skip_dc_item_trigger', true) = 'true' THEN
    RETURN NEW;
  END IF;

  SELECT dc.sales_order_id, dc.approval_status INTO v_dc
  FROM public.delivery_challans dc
  WHERE dc.id = NEW.challan_id;

  IF NOT FOUND OR NEW.sales_order_item_id IS NULL THEN
    RAISE EXCEPTION 'DC item requires a canonical SO item';
  END IF;

  -- Verify parent Sales Order status
  IF v_dc.sales_order_id IS NOT NULL THEN
    SELECT status::text INTO v_so_status
    FROM public.sales_orders
    WHERE id = v_dc.sales_order_id;

    IF v_so_status IN ('cancelled', 'rejected') THEN
      RAISE EXCEPTION 'Cannot add or modify Delivery Challan items: linked Sales Order is %', v_so_status;
    END IF;
  END IF;

  SELECT * INTO v_so_item
  FROM public.sales_order_items soi
  WHERE soi.id = NEW.sales_order_item_id
    AND soi.sales_order_id = v_dc.sales_order_id
    AND soi.product_id = NEW.product_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'DC product does not match its SO item';
  END IF;

  v_so_make := v_so_item.make_id;

  SELECT b.make_id INTO v_batch_make
  FROM public.batches b
  WHERE b.id = NEW.batch_id
    AND b.product_id = NEW.product_id
    AND b.is_active = true
    AND (b.expiry_date IS NULL OR b.expiry_date > CURRENT_DATE);

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Selected DC batch is not eligible for this product';
  END IF;

  -- NULL Make preserves historical records; known Make must match exactly.
  IF v_so_make IS NOT NULL AND v_batch_make IS DISTINCT FROM v_so_make THEN
    RAISE EXCEPTION 'Selected DC batch Make does not match the Sales Order Make';
  END IF;

  -- Validate against remaining deliverable Sales Order quantity
  -- Sum pending items from OTHER pending delivery challans
  SELECT COALESCE(sum(dci.quantity), 0) INTO v_pending
  FROM public.delivery_challan_items dci
  JOIN public.delivery_challans dc ON dc.id = dci.challan_id
  WHERE dci.sales_order_item_id = NEW.sales_order_item_id
    AND dc.approval_status = 'pending_approval'
    AND dc.id IS DISTINCT FROM NEW.challan_id;

  -- Sum other items on the SAME challan excluding the row being inserted/updated
  SELECT v_pending + COALESCE(sum(dci.quantity), 0) INTO v_pending
  FROM public.delivery_challan_items dci
  WHERE dci.challan_id = NEW.challan_id
    AND dci.sales_order_item_id = NEW.sales_order_item_id
    AND dci.id IS DISTINCT FROM NEW.id;

  v_remaining := v_so_item.quantity - COALESCE(v_so_item.delivered_quantity, 0);
  IF (v_pending + NEW.quantity) > (v_remaining + 0.0001) THEN
    RAISE EXCEPTION 'Delivery quantity (%) exceeds remaining Sales Order quantity (%)', (v_pending + NEW.quantity), v_remaining;
  END IF;

  RETURN NEW;
END;
$$;

-- 2. Update validate_delivery_challan_source_item trigger function
CREATE OR REPLACE FUNCTION public.validate_delivery_challan_source_item()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_dc public.delivery_challans%rowtype;
  v_soi public.sales_order_items%rowtype;
  v_remaining numeric;
BEGIN
  -- Honor trigger bypass during atomic RPC bulk operations
  IF current_setting('app.skip_dc_item_trigger', true) = 'true' THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_dc FROM public.delivery_challans WHERE id = NEW.challan_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Delivery Challan does not exist';
  END IF;

  IF v_dc.sales_order_id IS NULL THEN
    IF NEW.sales_order_item_id IS NOT NULL THEN
      RAISE EXCEPTION 'Unlinked Delivery Challan cannot reference a Sales Order item';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.sales_order_item_id IS NULL THEN
    SELECT soi.id INTO NEW.sales_order_item_id
    FROM public.sales_order_items soi
    WHERE soi.sales_order_id = v_dc.sales_order_id AND soi.product_id = NEW.product_id;

    IF NEW.sales_order_item_id IS NULL THEN
      RAISE EXCEPTION 'Delivery Challan product is not present on the selected Sales Order';
    END IF;

    IF (SELECT count(*) FROM public.sales_order_items soi WHERE soi.sales_order_id = v_dc.sales_order_id AND soi.product_id = NEW.product_id) > 1 THEN
      RAISE EXCEPTION 'Delivery Challan item source is ambiguous; select the exact Sales Order item';
    END IF;
  END IF;

  IF NEW.sales_order_item_id IS NULL THEN
    RAISE EXCEPTION 'Sales Order-linked Delivery Challan item requires sales_order_item_id';
  END IF;

  SELECT * INTO v_soi FROM public.sales_order_items WHERE id = NEW.sales_order_item_id AND sales_order_id = v_dc.sales_order_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Delivery Challan item is not from the selected Sales Order';
  END IF;

  IF NEW.product_id IS DISTINCT FROM v_soi.product_id THEN
    RAISE EXCEPTION 'Delivery Challan product must match the Sales Order item';
  END IF;

  v_remaining := v_soi.quantity - COALESCE(v_soi.delivered_quantity, 0);
  IF TG_OP = 'UPDATE' THEN
    v_remaining := v_remaining + COALESCE(OLD.quantity, 0);
  END IF;

  IF NEW.quantity <= 0 OR NEW.quantity > (v_remaining + 0.0001) THEN
    RAISE EXCEPTION 'Delivery quantity exceeds remaining Sales Order quantity';
  END IF;

  RETURN NEW;
END;
$$;

-- 3. Update edit_delivery_challan RPC
CREATE OR REPLACE FUNCTION public.edit_delivery_challan(
  p_challan_id uuid,
  p_new_items jsonb,
  p_header jsonb DEFAULT NULL::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_role               text;
  v_challan            record;
  v_item               jsonb;
  v_count              integer;
  v_product_id         uuid;
  v_batch_id           uuid;
  v_new_qty            numeric;
  v_item_id            uuid;
  v_matched_id         uuid;
  v_so_item_id         uuid;
  v_so_id              uuid;
  v_blocking_invoices  text;
  v_kept_ids           uuid[] := ARRAY[]::uuid[];
  v_new_status         text;
  v_parsed_status      public.dc_approval_status := NULL;
  v_so_status          text;
  v_soi_qty            numeric;
  v_soi_del_qty        numeric;
  v_other_pending      numeric;
  v_total_new_so_qty   numeric;
  v_remaining_qty      numeric;
  v_batch_active       boolean;
  v_batch_not_expired  boolean;
BEGIN
  SELECT role INTO v_role FROM public.user_profiles WHERE id = auth.uid();
  IF v_role NOT IN ('admin', 'accounts', 'warehouse', 'sales') THEN
    RAISE EXCEPTION 'Permission denied: role % cannot edit delivery challans', v_role;
  END IF;

  SELECT * INTO v_challan FROM public.delivery_challans WHERE id = p_challan_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Delivery challan not found');
  END IF;

  IF v_challan.approval_status = 'approved' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Cannot edit approved delivery challan directly; reverse it or use approved DC edit');
  END IF;

  -- Check if any active (uncancelled) invoice items reference this DC
  IF EXISTS (
    SELECT 1
    FROM public.sales_invoice_items sii
    JOIN public.delivery_challan_items dci ON dci.id = sii.delivery_challan_item_id
    JOIN public.sales_invoices si ON si.id = sii.invoice_id
    WHERE dci.challan_id = p_challan_id
      AND NOT (si.notes LIKE '[CANCELLED%' OR LOWER(si.notes) LIKE 'cancelled%')
  ) THEN
    SELECT string_agg(DISTINCT si.invoice_number, ', ')
    INTO v_blocking_invoices
    FROM public.sales_invoice_items sii
    JOIN public.delivery_challan_items dci ON dci.id = sii.delivery_challan_item_id
    JOIN public.sales_invoices si ON si.id = sii.invoice_id
    WHERE dci.challan_id = p_challan_id
      AND NOT (si.notes LIKE '[CANCELLED%' OR LOWER(si.notes) LIKE 'cancelled%');

    RETURN jsonb_build_object(
      'success', false,
      'error', 'Delivery Challan already invoiced by active invoice(s) ' || v_blocking_invoices || '; cancel or reverse the invoice(s) first'
    );
  END IF;

  -- Validate and apply header if provided
  IF p_header IS NOT NULL THEN
    IF p_header ? 'approval_status' THEN
      v_new_status := NULLIF(TRIM(p_header->>'approval_status'), '');
      IF v_new_status IS NOT NULL THEN
        IF v_new_status NOT IN ('pending_approval', 'rejected', 'cancelled') THEN
          RAISE EXCEPTION 'Invalid approval_status: %. Allowed values are pending_approval, rejected, cancelled.', v_new_status;
        END IF;
        v_parsed_status := v_new_status::public.dc_approval_status;
      END IF;
    END IF;

    v_so_id := CASE 
      WHEN p_header ? 'sales_order_id' THEN NULLIF(p_header->>'sales_order_id', '')::uuid 
      ELSE v_challan.sales_order_id 
    END;

    -- Verify parent Sales Order status if linked
    IF v_so_id IS NOT NULL THEN
      SELECT status::text INTO v_so_status FROM public.sales_orders WHERE id = v_so_id;
      IF v_so_status IN ('cancelled', 'rejected') THEN
        RAISE EXCEPTION 'Cannot save Delivery Challan: linked Sales Order is %', v_so_status;
      END IF;
    END IF;

    UPDATE public.delivery_challans SET
      customer_id = CASE WHEN p_header ? 'customer_id' THEN COALESCE(NULLIF(p_header->>'customer_id', '')::uuid, customer_id) ELSE customer_id END,
      sales_order_id = v_so_id,
      challan_date = CASE WHEN p_header ? 'challan_date' THEN COALESCE(NULLIF(p_header->>'challan_date', '')::date, challan_date) ELSE challan_date END,
      delivery_address = CASE WHEN p_header ? 'delivery_address' THEN COALESCE(p_header->>'delivery_address', delivery_address) ELSE delivery_address END,
      vehicle_number = CASE WHEN p_header ? 'vehicle_number' THEN NULLIF(p_header->>'vehicle_number', '') ELSE vehicle_number END,
      driver_name = CASE WHEN p_header ? 'driver_name' THEN NULLIF(p_header->>'driver_name', '') ELSE driver_name END,
      notes = CASE WHEN p_header ? 'notes' THEN NULLIF(p_header->>'notes', '') ELSE notes END,
      approval_status = COALESCE(v_parsed_status, approval_status),
      rejection_reason = CASE WHEN v_parsed_status = 'pending_approval'::public.dc_approval_status THEN NULL WHEN p_header ? 'rejection_reason' THEN NULLIF(p_header->>'rejection_reason', '') ELSE rejection_reason END,
      rejected_by = CASE WHEN v_parsed_status = 'pending_approval'::public.dc_approval_status THEN NULL ELSE rejected_by END,
      rejected_at = CASE WHEN v_parsed_status = 'pending_approval'::public.dc_approval_status THEN NULL ELSE rejected_at END,
      approved_at = CASE WHEN v_parsed_status = 'pending_approval'::public.dc_approval_status THEN NULL ELSE approved_at END,
      approved_by = CASE WHEN v_parsed_status = 'pending_approval'::public.dc_approval_status THEN NULL ELSE approved_by END,
      updated_at = NOW()
    WHERE id = p_challan_id;
  ELSE
    v_so_id := v_challan.sales_order_id;
    IF v_so_id IS NOT NULL THEN
      SELECT status::text INTO v_so_status FROM public.sales_orders WHERE id = v_so_id;
      IF v_so_status IN ('cancelled', 'rejected') THEN
        RAISE EXCEPTION 'Cannot save Delivery Challan: linked Sales Order is %', v_so_status;
      END IF;
    END IF;
  END IF;

  SELECT count(*) INTO v_count FROM jsonb_array_elements(p_new_items);
  IF v_count = 0 THEN
    RAISE EXCEPTION 'Cannot save DC with no items';
  END IF;

  PERFORM set_config('app.skip_dc_item_trigger', 'true', true);
  PERFORM set_config('app.sales_invoice_cancel', 'true', true);

  -- Upsert / replace items
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_new_items)
  LOOP
    v_item_id    := NULLIF(v_item->>'id', '')::uuid;
    v_product_id := NULLIF(v_item->>'product_id', '')::uuid;
    v_batch_id   := NULLIF(v_item->>'batch_id', '')::uuid;
    v_new_qty    := NULLIF(v_item->>'quantity', '')::numeric;
    v_so_item_id := NULLIF(v_item->>'sales_order_item_id', '')::uuid;

    IF v_product_id IS NULL OR v_batch_id IS NULL THEN
      RAISE EXCEPTION 'Each delivery item must have a valid product and batch';
    END IF;

    IF v_new_qty IS NULL OR v_new_qty <= 0 THEN
      RAISE EXCEPTION 'Item quantity must be greater than zero';
    END IF;

    -- Batch validity check
    SELECT is_active, (expiry_date IS NULL OR expiry_date > CURRENT_DATE)
    INTO v_batch_active, v_batch_not_expired
    FROM public.batches
    WHERE id = v_batch_id AND product_id = v_product_id;

    IF NOT FOUND OR NOT COALESCE(v_batch_active, false) OR NOT COALESCE(v_batch_not_expired, false) THEN
      RAISE EXCEPTION 'Selected batch is invalid, inactive, or expired';
    END IF;

    -- SO Item quantity constraint
    IF v_so_id IS NOT NULL AND v_so_item_id IS NOT NULL THEN
      SELECT quantity, COALESCE(delivered_quantity, 0)
      INTO v_soi_qty, v_soi_del_qty
      FROM public.sales_order_items
      WHERE id = v_so_item_id AND sales_order_id = v_so_id AND product_id = v_product_id;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'DC item does not match the linked Sales Order item';
      END IF;

      -- Other pending DCs (strictly excluding the current DC being edited)
      SELECT COALESCE(sum(dci.quantity), 0) INTO v_other_pending
      FROM public.delivery_challan_items dci
      JOIN public.delivery_challans dc ON dc.id = dci.challan_id
      WHERE dci.sales_order_item_id = v_so_item_id
        AND dc.approval_status = 'pending_approval'
        AND dc.id <> p_challan_id;

      -- Total requested quantity across p_new_items for this SO item
      SELECT COALESCE(sum((elem->>'quantity')::numeric), 0) INTO v_total_new_so_qty
      FROM jsonb_array_elements(p_new_items) elem
      WHERE NULLIF(elem->>'sales_order_item_id', '')::uuid = v_so_item_id;

      v_remaining_qty := v_soi_qty - v_soi_del_qty;
      IF (v_other_pending + v_total_new_so_qty) > (v_remaining_qty + 0.0001) THEN
        RAISE EXCEPTION 'Delivery quantity (%) exceeds remaining Sales Order quantity (%)', v_total_new_so_qty, (v_remaining_qty - v_other_pending);
      END IF;
    END IF;

    -- If no item ID supplied, attempt to match an existing unclaimed item on this DC
    IF v_item_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.delivery_challan_items WHERE id = v_item_id AND challan_id = p_challan_id) THEN
      v_matched_id := NULL;
      SELECT id INTO v_matched_id
      FROM public.delivery_challan_items
      WHERE challan_id = p_challan_id
        AND id <> ALL(v_kept_ids)
        AND (
          (v_so_item_id IS NOT NULL AND sales_order_item_id = v_so_item_id)
          OR (product_id = v_product_id)
        )
      ORDER BY (sales_order_item_id = v_so_item_id) DESC, (product_id = v_product_id) DESC
      LIMIT 1;

      IF v_matched_id IS NOT NULL THEN
        v_item_id := v_matched_id;
      END IF;
    END IF;

    IF v_item_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.delivery_challan_items WHERE id = v_item_id AND challan_id = p_challan_id) THEN
      UPDATE public.delivery_challan_items SET
        product_id = v_product_id,
        batch_id = v_batch_id,
        sales_order_item_id = v_so_item_id,
        quantity = v_new_qty,
        pack_size = NULLIF(v_item->>'pack_size', '')::numeric,
        pack_type = NULLIF(v_item->>'pack_type', ''),
        number_of_packs = NULLIF(v_item->>'number_of_packs', '')::integer
      WHERE id = v_item_id;

      v_kept_ids := array_append(v_kept_ids, v_item_id);
    ELSE
      v_item_id := COALESCE(v_item_id, gen_random_uuid());
      INSERT INTO public.delivery_challan_items (
        id, challan_id, product_id, batch_id, sales_order_item_id, quantity,
        pack_size, pack_type, number_of_packs
      ) VALUES (
        v_item_id, p_challan_id, v_product_id, v_batch_id, v_so_item_id, v_new_qty,
        NULLIF(v_item->>'pack_size', '')::numeric,
        NULLIF(v_item->>'pack_type', ''),
        NULLIF(v_item->>'number_of_packs', '')::integer
      );
      v_kept_ids := array_append(v_kept_ids, v_item_id);
    END IF;
  END LOOP;

  -- Remove any DC items that were not in the updated item list
  DELETE FROM public.delivery_challan_items
  WHERE challan_id = p_challan_id
    AND id <> ALL(v_kept_ids);

  PERFORM set_config('app.skip_dc_item_trigger', 'false', true);
  PERFORM set_config('app.sales_invoice_cancel', 'false', true);

  RETURN jsonb_build_object('success', true, 'message', 'Delivery challan updated successfully');

EXCEPTION
  WHEN foreign_key_violation THEN
    PERFORM set_config('app.skip_dc_item_trigger', 'false', true);
    PERFORM set_config('app.sales_invoice_cancel', 'false', true);
    RAISE EXCEPTION 'Invalid product or batch selection: %', SQLERRM;
  WHEN OTHERS THEN
    PERFORM set_config('app.skip_dc_item_trigger', 'false', true);
    PERFORM set_config('app.sales_invoice_cancel', 'false', true);
    RAISE EXCEPTION '%', SQLERRM;
END;
$$;

GRANT EXECUTE ON FUNCTION public.edit_delivery_challan(uuid, jsonb, jsonb) TO authenticated;

COMMIT;
