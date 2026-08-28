/*
  # Fix reserved_stock drift - remove manual increments, rely on trigger

  1. Problem
    - Multiple functions manually increment/decrement batches.reserved_stock
    - A trigger (trg_sync_batch_reserved_stock) also recalculates from actual reservations
    - These two mechanisms conflict, causing reserved_stock to drift

  2. Fix
    - Remove manual reserved_stock updates from all reservation functions
    - Let trg_sync_batch_reserved_stock be the single source of truth
    - Recalculate ALL batch reserved_stock to fix existing drift
*/

-- Drop all functions that need recreation
DROP FUNCTION IF EXISTS fn_reserve_stock_for_so_v2(uuid);
DROP FUNCTION IF EXISTS fn_release_partial_reservation(uuid, uuid, numeric, uuid);
DROP FUNCTION IF EXISTS fn_release_reservation_by_so_id(uuid, uuid);

-- 1. fn_reserve_stock_for_so_v2 - no manual reserved_stock updates
CREATE FUNCTION fn_reserve_stock_for_so_v2(p_so_id uuid)
RETURNS TABLE(success boolean, message text, shortage_items jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_item RECORD;
  v_batch RECORD;
  v_remaining_qty numeric;
  v_reserved_qty numeric;
  v_shortage_list jsonb := '[]'::jsonb;
  v_has_shortage boolean := false;
BEGIN
  DELETE FROM stock_reservations WHERE sales_order_id = p_so_id;

  FOR v_item IN 
    SELECT soi.id, soi.product_id, soi.quantity
    FROM sales_order_items soi WHERE soi.sales_order_id = p_so_id
  LOOP
    v_remaining_qty := v_item.quantity;
    FOR v_batch IN
      SELECT b.id, b.current_stock, COALESCE(b.reserved_stock, 0) as reserved_stock
      FROM batches b
      WHERE b.product_id = v_item.product_id AND b.is_active = true
        AND b.current_stock > COALESCE(b.reserved_stock, 0)
        AND (b.expiry_date IS NULL OR b.expiry_date > CURRENT_DATE)
      ORDER BY b.import_date ASC, b.created_at ASC
    LOOP
      v_reserved_qty := LEAST(v_remaining_qty, v_batch.current_stock - v_batch.reserved_stock);
      IF v_reserved_qty > 0 THEN
        INSERT INTO stock_reservations (
          sales_order_id, sales_order_item_id, batch_id, product_id, reserved_quantity, is_released
        ) VALUES (p_so_id, v_item.id, v_batch.id, v_item.product_id, v_reserved_qty, false);
        v_remaining_qty := v_remaining_qty - v_reserved_qty;
      END IF;
      EXIT WHEN v_remaining_qty <= 0;
    END LOOP;
    IF v_remaining_qty > 0 THEN
      v_has_shortage := true;
      v_shortage_list := v_shortage_list || jsonb_build_object(
        'product_id', v_item.product_id, 'required_qty', v_item.quantity, 'shortage_qty', v_remaining_qty);
    END IF;
  END LOOP;

  IF v_has_shortage THEN
    UPDATE sales_orders SET status = 'shortage', updated_at = now() WHERE id = p_so_id;
    PERFORM fn_create_import_requirements(p_so_id, v_shortage_list);
    RETURN QUERY SELECT false, 'Partial stock reserved - shortage exists.'::text, v_shortage_list;
  ELSE
    UPDATE sales_orders SET status = 'stock_reserved', updated_at = now() WHERE id = p_so_id;
    RETURN QUERY SELECT true, 'Stock fully reserved'::text, '[]'::jsonb;
  END IF;
END;
$$;

-- 2. fn_release_partial_reservation - no manual reserved_stock updates
CREATE FUNCTION fn_release_partial_reservation(
  p_so_id uuid, p_product_id uuid, p_qty numeric, p_released_by uuid
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_reservation RECORD;
  v_remaining_qty numeric := p_qty;
  v_release_qty numeric;
BEGIN
  FOR v_reservation IN
    SELECT id, reserved_quantity FROM stock_reservations
    WHERE sales_order_id = p_so_id AND product_id = p_product_id AND is_released = false
    ORDER BY created_at ASC
  LOOP
    EXIT WHEN v_remaining_qty <= 0;
    v_release_qty := LEAST(v_remaining_qty, v_reservation.reserved_quantity);
    IF v_release_qty >= v_reservation.reserved_quantity THEN
      UPDATE stock_reservations SET is_released = true, released_at = now(), released_by = p_released_by
      WHERE id = v_reservation.id;
    ELSE
      UPDATE stock_reservations SET reserved_quantity = reserved_quantity - v_release_qty
      WHERE id = v_reservation.id;
    END IF;
    v_remaining_qty := v_remaining_qty - v_release_qty;
  END LOOP;
  RETURN true;
END;
$$;

-- 3. fn_release_reservation_by_so_id - no manual reserved_stock updates
CREATE FUNCTION fn_release_reservation_by_so_id(p_so_id uuid, p_released_by uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_reservation RECORD;
BEGIN
  FOR v_reservation IN
    SELECT id FROM stock_reservations
    WHERE sales_order_id = p_so_id AND is_released = false
  LOOP
    UPDATE stock_reservations SET is_released = true, released_at = now(), released_by = p_released_by
    WHERE id = v_reservation.id;
  END LOOP;
  RETURN true;
END;
$$;

-- 4. fn_restore_reservation_on_dc_delete - no manual reserved_stock updates
CREATE OR REPLACE FUNCTION fn_restore_reservation_on_dc_delete()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_item RECORD;
BEGIN
  IF OLD.sales_order_id IS NOT NULL THEN
    FOR v_item IN
      SELECT product_id, batch_id, quantity FROM delivery_challan_items WHERE challan_id = OLD.id
    LOOP
      INSERT INTO stock_reservations (
        sales_order_id, sales_order_item_id, batch_id, product_id, reserved_quantity, status
      )
      SELECT OLD.sales_order_id, soi.id, v_item.batch_id, v_item.product_id, v_item.quantity, 'active'
      FROM sales_order_items soi
      WHERE soi.sales_order_id = OLD.sales_order_id AND soi.product_id = v_item.product_id
      LIMIT 1
      ON CONFLICT DO NOTHING;
    END LOOP;
    UPDATE sales_orders SET status = 'stock_reserved', updated_at = now() WHERE id = OLD.sales_order_id;
  END IF;
  RETURN OLD;
END;
$$;

-- 5. trg_auto_release_reservation_on_dc_item - no manual reserved_stock updates
CREATE OR REPLACE FUNCTION trg_auto_release_reservation_on_dc_item()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_so_id uuid;
  v_reservation RECORD;
  v_remaining_qty numeric;
  v_release_qty numeric;
BEGIN
  SELECT sales_order_id INTO v_so_id FROM delivery_challans WHERE id = NEW.challan_id;
  IF v_so_id IS NOT NULL THEN
    v_remaining_qty := NEW.quantity;
    FOR v_reservation IN
      SELECT id, reserved_quantity FROM stock_reservations
      WHERE sales_order_id = v_so_id AND product_id = NEW.product_id
        AND batch_id = NEW.batch_id AND status = 'active'
      ORDER BY id ASC
    LOOP
      EXIT WHEN v_remaining_qty <= 0;
      v_release_qty := LEAST(v_remaining_qty, v_reservation.reserved_quantity);
      IF v_release_qty >= v_reservation.reserved_quantity THEN
        UPDATE stock_reservations SET status = 'released' WHERE id = v_reservation.id;
      ELSE
        UPDATE stock_reservations SET reserved_quantity = reserved_quantity - v_release_qty WHERE id = v_reservation.id;
      END IF;
      v_remaining_qty := v_remaining_qty - v_release_qty;
    END LOOP;
    IF NOT EXISTS (
      SELECT 1 FROM stock_reservations WHERE sales_order_id = v_so_id AND status = 'active'
    ) THEN
      UPDATE sales_orders SET status = 'delivered', updated_at = now() WHERE id = v_so_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- 6. Recalculate ALL batch reserved_stock from actual active reservations
UPDATE batches b
SET reserved_stock = COALESCE((
  SELECT SUM(reserved_quantity) FROM stock_reservations
  WHERE batch_id = b.id AND status = 'active'
), 0)
WHERE reserved_stock > 0 
   OR EXISTS (SELECT 1 FROM stock_reservations WHERE batch_id = b.id AND status = 'active');
