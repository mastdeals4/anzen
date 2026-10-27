-- Migration: 20260909163000_propagate_batch_cost_to_sales_cogs.sql
-- Description: Automated propagation of batch authoritative cost changes to sales COGS,
--              creating controlled revaluation true-up journals and updating snapshots.

BEGIN;

-- 1. Helper to resolve the authoritative unit cost of a batch
CREATE OR REPLACE FUNCTION public.calculate_batch_authoritative_cost(p_batch public.batches)
RETURNS numeric
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT COALESCE(
    NULLIF(p_batch.landed_cost_per_unit, 0),
    NULLIF(p_batch.cost_per_unit, 0),
    NULLIF(p_batch.import_price, 0),
    0
  );
$$;

CREATE OR REPLACE FUNCTION public.get_batch_authoritative_unit_cost(p_batch_id uuid)
RETURNS numeric
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT COALESCE(
    NULLIF(b.landed_cost_per_unit, 0),
    NULLIF(b.cost_per_unit, 0),
    NULLIF(b.import_price, 0),
    0
  )
  FROM public.batches b
  WHERE b.id = p_batch_id;
$$;

-- 2. Core procedure to revalue sales COGS when a batch cost changes
CREATE OR REPLACE FUNCTION public.propagate_batch_cost_change(p_batch_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_batch public.batches%ROWTYPE;
  v_new_unit_cost numeric;
  v_cogs_account_id uuid;
  v_inventory_account_id uuid;
  v_inv record;
  v_item record;
  v_already_posted_item_cogs numeric;
  v_target_item_cogs numeric;
  v_item_delta numeric;
  v_invoice_total_delta numeric;
  v_entry_date date;
  v_period_status text;
  v_period_id uuid;
  v_je_id uuid;
  v_je_number text;
  v_source_module text;
  v_description text;
  v_line_number integer;
  v_adjusted_invoices_count integer := 0;
  v_adjusted_items_count integer := 0;
  v_total_delta_posted numeric := 0;
BEGIN
  SELECT * INTO v_batch FROM public.batches WHERE id = p_batch_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Batch not found');
  END IF;

  v_new_unit_cost := public.calculate_batch_authoritative_cost(v_batch);
  IF v_new_unit_cost <= 0 THEN
    RETURN jsonb_build_object('success', true, 'message', 'Batch has zero or uncosted basis; skipping propagation');
  END IF;

  SELECT id INTO v_cogs_account_id FROM public.chart_of_accounts WHERE code = '5100' LIMIT 1;
  SELECT id INTO v_inventory_account_id FROM public.chart_of_accounts WHERE code = '1130' LIMIT 1;
  IF v_cogs_account_id IS NULL OR v_inventory_account_id IS NULL THEN
    RAISE EXCEPTION 'Missing COGS (5100) or Inventory (1130) account in chart_of_accounts';
  END IF;

  -- Iterate through each posted sales invoice containing items from this batch
  FOR v_inv IN
    SELECT DISTINCT si.id, si.invoice_number, si.invoice_date, si.customer_id, si.created_by
      FROM public.sales_invoices si
      JOIN public.sales_invoice_items sii ON sii.invoice_id = si.id
     WHERE sii.batch_id = p_batch_id
       AND NOT COALESCE(si.is_draft, false)
       AND si.journal_entry_id IS NOT NULL
     ORDER BY si.invoice_date ASC, si.id ASC
  LOOP
    v_invoice_total_delta := 0;

    -- First pass: calculate total delta for items of this batch on this invoice
    FOR v_item IN
      SELECT sii.id, sii.quantity, sii.cogs_total_cost
        FROM public.sales_invoice_items sii
       WHERE sii.invoice_id = v_inv.id
         AND sii.batch_id = p_batch_id
       ORDER BY sii.id
    LOOP
      v_target_item_cogs := ROUND(COALESCE(v_item.quantity, 0) * v_new_unit_cost, 2);

      -- Check cumulative posted 5100 GL lines for this specific line item
      SELECT COALESCE(SUM(jel.debit - jel.credit), 0)
        INTO v_already_posted_item_cogs
        FROM public.journal_entries je
        JOIN public.journal_entry_lines jel ON jel.journal_entry_id = je.id
        JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
       WHERE jel.sales_invoice_item_id = v_item.id
         AND coa.code = '5100'
         AND je.is_posted = true
         AND NOT COALESCE(je.is_reversed, false);

      -- Fallback to item snapshot if no attributed GL lines exist yet
      IF v_already_posted_item_cogs = 0 AND COALESCE(v_item.cogs_total_cost, 0) > 0 THEN
        v_already_posted_item_cogs := v_item.cogs_total_cost;
      END IF;

      v_item_delta := v_target_item_cogs - v_already_posted_item_cogs;
      IF ABS(v_item_delta) >= 0.01 THEN
        v_invoice_total_delta := v_invoice_total_delta + v_item_delta;
      END IF;
    END LOOP;

    -- If this invoice needs a COGS adjustment, post the controlled revaluation entry
    IF ABS(v_invoice_total_delta) >= 0.01 THEN
      -- Respect accounting period lock:
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

      -- Check if an initial COGS entry already exists
      IF EXISTS (
        SELECT 1 FROM public.journal_entries
         WHERE source_module = 'sales_invoice_cogs'
           AND reference_id = v_inv.id
           AND is_posted = true
           AND NOT COALESCE(is_reversed, false)
      ) THEN
        v_source_module := 'sales_invoice_cogs_adjustment';
        v_description := 'COGS True-Up: ' || v_inv.invoice_number || ' (Batch ' || v_batch.batch_number || ' cost update)';
      ELSE
        v_source_module := 'sales_invoice_cogs';
        v_description := 'COGS for Sales Invoice: ' || v_inv.invoice_number;
      END IF;

      v_je_number := public.next_journal_entry_number();

      INSERT INTO public.journal_entries (
        entry_number, entry_date, period_id, source_module, reference_id, reference_number,
        description, total_debit, total_credit, is_posted, posted_by, created_by
      ) VALUES (
        v_je_number, v_entry_date, v_period_id, v_source_module, v_inv.id, v_inv.invoice_number,
        v_description, ABS(v_invoice_total_delta), ABS(v_invoice_total_delta),
        true, COALESCE(auth.uid(), v_inv.created_by), COALESCE(auth.uid(), v_inv.created_by)
      ) RETURNING id INTO v_je_id;

      v_line_number := 1;

      -- Second pass: insert balanced attributed journal lines and update item snapshots
      FOR v_item IN
        SELECT sii.id, sii.quantity, sii.cogs_total_cost
          FROM public.sales_invoice_items sii
         WHERE sii.invoice_id = v_inv.id
           AND sii.batch_id = p_batch_id
         ORDER BY sii.id
      LOOP
        v_target_item_cogs := ROUND(COALESCE(v_item.quantity, 0) * v_new_unit_cost, 2);

        SELECT COALESCE(SUM(jel.debit - jel.credit), 0)
          INTO v_already_posted_item_cogs
          FROM public.journal_entries je
          JOIN public.journal_entry_lines jel ON jel.journal_entry_id = je.id
          JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
         WHERE jel.sales_invoice_item_id = v_item.id
           AND coa.code = '5100'
           AND je.is_posted = true
           AND NOT COALESCE(je.is_reversed, false);

        IF v_already_posted_item_cogs = 0 AND COALESCE(v_item.cogs_total_cost, 0) > 0 THEN
          v_already_posted_item_cogs := v_item.cogs_total_cost;
        END IF;

        v_item_delta := v_target_item_cogs - v_already_posted_item_cogs;

        IF ABS(v_item_delta) >= 0.01 THEN
          -- Update item snapshot to authoritative cost
          UPDATE public.sales_invoice_items
             SET cogs_unit_cost = v_new_unit_cost,
                 cogs_total_cost = v_target_item_cogs
           WHERE id = v_item.id;

          IF v_item_delta > 0 THEN
            -- Debit 5100 COGS, Credit 1130 Inventory
            INSERT INTO public.journal_entry_lines (
              journal_entry_id, line_number, account_id, description, debit, credit,
              customer_id, batch_id, sales_invoice_item_id
            ) VALUES (
              v_je_id, v_line_number, v_cogs_account_id,
              'COGS adjustment - ' || v_inv.invoice_number, v_item_delta, 0,
              v_inv.customer_id, p_batch_id, v_item.id
            );
            v_line_number := v_line_number + 1;

            INSERT INTO public.journal_entry_lines (
              journal_entry_id, line_number, account_id, description, debit, credit,
              customer_id, batch_id, sales_invoice_item_id
            ) VALUES (
              v_je_id, v_line_number, v_inventory_account_id,
              'Inventory revaluation - ' || v_inv.invoice_number, 0, v_item_delta,
              v_inv.customer_id, p_batch_id, v_item.id
            );
            v_line_number := v_line_number + 1;
          ELSE
            -- Reverse for negative delta: Debit 1130 Inventory, Credit 5100 COGS
            INSERT INTO public.journal_entry_lines (
              journal_entry_id, line_number, account_id, description, debit, credit,
              customer_id, batch_id, sales_invoice_item_id
            ) VALUES (
              v_je_id, v_line_number, v_inventory_account_id,
              'Inventory revaluation (downward) - ' || v_inv.invoice_number, ABS(v_item_delta), 0,
              v_inv.customer_id, p_batch_id, v_item.id
            );
            v_line_number := v_line_number + 1;

            INSERT INTO public.journal_entry_lines (
              journal_entry_id, line_number, account_id, description, debit, credit,
              customer_id, batch_id, sales_invoice_item_id
            ) VALUES (
              v_je_id, v_line_number, v_cogs_account_id,
              'COGS adjustment (downward) - ' || v_inv.invoice_number, 0, ABS(v_item_delta),
              v_inv.customer_id, p_batch_id, v_item.id
            );
            v_line_number := v_line_number + 1;
          END IF;

          v_adjusted_items_count := v_adjusted_items_count + 1;
        END IF;
      END LOOP;

      v_adjusted_invoices_count := v_adjusted_invoices_count + 1;
      v_total_delta_posted := v_total_delta_posted + v_invoice_total_delta;
    END IF;
  END LOOP;

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

-- 3. Trigger on public.batches to automatically propagate cost changes
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
  IF pg_trigger_depth() > 1 THEN
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

-- 4. Update get_authoritative_sales_line_cogs to recognize sales_invoice_cogs_adjustment
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
      AND ABS(r.unresolved_base_cost_total - r.residual_posted_cogs) <= 1.00
      THEN r.base_line_cost * (r.residual_posted_cogs / r.unresolved_base_cost_total)
    ELSE NULL END AS authoritative_cogs,
  CASE
    WHEN r.quantity = 0 THEN NULL
    WHEN r.posted_item_cogs IS NOT NULL THEN r.posted_item_cogs / r.quantity
    WHEN r.snapshot_cogs IS NOT NULL THEN r.snapshot_cogs / r.quantity
    WHEN r.invoice_line_count = 1 AND r.invoice_posted_cogs IS NOT NULL THEN r.invoice_posted_cogs / r.quantity
    WHEN r.invoice_line_count > 1 AND r.invoice_posted_cogs IS NOT NULL
      AND r.unresolved_line_count = r.unresolved_base_line_count
      AND r.unresolved_base_cost_total > 0
      AND ABS(r.unresolved_base_cost_total - r.residual_posted_cogs) <= 1.00
      THEN (r.base_line_cost * (r.residual_posted_cogs / r.unresolved_base_cost_total)) / r.quantity
    ELSE NULL END AS authoritative_unit_cogs,
  CASE
    WHEN r.posted_item_cogs IS NOT NULL THEN 'posted_item_cogs'
    WHEN r.snapshot_cogs IS NOT NULL THEN 'snapshot'
    WHEN r.invoice_line_count = 1 AND r.invoice_posted_cogs IS NOT NULL THEN 'single_line_posted_cogs'
    WHEN r.invoice_line_count > 1 AND r.invoice_product_count = 1 AND r.invoice_posted_cogs IS NOT NULL
      AND r.unresolved_line_count = r.unresolved_base_line_count AND r.unresolved_base_cost_total > 0
      AND ABS(r.unresolved_base_cost_total - r.residual_posted_cogs) <= 1.00 THEN 'single_product_proven_allocation'
    WHEN r.invoice_line_count > 1 AND r.invoice_product_count > 1 AND r.invoice_posted_cogs IS NOT NULL
      AND r.unresolved_line_count = r.unresolved_base_line_count AND r.unresolved_base_cost_total > 0
      AND ABS(r.unresolved_base_cost_total - r.residual_posted_cogs) <= 1.00 THEN 'multi_product_proven_allocation'
    ELSE 'unresolved' END AS resolution_tier,
  r.invoice_line_count, r.invoice_product_count, r.invoice_posted_cogs,
  r.base_line_cost, r.reconciliation_difference
FROM resolved r;
$$;

GRANT EXECUTE ON FUNCTION public.calculate_batch_authoritative_cost(public.batches) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_batch_authoritative_unit_cost(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.propagate_batch_cost_change(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_authoritative_sales_line_cogs(date, date) TO authenticated, service_role;

COMMIT;
