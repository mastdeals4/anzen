-- ============================================================================
-- Migration: 20260702160000_import_requirements_views
-- Date:      2026-07-02
--
-- Create product-aggregated view for Import Requirements module.
--
-- vw_import_requirements_by_product:
--   One row per product showing aggregated quantities across all active SOs.
--   Used by the "Product Summary" view in ImportRequirements page.
--
-- Excludes: cancelled and received requirements (only active procurement rows).
-- ============================================================================

DROP VIEW IF EXISTS public.vw_import_requirements_by_product;

CREATE VIEW public.vw_import_requirements_by_product AS
SELECT
  ir.product_id,
  p.product_name,
  p.product_code,
  COUNT(ir.id)                                                    AS so_count,
  SUM(ir.required_quantity)                                       AS total_required_qty,
  SUM(COALESCE(ir.ordered_qty,   0))                              AS total_ordered_qty,
  SUM(COALESCE(ir.allocated_qty, 0))                              AS total_allocated_qty,
  SUM(COALESCE(ir.received_qty,  0))                              AS total_received_qty,
  SUM(GREATEST(ir.required_quantity - COALESCE(ir.ordered_qty, 0), 0))
                                                                  AS total_remaining_qty,
  CASE
    WHEN SUM(ir.required_quantity) <= SUM(COALESCE(ir.received_qty, 0))
      THEN 'fully_received'
    WHEN SUM(COALESCE(ir.ordered_qty, 0)) >= SUM(ir.required_quantity)
      THEN 'fully_ordered'
    WHEN SUM(COALESCE(ir.ordered_qty, 0)) > 0
      THEN 'partial'
    ELSE 'pending'
  END                                                             AS procurement_summary_status,
  MIN(ir.required_delivery_date)                                  AS earliest_delivery_date,
  -- Highest priority: high > medium > low (map to int for MAX, back to text)
  CASE MAX(CASE ir.priority WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END)
    WHEN 3 THEN 'high'
    WHEN 2 THEN 'medium'
    ELSE 'low'
  END                                                             AS highest_priority
FROM import_requirements ir
JOIN products p ON ir.product_id = p.id
WHERE ir.status NOT IN ('cancelled', 'received')
GROUP BY ir.product_id, p.product_name, p.product_code
ORDER BY
  -- Sort: high priority first, then earliest delivery date
  MAX(CASE ir.priority WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END) DESC,
  MIN(ir.required_delivery_date) ASC;

GRANT SELECT ON public.vw_import_requirements_by_product TO authenticated;

-- ── Verify view is queryable ─────────────────────────────────────────────────
DO $$
BEGIN
  PERFORM COUNT(*) FROM vw_import_requirements_by_product;
  RAISE NOTICE 'vw_import_requirements_by_product created successfully.';
END;
$$;
