-- PO -> Purchase Invoice foundation only.
-- This records commercial linkage; receiving and inventory remain separate.

ALTER TABLE public.purchase_invoices
  ADD COLUMN IF NOT EXISTS purchase_order_id uuid
    REFERENCES public.purchase_orders(id) ON DELETE SET NULL;

ALTER TABLE public.purchase_invoice_items
  ADD COLUMN IF NOT EXISTS purchase_order_item_id uuid
    REFERENCES public.purchase_order_items(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_purchase_invoices_purchase_order_id
  ON public.purchase_invoices(purchase_order_id)
  WHERE purchase_order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_purchase_invoice_items_purchase_order_item_id
  ON public.purchase_invoice_items(purchase_order_item_id)
  WHERE purchase_order_item_id IS NOT NULL;

-- Atomic orchestration around the existing authoritative invoice save RPC.
-- It validates PO ownership before saving, then records line links. It never
-- creates batches, allocations, stock movements, or inventory transactions.
CREATE OR REPLACE FUNCTION public.create_purchase_invoice_from_po(
  p_purchase_order_id uuid,
  p_invoice_data jsonb,
  p_items jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_po public.purchase_orders%ROWTYPE;
  v_result jsonb;
  v_invoice_id uuid;
  v_item jsonb;
  v_po_item public.purchase_order_items%ROWTYPE;
  v_ordinal integer := 0;
  v_invoice_item_id uuid;
BEGIN
  SELECT * INTO v_po
    FROM public.purchase_orders
   WHERE id = p_purchase_order_id
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Purchase Order not found';
  END IF;

  IF NULLIF(p_invoice_data->>'supplier_id', '')::uuid IS DISTINCT FROM v_po.supplier_id THEN
    RAISE EXCEPTION 'Purchase Invoice supplier must match the Purchase Order supplier';
  END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb))
  LOOP
    IF NULLIF(v_item->>'purchase_order_item_id', '') IS NULL THEN
      RAISE EXCEPTION 'Each PO invoice line requires purchase_order_item_id';
    END IF;
    SELECT * INTO v_po_item
      FROM public.purchase_order_items
     WHERE id = (v_item->>'purchase_order_item_id')::uuid
       AND po_id = p_purchase_order_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Purchase Invoice item is not a line of the selected Purchase Order';
    END IF;
    IF NULLIF(v_item->>'product_id', '')::uuid IS DISTINCT FROM v_po_item.product_id THEN
      RAISE EXCEPTION 'Purchase Invoice product does not match its Purchase Order line';
    END IF;
  END LOOP;

  v_result := public.save_purchase_invoice(NULL, p_invoice_data, p_items);
  v_invoice_id := (v_result->>'invoice_id')::uuid;

  UPDATE public.purchase_invoices
     SET purchase_order_id = p_purchase_order_id
   WHERE id = v_invoice_id;

  -- save_purchase_invoice inserts lines in JSON-array order. Match by the
  -- same stable creation ordering and persist each PO line link.
  FOR v_item IN SELECT value FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb))
  LOOP
    v_ordinal := v_ordinal + 1;
    SELECT id INTO v_invoice_item_id
      FROM public.purchase_invoice_items
     WHERE purchase_invoice_id = v_invoice_id
     -- ctid reflects the insert order within this transaction (the existing
     -- save RPC does not expose a line number), so duplicate-product lines
     -- still map deterministically to the input array.
     ORDER BY ctid
     OFFSET v_ordinal - 1 LIMIT 1;
    IF v_invoice_item_id IS NOT NULL THEN
      UPDATE public.purchase_invoice_items
         SET purchase_order_item_id = (v_item->>'purchase_order_item_id')::uuid
       WHERE id = v_invoice_item_id;
    END IF;
  END LOOP;

  RETURN v_result || jsonb_build_object('purchase_order_id', p_purchase_order_id);
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_purchase_invoice_from_po(uuid, jsonb, jsonb)
  TO authenticated;
