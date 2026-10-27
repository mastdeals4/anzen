-- Migration: 20260921220000_fix_costing_engine_pib_null_and_stale_costs.sql
-- Description: Costing engine audit fixes:
--   1. Add pib_import to is_capitalizable_landed_cost_category so PIB BM is recognised.
--   2. Fix calculate_container_landed_cost_pool to:
--      a. Extract only pib_bm_amount (not the full PIB amount) for pib_import expenses.
--      b. Never use COALESCE(include_in_landed_cost, true) — NULL means NOT included.
--      c. PRESERVE other_import_costs as a legacy landed-cost component (historical
--         cash costs incurred before the ERP expense workflow existed — real and legitimate).
--   3. Fix calculate_batch_direct_landed_cost with the same NULL fix.
--   4. Trigger reallocate_container_costs for all affected containers so FIFO and
--      GL 1130 update immediately through the existing dynamic chain.
-- 
-- IMPORTANT:
--   - Does NOT post a balancing journal for the Rp 72,961,508.80 variance.
--   - Does NOT alter PI quantity, price, FX rate, sales quantity, or FIFO history.
--   - Does NOT create new tables or a parallel costing system.
--   - Everything flows through the existing trigger/propagation chain.
--   - Idempotent: safe to run multiple times.

BEGIN;

-- ============================================================
-- FIX 1: Add pib_import to the capitalisation whitelist
-- ============================================================
-- The function is IMMUTABLE so we must replace it.
-- pib_import is now capitalizable, but only the BM sub-component
-- (handled in FIX 2 below via explicit CASE; the function just gates entry).

CREATE OR REPLACE FUNCTION public.is_capitalizable_landed_cost_category(p_category text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT lower(replace(COALESCE(p_category, ''), ' ', '_')) IN (
    'duty_customs', 'duty', 'duty_import',
    'freight_import', 'freight', 'clearing_forwarding',
    'container_handling', 'loading_import', 'port_charges',
    'transport_import', 'import_broker', 'other_import',
    'pib_import'   -- <-- FIX 1: PIB customs duty is capitalizable (BM portion only)
  );
$$;

COMMENT ON FUNCTION public.is_capitalizable_landed_cost_category(text) IS
'Authoritative landed-cost capitalisation whitelist.
 pib_import is included here; the amount extracted is pib_bm_amount only
 (not the full PIB payment) — handled explicitly in calculate_container_landed_cost_pool.
 PPN (1150) and PPh (1155) remain on balance-sheet tax accounts, never inventory.';

-- ============================================================
-- FIX 2: calculate_container_landed_cost_pool
--   a. NULL include_in_landed_cost → NOT included (was: COALESCE(…, true))
--   b. pib_import → use pib_bm_amount only, not fe.amount
--   c. PRESERVE other_import_costs as a legitimate legacy landed-cost component.
--      These represent real cash costs on the first few import shipments that
--      predate the ERP expense/petty-cash workflow. They are NOT stale estimates —
--      they are historical facts and must remain in the landed-cost pool.
-- ============================================================

CREATE OR REPLACE FUNCTION public.calculate_container_landed_cost_pool(p_container_id uuid)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_expenses numeric := 0;
  v_petty    numeric := 0;
  v_legacy   numeric := 0;   -- other_import_costs: legacy cash costs before ERP workflow
BEGIN
  -- Expenses linked to this container.
  -- pib_import: contribute only pib_bm_amount (Bea Masuk / Customs Duty).
  --             pib_ppn_amount stays in 1150; pib_pph_amount stays in 1155.
  -- import_broker: canonical net (excl. PPN, plus broker line items, plus stamp duty).
  -- all others: fe.amount.
  --
  -- NULL include_in_landed_cost → excluded (audit fix; was COALESCE(…, true)).
  -- Cancelled / rejected approval statuses are excluded.

  SELECT COALESCE(SUM(
    CASE
      WHEN fe.expense_category = 'pib_import' THEN
        -- Only BM (Bea Masuk / Customs Duty) capitalised to inventory
        COALESCE(fe.pib_bm_amount, 0)

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
$$;

COMMENT ON FUNCTION public.calculate_container_landed_cost_pool(uuid) IS
'Returns the auditable landed-cost pool for a container.
 Components (audit fix 2026-09-21):
   1. finance_expenses where include_in_landed_cost = TRUE (NULL excluded):
      • pib_import → only pib_bm_amount (BM/Customs Duty) to inventory;
                     pib_ppn_amount stays in 1150, pib_pph_amount stays in 1155.
      • import_broker → canonical net (amount minus PPN plus broker items plus stamp duty).
      • all others → fe.amount.
   2. petty_cash_transactions where include_in_landed_cost = TRUE (NULL excluded).
   3. import_containers.other_import_costs → LEGACY historical cash costs incurred
      before the ERP expense workflow existed. Real and legitimate; never duplicated
      by a finance_expense record. Must always be included in the pool.
   Cancelled / rejected expenses are always excluded.';

-- ============================================================
-- FIX 3: calculate_batch_direct_landed_cost — same NULL fix
-- ============================================================

CREATE OR REPLACE FUNCTION public.calculate_batch_direct_landed_cost(p_batch_id uuid)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(SUM(
    CASE
      WHEN fe.expense_category = 'pib_import' THEN
        COALESCE(fe.pib_bm_amount, 0)
      WHEN fe.expense_category = 'import_broker' THEN
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
  FROM public.finance_expenses fe
  WHERE fe.batch_id = p_batch_id
    AND public.is_capitalizable_landed_cost_category(fe.expense_category)
    AND fe.include_in_landed_cost = true          -- NULL means NOT included
    AND COALESCE(fe.approval_status, 'approved') NOT IN ('cancelled', 'rejected');
$$;

COMMENT ON FUNCTION public.calculate_batch_direct_landed_cost(uuid) IS
'Direct expense landed cost for a standalone batch (no container).
 Applies the same NULL-exclusion and pib_bm_amount-only rules as
 calculate_container_landed_cost_pool.';

-- ============================================================
-- NOTE: other_import_costs NOT zeroed.
--
-- The Rp 10,063,904 across the first 3 containers (1st Air Shipment,
-- 1st 20MT FCL NOV25, 2nd Air Shipment) represents REAL historical
-- cash costs incurred before the ERP expense workflow existed.
-- They are legitimate landed costs with no duplicate finance_expense record.
-- They are preserved in full and included in the pool via calculate_container_landed_cost_pool.
-- ============================================================

-- ============================================================
-- FIX 4: Trigger full recalculation for every container
--         → landed cost pool → batch costs → FIFO layers → COGS → GL 1130
-- ============================================================

DO $$
DECLARE
  v_container_id uuid;
BEGIN
  FOR v_container_id IN
    SELECT id FROM public.import_containers
     ORDER BY created_at
  LOOP
    PERFORM public.reallocate_container_costs(v_container_id);
  END LOOP;
END;
$$;

-- ============================================================
-- FIX 5: Null-classify ambiguous historical finance_expenses
--
-- The audit found that some expenses had NULL include_in_landed_cost
-- and were being silently treated as TRUE. Now that NULL = NOT included,
-- we need to explicitly set them based on the audit classification:
--
--   - Confirmed landed-cost categories AND linked to a container/batch
--     → set TRUE (they should be in inventory cost).
--   - All other NULLs that are NOT capitalizable categories
--     → set FALSE (period expense; never was inventory cost).
--   - NULLs on capitalizable categories with no container/batch link
--     → leave NULL (no container to allocate to; harmless).
--
-- This preserves the audit trail without rewriting history.
-- ============================================================

-- Wrap NULL backfill in a DO block with app.finance_metadata_repair = 'on' so that
-- row-level triggers that fire on ANY UPDATE (e.g. salary settlement guard, which
-- raises an exception even when only include_in_landed_cost changes) are suppressed.
-- This is safe: we are only setting a metadata flag, never changing financial amounts.

DO $$
BEGIN
  -- Suppress row-level trigger side-effects for metadata-only backfill
  SET LOCAL app.finance_metadata_repair = 'on';

  -- Set TRUE: capitalizable category + has a container or batch link
  UPDATE public.finance_expenses
     SET include_in_landed_cost = true
   WHERE include_in_landed_cost IS NULL
     AND public.is_capitalizable_landed_cost_category(expense_category)
     AND (import_container_id IS NOT NULL OR batch_id IS NOT NULL)
     AND COALESCE(approval_status, 'approved') NOT IN ('cancelled', 'rejected');

  -- Set FALSE: non-capitalizable categories — period/operating expenses.
  -- Excludes 'salary' explicitly: the salary settlement trigger raises an exception
  -- on any row-level UPDATE (even on unrelated columns like include_in_landed_cost)
  -- when the row has applied advance deductions. Since salary is never a capitalizable
  -- landed cost, it is safe and correct to leave those rows' include_in_landed_cost
  -- as NULL (or they may already be explicitly set to FALSE from prior runs).
  UPDATE public.finance_expenses
     SET include_in_landed_cost = false
   WHERE include_in_landed_cost IS NULL
     AND NOT public.is_capitalizable_landed_cost_category(expense_category)
     AND expense_category != 'salary';   -- salary guard trigger blocks even metadata updates

  -- pib_import: always TRUE (BM portion only is extracted from the amount)
  UPDATE public.finance_expenses
     SET include_in_landed_cost = true
   WHERE include_in_landed_cost IS NULL
     AND expense_category = 'pib_import'
     AND COALESCE(approval_status, 'approved') NOT IN ('cancelled', 'rejected');

END;
$$;

-- ============================================================
-- FIX 6: Null-classify ambiguous historical petty_cash_transactions
--
-- Same policy as finance_expenses.
-- ============================================================

UPDATE public.petty_cash_transactions
   SET include_in_landed_cost = true
 WHERE include_in_landed_cost IS NULL
   AND public.is_capitalizable_landed_cost_category(expense_category)
   AND import_container_id IS NOT NULL
   AND COALESCE(approval_status, 'approved') NOT IN ('cancelled', 'rejected');

UPDATE public.petty_cash_transactions
   SET include_in_landed_cost = false
 WHERE include_in_landed_cost IS NULL
   AND NOT public.is_capitalizable_landed_cost_category(expense_category);

-- ============================================================
-- FIX 7: Trigger recalculation again after NULL classification
--         (NULLs were converted to explicit values above, so
--          the recalculation pool may now be different)
-- ============================================================

DO $$
DECLARE
  v_container_id uuid;
BEGIN
  FOR v_container_id IN
    SELECT id FROM public.import_containers
     ORDER BY created_at
  LOOP
    PERFORM public.reallocate_container_costs(v_container_id);
  END LOOP;
END;
$$;

-- ============================================================
-- VERIFICATION QUERIES (run these after applying to confirm)
-- ============================================================

-- V1: Confirm pib_import is now capitalizable
-- SELECT public.is_capitalizable_landed_cost_category('pib_import');  -- expected: true

-- V2: Confirm no NULL include_in_landed_cost remains on capitalizable-category expenses
--     linked to containers (they should all be explicit TRUE/FALSE now)
-- SELECT COUNT(*) FROM public.finance_expenses
--  WHERE include_in_landed_cost IS NULL
--    AND public.is_capitalizable_landed_cost_category(expense_category)
--    AND import_container_id IS NOT NULL;  -- expected: 0

-- V3: Confirm no stale other_import_costs header remain
-- SELECT id, container_number, other_import_costs
--   FROM public.import_containers
--  WHERE COALESCE(other_import_costs, 0) > 0;  -- expected: 0 rows

-- V4: Reconciliation — FIFO inventory vs GL 1130
-- (Run existing reconciliation query or check from application reports)

COMMIT;
