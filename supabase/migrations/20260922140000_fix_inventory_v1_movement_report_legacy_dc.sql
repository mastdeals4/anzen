-- Migration: Fix Inventory Movement Report to include legitimate pre-V1 delivery challans
-- Description:
-- Fixes public.inventory_v1_movement_report(p_date_from, p_date_to) so its reporting logic
-- includes valid historical delivery_challan movement records without double-counting canonical
-- V1 movements or superseded/duplicate records.
--
-- Adds current_stock as an informative column so users can distinguish between closing stock
-- as of p_date_to and live stock today.
--
-- Note: This is a REPORTING BUG FIX ONLY. Does NOT modify physical stock, batches, transactions,
-- FIFO layers, or GL 1130 / COGS.

BEGIN;

DROP FUNCTION IF EXISTS public.inventory_v1_movement_report(date, date);

CREATE OR REPLACE FUNCTION public.inventory_v1_movement_report(
  p_date_from date,
  p_date_to date
)
RETURNS TABLE (
  product_id uuid,
  product_code text,
  product_name text,
  unit text,
  opening numeric,
  in_qty numeric,
  out_qty numeric,
  reserved_qty numeric,
  closing numeric,
  current_stock numeric
)
LANGUAGE sql
STABLE
SET search_path TO 'public'
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
    LEFT JOIN public.inventory_historical_movement_classifications h ON h.transaction_id = it.id
    WHERE (
      -- 1. Canonical V1 physical movements
      (it.metadata->>'canonical_engine_version' = '1.0' OR it.created_at >= cfg.enforcement_started_at)
      OR (
        -- 2. Legitimate pre-V1 historical movement evidence
        it.created_at < cfg.enforcement_started_at
        AND it.transaction_type IN ('purchase', 'sale', 'return', 'adjustment', 'delivery_challan')
        AND COALESCE(h.classification, '') NOT IN (
          'deterministic_duplicate_evidence',
          'legacy_nonphysical_reservation_evidence',
          'legacy_lifecycle_compensation_evidence'
        )
        AND COALESCE(it.reference_type, '') <> 'historical_stock_adjustment'
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
    p.id as product_id,
    p.product_code,
    p.product_name,
    COALESCE(p.unit, 'PCS') as unit,
    COALESCE(mt.opening, 0) as opening,
    COALESCE(mt.in_qty, 0) as in_qty,
    COALESCE(mt.out_qty, 0) as out_qty,
    COALESCE(r.reserved_qty, 0) as reserved_qty,
    COALESCE(mt.opening, 0)
      + COALESCE(mt.in_qty, 0)
      - COALESCE(mt.out_qty, 0) as closing,
    COALESCE(p.current_stock, 0) as current_stock
  FROM public.products p
  LEFT JOIN movement_totals mt ON mt.product_id = p.id
  LEFT JOIN reservations r ON r.product_id = p.id
  WHERE COALESCE(mt.opening, 0) <> 0
     OR COALESCE(mt.in_qty, 0) <> 0
     OR COALESCE(mt.out_qty, 0) <> 0
     OR COALESCE(r.reserved_qty, 0) <> 0
  ORDER BY p.product_code, p.product_name;
$$;

REVOKE ALL ON FUNCTION public.inventory_v1_movement_report(date, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.inventory_v1_movement_report(date, date) TO authenticated, service_role;

COMMIT;
