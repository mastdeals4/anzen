-- Fix historical cleanup/delete path where the SO delete trigger calls an
-- overloaded reservation release function with an untyped NULL/unknown value.
CREATE OR REPLACE FUNCTION public.trg_sales_order_deleted()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.fn_release_stock_reservations(
    OLD.id,
    'Sales order deleted'::text,
    NULL::uuid
  );
  RETURN OLD;
END;
$$;

NOTIFY pgrst, 'reload schema';
