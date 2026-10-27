-- ==============================================================================
-- Delivery Challan Recovery, Editing, Source Relinking, and Re-Approval Fix
-- Migration: 20261028010000_delivery_challan_recovery_and_source_relinking.sql
-- ==============================================================================

-- 1. Allow nullable delivery_challan_item_id on sales_invoice_items and set ON DELETE SET NULL
ALTER TABLE public.sales_invoice_items
  ALTER COLUMN delivery_challan_item_id DROP NOT NULL;

ALTER TABLE public.sales_invoice_items
  DROP CONSTRAINT IF EXISTS sales_invoice_items_delivery_challan_item_id_fkey,
  ADD CONSTRAINT sales_invoice_items_delivery_challan_item_id_fkey
    FOREIGN KEY (delivery_challan_item_id)
    REFERENCES public.delivery_challan_items(id)
    ON DELETE SET NULL;

-- 2. Update foreign key constraints referencing delivery_challan_items
ALTER TABLE public.so_product_reservation_events
  DROP CONSTRAINT IF EXISTS so_product_reservation_events_delivery_challan_item_id_fkey,
  ADD CONSTRAINT so_product_reservation_events_delivery_challan_item_id_fkey
    FOREIGN KEY (delivery_challan_item_id)
    REFERENCES public.delivery_challan_items(id)
    ON DELETE SET NULL;

ALTER TABLE public.dc_batch_allocations
  DROP CONSTRAINT IF EXISTS dc_batch_allocations_delivery_challan_item_id_fkey,
  ADD CONSTRAINT dc_batch_allocations_delivery_challan_item_id_fkey
    FOREIGN KEY (delivery_challan_item_id)
    REFERENCES public.delivery_challan_items(id)
    ON DELETE CASCADE;

-- 3. Update trg_sales_invoice_item_inventory trigger function
CREATE OR REPLACE FUNCTION public.trg_sales_invoice_item_inventory()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_dc_item public.delivery_challan_items%ROWTYPE;
  v_dc_status text;
  v_invoiced_quantity numeric;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  IF current_setting('app.sales_invoice_cancel', true) = 'true'
     OR current_setting('app.skip_dc_item_trigger', true) = 'true' THEN
    RETURN NEW;
  END IF;

  IF NEW.delivery_challan_item_id IS NULL THEN
    IF EXISTS (
      SELECT 1 FROM public.sales_invoices si
      WHERE si.id = NEW.invoice_id
        AND (si.notes LIKE '[CANCELLED%' OR LOWER(si.notes) LIKE 'cancelled%')
    ) THEN
      RETURN NEW;
    END IF;

    RAISE EXCEPTION 'Sales Invoice item must reference an approved Delivery Challan item';
  END IF;

  SELECT dci.*
  INTO v_dc_item
  FROM public.delivery_challan_items dci
  WHERE dci.id = NEW.delivery_challan_item_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sales Invoice item references a missing Delivery Challan item';
  END IF;

  SELECT dc.approval_status::text
  INTO v_dc_status
  FROM public.delivery_challans dc
  WHERE dc.id = v_dc_item.challan_id;

  IF NOT FOUND OR v_dc_status <> 'approved' THEN
    RAISE EXCEPTION 'Sales Invoice item references a non-approved Delivery Challan item';
  END IF;

  IF NEW.product_id IS DISTINCT FROM v_dc_item.product_id
     OR NEW.batch_id IS DISTINCT FROM v_dc_item.batch_id THEN
    RAISE EXCEPTION 'Sales Invoice product/batch must match its Delivery Challan item';
  END IF;

  SELECT COALESCE(SUM(sii.quantity), 0)
  INTO v_invoiced_quantity
  FROM public.sales_invoice_items sii
  JOIN public.sales_invoices si ON si.id = sii.invoice_id
  WHERE sii.delivery_challan_item_id = NEW.delivery_challan_item_id
    AND sii.id IS DISTINCT FROM NEW.id
    AND NOT (si.notes LIKE '[CANCELLED%' OR LOWER(si.notes) LIKE 'cancelled%');

  IF v_invoiced_quantity + NEW.quantity > v_dc_item.quantity THEN
    RAISE EXCEPTION 'Sales Invoice quantity exceeds approved Delivery Challan quantity';
  END IF;

  RETURN NEW;
END;
$$;

-- 4. Update guard_delivery_challan_source_link trigger function
-- Only block detachment / reassignment of sales_order_id if the DC is CURRENTLY APPROVED.
-- Allows rejected, cancelled, draft, or pending DCs to be relinked to an eligible Sales Order.
CREATE OR REPLACE FUNCTION public.guard_delivery_challan_source_link()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_so_customer uuid;
BEGIN
  IF OLD.approval_status = 'approved'
     AND OLD.sales_order_id IS NOT NULL
     AND NEW.sales_order_id IS DISTINCT FROM OLD.sales_order_id THEN
    RAISE EXCEPTION 'An approved Delivery Challan linked to a Sales Order cannot be detached or reassigned; cancel or reverse it first';
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

-- 5. Update edit_delivery_challan RPC to allow editing rejected/cancelled DCs and save sales_order_item_id
CREATE OR REPLACE FUNCTION public.edit_delivery_challan(p_challan_id uuid, p_new_items jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_role               text;
  v_challan            record;
  v_item               jsonb;
  v_count              integer;
  v_product_id         uuid;
  v_batch_id           uuid;
  v_new_qty            numeric;
  v_item_id            uuid;
  v_so_item_id         uuid;
  v_blocking_invoices  text;
  v_kept_ids           uuid[] := ARRAY[]::uuid[];
BEGIN
  SELECT role INTO v_role FROM public.user_profiles WHERE id = auth.uid();
  IF v_role NOT IN ('admin', 'accounts', 'warehouse', 'sales') THEN
    RAISE EXCEPTION 'Permission denied: role % cannot edit delivery challans', v_role;
  END IF;

  SELECT * INTO v_challan FROM public.delivery_challans WHERE id = p_challan_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Delivery challan not found');
  END IF;

  IF v_challan.approval_status = 'approved' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Cannot edit approved delivery challan directly; reverse it or use approved DC edit');
  END IF;

  -- Check if any active (uncancelled) invoice items reference this DC
  IF EXISTS (
    SELECT 1
    FROM public.sales_invoice_items sii
    JOIN public.delivery_challan_items dci ON dci.id = sii.delivery_challan_item_id
    JOIN public.sales_invoices si ON si.id = sii.invoice_id
    WHERE dci.challan_id = p_challan_id
      AND NOT (si.notes LIKE '[CANCELLED%' OR LOWER(si.notes) LIKE 'cancelled%')
  ) THEN
    SELECT string_agg(DISTINCT si.invoice_number, ', ')
    INTO v_blocking_invoices
    FROM public.sales_invoice_items sii
    JOIN public.delivery_challan_items dci ON dci.id = sii.delivery_challan_item_id
    JOIN public.sales_invoices si ON si.id = sii.invoice_id
    WHERE dci.challan_id = p_challan_id
      AND NOT (si.notes LIKE '[CANCELLED%' OR LOWER(si.notes) LIKE 'cancelled%');

    RETURN jsonb_build_object(
      'success', false,
      'error', 'Delivery Challan already invoiced by active invoice(s) ' || v_blocking_invoices || '; cancel or reverse the invoice(s) first'
    );
  END IF;

  SELECT count(*) INTO v_count FROM jsonb_array_elements(p_new_items);
  IF v_count = 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Cannot save DC with no items');
  END IF;

  PERFORM set_config('app.skip_dc_item_trigger', 'true', true);
  PERFORM set_config('app.sales_invoice_cancel', 'true', true);

  -- Upsert / replace items
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_new_items)
  LOOP
    v_item_id    := NULLIF(v_item->>'id', '')::uuid;
    v_product_id := (v_item->>'product_id')::uuid;
    v_batch_id   := (v_item->>'batch_id')::uuid;
    v_new_qty    := (v_item->>'quantity')::numeric;
    v_so_item_id := NULLIF(v_item->>'sales_order_item_id', '')::uuid;

    IF v_new_qty <= 0 THEN
      RAISE EXCEPTION 'Item quantity must be greater than zero';
    END IF;

    IF v_item_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.delivery_challan_items WHERE id = v_item_id AND challan_id = p_challan_id) THEN
      UPDATE public.delivery_challan_items SET
        product_id = v_product_id,
        batch_id = v_batch_id,
        sales_order_item_id = v_so_item_id,
        quantity = v_new_qty,
        pack_size = NULLIF(v_item->>'pack_size', '')::numeric,
        pack_type = NULLIF(v_item->>'pack_type', ''),
        number_of_packs = NULLIF(v_item->>'number_of_packs', '')::integer
      WHERE id = v_item_id;

      v_kept_ids := array_append(v_kept_ids, v_item_id);
    ELSE
      v_item_id := COALESCE(v_item_id, gen_random_uuid());
      INSERT INTO public.delivery_challan_items (
        id, challan_id, product_id, batch_id, sales_order_item_id, quantity,
        pack_size, pack_type, number_of_packs
      ) VALUES (
        v_item_id, p_challan_id, v_product_id, v_batch_id, v_so_item_id, v_new_qty,
        NULLIF(v_item->>'pack_size', '')::numeric,
        NULLIF(v_item->>'pack_type', ''),
        NULLIF(v_item->>'number_of_packs', '')::integer
      );
      v_kept_ids := array_append(v_kept_ids, v_item_id);
    END IF;
  END LOOP;

  -- Remove any DC items that were not in the updated item list
  DELETE FROM public.delivery_challan_items
  WHERE challan_id = p_challan_id
    AND id <> ALL(v_kept_ids);

  PERFORM set_config('app.skip_dc_item_trigger', 'false', true);
  PERFORM set_config('app.sales_invoice_cancel', 'false', true);

  RETURN jsonb_build_object('success', true, 'message', 'Delivery challan updated successfully');

EXCEPTION
  WHEN foreign_key_violation THEN
    PERFORM set_config('app.skip_dc_item_trigger', 'false', true);
    PERFORM set_config('app.sales_invoice_cancel', 'false', true);
    RETURN jsonb_build_object('success', false, 'error', 'Invalid product or batch selection: ' || SQLERRM);
  WHEN OTHERS THEN
    PERFORM set_config('app.skip_dc_item_trigger', 'false', true);
    PERFORM set_config('app.sales_invoice_cancel', 'false', true);
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

-- 6. Update trg_dc_approval_product_reservation_v2 trigger function
CREATE OR REPLACE FUNCTION public.trg_dc_approval_product_reservation_v2()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  r record;
BEGIN
  IF NEW.approval_status = 'approved'
     AND OLD.approval_status IS DISTINCT FROM 'approved' THEN
    IF NEW.approval_operation_id IS NULL THEN
      RAISE EXCEPTION 'approval_operation_id is required';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.delivery_challan_items WHERE challan_id = NEW.id) THEN
      RAISE EXCEPTION 'Cannot approve Delivery Challan % without items', NEW.challan_number;
    END IF;

    FOR r IN
      SELECT id FROM public.delivery_challan_items WHERE challan_id = NEW.id ORDER BY id
    LOOP
      PERFORM public.consume_so_product_reservation_v2(
        r.id,
        NEW.approval_operation_id,
        COALESCE(NEW.approved_by, auth.uid())
      );
    END LOOP;

    IF NEW.sales_order_id IS NOT NULL THEN
      PERFORM public.fn_recompute_so_delivered(NEW.sales_order_id);
      PERFORM public.fn_recompute_so_status(NEW.sales_order_id);
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- 7. Add RLS DELETE policy for delivery_challans
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'delivery_challans'
      AND policyname = 'Admin, sales, and warehouse can delete unposted delivery_challans'
  ) THEN
    CREATE POLICY "Admin, sales, and warehouse can delete unposted delivery_challans"
      ON public.delivery_challans
      FOR DELETE
      TO authenticated
      USING (
        EXISTS (
          SELECT 1 FROM public.user_profiles
          WHERE user_profiles.id = auth.uid()
            AND user_profiles.role = ANY (ARRAY['admin', 'sales', 'warehouse'])
            AND user_profiles.is_active = true
        )
        AND approval_status <> 'approved'
      );
  END IF;
END $$;
