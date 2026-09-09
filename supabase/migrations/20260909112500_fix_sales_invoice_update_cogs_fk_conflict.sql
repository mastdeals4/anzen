-- Migration: 20260909112500_fix_sales_invoice_update_cogs_fk_conflict.sql
-- Description: Fix foreign key conflict when updating sales invoices.
--              1. Alter journal_entry_lines_sales_invoice_item_id_fkey to ON DELETE SET NULL
--                 so item deletion is never blocked.
--              2. Update update_sales_invoice_atomic() to also delete the old COGS journal entry
--                 along with the revenue journal entry, so COGS is cleanly regenerated for new items.

BEGIN;

-- 1. Relax foreign key constraint to ON DELETE SET NULL
ALTER TABLE public.journal_entry_lines
  DROP CONSTRAINT IF EXISTS journal_entry_lines_sales_invoice_item_id_fkey,
  ADD CONSTRAINT journal_entry_lines_sales_invoice_item_id_fkey
    FOREIGN KEY (sales_invoice_item_id)
    REFERENCES public.sales_invoice_items(id)
    ON DELETE SET NULL;

-- 2. Update update_sales_invoice_atomic to clean up COGS journal before deleting items
CREATE OR REPLACE FUNCTION public.update_sales_invoice_atomic(
  p_invoice_id uuid,
  p_invoice_updates jsonb,
  p_new_items jsonb[]
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
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

  -- Remove old revenue journal entry
  IF v_old_je_id IS NOT NULL THEN
    UPDATE public.sales_invoices SET journal_entry_id = NULL WHERE id = p_invoice_id;
    DELETE FROM public.journal_entry_lines WHERE journal_entry_id = v_old_je_id;
    DELETE FROM public.journal_entries WHERE id = v_old_je_id;
  END IF;

  -- Remove old COGS journal entry so COGS is cleanly regenerated for updated items
  DELETE FROM public.journal_entry_lines
   WHERE journal_entry_id IN (
     SELECT id FROM public.journal_entries
      WHERE source_module = 'sales_invoice_cogs' AND reference_id = p_invoice_id
   );
  DELETE FROM public.journal_entries
   WHERE source_module = 'sales_invoice_cogs' AND reference_id = p_invoice_id;

  -- Delete old sales invoice items
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
$function$;

COMMIT;
