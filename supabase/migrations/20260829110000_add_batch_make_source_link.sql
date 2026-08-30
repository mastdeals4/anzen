-- Phase 1: link inventory batches to the existing Product Source identity.
-- Existing products, batches, stock movements, and documents are unchanged.
ALTER TABLE public.batches
  ADD COLUMN IF NOT EXISTS make_id uuid
  REFERENCES public.product_sources(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_batches_make_id ON public.batches(make_id);

-- Enforce that a selected source/make belongs to the batch product, including
-- for callers other than the Batch UI/RPC. NULL preserves unknown history.
ALTER TABLE public.product_sources
  ADD CONSTRAINT product_sources_product_id_id_key UNIQUE (product_id, id);

ALTER TABLE public.batches
  ADD CONSTRAINT batches_product_make_source_fkey
  FOREIGN KEY (product_id, make_id)
  REFERENCES public.product_sources(product_id, id)
  ON DELETE RESTRICT;

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
  IF NOT public.inventory_v1_actor_allowed(ARRAY['admin', 'accounts', 'warehouse', 'manager']) THEN
    RAISE EXCEPTION 'Permission denied for canonical batch save';
  END IF;
  IF p_operation_id IS NULL THEN
    RAISE EXCEPTION 'operation_id is required';
  END IF;
  IF p_batch_id IS NULL AND NULLIF(p_payload->>'make_id', '') IS NULL THEN
    RAISE EXCEPTION 'Make / Manufacturer is required for new inventory batches';
  END IF;
  IF NULLIF(p_payload->>'make_id', '') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM public.product_sources
        WHERE id = (p_payload->>'make_id')::uuid
          AND product_id = (p_payload->>'product_id')::uuid
     ) THEN
    RAISE EXCEPTION 'Selected Make / Manufacturer does not belong to the selected product';
  END IF;

  IF p_batch_id IS NULL THEN
    SELECT batch_id INTO v_existing_batch_id
      FROM public.inventory_transactions
     WHERE operation_id = p_operation_id AND transaction_type = 'purchase';
    IF FOUND THEN
      RETURN jsonb_build_object('success', true, 'batch_id', v_existing_batch_id, 'idempotent_retry', true);
    END IF;

    v_previous_context := current_setting('app.canonical_stock_engine', true);
    PERFORM set_config('app.canonical_stock_engine', 'on', true);
    INSERT INTO public.batches (
      batch_number, product_id, make_id, import_container_id, import_date,
      import_quantity, current_stock, packaging_details, import_price,
      import_price_usd, exchange_rate_usd_to_idr, duty_percent, duty_charges,
      duty_charge_type, freight_charges, freight_charge_type, other_charges,
      other_charge_type, expiry_date, is_active, created_by
    ) VALUES (
      p_payload->>'batch_number', (p_payload->>'product_id')::uuid,
      NULLIF(p_payload->>'make_id', '')::uuid,
      NULLIF(p_payload->>'import_container_id', '')::uuid,
      (p_payload->>'import_date')::date, (p_payload->>'import_quantity')::numeric,
      0, NULLIF(p_payload->>'packaging_details', ''),
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
      NULLIF(p_payload->>'expiry_date', '')::date, true, v_actor
    ) RETURNING * INTO v_batch;
    PERFORM set_config('app.canonical_stock_engine', COALESCE(v_previous_context, ''), true);
    PERFORM public.post_inventory_movement(
      p_operation_id, v_batch.product_id, v_batch.id, 'purchase',
      v_batch.import_quantity, v_batch.import_date, v_batch.batch_number,
      'batch_creation', v_batch.id, 'Canonical Batch Creation: ' || v_batch.batch_number,
      v_actor, 0, v_batch.import_quantity
    );
    RETURN jsonb_build_object('success', true, 'batch_id', v_batch.id);
  END IF;

  SELECT * INTO v_batch FROM public.batches WHERE id = p_batch_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Batch not found'; END IF;
  IF (p_payload->>'product_id')::uuid IS DISTINCT FROM v_batch.product_id
     AND EXISTS (SELECT 1 FROM public.inventory_transactions WHERE batch_id = p_batch_id AND transaction_type <> 'purchase') THEN
    RAISE EXCEPTION 'Cannot change product after batch stock movement exists';
  END IF;

  v_delta := (p_payload->>'import_quantity')::numeric - v_batch.import_quantity;
  UPDATE public.batches SET
    batch_number = p_payload->>'batch_number', product_id = (p_payload->>'product_id')::uuid,
    make_id = NULLIF(p_payload->>'make_id', '')::uuid,
    import_container_id = NULLIF(p_payload->>'import_container_id', '')::uuid,
    import_date = (p_payload->>'import_date')::date, import_quantity = (p_payload->>'import_quantity')::numeric,
    packaging_details = NULLIF(p_payload->>'packaging_details', ''),
    import_price = COALESCE((p_payload->>'import_price')::numeric, import_price),
    import_price_usd = NULLIF(p_payload->>'import_price_usd', '')::numeric,
    exchange_rate_usd_to_idr = NULLIF(p_payload->>'exchange_rate_usd_to_idr', '')::numeric,
    duty_percent = COALESCE(NULLIF(p_payload->>'duty_percent', '')::numeric, 0),
    duty_charges = COALESCE(NULLIF(p_payload->>'duty_charges', '')::numeric, 0),
    duty_charge_type = COALESCE(NULLIF(p_payload->>'duty_charge_type', ''), duty_charge_type),
    freight_charges = COALESCE(NULLIF(p_payload->>'freight_charges', '')::numeric, 0),
    freight_charge_type = COALESCE(NULLIF(p_payload->>'freight_charge_type', ''), freight_charge_type),
    other_charges = COALESCE(NULLIF(p_payload->>'other_charges', '')::numeric, 0),
    other_charge_type = COALESCE(NULLIF(p_payload->>'other_charge_type', ''), other_charge_type),
    expiry_date = NULLIF(p_payload->>'expiry_date', '')::date, updated_at = now()
  WHERE id = p_batch_id;

  IF v_delta <> 0 THEN
    PERFORM public.post_inventory_movement(
      p_operation_id, (p_payload->>'product_id')::uuid, p_batch_id, 'adjustment',
      v_delta, CURRENT_DATE, p_payload->>'batch_number', 'batch_edit', p_batch_id,
      format('Canonical Batch Edit quantity correction: %s to %s', v_batch.import_quantity, (p_payload->>'import_quantity')::numeric),
      v_actor, v_batch.current_stock, v_batch.current_stock + v_delta
    );
  END IF;
  RETURN jsonb_build_object('success', true, 'batch_id', p_batch_id);
END;
$$;

COMMENT ON COLUMN public.batches.make_id IS 'Optional link to product_sources; NULL means historical make not recorded.';
