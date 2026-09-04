/* A reversed DC is historical. A new delivery must use a new DC. */
CREATE OR REPLACE FUNCTION public.trg_dc_approval_product_reservation_v2()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public,pg_temp
AS $$
DECLARE r record;
BEGIN
  IF NEW.approval_status='approved'
     AND OLD.approval_status IN ('rejected','cancelled') THEN
    RAISE EXCEPTION 'Reversed Delivery Challan cannot be re-approved; create a new Delivery Challan';
  END IF;

  IF NEW.approval_status='approved'
     AND OLD.approval_status IS DISTINCT FROM 'approved' THEN
    IF NEW.approval_operation_id IS NULL THEN
      RAISE EXCEPTION 'approval_operation_id is required';
    END IF;
    IF NOT EXISTS(SELECT 1 FROM public.delivery_challan_items WHERE challan_id=NEW.id) THEN
      RAISE EXCEPTION 'Cannot approve Delivery Challan % without items',NEW.challan_number;
    END IF;
    FOR r IN
      SELECT id FROM public.delivery_challan_items WHERE challan_id=NEW.id ORDER BY id
    LOOP
      PERFORM public.consume_so_product_reservation_v2(
        r.id,NEW.approval_operation_id,NEW.approved_by
      );
    END LOOP;
    PERFORM public.fn_recompute_so_delivered(NEW.sales_order_id);
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.trg_dc_approval_product_reservation_v2() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.trg_dc_approval_product_reservation_v2() TO service_role;
