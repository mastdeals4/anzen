-- Migration: 20260921130000_dynamic_landed_cost_and_cogs_engine.sql
-- Description: Dynamic landed cost and sales COGS recalculation engine for SAPJ.
--              Automatically recalculates batch landed costs and propagates deltas to sales COGS
--              whenever import expenses are created, edited, deleted, approved, or reclassified.

BEGIN;

-- 1. Helper to calculate container landed cost pool (filtering out cancelled/rejected expenses)
CREATE OR REPLACE FUNCTION public.calculate_container_landed_cost_pool(p_container_id uuid)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_expenses numeric := 0;
  v_petty numeric := 0;
  v_other numeric := 0;
BEGIN
  SELECT COALESCE(other_import_costs, 0) INTO v_other
    FROM public.import_containers
   WHERE id = p_container_id;

  SELECT COALESCE(SUM(CASE
    WHEN fe.expense_category = 'import_broker' THEN
      fe.amount - COALESCE(fe.ppn_amount, 0)
      + COALESCE((SELECT SUM(
        CASE WHEN (x->>'invoice_amount_authoritative')::boolean = true THEN (x->>'amount')::numeric
             ELSE COALESCE(NULLIF((x->>'amount')::numeric, 0), (x->>'dpp_amount')::numeric + COALESCE((x->>'ppn_amount')::numeric, 0)) END
        - COALESCE((x->>'ppn_amount')::numeric, 0)) FROM jsonb_array_elements(fe.broker_items) x), 0)
      + COALESCE(fe.stamp_duty_amount, 0)
    ELSE fe.amount END), 0)
    INTO v_expenses
    FROM public.finance_expenses fe
   WHERE fe.import_container_id = p_container_id
     AND public.is_capitalizable_landed_cost_category(fe.expense_category)
     AND COALESCE(fe.include_in_landed_cost, true) = true
     AND COALESCE(fe.approval_status, 'approved') NOT IN ('cancelled', 'rejected');

  SELECT COALESCE(SUM(amount), 0) INTO v_petty
    FROM public.petty_cash_transactions
   WHERE import_container_id = p_container_id
     AND public.is_capitalizable_landed_cost_category(expense_category)
     AND COALESCE(include_in_landed_cost, true) = true
     AND COALESCE(approval_status, 'approved') NOT IN ('cancelled', 'rejected');

  RETURN v_expenses + v_petty + v_other;
END;
$$;

-- 2. Helper to calculate direct landed cost linked to a specific batch
CREATE OR REPLACE FUNCTION public.calculate_batch_direct_landed_cost(p_batch_id uuid)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(SUM(CASE
    WHEN fe.expense_category = 'import_broker' THEN
      fe.amount - COALESCE(fe.ppn_amount, 0)
      + COALESCE((SELECT SUM(
        CASE WHEN (x->>'invoice_amount_authoritative')::boolean = true THEN (x->>'amount')::numeric
             ELSE COALESCE(NULLIF((x->>'amount')::numeric, 0), (x->>'dpp_amount')::numeric + COALESCE((x->>'ppn_amount')::numeric, 0)) END
        - COALESCE((x->>'ppn_amount')::numeric, 0)) FROM jsonb_array_elements(fe.broker_items) x), 0)
      + COALESCE(fe.stamp_duty_amount, 0)
    ELSE fe.amount END), 0)
  FROM public.finance_expenses fe
  WHERE fe.batch_id = p_batch_id
    AND public.is_capitalizable_landed_cost_category(fe.expense_category)
    AND COALESCE(fe.include_in_landed_cost, true) = true
    AND COALESCE(fe.approval_status, 'approved') NOT IN ('cancelled', 'rejected');
$$;

-- 3. Enhanced Core procedure to revalue sales COGS when a batch cost changes
CREATE OR REPLACE FUNCTION public.propagate_batch_cost_change(p_batch_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_batch public.batches%ROWTYPE;
  v_new_unit_cost numeric;
  v_inv record;
  v_item record;
  v_target_item_cogs numeric;
  v_target_total numeric;
  v_posted_gl numeric;
  v_inv_delta numeric;
  v_item_delta numeric;
  v_running_delta numeric;
  v_item_count integer;
  v_item_idx integer;
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

  v_new_unit_cost := public.calculate_batch_authoritative_cost(v_batch);
  IF v_new_unit_cost IS NULL OR v_new_unit_cost <= 0 THEN
    PERFORM set_config('app.in_cogs_propagation', 'off', true);
    RETURN jsonb_build_object('success', true, 'message', 'Batch has zero or uncosted basis; skipping propagation');
  END IF;

  SELECT id INTO v_cogs_account_id FROM public.chart_of_accounts WHERE code = '5100' LIMIT 1;
  SELECT id INTO v_inventory_account_id FROM public.chart_of_accounts WHERE code = '1130' LIMIT 1;
  IF v_cogs_account_id IS NULL OR v_inventory_account_id IS NULL THEN
    PERFORM set_config('app.in_cogs_propagation', 'off', true);
    RAISE EXCEPTION 'Missing COGS (5100) or Inventory (1130) account in chart_of_accounts';
  END IF;

  -- Iterate through each posted sales invoice containing items from this batch
  FOR v_inv IN
    SELECT DISTINCT si.id, si.invoice_number, si.invoice_date, si.customer_id, si.created_by
      FROM public.sales_invoices si
      JOIN public.sales_invoice_items sii ON sii.invoice_id = si.id
     WHERE sii.batch_id = p_batch_id
       AND NOT COALESCE(si.is_draft, false)
     ORDER BY si.invoice_date ASC, si.id ASC
  LOOP
    -- Calculate invoice target COGS across all lines
    SELECT COALESCE(SUM(sii_all.quantity * public.calculate_batch_authoritative_cost(b_all)), 0),
           COUNT(sii_all.id)
      INTO v_target_total, v_item_count
      FROM public.sales_invoice_items sii_all
      JOIN public.batches b_all ON b_all.id = sii_all.batch_id
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

      IF EXISTS (
        SELECT 1 FROM public.journal_entries
         WHERE source_module IN ('sales_invoice_cogs', 'historical_cogs_entry', 'sales_invoice_cogs_adjustment')
           AND reference_id = v_inv.id
           AND is_posted = true
           AND NOT COALESCE(is_reversed, false)
      ) THEN
        v_source_module := 'sales_invoice_cogs_adjustment';
        v_description := 'COGS True-Up: ' || v_inv.invoice_number || ' (Batch ' || v_batch.batch_number || ' cost update)';
        v_base_ref_num := v_inv.invoice_number || '-ADJ-' || v_batch.batch_number;
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
      ELSE
        v_source_module := 'sales_invoice_cogs';
        v_description := 'COGS for Sales Invoice: ' || v_inv.invoice_number;
        v_ref_num := v_inv.invoice_number;
      END IF;

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
      v_running_delta := 0;
      v_item_idx := 0;

      FOR v_item IN
        SELECT sii.id, sii.quantity, sii.batch_id,
               ROUND(sii.quantity * public.calculate_batch_authoritative_cost(b), 2) as item_target_cogs
          FROM public.sales_invoice_items sii
          JOIN public.batches b ON b.id = sii.batch_id
         WHERE sii.invoice_id = v_inv.id
         ORDER BY sii.id
      LOOP
        v_item_idx := v_item_idx + 1;
        IF v_item_idx = v_item_count THEN
          v_item_delta := v_inv_delta - v_running_delta;
        ELSE
          IF v_target_total > 0 THEN
            v_item_delta := ROUND(v_inv_delta * (v_item.item_target_cogs / v_target_total), 2);
          ELSE
            v_item_delta := ROUND(v_inv_delta / v_item_count, 2);
          END IF;
          v_running_delta := v_running_delta + v_item_delta;
        END IF;

        IF ABS(v_item_delta) >= 0.01 THEN
          IF v_item_delta > 0 THEN
            -- Increase COGS: Debit 5100 COGS, Credit 1130 Inventory
            INSERT INTO public.journal_entry_lines (
              journal_entry_id, line_number, account_id, description, debit, credit,
              customer_id, batch_id, sales_invoice_item_id
            ) VALUES (
              v_je_id, v_line_number, v_cogs_account_id,
              'COGS adjustment - ' || v_inv.invoice_number, v_item_delta, 0,
              v_inv.customer_id, v_item.batch_id, v_item.id
            );
            v_line_number := v_line_number + 1;

            INSERT INTO public.journal_entry_lines (
              journal_entry_id, line_number, account_id, description, debit, credit,
              customer_id, batch_id, sales_invoice_item_id
            ) VALUES (
              v_je_id, v_line_number, v_inventory_account_id,
              'Inventory revaluation - ' || v_inv.invoice_number, 0, v_item_delta,
              v_inv.customer_id, v_item.batch_id, v_item.id
            );
            v_line_number := v_line_number + 1;
          ELSE
            -- Downward adjustment: Debit 1130 Inventory, Credit 5100 COGS
            INSERT INTO public.journal_entry_lines (
              journal_entry_id, line_number, account_id, description, debit, credit,
              customer_id, batch_id, sales_invoice_item_id
            ) VALUES (
              v_je_id, v_line_number, v_inventory_account_id,
              'Inventory revaluation (downward) - ' || v_inv.invoice_number, ABS(v_item_delta), 0,
              v_inv.customer_id, v_item.batch_id, v_item.id
            );
            v_line_number := v_line_number + 1;

            INSERT INTO public.journal_entry_lines (
              journal_entry_id, line_number, account_id, description, debit, credit,
              customer_id, batch_id, sales_invoice_item_id
            ) VALUES (
              v_je_id, v_line_number, v_cogs_account_id,
              'COGS adjustment (downward) - ' || v_inv.invoice_number, 0, ABS(v_item_delta),
              v_inv.customer_id, v_item.batch_id, v_item.id
            );
            v_line_number := v_line_number + 1;
          END IF;

          v_adjusted_items_count := v_adjusted_items_count + 1;
        END IF;
      END LOOP;

      v_adjusted_invoices_count := v_adjusted_invoices_count + 1;
      v_total_delta_posted := v_total_delta_posted + v_inv_delta;
    END IF;

    -- Synchronize sales_invoice_items snapshot fields for this batch
    FOR v_item IN
      SELECT sii.id, sii.quantity
        FROM public.sales_invoice_items sii
       WHERE sii.invoice_id = v_inv.id
         AND sii.batch_id = p_batch_id
    LOOP
      v_target_item_cogs := ROUND(COALESCE(v_item.quantity, 0) * v_new_unit_cost, 2);
      UPDATE public.sales_invoice_items
         SET cogs_unit_cost = v_new_unit_cost,
             cogs_total_cost = v_target_item_cogs
       WHERE id = v_item.id;
    END LOOP;

  END LOOP;

  PERFORM set_config('app.in_cogs_propagation', 'off', true);

  RETURN jsonb_build_object(
    'success', true,
    'batch_id', p_batch_id,
    'batch_number', v_batch.batch_number,
    'new_unit_cost', v_new_unit_cost,
    'adjusted_invoices_count', v_adjusted_invoices_count,
    'adjusted_items_count', v_adjusted_items_count,
    'total_delta_posted', v_total_delta_posted
  );
END;
$$;

-- 4. Reallocate container costs and trigger propagation across all affected batches
CREATE OR REPLACE FUNCTION public.reallocate_container_costs(p_container_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  pool numeric := public.calculate_container_landed_cost_pool(p_container_id);
  total_qty numeric;
  total_val numeric;
  l record;
  v_batch_id uuid;
  batch_cost numeric;
  v_affected_batches uuid[] := ARRAY[]::uuid[];
BEGIN
  -- Branch 1: Purchase cost layers exist for this container
  SELECT COALESCE(SUM(quantity), 0) INTO total_qty
    FROM public.purchase_batch_cost_layers
   WHERE import_container_id = p_container_id;

  IF total_qty > 0 THEN
    FOR l IN SELECT * FROM public.purchase_batch_cost_layers
      WHERE import_container_id = p_container_id ORDER BY created_at, id FOR UPDATE LOOP
      UPDATE public.purchase_batch_cost_layers
         SET landed_cost_amount = ROUND(pool * l.quantity / total_qty, 2),
             final_functional_unit_cost = ROUND(l.functional_unit_cost + pool * l.quantity / total_qty / l.quantity, 2)
       WHERE id = l.id;
    END LOOP;

    FOR v_batch_id IN SELECT DISTINCT pbl.batch_id FROM public.purchase_batch_cost_layers pbl
      WHERE import_container_id = p_container_id LOOP
      SELECT COALESCE(SUM(quantity * final_functional_unit_cost) / NULLIF(SUM(quantity), 0), 0)
        INTO batch_cost
        FROM public.purchase_batch_cost_layers pbl WHERE pbl.batch_id = v_batch_id;

      UPDATE public.batches
         SET cost_per_unit = ROUND(batch_cost, 2),
             landed_cost_per_unit = ROUND(batch_cost, 2),
             updated_at = now()
       WHERE id = v_batch_id AND COALESCE(cost_locked, false) = false;

      v_affected_batches := array_append(v_affected_batches, v_batch_id);
    END LOOP;

    -- Propagate cost changes to sales COGS for every affected batch
    FOREACH v_batch_id IN ARRAY v_affected_batches LOOP
      PERFORM public.propagate_batch_cost_change(v_batch_id);
    END LOOP;

    RETURN;
  END IF;

  -- Branch 2: Value-weighted allocation across linked batches
  SELECT COALESCE(SUM(COALESCE(import_price, 0) * COALESCE(import_quantity, 0)), 0)
    INTO total_val
    FROM public.batches
   WHERE import_container_id = p_container_id;

  IF total_val <= 0 THEN RETURN; END IF;

  FOR l IN SELECT id, import_price, import_quantity, duty_charges, freight_charges, other_charges
    FROM public.batches WHERE import_container_id = p_container_id AND COALESCE(cost_locked, false) = false LOOP
    batch_cost := pool * (COALESCE(l.import_price, 0) * COALESCE(l.import_quantity, 0)) / total_val;
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
$$;

-- 5. Helper to recalculate a specific batch (with container reallocation or direct expenses)
CREATE OR REPLACE FUNCTION public.recalculate_batch_landed_cost(p_batch_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_container_id uuid;
  v_direct_cost numeric;
  v_b record;
BEGIN
  SELECT * INTO v_b FROM public.batches WHERE id = p_batch_id;
  IF NOT FOUND THEN RETURN; END IF;

  IF v_b.import_container_id IS NOT NULL THEN
    PERFORM public.reallocate_container_costs(v_b.import_container_id);
  ELSE
    -- Standalone batch with direct expense link
    v_direct_cost := public.calculate_batch_direct_landed_cost(p_batch_id);
    IF v_direct_cost > 0 AND COALESCE(v_b.cost_locked, false) = false THEN
      UPDATE public.batches
         SET import_cost_allocated = ROUND(v_direct_cost, 2),
             final_landed_cost = ROUND((COALESCE(v_b.import_price, 0) + COALESCE(v_b.duty_charges, 0)) * COALESCE(v_b.import_quantity, 0) + COALESCE(v_b.freight_charges, 0) + COALESCE(v_b.other_charges, 0) + v_direct_cost, 2),
             landed_cost_per_unit = ROUND(COALESCE(v_b.import_price, 0) + COALESCE(v_b.duty_charges, 0) + COALESCE(v_b.freight_charges, 0) / NULLIF(v_b.import_quantity, 0) + COALESCE(v_b.other_charges, 0) / NULLIF(v_b.import_quantity, 0) + v_direct_cost / NULLIF(v_b.import_quantity, 0), 2),
             cost_per_unit = ROUND(COALESCE(v_b.import_price, 0) + COALESCE(v_b.duty_charges, 0) + COALESCE(v_b.freight_charges, 0) / NULLIF(v_b.import_quantity, 0) + COALESCE(v_b.other_charges, 0) / NULLIF(v_b.import_quantity, 0) + v_direct_cost / NULLIF(v_b.import_quantity, 0), 2),
             updated_at = now()
       WHERE id = p_batch_id;
    END IF;
    PERFORM public.propagate_batch_cost_change(p_batch_id);
  END IF;
END;
$$;

-- 6. Trigger on public.batches to propagate changes (allowing depth up to 3)
CREATE OR REPLACE FUNCTION public.trg_batches_propagate_cost_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_old_cost numeric;
  v_new_cost numeric;
BEGIN
  IF pg_trigger_depth() > 3 THEN
    RETURN NEW;
  END IF;

  IF current_setting('app.in_cogs_propagation', true) = 'on' THEN
    RETURN NEW;
  END IF;

  IF current_setting('app.finance_metadata_repair', true) = 'on' THEN
    RETURN NEW;
  END IF;

  v_old_cost := public.calculate_batch_authoritative_cost(OLD);
  v_new_cost := public.calculate_batch_authoritative_cost(NEW);

  IF v_old_cost IS DISTINCT FROM v_new_cost AND v_new_cost > 0 THEN
    PERFORM public.propagate_batch_cost_change(NEW.id);
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_batches_propagate_cost_change ON public.batches;
CREATE TRIGGER trg_batches_propagate_cost_change
AFTER UPDATE OF landed_cost_per_unit, cost_per_unit, import_price, final_landed_cost
ON public.batches
FOR EACH ROW
EXECUTE FUNCTION public.trg_batches_propagate_cost_change();

-- 7. Trigger on public.finance_expenses to react dynamically to any expense lifecycle event
CREATE OR REPLACE FUNCTION public.trigger_recalc_batches_on_expense_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_container_id uuid;
  v_batch_id uuid;
BEGIN
  IF current_setting('app.finance_metadata_repair', true) = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  v_container_id := COALESCE(NEW.import_container_id, OLD.import_container_id);
  v_batch_id := COALESCE(NEW.batch_id, OLD.batch_id);

  IF v_container_id IS NOT NULL THEN
    PERFORM public.reallocate_container_costs(v_container_id);
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.import_container_id IS NOT NULL
     AND NEW.import_container_id IS DISTINCT FROM OLD.import_container_id THEN
    PERFORM public.reallocate_container_costs(OLD.import_container_id);
  END IF;

  IF v_batch_id IS NOT NULL THEN
    PERFORM public.recalculate_batch_landed_cost(v_batch_id);
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.batch_id IS NOT NULL
     AND NEW.batch_id IS DISTINCT FROM OLD.batch_id THEN
    PERFORM public.recalculate_batch_landed_cost(OLD.batch_id);
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trigger_recalc_batches_on_expense ON public.finance_expenses;
CREATE TRIGGER trigger_recalc_batches_on_expense
AFTER INSERT OR UPDATE OF import_container_id, batch_id, include_in_landed_cost, amount, ppn_amount, stamp_duty_amount, broker_items, expense_category, approval_status
ON public.finance_expenses
FOR EACH ROW
EXECUTE FUNCTION public.trigger_recalc_batches_on_expense_change();

DROP TRIGGER IF EXISTS trigger_recalc_batches_on_expense_del ON public.finance_expenses;
CREATE TRIGGER trigger_recalc_batches_on_expense_del
AFTER DELETE ON public.finance_expenses
FOR EACH ROW
EXECUTE FUNCTION public.trigger_recalc_batches_on_expense_change();

-- 8. Trigger on public.petty_cash_transactions
CREATE OR REPLACE FUNCTION public.trigger_recalc_batches_on_petty_cash_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_container_id uuid;
BEGIN
  IF current_setting('app.finance_metadata_repair', true) = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  v_container_id := COALESCE(NEW.import_container_id, OLD.import_container_id);

  IF v_container_id IS NOT NULL THEN
    PERFORM public.reallocate_container_costs(v_container_id);
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.import_container_id IS NOT NULL
     AND NEW.import_container_id IS DISTINCT FROM OLD.import_container_id THEN
    PERFORM public.reallocate_container_costs(OLD.import_container_id);
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trigger_recalc_batches_on_petty_cash ON public.petty_cash_transactions;
CREATE TRIGGER trigger_recalc_batches_on_petty_cash
AFTER INSERT OR UPDATE OF import_container_id, include_in_landed_cost, amount, expense_category, approval_status
ON public.petty_cash_transactions
FOR EACH ROW
EXECUTE FUNCTION public.trigger_recalc_batches_on_petty_cash_change();

DROP TRIGGER IF EXISTS trigger_recalc_batches_on_petty_cash_del ON public.petty_cash_transactions;
CREATE TRIGGER trigger_recalc_batches_on_petty_cash_del
AFTER DELETE ON public.petty_cash_transactions
FOR EACH ROW
EXECUTE FUNCTION public.trigger_recalc_batches_on_petty_cash_change();

-- 9. Authoritative sales line COGS view resolver
CREATE OR REPLACE FUNCTION public.get_authoritative_sales_line_cogs(
  p_start_date date, p_end_date date
)
RETURNS TABLE (
  line_id uuid, invoice_id uuid, product_id uuid, batch_id uuid, quantity numeric,
  authoritative_cogs numeric, authoritative_unit_cogs numeric, resolution_tier text,
  invoice_line_count bigint, invoice_product_count bigint, posted_invoice_cogs numeric,
  base_line_cost numeric, reconciliation_difference numeric
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
WITH active_cogs AS (
  SELECT je.reference_id AS invoice_id, je.id AS journal_id,
         SUM(jel.debit - jel.credit) AS cogs_amount
  FROM public.journal_entries je
  JOIN public.journal_entry_lines jel ON jel.journal_entry_id = je.id
  JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
  WHERE je.is_posted = true
    AND NOT COALESCE(je.is_reversed, false)
    AND coa.code = '5100'
    AND je.reference_id IS NOT NULL
    AND (
      je.source_module IN ('sales_invoice_cogs', 'sales_invoice_cogs_adjustment')
      OR je.source_module IN ('historical_cogs_correction', 'historical_cogs_final_correction')
      OR je.source_module LIKE 'historical_cogs%'
      OR je.source_module LIKE '%cogs%'
    )
  GROUP BY je.reference_id, je.id
), posted_cogs AS (
  SELECT invoice_id, SUM(cogs_amount) AS posted_invoice_cogs
  FROM active_cogs GROUP BY invoice_id
), posted_item_cogs AS (
  SELECT jel.sales_invoice_item_id AS line_id,
         SUM(jel.debit - jel.credit) AS posted_item_cogs
  FROM public.journal_entries je
  JOIN public.journal_entry_lines jel ON jel.journal_entry_id = je.id
  JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
  WHERE je.is_posted = true AND NOT COALESCE(je.is_reversed, false)
    AND coa.code = '5100' AND jel.sales_invoice_item_id IS NOT NULL
    AND (
      je.source_module IN ('sales_invoice_cogs', 'sales_invoice_cogs_adjustment')
      OR je.source_module IN ('historical_cogs_correction', 'historical_cogs_final_correction')
      OR je.source_module LIKE 'historical_cogs%'
      OR je.source_module LIKE '%cogs%'
    )
  GROUP BY jel.sales_invoice_item_id
), line_basis AS (
  SELECT sii.id AS line_id, sii.invoice_id, sii.product_id, sii.batch_id,
         sii.quantity, pic.posted_item_cogs, sii.cogs_total_cost AS snapshot_cogs,
         CASE WHEN COALESCE(NULLIF(b.landed_cost_per_unit, 0), NULLIF(b.cost_per_unit, 0), NULLIF(b.import_price, 0)) IS NULL
              THEN NULL ELSE sii.quantity * COALESCE(NULLIF(b.landed_cost_per_unit, 0), NULLIF(b.cost_per_unit, 0), NULLIF(b.import_price, 0)) END AS base_line_cost,
         pc.posted_invoice_cogs
  FROM public.sales_invoice_items sii
  JOIN public.sales_invoices si ON si.id = sii.invoice_id
  LEFT JOIN public.batches b ON b.id = sii.batch_id
  LEFT JOIN posted_cogs pc ON pc.invoice_id = sii.invoice_id
  LEFT JOIN posted_item_cogs pic ON pic.line_id = sii.id
  WHERE si.invoice_date BETWEEN p_start_date AND p_end_date
    AND NOT COALESCE(si.is_draft, false)
), invoice_evidence AS (
  SELECT invoice_id, COUNT(*) AS invoice_line_count,
         COUNT(DISTINCT product_id) AS invoice_product_count,
         COUNT(*) FILTER (WHERE posted_item_cogs IS NULL AND snapshot_cogs IS NULL) AS unresolved_line_count,
         COUNT(*) FILTER (WHERE posted_item_cogs IS NULL AND snapshot_cogs IS NULL AND base_line_cost IS NOT NULL) AS unresolved_base_line_count,
         COALESCE(SUM(COALESCE(posted_item_cogs, snapshot_cogs)), 0) AS resolved_cogs_total,
         SUM(base_line_cost) FILTER (WHERE posted_item_cogs IS NULL AND snapshot_cogs IS NULL) AS unresolved_base_cost_total,
         MAX(posted_invoice_cogs) AS posted_invoice_cogs
  FROM line_basis GROUP BY invoice_id
), resolved AS (
  SELECT lb.*, ie.invoice_line_count, ie.invoice_product_count,
         ie.unresolved_line_count, ie.unresolved_base_line_count,
         ie.resolved_cogs_total, ie.unresolved_base_cost_total,
         ie.posted_invoice_cogs AS invoice_posted_cogs,
         ie.posted_invoice_cogs - ie.resolved_cogs_total AS residual_posted_cogs,
         ABS(ie.unresolved_base_cost_total - (ie.posted_invoice_cogs - ie.resolved_cogs_total)) AS reconciliation_difference
  FROM line_basis lb JOIN invoice_evidence ie ON ie.invoice_id = lb.invoice_id
)
SELECT r.line_id, r.invoice_id, r.product_id, r.batch_id, r.quantity,
  CASE
    WHEN r.posted_item_cogs IS NOT NULL THEN r.posted_item_cogs
    WHEN r.snapshot_cogs IS NOT NULL THEN r.snapshot_cogs
    WHEN r.invoice_line_count = 1 AND r.invoice_posted_cogs IS NOT NULL THEN r.invoice_posted_cogs
    WHEN r.invoice_line_count > 1 AND r.invoice_posted_cogs IS NOT NULL
      AND r.unresolved_line_count = r.unresolved_base_line_count
      AND r.unresolved_base_cost_total > 0
      THEN r.base_line_cost * (r.residual_posted_cogs / r.unresolved_base_cost_total)
    WHEN r.base_line_cost IS NOT NULL THEN r.base_line_cost
    ELSE NULL END AS authoritative_cogs,
  CASE
    WHEN r.quantity = 0 THEN NULL
    WHEN r.posted_item_cogs IS NOT NULL THEN r.posted_item_cogs / r.quantity
    WHEN r.snapshot_cogs IS NOT NULL THEN r.snapshot_cogs / r.quantity
    WHEN r.invoice_line_count = 1 AND r.invoice_posted_cogs IS NOT NULL THEN r.invoice_posted_cogs / r.quantity
    WHEN r.invoice_line_count > 1 AND r.invoice_posted_cogs IS NOT NULL
      AND r.unresolved_line_count = r.unresolved_base_line_count
      AND r.unresolved_base_cost_total > 0
      THEN (r.base_line_cost * (r.residual_posted_cogs / r.unresolved_base_cost_total)) / r.quantity
    WHEN r.base_line_cost IS NOT NULL THEN r.base_line_cost / r.quantity
    ELSE NULL END AS authoritative_unit_cogs,
  CASE
    WHEN r.posted_item_cogs IS NOT NULL THEN 'posted_item_cogs'
    WHEN r.snapshot_cogs IS NOT NULL THEN 'snapshot'
    WHEN r.invoice_line_count = 1 AND r.invoice_posted_cogs IS NOT NULL THEN 'single_line_posted_cogs'
    WHEN r.invoice_line_count > 1 AND r.invoice_product_count = 1 AND r.invoice_posted_cogs IS NOT NULL
      AND r.unresolved_line_count = r.unresolved_base_line_count AND r.unresolved_base_cost_total > 0 THEN 'single_product_proven_allocation'
    WHEN r.invoice_line_count > 1 AND r.invoice_product_count > 1 AND r.invoice_posted_cogs IS NOT NULL
      AND r.unresolved_line_count = r.unresolved_base_line_count AND r.unresolved_base_cost_total > 0 THEN 'multi_product_proven_allocation'
    WHEN r.base_line_cost IS NOT NULL THEN 'canonical_batch_cost'
    ELSE 'unresolved' END AS resolution_tier,
  r.invoice_line_count, r.invoice_product_count, r.invoice_posted_cogs,
  r.base_line_cost, r.reconciliation_difference
FROM resolved r;
$$;

-- 10. Canonical Safe Reconciliation Backfill Procedure
CREATE OR REPLACE FUNCTION public.reconcile_all_sales_cogs(
  p_start_date date DEFAULT '2025-11-29',
  p_end_date date DEFAULT CURRENT_DATE
)
RETURNS TABLE (
  total_invoices integer,
  total_items integer,
  snapshots_updated integer,
  delta_journals_created integer,
  total_delta_posted numeric
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_batch_id uuid;
  v_res jsonb;
  v_tot_inv integer := 0;
  v_tot_items integer := 0;
  v_snap_updated integer := 0;
  v_je_created integer := 0;
  v_delta_posted numeric := 0;
BEGIN
  -- Count total non-draft sales invoices and items in scope
  SELECT COUNT(DISTINCT si.id), COUNT(sii.id)
    INTO v_tot_inv, v_tot_items
    FROM public.sales_invoices si
    JOIN public.sales_invoice_items sii ON sii.invoice_id = si.id
   WHERE NOT COALESCE(si.is_draft, false)
     AND si.invoice_date BETWEEN p_start_date AND p_end_date;

  DECLARE
    v_cont record;
  BEGIN
    -- Reallocate all import containers first to ensure canonical batch costs
    FOR v_cont IN
      SELECT id FROM public.import_containers
    LOOP
      PERFORM public.reallocate_container_costs(v_cont.id);
    END LOOP;
  END;

  -- Propagate cost changes for every batch sold in the period
  FOR v_batch_id IN
    SELECT DISTINCT sii.batch_id
      FROM public.sales_invoice_items sii
      JOIN public.sales_invoices si ON si.id = sii.invoice_id
     WHERE NOT COALESCE(si.is_draft, false)
       AND si.invoice_date BETWEEN p_start_date AND p_end_date
       AND sii.batch_id IS NOT NULL
  LOOP
    v_res := public.propagate_batch_cost_change(v_batch_id);
    v_je_created := v_je_created + COALESCE((v_res->>'adjusted_invoices_count')::integer, 0);
    v_snap_updated := v_snap_updated + COALESCE((v_res->>'adjusted_items_count')::integer, 0);
    v_delta_posted := v_delta_posted + COALESCE((v_res->>'total_delta_posted')::numeric, 0);
  END LOOP;

  -- Return final summary
  RETURN QUERY SELECT v_tot_inv, v_tot_items, v_snap_updated, v_je_created, v_delta_posted;
END;
$$;

GRANT EXECUTE ON FUNCTION public.calculate_container_landed_cost_pool(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.calculate_batch_direct_landed_cost(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.propagate_batch_cost_change(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reallocate_container_costs(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.recalculate_batch_landed_cost(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_authoritative_sales_line_cogs(date, date) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reconcile_all_sales_cogs(date, date) TO authenticated, service_role;

COMMIT;
