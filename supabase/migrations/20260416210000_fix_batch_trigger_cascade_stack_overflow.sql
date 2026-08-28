/*
  # Fix: Batch triggers cascade causing stack depth limit exceeded

  ## Root Cause
  When trg_sync_batch_reserved_stock updates batches.reserved_stock, it fires
  auto_reallocate_on_batch_change (which fires on ANY column change on batches).
  That reallocate function may update other batches, which fires the trigger again,
  creating infinite recursion → stack depth exceeded.

  Additionally, trigger_update_product_stock fires on every batch update to
  aggregate current_stock to products, which also re-triggers deeply.

  ## Fix
  1. Add WHEN conditions to batch triggers so they only fire on relevant column changes
     (not on reserved_stock-only changes)
  2. Add pg_trigger_depth() guard to trg_sync_batch_reserved_stock to prevent
     re-entry when already inside a trigger stack
*/

-- ===========================================================================
-- 1. Guard trg_sync_batch_reserved_stock against re-entry
--    Only run when NOT already inside another trigger call
-- ===========================================================================
CREATE OR REPLACE FUNCTION trg_sync_batch_reserved_stock()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Guard: don't re-run if we're already inside a trigger cascade
  -- This prevents infinite loops when batch triggers update stock_reservations
  IF pg_trigger_depth() > 1 THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  UPDATE batches
  SET reserved_stock = COALESCE((
    SELECT SUM(reserved_quantity)
    FROM stock_reservations
    WHERE batch_id = batches.id AND status = 'active'
  ), 0)
  WHERE id = COALESCE(NEW.batch_id, OLD.batch_id);

  RETURN COALESCE(NEW, OLD);
END;
$$;

-- ===========================================================================
-- 2. Fix auto_reallocate_on_batch_change — only fire when relevant columns change
--    NOT when only reserved_stock changes (which is what caused the loop)
-- ===========================================================================
DROP TRIGGER IF EXISTS auto_reallocate_on_batch_change ON batches;
DROP TRIGGER IF EXISTS trigger_reallocate_on_batch_container_change ON batches;

CREATE TRIGGER auto_reallocate_on_batch_change
  AFTER UPDATE ON batches
  FOR EACH ROW
  WHEN (
    OLD.import_container_id IS DISTINCT FROM NEW.import_container_id
    OR OLD.current_stock IS DISTINCT FROM NEW.current_stock
    OR OLD.import_invoice_value IS DISTINCT FROM NEW.import_invoice_value
  )
  EXECUTE FUNCTION trigger_reallocate_on_batch_container_change();

-- ===========================================================================
-- 3. Fix trigger_update_product_stock — only fire on current_stock changes
--    Not on reserved_stock changes
-- ===========================================================================
DROP TRIGGER IF EXISTS trigger_update_product_current_stock ON batches;
DROP TRIGGER IF EXISTS trigger_update_product_stock ON batches;

-- Re-create with WHEN condition (only fires when current_stock changes)
DO $$
DECLARE
  v_fn_name text;
BEGIN
  -- Find the function name used by the product stock trigger
  SELECT p.proname INTO v_fn_name
  FROM pg_trigger t
  JOIN pg_proc p ON p.oid = t.tgfoid
  JOIN pg_class c ON c.oid = t.tgrelid
  WHERE c.relname = 'batches'
    AND t.tgname IN ('trigger_update_product_current_stock', 'trigger_update_product_stock')
  LIMIT 1;

  IF v_fn_name IS NOT NULL THEN
    EXECUTE format(
      'CREATE TRIGGER trigger_update_product_stock
         AFTER INSERT OR UPDATE OR DELETE ON batches
         FOR EACH ROW
         WHEN (
           pg_trigger_depth() = 0
           AND (
             TG_OP = ''INSERT''
             OR TG_OP = ''DELETE''
             OR OLD.current_stock IS DISTINCT FROM NEW.current_stock
           )
         )
         EXECUTE FUNCTION %I()',
      v_fn_name
    );
  END IF;
END;
$$;

-- ===========================================================================
-- 4. Fix trigger_auto_fill_batch_duty_percent — only fire on relevant changes
-- ===========================================================================
DROP TRIGGER IF EXISTS trigger_auto_fill_batch_duty_percent ON batches;

DO $$
DECLARE
  v_fn_name text;
BEGIN
  SELECT p.proname INTO v_fn_name
  FROM pg_trigger t
  JOIN pg_proc p ON p.oid = t.tgfoid
  JOIN pg_class c ON c.oid = t.tgrelid
  WHERE c.relname = 'batches'
    AND t.tgname = 'trigger_auto_fill_batch_duty_percent'
  LIMIT 1;

  IF v_fn_name IS NOT NULL THEN
    EXECUTE format(
      'CREATE TRIGGER trigger_auto_fill_batch_duty_percent
         BEFORE INSERT OR UPDATE ON batches
         FOR EACH ROW
         WHEN (pg_trigger_depth() = 0)
         EXECUTE FUNCTION %I()',
      v_fn_name
    );
  END IF;
END;
$$;
