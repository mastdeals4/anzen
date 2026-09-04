/*
  # Safe SO-DC Linking and Status Views

  ## Summary
  1. Adds `review_status` column to delivery_challans to flag records needing manual review
  2. Safely auto-links unlinked DCs to matching SOs (same customer, matching products, compatible qty)
  3. Creates `so_delivery_invoice_status` view to show per-SO delivery and invoice status
  4. Does NOT touch stock, inventory, or any financial data

  ## New Columns
  - `delivery_challans.review_status` (text, nullable): NULL = ok, 'needs_review' = skip, needs manual link

  ## New Views / Functions
  - `so_delivery_invoice_status`: for each SO shows delivery_status and invoice_status
  - `fn_safe_autolink_dc_to_so()`: safe one-time linker

  ## Safe Auto-Link Rules
  Only links DC to SO when ALL of:
  - Same customer_id
  - ALL products in the DC exist in the SO
  - There is exactly ONE matching SO (no ambiguity)
  - Quantity in DC <= quantity in SO (per product)
*/

-- 1. Add review_status column to delivery_challans
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'delivery_challans' AND column_name = 'review_status'
  ) THEN
    ALTER TABLE delivery_challans ADD COLUMN review_status text DEFAULT NULL;
  END IF;
END $$;

-- 2. Safe auto-link function (challan_items FK column is "challan_id")
CREATE OR REPLACE FUNCTION fn_safe_autolink_dc_to_so()
RETURNS TABLE(
  dc_id uuid,
  linked_so_id uuid,
  action text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  dc_rec RECORD;
  candidate_so_id uuid;
  match_count int;
BEGIN
  FOR dc_rec IN
    SELECT dc.id, dc.customer_id
    FROM delivery_challans dc
    WHERE dc.sales_order_id IS NULL
      AND (dc.review_status IS NULL OR dc.review_status != 'needs_review')
  LOOP
    SELECT COUNT(DISTINCT so.id) INTO match_count
    FROM sales_orders so
    WHERE so.customer_id = dc_rec.customer_id
      AND so.is_archived = false
      AND so.status NOT IN ('draft', 'cancelled', 'rejected')
      AND NOT EXISTS (
        SELECT 1 FROM delivery_challan_items dci
        WHERE dci.challan_id = dc_rec.id
          AND NOT EXISTS (
            SELECT 1 FROM sales_order_items soi
            WHERE soi.sales_order_id = so.id
              AND soi.product_id = dci.product_id
              AND soi.quantity >= dci.quantity
          )
      )
      AND EXISTS (
        SELECT 1 FROM delivery_challan_items dci2
        WHERE dci2.challan_id = dc_rec.id
      );

    IF match_count = 1 THEN
      SELECT so.id INTO candidate_so_id
      FROM sales_orders so
      WHERE so.customer_id = dc_rec.customer_id
        AND so.is_archived = false
        AND so.status NOT IN ('draft', 'cancelled', 'rejected')
        AND NOT EXISTS (
          SELECT 1 FROM delivery_challan_items dci
          WHERE dci.challan_id = dc_rec.id
            AND NOT EXISTS (
              SELECT 1 FROM sales_order_items soi
              WHERE soi.sales_order_id = so.id
                AND soi.product_id = dci.product_id
                AND soi.quantity >= dci.quantity
            )
        )
        AND EXISTS (
          SELECT 1 FROM delivery_challan_items dci2
          WHERE dci2.challan_id = dc_rec.id
        )
      LIMIT 1;

      UPDATE delivery_challans
      SET sales_order_id = candidate_so_id,
          updated_at = now()
      WHERE id = dc_rec.id;

      dc_id := dc_rec.id;
      linked_so_id := candidate_so_id;
      action := 'linked';
      RETURN NEXT;

    ELSIF match_count = 0 THEN
      UPDATE delivery_challans
      SET review_status = 'needs_review',
          updated_at = now()
      WHERE id = dc_rec.id
        AND sales_order_id IS NULL;

      dc_id := dc_rec.id;
      linked_so_id := NULL;
      action := 'needs_review';
      RETURN NEXT;

    ELSE
      UPDATE delivery_challans
      SET review_status = 'needs_review',
          updated_at = now()
      WHERE id = dc_rec.id
        AND sales_order_id IS NULL;

      dc_id := dc_rec.id;
      linked_so_id := NULL;
      action := 'needs_review';
      RETURN NEXT;
    END IF;

  END LOOP;
END;
$$;

-- 3. Run the safe auto-link on existing unlinked DCs
SELECT * FROM fn_safe_autolink_dc_to_so();

-- 4. Create SO delivery + invoice status view
CREATE OR REPLACE VIEW so_delivery_invoice_status AS
SELECT
  so.id AS so_id,
  so.so_number,
  so.customer_id,
  so.status AS so_status,

  CASE
    WHEN COUNT(DISTINCT dc.id) FILTER (WHERE dc.approval_status = 'approved') = 0
      THEN 'pending'
    WHEN EXISTS (
      SELECT 1 FROM sales_order_items soi2
      WHERE soi2.sales_order_id = so.id
        AND soi2.delivered_quantity < soi2.quantity
    ) THEN 'partial'
    ELSE 'completed'
  END AS delivery_status,

  CASE
    WHEN COUNT(DISTINCT si.id) = 0
      THEN 'pending'
    WHEN COUNT(DISTINCT si.id) > 0
      AND EXISTS (
        SELECT 1 FROM sales_order_items soi3
        WHERE soi3.sales_order_id = so.id
          AND soi3.delivered_quantity < soi3.quantity
      ) THEN 'partial'
    ELSE 'completed'
  END AS invoice_status,

  CASE
    WHEN COUNT(DISTINCT si.id) > 0
      AND COUNT(DISTINCT dc.id) FILTER (WHERE dc.approval_status = 'approved') = 0
      THEN 'invoice_done_delivery_pending'
    ELSE NULL
  END AS special_status,

  COUNT(DISTINCT dc.id) FILTER (WHERE dc.approval_status = 'approved') AS approved_dc_count,
  COUNT(DISTINCT si.id) AS invoice_count

FROM sales_orders so
LEFT JOIN delivery_challans dc ON dc.sales_order_id = so.id
LEFT JOIN sales_invoices si ON si.sales_order_id = so.id
GROUP BY so.id, so.so_number, so.customer_id, so.status;

GRANT SELECT ON so_delivery_invoice_status TO authenticated;
