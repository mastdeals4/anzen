/*
  # Fix: Auto-release Trigger Bug
  
  ## Problem
  Line 295 in fn_auto_release_on_so_status_change has:
  `PERFORM fn_release_reservation_by_so_id(NEW.id, NEW.updated_at::text::uuid);`
  
  This tries to convert a timestamp to UUID, causing error:
  "invalid input syntax for type uuid: '2025-11-29 13:07:36.00881+00'"
  
  ## Solution
  Pass NULL instead since we don't have user context in trigger.
  The released_by field is nullable and designed for this scenario.
*/

CREATE OR REPLACE FUNCTION fn_auto_release_on_so_status_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Release reservations if status changes to cancelled or rejected
  IF NEW.status IN ('cancelled', 'rejected') AND OLD.status NOT IN ('cancelled', 'rejected') THEN
    -- Pass NULL for released_by since triggers don't have user context
    PERFORM fn_release_reservation_by_so_id(NEW.id, NULL);
  END IF;
  
  RETURN NEW;
END;
$$;
