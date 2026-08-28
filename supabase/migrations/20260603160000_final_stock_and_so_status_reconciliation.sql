/*
  # Final stock + Sales Order status reconciliation

  Purpose:
    - Recompute SO delivered_quantity from approved Delivery Challans only.
    - Compute SO invoice state from both direct SO invoices and DC-linked invoice
      items.
    - Keep sales_orders.status aligned with production enum values:
        closed              = fully delivered + fully invoiced
        delivered           = fully delivered, not fully invoiced
        partially_delivered = partial approved delivery
    - Replace so_delivery_invoice_status with quantity-based calculations.

  Safety:
    - Does not update invoices, DCs, finance journals, or source transactions.
    - Data updates are limited to derived sales_order_items.delivered_quantity
      and sales_orders.status.
*/

BEGIN;

CREATE OR REPLACE VIEW public.so_delivery_invoice_status AS
WITH ordered AS (
  SELECT
    soi.sales_order_id AS so_id,
    COALESCE(SUM(soi.quantity), 0)::numeric AS ordered_qty
  FROM sales_order_items soi
  GROUP BY soi.sales_order_id
),
approved_delivery AS (
  SELECT
    dc.sales_order_id AS so_id,
    COALESCE(SUM(dci.quantity), 0)::numeric AS approved_delivered_qty,
    COUNT(DISTINCT dc.id) AS approved_dc_count
  FROM delivery_challans dc
  JOIN delivery_challan_items dci ON dci.challan_id = dc.id
  WHERE dc.approval_status = 'approved'
    AND dc.sales_order_id IS NOT NULL
  GROUP BY dc.sales_order_id
),
invoice_items_by_so AS (
  SELECT DISTINCT
    sii.id AS invoice_item_id,
    COALESCE(si.sales_order_id, dc.sales_order_id) AS so_id,
    sii.quantity
  FROM sales_invoice_items sii
  JOIN sales_invoices si ON si.id = sii.invoice_id
  LEFT JOIN delivery_challan_items dci ON dci.id = sii.delivery_challan_item_id
  LEFT JOIN delivery_challans dc ON dc.id = dci.challan_id
  WHERE COALESCE(si.is_draft, false) = false
    AND si.invoice_number NOT ILIKE 'TEST-COGS-%'
    AND COALESCE(si.sales_order_id, dc.sales_order_id) IS NOT NULL
),
invoiced AS (
  SELECT
    i.so_id,
    COALESCE(SUM(i.quantity), 0)::numeric AS invoiced_qty,
    COUNT(DISTINCT i.invoice_item_id) AS invoice_count
  FROM invoice_items_by_so i
  GROUP BY i.so_id
)
SELECT
  so.id AS so_id,
  so.so_number,
  so.customer_id,
  so.status AS so_status,
  CASE
    WHEN COALESCE(ad.approved_delivered_qty, 0) = 0 THEN 'pending'
    WHEN COALESCE(ad.approved_delivered_qty, 0) >= COALESCE(o.ordered_qty, 0)
      AND COALESCE(o.ordered_qty, 0) > 0 THEN 'completed'
    ELSE 'partial'
  END AS delivery_status,
  CASE
    WHEN COALESCE(i.invoiced_qty, 0) = 0 THEN 'pending'
    WHEN COALESCE(i.invoiced_qty, 0) >= COALESCE(o.ordered_qty, 0)
      AND COALESCE(o.ordered_qty, 0) > 0 THEN 'completed'
    ELSE 'partial'
  END AS invoice_status,
  CASE
    WHEN COALESCE(i.invoiced_qty, 0) > 0
      AND COALESCE(ad.approved_delivered_qty, 0) = 0
      THEN 'invoice_done_delivery_pending'
    ELSE NULL
  END AS special_status,
  COALESCE(ad.approved_dc_count, 0) AS approved_dc_count,
  COALESCE(i.invoice_count, 0) AS invoice_count,
  COALESCE(o.ordered_qty, 0) AS ordered_qty,
  COALESCE(ad.approved_delivered_qty, 0) AS approved_delivered_qty,
  COALESCE(i.invoiced_qty, 0) AS invoiced_qty
FROM sales_orders so
LEFT JOIN ordered o ON o.so_id = so.id
LEFT JOIN approved_delivery ad ON ad.so_id = so.id
LEFT JOIN invoiced i ON i.so_id = so.id;

ALTER VIEW public.so_delivery_invoice_status SET (security_invoker = true);
GRANT SELECT ON public.so_delivery_invoice_status TO authenticated;

CREATE OR REPLACE FUNCTION public.fn_recompute_so_status(p_so_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ordered numeric := 0;
  v_delivered numeric := 0;
  v_invoiced numeric := 0;
BEGIN
  IF p_so_id IS NULL THEN
    RETURN;
  END IF;

  WITH approved_by_product AS (
    SELECT
      dci.product_id,
      COALESCE(SUM(dci.quantity), 0)::numeric AS delivered_qty
    FROM delivery_challans dc
    JOIN delivery_challan_items dci ON dci.challan_id = dc.id
    WHERE dc.sales_order_id = p_so_id
      AND dc.approval_status = 'approved'
    GROUP BY dci.product_id
  ),
  ordered_items AS (
    SELECT
      soi.id,
      soi.product_id,
      soi.quantity,
      COALESCE(abp.delivered_qty, 0) AS delivered_qty,
      COALESCE(
        SUM(soi.quantity) OVER (
          PARTITION BY soi.product_id
          ORDER BY soi.created_at, soi.id
          ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
        ),
        0
      ) AS prior_qty
    FROM sales_order_items soi
    LEFT JOIN approved_by_product abp ON abp.product_id = soi.product_id
    WHERE soi.sales_order_id = p_so_id
  ),
  allocated AS (
    SELECT
      id,
      CASE
        WHEN delivered_qty - prior_qty <= 0 THEN 0
        WHEN delivered_qty - prior_qty >= quantity THEN quantity
        ELSE delivered_qty - prior_qty
      END AS delivered_quantity
    FROM ordered_items
  )
  UPDATE sales_order_items soi
     SET delivered_quantity = allocated.delivered_quantity
    FROM allocated
   WHERE soi.id = allocated.id;

  SELECT COALESCE(SUM(quantity), 0)
    INTO v_ordered
    FROM sales_order_items
   WHERE sales_order_id = p_so_id;

  SELECT COALESCE(SUM(dci.quantity), 0)
    INTO v_delivered
    FROM delivery_challans dc
    JOIN delivery_challan_items dci ON dci.challan_id = dc.id
   WHERE dc.sales_order_id = p_so_id
     AND dc.approval_status = 'approved';

  SELECT COALESCE(SUM(x.quantity), 0)
    INTO v_invoiced
    FROM (
      SELECT DISTINCT
        sii.id,
        sii.quantity
      FROM sales_invoice_items sii
      JOIN sales_invoices si ON si.id = sii.invoice_id
      LEFT JOIN delivery_challan_items dci ON dci.id = sii.delivery_challan_item_id
      LEFT JOIN delivery_challans dc ON dc.id = dci.challan_id
      WHERE COALESCE(si.is_draft, false) = false
        AND si.invoice_number NOT ILIKE 'TEST-COGS-%'
        AND COALESCE(si.sales_order_id, dc.sales_order_id) = p_so_id
    ) x;

  UPDATE sales_orders
     SET status = CASE
                    WHEN v_ordered > 0 AND v_delivered >= v_ordered AND v_invoiced >= v_ordered
                      THEN 'closed'::sales_order_status
                    WHEN v_ordered > 0 AND v_delivered >= v_ordered
                      THEN 'delivered'::sales_order_status
                    WHEN v_delivered > 0
                      THEN 'partially_delivered'::sales_order_status
                    ELSE status
                  END,
         updated_at = now()
   WHERE id = p_so_id
     AND status NOT IN ('closed', 'cancelled', 'rejected');
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_recompute_so_delivered(p_so_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.fn_recompute_so_status(p_so_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.update_so_delivered_quantity_atomic(
  p_sales_order_id uuid,
  p_dc_items jsonb[]
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.fn_recompute_so_status(p_sales_order_id);
END;
$$;

DO $$
DECLARE
  v_so RECORD;
BEGIN
  FOR v_so IN SELECT id FROM sales_orders
  LOOP
    PERFORM public.fn_recompute_so_status(v_so.id);
  END LOOP;
END $$;

COMMIT;
