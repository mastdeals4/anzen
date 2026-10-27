-- Keep the existing Sales Order -> Delivery Challan -> Invoice ownership chain
-- authoritative.  This migration deliberately does not post, reverse, or
-- otherwise alter inventory or finance entries.

BEGIN;

-- A DC created from an SO cannot be detached/reassigned later.  Its customer
-- must also remain the SO customer.  Header fields such as delivery address
-- and notes remain editable, including through the existing pending-DC RPC.
CREATE OR REPLACE FUNCTION public.guard_delivery_challan_source_link()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_so_customer uuid;
BEGIN
  IF OLD.sales_order_id IS NOT NULL
     AND NEW.sales_order_id IS DISTINCT FROM OLD.sales_order_id THEN
    RAISE EXCEPTION 'A Delivery Challan linked to a Sales Order cannot be detached or reassigned';
  END IF;

  IF NEW.sales_order_id IS NOT NULL THEN
    SELECT customer_id INTO v_so_customer
    FROM public.sales_orders
    WHERE id = NEW.sales_order_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Linked Sales Order % does not exist', NEW.sales_order_id;
    END IF;
    IF NEW.customer_id IS DISTINCT FROM v_so_customer THEN
      RAISE EXCEPTION 'Delivery Challan customer must match its linked Sales Order customer';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_delivery_challan_source_link ON public.delivery_challans;
CREATE TRIGGER trg_guard_delivery_challan_source_link
BEFORE INSERT OR UPDATE OF sales_order_id, customer_id ON public.delivery_challans
FOR EACH ROW EXECUTE FUNCTION public.guard_delivery_challan_source_link();

-- The canonical invoice trigger already requires an approved DC item.  Make
-- that source relationship structural as well, and prevent a duplicated line
-- for the same source item on one invoice.  Different DC items are not
-- collapsed, even when they share product and batch.
ALTER TABLE public.sales_invoice_items
  ALTER COLUMN delivery_challan_item_id SET NOT NULL;

ALTER TABLE public.sales_invoice_items
  DROP CONSTRAINT IF EXISTS sales_invoice_items_delivery_challan_item_id_fkey;

ALTER TABLE public.sales_invoice_items
  ADD CONSTRAINT sales_invoice_items_delivery_challan_item_id_fkey
  FOREIGN KEY (delivery_challan_item_id)
  REFERENCES public.delivery_challan_items(id)
  ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_sales_invoice_items_invoice_dc_item
  ON public.sales_invoice_items(invoice_id, delivery_challan_item_id);

-- Preserve the current atomic journal-rebuild sequence, but derive the
-- invoice's DC links and SO link from the replacement source lines.  The
-- caller-supplied header array is no longer trusted during edits.
CREATE OR REPLACE FUNCTION public.update_sales_invoice_atomic(
  p_invoice_id uuid,
  p_invoice_updates jsonb,
  p_new_items jsonb[]
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_role text;
  v_old_je_id uuid;
  v_result uuid;
  v_dc_item_ids uuid[];
  v_linked_challan_ids text[];
  v_sales_order_ids uuid[];
  v_customer_ids uuid[];
BEGIN
  SELECT role INTO v_role FROM public.user_profiles WHERE id = auth.uid();
  IF v_role NOT IN ('admin', 'accounts', 'sales', 'manager') THEN
    RAISE EXCEPTION 'Permission denied: role % cannot update sales invoices', v_role;
  END IF;

  SELECT array_agg(DISTINCT NULLIF(item->>'delivery_challan_item_id', '')::uuid)
  INTO v_dc_item_ids
  FROM unnest(p_new_items) AS item;

  IF v_dc_item_ids IS NULL OR cardinality(v_dc_item_ids) = 0 THEN
    RAISE EXCEPTION 'Sales Invoice must contain Delivery Challan-linked items';
  END IF;

  IF array_length(v_dc_item_ids, 1) <> (
    SELECT count(*) FROM public.delivery_challan_items WHERE id = ANY(v_dc_item_ids)
  ) THEN
    RAISE EXCEPTION 'Sales Invoice contains a missing Delivery Challan item';
  END IF;

  SELECT
    array_agg(DISTINCT dc.id::text ORDER BY dc.id::text),
    array_agg(DISTINCT dc.sales_order_id),
    array_agg(DISTINCT dc.customer_id)
  INTO v_linked_challan_ids, v_sales_order_ids, v_customer_ids
  FROM public.delivery_challan_items dci
  JOIN public.delivery_challans dc ON dc.id = dci.challan_id
  WHERE dci.id = ANY(v_dc_item_ids);

  IF cardinality(v_customer_ids) <> 1
     OR (p_invoice_updates ? 'customer_id'
         AND (p_invoice_updates->>'customer_id')::uuid IS DISTINCT FROM v_customer_ids[1]) THEN
    RAISE EXCEPTION 'Invoice customer must match all linked Delivery Challans';
  END IF;

  SELECT journal_entry_id INTO v_old_je_id
  FROM public.sales_invoices
  WHERE id = p_invoice_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sales Invoice % not found', p_invoice_id;
  END IF;

  IF v_old_je_id IS NOT NULL THEN
    UPDATE public.sales_invoices SET journal_entry_id = NULL WHERE id = p_invoice_id;
    DELETE FROM public.journal_entry_lines WHERE journal_entry_id = v_old_je_id;
    DELETE FROM public.journal_entries WHERE id = v_old_je_id;
  END IF;

  DELETE FROM public.sales_invoice_items WHERE invoice_id = p_invoice_id;
  PERFORM set_config('app.sales_invoice_rebuild', 'true', true);

  UPDATE public.sales_invoices
  SET
    invoice_date       = COALESCE((p_invoice_updates->>'invoice_date')::date, invoice_date),
    due_date           = COALESCE((p_invoice_updates->>'due_date')::date, due_date),
    customer_id        = v_customer_ids[1],
    sales_order_id     = CASE WHEN cardinality(v_sales_order_ids) = 1 THEN v_sales_order_ids[1] ELSE NULL END,
    subtotal           = COALESCE((p_invoice_updates->>'subtotal')::numeric, subtotal),
    tax_amount         = COALESCE((p_invoice_updates->>'tax_amount')::numeric, tax_amount),
    total_amount       = COALESCE((p_invoice_updates->>'total_amount')::numeric, total_amount),
    discount_amount    = COALESCE((p_invoice_updates->>'discount_amount')::numeric, discount_amount),
    stamp_duty_amount  = COALESCE((p_invoice_updates->>'stamp_duty_amount')::numeric, stamp_duty_amount),
    po_number          = COALESCE(p_invoice_updates->>'po_number', po_number),
    payment_terms_days = COALESCE((p_invoice_updates->>'payment_terms_days')::integer, payment_terms_days),
    notes              = COALESCE(p_invoice_updates->>'notes', notes),
    linked_challan_ids = v_linked_challan_ids,
    updated_at         = now()
  WHERE id = p_invoice_id
  RETURNING id INTO v_result;

  INSERT INTO public.sales_invoice_items (
    invoice_id, product_id, batch_id, quantity, unit_price, tax_rate, delivery_challan_item_id
  )
  SELECT
    p_invoice_id,
    (item->>'product_id')::uuid,
    NULLIF(item->>'batch_id', '')::uuid,
    (item->>'quantity')::numeric,
    (item->>'unit_price')::numeric,
    (item->>'tax_rate')::numeric,
    NULLIF(item->>'delivery_challan_item_id', '')::uuid
  FROM unnest(p_new_items) AS item;

  PERFORM set_config('app.sales_invoice_rebuild', 'false', true);
  UPDATE public.sales_invoices SET updated_at = now()
  WHERE id = p_invoice_id AND journal_entry_id IS NULL;

  RETURN v_result;
END;
$$;

COMMIT;
