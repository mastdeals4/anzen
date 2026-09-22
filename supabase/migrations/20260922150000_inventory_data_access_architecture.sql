-- Migration: 20260922150000_inventory_data_access_architecture.sql
-- Description: Final Inventory Data Access Architecture
-- Establishes canonical operational inventory views & functions,
-- isolates legacy inventory_transactions for forensic audit only,
-- and creates a dedicated read-only AI/reporting layer.

BEGIN;

-- 1. CANONICAL OPERATIONAL PHYSICAL LEDGER
CREATE OR REPLACE VIEW public.inventory_operational_physical_ledger
WITH (security_invoker = true)
AS
WITH cfg AS (
  SELECT enforcement_started_at
  FROM public.inventory_engine_certification
  WHERE singleton
),
batch_receipts AS (
  SELECT
    b.id AS source_id,
    b.product_id,
    b.id AS batch_id,
    b.import_date AS transaction_date,
    b.import_quantity AS quantity,
    'batch_receipt'::text AS source_type,
    b.batch_number AS reference_number
  FROM public.batches b
  WHERE COALESCE(b.import_quantity, 0) > 0
    AND b.import_date IS NOT NULL
),
approved_deliveries AS (
  SELECT
    dci.id AS source_id,
    dci.product_id,
    dci.batch_id,
    dc.challan_date AS transaction_date,
    -abs(COALESCE(dci.quantity, 0)) AS quantity,
    'delivery_challan'::text AS source_type,
    dc.challan_number AS reference_number
  FROM public.delivery_challan_items dci
  JOIN public.delivery_challans dc ON dc.id = dci.challan_id
  WHERE dc.approval_status = 'approved'
    AND COALESCE(dci.quantity, 0) > 0
),
canonical_post_cutover_changes AS (
  SELECT
    it.id AS source_id,
    it.product_id,
    it.batch_id,
    it.transaction_date,
    it.quantity,
    CASE
      WHEN it.transaction_type = 'return' THEN 'canonical_return'
      ELSE 'canonical_adjustment'
    END AS source_type,
    it.reference_number
  FROM public.inventory_transactions it
  CROSS JOIN cfg
  WHERE it.created_at >= cfg.enforcement_started_at
    AND it.transaction_type IN ('return', 'adjustment')
    AND it.metadata->>'canonical_engine_version' = '1.0'
    AND COALESCE((it.metadata->>'superseded')::boolean, false) = false
    AND COALESCE(it.reference_type, '') NOT IN ('purchase_invoice_receiving', 'historical_stock_repair')
)
SELECT source_id, product_id, batch_id, transaction_date, quantity, source_type, reference_number FROM batch_receipts
UNION ALL
SELECT source_id, product_id, batch_id, transaction_date, quantity, source_type, reference_number FROM approved_deliveries
UNION ALL
SELECT source_id, product_id, batch_id, transaction_date, quantity, source_type, reference_number FROM canonical_post_cutover_changes;

-- 2. CANONICAL INVENTORY MOVEMENT REPORT
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
SECURITY INVOKER
SET search_path TO 'public'
AS $$
  WITH movement_totals AS (
    SELECT
      m.product_id,
      COALESCE(SUM(m.quantity) FILTER (
        WHERE m.transaction_date < p_date_from
      ), 0) AS opening,
      COALESCE(SUM(m.quantity) FILTER (
        WHERE m.transaction_date BETWEEN p_date_from AND p_date_to
          AND m.quantity > 0
      ), 0) AS in_qty,
      COALESCE(ABS(SUM(m.quantity) FILTER (
        WHERE m.transaction_date BETWEEN p_date_from AND p_date_to
          AND m.quantity < 0
      )), 0) AS out_qty
    FROM public.inventory_operational_physical_ledger m
    GROUP BY m.product_id
  ),
  stock AS (
    SELECT
      s.product_id,
      COALESCE(s.total_current_stock, 0) AS current_stock,
      COALESCE(s.reserved_stock, 0) AS reserved_qty
    FROM public.inventory_v1_stock_summary s
  )
  SELECT
    p.id AS product_id,
    p.product_code,
    p.product_name,
    COALESCE(p.unit, 'PCS') AS unit,
    COALESCE(mt.opening, 0) AS opening,
    COALESCE(mt.in_qty, 0) AS in_qty,
    COALESCE(mt.out_qty, 0) AS out_qty,
    COALESCE(st.reserved_qty, 0) AS reserved_qty,
    COALESCE(mt.opening, 0)
      + COALESCE(mt.in_qty, 0)
      - COALESCE(mt.out_qty, 0) AS closing,
    COALESCE(st.current_stock, 0) AS current_stock
  FROM public.products p
  LEFT JOIN movement_totals mt ON mt.product_id = p.id
  LEFT JOIN stock st ON st.product_id = p.id
  WHERE COALESCE(mt.opening, 0) <> 0
     OR COALESCE(mt.in_qty, 0) <> 0
     OR COALESCE(mt.out_qty, 0) <> 0
     OR COALESCE(st.reserved_qty, 0) <> 0
     OR COALESCE(st.current_stock, 0) <> 0
  ORDER BY p.product_code, p.product_name;
$$;

-- 3. AI / REPORTING ACCESS LAYER
CREATE OR REPLACE VIEW public.ai_inventory_current
WITH (security_invoker = true)
AS
SELECT
  product_id,
  product_code,
  product_name,
  unit,
  category,
  min_stock_level,
  total_current_stock AS current_stock,
  reserved_stock,
  available_quantity,
  shortage_quantity,
  active_batch_count,
  expired_batch_count,
  nearest_expiry_date
FROM public.inventory_v1_stock_summary;

CREATE OR REPLACE FUNCTION public.ai_inventory_movement(
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
SECURITY INVOKER
SET search_path TO 'public'
AS $$
  SELECT * FROM public.inventory_v1_movement_report(p_date_from, p_date_to);
$$;

-- 4. LEGACY TABLE CLASSIFICATION COMMENTS
COMMENT ON TABLE public.inventory_transactions IS
'LEGACY INVENTORY HISTORY - AUDIT / FORENSIC ONLY. Do NOT treat as an operational stock source. For operational stock use inventory_v1_stock_summary, inventory_operational_physical_ledger, and inventory_v1_movement_report().';

COMMENT ON TABLE public.inventory_historical_movement_classifications IS
'LEGACY INVENTORY HISTORY - AUDIT / FORENSIC ONLY. Classification metadata for pre-V1 historical movement audit.';

-- 5. REPORTING / AI ROLE PERMISSION DESIGN
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'reporting_ai_role') THEN
    CREATE ROLE reporting_ai_role NOLOGIN;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO reporting_ai_role;

-- Grant operational reads
GRANT SELECT ON public.inventory_operational_physical_ledger TO reporting_ai_role, authenticated, service_role;
GRANT SELECT ON public.inventory_v1_stock_summary TO reporting_ai_role, authenticated, service_role;
GRANT SELECT ON public.ai_inventory_current TO reporting_ai_role, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.inventory_v1_movement_report(date, date) TO reporting_ai_role, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ai_inventory_movement(date, date) TO reporting_ai_role, authenticated, service_role;

-- Explicitly ensure legacy tables are NOT accessible to reporting_ai_role
REVOKE ALL ON public.inventory_transactions FROM reporting_ai_role;
REVOKE ALL ON public.inventory_historical_movement_classifications FROM reporting_ai_role;

COMMIT;
