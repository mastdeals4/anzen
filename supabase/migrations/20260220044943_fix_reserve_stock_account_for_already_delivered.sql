/*
  # Fix fn_reserve_stock_for_so - Account for already-delivered quantities

  ## Problem
  When a Sales Order is approved AFTER a Delivery Challan has already been 
  approved for the same products, the reservation function sees stock = 0 
  (already shipped out), reports a shortage, and creates false import requirements.

  ## Fix
  Before calculating shortage, subtract quantities already delivered via approved 
  DCs for this SO's customer and product combination. 
  
  Also consider inventory transactions of type 'delivery_challan' that happened 
  between SO creation and approval - if goods were already shipped to this customer,
  treat them as "already fulfilled" and reduce the required reservation accordingly.

  The key logic: required_qty = SO item qty - already_delivered_qty_via_dc
  If required_qty <= 0, no shortage for that item.
*/

CREATE OR REPLACE FUNCTION fn_reserve_stock_for_so(p_so_id uuid)
RETURNS TABLE(success boolean, message text, shortage_items jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_item RECORD;
  v_batch RECORD;
  v_remaining_qty numeric;
  v_reserve_qty numeric;
  v_user_id uuid;
  v_so_number text;
  v_customer_id uuid;
  v_so_date timestamptz;
  v_shortage_list jsonb := '[]'::jsonb;
  v_has_shortage boolean := false;
  v_already_delivered numeric;
BEGIN
  -- Get SO details
  SELECT created_by, so_number, customer_id, created_at
  INTO v_user_id, v_so_number, v_customer_id, v_so_date
  FROM sales_orders WHERE id = p_so_id;

  -- Loop through each SO item
  FOR v_item IN 
    SELECT * FROM sales_order_items 
    WHERE sales_order_id = p_so_id 
    ORDER BY created_at
  LOOP
    -- Calculate how much has already been delivered for this product
    -- via approved delivery challans to this customer AFTER the SO was created
    -- (covers the case where DC was approved before SO approval)
    SELECT COALESCE(SUM(dci.quantity), 0)
    INTO v_already_delivered
    FROM delivery_challan_items dci
    JOIN delivery_challans dc ON dc.id = dci.challan_id
    WHERE dci.product_id = v_item.product_id
      AND dc.customer_id = v_customer_id
      AND dc.approval_status = 'approved'
      AND dc.approved_at >= v_so_date
      AND dc.approved_at <= now()
      -- Only count DCs not already linked to another SO, or linked to this SO
      AND (dc.sales_order_id IS NULL OR dc.sales_order_id = p_so_id);

    -- Net remaining to reserve = ordered - already delivered
    v_remaining_qty := v_item.quantity - v_already_delivered;

    -- If already fully delivered, no reservation needed for this item
    IF v_remaining_qty <= 0 THEN
      -- Update delivered_quantity on the SO item
      UPDATE sales_order_items
      SET delivered_quantity = v_item.quantity
      WHERE id = v_item.id;
      CONTINUE;
    END IF;

    -- Find available batches using FIFO (earliest expiry first)
    FOR v_batch IN
      SELECT 
        b.id,
        b.batch_number,
        fn_get_free_stock(b.id) as free_stock
      FROM batches b
      WHERE b.product_id = v_item.product_id
        AND b.current_stock > 0
      ORDER BY b.expiry_date ASC, b.created_at ASC
    LOOP
      EXIT WHEN v_remaining_qty <= 0;

      IF v_batch.free_stock > 0 THEN
        v_reserve_qty := LEAST(v_remaining_qty, v_batch.free_stock);

        INSERT INTO stock_reservations (
          sales_order_id,
          sales_order_item_id,
          batch_id,
          product_id,
          reserved_quantity,
          reserved_by,
          status
        ) VALUES (
          p_so_id,
          v_item.id,
          v_batch.id,
          v_item.product_id,
          v_reserve_qty,
          v_user_id,
          'active'
        );

        INSERT INTO inventory_transactions (
          product_id,
          batch_id,
          transaction_type,
          quantity,
          transaction_date,
          reference_number,
          notes,
          created_by
        ) VALUES (
          v_item.product_id,
          v_batch.id,
          'reservation',
          v_reserve_qty,
          CURRENT_DATE,
          v_so_number,
          'Stock reserved for SO: ' || v_so_number,
          v_user_id
        );

        v_remaining_qty := v_remaining_qty - v_reserve_qty;
      END IF;
    END LOOP;

    -- Check if there's still shortage after accounting for deliveries
    IF v_remaining_qty > 0 THEN
      v_has_shortage := true;
      v_shortage_list := v_shortage_list || jsonb_build_object(
        'product_id', v_item.product_id,
        'required_qty', v_item.quantity,
        'shortage_qty', v_remaining_qty
      );
    END IF;
  END LOOP;

  -- Update SO status
  IF v_has_shortage THEN
    UPDATE sales_orders 
    SET status = 'shortage', updated_at = now()
    WHERE id = p_so_id;

    -- Auto-create import requirements for shortage
    PERFORM fn_create_import_requirements(p_so_id, v_shortage_list);

    RETURN QUERY SELECT false, 'Partial stock reserved - shortage detected. Import requirements created.', v_shortage_list;
  ELSE
    -- Check if any items were already delivered (all delivered = delivered status)
    IF EXISTS (
      SELECT 1 FROM sales_order_items 
      WHERE sales_order_id = p_so_id 
        AND delivered_quantity >= quantity
    ) AND NOT EXISTS (
      SELECT 1 FROM sales_order_items
      WHERE sales_order_id = p_so_id
        AND delivered_quantity < quantity
    ) THEN
      UPDATE sales_orders 
      SET status = 'delivered', updated_at = now()
      WHERE id = p_so_id;
    ELSE
      UPDATE sales_orders 
      SET status = 'stock_reserved', updated_at = now()
      WHERE id = p_so_id;
    END IF;

    RETURN QUERY SELECT true, 'Stock reserved successfully', '[]'::jsonb;
  END IF;
END;
$$;
