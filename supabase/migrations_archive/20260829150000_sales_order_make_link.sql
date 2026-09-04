ALTER TABLE public.sales_order_items
  ADD COLUMN IF NOT EXISTS make_id uuid REFERENCES public.product_sources(id) ON DELETE SET NULL;

ALTER TABLE public.sales_order_items
  ADD CONSTRAINT sales_order_items_product_make_source_fkey
  FOREIGN KEY (product_id, make_id)
  REFERENCES public.product_sources(product_id, id)
  ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_sales_order_items_make_id ON public.sales_order_items(make_id);
