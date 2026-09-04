/*
  # Create Atomic DC Edit Function
  
  ## Problem
  Current edit flow:
  1. DELETE all DC items → triggers fire → releases reservations/adds stock
  2. INSERT new DC items → triggers fire → creates new reservations
  3. If step 2 fails, step 1 already corrupted stock
  4. Even if successful, unnecessary trigger firings cause stock confusion
  
  ## Solution
  Create RPC function that handles DC edit atomically:
  1. Calculates net changes in reservations (old vs new items)
  2. Deletes old items WITHOUT triggers
  3. Inserts new items WITHOUT triggers  
  4. Manually updates batch reservations with net changes only
  5. Creates single inventory transaction for the net change
*/

CREATE OR REPLACE FUNCTION edit_delivery_challan(
  p_challan_id uuid,
  p_new_items jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old_item record;
  v_new_item jsonb;
  v_challan record;
  v_batch_id text;
  v_changes jsonb;
  v_old_reservation numeric;
  v_new_reservation numeric;
  v_net_change numeric;
  v_batch_changes_obj jsonb := '{}'::jsonb;
BEGIN
  -- Get challan details
  SELECT * INTO v_challan
  FROM delivery_challans
  WHERE id = p_challan_id;
  
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Delivery challan not found');
  END IF;
  
  -- Only allow editing PENDING DCs
  IF v_challan.approval_status != 'pending_approval' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Can only edit pending delivery challans');
  END IF;
  
  -- Build batch changes map: old reservations per batch
  FOR v_old_item IN 
    SELECT batch_id, SUM(quantity) as total_qty
    FROM delivery_challan_items
    WHERE challan_id = p_challan_id
    GROUP BY batch_id
  LOOP
    v_batch_changes_obj := jsonb_set(
      v_batch_changes_obj,
      array[v_old_item.batch_id::text],
      jsonb_build_object('old', v_old_item.total_qty, 'new', 0)
    );
  END LOOP;
  
  -- Add new reservations to the map
  FOR v_new_item IN SELECT * FROM jsonb_array_elements(p_new_items)
  LOOP
    v_old_reservation := COALESCE(((v_batch_changes_obj->(v_new_item->>'batch_id'))->>'old')::numeric, 0);
    v_new_reservation := COALESCE(((v_batch_changes_obj->(v_new_item->>'batch_id'))->>'new')::numeric, 0);
    v_new_reservation := v_new_reservation + (v_new_item->>'quantity')::numeric;
    
    v_batch_changes_obj := jsonb_set(
      v_batch_changes_obj,
      array[v_new_item->>'batch_id'],
      jsonb_build_object('old', v_old_reservation, 'new', v_new_reservation)
    );
  END LOOP;
  
  -- Temporarily disable triggers
  ALTER TABLE delivery_challan_items DISABLE TRIGGER trigger_dc_item_insert;
  ALTER TABLE delivery_challan_items DISABLE TRIGGER trigger_dc_item_delete;
  ALTER TABLE delivery_challan_items DISABLE TRIGGER trigger_auto_release_reservation_on_dc_item;
  
  -- Delete old items (triggers disabled)
  DELETE FROM delivery_challan_items
  WHERE challan_id = p_challan_id;
  
  -- Insert new items (triggers disabled)
  INSERT INTO delivery_challan_items (
    challan_id, product_id, batch_id, quantity,
    pack_size, pack_type, number_of_packs
  )
  SELECT 
    p_challan_id,
    (item->>'product_id')::uuid,
    (item->>'batch_id')::uuid,
    (item->>'quantity')::numeric,
    (item->>'pack_size')::numeric,
    item->>'pack_type',
    (item->>'number_of_packs')::integer
  FROM jsonb_array_elements(p_new_items) as item;
  
  -- Re-enable triggers
  ALTER TABLE delivery_challan_items ENABLE TRIGGER trigger_dc_item_insert;
  ALTER TABLE delivery_challan_items ENABLE TRIGGER trigger_dc_item_delete;
  ALTER TABLE delivery_challan_items ENABLE TRIGGER trigger_auto_release_reservation_on_dc_item;
  
  -- Apply net reservation changes per batch
  FOR v_batch_id, v_changes IN 
    SELECT key, value FROM jsonb_each(v_batch_changes_obj)
  LOOP
    v_old_reservation := (v_changes->>'old')::numeric;
    v_new_reservation := (v_changes->>'new')::numeric;
    v_net_change := v_new_reservation - v_old_reservation;
    
    IF v_net_change != 0 THEN
      -- Update batch reserved_stock
      UPDATE batches
      SET reserved_stock = GREATEST(0, COALESCE(reserved_stock, 0) + v_net_change)
      WHERE id = v_batch_id::uuid;
      
      -- Log transaction
      INSERT INTO inventory_transactions (
        product_id, batch_id, transaction_type, quantity,
        transaction_date, reference_number, reference_type, reference_id,
        notes, created_by
      )
      SELECT 
        b.product_id,
        b.id,
        'adjustment',
        v_net_change,
        v_challan.challan_date,
        v_challan.challan_number,
        'dc_edit',
        v_challan.id,
        CASE 
          WHEN v_net_change > 0 THEN 'DC Edit: Increased reservation by ' || v_net_change || ' kg'
          ELSE 'DC Edit: Decreased reservation by ' || ABS(v_net_change) || ' kg'
        END,
        auth.uid()
      FROM batches b
      WHERE b.id = v_batch_id::uuid;
    END IF;
  END LOOP;
  
  RETURN jsonb_build_object('success', true, 'message', 'Delivery challan updated successfully');
  
EXCEPTION
  WHEN OTHERS THEN
    -- Re-enable triggers in case of error
    ALTER TABLE delivery_challan_items ENABLE TRIGGER trigger_dc_item_insert;
    ALTER TABLE delivery_challan_items ENABLE TRIGGER trigger_dc_item_delete;
    ALTER TABLE delivery_challan_items ENABLE TRIGGER trigger_auto_release_reservation_on_dc_item;
    
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;
