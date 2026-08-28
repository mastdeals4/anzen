-- SAPJ Inventory Version 1.0 canonical stock engine
-- Forward-only enforcement. Historical inventory rows are not rewritten.

BEGIN;

CREATE TABLE IF NOT EXISTS public.inventory_engine_certification (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  engine_version text NOT NULL,
  enforcement_started_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.inventory_engine_certification (
  singleton,
  engine_version,
  enforcement_started_at
)
VALUES (true, '1.0', now())
ON CONFLICT (singleton) DO UPDATE
SET engine_version = EXCLUDED.engine_version;

CREATE OR REPLACE FUNCTION public.uuid_from_text(p_key text)
RETURNS uuid
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT (
    substr(md5(p_key), 1, 8) || '-' ||
    substr(md5(p_key), 9, 4) || '-' ||
    substr(md5(p_key), 13, 4) || '-' ||
    substr(md5(p_key), 17, 4) || '-' ||
    substr(md5(p_key), 21, 12)
  )::uuid;
$$;

CREATE OR REPLACE FUNCTION public.inventory_v1_actor_allowed(
  p_roles text[]
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    auth.role() = 'service_role'
    OR EXISTS (
      SELECT 1
      FROM public.user_profiles up
      WHERE up.id = auth.uid()
        AND up.role = ANY(p_roles)
    );
$$;

REVOKE ALL ON FUNCTION public.inventory_v1_actor_allowed(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.inventory_v1_actor_allowed(text[]) TO authenticated, service_role;

-- Remove stock writers superseded by the canonical engine.
DROP TRIGGER IF EXISTS trigger_update_batch_stock ON public.inventory_transactions;
DROP TRIGGER IF EXISTS trg_track_stock_levels ON public.inventory_transactions;
DROP TRIGGER IF EXISTS track_stock_levels_trigger ON public.inventory_transactions;
DROP TRIGGER IF EXISTS trg_auto_batch_purchase_transaction ON public.batches;
DROP TRIGGER IF EXISTS trigger_create_batch_inventory_transaction ON public.batches;

DROP TRIGGER IF EXISTS trigger_sales_invoice_item_insert ON public.sales_invoice_items;
DROP TRIGGER IF EXISTS trigger_sales_invoice_item_delete ON public.sales_invoice_items;
DROP TRIGGER IF EXISTS trg_sales_invoice_item_inventory ON public.sales_invoice_items;

DROP TRIGGER IF EXISTS trigger_dc_approval_deduct_stock ON public.delivery_challans;
DROP TRIGGER IF EXISTS trigger_auto_release_reservation_on_dc_item ON public.delivery_challan_items;
DROP TRIGGER IF EXISTS trigger_dc_rejection_release_stock ON public.delivery_challans;
DROP TRIGGER IF EXISTS trigger_dc_cancellation_release_stock ON public.delivery_challans;
DROP TRIGGER IF EXISTS trigger_dc_approval_recompute_so ON public.delivery_challans;
DROP TRIGGER IF EXISTS trigger_dc_approval_validate_stock ON public.delivery_challans;
DROP TRIGGER IF EXISTS verify_dc_items_before_approval ON public.delivery_challans;
DROP TRIGGER IF EXISTS trigger_restore_reservation_on_dc_delete
  ON public.delivery_challans;

DROP TRIGGER IF EXISTS handle_material_return_approval_trigger ON public.material_returns;
DROP TRIGGER IF EXISTS trg_material_return_approval ON public.material_returns;
DROP TRIGGER IF EXISTS trigger_material_return_item_approved ON public.material_return_items;

DROP TRIGGER IF EXISTS trigger_credit_note_item_insert ON public.credit_note_items;
DROP TRIGGER IF EXISTS trigger_credit_note_item_delete ON public.credit_note_items;
DROP TRIGGER IF EXISTS trigger_credit_note_status ON public.credit_notes;
DROP TRIGGER IF EXISTS trigger_credit_note_item_approved ON public.credit_note_items;

DROP TRIGGER IF EXISTS handle_stock_rejection_approval_trigger ON public.stock_rejections;
DROP TRIGGER IF EXISTS trg_stock_rejection_approval ON public.stock_rejections;
DROP TRIGGER IF EXISTS trigger_stock_rejection_approved ON public.stock_rejections;

ALTER TABLE public.inventory_transactions
ADD COLUMN IF NOT EXISTS operation_id uuid;

-- Legacy uniqueness allowed only one lifetime DC movement per batch/document,
-- which prevents reversal/repost history. Canonical idempotency is operation-id
-- based instead.
DROP INDEX IF EXISTS public.idx_unique_dc_delivery_transaction;
DROP INDEX IF EXISTS public.idx_unique_dc_reservation_transaction;

CREATE UNIQUE INDEX IF NOT EXISTS
  idx_inventory_transactions_operation_id
ON public.inventory_transactions (operation_id)
WHERE operation_id IS NOT NULL;

ALTER TABLE public.inventory_transactions
DROP CONSTRAINT IF EXISTS inventory_transactions_transaction_type_check;

ALTER TABLE public.inventory_transactions
ADD CONSTRAINT inventory_transactions_transaction_type_check
CHECK (
  transaction_type IN (
    'purchase',
    'sale',
    'adjustment',
    'return',
    'delivery_challan',
    'delivery_challan_reserved',
    'rejection',
    'reservation',
    'release_reservation',
    'delivery'
  )
) NOT VALID;

-- The only function allowed to change physical batch quantity and append a
-- physical inventory movement after this migration.
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
SET search_path = public, pg_temp
AS $$
DECLARE
  v_existing public.inventory_transactions%ROWTYPE;
  v_batch public.batches%ROWTYPE;
  v_transaction_id uuid;
  v_new_stock numeric;
  v_previous_context text;
BEGIN
  IF p_operation_id IS NULL THEN
    RAISE EXCEPTION 'Canonical inventory posting requires operation_id';
  END IF;
  IF p_batch_id IS NULL OR p_product_id IS NULL THEN
    RAISE EXCEPTION 'Canonical inventory posting requires product_id and batch_id';
  END IF;
  IF COALESCE(p_quantity, 0) = 0 THEN
    RAISE EXCEPTION 'Canonical inventory posting quantity cannot be zero';
  END IF;
  IF p_transaction_type NOT IN (
    'purchase', 'delivery_challan', 'return', 'adjustment', 'rejection'
  ) THEN
    RAISE EXCEPTION 'Unsupported canonical inventory transaction type: %',
      p_transaction_type;
  END IF;

  SELECT *
  INTO v_existing
  FROM public.inventory_transactions
  WHERE operation_id = p_operation_id;

  IF FOUND THEN
    IF v_existing.batch_id IS DISTINCT FROM p_batch_id
       OR v_existing.product_id IS DISTINCT FROM p_product_id
       OR v_existing.transaction_type IS DISTINCT FROM p_transaction_type
       OR v_existing.quantity IS DISTINCT FROM p_quantity
       OR v_existing.reference_type IS DISTINCT FROM p_reference_type
       OR v_existing.reference_id IS DISTINCT FROM p_reference_id THEN
      RAISE EXCEPTION 'operation_id % was already used with different inventory values',
        p_operation_id;
    END IF;
    RETURN v_existing.id;
  END IF;

  SELECT *
  INTO v_batch
  FROM public.batches
  WHERE id = p_batch_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Batch not found: %', p_batch_id;
  END IF;
  IF v_batch.product_id IS DISTINCT FROM p_product_id THEN
    RAISE EXCEPTION 'Product % does not match batch % product %',
      p_product_id, p_batch_id, v_batch.product_id;
  END IF;

  IF p_transaction_type IN ('purchase', 'return') AND p_quantity <= 0 THEN
    RAISE EXCEPTION '% movement must be positive', p_transaction_type;
  END IF;
  IF p_transaction_type IN ('delivery_challan', 'rejection') AND p_quantity >= 0 THEN
    RAISE EXCEPTION '% movement must be negative', p_transaction_type;
  END IF;
  IF p_transaction_type = 'delivery_challan'
     AND v_batch.expiry_date IS NOT NULL
     AND v_batch.expiry_date <= COALESCE(p_transaction_date, CURRENT_DATE) THEN
    RAISE EXCEPTION 'Expired batch % cannot be delivered (expiry %)',
      v_batch.batch_number, v_batch.expiry_date;
  END IF;
  IF p_transaction_type = 'purchase'
     AND EXISTS (
       SELECT 1
       FROM public.inventory_transactions it
       WHERE it.batch_id = p_batch_id
         AND it.transaction_type = 'purchase'
     ) THEN
    RAISE EXCEPTION 'Batch % already has a Batch Creation movement',
      v_batch.batch_number;
  END IF;

  v_new_stock := v_batch.current_stock + p_quantity;
  IF v_new_stock < 0 THEN
    RAISE EXCEPTION 'Insufficient stock in batch %: current %, movement %, result %',
      v_batch.batch_number, v_batch.current_stock, p_quantity, v_new_stock;
  END IF;

  IF p_stock_before IS NOT NULL
     AND p_stock_before IS DISTINCT FROM v_batch.current_stock THEN
    RAISE EXCEPTION 'Stale stock_before for batch %: expected %, received %',
      v_batch.batch_number, v_batch.current_stock, p_stock_before;
  END IF;
  IF p_stock_after IS NOT NULL
     AND p_stock_after IS DISTINCT FROM v_new_stock THEN
    RAISE EXCEPTION 'Invalid stock_after for batch %: expected %, received %',
      v_batch.batch_number, v_new_stock, p_stock_after;
  END IF;

  v_previous_context := current_setting('app.canonical_stock_engine', true);
  PERFORM set_config('app.canonical_stock_engine', 'on', true);

  UPDATE public.batches
  SET current_stock = v_new_stock,
      updated_at = now()
  WHERE id = p_batch_id;

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
    stock_after,
    metadata
  )
  VALUES (
    p_operation_id,
    p_product_id,
    p_batch_id,
    p_transaction_type,
    p_quantity,
    COALESCE(p_transaction_date, CURRENT_DATE),
    p_reference_number,
    p_reference_type,
    p_reference_id,
    p_notes,
    COALESCE(p_created_by, auth.uid()),
    v_batch.current_stock,
    v_new_stock,
    jsonb_build_object(
      'canonical_engine_version', '1.0',
      'canonical_posted_at', clock_timestamp()
    )
  )
  RETURNING id INTO v_transaction_id;

  PERFORM set_config(
    'app.canonical_stock_engine',
    COALESCE(v_previous_context, ''),
    true
  );

  RETURN v_transaction_id;
END;
$$;

REVOKE ALL ON FUNCTION public.post_inventory_movement(
  uuid, uuid, uuid, text, numeric, date, text, text, uuid, text, uuid, numeric, numeric
) FROM PUBLIC;

-- Batch creation and batch quantity correction.
CREATE OR REPLACE FUNCTION public.save_batch_inventory_v1(
  p_batch_id uuid,
  p_payload jsonb,
  p_operation_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_batch public.batches%ROWTYPE;
  v_existing_batch_id uuid;
  v_actor uuid := auth.uid();
  v_delta numeric;
  v_previous_context text;
BEGIN
  IF NOT public.inventory_v1_actor_allowed(
    ARRAY['admin', 'accounts', 'warehouse', 'manager']
  ) THEN
    RAISE EXCEPTION 'Permission denied for canonical batch save';
  END IF;
  IF p_operation_id IS NULL THEN
    RAISE EXCEPTION 'operation_id is required';
  END IF;

  IF p_batch_id IS NULL THEN
    SELECT batch_id
    INTO v_existing_batch_id
    FROM public.inventory_transactions
    WHERE operation_id = p_operation_id
      AND transaction_type = 'purchase';

    IF FOUND THEN
      RETURN jsonb_build_object(
        'success', true,
        'batch_id', v_existing_batch_id,
        'idempotent_retry', true
      );
    END IF;

    v_previous_context := current_setting('app.canonical_stock_engine', true);
    PERFORM set_config('app.canonical_stock_engine', 'on', true);

    INSERT INTO public.batches (
      batch_number,
      product_id,
      import_container_id,
      import_date,
      import_quantity,
      current_stock,
      packaging_details,
      import_price,
      import_price_usd,
      exchange_rate_usd_to_idr,
      duty_percent,
      duty_charges,
      duty_charge_type,
      freight_charges,
      freight_charge_type,
      other_charges,
      other_charge_type,
      expiry_date,
      is_active,
      created_by
    )
    VALUES (
      p_payload->>'batch_number',
      (p_payload->>'product_id')::uuid,
      NULLIF(p_payload->>'import_container_id', '')::uuid,
      (p_payload->>'import_date')::date,
      (p_payload->>'import_quantity')::numeric,
      0,
      NULLIF(p_payload->>'packaging_details', ''),
      COALESCE((p_payload->>'import_price')::numeric, 0),
      NULLIF(p_payload->>'import_price_usd', '')::numeric,
      NULLIF(p_payload->>'exchange_rate_usd_to_idr', '')::numeric,
      COALESCE(NULLIF(p_payload->>'duty_percent', '')::numeric, 0),
      COALESCE(NULLIF(p_payload->>'duty_charges', '')::numeric, 0),
      COALESCE(NULLIF(p_payload->>'duty_charge_type', ''), 'fixed'),
      COALESCE(NULLIF(p_payload->>'freight_charges', '')::numeric, 0),
      COALESCE(NULLIF(p_payload->>'freight_charge_type', ''), 'fixed'),
      COALESCE(NULLIF(p_payload->>'other_charges', '')::numeric, 0),
      COALESCE(NULLIF(p_payload->>'other_charge_type', ''), 'fixed'),
      NULLIF(p_payload->>'expiry_date', '')::date,
      true,
      v_actor
    )
    RETURNING * INTO v_batch;

    PERFORM set_config(
      'app.canonical_stock_engine',
      COALESCE(v_previous_context, ''),
      true
    );

    PERFORM public.post_inventory_movement(
      p_operation_id,
      v_batch.product_id,
      v_batch.id,
      'purchase',
      v_batch.import_quantity,
      v_batch.import_date,
      v_batch.batch_number,
      'batch_creation',
      v_batch.id,
      'Canonical Batch Creation: ' || v_batch.batch_number,
      v_actor,
      0,
      v_batch.import_quantity
    );

    RETURN jsonb_build_object('success', true, 'batch_id', v_batch.id);
  END IF;

  SELECT *
  INTO v_batch
  FROM public.batches
  WHERE id = p_batch_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Batch not found';
  END IF;

  IF (p_payload->>'product_id')::uuid IS DISTINCT FROM v_batch.product_id
     AND EXISTS (
       SELECT 1
       FROM public.inventory_transactions
       WHERE batch_id = p_batch_id
         AND transaction_type <> 'purchase'
     ) THEN
    RAISE EXCEPTION 'Cannot change product after batch stock movement exists';
  END IF;

  v_delta := (p_payload->>'import_quantity')::numeric - v_batch.import_quantity;

  UPDATE public.batches
  SET batch_number = p_payload->>'batch_number',
      product_id = (p_payload->>'product_id')::uuid,
      import_container_id = NULLIF(p_payload->>'import_container_id', '')::uuid,
      import_date = (p_payload->>'import_date')::date,
      import_quantity = (p_payload->>'import_quantity')::numeric,
      packaging_details = NULLIF(p_payload->>'packaging_details', ''),
      import_price = COALESCE((p_payload->>'import_price')::numeric, import_price),
      import_price_usd = NULLIF(p_payload->>'import_price_usd', '')::numeric,
      exchange_rate_usd_to_idr =
        NULLIF(p_payload->>'exchange_rate_usd_to_idr', '')::numeric,
      duty_percent = COALESCE(NULLIF(p_payload->>'duty_percent', '')::numeric, 0),
      duty_charges = COALESCE(NULLIF(p_payload->>'duty_charges', '')::numeric, 0),
      duty_charge_type =
        COALESCE(NULLIF(p_payload->>'duty_charge_type', ''), duty_charge_type),
      freight_charges =
        COALESCE(NULLIF(p_payload->>'freight_charges', '')::numeric, 0),
      freight_charge_type =
        COALESCE(NULLIF(p_payload->>'freight_charge_type', ''), freight_charge_type),
      other_charges =
        COALESCE(NULLIF(p_payload->>'other_charges', '')::numeric, 0),
      other_charge_type =
        COALESCE(NULLIF(p_payload->>'other_charge_type', ''), other_charge_type),
      expiry_date = NULLIF(p_payload->>'expiry_date', '')::date,
      updated_at = now()
  WHERE id = p_batch_id;

  IF v_delta <> 0 THEN
    PERFORM public.post_inventory_movement(
      p_operation_id,
      (p_payload->>'product_id')::uuid,
      p_batch_id,
      'adjustment',
      v_delta,
      CURRENT_DATE,
      p_payload->>'batch_number',
      'batch_edit',
      p_batch_id,
      format(
        'Canonical Batch Edit quantity correction: %s to %s',
        v_batch.import_quantity,
        (p_payload->>'import_quantity')::numeric
      ),
      v_actor,
      v_batch.current_stock,
      v_batch.current_stock + v_delta
    );
  END IF;

  RETURN jsonb_build_object('success', true, 'batch_id', p_batch_id);
END;
$$;

REVOKE ALL ON FUNCTION public.save_batch_inventory_v1(uuid, jsonb, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.save_batch_inventory_v1(uuid, jsonb, uuid)
TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.adjust_batch_stock_atomic(
  p_batch_id uuid,
  p_quantity_change numeric,
  p_transaction_type text,
  p_reference_id uuid DEFAULT NULL,
  p_notes text DEFAULT NULL,
  p_created_by uuid DEFAULT NULL,
  p_operation_id uuid DEFAULT NULL
)
RETURNS TABLE(new_stock numeric, transaction_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_batch public.batches%ROWTYPE;
  v_transaction_id uuid;
BEGIN
  IF NOT public.inventory_v1_actor_allowed(
    ARRAY['admin', 'accounts', 'warehouse', 'manager']
  ) THEN
    RAISE EXCEPTION 'Permission denied for stock adjustment';
  END IF;
  IF p_transaction_type IS DISTINCT FROM 'adjustment' THEN
    RAISE EXCEPTION 'Manual inventory entry supports Stock Adjustment only';
  END IF;
  IF COALESCE(p_quantity_change, 0) = 0 THEN
    RAISE EXCEPTION 'Stock adjustment cannot be zero';
  END IF;

  SELECT *
  INTO v_batch
  FROM public.batches
  WHERE id = p_batch_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Batch not found';
  END IF;

  v_transaction_id := public.post_inventory_movement(
    p_operation_id,
    v_batch.product_id,
    v_batch.id,
    'adjustment',
    p_quantity_change,
    CURRENT_DATE,
    NULL,
    'stock_adjustment',
    p_reference_id,
    p_notes,
    COALESCE(p_created_by, auth.uid()),
    NULL,
    NULL
  );

  SELECT current_stock
  INTO new_stock
  FROM public.batches
  WHERE id = p_batch_id;

  transaction_id := v_transaction_id;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.adjust_batch_stock_atomic(
  uuid, numeric, text, uuid, text, uuid, uuid
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.adjust_batch_stock_atomic(
  uuid, numeric, text, uuid, text, uuid, uuid
) TO authenticated, service_role;

-- FEFO reservation is the canonical Sales Order stock action.
CREATE OR REPLACE FUNCTION public.fn_reserve_stock_for_so_v2(p_so_id uuid)
RETURNS TABLE(success boolean, message text, shortage_items jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_item record;
  v_batch record;
  v_remaining_qty numeric;
  v_reserved_qty numeric;
  v_shortage_list jsonb := '[]'::jsonb;
  v_has_shortage boolean := false;
BEGIN
  IF NOT public.inventory_v1_actor_allowed(
    ARRAY['admin', 'accounts', 'manager', 'warehouse']
  ) THEN
    RAISE EXCEPTION 'Permission denied for stock reservation';
  END IF;

  PERFORM 1
  FROM public.sales_orders
  WHERE id = p_so_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sales Order not found';
  END IF;

  UPDATE public.stock_reservations
  SET status = 'released',
      is_released = true,
      released_at = now(),
      released_by = auth.uid(),
      release_reason = 'Canonical re-reservation superseded prior reservation'
  WHERE sales_order_id = p_so_id
    AND status = 'active';

  FOR v_item IN
    SELECT soi.id, soi.product_id,
           GREATEST(soi.quantity - COALESCE(soi.delivered_quantity, 0), 0) quantity
    FROM public.sales_order_items soi
    WHERE soi.sales_order_id = p_so_id
  LOOP
    v_remaining_qty := v_item.quantity;

    FOR v_batch IN
      SELECT b.id, b.current_stock, COALESCE(b.reserved_stock, 0) reserved_stock
      FROM public.batches b
      WHERE b.product_id = v_item.product_id
        AND b.is_active = true
        AND b.current_stock > COALESCE(b.reserved_stock, 0)
        AND (b.expiry_date IS NULL OR b.expiry_date > CURRENT_DATE)
      ORDER BY
        (b.expiry_date IS NULL) ASC,
        b.expiry_date ASC,
        b.import_date ASC,
        b.created_at ASC,
        b.id ASC
      FOR UPDATE OF b
    LOOP
      v_reserved_qty := LEAST(
        v_remaining_qty,
        v_batch.current_stock - v_batch.reserved_stock
      );

      IF v_reserved_qty > 0 THEN
        INSERT INTO public.stock_reservations (
          sales_order_id,
          sales_order_item_id,
          batch_id,
          product_id,
          reserved_quantity,
          reserved_by,
          is_released,
          status
        )
        VALUES (
          p_so_id,
          v_item.id,
          v_batch.id,
          v_item.product_id,
          v_reserved_qty,
          auth.uid(),
          false,
          'active'
        );
        v_remaining_qty := v_remaining_qty - v_reserved_qty;
      END IF;

      EXIT WHEN v_remaining_qty <= 0;
    END LOOP;

    IF v_remaining_qty > 0 THEN
      v_has_shortage := true;
      v_shortage_list := v_shortage_list || jsonb_build_object(
        'product_id', v_item.product_id,
        'required_qty', v_item.quantity,
        'shortage_qty', v_remaining_qty
      );
    END IF;
  END LOOP;

  IF v_has_shortage THEN
    UPDATE public.sales_orders
    SET status = 'shortage', updated_at = now()
    WHERE id = p_so_id;
    PERFORM public.fn_create_import_requirements(p_so_id, v_shortage_list);
    RETURN QUERY
    SELECT false, 'Partial stock reserved - shortage exists.'::text, v_shortage_list;
  ELSE
    UPDATE public.sales_orders
    SET status = 'stock_reserved', updated_at = now()
    WHERE id = p_so_id;
    RETURN QUERY
    SELECT true, 'Stock fully reserved'::text, '[]'::jsonb;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_reserve_stock_for_so_v2(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_reserve_stock_for_so_v2(uuid)
TO authenticated, service_role;

-- Reservation release remains history-preserving and updates both status fields
-- so batches.reserved_stock continues to be derived by the existing sync trigger.
CREATE OR REPLACE FUNCTION public.fn_release_reservation_by_so_id(
  p_so_id uuid,
  p_released_by uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT public.inventory_v1_actor_allowed(
    ARRAY['admin', 'accounts', 'manager', 'warehouse']
  ) THEN
    RAISE EXCEPTION 'Permission denied for reservation release';
  END IF;

  UPDATE public.stock_reservations
  SET status = 'released',
      is_released = true,
      released_at = now(),
      released_by = COALESCE(p_released_by, auth.uid()),
      release_reason = COALESCE(
        release_reason,
        'Canonical Sales Order reservation release'
      )
  WHERE sales_order_id = p_so_id
    AND status = 'active';

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_release_reservation_by_so_id(uuid, uuid)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_release_reservation_by_so_id(uuid, uuid)
TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_release_partial_reservation(
  p_so_id uuid,
  p_product_id uuid,
  p_qty numeric,
  p_released_by uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_reservation record;
  v_remaining_qty numeric := p_qty;
  v_release_qty numeric;
BEGIN
  IF NOT public.inventory_v1_actor_allowed(
    ARRAY['admin', 'accounts', 'manager', 'warehouse']
  ) THEN
    RAISE EXCEPTION 'Permission denied for partial reservation release';
  END IF;
  IF COALESCE(p_qty, 0) <= 0 THEN
    RAISE EXCEPTION 'Reservation release quantity must be positive';
  END IF;

  FOR v_reservation IN
    SELECT id, reserved_quantity
    FROM public.stock_reservations
    WHERE sales_order_id = p_so_id
      AND product_id = p_product_id
      AND status = 'active'
    ORDER BY reserved_at, id
    FOR UPDATE
  LOOP
    EXIT WHEN v_remaining_qty <= 0;
    v_release_qty := LEAST(v_remaining_qty, v_reservation.reserved_quantity);

    IF v_release_qty = v_reservation.reserved_quantity THEN
      UPDATE public.stock_reservations
      SET status = 'released',
          is_released = true,
          released_at = now(),
          released_by = COALESCE(p_released_by, auth.uid()),
          release_reason = 'Canonical partial reservation release'
      WHERE id = v_reservation.id;
    ELSE
      UPDATE public.stock_reservations
      SET reserved_quantity = reserved_quantity - v_release_qty
      WHERE id = v_reservation.id;
    END IF;

    v_remaining_qty := v_remaining_qty - v_release_qty;
  END LOOP;

  IF v_remaining_qty > 0 THEN
    RAISE EXCEPTION 'Reservation release exceeds active reserved quantity by %',
      v_remaining_qty;
  END IF;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_release_partial_reservation(
  uuid, uuid, numeric, uuid
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_release_partial_reservation(
  uuid, uuid, numeric, uuid
) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.inventory_v1_consume_reservation(
  p_so_id uuid,
  p_product_id uuid,
  p_batch_id uuid,
  p_quantity numeric,
  p_released_by uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_reservation record;
  v_remaining_qty numeric := p_quantity;
  v_release_qty numeric;
  v_reserved_qty numeric;
BEGIN
  IF p_so_id IS NULL THEN
    RETURN;
  END IF;
  IF COALESCE(p_quantity, 0) <= 0 THEN
    RAISE EXCEPTION 'Delivery quantity must be positive';
  END IF;

  SELECT COALESCE(sum(reserved_quantity), 0)
  INTO v_reserved_qty
  FROM public.stock_reservations
  WHERE sales_order_id = p_so_id
    AND product_id = p_product_id
    AND batch_id = p_batch_id
    AND status = 'active';

  IF v_reserved_qty < p_quantity THEN
    RAISE EXCEPTION
      'Delivery Challan batch does not match canonical FEFO reservation: reserved %, requested %',
      v_reserved_qty,
      p_quantity;
  END IF;

  FOR v_reservation IN
    SELECT id, reserved_quantity
    FROM public.stock_reservations
    WHERE sales_order_id = p_so_id
      AND product_id = p_product_id
      AND batch_id = p_batch_id
      AND status = 'active'
    ORDER BY reserved_at, id
    FOR UPDATE
  LOOP
    EXIT WHEN v_remaining_qty <= 0;
    v_release_qty := LEAST(v_remaining_qty, v_reservation.reserved_quantity);

    IF v_release_qty = v_reservation.reserved_quantity THEN
      UPDATE public.stock_reservations
      SET status = 'released',
          is_released = true,
          released_at = now(),
          released_by = COALESCE(p_released_by, auth.uid()),
          release_reason = 'delivered'
      WHERE id = v_reservation.id;
    ELSE
      UPDATE public.stock_reservations
      SET reserved_quantity = reserved_quantity - v_release_qty
      WHERE id = v_reservation.id;
    END IF;

    v_remaining_qty := v_remaining_qty - v_release_qty;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.inventory_v1_consume_reservation(
  uuid, uuid, uuid, numeric, uuid
) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.approve_sales_order_inventory_v1(
  p_so_id uuid,
  p_approved_by uuid
)
RETURNS TABLE(success boolean, message text, shortage_items jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_previous_context text;
BEGIN
  IF NOT public.inventory_v1_actor_allowed(
    ARRAY['admin', 'accounts', 'manager', 'warehouse']
  ) THEN
    RAISE EXCEPTION 'Permission denied for Sales Order approval';
  END IF;

  v_previous_context := current_setting('app.canonical_reservation_engine', true);
  PERFORM set_config('app.canonical_reservation_engine', 'on', true);

  UPDATE public.sales_orders
  SET status = 'approved',
      approved_by = COALESCE(p_approved_by, auth.uid()),
      approved_at = now(),
      updated_at = now()
  WHERE id = p_so_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sales Order not found';
  END IF;

  RETURN QUERY
  SELECT *
  FROM public.fn_reserve_stock_for_so_v2(p_so_id);

  PERFORM set_config(
    'app.canonical_reservation_engine',
    COALESCE(v_previous_context, ''),
    true
  );
END;
$$;

REVOKE ALL ON FUNCTION public.approve_sales_order_inventory_v1(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.approve_sales_order_inventory_v1(uuid, uuid)
TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.inventory_v1_guard_sales_order_approval()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status::text = 'approved'
     AND OLD.status::text IS DISTINCT FROM 'approved'
     AND current_setting('app.canonical_reservation_engine', true)
       IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'Direct Sales Order approval blocked; use canonical reservation engine';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER guard_sales_order_canonical_approval
BEFORE UPDATE OF status ON public.sales_orders
FOR EACH ROW
EXECUTE FUNCTION public.inventory_v1_guard_sales_order_approval();

-- Delivery Challan approval is the only normal physical stock outflow.
CREATE OR REPLACE FUNCTION public.trg_dc_approval_deduct_stock()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_item record;
BEGIN
  IF NEW.approval_status = 'approved'
     AND OLD.approval_status IS DISTINCT FROM 'approved' THEN
    IF NEW.approval_operation_id IS NULL THEN
      RAISE EXCEPTION 'approval_operation_id is required for DC approval';
    END IF;
    IF EXISTS (
      SELECT 1
      FROM public.inventory_transactions
      WHERE reference_type = 'delivery_challan_reversal'
        AND reference_id = NEW.id
        AND metadata->>'canonical_engine_version' = '1.0'
    ) THEN
      RAISE EXCEPTION 'Reversed Delivery Challan cannot be re-approved; create a new DC';
    END IF;
    IF NOT EXISTS (
      SELECT 1
      FROM public.delivery_challan_items
      WHERE challan_id = NEW.id
    ) THEN
      RAISE EXCEPTION 'Cannot approve Delivery Challan % without items',
        NEW.challan_number;
    END IF;

    FOR v_item IN
      SELECT *
      FROM public.delivery_challan_items
      WHERE challan_id = NEW.id
      ORDER BY id
    LOOP
      PERFORM public.inventory_v1_consume_reservation(
        NEW.sales_order_id,
        v_item.product_id,
        v_item.batch_id,
        v_item.quantity,
        NEW.approved_by
      );

      PERFORM public.post_inventory_movement(
        public.uuid_from_text(
          'inventory-v1:dc:' || NEW.approval_operation_id || ':' || v_item.id
        ),
        v_item.product_id,
        v_item.batch_id,
        'delivery_challan',
        -v_item.quantity,
        NEW.challan_date,
        NEW.challan_number,
        'delivery_challan',
        NEW.id,
        'Canonical Delivery Challan approval: ' || NEW.challan_number,
        NEW.approved_by,
        NULL,
        NULL
      );

    END LOOP;

    IF NEW.sales_order_id IS NOT NULL THEN
      PERFORM public.fn_recompute_so_delivered(NEW.sales_order_id);
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trigger_dc_approval_deduct_stock
AFTER UPDATE OF approval_status ON public.delivery_challans
FOR EACH ROW
EXECUTE FUNCTION public.trg_dc_approval_deduct_stock();

CREATE OR REPLACE FUNCTION public.trg_dc_reverse_inventory_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_item record;
BEGIN
  IF OLD.approval_status = 'approved'
     AND NEW.approval_status IN ('rejected', 'cancelled') THEN
    IF EXISTS (
      SELECT 1
      FROM public.sales_invoice_items sii
      JOIN public.delivery_challan_items dci
        ON dci.id = sii.delivery_challan_item_id
      WHERE dci.challan_id = NEW.id
    ) THEN
      RAISE EXCEPTION
        'Approved Delivery Challan already invoiced; reverse the invoice before cancelling';
    END IF;

    FOR v_item IN
      SELECT *
      FROM public.delivery_challan_items
      WHERE challan_id = NEW.id
      ORDER BY id
    LOOP
      PERFORM public.post_inventory_movement(
        public.uuid_from_text(
          'inventory-v1:dc-reversal:' || NEW.id || ':' || v_item.id || ':' ||
          NEW.approval_status
        ),
        v_item.product_id,
        v_item.batch_id,
        'adjustment',
        v_item.quantity,
        CURRENT_DATE,
        NEW.challan_number,
        'delivery_challan_reversal',
        NEW.id,
        'Canonical reversal of DC ' || NEW.challan_number ||
          ' (' || NEW.approval_status || ')',
        COALESCE(NEW.rejected_by, NEW.approved_by, auth.uid()),
        NULL,
        NULL
      );
    END LOOP;

    IF NEW.sales_order_id IS NOT NULL THEN
      PERFORM public.fn_recompute_so_delivered(NEW.sales_order_id);
      PERFORM public.fn_reserve_stock_for_so_v2(NEW.sales_order_id);
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trigger_dc_inventory_v1_reversal
AFTER UPDATE OF approval_status ON public.delivery_challans
FOR EACH ROW
EXECUTE FUNCTION public.trg_dc_reverse_inventory_v1();

CREATE OR REPLACE FUNCTION public.admin_edit_approved_delivery_challan(
  p_challan_id uuid,
  p_new_items jsonb,
  p_operation_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_challan public.delivery_challans%ROWTYPE;
  v_old_item record;
  v_item jsonb;
  v_item_id uuid;
  v_product_id uuid;
  v_batch_id uuid;
  v_quantity numeric;
BEGIN
  IF NOT public.inventory_v1_actor_allowed(ARRAY['admin']) THEN
    RAISE EXCEPTION 'Only admin can edit an approved Delivery Challan';
  END IF;
  IF p_operation_id IS NULL THEN
    RAISE EXCEPTION 'operation_id is required';
  END IF;

  SELECT *
  INTO v_challan
  FROM public.delivery_challans
  WHERE id = p_challan_id
  FOR UPDATE;

  IF NOT FOUND OR v_challan.approval_status <> 'approved' THEN
    RAISE EXCEPTION 'Approved Delivery Challan not found';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.inventory_transactions
    WHERE reference_type = 'delivery_challan'
      AND reference_id = p_challan_id
      AND COALESCE(metadata->>'canonical_engine_version', '') <> '1.0'
  ) THEN
    RAISE EXCEPTION 'Historical DC movement is ambiguous; manual review is required';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.sales_invoice_items sii
    JOIN public.delivery_challan_items dci
      ON dci.id = sii.delivery_challan_item_id
    WHERE dci.challan_id = p_challan_id
  ) THEN
    RAISE EXCEPTION
      'Approved Delivery Challan already invoiced; reverse the invoice before editing';
  END IF;

  FOR v_old_item IN
    SELECT *
    FROM public.delivery_challan_items
    WHERE challan_id = p_challan_id
    ORDER BY id
  LOOP
    PERFORM public.post_inventory_movement(
      public.uuid_from_text(
        'inventory-v1:dc-edit-reverse:' || p_operation_id || ':' ||
        v_old_item.id
      ),
      v_old_item.product_id,
      v_old_item.batch_id,
      'adjustment',
      v_old_item.quantity,
      CURRENT_DATE,
      v_challan.challan_number,
      'delivery_challan_edit_reversal',
      p_challan_id,
      'Canonical reversal before approved DC edit',
      auth.uid(),
      NULL,
      NULL
    );
  END LOOP;

  PERFORM set_config('app.skip_dc_item_trigger', 'true', true);
  DELETE FROM public.delivery_challan_items WHERE challan_id = p_challan_id;

  IF v_challan.sales_order_id IS NOT NULL THEN
    PERFORM public.fn_recompute_so_delivered(v_challan.sales_order_id);
    PERFORM public.fn_reserve_stock_for_so_v2(v_challan.sales_order_id);
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_new_items)
  LOOP
    v_product_id := (v_item->>'product_id')::uuid;
    v_batch_id := (v_item->>'batch_id')::uuid;
    v_quantity := (v_item->>'quantity')::numeric;

    INSERT INTO public.delivery_challan_items (
      challan_id,
      product_id,
      batch_id,
      quantity,
      pack_size,
      pack_type,
      number_of_packs
    )
    VALUES (
      p_challan_id,
      v_product_id,
      v_batch_id,
      v_quantity,
      NULLIF(v_item->>'pack_size', '')::numeric,
      NULLIF(v_item->>'pack_type', ''),
      NULLIF(v_item->>'number_of_packs', '')::integer
    )
    RETURNING id INTO v_item_id;

    PERFORM public.inventory_v1_consume_reservation(
      v_challan.sales_order_id,
      v_product_id,
      v_batch_id,
      v_quantity,
      auth.uid()
    );

    PERFORM public.post_inventory_movement(
      public.uuid_from_text(
        'inventory-v1:dc-edit-post:' || p_operation_id || ':' || v_item_id
      ),
      v_product_id,
      v_batch_id,
      'delivery_challan',
      -v_quantity,
      v_challan.challan_date,
      v_challan.challan_number,
      'delivery_challan',
      p_challan_id,
      'Canonical approved DC edit repost',
      auth.uid(),
      NULL,
      NULL
    );
  END LOOP;

  PERFORM set_config('app.skip_dc_item_trigger', 'false', true);
  IF v_challan.sales_order_id IS NOT NULL THEN
    PERFORM public.fn_recompute_so_delivered(v_challan.sales_order_id);
  END IF;

  RETURN jsonb_build_object('success', true);
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.skip_dc_item_trigger', 'false', true);
  RAISE;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_edit_approved_delivery_challan(
  uuid, jsonb, uuid
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_edit_approved_delivery_challan(
  uuid, jsonb, uuid
) TO authenticated, service_role;

-- Backward-compatible wrapper for older clients. It still routes through the
-- canonical reversal/repost implementation.
CREATE OR REPLACE FUNCTION public.admin_edit_approved_delivery_challan(
  p_challan_id uuid,
  p_new_items jsonb
)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.admin_edit_approved_delivery_challan(
    p_challan_id,
    p_new_items,
    gen_random_uuid()
  );
$$;

REVOKE ALL ON FUNCTION public.admin_edit_approved_delivery_challan(
  uuid, jsonb
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_edit_approved_delivery_challan(
  uuid, jsonb
) TO authenticated, service_role;

-- Sales Invoice is accounting-only. It validates an approved DC allocation and
-- never posts, reverses, or mutates physical stock.
CREATE OR REPLACE FUNCTION public.trg_sales_invoice_item_inventory()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_dc_item public.delivery_challan_items%ROWTYPE;
  v_dc_status text;
  v_invoiced_quantity numeric;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  IF NEW.delivery_challan_item_id IS NULL THEN
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
  WHERE sii.delivery_challan_item_id = NEW.delivery_challan_item_id
    AND sii.id IS DISTINCT FROM NEW.id;

  IF v_invoiced_quantity + NEW.quantity > v_dc_item.quantity THEN
    RAISE EXCEPTION 'Sales Invoice quantity exceeds approved Delivery Challan quantity';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trigger_sales_invoice_inventory_v1_validation
BEFORE INSERT OR UPDATE ON public.sales_invoice_items
FOR EACH ROW
EXECUTE FUNCTION public.trg_sales_invoice_item_inventory();

CREATE OR REPLACE FUNCTION public.trg_material_return_inventory_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_item record;
  v_is_stocked boolean;
  v_was_stocked boolean;
BEGIN
  v_is_stocked := NEW.status IN ('approved', 'completed') AND NEW.restocked = true;
  v_was_stocked := OLD.status IN ('approved', 'completed') AND OLD.restocked = true;

  IF v_is_stocked AND NOT v_was_stocked THEN
    IF EXISTS (
      SELECT 1
      FROM public.inventory_transactions
      WHERE reference_type = 'material_return_reversal'
        AND reference_id = NEW.id
        AND metadata->>'canonical_engine_version' = '1.0'
    ) THEN
      RAISE EXCEPTION 'Reversed Material Return cannot be re-approved; create a new return';
    END IF;

    FOR v_item IN
      SELECT *
      FROM public.material_return_items
      WHERE return_id = NEW.id
        AND disposition = 'restock'
        AND batch_id IS NOT NULL
      ORDER BY id
    LOOP
      PERFORM public.post_inventory_movement(
        public.uuid_from_text('inventory-v1:material-return:' || NEW.id || ':' || v_item.id),
        v_item.product_id,
        v_item.batch_id,
        'return',
        v_item.quantity_returned,
        NEW.return_date,
        NEW.return_number,
        'material_return',
        NEW.id,
        'Canonical Material Return: ' || NEW.return_number,
        NEW.approved_by,
        NULL,
        NULL
      );
    END LOOP;
  ELSIF v_was_stocked AND NOT v_is_stocked THEN
    FOR v_item IN
      SELECT *
      FROM public.material_return_items
      WHERE return_id = NEW.id
        AND disposition = 'restock'
        AND batch_id IS NOT NULL
      ORDER BY id
    LOOP
      PERFORM public.post_inventory_movement(
        public.uuid_from_text(
          'inventory-v1:material-return-reversal:' || NEW.id || ':' || v_item.id
        ),
        v_item.product_id,
        v_item.batch_id,
        'adjustment',
        -v_item.quantity_returned,
        CURRENT_DATE,
        NEW.return_number,
        'material_return_reversal',
        NEW.id,
        'Canonical Material Return reversal: ' || NEW.return_number,
        COALESCE(NEW.approved_by, auth.uid()),
        NULL,
        NULL
      );
    END LOOP;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trigger_material_return_inventory_v1
AFTER UPDATE OF status, restocked ON public.material_returns
FOR EACH ROW
EXECUTE FUNCTION public.trg_material_return_inventory_v1();

CREATE OR REPLACE FUNCTION public.trg_credit_note_inventory_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_item record;
BEGIN
  IF NEW.status = 'approved' AND OLD.status IS DISTINCT FROM 'approved' THEN
    IF EXISTS (
      SELECT 1
      FROM public.inventory_transactions
      WHERE reference_type = 'credit_note_reversal'
        AND reference_id = NEW.id
        AND metadata->>'canonical_engine_version' = '1.0'
    ) THEN
      RAISE EXCEPTION 'Reversed Credit Note cannot be re-approved; create a new Credit Note';
    END IF;

    FOR v_item IN
      SELECT *
      FROM public.credit_note_items
      WHERE credit_note_id = NEW.id
      ORDER BY id
    LOOP
      PERFORM public.post_inventory_movement(
        public.uuid_from_text('inventory-v1:credit-note:' || NEW.id || ':' || v_item.id),
        v_item.product_id,
        v_item.batch_id,
        'return',
        v_item.quantity,
        NEW.credit_note_date,
        NEW.credit_note_number,
        'credit_note',
        NEW.id,
        'Canonical Credit Note return: ' || NEW.credit_note_number,
        NEW.approved_by,
        NULL,
        NULL
      );
    END LOOP;
  ELSIF OLD.status = 'approved' AND NEW.status IS DISTINCT FROM 'approved' THEN
    FOR v_item IN
      SELECT *
      FROM public.credit_note_items
      WHERE credit_note_id = NEW.id
      ORDER BY id
    LOOP
      PERFORM public.post_inventory_movement(
        public.uuid_from_text(
          'inventory-v1:credit-note-reversal:' || NEW.id || ':' || v_item.id
        ),
        v_item.product_id,
        v_item.batch_id,
        'adjustment',
        -v_item.quantity,
        CURRENT_DATE,
        NEW.credit_note_number,
        'credit_note_reversal',
        NEW.id,
        'Canonical Credit Note reversal: ' || NEW.credit_note_number,
        COALESCE(NEW.approved_by, auth.uid()),
        NULL,
        NULL
      );
    END LOOP;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trigger_credit_note_inventory_v1
AFTER UPDATE OF status ON public.credit_notes
FOR EACH ROW
EXECUTE FUNCTION public.trg_credit_note_inventory_v1();

CREATE OR REPLACE FUNCTION public.trg_stock_rejection_inventory_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.status IN ('approved', 'disposed')
     AND OLD.status NOT IN ('approved', 'disposed') THEN
    IF EXISTS (
      SELECT 1
      FROM public.inventory_transactions
      WHERE reference_type = 'stock_rejection_reversal'
        AND reference_id = NEW.id
        AND metadata->>'canonical_engine_version' = '1.0'
    ) THEN
      RAISE EXCEPTION 'Reversed Stock Rejection cannot be re-approved; create a new rejection';
    END IF;

    PERFORM public.post_inventory_movement(
      public.uuid_from_text('inventory-v1:stock-rejection:' || NEW.id),
      NEW.product_id,
      NEW.batch_id,
      'rejection',
      -NEW.quantity_rejected,
      NEW.rejection_date,
      NEW.rejection_number,
      'stock_rejection',
      NEW.id,
      'Canonical Stock Rejection: ' || NEW.rejection_number,
      NEW.approved_by,
      NULL,
      NULL
    );
  ELSIF OLD.status IN ('approved', 'disposed')
        AND NEW.status NOT IN ('approved', 'disposed') THEN
    PERFORM public.post_inventory_movement(
      public.uuid_from_text('inventory-v1:stock-rejection-reversal:' || NEW.id),
      NEW.product_id,
      NEW.batch_id,
      'adjustment',
      NEW.quantity_rejected,
      CURRENT_DATE,
      NEW.rejection_number,
      'stock_rejection_reversal',
      NEW.id,
      'Canonical Stock Rejection reversal: ' || NEW.rejection_number,
      COALESCE(NEW.approved_by, auth.uid()),
      NULL,
      NULL
    );
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trigger_stock_rejection_inventory_v1
AFTER UPDATE OF status ON public.stock_rejections
FOR EACH ROW
EXECUTE FUNCTION public.trg_stock_rejection_inventory_v1();

CREATE OR REPLACE FUNCTION public.inventory_v1_block_approved_detail_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status text;
BEGIN
  IF TG_TABLE_NAME = 'material_return_items' THEN
    SELECT status INTO v_status
    FROM public.material_returns
    WHERE id = COALESCE(NEW.return_id, OLD.return_id);
  ELSIF TG_TABLE_NAME = 'credit_note_items' THEN
    SELECT status INTO v_status
    FROM public.credit_notes
    WHERE id = COALESCE(NEW.credit_note_id, OLD.credit_note_id);
  END IF;

  IF v_status IN ('approved', 'completed') THEN
    RAISE EXCEPTION 'Approved stock source items cannot be edited or deleted; reverse first';
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER guard_material_return_items_after_approval
BEFORE UPDATE OR DELETE ON public.material_return_items
FOR EACH ROW
EXECUTE FUNCTION public.inventory_v1_block_approved_detail_change();

CREATE TRIGGER guard_credit_note_items_after_approval
BEFORE UPDATE OR DELETE ON public.credit_note_items
FOR EACH ROW
EXECUTE FUNCTION public.inventory_v1_block_approved_detail_change();

CREATE OR REPLACE FUNCTION public.inventory_v1_guard_source_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_TABLE_NAME = 'delivery_challans'
     AND EXISTS (
       SELECT 1 FROM public.inventory_transactions
       WHERE reference_id = OLD.id
         AND reference_type = 'delivery_challan'
         AND metadata->>'canonical_engine_version' = '1.0'
     ) THEN
    RAISE EXCEPTION 'Delivery Challan with canonical stock history cannot be deleted; cancel/reverse it';
  ELSIF TG_TABLE_NAME = 'material_returns'
        AND OLD.status IN ('approved', 'completed') THEN
    RAISE EXCEPTION 'Approved Material Return cannot be deleted; reverse it first';
  ELSIF TG_TABLE_NAME = 'credit_notes'
        AND OLD.status = 'approved' THEN
    RAISE EXCEPTION 'Approved Credit Note cannot be deleted; reverse it first';
  ELSIF TG_TABLE_NAME = 'stock_rejections'
        AND OLD.status IN ('approved', 'disposed') THEN
    RAISE EXCEPTION 'Approved Stock Rejection cannot be deleted; reverse it first';
  END IF;

  RETURN OLD;
END;
$$;

CREATE TRIGGER guard_dc_canonical_history_delete
BEFORE DELETE ON public.delivery_challans
FOR EACH ROW EXECUTE FUNCTION public.inventory_v1_guard_source_delete();

CREATE TRIGGER guard_material_return_delete
BEFORE DELETE ON public.material_returns
FOR EACH ROW EXECUTE FUNCTION public.inventory_v1_guard_source_delete();

CREATE TRIGGER guard_credit_note_delete
BEFORE DELETE ON public.credit_notes
FOR EACH ROW EXECUTE FUNCTION public.inventory_v1_guard_source_delete();

CREATE TRIGGER guard_stock_rejection_delete
BEFORE DELETE ON public.stock_rejections
FOR EACH ROW EXECUTE FUNCTION public.inventory_v1_guard_source_delete();

-- Canonical batches always have a creation movement. "Delete" therefore means
-- archive; physical deletion is prohibited once any inventory history exists.
CREATE OR REPLACE FUNCTION public.archive_batch_inventory_v1(p_batch_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_batch public.batches%ROWTYPE;
BEGIN
  IF NOT public.inventory_v1_actor_allowed(
    ARRAY['admin', 'accounts', 'warehouse', 'manager']
  ) THEN
    RAISE EXCEPTION 'Permission denied for batch archive';
  END IF;

  SELECT *
  INTO v_batch
  FROM public.batches
  WHERE id = p_batch_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'archived', false,
      'reason', 'Batch not found'
    );
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.stock_reservations
    WHERE batch_id = p_batch_id
      AND status = 'active'
  ) THEN
    RETURN jsonb_build_object(
      'archived', false,
      'reason', format(
        'Batch %s has active reservations and cannot be archived',
        v_batch.batch_number
      )
    );
  END IF;

  IF v_batch.current_stock <> 0 THEN
    RETURN jsonb_build_object(
      'archived', false,
      'reason', format(
        'Batch %s still has stock %s. Post a canonical adjustment to zero before archiving',
        v_batch.batch_number,
        v_batch.current_stock
      )
    );
  END IF;

  UPDATE public.batches
  SET is_active = false,
      updated_at = now()
  WHERE id = p_batch_id;

  RETURN jsonb_build_object(
    'archived', true,
    'batch_id', p_batch_id,
    'batch_number', v_batch.batch_number
  );
END;
$$;

REVOKE ALL ON FUNCTION public.archive_batch_inventory_v1(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.archive_batch_inventory_v1(uuid)
TO authenticated, service_role;

-- Backward-compatible hard-delete endpoint. Inventory V1 intentionally changes
-- it to an archive-only operation so older clients cannot erase stock history.
CREATE OR REPLACE FUNCTION public.delete_batch_safe(p_batch_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_result jsonb;
BEGIN
  v_result := public.archive_batch_inventory_v1(p_batch_id);
  RETURN jsonb_build_object(
    'deleted', false,
    'archived', COALESCE((v_result->>'archived')::boolean, false),
    'batch_id', v_result->>'batch_id',
    'batch_number', v_result->>'batch_number',
    'reason', COALESCE(
      v_result->>'reason',
      'Inventory V1 preserves batch and movement history; the batch was archived'
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.delete_batch_safe(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_batch_safe(uuid)
TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.inventory_v1_guard_batch_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.inventory_transactions
    WHERE batch_id = OLD.id
  ) THEN
    RAISE EXCEPTION
      'Batch with inventory history cannot be deleted; archive it';
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER guard_batch_history_delete
BEFORE DELETE ON public.batches
FOR EACH ROW
EXECUTE FUNCTION public.inventory_v1_guard_batch_delete();

-- Database enforcement: application code and ad-hoc SQL cannot become a
-- second stock engine.
CREATE OR REPLACE FUNCTION public.inventory_v1_guard_batch_quantity_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF current_setting('app.canonical_stock_engine', true) IS DISTINCT FROM 'on' THEN
    IF TG_OP = 'INSERT' OR NEW.current_stock IS DISTINCT FROM OLD.current_stock THEN
      RAISE EXCEPTION 'Direct batch quantity write blocked; use canonical inventory engine';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER guard_batch_insert_canonical_engine
BEFORE INSERT ON public.batches
FOR EACH ROW
EXECUTE FUNCTION public.inventory_v1_guard_batch_quantity_write();

CREATE TRIGGER guard_batch_quantity_canonical_engine
BEFORE UPDATE OF current_stock ON public.batches
FOR EACH ROW
EXECUTE FUNCTION public.inventory_v1_guard_batch_quantity_write();

CREATE OR REPLACE FUNCTION public.inventory_v1_guard_movement_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF current_setting('app.canonical_stock_engine', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'Direct inventory movement write blocked; use canonical inventory engine';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER guard_inventory_movement_canonical_engine
BEFORE INSERT OR UPDATE OR DELETE ON public.inventory_transactions
FOR EACH ROW
EXECUTE FUNCTION public.inventory_v1_guard_movement_write();

-- Canonical report sources. Forward movements use Inventory V1 metadata.
-- Historical periods retain the certified legacy convention where invoice
-- "sale" rows represented stock OUT and legacy DC rows were duplicates.
CREATE OR REPLACE FUNCTION public.inventory_v1_movement_report(
  p_date_from date,
  p_date_to date
)
RETURNS TABLE(
  product_id uuid,
  product_code text,
  product_name text,
  unit text,
  opening numeric,
  in_qty numeric,
  out_qty numeric,
  reserved_qty numeric,
  closing numeric
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH cfg AS (
    SELECT enforcement_started_at
    FROM public.inventory_engine_certification
    WHERE singleton
  ),
  physical_movements AS (
    SELECT it.product_id, it.transaction_date, it.quantity
    FROM public.inventory_transactions it
    CROSS JOIN cfg
    WHERE (
      it.metadata->>'canonical_engine_version' = '1.0'
      OR (
        it.created_at < cfg.enforcement_started_at
        AND it.transaction_type IN ('purchase', 'sale', 'return', 'adjustment')
      )
    )
      AND COALESCE((it.metadata->>'superseded')::boolean, false) = false
  ),
  movement_totals AS (
    SELECT
      pm.product_id,
      COALESCE(sum(pm.quantity) FILTER (
        WHERE pm.transaction_date < p_date_from
      ), 0) AS opening,
      COALESCE(sum(pm.quantity) FILTER (
        WHERE pm.transaction_date BETWEEN p_date_from AND p_date_to
          AND pm.quantity > 0
      ), 0) AS in_qty,
      COALESCE(abs(sum(pm.quantity) FILTER (
        WHERE pm.transaction_date BETWEEN p_date_from AND p_date_to
          AND pm.quantity < 0
      )), 0) AS out_qty
    FROM physical_movements pm
    GROUP BY pm.product_id
  ),
  reservations AS (
    SELECT sr.product_id, COALESCE(sum(sr.reserved_quantity), 0) reserved_qty
    FROM public.stock_reservations sr
    WHERE sr.status = 'active'
    GROUP BY sr.product_id
  )
  SELECT
    p.id,
    p.product_code,
    p.product_name,
    COALESCE(p.unit, 'PCS'),
    COALESCE(mt.opening, 0),
    COALESCE(mt.in_qty, 0),
    COALESCE(mt.out_qty, 0),
    COALESCE(r.reserved_qty, 0),
    COALESCE(mt.opening, 0)
      + COALESCE(mt.in_qty, 0)
      - COALESCE(mt.out_qty, 0)
  FROM public.products p
  LEFT JOIN movement_totals mt ON mt.product_id = p.id
  LEFT JOIN reservations r ON r.product_id = p.id
  WHERE COALESCE(mt.opening, 0) <> 0
     OR COALESCE(mt.in_qty, 0) <> 0
     OR COALESCE(mt.out_qty, 0) <> 0
     OR COALESCE(r.reserved_qty, 0) <> 0
  ORDER BY p.product_code, p.product_name;
$$;

REVOKE ALL ON FUNCTION public.inventory_v1_movement_report(date, date)
FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.inventory_v1_movement_report(date, date)
TO authenticated, service_role;

CREATE OR REPLACE VIEW public.inventory_v1_stock_summary
WITH (security_invoker = true)
AS
WITH batch_totals AS (
  SELECT
    b.product_id,
    COALESCE(sum(b.current_stock) FILTER (WHERE b.is_active), 0)
      AS total_current_stock,
    count(*) FILTER (WHERE b.is_active) AS active_batch_count,
    count(*) FILTER (
      WHERE b.is_active
        AND b.expiry_date IS NOT NULL
        AND b.expiry_date <= CURRENT_DATE
    ) AS expired_batch_count,
    min(b.expiry_date) FILTER (
      WHERE b.is_active
        AND b.expiry_date > CURRENT_DATE
        AND b.current_stock > 0
    ) AS nearest_expiry_date
  FROM public.batches b
  GROUP BY b.product_id
),
reservation_totals AS (
  SELECT
    sr.product_id,
    COALESCE(sum(sr.reserved_quantity), 0) AS reserved_stock
  FROM public.stock_reservations sr
  WHERE sr.status = 'active'
  GROUP BY sr.product_id
),
shortage_totals AS (
  SELECT
    ir.product_id,
    COALESCE(sum(ir.shortage_quantity), 0) AS shortage_quantity
  FROM public.import_requirements ir
  WHERE ir.status IN ('pending', 'ordered')
  GROUP BY ir.product_id
)
SELECT
  p.id AS product_id,
  p.product_name,
  p.product_code,
  p.unit,
  p.category,
  p.min_stock_level,
  COALESCE(bt.total_current_stock, 0) AS total_current_stock,
  COALESCE(rt.reserved_stock, 0) AS reserved_stock,
  COALESCE(bt.total_current_stock, 0) - COALESCE(rt.reserved_stock, 0)
    AS available_quantity,
  COALESCE(st.shortage_quantity, 0) AS shortage_quantity,
  COALESCE(bt.active_batch_count, 0) AS active_batch_count,
  COALESCE(bt.expired_batch_count, 0) AS expired_batch_count,
  bt.nearest_expiry_date
FROM public.products p
LEFT JOIN batch_totals bt ON bt.product_id = p.id
LEFT JOIN reservation_totals rt ON rt.product_id = p.id
LEFT JOIN shortage_totals st ON st.product_id = p.id
WHERE p.is_active = true;

REVOKE ALL ON public.inventory_v1_stock_summary FROM PUBLIC, anon;
GRANT SELECT ON public.inventory_v1_stock_summary
TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.inventory_v1_certification_status()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH cfg AS (
    SELECT enforcement_started_at
    FROM public.inventory_engine_certification
    WHERE singleton
  ),
  checks AS (
    SELECT
      (
        SELECT count(*)
        FROM public.batches b, cfg
        WHERE b.created_at >= cfg.enforcement_started_at
          AND NOT EXISTS (
            SELECT 1
            FROM public.inventory_transactions it
            WHERE it.batch_id = b.id
              AND it.transaction_type = 'purchase'
              AND it.metadata->>'canonical_engine_version' = '1.0'
          )
      ) new_batches_without_canonical_creation,
      (
        SELECT count(*)
        FROM public.inventory_transactions it, cfg
        WHERE it.created_at >= cfg.enforcement_started_at
          AND COALESCE(it.metadata->>'canonical_engine_version', '') <> '1.0'
      ) noncanonical_new_movements,
      (
        SELECT count(*)
        FROM public.inventory_transactions it, cfg
        WHERE it.created_at >= cfg.enforcement_started_at
          AND it.transaction_type = 'sale'
      ) sales_invoice_physical_movements,
      (
        SELECT count(*)
        FROM public.sales_invoice_items sii, cfg
        WHERE sii.created_at >= cfg.enforcement_started_at
          AND sii.delivery_challan_item_id IS NULL
      ) new_invoice_items_without_dc,
      (
        SELECT count(*)
        FROM (
          SELECT dci.challan_id, dci.batch_id, dci.product_id
          FROM public.delivery_challan_items dci
          JOIN public.delivery_challans dc ON dc.id = dci.challan_id
          CROSS JOIN cfg
          WHERE dc.approval_status::text = 'approved'
            AND COALESCE(dc.approved_at, dc.updated_at, dc.created_at)
              >= cfg.enforcement_started_at
          GROUP BY dci.challan_id, dci.batch_id, dci.product_id
          HAVING sum(dci.quantity) IS DISTINCT FROM (
            SELECT abs(COALESCE(sum(it.quantity), 0))
            FROM public.inventory_transactions it
            WHERE it.reference_type = 'delivery_challan'
              AND it.reference_id = dci.challan_id
              AND it.batch_id = dci.batch_id
              AND it.product_id = dci.product_id
              AND it.metadata->>'canonical_engine_version' = '1.0'
          )
        ) mismatch
      ) approved_dc_movement_mismatches,
      (
        SELECT count(*)
        FROM (
          SELECT mri.return_id, mri.batch_id, mri.product_id
          FROM public.material_return_items mri
          JOIN public.material_returns mr ON mr.id = mri.return_id
          CROSS JOIN cfg
          WHERE mr.status IN ('approved', 'completed')
            AND mr.restocked = true
            AND mri.disposition = 'restock'
            AND mr.updated_at >= cfg.enforcement_started_at
          GROUP BY mri.return_id, mri.batch_id, mri.product_id
          HAVING sum(mri.quantity_returned) IS DISTINCT FROM (
            SELECT COALESCE(sum(it.quantity), 0)
            FROM public.inventory_transactions it
            WHERE it.reference_type = 'material_return'
              AND it.reference_id = mri.return_id
              AND it.batch_id = mri.batch_id
              AND it.product_id = mri.product_id
              AND it.metadata->>'canonical_engine_version' = '1.0'
          )
        ) mismatch
      ) material_return_movement_mismatches,
      (
        SELECT count(*)
        FROM (
          SELECT cni.credit_note_id, cni.batch_id, cni.product_id
          FROM public.credit_note_items cni
          JOIN public.credit_notes cn ON cn.id = cni.credit_note_id
          CROSS JOIN cfg
          WHERE cn.status = 'approved'
            AND cn.updated_at >= cfg.enforcement_started_at
          GROUP BY cni.credit_note_id, cni.batch_id, cni.product_id
          HAVING sum(cni.quantity) IS DISTINCT FROM (
            SELECT COALESCE(sum(it.quantity), 0)
            FROM public.inventory_transactions it
            WHERE it.reference_type = 'credit_note'
              AND it.reference_id = cni.credit_note_id
              AND it.batch_id = cni.batch_id
              AND it.product_id = cni.product_id
              AND it.metadata->>'canonical_engine_version' = '1.0'
          )
        ) mismatch
      ) credit_note_movement_mismatches,
      (
        SELECT count(*)
        FROM public.stock_rejections sr, cfg
        WHERE sr.status IN ('approved', 'disposed')
          AND sr.updated_at >= cfg.enforcement_started_at
          AND NOT EXISTS (
            SELECT 1
            FROM public.inventory_transactions it
            WHERE it.reference_type = 'stock_rejection'
              AND it.reference_id = sr.id
              AND it.batch_id = sr.batch_id
              AND it.quantity = -sr.quantity_rejected
              AND it.metadata->>'canonical_engine_version' = '1.0'
          )
      ) stock_rejection_movement_mismatches,
      (
        SELECT count(*)
        FROM public.stock_reservations sr
        JOIN public.batches b ON b.id = sr.batch_id
        CROSS JOIN cfg
        WHERE sr.reserved_at >= cfg.enforcement_started_at
          AND sr.status = 'active'
          AND b.expiry_date IS NOT NULL
          AND b.expiry_date <= CURRENT_DATE
      ) active_reservations_on_expired_batches,
      (
        SELECT count(*)
        FROM public.batches
        WHERE current_stock < 0
      ) negative_batches
  )
  SELECT jsonb_build_object(
    'engine_version', '1.0',
    'enforcement_started_at', (SELECT enforcement_started_at FROM cfg),
    'certified',
      new_batches_without_canonical_creation = 0
      AND noncanonical_new_movements = 0
      AND sales_invoice_physical_movements = 0
      AND new_invoice_items_without_dc = 0
      AND approved_dc_movement_mismatches = 0
      AND material_return_movement_mismatches = 0
      AND credit_note_movement_mismatches = 0
      AND stock_rejection_movement_mismatches = 0
      AND active_reservations_on_expired_batches = 0
      AND negative_batches = 0,
    'checks', jsonb_build_object(
      'new_batches_without_canonical_creation',
        new_batches_without_canonical_creation,
      'noncanonical_new_movements', noncanonical_new_movements,
      'sales_invoice_physical_movements', sales_invoice_physical_movements,
      'new_invoice_items_without_dc', new_invoice_items_without_dc,
      'approved_dc_movement_mismatches', approved_dc_movement_mismatches,
      'material_return_movement_mismatches',
        material_return_movement_mismatches,
      'credit_note_movement_mismatches', credit_note_movement_mismatches,
      'stock_rejection_movement_mismatches',
        stock_rejection_movement_mismatches,
      'active_reservations_on_expired_batches',
        active_reservations_on_expired_batches,
      'negative_batches', negative_batches
    )
  )
  FROM checks;
$$;

REVOKE ALL ON FUNCTION public.inventory_v1_certification_status() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.inventory_v1_certification_status()
TO authenticated, service_role;

COMMIT;
