/*
  # Add Batch Stock Consistency Checks
  
  1. Purpose
    - Prevent current_stock from going negative
    - Ensure reserved_stock never exceeds current_stock
    - Auto-sync reserved_stock with actual active reservations
  
  2. Changes
    - Add CHECK constraints on batches table
    - Create trigger to keep reserved_stock in sync
*/

-- Add CHECK constraint: current_stock cannot be negative
ALTER TABLE batches
DROP CONSTRAINT IF EXISTS chk_batch_current_stock_positive;

ALTER TABLE batches
ADD CONSTRAINT chk_batch_current_stock_positive
CHECK (current_stock >= 0);

-- Add CHECK constraint: reserved_stock cannot exceed current_stock
ALTER TABLE batches
DROP CONSTRAINT IF EXISTS chk_batch_reserved_not_exceed_current;

ALTER TABLE batches
ADD CONSTRAINT chk_batch_reserved_not_exceed_current
CHECK (COALESCE(reserved_stock, 0) <= current_stock);

-- Function: Auto-sync reserved_stock from active reservations
CREATE OR REPLACE FUNCTION trg_sync_batch_reserved_stock()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Recalculate reserved_stock from actual active reservations
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

-- Trigger: Sync reserved_stock whenever stock_reservations change
DROP TRIGGER IF EXISTS trigger_sync_batch_reserved_stock ON stock_reservations;
CREATE TRIGGER trigger_sync_batch_reserved_stock
  AFTER INSERT OR UPDATE OR DELETE ON stock_reservations
  FOR EACH ROW
  EXECUTE FUNCTION trg_sync_batch_reserved_stock();

-- One-time sync: Fix all batches' reserved_stock to match actual reservations
UPDATE batches
SET reserved_stock = COALESCE((
  SELECT SUM(reserved_quantity)
  FROM stock_reservations
  WHERE batch_id = batches.id AND status = 'active'
), 0);
