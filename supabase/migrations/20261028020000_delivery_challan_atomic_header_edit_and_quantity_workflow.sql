-- ============================================================================
-- Migration: Delivery Challan Atomic Header Edit and Quantity Workflow
-- Description:
-- 1. Updates edit_delivery_challan RPC to accept optional p_header parameter,
--    allowing header updates and reactivation to occur atomically with item updates.
--    If item validation or SO quantity constraints fail, the entire transaction rolls back.
-- 2. Preserves the 2-argument edit_delivery_challan overload for full backward compatibility.
-- ============================================================================

-- Function overload: 3 arguments (with optional header)
CREATE OR REPLACE FUNCTION public.edit_delivery_challan(
  p_challan_id uuid,
  p_new_items jsonb,
  p_header jsonb DEFAULT NULL
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
  v_blocking_invoices  text;
  v_kept_ids           uuid[] := ARRAY[]::uuid[];
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

  -- Update header atomically if provided
  IF p_header IS NOT NULL THEN
    UPDATE public.delivery_challans SET
      customer_id = COALESCE((p_header->>'customer_id')::uuid, customer_id),
      sales_order_id = CASE WHEN p_header ? 'sales_order_id' THEN NULLIF(p_header->>'sales_order_id', '')::uuid ELSE sales_order_id END,
      challan_date = COALESCE((p_header->>'challan_date')::date, challan_date),
      delivery_address = COALESCE(p_header->>'delivery_address', delivery_address),
      vehicle_number = CASE WHEN p_header ? 'vehicle_number' THEN NULLIF(p_header->>'vehicle_number', '') ELSE vehicle_number END,
      driver_name = CASE WHEN p_header ? 'driver_name' THEN NULLIF(p_header->>'driver_name', '') ELSE driver_name END,
      notes = CASE WHEN p_header ? 'notes' THEN NULLIF(p_header->>'notes', '') ELSE notes END,
      approval_status = COALESCE(NULLIF(TRIM(p_header->>'approval_status'), '')::public.dc_approval_status, approval_status),
      rejection_reason = CASE WHEN (p_header->>'approval_status') = 'pending_approval' THEN NULL ELSE rejection_reason END,
      rejected_by = CASE WHEN (p_header->>'approval_status') = 'pending_approval' THEN NULL ELSE rejected_by END,
      rejected_at = CASE WHEN (p_header->>'approval_status') = 'pending_approval' THEN NULL ELSE rejected_at END,
      approved_at = CASE WHEN (p_header->>'approval_status') = 'pending_approval' THEN NULL ELSE approved_at END,
      approved_by = CASE WHEN (p_header->>'approval_status') = 'pending_approval' THEN NULL ELSE approved_by END,
      updated_at = NOW()
    WHERE id = p_challan_id;
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
    v_product_id := (v_item->>'product_id')::uuid;
    v_batch_id   := (v_item->>'batch_id')::uuid;
    v_new_qty    := (v_item->>'quantity')::numeric;
    v_so_item_id := NULLIF(v_item->>'sales_order_item_id', '')::uuid;

    IF v_new_qty <= 0 THEN
      RAISE EXCEPTION 'Item quantity must be greater than zero';
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

-- Overload: 2 arguments calling 3-argument version
CREATE OR REPLACE FUNCTION public.edit_delivery_challan(
  p_challan_id uuid,
  p_new_items jsonb
)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT public.edit_delivery_challan(p_challan_id, p_new_items, NULL::jsonb);
$$;

GRANT EXECUTE ON FUNCTION public.edit_delivery_challan(uuid, jsonb, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.edit_delivery_challan(uuid, jsonb) TO authenticated;
