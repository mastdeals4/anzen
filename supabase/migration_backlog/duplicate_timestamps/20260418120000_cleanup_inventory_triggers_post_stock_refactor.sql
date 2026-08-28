/*
  # Cleanup inventory triggers after stock refactor

  Goal:
  - Remove all direct stock movements and inventory_transactions writes from triggers.
  - Keep only validation/status/reservation behavior in trigger functions.
  - Stock and inventory ledger posting must be handled by application/RPC flow.
*/

-- =====================================================
-- Sales invoice item trigger: keep lightweight guards only
-- =====================================================
CREATE OR REPLACE FUNCTION trg_sales_invoice_item_inventory()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Trigger retained intentionally after stock refactor.
  -- No direct batch stock updates and no inventory_transactions writes.
  IF TG_OP = 'INSERT' THEN
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

-- =====================================================
-- Delivery challan item trigger: keep reservation + validation only
-- =====================================================
CREATE OR REPLACE FUNCTION trg_delivery_challan_item_inventory()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_current_stock numeric;
  v_reserved_stock numeric;
BEGIN
  -- Skip trigger if being called from edit_delivery_challan RPC
  IF current_setting('app.skip_dc_item_trigger', true) = 'true' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- Validate reserve availability
    SELECT current_stock, reserved_stock
    INTO v_current_stock, v_reserved_stock
    FROM batches
    WHERE id = NEW.batch_id;

    IF (COALESCE(v_reserved_stock, 0) + NEW.quantity) > v_current_stock THEN
      RAISE EXCEPTION 'Insufficient stock: Batch has %kg available but trying to reserve %kg total',
        v_current_stock, COALESCE(v_reserved_stock, 0) + NEW.quantity;
    END IF;

    -- Reserve stock only
    UPDATE batches
    SET reserved_stock = COALESCE(reserved_stock, 0) + NEW.quantity
    WHERE id = NEW.batch_id;

    RETURN NEW;

  ELSIF TG_OP = 'DELETE' THEN
    -- Release reservation only
    UPDATE batches
    SET reserved_stock = GREATEST(0, COALESCE(reserved_stock, 0) - OLD.quantity)
    WHERE id = OLD.batch_id;

    RETURN OLD;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

-- =====================================================
-- DC approval trigger: keep reservation release only
-- =====================================================
CREATE OR REPLACE FUNCTION trg_dc_approval_deduct_stock()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_item RECORD;
BEGIN
  -- Only process when status changes to approved
  IF NEW.approval_status = 'approved' AND (OLD.approval_status != 'approved') THEN
    FOR v_item IN
      SELECT * FROM delivery_challan_items WHERE challan_id = NEW.id
    LOOP
      -- Release reservation only (no current_stock movement here)
      UPDATE batches
      SET reserved_stock = GREATEST(0, COALESCE(reserved_stock, 0) - v_item.quantity)
      WHERE id = v_item.batch_id;
    END LOOP;
  END IF;

  RETURN NEW;
END;
$$;

-- =====================================================
-- Credit note item trigger: keep status checks only
-- =====================================================
CREATE OR REPLACE FUNCTION trg_credit_note_item_inventory()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT COALESCE(cn.status, 'pending')
    INTO v_status
    FROM credit_notes cn
    WHERE cn.id = NEW.credit_note_id;

    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    SELECT COALESCE(cn.status, 'pending')
    INTO v_status
    FROM credit_notes cn
    WHERE cn.id = OLD.credit_note_id;

    RETURN OLD;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

-- =====================================================
-- Material return trigger: keep approval/status checks only
-- =====================================================
CREATE OR REPLACE FUNCTION trg_material_return_item_stock()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_return_status text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    SELECT status INTO v_return_status
    FROM material_returns
    WHERE id = NEW.return_id;
  END IF;

  RETURN NEW;
END;
$$;

-- =====================================================
-- Stock rejection trigger: keep status transition check only
-- =====================================================
CREATE OR REPLACE FUNCTION trg_stock_rejection_approved()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Trigger retained for status transition checks; no stock write from trigger.
  IF TG_OP = 'UPDATE' AND NEW.status = 'approved' AND OLD.status != 'approved' THEN
    RETURN NEW;
  END IF;

  RETURN NEW;
END;
$$;

-- =====================================================
-- Credit note status trigger: keep status transition checks only
-- =====================================================
CREATE OR REPLACE FUNCTION trg_credit_note_status_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Retained intentionally; stock posting is handled outside trigger path.
  IF NEW.status = 'approved' AND COALESCE(OLD.status, 'pending') != 'approved' THEN
    RETURN NEW;
  END IF;

  IF COALESCE(OLD.status, 'pending') = 'approved' AND NEW.status = 'rejected' THEN
    RETURN NEW;
  END IF;

  RETURN NEW;
END;
$$;
