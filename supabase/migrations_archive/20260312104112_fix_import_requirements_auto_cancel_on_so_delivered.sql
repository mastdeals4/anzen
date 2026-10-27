/*
  # Fix import requirements: auto-cancel when linked SO is delivered/closed/cancelled

  1. Cancel stale import requirements where the linked SO is already delivered/closed/cancelled
  2. Add a trigger to auto-cancel import requirements when an SO transitions to delivered/closed/cancelled

  This prevents the import requirements page from showing items that are no longer needed.
*/

-- Step 1: Cancel existing stale import requirements for delivered/closed/cancelled SOs
UPDATE import_requirements ir
SET 
  status = 'cancelled',
  notes = COALESCE(ir.notes || ' | ', '') || 'Auto-cancelled: Sales Order ' || so.so_number || ' is ' || so.status::text
FROM sales_orders so
WHERE ir.sales_order_id = so.id
AND so.status IN ('delivered', 'closed', 'cancelled')
AND ir.status NOT IN ('cancelled', 'received');

-- Step 2: Create/replace trigger function to auto-cancel import requirements when SO status changes
CREATE OR REPLACE FUNCTION auto_cancel_import_requirements_on_so_status()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- When SO moves to delivered, closed, or cancelled - cancel pending import requirements
  IF NEW.status IN ('delivered', 'closed', 'cancelled') AND 
     OLD.status NOT IN ('delivered', 'closed', 'cancelled') THEN
    UPDATE import_requirements
    SET 
      status = 'cancelled',
      notes = COALESCE(notes || ' | ', '') || 'Auto-cancelled: Sales Order is ' || NEW.status::text
    WHERE sales_order_id = NEW.id
    AND status NOT IN ('cancelled', 'received');
  END IF;
  
  RETURN NEW;
END;
$$;

-- Step 3: Drop old trigger if exists, recreate
DROP TRIGGER IF EXISTS trg_auto_cancel_import_requirements ON sales_orders;

CREATE TRIGGER trg_auto_cancel_import_requirements
  AFTER UPDATE OF status ON sales_orders
  FOR EACH ROW
  EXECUTE FUNCTION auto_cancel_import_requirements_on_so_status();
