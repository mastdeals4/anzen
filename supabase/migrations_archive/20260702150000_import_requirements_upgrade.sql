-- ============================================================================
-- Migration: 20260702150000_import_requirements_upgrade
-- Date:      2026-07-02
--
-- Import Requirements Module — Production Hardening
--
-- Changes:
--   1. Cancel existing orphan requirements (product removed from SO)
--   2. Add new columns: import_container_id, ordered_qty, allocated_qty,
--      received_qty, po_reference
--   3. Extend import_status enum: rfq_sent, po_created, supplier_confirmed,
--      in_production, ready_to_ship, in_transit, customs_clearance
--   4. Partial unique index to prevent DB-level duplicates
--   5. Fix fn_create_import_requirements: cleanup orphans before upsert
--   6. New trigger fn_sync_import_requirements_on_so_edit on
--      sales_order_items DELETE to auto-cancel orphan requirements
--
-- Backward compatibility:
--   - All existing requirements rows preserved (only orphans cancelled)
--   - Existing enum values unchanged (pending/ordered/partially_received/received/cancelled)
--   - fn_reserve_stock_for_so_v2 unchanged
--   - fn_cancel_sales_order unchanged
--   - trg_auto_cancel_import_requirements unchanged
-- ============================================================================

-- ── 1. Cancel existing orphan requirements ─────────────────────────────────
-- An orphan is a pending/ordered requirement for a product that is no longer
-- in its linked sales order's items (e.g. product changed from USP to EP).
-- This fixes the confirmed live bug: SO-2026-0044 / Cetirizine USP.

UPDATE import_requirements ir
SET
  status = 'cancelled',
  notes  = COALESCE(ir.notes || ' | ', '') || 'Auto-cancelled: product no longer in Sales Order (data fix 2026-07-02)'
WHERE ir.status IN ('pending', 'ordered')
  AND NOT EXISTS (
    SELECT 1 FROM sales_order_items soi
    WHERE soi.sales_order_id = ir.sales_order_id
      AND soi.product_id = ir.product_id
  );

-- ── 2. Add new columns ──────────────────────────────────────────────────────

ALTER TABLE import_requirements
  -- Container allocation: optional link to an import container
  ADD COLUMN IF NOT EXISTS import_container_id UUID REFERENCES import_containers(id) ON DELETE SET NULL,
  -- Quantity tracking (all default 0 — backward compatible with existing rows)
  ADD COLUMN IF NOT EXISTS ordered_qty    NUMERIC(15,3) NOT NULL DEFAULT 0 CHECK (ordered_qty >= 0),
  ADD COLUMN IF NOT EXISTS allocated_qty  NUMERIC(15,3) NOT NULL DEFAULT 0 CHECK (allocated_qty >= 0),
  ADD COLUMN IF NOT EXISTS received_qty   NUMERIC(15,3) NOT NULL DEFAULT 0 CHECK (received_qty >= 0),
  -- Optional PO reference text (e.g. "PO-2026-001")
  ADD COLUMN IF NOT EXISTS po_reference   TEXT;

-- ── 3. Extend import_status enum ────────────────────────────────────────────
-- PostgreSQL requires ADD VALUE outside a transaction block for enum changes.
-- Using IF NOT EXISTS to be idempotent.
-- Existing values preserved: pending, ordered, partially_received, received, cancelled

ALTER TYPE import_status ADD VALUE IF NOT EXISTS 'rfq_sent'           AFTER 'pending';
ALTER TYPE import_status ADD VALUE IF NOT EXISTS 'po_created'         AFTER 'rfq_sent';
ALTER TYPE import_status ADD VALUE IF NOT EXISTS 'supplier_confirmed' AFTER 'po_created';
ALTER TYPE import_status ADD VALUE IF NOT EXISTS 'in_production'      AFTER 'supplier_confirmed';
ALTER TYPE import_status ADD VALUE IF NOT EXISTS 'ready_to_ship'      AFTER 'in_production';
ALTER TYPE import_status ADD VALUE IF NOT EXISTS 'in_transit'         AFTER 'ready_to_ship';
ALTER TYPE import_status ADD VALUE IF NOT EXISTS 'customs_clearance'  AFTER 'in_transit';

-- ── 4. Partial unique index — prevent DB-level duplicate active requirements
-- Only one pending or ordered requirement per (SO, product) pair is allowed.
-- Cancelled/received requirements do NOT count (partial index WHERE clause).

CREATE UNIQUE INDEX IF NOT EXISTS uq_import_req_so_product_active
  ON import_requirements (sales_order_id, product_id)
  WHERE status IN ('pending', 'ordered', 'rfq_sent', 'po_created', 'supplier_confirmed',
                   'in_production', 'ready_to_ship', 'in_transit', 'customs_clearance');

-- ── 5. Fix fn_create_import_requirements ────────────────────────────────────
-- Core fix: before upserting shortage items, CANCEL requirements for products
-- that are no longer in the SO's items (handles USP→EP product change scenario).
--
-- Flow:
--   Step 0: Cancel orphan requirements (product removed from SO)
--   Step 1: For each shortage item:
--           - If pending/active requirement exists → UPDATE quantities
--           - If not → INSERT new requirement

CREATE OR REPLACE FUNCTION public.fn_create_import_requirements(
  p_so_id         UUID,
  p_shortage_items JSONB
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_shortage      RECORD;
  v_customer_id   UUID;
  v_delivery_date DATE;
  v_priority      import_priority;
  v_existing_id   UUID;
BEGIN
  -- Get SO details
  SELECT customer_id, expected_delivery_date
  INTO v_customer_id, v_delivery_date
  FROM sales_orders
  WHERE id = p_so_id;

  -- Default delivery date if not set
  IF v_delivery_date IS NULL THEN
    v_delivery_date := CURRENT_DATE + INTERVAL '30 days';
  END IF;

  -- Calculate priority from delivery date
  v_priority := fn_calculate_import_priority(v_delivery_date);

  -- ── Step 0: Cancel requirements for products NO LONGER in this SO ────────
  -- This handles the product-change scenario (e.g. USP → EP):
  --   old product's requirement becomes orphaned → cancel it.
  -- Status check: only cancel active-phase requirements (not already cancelled/received).
  UPDATE import_requirements
  SET
    status = 'cancelled',
    notes  = COALESCE(notes || ' | ', '') || 'Product removed from SO on re-reservation ' || to_char(now(), 'YYYY-MM-DD')
  WHERE sales_order_id = p_so_id
    AND status NOT IN ('cancelled', 'received')
    AND product_id NOT IN (
      SELECT DISTINCT soi.product_id
      FROM sales_order_items soi
      WHERE soi.sales_order_id = p_so_id
    );

  -- ── Step 1: Upsert shortage requirements ─────────────────────────────────
  FOR v_shortage IN
    SELECT
      (item->>'product_id')::UUID  AS product_id,
      (item->>'required_qty')::NUMERIC AS required_qty,
      (item->>'shortage_qty')::NUMERIC AS shortage_qty
    FROM jsonb_array_elements(p_shortage_items) AS item
  LOOP
    -- Check for existing active requirement for this SO + product
    SELECT id INTO v_existing_id
    FROM import_requirements
    WHERE sales_order_id = p_so_id
      AND product_id = v_shortage.product_id
      AND status NOT IN ('cancelled', 'received')
    LIMIT 1;

    IF v_existing_id IS NOT NULL THEN
      -- Update existing requirement with latest shortage quantities
      UPDATE import_requirements
      SET
        shortage_quantity     = v_shortage.shortage_qty,
        required_quantity     = v_shortage.required_qty,
        priority              = v_priority,
        required_delivery_date = v_delivery_date,
        updated_at            = now()
      WHERE id = v_existing_id;
    ELSE
      -- Insert new requirement
      INSERT INTO import_requirements (
        product_id,
        sales_order_id,
        customer_id,
        required_quantity,
        shortage_quantity,
        required_delivery_date,
        priority,
        status,
        ordered_qty,
        allocated_qty,
        received_qty,
        notes
      ) VALUES (
        v_shortage.product_id,
        p_so_id,
        v_customer_id,
        v_shortage.required_qty,
        v_shortage.shortage_qty,
        v_delivery_date,
        v_priority,
        'pending',
        0,
        0,
        0,
        'Auto-generated from SO shortage'
      );
    END IF;
  END LOOP;

  RETURN TRUE;
END;
$$;

-- ── 6. Trigger: auto-cancel requirement when SO item is deleted ─────────────
-- Fires when a product is removed from a Sales Order (DELETE from sales_order_items).
-- Cancels the corresponding import requirement if it is still in an active phase.
-- This is the real-time complement to the Step 0 cleanup above.

CREATE OR REPLACE FUNCTION public.fn_sync_import_requirements_on_so_edit()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- When an SO item is deleted, cancel the corresponding import requirement
  -- if it hasn't progressed past procurement (still pending/active).
  UPDATE import_requirements
  SET
    status = 'cancelled',
    notes  = COALESCE(notes || ' | ', '') || 'Product removed from SO ' || to_char(now(), 'YYYY-MM-DD')
  WHERE sales_order_id = OLD.sales_order_id
    AND product_id     = OLD.product_id
    AND status NOT IN ('cancelled', 'received');

  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_import_req_on_so_item_delete ON sales_order_items;
CREATE TRIGGER trg_sync_import_req_on_so_item_delete
  AFTER DELETE ON sales_order_items
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_sync_import_requirements_on_so_edit();

-- ── 7. Index for container linkage query performance ──────────────────────
CREATE INDEX IF NOT EXISTS idx_import_req_container_id
  ON import_requirements (import_container_id)
  WHERE import_container_id IS NOT NULL;

-- ── 8. Verification ────────────────────────────────────────────────────────
DO $$
DECLARE
  v_orphan_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_orphan_count
  FROM import_requirements ir
  WHERE ir.status NOT IN ('cancelled', 'received')
    AND NOT EXISTS (
      SELECT 1 FROM sales_order_items soi
      WHERE soi.sales_order_id = ir.sales_order_id
        AND soi.product_id = ir.product_id
    );

  IF v_orphan_count > 0 THEN
    RAISE WARNING 'Still % orphan import_requirements after migration', v_orphan_count;
  ELSE
    RAISE NOTICE 'Verification passed: 0 orphan import requirements.';
  END IF;
END;
$$;
