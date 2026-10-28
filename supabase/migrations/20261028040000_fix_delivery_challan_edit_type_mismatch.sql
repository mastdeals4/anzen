-- ============================================================================
-- Migration: 20261028040000_fix_delivery_challan_edit_type_mismatch.sql
-- Description:
-- 1. Fixes the PostgreSQL type error: "COALESCE types text and dc_approval_status cannot be matched"
--    in edit_delivery_challan RPC by validating and casting approval_status to public.dc_approval_status.
-- 2. Eliminates signature ambiguity between 2-arg and 3-arg overloads by defining a single canonical
--    edit_delivery_challan function with DEFAULT NULL for p_header.
-- 3. Enforces Sales Order quantity constraints, batch validity, and parent SO status checks atomically.
-- ============================================================================

BEGIN;

-- Drop existing overloads to avoid signature collision
DROP FUNCTION IF EXISTS public.edit_delivery_challan(uuid, jsonb);
DROP FUNCTION IF EXISTS public.edit_delivery_challan(uuid, jsonb, jsonb);

CREATE OR REPLACE FUNCTION public.edit_delivery_challan(
  p_challan_id uuid,
  p_new_items jsonb,
  p_header jsonb DEFAULT NULL::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
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
          RETURN jsonb_build_object(
            'success', false,
            'error', 'Invalid approval_status: ' || v_new_status || '. Allowed values are pending_approval, rejected, cancelled.'
          );
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
        RETURN jsonb_build_object(
          'success', false,
          'error', 'Cannot save Delivery Challan: linked Sales Order is ' || v_so_status
        );
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
        RETURN jsonb_build_object(
          'success', false,
          'error', 'Cannot save Delivery Challan: linked Sales Order is ' || v_so_status
        );
      END IF;
    END IF;
  END IF;

  SELECT count(*) INTO v_count FROM jsonb_array_elements(p_new_items);
  IF v_count = 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Cannot save DC with no items');
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
      RETURN jsonb_build_object('success', false, 'error', 'Each delivery item must have a valid product and batch');
    END IF;

    IF v_new_qty IS NULL OR v_new_qty <= 0 THEN
      RETURN jsonb_build_object('success', false, 'error', 'Item quantity must be greater than zero');
    END IF;

    -- Batch validity check
    SELECT is_active, (expiry_date IS NULL OR expiry_date > CURRENT_DATE)
    INTO v_batch_active, v_batch_not_expired
    FROM public.batches
    WHERE id = v_batch_id AND product_id = v_product_id;

    IF NOT FOUND OR NOT COALESCE(v_batch_active, false) OR NOT COALESCE(v_batch_not_expired, false) THEN
      RETURN jsonb_build_object('success', false, 'error', 'Selected batch is invalid, inactive, or expired');
    END IF;

    -- SO Item quantity constraint
    IF v_so_id IS NOT NULL AND v_so_item_id IS NOT NULL THEN
      SELECT quantity, COALESCE(delivered_quantity, 0)
      INTO v_soi_qty, v_soi_del_qty
      FROM public.sales_order_items
      WHERE id = v_so_item_id AND sales_order_id = v_so_id AND product_id = v_product_id;

      IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'DC item does not match the linked Sales Order item');
      END IF;

      SELECT COALESCE(sum(dci.quantity), 0) INTO v_other_pending
      FROM public.delivery_challan_items dci
      JOIN public.delivery_challans dc ON dc.id = dci.challan_id
      WHERE dci.sales_order_item_id = v_so_item_id
        AND dc.approval_status = 'pending_approval'
        AND dc.id <> p_challan_id;

      v_remaining_qty := v_soi_qty - v_soi_del_qty;
      IF (v_other_pending + v_new_qty) > (v_remaining_qty + 0.0001) THEN
        RETURN jsonb_build_object(
          'success', false,
          'error', 'Delivery quantity (' || v_new_qty || ') exceeds remaining Sales Order quantity (' || (v_remaining_qty - v_other_pending) || ')'
        );
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
    RETURN jsonb_build_object('success', false, 'error', 'Invalid product or batch selection: ' || SQLERRM);
  WHEN OTHERS THEN
    PERFORM set_config('app.skip_dc_item_trigger', 'false', true);
    PERFORM set_config('app.sales_invoice_cancel', 'false', true);
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

GRANT EXECUTE ON FUNCTION public.edit_delivery_challan(uuid, jsonb, jsonb) TO authenticated;

COMMIT;
