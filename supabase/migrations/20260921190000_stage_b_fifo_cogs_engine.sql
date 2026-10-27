-- Migration: 20260921190000_stage_b_fifo_cogs_engine.sql
-- Description: Implement Stage B — Chronological FIFO COGS Engine using purchase_batch_cost_layers.

BEGIN;

-- 1. Add cogs_layer_allocations to sales_invoice_items to preserve layer consumption history
ALTER TABLE public.sales_invoice_items
  ADD COLUMN IF NOT EXISTS cogs_layer_allocations jsonb;

COMMENT ON COLUMN public.sales_invoice_items.cogs_layer_allocations IS
  'Array of purchase_batch_cost_layers consumed for this sales item, including layer_id, pi_number, quantity, and unit cost.';

-- 2. Reconcile B108/2026 and B109/2026 layers to align with PO/25-26/014 and physical receipts
-- B108/2026: 10,000 kg (functional total: 92,352,000.00, landed: 5,815,553.20, final unit: 9816.76)
UPDATE public.purchase_batch_cost_layers pbcl
   SET quantity = 10000.000,
       functional_total_cost = 92352000.00,
       landed_cost_amount = 5815553.20,
       final_functional_unit_cost = 9816.76
  FROM public.batches b
 WHERE b.id = pbcl.batch_id
   AND b.batch_number = 'B108/2026';

UPDATE public.purchase_invoice_receiving_allocations pira
   SET received_quantity = 10000.000,
       functional_total_cost = 92352000.00
  FROM public.batches b
 WHERE b.id = pira.batch_id
   AND b.batch_number = 'B108/2026';

-- B109/2026: 9,000 kg (functional total: 83,116,800.00, landed: 5,233,997.88, final unit: 9816.76)
UPDATE public.purchase_batch_cost_layers pbcl
   SET quantity = 9000.000,
       functional_total_cost = 83116800.00,
       landed_cost_amount = 5233997.88,
       final_functional_unit_cost = 9816.76
  FROM public.batches b
 WHERE b.id = pbcl.batch_id
   AND b.batch_number = 'B109/2026';

UPDATE public.purchase_invoice_receiving_allocations pira
   SET received_quantity = 9000.000,
       functional_total_cost = 83116800.00
  FROM public.batches b
 WHERE b.id = pira.batch_id
   AND b.batch_number = 'B109/2026';

-- 3. Function to get layer-aware batch authoritative unit cost (for display and single-layer batches)
CREATE OR REPLACE FUNCTION public.calculate_batch_authoritative_cost(p_batch public.batches)
RETURNS numeric
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_layer_count integer;
  v_weighted_unit_cost numeric;
BEGIN
  -- If purchase_batch_cost_layers exist, return the weighted final functional unit cost
  SELECT COUNT(*),
         ROUND(SUM(pbcl.quantity * pbcl.final_functional_unit_cost) / NULLIF(SUM(pbcl.quantity), 0), 4)
    INTO v_layer_count, v_weighted_unit_cost
    FROM public.purchase_batch_cost_layers pbcl
   WHERE pbcl.batch_id = p_batch.id;

  IF v_layer_count > 0 AND v_weighted_unit_cost IS NOT NULL AND v_weighted_unit_cost > 0 THEN
    RETURN v_weighted_unit_cost;
  END IF;

  -- Fallback to landed_cost_per_unit or cost_per_unit
  RETURN COALESCE(
    NULLIF(p_batch.landed_cost_per_unit, 0),
    NULLIF(p_batch.cost_per_unit, 0),
    NULLIF(p_batch.import_price, 0),
    0
  );
END;
$$;

-- 4. Function: effective_sales_cogs_unit_cost (layer-aware)
CREATE OR REPLACE FUNCTION public.effective_sales_cogs_unit_cost(p_batch_id uuid)
RETURNS numeric
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_batch public.batches%ROWTYPE;
BEGIN
  SELECT * INTO v_batch FROM public.batches WHERE id = p_batch_id;
  IF NOT FOUND THEN RETURN 0; END IF;
  RETURN public.calculate_batch_authoritative_cost(v_batch);
END;
$$;

-- 5. Enhanced propagate_batch_cost_change using true chronological FIFO layer consumption
CREATE OR REPLACE FUNCTION public.propagate_batch_cost_change(p_batch_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_batch public.batches%ROWTYPE;
  v_layer_count integer;
  v_inv record;
  v_item record;
  v_layer record;
  v_target_item_cogs numeric;
  v_target_total numeric;
  v_posted_gl numeric;
  v_inv_delta numeric;
  v_je_id uuid;
  v_je_number text;
  v_entry_date date;
  v_period_id uuid;
  v_period_status text;
  v_source_module text;
  v_description text;
  v_base_ref_num text;
  v_ref_num text;
  v_counter integer;
  v_cogs_account_id uuid;
  v_inventory_account_id uuid;
  v_line_number integer;
  v_adjusted_invoices_count integer := 0;
  v_adjusted_items_count integer := 0;
  v_total_delta_posted numeric := 0;
  
  -- FIFO simulation variables
  v_rem_to_consume numeric;
  v_layer_consume numeric;
  v_item_fifo_cogs numeric;
  v_item_layer_alloc jsonb;
  v_item_delta numeric;
  v_item_old_cogs numeric;
BEGIN
  -- Prevent trigger cascades while allowing normal execution
  IF current_setting('app.in_cogs_propagation', true) = 'on' THEN
    RETURN jsonb_build_object('success', true, 'message', 'Propagation already active in current session');
  END IF;

  PERFORM set_config('app.in_cogs_propagation', 'on', true);

  SELECT * INTO v_batch FROM public.batches WHERE id = p_batch_id FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM set_config('app.in_cogs_propagation', 'off', true);
    RETURN jsonb_build_object('success', false, 'error', 'Batch not found');
  END IF;

  SELECT id INTO v_cogs_account_id FROM public.chart_of_accounts WHERE code = '5100' LIMIT 1;
  SELECT id INTO v_inventory_account_id FROM public.chart_of_accounts WHERE code = '1130' LIMIT 1;
  IF v_cogs_account_id IS NULL OR v_inventory_account_id IS NULL THEN
    PERFORM set_config('app.in_cogs_propagation', 'off', true);
    RAISE EXCEPTION 'Missing COGS (5100) or Inventory (1130) account in chart_of_accounts';
  END IF;

  -- Build temp table for layers of this batch with running remaining quantities
  DROP TABLE IF EXISTS tmp_batch_fifo_layers;
  CREATE TEMP TABLE tmp_batch_fifo_layers ON COMMIT DROP AS
    SELECT 
      pbcl.id as layer_id,
      pbcl.quantity as original_qty,
      pbcl.quantity as remaining_qty,
      pbcl.final_functional_unit_cost as unit_cost,
      pi.invoice_number as pi_number,
      COALESCE(pira.received_at, pi.invoice_date::timestamp, pbcl.created_at) as receipt_date
    FROM public.purchase_batch_cost_layers pbcl
    LEFT JOIN public.purchase_invoices pi ON pi.id = pbcl.purchase_invoice_id
    LEFT JOIN public.purchase_invoice_receiving_allocations pira ON pira.id = pbcl.receiving_allocation_id
   WHERE pbcl.batch_id = p_batch_id
   ORDER BY receipt_date ASC, pbcl.id ASC;

  SELECT COUNT(*) INTO v_layer_count FROM tmp_batch_fifo_layers;

  -- Iterate through each posted sales invoice containing items from this batch in chronological order
  FOR v_inv IN
    SELECT DISTINCT si.id, si.invoice_number, si.invoice_date, si.customer_id, si.created_by
      FROM public.sales_invoices si
      JOIN public.sales_invoice_items sii ON sii.invoice_id = si.id
     WHERE sii.batch_id = p_batch_id
       AND NOT COALESCE(si.is_draft, false)
     ORDER BY si.invoice_date ASC, si.id ASC
  LOOP
    -- Iterate through each item in this invoice for this batch
    FOR v_item IN
      SELECT sii.id, sii.quantity, COALESCE(sii.cogs_total_cost, 0) as old_cogs
        FROM public.sales_invoice_items sii
       WHERE sii.invoice_id = v_inv.id
         AND sii.batch_id = p_batch_id
       ORDER BY sii.id
    LOOP
      v_rem_to_consume := COALESCE(v_item.quantity, 0);
      v_item_fifo_cogs := 0;
      v_item_layer_alloc := '[]'::jsonb;

      IF v_layer_count > 0 THEN
        FOR v_layer IN
          SELECT * FROM tmp_batch_fifo_layers
           WHERE remaining_qty > 0.00001
           ORDER BY receipt_date ASC, layer_id ASC
        LOOP
          EXIT WHEN v_rem_to_consume <= 0.00001;
          v_layer_consume := LEAST(v_layer.remaining_qty, v_rem_to_consume);
          v_item_fifo_cogs := v_item_fifo_cogs + (v_layer_consume * v_layer.unit_cost);
          
          UPDATE tmp_batch_fifo_layers
             SET remaining_qty = remaining_qty - v_layer_consume
           WHERE layer_id = v_layer.layer_id;

          v_item_layer_alloc := v_item_layer_alloc || jsonb_build_object(
            'layer_id', v_layer.layer_id,
            'pi_number', v_layer.pi_number,
            'receipt_date', v_layer.receipt_date,
            'consumed_qty', v_layer_consume,
            'unit_cost', v_layer.unit_cost,
            'cost', ROUND(v_layer_consume * v_layer.unit_cost, 2)
          );

          v_rem_to_consume := v_rem_to_consume - v_layer_consume;
        END LOOP;
      ELSE
        -- Fallback to scalar batch cost if no layers exist
        v_item_fifo_cogs := v_rem_to_consume * COALESCE(v_batch.landed_cost_per_unit, v_batch.cost_per_unit, 0);
      END IF;

      v_target_item_cogs := ROUND(v_item_fifo_cogs, 2);

      -- Update snapshot on sales_invoice_items
      UPDATE public.sales_invoice_items
         SET cogs_unit_cost = CASE WHEN v_item.quantity > 0 THEN ROUND(v_target_item_cogs / v_item.quantity, 4) ELSE 0 END,
             cogs_total_cost = v_target_item_cogs,
             cogs_layer_allocations = v_item_layer_alloc
       WHERE id = v_item.id;

      v_adjusted_items_count := v_adjusted_items_count + 1;
    END LOOP;

    -- Now calculate invoice-level target total across ALL items of this invoice
    SELECT COALESCE(SUM(sii_all.cogs_total_cost), 0)
      INTO v_target_total
      FROM public.sales_invoice_items sii_all
     WHERE sii_all.invoice_id = v_inv.id;

    -- Calculate total posted GL 5100 for this invoice across all active journals
    SELECT COALESCE(SUM(jel.debit - jel.credit), 0)
      INTO v_posted_gl
      FROM public.journal_entries je
      JOIN public.journal_entry_lines jel ON jel.journal_entry_id = je.id
      JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
     WHERE je.reference_id = v_inv.id
       AND coa.code = '5100'
       AND je.is_posted = true
       AND NOT COALESCE(je.is_reversed, false);

    v_inv_delta := ROUND(v_target_total - v_posted_gl, 2);

    IF ABS(v_inv_delta) >= 0.01 THEN
      SELECT ap.status INTO v_period_status
        FROM public.accounting_periods ap
       WHERE ap.start_date <= v_inv.invoice_date AND ap.end_date >= v_inv.invoice_date
       ORDER BY ap.start_date DESC LIMIT 1;

      IF v_period_status = 'open' THEN
        v_entry_date := v_inv.invoice_date;
      ELSE
        v_entry_date := CURRENT_DATE;
      END IF;

      SELECT id INTO v_period_id
        FROM public.accounting_periods
       WHERE start_date <= v_entry_date AND end_date >= v_entry_date
       ORDER BY start_date DESC LIMIT 1;

      v_source_module := 'sales_invoice_cogs_adjustment';
      v_description := 'FIFO COGS True-Up: ' || v_inv.invoice_number || ' (Batch ' || v_batch.batch_number || ')';
      v_base_ref_num := v_inv.invoice_number || '-FIFO-ADJ';
      v_ref_num := v_base_ref_num;
      v_counter := 2;
      WHILE EXISTS (
        SELECT 1 FROM public.journal_entries
         WHERE source_module = v_source_module
           AND reference_number = v_ref_num
           AND NOT COALESCE(is_reversed, false)
      ) LOOP
        v_ref_num := v_base_ref_num || '-' || v_counter;
        v_counter := v_counter + 1;
      END LOOP;

      v_je_number := public.next_journal_entry_number();

      INSERT INTO public.journal_entries (
        entry_number, entry_date, period_id, source_module, reference_id, reference_number,
        description, total_debit, total_credit, is_posted, posted_by, created_by
      ) VALUES (
        v_je_number, v_entry_date, v_period_id, v_source_module, v_inv.id, v_ref_num,
        v_description, ABS(v_inv_delta), ABS(v_inv_delta),
        true, COALESCE(auth.uid(), v_inv.created_by), COALESCE(auth.uid(), v_inv.created_by)
      ) RETURNING id INTO v_je_id;

      v_line_number := 1;

      IF v_inv_delta > 0 THEN
        -- Target > Posted: Debit 5100 COGS, Credit 1130 Inventory
        INSERT INTO public.journal_entry_lines (
          journal_entry_id, line_number, account_id, description, debit, credit,
          customer_id, batch_id
        ) VALUES (
          v_je_id, v_line_number, v_cogs_account_id,
          'FIFO COGS adjustment - ' || v_inv.invoice_number, v_inv_delta, 0,
          v_inv.customer_id, p_batch_id
        );
        v_line_number := v_line_number + 1;

        INSERT INTO public.journal_entry_lines (
          journal_entry_id, line_number, account_id, description, debit, credit,
          customer_id, batch_id
        ) VALUES (
          v_je_id, v_line_number, v_inventory_account_id,
          'FIFO Inventory revaluation - ' || v_inv.invoice_number, 0, v_inv_delta,
          v_inv.customer_id, p_batch_id
        );
      ELSE
        -- Target < Posted: Debit 1130 Inventory, Credit 5100 COGS
        INSERT INTO public.journal_entry_lines (
          journal_entry_id, line_number, account_id, description, debit, credit,
          customer_id, batch_id
        ) VALUES (
          v_je_id, v_line_number, v_inventory_account_id,
          'FIFO Inventory revaluation (downward) - ' || v_inv.invoice_number, ABS(v_inv_delta), 0,
          v_inv.customer_id, p_batch_id
        );
        v_line_number := v_line_number + 1;

        INSERT INTO public.journal_entry_lines (
          journal_entry_id, line_number, account_id, description, debit, credit,
          customer_id, batch_id
        ) VALUES (
          v_je_id, v_line_number, v_cogs_account_id,
          'FIFO COGS adjustment (downward) - ' || v_inv.invoice_number, 0, ABS(v_inv_delta),
          v_inv.customer_id, p_batch_id
        );
      END IF;

      v_adjusted_invoices_count := v_adjusted_invoices_count + 1;
      v_total_delta_posted := v_total_delta_posted + v_inv_delta;
    END IF;

  END LOOP;

  PERFORM set_config('app.in_cogs_propagation', 'off', true);

  RETURN jsonb_build_object(
    'success', true,
    'batch_id', p_batch_id,
    'batch_number', v_batch.batch_number,
    'adjusted_invoices_count', v_adjusted_invoices_count,
    'adjusted_items_count', v_adjusted_items_count,
    'total_delta_posted', v_total_delta_posted
  );
END;
$$;

-- 6. Refactor post_sales_invoice_cogs() trigger for future sales to use FIFO cost layers
CREATE OR REPLACE FUNCTION public.post_sales_invoice_cogs()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_existing_cogs_je_id uuid;
  v_je_id uuid;
  v_je_number text;
  v_cogs_account_id uuid;
  v_inventory_account_id uuid;
  v_period_id uuid;
  v_item record;
  v_layer record;
  v_rem_to_consume numeric;
  v_layer_consume numeric;
  v_item_fifo_cogs numeric;
  v_item_alloc jsonb;
  v_total_cogs numeric := 0;
  v_line_number integer := 1;
  v_snapshot_item_ids uuid[] := ARRAY[]::uuid[];
  v_snapshot_unit_costs numeric[] := ARRAY[]::numeric[];
  v_snapshot_total_costs numeric[] := ARRAY[]::numeric[];
  v_snapshot_allocs jsonb[] := ARRAY[]::jsonb[];
BEGIN
  IF NEW.journal_entry_id IS NULL THEN RETURN NEW; END IF;
  IF NEW.payment_status NOT IN ('pending', 'partial', 'paid') THEN RETURN NEW; END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.id::text, 0));

  SELECT id INTO v_existing_cogs_je_id
    FROM public.journal_entries
   WHERE source_module = 'sales_invoice_cogs'
     AND reference_id = NEW.id
   LIMIT 1;
  IF v_existing_cogs_je_id IS NOT NULL THEN RETURN NEW; END IF;

  SELECT id INTO v_cogs_account_id FROM public.chart_of_accounts WHERE code = '5100' LIMIT 1;
  SELECT id INTO v_inventory_account_id FROM public.chart_of_accounts WHERE code = '1130' LIMIT 1;
  IF v_cogs_account_id IS NULL OR v_inventory_account_id IS NULL THEN
    RAISE EXCEPTION
      'post_sales_invoice_cogs: Missing COGS (5100) or Inventory (1130) in chart_of_accounts.';
  END IF;

  SELECT id INTO v_period_id
    FROM public.accounting_periods
   WHERE start_date <= NEW.invoice_date AND end_date >= NEW.invoice_date
   ORDER BY start_date DESC LIMIT 1;

  FOR v_item IN
    SELECT sii.id, sii.quantity, sii.batch_id, b.landed_cost_per_unit, b.cost_per_unit
      FROM public.sales_invoice_items sii
      LEFT JOIN public.batches b ON b.id = sii.batch_id
     WHERE sii.invoice_id = NEW.id
       AND sii.batch_id IS NOT NULL
     ORDER BY sii.id
  LOOP
    v_rem_to_consume := COALESCE(v_item.quantity, 0);
    v_item_fifo_cogs := 0;
    v_item_alloc := '[]'::jsonb;

    -- Look up available cost layers for this batch, taking into account prior posted sales
    FOR v_layer IN
      WITH prior_sales AS (
        SELECT COALESCE(SUM(sii_prior.quantity), 0) as prior_consumed
          FROM public.sales_invoice_items sii_prior
          JOIN public.sales_invoices si_prior ON si_prior.id = sii_prior.invoice_id
         WHERE sii_prior.batch_id = v_item.batch_id
           AND NOT COALESCE(si_prior.is_draft, false)
           AND (si_prior.invoice_date < NEW.invoice_date 
                OR (si_prior.invoice_date = NEW.invoice_date AND si_prior.id < NEW.id)
                OR (si_prior.id = NEW.id AND sii_prior.id < v_item.id))
      ),
      ordered_layers AS (
        SELECT 
          pbcl.id as layer_id,
          pbcl.quantity as layer_qty,
          pbcl.final_functional_unit_cost as unit_cost,
          pi.invoice_number as pi_number,
          COALESCE(pira.received_at, pi.invoice_date::timestamp, pbcl.created_at) as receipt_date,
          COALESCE(SUM(pbcl.quantity) OVER (
            ORDER BY COALESCE(pira.received_at, pi.invoice_date::timestamp, pbcl.created_at) ASC, pbcl.id ASC
            ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
          ), 0) as prior_layer_qty_sum
        FROM public.purchase_batch_cost_layers pbcl
        LEFT JOIN public.purchase_invoices pi ON pi.id = pbcl.purchase_invoice_id
        LEFT JOIN public.purchase_invoice_receiving_allocations pira ON pira.id = pbcl.receiving_allocation_id
       WHERE pbcl.batch_id = v_item.batch_id
      )
      SELECT 
        ol.layer_id,
        ol.layer_qty,
        ol.unit_cost,
        ol.pi_number,
        ol.receipt_date,
        GREATEST(0, ol.layer_qty - GREATEST(0, ps.prior_consumed - ol.prior_layer_qty_sum)) as available_qty
      FROM ordered_layers ol
      CROSS JOIN prior_sales ps
      ORDER BY ol.receipt_date ASC, ol.layer_id ASC
    LOOP
      EXIT WHEN v_rem_to_consume <= 0.00001;
      CONTINUE WHEN v_layer.available_qty <= 0.00001;

      v_layer_consume := LEAST(v_layer.available_qty, v_rem_to_consume);
      v_item_fifo_cogs := v_item_fifo_cogs + (v_layer_consume * v_layer.unit_cost);

      v_item_alloc := v_item_alloc || jsonb_build_object(
        'layer_id', v_layer.layer_id,
        'pi_number', v_layer.pi_number,
        'receipt_date', v_layer.receipt_date,
        'consumed_qty', v_layer_consume,
        'unit_cost', v_layer.unit_cost,
        'cost', ROUND(v_layer_consume * v_layer.unit_cost, 2)
      );

      v_rem_to_consume := v_rem_to_consume - v_layer_consume;
    END LOOP;

    -- If remaining quantity couldn't be satisfied from layers, use batch scalar fallback
    IF v_rem_to_consume > 0.00001 THEN
      v_item_fifo_cogs := v_item_fifo_cogs + (v_rem_to_consume * COALESCE(v_item.landed_cost_per_unit, v_item.cost_per_unit, 0));
    END IF;

    v_item_fifo_cogs := ROUND(v_item_fifo_cogs, 2);

    v_snapshot_item_ids := array_append(v_snapshot_item_ids, v_item.id);
    v_snapshot_unit_costs := array_append(
      v_snapshot_unit_costs, 
      CASE WHEN v_item.quantity > 0 THEN ROUND(v_item_fifo_cogs / v_item.quantity, 4) ELSE 0 END
    );
    v_snapshot_total_costs := array_append(v_snapshot_total_costs, v_item_fifo_cogs);
    v_snapshot_allocs := array_append(v_snapshot_allocs, v_item_alloc);

    v_total_cogs := v_total_cogs + v_item_fifo_cogs;
  END LOOP;

  IF v_total_cogs <= 0 THEN RETURN NEW; END IF;

  -- Update snapshots on sales_invoice_items
  UPDATE public.sales_invoice_items sii
     SET cogs_unit_cost = s.unit_cost,
         cogs_total_cost = s.total_cost,
         cogs_layer_allocations = s.alloc
    FROM unnest(
      v_snapshot_item_ids,
      v_snapshot_unit_costs,
      v_snapshot_total_costs,
      v_snapshot_allocs
    ) AS s(item_id, unit_cost, total_cost, alloc)
   WHERE sii.id = s.item_id;

  v_je_number := public.next_journal_entry_number();
  INSERT INTO public.journal_entries (
    entry_number, entry_date, period_id, source_module, reference_id, reference_number,
    description, total_debit, total_credit, is_posted, posted_by, created_by
  ) VALUES (
    v_je_number, NEW.invoice_date, v_period_id, 'sales_invoice_cogs', NEW.id, NEW.invoice_number,
    'COGS for Sales Invoice: ' || NEW.invoice_number,
    v_total_cogs, v_total_cogs, true, NEW.created_by, NEW.created_by
  ) RETURNING id INTO v_je_id;

  -- Debit 5100 COGS, Credit 1130 Inventory
  FOR v_item IN
    SELECT sii.id, sii.quantity, sii.batch_id, sii.cogs_total_cost
      FROM public.sales_invoice_items sii
     WHERE sii.invoice_id = NEW.id
       AND sii.batch_id IS NOT NULL
     ORDER BY sii.id
  LOOP
    IF COALESCE(v_item.cogs_total_cost, 0) > 0 THEN
      INSERT INTO public.journal_entry_lines (
        journal_entry_id, line_number, account_id, description, debit, credit,
        customer_id, batch_id, sales_invoice_item_id
      ) VALUES (
        v_je_id, v_line_number, v_cogs_account_id,
        'COGS - ' || NEW.invoice_number, v_item.cogs_total_cost, 0,
        NEW.customer_id, v_item.batch_id, v_item.id
      );
      v_line_number := v_line_number + 1;

      INSERT INTO public.journal_entry_lines (
        journal_entry_id, line_number, account_id, description, debit, credit,
        customer_id, batch_id, sales_invoice_item_id
      ) VALUES (
        v_je_id, v_line_number, v_inventory_account_id,
        'Inventory reduction - ' || NEW.invoice_number, 0, v_item.cogs_total_cost,
        NEW.customer_id, v_item.batch_id, v_item.id
      );
      v_line_number := v_line_number + 1;
    END IF;
  END LOOP;

  RETURN NEW;
END;
$$;

COMMIT;
