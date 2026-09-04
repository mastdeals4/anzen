-- Physical stock includes expired goods, but available/sellable stock must not.

BEGIN;

CREATE OR REPLACE VIEW public.inventory_v1_stock_summary
WITH (security_invoker = true)
AS
WITH batch_totals AS (
  SELECT
    b.product_id,
    COALESCE(sum(b.current_stock) FILTER (WHERE b.is_active), 0)
      AS total_current_stock,
    COALESCE(sum(b.current_stock) FILTER (
      WHERE b.is_active
        AND (b.expiry_date IS NULL OR b.expiry_date > CURRENT_DATE)
    ), 0) AS usable_current_stock,
    count(*) FILTER (WHERE b.is_active) AS active_batch_count,
    count(*) FILTER (
      WHERE b.is_active
        AND b.expiry_date IS NOT NULL
        AND b.expiry_date <= CURRENT_DATE
    ) AS expired_batch_count,
    min(b.expiry_date) FILTER (
      WHERE b.is_active
        AND b.expiry_date > CURRENT_DATE
        AND b.current_stock > 0
    ) AS nearest_expiry_date
  FROM public.batches b
  GROUP BY b.product_id
),
reservation_totals AS (
  SELECT
    sr.product_id,
    COALESCE(sum(sr.reserved_quantity), 0) AS reserved_stock
  FROM public.stock_reservations sr
  WHERE sr.status = 'active'
  GROUP BY sr.product_id
),
shortage_totals AS (
  SELECT
    ir.product_id,
    COALESCE(sum(ir.shortage_quantity), 0) AS shortage_quantity
  FROM public.import_requirements ir
  WHERE ir.status IN ('pending', 'ordered')
  GROUP BY ir.product_id
)
SELECT
  p.id AS product_id,
  p.product_name,
  p.product_code,
  p.unit,
  p.category,
  p.min_stock_level,
  COALESCE(bt.total_current_stock, 0) AS total_current_stock,
  COALESCE(rt.reserved_stock, 0) AS reserved_stock,
  COALESCE(bt.usable_current_stock, 0) - COALESCE(rt.reserved_stock, 0)
    AS available_quantity,
  COALESCE(st.shortage_quantity, 0) AS shortage_quantity,
  COALESCE(bt.active_batch_count, 0) AS active_batch_count,
  COALESCE(bt.expired_batch_count, 0) AS expired_batch_count,
  bt.nearest_expiry_date
FROM public.products p
LEFT JOIN batch_totals bt ON bt.product_id = p.id
LEFT JOIN reservation_totals rt ON rt.product_id = p.id
LEFT JOIN shortage_totals st ON st.product_id = p.id
WHERE p.is_active = true;

REVOKE ALL ON public.inventory_v1_stock_summary FROM PUBLIC, anon;
GRANT SELECT ON public.inventory_v1_stock_summary
TO authenticated, service_role;

COMMIT;
