/*
  # Fix DC Edit RPC - Complete Rewrite
  
  ## Problems with Old Function
  1. ALTER TABLE doesn't work in SECURITY DEFINER functions
  2. Triggers can't be disabled in transactions
  3. Foreign key errors when inserting items
  
  ## New Approach
  1. Don't disable triggers - work WITH them
  2. Calculate differences BEFORE making changes
  3. Delete old items one by one (triggers handle reservation release)
  4. Insert new items one by one (triggers handle new reservations)
  5. Much simpler, much safer
  
  ## How It Works
  - Old items deleted → triggers automatically release reservations
  - New items inserted → triggers automatically create reservations
  - Net effect: Only the DIFFERENCE in quantities affects stock
*/

-- Drop old version
DROP FUNCTION IF EXISTS edit_delivery_challan(uuid, jsonb);

-- Create new, simpler version that works WITH triggers instead of against them
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
    RETURN jsonb_build_object(
      'success', false, 
      'error', 'Can only edit pending delivery challans. This DC is ' || v_challan.approval_status
    );
  END IF;
  
  -- Validate new items exist
  SELECT count(*) INTO v_count FROM jsonb_array_elements(p_new_items);
  IF v_count = 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Cannot update DC with no items');
  END IF;
  
  -- Step 1: Delete ALL old items
  -- The DELETE trigger will automatically release reservations
  DELETE FROM delivery_challan_items
  WHERE challan_id = p_challan_id;
  
  -- Step 2: Insert ALL new items  
  -- The INSERT trigger will automatically create new reservations
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_new_items)
  LOOP
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
      (v_item->>'product_id')::uuid,
      (v_item->>'batch_id')::uuid,
      (v_item->>'quantity')::numeric,
      (v_item->>'pack_size')::numeric,
      v_item->>'pack_type',
      (v_item->>'number_of_packs')::integer
    );
  END LOOP;
  
  RETURN jsonb_build_object(
    'success', true, 
    'message', 'Delivery challan updated successfully'
  );
  
EXCEPTION
  WHEN foreign_key_violation THEN
    RETURN jsonb_build_object(
      'success', false, 
      'error', 'Invalid product or batch selection: ' || SQLERRM
    );
  WHEN OTHERS THEN
    RETURN jsonb_build_object(
      'success', false, 
      'error', SQLERRM
    );
END;
$$;

-- Grant execute permission
GRANT EXECUTE ON FUNCTION edit_delivery_challan(uuid, jsonb) TO authenticated;
