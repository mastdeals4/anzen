-- A Purchase Order records the Make / Manufacturer being ordered.
-- NULL preserves historical PO lines where Make was not recorded.
ALTER TABLE public.purchase_order_items
  ADD COLUMN IF NOT EXISTS make_id uuid
  REFERENCES public.product_sources(id) ON DELETE SET NULL;

-- A selected Make must be a Make of the PO line's Product.  The existing
-- product_sources(product_id, id) key is also used by Batch and SO Make links.
ALTER TABLE public.purchase_order_items
  ADD CONSTRAINT purchase_order_items_product_make_source_fkey
  FOREIGN KEY (product_id, make_id)
  REFERENCES public.product_sources(product_id, id)
  ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_purchase_order_items_make_id
  ON public.purchase_order_items(make_id)
  WHERE make_id IS NOT NULL;

COMMENT ON COLUMN public.purchase_order_items.make_id IS
  'Optional Make / Manufacturer ordered from the existing product_sources master; NULL means not recorded.';
