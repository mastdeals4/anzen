/*
  # Fix invalid 'partial' enum value in update_so_delivered_quantity_atomic

  ## Problem
  The function used `status = 'partial'` which is NOT in the sales_order_status enum.
  The correct value is 'partially_delivered'.
  This caused error code 42804 when saving a delivery challan.

  ## Fix
  Replace 'partial' with 'partially_delivered' in the CASE statement.
*/

CREATE OR REPLACE FUNCTION public.update_so_delivered_quantity_atomic(
  p_sales_order_id uuid,
  p_dc_items jsonb[]
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
BEGIN
  -- Atomically increment delivered_quantity for matching products
  UPDATE sales_order_items soi
  SET delivered_quantity = COALESCE(soi.delivered_quantity, 0) + COALESCE(
    (
      SELECT SUM((item->>'quantity')::numeric)
      FROM unnest(p_dc_items) AS item
      WHERE (item->>'product_id')::uuid = soi.product_id
    ), 0
  )
  WHERE soi.sales_order_id = p_sales_order_id;

  -- Check if all items are fully delivered
  UPDATE sales_orders
  SET status = CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM sales_order_items
      WHERE sales_order_id = p_sales_order_id
        AND COALESCE(delivered_quantity, 0) < quantity
    ) THEN 'delivered'::sales_order_status
    ELSE 'partially_delivered'::sales_order_status
  END
  WHERE id = p_sales_order_id;
END;
$function$;
