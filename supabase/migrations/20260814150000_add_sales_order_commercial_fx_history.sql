-- Historical commercial basis for Sales Orders.
-- These are reference fields only; unit_price remains the final transaction price.
ALTER TABLE public.sales_orders
  ADD COLUMN IF NOT EXISTS commercial_usd_to_idr_rate numeric(18,6);

ALTER TABLE public.sales_order_items
  ADD COLUMN IF NOT EXISTS quoted_usd_unit_price numeric(18,6);

ALTER TABLE public.sales_orders
  DROP CONSTRAINT IF EXISTS sales_orders_commercial_usd_to_idr_rate_check;
ALTER TABLE public.sales_orders
  ADD CONSTRAINT sales_orders_commercial_usd_to_idr_rate_check
  CHECK (commercial_usd_to_idr_rate IS NULL OR commercial_usd_to_idr_rate > 0);

ALTER TABLE public.sales_order_items
  DROP CONSTRAINT IF EXISTS sales_order_items_quoted_usd_unit_price_check;
ALTER TABLE public.sales_order_items
  ADD CONSTRAINT sales_order_items_quoted_usd_unit_price_check
  CHECK (quoted_usd_unit_price IS NULL OR quoted_usd_unit_price >= 0);

COMMENT ON COLUMN public.sales_orders.commercial_usd_to_idr_rate IS
  'Historical USD to IDR rate used for this order commercial agreement; never recalculated.';
COMMENT ON COLUMN public.sales_order_items.quoted_usd_unit_price IS
  'Historical USD quoted unit price used as the commercial basis; unit_price remains the transaction price.';
