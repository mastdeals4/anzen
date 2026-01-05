/*
  # Fix DC Edit - Delta-Based Stock Logic
  
  ## The REAL Problem
  When editing a DC:
  - Old: 600kg from batch A-3145
  - New: 600kg from A-3145 + 350kg from A-3146
  
  Current broken logic:
  1. DELETE 600kg item → releases 600kg
  2. INSERT 600kg item → tries to reserve 600kg (FAILS due to race condition)
  3. INSERT 350kg item → never gets here
  
  ## Correct Delta Logic
  For each batch:
  - IF batch exists in both old and new:
    - Calculate difference = new_qty - old_qty
    - IF difference > 0: reserve MORE
    - IF difference < 0: release EXCESS
    - IF difference = 0: do NOTHING
  - IF batch only in old: release ALL
  - IF batch only in new: reserve ALL
  
  ## Implementation
  Use UPSERT logic instead of DELETE ALL + INSERT ALL
*/

-- Drop the broken edit function
DROP FUNCTION IF EXISTS edit_delivery_challan(uuid, jsonb);

-- Create smart delta-based edit function
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
  v_challan record;
  v_item jsonb;
  v_count integer;
  v_old_items record;
  v_old_qty numeric;
  v_new_qty numeric;
  v_difference numeric;
  v_product_id uuid;
  v_batch_id uuid;
  v_current_stock numeric;
  v_reserved_stock numeric;
BEGIN
  -- Get challan details
  SELECT * INTO v_challan
  FROM delivery_challans
  WHERE id = p_challan_id;
  
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Delivery challan not found');
  END IF;
  
  -- Cannot edit if ever approved
  IF v_challan.approved_at IS NOT NULL THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Cannot edit approved delivery challan. Stock was already deducted. Create a new DC or use Material Return.'
    );
  END IF;
  
  -- Validate new items count
  SELECT count(*) INTO v_count FROM jsonb_array_elements(p_new_items);
  IF v_count = 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Cannot save DC with no items');
  END IF;
  
  -- Step 1: Release reservations for items that are being REMOVED
  FOR v_old_items IN 
    SELECT dci.*, b.batch_number, b.current_stock
    FROM delivery_challan_items dci
    JOIN batches b ON dci.batch_id = b.id
    WHERE dci.challan_id = p_challan_id
    AND dci.batch_id NOT IN (
      SELECT (item->>'batch_id')::uuid 
      FROM jsonb_array_elements(p_new_items) item
    )
  LOOP
    RAISE NOTICE 'Removing batch % - releasing %kg', v_old_items.batch_number, v_old_items.quantity;
    
    -- Release reservation
    UPDATE batches
    SET reserved_stock = GREATEST(0, COALESCE(reserved_stock, 0) - v_old_items.quantity)
    WHERE id = v_old_items.batch_id;
    
    -- Delete the item
    DELETE FROM delivery_challan_items WHERE id = v_old_items.id;
  END LOOP;
  
  -- Step 2: Process each NEW item (update existing or insert new)
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_new_items)
  LOOP
    v_product_id := (v_item->>'product_id')::uuid;
    v_batch_id := (v_item->>'batch_id')::uuid;
    v_new_qty := (v_item->>'quantity')::numeric;
    
    -- Check if this batch already exists in old items
    SELECT quantity INTO v_old_qty
    FROM delivery_challan_items
    WHERE challan_id = p_challan_id
      AND batch_id = v_batch_id;
    
    IF FOUND THEN
      -- Batch exists - calculate difference
      v_difference := v_new_qty - v_old_qty;
      
      RAISE NOTICE 'Batch % exists: old=%kg, new=%kg, diff=%kg', 
        v_batch_id, v_old_qty, v_new_qty, v_difference;
      
      IF v_difference != 0 THEN
        -- Get current batch state
        SELECT current_stock, reserved_stock 
        INTO v_current_stock, v_reserved_stock
        FROM batches WHERE id = v_batch_id;
        
        -- Adjust reservation by difference
        UPDATE batches
        SET reserved_stock = COALESCE(reserved_stock, 0) + v_difference
        WHERE id = v_batch_id;
        
        -- Validate after adjustment
        SELECT reserved_stock INTO v_reserved_stock
        FROM batches WHERE id = v_batch_id;
        
        IF v_reserved_stock > v_current_stock THEN
          RAISE EXCEPTION 'Insufficient stock: Batch has %kg available but trying to reserve %kg total (increase of %kg)', 
            v_current_stock, v_reserved_stock, v_difference;
        END IF;
        
        -- Update the item quantity
        UPDATE delivery_challan_items
        SET quantity = v_new_qty,
            pack_size = (v_item->>'pack_size')::numeric,
            pack_type = v_item->>'pack_type',
            number_of_packs = (v_item->>'number_of_packs')::integer
        WHERE challan_id = p_challan_id
          AND batch_id = v_batch_id;
      END IF;
      
    ELSE
      -- New batch - reserve full quantity
      RAISE NOTICE 'New batch % - reserving %kg', v_batch_id, v_new_qty;
      
      -- Get current batch state
      SELECT current_stock, reserved_stock 
      INTO v_current_stock, v_reserved_stock
      FROM batches WHERE id = v_batch_id;
      
      -- Check if we can reserve
      IF (COALESCE(v_reserved_stock, 0) + v_new_qty) > v_current_stock THEN
        RAISE EXCEPTION 'Insufficient stock: Batch has %kg available but trying to reserve %kg additional', 
          v_current_stock - COALESCE(v_reserved_stock, 0), v_new_qty;
      END IF;
      
      -- Reserve stock
      UPDATE batches
      SET reserved_stock = COALESCE(reserved_stock, 0) + v_new_qty
      WHERE id = v_batch_id;
      
      -- Insert new item (but disable the trigger to avoid double reservation)
      INSERT INTO delivery_challan_items (
        challan_id, 
        product_id, 
        batch_id, 
        quantity,
        pack_size, 
        pack_type, 
        number_of_packs
      ) VALUES (
        p_challan_id,
        v_product_id,
        v_batch_id,
        v_new_qty,
        (v_item->>'pack_size')::numeric,
        v_item->>'pack_type',
        (v_item->>'number_of_packs')::integer
      );
      
      -- Manual transaction log since we're bypassing trigger
      INSERT INTO inventory_transactions (
        product_id, batch_id, transaction_type, quantity,
        transaction_date, reference_number, reference_type, reference_id,
        notes, created_by, stock_before, stock_after
      ) VALUES (
        v_product_id, v_batch_id, 'delivery_challan_reserved', -v_new_qty,
        v_challan.challan_date, v_challan.challan_number, 'delivery_challan_item', p_challan_id,
        'Reserved for DC: ' || v_challan.challan_number || ' (Added in Edit)', v_challan.created_by,
        v_current_stock, v_current_stock
      );
    END IF;
  END LOOP;
  
  RETURN jsonb_build_object('success', true, 'message', 'Delivery challan updated successfully');
  
EXCEPTION
  WHEN foreign_key_violation THEN
    RETURN jsonb_build_object('success', false, 'error', 'Invalid product or batch selection');
  WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

-- Disable the automatic trigger during RPC edits to avoid double processing
CREATE OR REPLACE FUNCTION trg_delivery_challan_item_inventory()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_challan_number text;
  v_user_id uuid;
  v_challan_date date;
  v_current_stock numeric;
  v_reserved_stock numeric;
  v_approval_status text;
BEGIN
  -- Skip trigger if being called from edit_delivery_challan RPC
  IF current_setting('app.skip_dc_item_trigger', true) = 'true' THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- Get DC details
    SELECT dc.challan_number, dc.created_by, dc.challan_date, dc.approval_status
    INTO v_challan_number, v_user_id, v_challan_date, v_approval_status
    FROM delivery_challans dc WHERE dc.id = NEW.challan_id;
    
    -- Get current batch state
    SELECT current_stock, reserved_stock 
    INTO v_current_stock, v_reserved_stock
    FROM batches WHERE id = NEW.batch_id;
    
    -- Check if we can reserve BEFORE updating
    IF (COALESCE(v_reserved_stock, 0) + NEW.quantity) > v_current_stock THEN
      RAISE EXCEPTION 'Insufficient stock: Batch has %kg available but trying to reserve %kg total', 
        v_current_stock, COALESCE(v_reserved_stock, 0) + NEW.quantity;
    END IF;
    
    -- Reserve stock
    UPDATE batches
    SET reserved_stock = COALESCE(reserved_stock, 0) + NEW.quantity
    WHERE id = NEW.batch_id;
    
    -- Log transaction
    INSERT INTO inventory_transactions (
      product_id, batch_id, transaction_type, quantity,
      transaction_date, reference_number, reference_type, reference_id,
      notes, created_by, stock_before, stock_after
    ) VALUES (
      NEW.product_id, NEW.batch_id, 'delivery_challan_reserved', -NEW.quantity,
      v_challan_date, v_challan_number, 'delivery_challan_item', NEW.id,
      'Reserved for DC: ' || v_challan_number || ' (Pending Approval)', v_user_id,
      v_current_stock, v_current_stock
    );
    
    RETURN NEW;
    
  ELSIF TG_OP = 'DELETE' THEN
    -- Skip if being called from edit RPC (it handles releases manually)
    IF current_setting('app.skip_dc_item_trigger', true) = 'true' THEN
      RETURN OLD;
    END IF;
    
    -- Get DC details
    SELECT dc.challan_number, dc.created_by 
    INTO v_challan_number, v_user_id
    FROM delivery_challans dc WHERE dc.id = OLD.challan_id;
    
    -- Get current stock
    SELECT current_stock INTO v_current_stock
    FROM batches WHERE id = OLD.batch_id;
    
    -- Release reservation
    UPDATE batches
    SET reserved_stock = GREATEST(0, COALESCE(reserved_stock, 0) - OLD.quantity)
    WHERE id = OLD.batch_id;
    
    -- Log transaction
    INSERT INTO inventory_transactions (
      product_id, batch_id, transaction_type, quantity,
      transaction_date, reference_number, reference_type, reference_id,
      notes, created_by, stock_before, stock_after
    ) VALUES (
      OLD.product_id, OLD.batch_id, 'adjustment', OLD.quantity,
      CURRENT_DATE, v_challan_number, 'dc_item_delete', OLD.challan_id,
      'Released reservation from deleted DC item', COALESCE(auth.uid(), v_user_id),
      v_current_stock, v_current_stock
    );
    
    RETURN OLD;
  END IF;
END;
$$;
