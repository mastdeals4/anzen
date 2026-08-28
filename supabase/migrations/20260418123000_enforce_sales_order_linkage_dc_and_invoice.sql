-- Enforce Sales Order linkage for Delivery Challans and Sales Invoices

-- 1) Backfill sales_invoices.sales_order_id from linked Delivery Challans when possible
UPDATE sales_invoices si
SET sales_order_id = resolved.sales_order_id
FROM (
  SELECT
    si2.id AS invoice_id,
    MIN(dc.sales_order_id) AS sales_order_id
  FROM sales_invoices si2
  JOIN LATERAL unnest(si2.linked_challan_ids) AS dc_id ON TRUE
  JOIN delivery_challans dc ON dc.id = dc_id
  WHERE si2.sales_order_id IS NULL
  GROUP BY si2.id
  HAVING COUNT(DISTINCT dc.sales_order_id) = 1
) resolved
WHERE si.id = resolved.invoice_id
  AND si.sales_order_id IS NULL;

DO $$
DECLARE
  v_dc_missing_count integer;
  v_invoice_missing_count integer;
BEGIN
  -- 2) Delivery Challans must always link to a Sales Order
  SELECT COUNT(*) INTO v_dc_missing_count
  FROM delivery_challans
  WHERE sales_order_id IS NULL;

  IF v_dc_missing_count > 0 THEN
    RAISE EXCEPTION 'Cannot enforce NOT NULL on delivery_challans.sales_order_id: % rows are missing sales_order_id', v_dc_missing_count;
  END IF;

  -- 3) Sales Invoices must always link to a Sales Order (directly or via DC-derived backfill)
  SELECT COUNT(*) INTO v_invoice_missing_count
  FROM sales_invoices
  WHERE sales_order_id IS NULL;

  IF v_invoice_missing_count > 0 THEN
    RAISE EXCEPTION 'Cannot enforce NOT NULL on sales_invoices.sales_order_id: % rows are missing sales_order_id', v_invoice_missing_count;
  END IF;
END $$;

ALTER TABLE delivery_challans
  ALTER COLUMN sales_order_id SET NOT NULL;

ALTER TABLE sales_invoices
  ALTER COLUMN sales_order_id SET NOT NULL;
