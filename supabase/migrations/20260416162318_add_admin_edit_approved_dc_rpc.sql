/*
  # Admin Edit Approved Delivery Challan

  1. Problem
    - Approved DC items cannot be edited via the existing `edit_delivery_challan`
      RPC because it rejects DCs where `approved_at IS NOT NULL`. Admins need a
      way to correct genuine mistakes (wrong batch, wrong quantity) after
      approval, with proper stock re-adjustment.

  2. New Function `admin_edit_approved_delivery_challan`
    - Accepts challan_id and new items payload.
    - Only callable by admin users (checked via user_profiles.role).
    - Reverses old inventory_transactions for this challan (restores stock).
    - Deletes old DC items.
    - Inserts new DC items and creates new inventory_transactions.
    - Verifies each new batch has sufficient current_stock before deducting.

  3. Security
    - SECURITY DEFINER, search_path=public.
    - Internal role check enforces admin-only usage.
    - Input is validated; stock sufficiency is enforced.
*/

CREATE OR REPLACE FUNCTION public.admin_edit_approved_delivery_challan(
  p_challan_id uuid,
  p_new_items jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_role text;
  v_challan record;
  v_item jsonb;
  v_old record;
  v_count integer;
  v_product_id uuid;
  v_batch_id uuid;
  v_qty numeric;
  v_pack_size numeric;
  v_pack_type text;
  v_packs integer;
  v_current_stock numeric;
  v_reserved numeric;
BEGIN
  SELECT role INTO v_role FROM user_profiles WHERE id = auth.uid();
  IF v_role IS DISTINCT FROM 'admin' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Only admin can edit approved DCs');
  END IF;

  SELECT * INTO v_challan FROM delivery_challans WHERE id = p_challan_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Delivery challan not found');
  END IF;

  SELECT count(*) INTO v_count FROM jsonb_array_elements(p_new_items);
  IF v_count = 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Cannot save DC with no items');
  END IF;

  PERFORM set_config('app.skip_dc_item_trigger', 'true', true);

  -- Reverse old inventory transactions (add back the deducted stock)
  FOR v_old IN
    SELECT id, batch_id, product_id, quantity
    FROM inventory_transactions
    WHERE reference_type = 'delivery_challan'
      AND reference_id = p_challan_id
  LOOP
    PERFORM post_inventory_movement(
      v_old.product_id,
      v_old.batch_id,
      ABS(v_old.quantity),
      'adjustment',
      'delivery_challan_admin_edit_reverse',
      v_old.id,
      auth.uid()
    );
    DELETE FROM inventory_transactions WHERE id = v_old.id;
  END LOOP;

  -- Remove existing DC items
  DELETE FROM delivery_challan_items WHERE challan_id = p_challan_id;

  -- Insert new items, deduct stock, and create transactions
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_new_items) LOOP
    v_product_id := (v_item->>'product_id')::uuid;
    v_batch_id   := (v_item->>'batch_id')::uuid;
    v_qty        := (v_item->>'quantity')::numeric;
    v_pack_size  := NULLIF(v_item->>'pack_size','')::numeric;
    v_pack_type  := NULLIF(v_item->>'pack_type','');
    v_packs      := NULLIF(v_item->>'number_of_packs','')::integer;

    SELECT current_stock, COALESCE(reserved_stock,0)
    INTO v_current_stock, v_reserved
    FROM batches WHERE id = v_batch_id FOR UPDATE;

    IF v_current_stock < v_qty THEN
      PERFORM set_config('app.skip_dc_item_trigger', 'false', true);
      RETURN jsonb_build_object(
        'success', false,
        'error', format('Insufficient stock in batch. Available: %s, required: %s', v_current_stock, v_qty)
      );
    END IF;

    INSERT INTO delivery_challan_items (
      challan_id, product_id, batch_id, quantity,
      pack_size, pack_type, number_of_packs
    ) VALUES (
      p_challan_id, v_product_id, v_batch_id, v_qty,
      v_pack_size, v_pack_type, v_packs
    );

    PERFORM post_inventory_movement(
      v_product_id,
      v_batch_id,
      -v_qty,
      'delivery_challan',
      'delivery_challan',
      p_challan_id,
      auth.uid()
    );
  END LOOP;

  PERFORM set_config('app.skip_dc_item_trigger', 'false', true);

  RETURN jsonb_build_object('success', true, 'message', 'Approved DC updated successfully');

EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.skip_dc_item_trigger', 'false', true);
  RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.admin_edit_approved_delivery_challan(uuid, jsonb) TO authenticated;
