-- Revert the unrequested schema change added for a UI redesign.
-- No values were written to commercial_idr_to_usd_rate; the data correction
-- should continue using the existing commercial_usd_to_idr_rate field only.
DROP FUNCTION IF EXISTS public.update_sales_order_commercial_fx_rate(uuid, numeric, text);
ALTER TABLE public.sales_orders
  DROP CONSTRAINT IF EXISTS sales_orders_commercial_idr_to_usd_rate_positive;
ALTER TABLE public.sales_orders
  DROP COLUMN IF EXISTS commercial_idr_to_usd_rate;
