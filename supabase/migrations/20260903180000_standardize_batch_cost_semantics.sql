-- Migration: 20260903180000_standardize_batch_cost_semantics.sql
-- Description: Standardize batch cost semantics, remove obsolete generated column formulas,
--              reconcile historical local batches to authoritative Purchase Invoice prices,
--              and align canonical effective sales COGS unit cost calculation.

-- 1. Remove obsolete generated-column expressions from batches table
ALTER TABLE public.batches ALTER COLUMN cost_per_unit DROP EXPRESSION IF EXISTS;
ALTER TABLE public.batches ALTER COLUMN import_price_per_unit DROP EXPRESSION IF EXISTS;

-- 2. Reconcile the 5 historical local batches against their authoritative Purchase Invoice item unit prices
UPDATE public.batches b
SET
  import_price = pii.unit_price,
  cost_per_unit = pii.unit_price,
  landed_cost_per_unit = pii.unit_price,
  final_landed_cost = pii.unit_price * b.import_quantity,
  import_price_per_unit = pii.unit_price
FROM public.purchase_invoices pi
JOIN public.purchase_invoice_items pii ON pii.purchase_invoice_id = pi.id
WHERE b.purchase_invoice_id = pi.id
  AND pii.product_id = b.product_id
  AND pii.quantity = b.import_quantity
  AND b.import_container_id IS NULL
  AND b.batch_number IN ('DFS/125120557', 'DFS/126010052', 'DFS/126030157', 'DFS/126030158', 'PH25097020');

-- 3. For existing imported batches, synchronize cost_per_unit with landed_cost_per_unit
UPDATE public.batches
SET
  cost_per_unit = landed_cost_per_unit,
  import_price_per_unit = import_price
WHERE import_container_id IS NOT NULL AND landed_cost_per_unit > 0;

-- 4. Update canonical effective_sales_cogs_unit_cost function
CREATE OR REPLACE FUNCTION public.effective_sales_cogs_unit_cost(p_batch_id uuid)
RETURNS numeric
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT COALESCE(
    NULLIF(b.landed_cost_per_unit, 0),
    NULLIF(b.import_price, 0),
    NULLIF(b.cost_per_unit, 0)
  )
  FROM public.batches b
  WHERE b.id = p_batch_id;
$$;

COMMENT ON FUNCTION public.effective_sales_cogs_unit_cost(uuid)
IS 'Returns authoritative landed unit cost (for imports) or authoritative local purchase unit cost (for local goods)';

-- 5. Update save_batch_inventory_v1 to populate cost_per_unit and landed_cost_per_unit correctly
CREATE OR REPLACE FUNCTION public.save_batch_inventory_v1(p_batch_id uuid, p_payload jsonb, p_operation_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_batch public.batches%ROWTYPE;
  v_existing_batch_id uuid;
  v_actor uuid := auth.uid();
  v_delta numeric;
  v_previous_context text;
  v_unit_price numeric;
  v_is_local boolean;
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

  v_unit_price := COALESCE((p_payload->>'import_price')::numeric, 0);
  v_is_local := NULLIF(p_payload->>'import_container_id', '') IS NULL;

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
      other_charge_type, expiry_date, is_active, created_by,
      cost_per_unit, landed_cost_per_unit, final_landed_cost, import_price_per_unit
    ) VALUES (
      p_payload->>'batch_number', (p_payload->>'product_id')::uuid,
      NULLIF(p_payload->>'make_id', '')::uuid,
      NULLIF(p_payload->>'import_container_id', '')::uuid,
      (p_payload->>'import_date')::date, (p_payload->>'import_quantity')::numeric,
      0, NULLIF(p_payload->>'packaging_details', ''),
      v_unit_price,
      NULLIF(p_payload->>'import_price_usd', '')::numeric,
      NULLIF(p_payload->>'exchange_rate_usd_to_idr', '')::numeric,
      COALESCE(NULLIF(p_payload->>'duty_percent', '')::numeric, 0),
      COALESCE(NULLIF(p_payload->>'duty_charges', '')::numeric, 0),
      COALESCE(NULLIF(p_payload->>'duty_charge_type', ''), 'fixed'),
      COALESCE(NULLIF(p_payload->>'freight_charges', '')::numeric, 0),
      COALESCE(NULLIF(p_payload->>'freight_charge_type', ''), 'fixed'),
      COALESCE(NULLIF(p_payload->>'other_charges', '')::numeric, 0),
      COALESCE(NULLIF(p_payload->>'other_charge_type', ''), 'fixed'),
      NULLIF(p_payload->>'expiry_date', '')::date, true, v_actor,
      v_unit_price,
      CASE WHEN v_is_local THEN v_unit_price ELSE 0 END,
      CASE WHEN v_is_local THEN v_unit_price * (p_payload->>'import_quantity')::numeric ELSE 0 END,
      v_unit_price
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
    expiry_date = NULLIF(p_payload->>'expiry_date', '')::date,
    cost_per_unit = CASE
      WHEN NULLIF(p_payload->>'import_container_id', '') IS NULL
        THEN COALESCE((p_payload->>'import_price')::numeric, import_price)
      ELSE cost_per_unit
    END,
    landed_cost_per_unit = CASE
      WHEN NULLIF(p_payload->>'import_container_id', '') IS NULL
        THEN COALESCE((p_payload->>'import_price')::numeric, import_price)
      ELSE landed_cost_per_unit
    END,
    final_landed_cost = CASE
      WHEN NULLIF(p_payload->>'import_container_id', '') IS NULL
        THEN COALESCE((p_payload->>'import_price')::numeric, import_price) * (p_payload->>'import_quantity')::numeric
      ELSE final_landed_cost
    END,
    import_price_per_unit = COALESCE((p_payload->>'import_price')::numeric, import_price),
    updated_at = now()
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
$function$;

-- 6. Update reallocate_container_costs to keep cost_per_unit in sync with landed_cost_per_unit
CREATE OR REPLACE FUNCTION public.reallocate_container_costs(p_container_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_total_invoice_value numeric := 0;
  v_batch_record record;
  v_total_container_costs numeric;
  v_batch_percentage numeric;
  v_allocated_cost numeric;
  v_landed_cost_per_unit numeric;
  v_final_total_cost numeric;
BEGIN
  v_total_container_costs := public.calculate_container_landed_cost_pool(p_container_id);

  SELECT COALESCE(SUM(COALESCE(import_price,0) * COALESCE(import_quantity,0)), 0)
    INTO v_total_invoice_value
  FROM public.batches
  WHERE import_container_id = p_container_id;

  IF v_total_invoice_value <= 0 THEN
    RETURN;
  END IF;

  FOR v_batch_record IN
    SELECT id, import_price, import_quantity, duty_charges, freight_charges, other_charges
    FROM public.batches
    WHERE import_container_id = p_container_id
      AND COALESCE(cost_locked, false) = false
  LOOP
    v_batch_percentage :=
      (COALESCE(v_batch_record.import_price,0) * COALESCE(v_batch_record.import_quantity,0))
      / v_total_invoice_value;

    v_allocated_cost := v_total_container_costs * v_batch_percentage;

    v_landed_cost_per_unit :=
      COALESCE(v_batch_record.import_price,0)
      + COALESCE(v_batch_record.duty_charges,0)
      + COALESCE(v_batch_record.freight_charges,0) / NULLIF(v_batch_record.import_quantity,0)
      + COALESCE(v_batch_record.other_charges,0) / NULLIF(v_batch_record.import_quantity,0)
      + v_allocated_cost / NULLIF(v_batch_record.import_quantity,0);

    v_final_total_cost :=
      (COALESCE(v_batch_record.import_price,0) + COALESCE(v_batch_record.duty_charges,0))
        * COALESCE(v_batch_record.import_quantity,0)
      + COALESCE(v_batch_record.freight_charges,0)
      + COALESCE(v_batch_record.other_charges,0)
      + v_allocated_cost;

    UPDATE public.batches
    SET import_cost_allocated = ROUND(v_allocated_cost, 2),
        final_landed_cost = ROUND(v_final_total_cost, 2),
        landed_cost_per_unit = ROUND(v_landed_cost_per_unit, 2),
        cost_per_unit = ROUND(v_landed_cost_per_unit, 2),
        import_price_per_unit = import_price,
        updated_at = now()
    WHERE id = v_batch_record.id;
  END LOOP;
END;
$function$;

-- 7. Update post_sales_invoice_cogs to use authoritative cost basis
CREATE OR REPLACE FUNCTION public.post_sales_invoice_cogs()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_existing_cogs_je_id UUID;
  v_je_id UUID;
  v_je_number TEXT;
  v_cogs_account_id UUID;
  v_inventory_account_id UUID;
  v_item RECORD;
  v_total_cogs NUMERIC := 0;
BEGIN
  -- Only consider invoices that have already had their revenue JE posted.
  IF NEW.journal_entry_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Skip non-billable invoices (drafts, voids, cancellations).
  IF NEW.payment_status NOT IN ('pending', 'partial', 'paid') THEN
    RETURN NEW;
  END IF;

  -- Idempotency: never post a second COGS JE for the same invoice.
  SELECT id INTO v_existing_cogs_je_id
  FROM journal_entries
  WHERE source_module = 'sales_invoice_cogs'
    AND reference_id = NEW.id
  LIMIT 1;

  IF v_existing_cogs_je_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT id INTO v_cogs_account_id      FROM chart_of_accounts WHERE code = '5100' LIMIT 1;
  SELECT id INTO v_inventory_account_id FROM chart_of_accounts WHERE code = '1130' LIMIT 1;

  IF v_cogs_account_id IS NULL OR v_inventory_account_id IS NULL THEN
    RAISE EXCEPTION
      'post_sales_invoice_cogs: chart_of_accounts is missing 5100 (COGS) or 1130 (Inventory). Cannot post COGS for invoice %.',
      NEW.invoice_number;
  END IF;

  -- Compute COGS from items: landed_cost_per_unit -> import_price -> cost_per_unit -> 0
  FOR v_item IN
    SELECT
      sii.quantity,
      sii.batch_id,
      COALESCE(
        NULLIF(b.landed_cost_per_unit, 0),
        NULLIF(b.import_price, 0),
        NULLIF(b.cost_per_unit, 0),
        0
      ) AS effective_cost
    FROM sales_invoice_items sii
    LEFT JOIN batches b ON b.id = sii.batch_id
    WHERE sii.invoice_id = NEW.id
      AND sii.batch_id IS NOT NULL
  LOOP
    v_total_cogs := v_total_cogs + (COALESCE(v_item.quantity, 0) * v_item.effective_cost);
  END LOOP;

  -- No cost basis available. Nothing to post.
  IF v_total_cogs <= 0 THEN
    RETURN NEW;
  END IF;

  v_je_number := next_journal_entry_number();

  INSERT INTO journal_entries (
    entry_number, entry_date, source_module, reference_id, reference_number,
    description, total_debit, total_credit, is_posted, posted_by, created_by
  ) VALUES (
    v_je_number, NEW.invoice_date, 'sales_invoice_cogs', NEW.id, NEW.invoice_number,
    'COGS for Sales Invoice: ' || NEW.invoice_number,
    v_total_cogs, v_total_cogs, true, NEW.created_by, NEW.created_by
  )
  RETURNING id INTO v_je_id;

  -- Dr: COGS
  INSERT INTO journal_entry_lines (
    journal_entry_id, line_number, account_id, description, debit, credit, customer_id
  ) VALUES (
    v_je_id, 1, v_cogs_account_id, 'COGS - ' || NEW.invoice_number,
    v_total_cogs, 0, NEW.customer_id
  );

  -- Cr: Inventory
  INSERT INTO journal_entry_lines (
    journal_entry_id, line_number, account_id, description, debit, credit, customer_id
  ) VALUES (
    v_je_id, 2, v_inventory_account_id, 'Inventory - ' || NEW.invoice_number,
    0, v_total_cogs, NEW.customer_id
  );

  RETURN NEW;

EXCEPTION
  WHEN OTHERS THEN
    RAISE LOG 'post_sales_invoice_cogs failed for invoice %: %', NEW.id, SQLERRM;
    RAISE;
END;
$function$;
