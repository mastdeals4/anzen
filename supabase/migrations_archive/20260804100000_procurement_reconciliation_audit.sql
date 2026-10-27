-- Procurement and inventory reconciliation hardening.
--
-- The Sales Order editor replaces all lines (DELETE, then INSERT).  The old
-- DELETE trigger treated every deleted line as a product removal and cancelled
-- a valid import requirement before its replacement line was inserted.

CREATE OR REPLACE FUNCTION public.fn_sync_import_requirements_on_so_edit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- A draft/pending-approval SO is being edited by the application.  Its
  -- replacement lines are inserted immediately after this DELETE, so do not
  -- mutate procurement state in the middle of that replacement transaction.
  IF EXISTS (
    SELECT 1
    FROM public.sales_orders so
    WHERE so.id = OLD.sales_order_id
      AND so.status::text IN ('draft', 'pending_approval')
  ) THEN
    RETURN OLD;
  END IF;

  -- For a genuine line removal, cancel only when no line for that product
  -- remains on the SO.  This also handles duplicate lines safely.
  UPDATE public.import_requirements ir
  SET status = 'cancelled',
      notes = COALESCE(ir.notes || ' | ', '') ||
        'Product removed from SO ' || to_char(now(), 'YYYY-MM-DD')
  WHERE ir.sales_order_id = OLD.sales_order_id
    AND ir.product_id = OLD.product_id
    AND ir.status::text NOT IN ('cancelled', 'received')
    AND NOT EXISTS (
      SELECT 1
      FROM public.sales_order_items soi
      WHERE soi.sales_order_id = OLD.sales_order_id
        AND soi.product_id = OLD.product_id
    );

  RETURN OLD;
END;
$$;

-- Repair only rows that are demonstrably valid: the product line still exists
-- on a live shortage SO and the cancellation was produced by the faulty edit
-- trigger.  No received/cancelled SO or unrelated manual cancellation is
-- changed.
UPDATE public.import_requirements ir
SET status = 'pending',
    notes = COALESCE(ir.notes || ' | ', '') ||
      'Reopened by procurement reconciliation 2026-08-04',
    updated_at = now()
FROM public.sales_orders so
WHERE ir.sales_order_id = so.id
  AND ir.status::text = 'cancelled'
  AND ir.notes ILIKE '%Product removed from SO%'
  AND so.status::text IN ('approved', 'stock_reserved', 'shortage',
                          'pending_delivery', 'partially_delivered')
  AND NOT COALESCE(so.is_archived, false)
  AND EXISTS (
    SELECT 1
    FROM public.sales_order_items soi
    WHERE soi.sales_order_id = ir.sales_order_id
      AND soi.product_id = ir.product_id
  );

-- A stock_reserved SO must be fully represented by active reservations.  Run
-- the existing canonical FEFO engine for any proven historical exception; do
-- not manufacture reservation rows directly.
DO $$
DECLARE
  v_so_id uuid;
  v_previous_role text := current_setting('request.jwt.claim.role', true);
BEGIN
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);

  FOR v_so_id IN
    WITH demand AS (
      SELECT so.id,
             SUM(GREATEST(soi.quantity - COALESCE(soi.delivered_quantity, 0), 0))
               AS quantity
      FROM public.sales_orders so
      JOIN public.sales_order_items soi ON soi.sales_order_id = so.id
      WHERE so.status::text = 'stock_reserved'
        AND NOT COALESCE(so.is_archived, false)
      GROUP BY so.id
    ),
    reserved AS (
      SELECT sales_order_id, SUM(reserved_quantity) AS quantity
      FROM public.stock_reservations
      WHERE status::text = 'active' AND NOT is_released
      GROUP BY sales_order_id
    )
    SELECT d.id
    FROM demand d
    LEFT JOIN reserved r ON r.sales_order_id = d.id
    WHERE d.quantity <> COALESCE(r.quantity, 0)
    ORDER BY d.id
  LOOP
    PERFORM * FROM public.fn_reserve_stock_for_so_v2(v_so_id);
  END LOOP;

  PERFORM set_config(
    'request.jwt.claim.role', COALESCE(v_previous_role, ''), true
  );
END;
$$;

-- When FEFO reservation resolves a shortage, close only still-pending
-- requirements.  Procurement already committed to a later phase remains
-- visible and is not silently cancelled.
CREATE OR REPLACE FUNCTION public.fn_close_pending_import_requirements_on_reservation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF OLD.status::text = 'shortage'
     AND NEW.status::text = 'stock_reserved' THEN
    UPDATE public.import_requirements ir
    SET status = 'cancelled',
        notes = COALESCE(ir.notes || ' | ', '') ||
          'Auto-cancelled: shortage resolved by stock reservation ' ||
          to_char(now(), 'YYYY-MM-DD'),
        updated_at = now()
    WHERE ir.sales_order_id = NEW.id
      AND ir.status::text = 'pending';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_close_import_req_when_stock_reserved
  ON public.sales_orders;
CREATE TRIGGER trg_close_import_req_when_stock_reserved
AFTER UPDATE OF status ON public.sales_orders
FOR EACH ROW
EXECUTE FUNCTION public.fn_close_pending_import_requirements_on_reservation();

-- Historical counterpart of the event rule above.
UPDATE public.import_requirements ir
SET status = 'cancelled',
    notes = COALESCE(ir.notes || ' | ', '') ||
      'Reconciled: Sales Order already fully stock-reserved 2026-08-04',
    updated_at = now()
FROM public.sales_orders so
WHERE so.id = ir.sales_order_id
  AND so.status::text = 'stock_reserved'
  AND ir.status::text = 'pending';

-- Canonical, read-only exception report.  All downstream reports should use
-- these same aggregates rather than independently summing SO or requirement
-- rows.
DROP VIEW IF EXISTS public.vw_procurement_reconciliation_audit;
CREATE VIEW public.vw_procurement_reconciliation_audit
WITH (security_invoker = true)
AS
WITH open_so AS (
  SELECT soi.product_id,
         COUNT(DISTINCT so.id)::numeric AS so_count,
         COUNT(DISTINCT so.id) FILTER (WHERE so.status::text = 'shortage')::numeric
           AS shortage_so_count,
         SUM(GREATEST(soi.quantity - COALESCE(soi.delivered_quantity, 0), 0))
           AS total_sales_order_qty,
         SUM(GREATEST(soi.quantity - COALESCE(soi.delivered_quantity, 0), 0))
           FILTER (WHERE so.status::text = 'shortage')
           AS shortage_sales_order_qty
  FROM public.sales_order_items soi
  JOIN public.sales_orders so ON so.id = soi.sales_order_id
  WHERE so.status::text IN ('approved', 'stock_reserved', 'shortage',
                            'pending_delivery', 'partially_delivered')
    AND NOT COALESCE(so.is_archived, false)
  GROUP BY soi.product_id
),
reservations AS (
  SELECT product_id, SUM(reserved_quantity) AS reserved_qty
  FROM public.stock_reservations
  WHERE status::text = 'active' AND NOT is_released
  GROUP BY product_id
),
requirements AS (
  SELECT product_id,
         SUM(required_quantity) AS import_requirement_qty,
         SUM(shortage_quantity) AS import_shortage_qty,
         SUM(COALESCE(ordered_qty, 0)) AS import_ordered_qty,
         SUM(COALESCE(received_qty, 0)) AS import_received_qty,
         COUNT(DISTINCT sales_order_id)::numeric AS requirement_so_count
  FROM public.import_requirements
  WHERE status::text NOT IN ('cancelled', 'received')
  GROUP BY product_id
),
purchase AS (
  SELECT poi.product_id,
         SUM(CASE WHEN po.status NOT IN ('draft', 'cancelled', 'rejected')
                  THEN GREATEST(poi.quantity - COALESCE(poi.quantity_received, 0), 0)
                  ELSE 0 END) AS purchase_ordered_qty,
         SUM(CASE WHEN po.status NOT IN ('draft', 'cancelled', 'rejected')
                  THEN COALESCE(poi.quantity_received, 0) ELSE 0 END)
           AS purchase_received_qty
  FROM public.purchase_order_items poi
  JOIN public.purchase_orders po ON po.id = poi.po_id
  GROUP BY poi.product_id
),
stock AS (
  SELECT product_id,
         SUM(current_stock) FILTER (WHERE is_active) AS physical_stock
  FROM public.batches
  GROUP BY product_id
)
SELECT p.id AS product_id,
       p.product_code,
       p.product_name,
       COALESCE(o.so_count, 0) AS so_count,
       COALESCE(o.shortage_so_count, 0) AS shortage_so_count,
       COALESCE(o.total_sales_order_qty, 0) AS total_sales_order_qty,
       COALESCE(o.shortage_sales_order_qty, 0) AS shortage_sales_order_qty,
       COALESCE(r.reserved_qty, 0) AS reserved_qty,
       COALESCE(ir.import_requirement_qty, 0) AS import_requirement_qty,
       COALESCE(ir.import_shortage_qty, 0) AS import_shortage_qty,
       COALESCE(po.purchase_ordered_qty, 0) AS purchase_ordered_qty,
       COALESCE(po.purchase_received_qty, 0) AS purchase_received_qty,
       COALESCE(s.physical_stock, 0) AS physical_stock,
       COALESCE(s.physical_stock, 0) - COALESCE(r.reserved_qty, 0)
         AS available_stock,
       GREATEST(COALESCE(o.shortage_sales_order_qty, 0)
                - COALESCE(po.purchase_ordered_qty, 0)
                - COALESCE(po.purchase_received_qty, 0), 0)
         AS expected_remaining_procurement,
       COALESCE(ir.import_requirement_qty, 0)
         - GREATEST(COALESCE(o.shortage_sales_order_qty, 0)
                    - COALESCE(po.purchase_ordered_qty, 0)
                    - COALESCE(po.purchase_received_qty, 0), 0)
         AS difference,
       (COALESCE(s.physical_stock, 0) - COALESCE(r.reserved_qty, 0)) < 0
         AS available_stock_mismatch,
       COALESCE(ir.requirement_so_count, 0) <> COALESCE(o.shortage_so_count, 0)
         AS so_count_mismatch
FROM public.products p
LEFT JOIN open_so o ON o.product_id = p.id
LEFT JOIN reservations r ON r.product_id = p.id
LEFT JOIN requirements ir ON ir.product_id = p.id
LEFT JOIN purchase po ON po.product_id = p.id
LEFT JOIN stock s ON s.product_id = p.id
WHERE p.is_active = true;

GRANT SELECT ON public.vw_procurement_reconciliation_audit TO authenticated,
  service_role;
