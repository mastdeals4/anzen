/*
  # Add operation_id propagation for inventory postings

  Ensures all inventory movement posting paths pass a caller-generated operation_id
  to post_inventory_movement for deterministic retries.
*/

-- 1) Track operation IDs on source records (caller-generated from app)
ALTER TABLE public.delivery_challans
  ADD COLUMN IF NOT EXISTS approval_operation_id uuid;

ALTER TABLE public.sales_invoices
  ADD COLUMN IF NOT EXISTS inventory_operation_id uuid;

ALTER TABLE public.inventory_transactions
  ADD COLUMN IF NOT EXISTS operation_id uuid;

CREATE INDEX IF NOT EXISTS idx_inventory_transactions_operation_id
  ON public.inventory_transactions(operation_id);

-- 2) Central posting function with idempotent retry behavior keyed by operation_id
CREATE OR REPLACE FUNCTION public.post_inventory_movement(
  p_operation_id uuid,
  p_product_id uuid,
  p_batch_id uuid,
  p_transaction_type text,
  p_quantity numeric,
  p_transaction_date date DEFAULT CURRENT_DATE,
  p_reference_number text DEFAULT NULL,
  p_reference_type text DEFAULT NULL,
  p_reference_id uuid DEFAULT NULL,
  p_notes text DEFAULT NULL,
  p_created_by uuid DEFAULT NULL,
  p_stock_before numeric DEFAULT NULL,
  p_stock_after numeric DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_transaction_id uuid;
BEGIN
  IF p_operation_id IS NULL THEN
    RAISE EXCEPTION 'post_inventory_movement requires a caller-provided operation_id';
  END IF;

  SELECT id INTO v_transaction_id
  FROM public.inventory_transactions
  WHERE operation_id = p_operation_id
    AND batch_id IS NOT DISTINCT FROM p_batch_id
    AND product_id IS NOT DISTINCT FROM p_product_id
    AND transaction_type = p_transaction_type
    AND reference_id IS NOT DISTINCT FROM p_reference_id
  ORDER BY created_at DESC
  LIMIT 1;

  IF v_transaction_id IS NOT NULL THEN
    RETURN v_transaction_id;
  END IF;

  INSERT INTO public.inventory_transactions (
    operation_id,
    product_id,
    batch_id,
    transaction_type,
    quantity,
    transaction_date,
    reference_number,
    reference_type,
    reference_id,
    notes,
    created_by,
    stock_before,
    stock_after
  ) VALUES (
    p_operation_id,
    p_product_id,
    p_batch_id,
    p_transaction_type,
    p_quantity,
    p_transaction_date,
    p_reference_number,
    p_reference_type,
    p_reference_id,
    p_notes,
    p_created_by,
    p_stock_before,
    p_stock_after
  )
  RETURNING id INTO v_transaction_id;

  RETURN v_transaction_id;
END;
$$;

-- 3) Delivery challan approval: use caller-provided approval_operation_id
CREATE OR REPLACE FUNCTION public.trg_dc_approval_deduct_stock()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_item RECORD;
  v_current_stock numeric;
  v_operation_id uuid;
BEGIN
  IF NEW.approval_status = 'approved' AND (OLD.approval_status != 'approved') THEN
    v_operation_id := COALESCE(NEW.approval_operation_id, gen_random_uuid());

    FOR v_item IN
      SELECT * FROM public.delivery_challan_items WHERE challan_id = NEW.id
    LOOP
      SELECT current_stock INTO v_current_stock FROM public.batches WHERE id = v_item.batch_id;

      UPDATE public.batches
      SET
        current_stock = current_stock - v_item.quantity,
        reserved_stock = GREATEST(0, COALESCE(reserved_stock, 0) - v_item.quantity)
      WHERE id = v_item.batch_id;

      PERFORM public.post_inventory_movement(
        p_operation_id => v_operation_id,
        p_product_id => v_item.product_id,
        p_batch_id => v_item.batch_id,
        p_transaction_type => 'delivery_challan',
        p_quantity => -v_item.quantity,
        p_transaction_date => NEW.challan_date,
        p_reference_number => NEW.challan_number,
        p_reference_type => 'delivery_challan',
        p_reference_id => NEW.id,
        p_notes => 'Delivered via approved DC: ' || NEW.challan_number,
        p_created_by => NEW.approved_by,
        p_stock_before => v_current_stock,
        p_stock_after => v_current_stock - v_item.quantity
      );
    END LOOP;
  END IF;

  RETURN NEW;
END;
$$;

-- 4) Invoice creation path: use caller-provided sales_invoices.inventory_operation_id
CREATE OR REPLACE FUNCTION public.sync_batch_stock_on_sale()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_is_linked_to_challan BOOLEAN;
  v_current_stock NUMERIC;
  v_import_quantity NUMERIC;
  v_invoice_number text;
  v_invoice_date date;
  v_invoice_created_by uuid;
  v_operation_id uuid;
BEGIN
  SELECT
    (linked_challan_ids IS NOT NULL AND array_length(linked_challan_ids, 1) > 0),
    invoice_number,
    invoice_date,
    created_by,
    inventory_operation_id
  INTO v_is_linked_to_challan, v_invoice_number, v_invoice_date, v_invoice_created_by, v_operation_id
  FROM public.sales_invoices
  WHERE id = COALESCE(NEW.invoice_id, OLD.invoice_id);

  IF v_is_linked_to_challan THEN
    IF TG_OP = 'INSERT' THEN
      RETURN NEW;
    ELSIF TG_OP = 'DELETE' THEN
      RETURN OLD;
    ELSE
      RETURN NEW;
    END IF;
  END IF;

  IF (TG_OP = 'INSERT') THEN
    IF NEW.batch_id IS NOT NULL THEN
      UPDATE public.batches
      SET current_stock = current_stock - NEW.quantity
      WHERE id = NEW.batch_id
      RETURNING current_stock + NEW.quantity INTO v_current_stock;

      PERFORM public.post_inventory_movement(
        p_operation_id => COALESCE(v_operation_id, gen_random_uuid()),
        p_product_id => NEW.product_id,
        p_batch_id => NEW.batch_id,
        p_transaction_type => 'sale',
        p_quantity => -NEW.quantity,
        p_transaction_date => v_invoice_date,
        p_reference_number => v_invoice_number,
        p_reference_type => 'sale_invoice',
        p_reference_id => NEW.invoice_id,
        p_notes => 'Sale: Invoice ' || v_invoice_number,
        p_created_by => v_invoice_created_by,
        p_stock_before => v_current_stock,
        p_stock_after => v_current_stock - NEW.quantity
      );
    END IF;

    RETURN NEW;

  ELSIF (TG_OP = 'UPDATE') THEN
    IF NEW.batch_id IS NOT NULL AND OLD.quantity IS DISTINCT FROM NEW.quantity THEN
      UPDATE public.batches
      SET current_stock = current_stock + OLD.quantity - NEW.quantity
      WHERE id = NEW.batch_id;

      UPDATE public.inventory_transactions
      SET quantity = -NEW.quantity
      WHERE batch_id = NEW.batch_id
        AND transaction_type = 'sale'
        AND reference_number = v_invoice_number;
    END IF;

    RETURN NEW;

  ELSIF (TG_OP = 'DELETE') THEN
    IF OLD.batch_id IS NOT NULL THEN
      SELECT current_stock, import_quantity
      INTO v_current_stock, v_import_quantity
      FROM public.batches
      WHERE id = OLD.batch_id;

      IF (v_current_stock + OLD.quantity) <= v_import_quantity THEN
        UPDATE public.batches
        SET current_stock = current_stock + OLD.quantity
        WHERE id = OLD.batch_id;

        DELETE FROM public.inventory_transactions
        WHERE batch_id = OLD.batch_id
          AND transaction_type = 'sale'
          AND reference_number = v_invoice_number;
      END IF;
    END IF;

    RETURN OLD;
  END IF;
END;
$$;

-- 5) Admin edit approved DC: caller-provided operation_id passed through
CREATE OR REPLACE FUNCTION public.admin_edit_approved_delivery_challan(
  p_challan_id uuid,
  p_new_items jsonb,
  p_operation_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_role text;
  v_challan record;
  v_item jsonb;
  v_old record;
  v_count integer;
  v_product_id uuid;
  v_batch_id uuid;
  v_qty numeric;
  v_pack_size numeric;
  v_pack_type text;
  v_packs integer;
  v_current_stock numeric;
  v_reserved numeric;
BEGIN
  IF p_operation_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'operation_id is required');
  END IF;

  SELECT role INTO v_role FROM public.user_profiles WHERE id = auth.uid();
  IF v_role IS DISTINCT FROM 'admin' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Only admin can edit approved DCs');
  END IF;

  SELECT * INTO v_challan FROM public.delivery_challans WHERE id = p_challan_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Delivery challan not found');
  END IF;

  SELECT count(*) INTO v_count FROM jsonb_array_elements(p_new_items);
  IF v_count = 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Cannot save DC with no items');
  END IF;

  PERFORM set_config('app.skip_dc_item_trigger', 'true', true);

  FOR v_old IN
    SELECT id, batch_id, quantity
    FROM public.inventory_transactions
    WHERE reference_type = 'delivery_challan'
      AND reference_id = p_challan_id
  LOOP
    UPDATE public.batches
    SET current_stock = current_stock + ABS(v_old.quantity)
    WHERE id = v_old.batch_id;
    DELETE FROM public.inventory_transactions WHERE id = v_old.id;
  END LOOP;

  DELETE FROM public.delivery_challan_items WHERE challan_id = p_challan_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_new_items) LOOP
    v_product_id := (v_item->>'product_id')::uuid;
    v_batch_id   := (v_item->>'batch_id')::uuid;
    v_qty        := (v_item->>'quantity')::numeric;
    v_pack_size  := NULLIF(v_item->>'pack_size','')::numeric;
    v_pack_type  := NULLIF(v_item->>'pack_type','');
    v_packs      := NULLIF(v_item->>'number_of_packs','')::integer;

    SELECT current_stock, COALESCE(reserved_stock,0)
    INTO v_current_stock, v_reserved
    FROM public.batches WHERE id = v_batch_id FOR UPDATE;

    IF v_current_stock < v_qty THEN
      PERFORM set_config('app.skip_dc_item_trigger', 'false', true);
      RETURN jsonb_build_object(
        'success', false,
        'error', format('Insufficient stock in batch. Available: %s, required: %s', v_current_stock, v_qty)
      );
    END IF;

    INSERT INTO public.delivery_challan_items (
      challan_id, product_id, batch_id, quantity,
      pack_size, pack_type, number_of_packs
    ) VALUES (
      p_challan_id, v_product_id, v_batch_id, v_qty,
      v_pack_size, v_pack_type, v_packs
    );

    UPDATE public.batches
    SET current_stock = current_stock - v_qty
    WHERE id = v_batch_id;

    PERFORM public.post_inventory_movement(
      p_operation_id => p_operation_id,
      p_product_id => v_product_id,
      p_batch_id => v_batch_id,
      p_transaction_type => 'delivery_challan',
      p_quantity => -v_qty,
      p_transaction_date => v_challan.challan_date,
      p_reference_number => v_challan.challan_number,
      p_reference_type => 'delivery_challan',
      p_reference_id => p_challan_id,
      p_notes => 'Delivered via approved DC: ' || v_challan.challan_number,
      p_created_by => auth.uid(),
      p_stock_before => v_current_stock,
      p_stock_after => v_current_stock - v_qty
    );
  END LOOP;

  PERFORM set_config('app.skip_dc_item_trigger', 'false', true);

  RETURN jsonb_build_object('success', true, 'message', 'Approved DC updated successfully');

EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.skip_dc_item_trigger', 'false', true);
  RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.admin_edit_approved_delivery_challan(uuid, jsonb, uuid) TO authenticated;

-- 6) Stock adjustment RPC: caller-provided operation_id must be passed through
CREATE OR REPLACE FUNCTION public.adjust_batch_stock_atomic(
  p_batch_id UUID,
  p_quantity_change NUMERIC,
  p_transaction_type TEXT,
  p_reference_id UUID DEFAULT NULL,
  p_notes TEXT DEFAULT NULL,
  p_created_by UUID DEFAULT NULL,
  p_operation_id UUID DEFAULT NULL
)
RETURNS TABLE(new_stock NUMERIC, transaction_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_transaction_id UUID;
  v_new_stock NUMERIC;
  v_product_id UUID;
  v_stock_before NUMERIC;
BEGIN
  IF p_operation_id IS NULL THEN
    RAISE EXCEPTION 'adjust_batch_stock_atomic requires p_operation_id';
  END IF;

  SELECT product_id, current_stock INTO v_product_id, v_stock_before
  FROM public.batches
  WHERE id = p_batch_id;

  IF v_product_id IS NULL THEN
    RAISE EXCEPTION 'Batch not found: %', p_batch_id;
  END IF;

  UPDATE public.batches
  SET current_stock = current_stock + p_quantity_change
  WHERE id = p_batch_id
  RETURNING current_stock INTO v_new_stock;

  v_transaction_id := public.post_inventory_movement(
    p_operation_id => p_operation_id,
    p_product_id => v_product_id,
    p_batch_id => p_batch_id,
    p_transaction_type => p_transaction_type,
    p_quantity => ABS(p_quantity_change),
    p_reference_type => 'stock_adjustment',
    p_reference_id => p_reference_id,
    p_notes => p_notes,
    p_created_by => p_created_by,
    p_stock_before => v_stock_before,
    p_stock_after => v_new_stock
  );

  RETURN QUERY SELECT v_new_stock, v_transaction_id;
END;
$$;
