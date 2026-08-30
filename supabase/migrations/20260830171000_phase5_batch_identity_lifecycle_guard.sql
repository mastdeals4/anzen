-- Phase 5: preserve batch identity after inventory/downstream use.
--
-- Historical make completion remains supported: NULL -> a valid product source
-- is intentionally allowed. Once a make is recorded on a used batch, changing
-- it would rewrite the identity of inventory and downstream documents.

CREATE OR REPLACE FUNCTION public.guard_used_batch_identity_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_is_used boolean;
BEGIN
  IF NEW.product_id IS NOT DISTINCT FROM OLD.product_id
     AND NEW.make_id IS NOT DISTINCT FROM OLD.make_id THEN
    RETURN NEW;
  END IF;

  SELECT
    EXISTS (
      SELECT 1
      FROM public.inventory_transactions it
      WHERE it.batch_id = OLD.id
    )
    OR EXISTS (
      SELECT 1
      FROM public.purchase_invoice_receiving_allocations pira
      WHERE pira.batch_id = OLD.id
    )
    OR EXISTS (
      SELECT 1
      FROM public.stock_reservations sr
      WHERE sr.batch_id = OLD.id
    )
    OR EXISTS (
      SELECT 1
      FROM public.delivery_challan_items dci
      WHERE dci.batch_id = OLD.id
    )
    OR EXISTS (
      SELECT 1
      FROM public.sales_invoice_items sii
      WHERE sii.batch_id = OLD.id
    )
  INTO v_is_used;

  IF v_is_used AND NEW.product_id IS DISTINCT FROM OLD.product_id THEN
    RAISE EXCEPTION
      'Cannot change Product after a batch has inventory or downstream history'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Preserve the approved historical-data workflow: an unknown historical
  -- make may be recorded once. Do not permit a known identity to be rewritten
  -- after the batch has inventory/downstream history.
  IF v_is_used
     AND OLD.make_id IS NOT NULL
     AND NEW.make_id IS DISTINCT FROM OLD.make_id THEN
    RAISE EXCEPTION
      'Cannot change a recorded Make after a batch has inventory or downstream history'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_used_batch_identity_v1 ON public.batches;
CREATE TRIGGER guard_used_batch_identity_v1
BEFORE UPDATE OF product_id, make_id ON public.batches
FOR EACH ROW
EXECUTE FUNCTION public.guard_used_batch_identity_v1();

COMMENT ON FUNCTION public.guard_used_batch_identity_v1() IS
  'Prevents Product or an already-recorded Make from being rewritten after inventory/downstream use; permits historical NULL Make completion.';
