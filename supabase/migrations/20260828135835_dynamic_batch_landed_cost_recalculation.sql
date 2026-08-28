/*
# Dynamic batch landed-cost recalculation

## Root Cause of Static Allocation
The old reallocate_container_costs() used legacy manual container columns
(total_import_expenses - duty_bm - ppn_import - pph_import) which are all
zero or stale. It never looked at linked finance_expenses or petty_cash.
The only way to update batch costs was the manual allocate_import_costs_to_batches
RPC, which also locked the container.

## Fix
1. Replace reallocate_container_costs() with canonical formula:
   - SUM(finance_expenses canonical total WHERE include_in_landed_cost != false AND category != pib_import)
   + SUM(petty_cash amount WHERE include_in_landed_cost != false)
   + container.other_import_costs
2. Add triggers on finance_expenses, petty_cash_transactions, import_containers
   to auto-recalculate linked batches whenever linked costs change.
3. Do NOT lock the container or set status to 'allocated'.
4. Do NOT touch cost_locked or historical batches.

## Safety
- No data deleted or modified.
- Existing allocated/locked containers are not affected (cost_locked = true batches are skipped).
- No accounting, tax, or journal changes.
*/

-- =========================================================
-- Canonical container pool calculator (shared logic)
-- =========================================================
CREATE OR REPLACE FUNCTION public.calculate_container_landed_cost_pool(p_container_id uuid)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_other_import_costs numeric;
  v_linked_expenses_total numeric;
  v_linked_petty_cash_total numeric;
BEGIN
  SELECT COALESCE(other_import_costs, 0) INTO v_other_import_costs
  FROM import_containers WHERE id = p_container_id;

  -- Canonical broker-aware expense total
  WITH canonical_expenses AS (
    SELECT
      fe.id,
      CASE
        WHEN fe.expense_category = 'import_broker' THEN
          fe.amount - COALESCE(fe.ppn_amount, 0)
          + COALESCE((
            SELECT SUM(
              CASE
                WHEN (item->>'invoice_amount_authoritative')::boolean = true
                  THEN (item->>'amount')::numeric
                  ELSE COALESCE(NULLIF((item->>'amount')::numeric, 0), (item->>'dpp_amount')::numeric + (item->>'ppn_amount')::numeric)
              END
              - COALESCE((item->>'ppn_amount')::numeric, 0)
            )
            FROM jsonb_array_elements(fe.broker_items) AS item
          ), 0)
          + COALESCE(fe.stamp_duty_amount, 0)
        ELSE COALESCE(fe.amount, 0)
      END AS canonical_total
    FROM finance_expenses fe
    WHERE fe.import_container_id = p_container_id
      AND fe.expense_category != 'pib_import'
      AND COALESCE(fe.include_in_landed_cost, true) = true
  )
  SELECT COALESCE(SUM(canonical_total), 0) INTO v_linked_expenses_total
  FROM canonical_expenses;

  SELECT COALESCE(SUM(amount), 0) INTO v_linked_petty_cash_total
  FROM petty_cash_transactions
  WHERE import_container_id = p_container_id
    AND COALESCE(include_in_landed_cost, true) = true;

  RETURN v_linked_expenses_total + v_linked_petty_cash_total + v_other_import_costs;
END;
$function$;

-- =========================================================
-- Replace reallocate_container_costs with canonical version
-- =========================================================
CREATE OR REPLACE FUNCTION public.reallocate_container_costs(p_container_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_total_quantity numeric := 0;
  v_batch_record RECORD;
  v_batch_percentage numeric;
  v_total_container_costs numeric;
  v_allocated_cost numeric;
  v_allocated_per_unit numeric;
  v_final_total_cost numeric;
  v_landed_cost_per_unit numeric;
BEGIN
  -- Calculate canonical pool
  v_total_container_costs := public.calculate_container_landed_cost_pool(p_container_id);

  SELECT COALESCE(SUM(import_quantity), 0) INTO v_total_quantity
  FROM batches WHERE import_container_id = p_container_id;

  IF v_total_quantity = 0 THEN
    -- No batches linked: nothing to allocate
    RETURN;
  END IF;

  FOR v_batch_record IN
    SELECT id, import_price, import_quantity, duty_charges, freight_charges, other_charges
    FROM batches
    WHERE import_container_id = p_container_id
      AND COALESCE(cost_locked, false) = false
  LOOP
    v_batch_percentage   := (v_batch_record.import_quantity / v_total_quantity);
    v_allocated_cost     := v_total_container_costs * v_batch_percentage;
    v_allocated_per_unit := v_allocated_cost / NULLIF(v_batch_record.import_quantity, 0);

    v_landed_cost_per_unit :=
      v_batch_record.import_price +
      (v_batch_record.duty_charges    / NULLIF(v_batch_record.import_quantity, 0)) +
      (v_batch_record.freight_charges / NULLIF(v_batch_record.import_quantity, 0)) +
      (v_batch_record.other_charges   / NULLIF(v_batch_record.import_quantity, 0)) +
      v_allocated_per_unit;

    v_final_total_cost :=
      (v_batch_record.import_price +
       (v_batch_record.duty_charges    / NULLIF(v_batch_record.import_quantity, 0)) +
       (v_batch_record.freight_charges / NULLIF(v_batch_record.import_quantity, 0)) +
       (v_batch_record.other_charges   / NULLIF(v_batch_record.import_quantity, 0)))
      * v_batch_record.import_quantity +
      v_allocated_cost;

    UPDATE batches
    SET
      import_cost_allocated = v_allocated_cost,
      final_landed_cost     = v_final_total_cost,
      landed_cost_per_unit  = v_landed_cost_per_unit
    WHERE id = v_batch_record.id;
  END LOOP;
END;
$function$;

-- =========================================================
-- Trigger: recalculate batch costs when finance_expenses change
-- =========================================================
CREATE OR REPLACE FUNCTION public.trigger_recalc_batches_on_expense_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_container_id uuid;
BEGIN
  -- Determine the container ID from OLD or NEW
  v_container_id := COALESCE(NEW.import_container_id, OLD.import_container_id);

  IF v_container_id IS NOT NULL THEN
    PERFORM public.reallocate_container_costs(v_container_id);
  END IF;

  -- If the expense moved from one container to another, recalc the old one too
  IF TG_OP = 'UPDATE' AND OLD.import_container_id IS NOT NULL
     AND NEW.import_container_id IS DISTINCT FROM OLD.import_container_id THEN
    PERFORM public.reallocate_container_costs(OLD.import_container_id);
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$function$;

DROP TRIGGER IF EXISTS trigger_recalc_batches_on_expense ON finance_expenses;
CREATE TRIGGER trigger_recalc_batches_on_expense
  AFTER INSERT OR UPDATE OF import_container_id, include_in_landed_cost, amount, ppn_amount, stamp_duty_amount, broker_items, expense_category
  ON finance_expenses
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_recalc_batches_on_expense_change();

DROP TRIGGER IF EXISTS trigger_recalc_batches_on_expense_del ON finance_expenses;
CREATE TRIGGER trigger_recalc_batches_on_expense_del
  AFTER DELETE ON finance_expenses
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_recalc_batches_on_expense_change();

-- =========================================================
-- Trigger: recalculate batch costs when petty_cash_transactions change
-- =========================================================
CREATE OR REPLACE FUNCTION public.trigger_recalc_batches_on_petty_cash_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_container_id uuid;
BEGIN
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
$function$;

DROP TRIGGER IF EXISTS trigger_recalc_batches_on_petty_cash ON petty_cash_transactions;
CREATE TRIGGER trigger_recalc_batches_on_petty_cash
  AFTER INSERT OR UPDATE OF import_container_id, include_in_landed_cost, amount
  ON petty_cash_transactions
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_recalc_batches_on_petty_cash_change();

DROP TRIGGER IF EXISTS trigger_recalc_batches_on_petty_cash_del ON petty_cash_transactions;
CREATE TRIGGER trigger_recalc_batches_on_petty_cash_del
  AFTER DELETE ON petty_cash_transactions
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_recalc_batches_on_petty_cash_change();

-- =========================================================
-- Trigger: recalculate batch costs when import_containers.other_import_costs changes
-- =========================================================
CREATE OR REPLACE FUNCTION public.trigger_recalc_batches_on_container_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.id IS NOT NULL THEN
    PERFORM public.reallocate_container_costs(NEW.id);
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trigger_recalc_batches_on_container ON import_containers;
CREATE TRIGGER trigger_recalc_batches_on_container
  AFTER INSERT OR UPDATE OF other_import_costs
  ON import_containers
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_recalc_batches_on_container_change();

-- =========================================================
-- Run initial recalculation for all draft containers
-- (one-time backfill, does NOT touch cost_locked batches)
-- =========================================================
DO $$
DECLARE
  v_container_id uuid;
BEGIN
  FOR v_container_id IN
    SELECT id FROM import_containers WHERE status = 'draft'
  LOOP
    PERFORM public.reallocate_container_costs(v_container_id);
  END LOOP;
END;
$$;
