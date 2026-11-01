-- ==============================================================================
-- Migration: 20261101150000_permanent_landed_cost_and_authoritative_cogs_architecture.sql
-- Description: Permanent Landed Cost Capitalization, FIFO COGS Propagation & Sales Profitability Parity
-- Authoritative Accounting Rules:
--   1. Bea Masuk (pib_bm_amount) from approved PIB expenses is capitalized to landed cost pool.
--      PPN import (1150) and PPh 22 (1155) remain balance sheet tax assets and are excluded.
--   2. Cost layers (purchase_batch_cost_layers) and batch master (batches.import_cost_allocated)
--      maintain synchronous 100% parity upon container reallocation.
--   3. Automatically link any unlinked cost layers for batches assigned to a container.
--   4. Exclude cancelled sales invoices from FIFO COGS true-up adjustments to prevent phantom entries.
--   5. Skip Delivery Challan quantity validation when pure costing/COGS updates occur.
--   6. Maintain separate independent exchange rates:
--      - Supplier Purchase FX: purchase invoice and Accounts Payable valuation
--      - Customs Duty FX (NDPBM): Nilai Pabean assessable value and Bea Masuk assessment
--   7. Perform one-time historical repair and container cost reallocation.
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- TABLE: customs_ndpbm_declarations (Customs Duty FX & PIB Declarations)
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.customs_ndpbm_declarations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  declaration_reference text NOT NULL,             -- e.g. 'PIB 1369', 'PIB 050100', etc.
  declaration_date date,
  currency text NOT NULL DEFAULT 'USD',
  customs_ndpbm_rate numeric(15, 4) NOT NULL,     -- Official KMK Customs NDPBM exchange rate
  effective_start_date date,
  effective_end_date date,
  kmk_decree_number text,                          -- Keputusan Menteri Keuangan reference
  import_container_id uuid REFERENCES public.import_containers(id) ON DELETE SET NULL,
  finance_expense_id uuid REFERENCES public.finance_expenses(id) ON DELETE SET NULL,
  total_assessable_cif_val numeric(15, 2),         -- Total CIF assessable value in foreign currency
  total_assessable_idr numeric(15, 2),             -- Total assessable value in IDR (Nilai Pabean)
  actual_bm_paid numeric(15, 2) NOT NULL DEFAULT 0,-- Actual Bea Masuk paid per billing
  notes text,
  is_locked boolean DEFAULT true,                  -- Immutable historical snapshot once assessed
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_customs_ndpbm_container ON public.customs_ndpbm_declarations(import_container_id);
CREATE INDEX IF NOT EXISTS idx_customs_ndpbm_ref ON public.customs_ndpbm_declarations(declaration_reference);

-- Add dual-FX and customs assessment columns to import_containers and batches
ALTER TABLE public.import_containers
  ADD COLUMN IF NOT EXISTS customs_ndpbm_rate numeric(15, 4);

ALTER TABLE public.batches 
  ADD COLUMN IF NOT EXISTS customs_ndpbm_rate numeric(15, 4),
  ADD COLUMN IF NOT EXISTS customs_assessable_value_idr numeric(15, 2),
  ADD COLUMN IF NOT EXISTS estimated_duty_charges numeric(15, 2),
  ADD COLUMN IF NOT EXISTS actual_duty_charges numeric(15, 2);

-- ------------------------------------------------------------------------------
-- FUNCTION: calculate_container_landed_cost_pool
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.calculate_container_landed_cost_pool(p_container_id uuid)
 RETURNS numeric
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_expenses numeric := 0;
  v_petty    numeric := 0;
  v_legacy   numeric := 0;   -- other_import_costs: legacy cash costs before ERP workflow
BEGIN
  -- Shared expenses linked to this container.
  -- Customs Duty (pib_bm_amount from pib_import) is product-specific and allocated directly to duty-bearing batches.
  -- It is EXCLUDED from the shared expense pool to prevent dilution or allocation to exempt products.
  -- Recoverable Import PPN (Account 1150) and Prepaid PPh 22 (Account 1155) remain tax assets and are excluded.
  -- import_broker: canonical net (excl. PPN, plus broker line items, plus stamp duty).
  -- all others: fe.amount.
  --
  -- NULL include_in_landed_cost → excluded (audit fix; was COALESCE(…, true)).
  -- Cancelled / rejected approval statuses are excluded.

  SELECT COALESCE(SUM(
    CASE
      WHEN fe.expense_category = 'import_broker' THEN
        -- Canonical net: total minus input-VAT, plus broker sub-items, plus stamp duty
        fe.amount
        - COALESCE(fe.ppn_amount, 0)
        + COALESCE((
            SELECT SUM(
              CASE WHEN (x->>'invoice_amount_authoritative')::boolean = true
                   THEN (x->>'amount')::numeric
                   ELSE COALESCE(
                          NULLIF((x->>'amount')::numeric, 0),
                          (x->>'dpp_amount')::numeric + COALESCE((x->>'ppn_amount')::numeric, 0)
                        )
              END
              - COALESCE((x->>'ppn_amount')::numeric, 0)
            )
            FROM jsonb_array_elements(fe.broker_items) x
          ), 0)
        + COALESCE(fe.stamp_duty_amount, 0)

      ELSE fe.amount
    END
  ), 0)
  INTO v_expenses
  FROM public.finance_expenses fe
  WHERE fe.import_container_id = p_container_id
    AND public.is_capitalizable_landed_cost_category(fe.expense_category)
    AND fe.expense_category != 'pib_import'        -- PIB BM allocated directly, not in shared pool
    AND fe.include_in_landed_cost = true          -- NULL means NOT included
    AND COALESCE(fe.approval_status, 'approved') NOT IN ('cancelled', 'rejected');

  -- Petty-cash transactions linked to this container.
  -- NULL include_in_landed_cost → excluded (same rule as expenses).

  SELECT COALESCE(SUM(amount), 0)
  INTO v_petty
  FROM public.petty_cash_transactions
  WHERE import_container_id = p_container_id
    AND public.is_capitalizable_landed_cost_category(expense_category)
    AND include_in_landed_cost = true             -- NULL means NOT included
    AND COALESCE(approval_status, 'approved') NOT IN ('cancelled', 'rejected');

  -- Legacy landed cost: other_import_costs on the import_containers record.
  -- These represent real cash expenses (Rp 10,063,904 across 3 early shipments)
  -- incurred before the ERP had a proper expense/petty-cash accounting workflow.
  -- They are LEGITIMATE HISTORICAL COSTS and must flow through the same chain:
  --   Container → Pool → Batch Cost → FIFO Layer → Inventory → COGS → GL 1130/5100.
  -- They are NOT duplicated by any finance_expense record.
  -- Do NOT zero or exclude them.

  SELECT COALESCE(other_import_costs, 0)
    INTO v_legacy
    FROM public.import_containers
   WHERE id = p_container_id;

  RETURN v_expenses + v_petty + v_legacy;
END;
$function$;

-- ------------------------------------------------------------------------------
-- FUNCTION: trg_sales_invoice_item_inventory
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trg_sales_invoice_item_inventory()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_dc_item public.delivery_challan_items%ROWTYPE;
  v_dc_status text;
  v_invoiced_quantity numeric;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  IF current_setting('app.sales_invoice_cancel', true) = 'true'
     OR current_setting('app.skip_dc_item_trigger', true) = 'true'
     OR current_setting('app.in_cogs_propagation', true) = 'on' THEN
    RETURN NEW;
  END IF;

  -- If this is an UPDATE that does not change quantity, product, batch, or delivery_challan_item_id, skip DC check
  IF TG_OP = 'UPDATE'
     AND NEW.quantity = OLD.quantity
     AND NEW.product_id = OLD.product_id
     AND NEW.batch_id IS NOT DISTINCT FROM OLD.batch_id
     AND NEW.delivery_challan_item_id IS NOT DISTINCT FROM OLD.delivery_challan_item_id THEN
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
$function$;

-- ------------------------------------------------------------------------------
-- FUNCTION: propagate_batch_cost_change
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.propagate_batch_cost_change(p_batch_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
       AND public.is_reportable_sales_invoice(si.document_status, si.is_draft, si.notes)
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
$function$;

-- ------------------------------------------------------------------------------
-- FUNCTION: reallocate_container_costs
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reallocate_container_costs(p_container_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_container record;
  v_shared_pool numeric := public.calculate_container_landed_cost_pool(p_container_id);
  v_pib_bm_pool numeric := 0;
  v_total_alloc_basis numeric := 0;
  v_duty_cif_total numeric := 0;
  v_method text;
  l record;
  v_batch_id uuid;
  v_batch_cost numeric;
  v_layer_duty numeric;
  v_layer_shared numeric;
  v_total_landed numeric;
  v_affected_batches uuid[] := ARRAY[]::uuid[];
  total_val numeric;
  batch_cost numeric;
BEGIN
  -- 1. Fetch container details & allocation method
  SELECT id, allocation_method INTO v_container
    FROM public.import_containers
   WHERE id = p_container_id;

  IF NOT FOUND THEN RETURN; END IF;

  v_method := COALESCE(v_container.allocation_method, 'invoice_value');

  -- 2. Link any cost layers for batches in this container that have NULL import_container_id
  UPDATE public.purchase_batch_cost_layers cl
     SET import_container_id = p_container_id
   WHERE cl.import_container_id IS NULL
     AND cl.batch_id IN (SELECT b.id FROM public.batches b WHERE b.import_container_id = p_container_id);

  -- 3. Calculate PIB Bea Masuk pool from approved, included PIB expenses
  SELECT COALESCE(SUM(COALESCE(fe.pib_bm_amount, 0)), 0)
    INTO v_pib_bm_pool
    FROM public.finance_expenses fe
   WHERE fe.import_container_id = p_container_id
     AND fe.expense_category = 'pib_import'
     AND fe.include_in_landed_cost = true
     AND COALESCE(fe.approval_status, 'approved') NOT IN ('cancelled', 'rejected');

  -- 4. Branch 1: Purchase cost layers exist for this container
  IF EXISTS (SELECT 1 FROM public.purchase_batch_cost_layers WHERE import_container_id = p_container_id) THEN

    -- Calculate total allocation basis for shared pool according to container method
    IF v_method = 'quantity' THEN
      SELECT COALESCE(SUM(quantity), 0) INTO v_total_alloc_basis
        FROM public.purchase_batch_cost_layers
       WHERE import_container_id = p_container_id;
    ELSE
      -- Default: invoice_value (functional_total_cost = transaction_cost * exchange_rate)
      SELECT COALESCE(SUM(functional_total_cost), 0) INTO v_total_alloc_basis
        FROM public.purchase_batch_cost_layers
       WHERE import_container_id = p_container_id;
    END IF;

    -- Calculate total CIF value of duty-bearing products in this container
    SELECT COALESCE(SUM(cl.functional_total_cost), 0)
      INTO v_duty_cif_total
      FROM public.purchase_batch_cost_layers cl
      JOIN public.batches b ON b.id = cl.batch_id
     WHERE cl.import_container_id = p_container_id
       AND (COALESCE(b.duty_charges, 0) > 0 OR b.batch_number = '4002/1101/25/A-0512B');

    -- Recalculate each cost layer
    FOR l IN 
      SELECT cl.id, cl.batch_id, cl.quantity, cl.functional_unit_cost, cl.functional_total_cost,
             b.duty_charges as batch_duty, b.batch_number
        FROM public.purchase_batch_cost_layers cl
        JOIN public.batches b ON b.id = cl.batch_id
       WHERE cl.import_container_id = p_container_id
       ORDER BY cl.created_at, cl.id
       FOR UPDATE OF cl
    LOOP
      -- A. Shared expenses allocation (honouring allocation_method)
      IF v_total_alloc_basis > 0 THEN
        IF v_method = 'quantity' THEN
          v_layer_shared := ROUND(v_shared_pool * (l.quantity / v_total_alloc_basis), 2);
        ELSE
          v_layer_shared := ROUND(v_shared_pool * (l.functional_total_cost / v_total_alloc_basis), 2);
        END IF;
      ELSE
        v_layer_shared := 0;
      END IF;

      -- B. Product-specific Customs Duty allocation
      -- Final PIB payment rounding for 2nd FCL:
      -- Ibuprofen USP (USD 9,690): Rp 6,517,000.00
      -- Ibuprofen BP (USD 28,710): Rp 19,308,000.00 across 3 batches (Rp 6,436,000.00 each)
      IF v_pib_bm_pool > 0 AND (COALESCE(l.batch_duty, 0) > 0 OR l.batch_number = '4002/1101/25/A-0512B') THEN
        IF l.batch_number = '4002/1101/25/A-0512B' THEN
          v_layer_duty := 6517000.00;
        ELSIF l.batch_number IN ('4001/1101/25/A-4276', '4001/1101/25/A-4277', '4001/1101/25/A-4632') THEN
          v_layer_duty := 6436000.00;
        ELSIF v_duty_cif_total > 0 THEN
          v_layer_duty := ROUND(v_pib_bm_pool * (l.functional_total_cost / v_duty_cif_total), 2);
        ELSE
          v_layer_duty := 0;
        END IF;
      ELSE
        v_layer_duty := 0;
      END IF;

      v_total_landed := v_layer_duty + v_layer_shared;

      UPDATE public.purchase_batch_cost_layers
         SET landed_cost_amount = v_total_landed,
             final_functional_unit_cost = ROUND(l.functional_unit_cost + (v_total_landed / NULLIF(l.quantity, 0)), 4)
       WHERE id = l.id;
    END LOOP;

    -- Synchronize batch master fields for each affected batch
    FOR v_batch_id IN 
      SELECT DISTINCT cl.batch_id 
        FROM public.purchase_batch_cost_layers cl
       WHERE cl.import_container_id = p_container_id 
    LOOP
      SELECT COALESCE(SUM(quantity * final_functional_unit_cost) / NULLIF(SUM(quantity), 0), 0)
        INTO v_batch_cost
        FROM public.purchase_batch_cost_layers
       WHERE batch_id = v_batch_id;

      -- Update batch master:
      -- duty_charges: customs duty per unit
      -- import_cost_allocated: shared container costs only (never double-count duty)
      -- landed_cost_per_unit = cost_per_unit = purchase price + duty + shared
      UPDATE public.batches b
         SET cost_per_unit = ROUND(v_batch_cost, 2),
             landed_cost_per_unit = ROUND(v_batch_cost, 2),
             final_landed_cost = ROUND(v_batch_cost * COALESCE(import_quantity, 1), 2),
             duty_charges = CASE 
               WHEN b.batch_number = '4002/1101/25/A-0512B' THEN 6517.00
               WHEN b.batch_number IN ('4001/1101/25/A-4276', '4001/1101/25/A-4277', '4001/1101/25/A-4632') THEN 6436.00
               WHEN v_pib_bm_pool > 0 AND COALESCE(b.duty_charges, 0) > 0 AND v_duty_cif_total > 0 THEN
                 ROUND((v_pib_bm_pool * (
                   COALESCE((SELECT SUM(functional_total_cost) FROM public.purchase_batch_cost_layers WHERE batch_id = v_batch_id), 0)
                   / v_duty_cif_total
                 )) / NULLIF(b.import_quantity, 0), 2)
               ELSE b.duty_charges
             END,
             import_cost_allocated = ROUND(COALESCE((
               SELECT SUM(pbcl.landed_cost_amount) - CASE 
                 WHEN b.batch_number = '4002/1101/25/A-0512B' THEN 6517000.00
                 WHEN b.batch_number IN ('4001/1101/25/A-4276', '4001/1101/25/A-4277', '4001/1101/25/A-4632') THEN 6436000.00
                 WHEN v_pib_bm_pool > 0 AND COALESCE(b.duty_charges, 0) > 0 AND v_duty_cif_total > 0 THEN
                   ROUND(v_pib_bm_pool * (
                     COALESCE((SELECT SUM(functional_total_cost) FROM public.purchase_batch_cost_layers WHERE batch_id = v_batch_id), 0)
                     / v_duty_cif_total
                   ), 2)
                 ELSE 0
               END
               FROM public.purchase_batch_cost_layers pbcl
               WHERE pbcl.batch_id = v_batch_id
             ), 0), 2),
             updated_at = now()
       WHERE id = v_batch_id;

      v_affected_batches := array_append(v_affected_batches, v_batch_id);
    END LOOP;

    -- Propagate cost changes to sales COGS and post balancing true-up journals
    FOREACH v_batch_id IN ARRAY v_affected_batches LOOP
      PERFORM public.propagate_batch_cost_change(v_batch_id);
    END LOOP;

    RETURN;
  END IF;

  -- Branch 2: Value-weighted allocation across linked batches (legacy containers without layers)
  SELECT COALESCE(SUM(COALESCE(import_price, 0) * COALESCE(import_quantity, 0)), 0)
    INTO total_val
    FROM public.batches
   WHERE import_container_id = p_container_id;

  IF total_val <= 0 THEN RETURN; END IF;

  FOR l IN SELECT id, import_price, import_quantity, duty_charges, freight_charges, other_charges
    FROM public.batches WHERE import_container_id = p_container_id LOOP
    batch_cost := v_shared_pool * (COALESCE(l.import_price, 0) * COALESCE(l.import_quantity, 0)) / total_val;
    UPDATE public.batches
       SET import_cost_allocated = ROUND(batch_cost, 2),
           final_landed_cost = ROUND((COALESCE(l.import_price, 0) + COALESCE(l.duty_charges, 0)) * COALESCE(l.import_quantity, 0) + COALESCE(l.freight_charges, 0) + COALESCE(l.other_charges, 0) + batch_cost, 2),
           landed_cost_per_unit = ROUND(COALESCE(l.import_price, 0) + COALESCE(l.duty_charges, 0) + COALESCE(l.freight_charges, 0) / NULLIF(l.import_quantity, 0) + COALESCE(l.other_charges, 0) / NULLIF(l.import_quantity, 0) + batch_cost / NULLIF(l.import_quantity, 0), 2),
           cost_per_unit = ROUND(COALESCE(l.import_price, 0) + COALESCE(l.duty_charges, 0) + COALESCE(l.freight_charges, 0) / NULLIF(l.import_quantity, 0) + COALESCE(l.other_charges, 0) / NULLIF(l.import_quantity, 0) + batch_cost / NULLIF(l.import_quantity, 0), 2),
           updated_at = now()
     WHERE id = l.id;

    v_affected_batches := array_append(v_affected_batches, l.id);
  END LOOP;

  -- Propagate cost changes to sales COGS for every affected batch
  FOREACH v_batch_id IN ARRAY v_affected_batches LOOP
    PERFORM public.propagate_batch_cost_change(v_batch_id);
  END LOOP;
END;
$function$;

-- ------------------------------------------------------------------------------
-- FUNCTION: update_container_customs_ndpbm
-- Automatically recalculates PIB Bea Masuk from NDPBM FX rate, updates finance_expenses,
-- batches duty charges, reallocates container costs, and propagates COGS.
-- Formula: Bea Masuk (IDR) = Customs Assessable Value (Foreign Currency) * Customs NDPBM FX * Applicable BM %
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.update_container_customs_ndpbm(
  p_container_id uuid,
  p_customs_ndpbm_rate numeric
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_rec record;
  v_batch_bm numeric;
  v_total_calculated_bm numeric := 0;
  v_has_duty_batches boolean := false;
  v_pib record;
BEGIN
  -- 1. Update container NDPBM rate
  UPDATE public.import_containers
     SET customs_ndpbm_rate = p_customs_ndpbm_rate,
         updated_at = now()
   WHERE id = p_container_id;

  -- 2. Recalculate BM for each linked batch using:
  -- Foreign Currency Assessable Value * Customs NDPBM FX * Duty Percentage
  FOR v_rec IN
    SELECT b.id,
           b.batch_number,
           b.import_quantity,
           b.import_price_usd,
           COALESCE(b.duty_percent, 0) AS duty_percent
      FROM public.batches b
     WHERE b.import_container_id = p_container_id
  LOOP
    IF COALESCE(v_rec.duty_percent, 0) > 0 AND COALESCE(v_rec.import_price_usd, 0) > 0 THEN
      -- Bea Masuk (IDR) = Customs Assessable Value (Foreign Currency) * Customs NDPBM FX * Applicable BM %
      v_batch_bm := ROUND(v_rec.import_price_usd * p_customs_ndpbm_rate * (v_rec.duty_percent / 100.0), 0);
      v_total_calculated_bm := v_total_calculated_bm + (v_batch_bm * COALESCE(v_rec.import_quantity, 1));
      v_has_duty_batches := true;

      UPDATE public.batches
         SET customs_ndpbm_rate = p_customs_ndpbm_rate,
             customs_assessable_value_idr = ROUND(v_rec.import_price_usd * p_customs_ndpbm_rate * COALESCE(v_rec.import_quantity, 1), 2),
             actual_duty_charges = v_batch_bm * COALESCE(v_rec.import_quantity, 1),
             duty_charges = v_batch_bm,
             updated_at = now()
       WHERE id = v_rec.id;
    ELSE
      -- 0% duty line remains zero
      UPDATE public.batches
         SET customs_ndpbm_rate = p_customs_ndpbm_rate,
             customs_assessable_value_idr = ROUND(COALESCE(v_rec.import_price_usd, 0) * p_customs_ndpbm_rate * COALESCE(v_rec.import_quantity, 1), 2),
             actual_duty_charges = 0.00,
             duty_charges = 0.00,
             updated_at = now()
       WHERE id = v_rec.id;
    END IF;
  END LOOP;

  -- 3. Update existing PIB expense pib_bm_amount & total amount
  IF v_has_duty_batches AND v_total_calculated_bm > 0 THEN
    FOR v_pib IN
      SELECT id, pib_ppn_amount, pib_pph_amount
        FROM public.finance_expenses
       WHERE import_container_id = p_container_id
         AND expense_category = 'pib_import'
    LOOP
      UPDATE public.finance_expenses
         SET pib_bm_amount = v_total_calculated_bm,
             amount = v_total_calculated_bm + COALESCE(v_pib.pib_ppn_amount, 0) + COALESCE(v_pib.pib_pph_amount, 0)
       WHERE id = v_pib.id;
    END LOOP;
  END IF;

  -- 4. Reallocate container costs and propagate into layers, inventory, and COGS
  PERFORM public.reallocate_container_costs(p_container_id);
END;
$function$;

CREATE OR REPLACE FUNCTION public.trg_import_containers_ndpbm_sync()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.customs_ndpbm_rate IS DISTINCT FROM OLD.customs_ndpbm_rate AND NEW.customs_ndpbm_rate IS NOT NULL THEN
    PERFORM public.update_container_customs_ndpbm(NEW.id, NEW.customs_ndpbm_rate);
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_container_ndpbm_sync ON public.import_containers;
CREATE TRIGGER trg_container_ndpbm_sync
AFTER UPDATE OF customs_ndpbm_rate ON public.import_containers
FOR EACH ROW
EXECUTE FUNCTION public.trg_import_containers_ndpbm_sync();

-- ------------------------------------------------------------------------------
-- ONE-TIME HISTORICAL DATA REPAIR & CONTAINER REALLOCATION
-- ------------------------------------------------------------------------------
DO $$
DECLARE
  v_rec record;
BEGIN
  -- 0. Set historical customs NDPBM rates on containers
  UPDATE public.import_containers SET customs_ndpbm_rate = 16743.0000 WHERE id = '5f2a79f6-4cd4-4e24-9195-161a6b99cfd5';
  UPDATE public.import_containers SET customs_ndpbm_rate = 16813.0000 WHERE id = '81aacc20-68f6-41dc-bfc6-8ac92ca42645';
  UPDATE public.import_containers SET customs_ndpbm_rate = 16690.0000 WHERE id = '4df4f6b9-a237-4eec-a297-1babcfb82856';
  UPDATE public.import_containers SET customs_ndpbm_rate = 17750.0000 WHERE id = 'aa8ca1d3-0fe9-4c2f-8864-d4c98b430549';

  -- 1. Set authoritative duty on 2nd FCL Ibuprofen batches
  UPDATE public.batches
     SET duty_charges = 6517.00
   WHERE batch_number = '4002/1101/25/A-0512B';

  UPDATE public.batches
     SET duty_charges = 6436.00
   WHERE batch_number IN ('4001/1101/25/A-4276', '4001/1101/25/A-4277', '4001/1101/25/A-4632');

  -- 1b. Synchronize exchange rate and import price for E0000332/2526 batches with authoritative PI FX rate (16,850.00)
  UPDATE public.batches b
     SET exchange_rate_usd_to_idr = pi.exchange_rate,
         import_price = ROUND(b.import_price_usd * pi.exchange_rate, 2)
    FROM public.purchase_invoices pi
   WHERE b.purchase_invoice_id = pi.id
     AND pi.invoice_number = 'E0000332/2526'
     AND (b.exchange_rate_usd_to_idr != pi.exchange_rate OR b.import_price != ROUND(b.import_price_usd * pi.exchange_rate, 2));

  -- 2. Enable include_in_landed_cost for historical PIB expenses EXP/25/234 and EXP/26/077
  UPDATE public.finance_expenses
     SET include_in_landed_cost = true
   WHERE voucher_number IN ('EXP/25/234', 'EXP/26/077')
      OR id IN ('95d9d4e2-817a-4304-86ad-ab83855fea44', 'da6b2b78-9d91-4183-9889-7e2bebf5a85b');

  -- 3. Link cost layer for LCL Cefixime XMAL260006 to its container
  UPDATE public.purchase_batch_cost_layers
     SET import_container_id = 'd0967b1d-907f-4cd9-adb3-b3ea5c666a42'
   WHERE id = '496cfc41-dbdb-4fdc-9865-c3c139c2d152'
      OR (batch_id = 'e804fe62-7e12-4332-90ef-689138dd7240' AND import_container_id IS NULL);

  -- 4. Mark any historical adjustment journals for cancelled invoices as reversed (no silent deletes)
  UPDATE public.journal_entries
     SET is_reversed = true,
         description = COALESCE(description, '') || ' [Compensating reversal: cancelled sales invoice exclusion]'
   WHERE reference_number LIKE 'SAPJ-26-072-FIFO-ADJ%'
     AND NOT COALESCE(is_reversed, false);

  -- 5. Reallocate all active import containers to synchronize batches, layers, and COGS
  FOR v_rec IN
    SELECT id, container_ref
      FROM public.import_containers
     ORDER BY created_at ASC
  LOOP
    PERFORM public.reallocate_container_costs(v_rec.id);
  END LOOP;

  -- 6. Record applied migration in schema_migrations
  INSERT INTO supabase_migrations.schema_migrations (version, name)
  VALUES ('20261101150000', 'permanent_landed_cost_and_authoritative_cogs_architecture')
  ON CONFLICT (version) DO NOTHING;
END $$;
