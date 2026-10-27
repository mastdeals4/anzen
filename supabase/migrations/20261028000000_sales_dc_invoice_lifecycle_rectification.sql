-- ==============================================================================
-- Sales Order -> Delivery Challan -> Sales Invoice Lifecycle Rectification
-- ==============================================================================
-- 1. Updates DC reversal triggers (trg_dc_reverse_product_reservation_v2 and
--    trg_dc_reverse_inventory_v1) to allow reversing an approved Delivery Challan
--    when its linked invoice has been cancelled.
-- 2. Updates admin_edit_approved_delivery_challan to ignore cancelled invoices.
-- 3. Updates dc_item_invoice_status view to ignore cancelled invoices.
-- 4. Updates dc_invoicing_summary view to ignore cancelled invoices and provide
--    both linked_invoices and linked_invoice_numbers aliases.
-- 5. Updates so_delivery_invoice_status view to ignore cancelled invoices in
--    invoiced_qty and invoice_count.
-- 6. Updates fn_recompute_so_status to ignore cancelled invoices.
-- ==============================================================================

-- 1. Update trg_dc_reverse_product_reservation_v2
CREATE OR REPLACE FUNCTION public.trg_dc_reverse_product_reservation_v2()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  r record;
BEGIN
  IF OLD.approval_status = 'approved' AND NEW.approval_status IN ('rejected', 'cancelled') THEN
    -- Only block DC reversal if there is an active (uncancelled) invoice item referencing it
    IF EXISTS (
      SELECT 1
      FROM public.sales_invoice_items sii
      JOIN public.delivery_challan_items dci ON dci.id = sii.delivery_challan_item_id
      JOIN public.sales_invoices si ON si.id = sii.invoice_id
      WHERE dci.challan_id = NEW.id
        AND NOT (si.notes LIKE '[CANCELLED%' OR LOWER(si.notes) LIKE 'cancelled%')
    ) THEN
      RAISE EXCEPTION 'Approved Delivery Challan already invoiced; reverse invoice first';
    END IF;

    -- Reverse consumed allocations and restore inventory
    FOR r IN
      SELECT dci.*, a.id AS allocation_id
      FROM public.delivery_challan_items dci
      JOIN public.dc_batch_allocations a ON a.delivery_challan_item_id = dci.id AND a.status = 'consumed'
      WHERE dci.challan_id = NEW.id
      ORDER BY dci.id
      FOR UPDATE OF a
    LOOP
      PERFORM public.post_inventory_movement(
        public.uuid_from_text('inventory-v2:dc-reversal:' || NEW.id || ':' || r.id),
        r.product_id,
        r.batch_id,
        'adjustment',
        r.quantity,
        CURRENT_DATE,
        NEW.challan_number,
        'delivery_challan_reversal',
        NEW.id,
        'Reversal of product-reservation DC batch allocation',
        COALESCE(NEW.rejected_by, auth.uid()),
        NULL,
        NULL
      );
      UPDATE public.dc_batch_allocations
      SET status = 'reversed',
          reversed_at = now(),
          reversal_reason = NEW.approval_status
      WHERE id = r.allocation_id;
    END LOOP;

    -- Fallback for legacy DC items without dc_batch_allocations
    FOR r IN
      SELECT dci.*
      FROM public.delivery_challan_items dci
      WHERE dci.challan_id = NEW.id
        AND NOT EXISTS (
          SELECT 1 FROM public.dc_batch_allocations a
          WHERE a.delivery_challan_item_id = dci.id
        )
      ORDER BY dci.id
    LOOP
      PERFORM public.post_inventory_movement(
        public.uuid_from_text('inventory-v1:dc-reversal:' || NEW.id || ':' || r.id || ':' || NEW.approval_status),
        r.product_id,
        r.batch_id,
        'adjustment',
        r.quantity,
        CURRENT_DATE,
        NEW.challan_number,
        'delivery_challan_reversal',
        NEW.id,
        'Canonical reversal of DC ' || NEW.challan_number || ' (' || NEW.approval_status || ')',
        COALESCE(NEW.rejected_by, auth.uid()),
        NULL,
        NULL
      );
    END LOOP;

    IF NEW.sales_order_id IS NOT NULL THEN
      PERFORM public.fn_recompute_so_delivered(NEW.sales_order_id);
      FOR r IN
        SELECT DISTINCT sales_order_item_id
        FROM public.delivery_challan_items
        WHERE challan_id = NEW.id
          AND sales_order_item_id IS NOT NULL
      LOOP
        PERFORM public.reconcile_so_product_reservation_v2(r.sales_order_item_id, 'DC reversal');
      END LOOP;
      PERFORM public.fn_recompute_so_status(NEW.sales_order_id);
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- 2. Update trg_dc_reverse_inventory_v1
CREATE OR REPLACE FUNCTION public.trg_dc_reverse_inventory_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_item record;
BEGIN
  IF OLD.approval_status = 'approved'
     AND NEW.approval_status IN ('rejected', 'cancelled') THEN
    IF EXISTS (
      SELECT 1
      FROM public.sales_invoice_items sii
      JOIN public.delivery_challan_items dci ON dci.id = sii.delivery_challan_item_id
      JOIN public.sales_invoices si ON si.id = sii.invoice_id
      WHERE dci.challan_id = NEW.id
        AND NOT (si.notes LIKE '[CANCELLED%' OR LOWER(si.notes) LIKE 'cancelled%')
    ) THEN
      RAISE EXCEPTION 'Approved Delivery Challan already invoiced; reverse the invoice before cancelling';
    END IF;

    FOR v_item IN
      SELECT *
      FROM public.delivery_challan_items
      WHERE challan_id = NEW.id
      ORDER BY id
    LOOP
      PERFORM public.post_inventory_movement(
        public.uuid_from_text(
          'inventory-v1:dc-reversal:' || NEW.id || ':' || v_item.id || ':' ||
          NEW.approval_status
        ),
        v_item.product_id,
        v_item.batch_id,
        'adjustment',
        v_item.quantity,
        CURRENT_DATE,
        NEW.challan_number,
        'delivery_challan_reversal',
        NEW.id,
        'Canonical reversal of DC ' || NEW.challan_number || ' (' || NEW.approval_status || ')',
        COALESCE(NEW.rejected_by, NEW.approved_by, auth.uid()),
        NULL,
        NULL
      );
    END LOOP;

    IF NEW.sales_order_id IS NOT NULL THEN
      PERFORM public.fn_recompute_so_delivered(NEW.sales_order_id);
      PERFORM public.fn_reserve_stock_for_so_v2(NEW.sales_order_id);
      PERFORM public.fn_recompute_so_status(NEW.sales_order_id);
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- 3. Update admin_edit_approved_delivery_challan
CREATE OR REPLACE FUNCTION public.admin_edit_approved_delivery_challan(
  p_challan_id uuid,
  p_items jsonb,
  p_operation_id uuid DEFAULT gen_random_uuid()
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_challan public.delivery_challans%ROWTYPE;
  v_old_item record;
  v_item jsonb;
  v_item_id uuid;
  v_product_id uuid;
  v_batch_id uuid;
  v_quantity numeric;
BEGIN
  IF NOT public.inventory_v1_actor_allowed(ARRAY['admin']) THEN
    RAISE EXCEPTION 'Only admin can edit an approved Delivery Challan';
  END IF;
  IF p_operation_id IS NULL THEN
    RAISE EXCEPTION 'operation_id is required';
  END IF;

  SELECT *
  INTO v_challan
  FROM public.delivery_challans
  WHERE id = p_challan_id
  FOR UPDATE;

  IF NOT FOUND OR v_challan.approval_status <> 'approved' THEN
    RAISE EXCEPTION 'Approved Delivery Challan not found';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.inventory_transactions
    WHERE reference_type = 'delivery_challan'
      AND reference_id = p_challan_id
      AND COALESCE(metadata->>'canonical_engine_version', '') <> '1.0'
  ) THEN
    RAISE EXCEPTION 'Historical DC movement is ambiguous; manual review is required';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.sales_invoice_items sii
    JOIN public.delivery_challan_items dci ON dci.id = sii.delivery_challan_item_id
    JOIN public.sales_invoices si ON si.id = sii.invoice_id
    WHERE dci.challan_id = p_challan_id
      AND NOT (si.notes LIKE '[CANCELLED%' OR LOWER(si.notes) LIKE 'cancelled%')
  ) THEN
    RAISE EXCEPTION 'Approved Delivery Challan already invoiced; reverse the invoice before editing';
  END IF;

  FOR v_old_item IN
    SELECT *
    FROM public.delivery_challan_items
    WHERE challan_id = p_challan_id
    ORDER BY id
  LOOP
    PERFORM public.post_inventory_movement(
      public.uuid_from_text(
        'inventory-v1:dc-edit-reverse:' || p_operation_id || ':' ||
        v_old_item.id
      ),
      v_old_item.product_id,
      v_old_item.batch_id,
      'adjustment',
      v_old_item.quantity,
      CURRENT_DATE,
      v_challan.challan_number,
      'delivery_challan_edit_reversal',
      p_challan_id,
      'Canonical reversal before approved DC edit',
      auth.uid(),
      NULL,
      NULL
    );
  END LOOP;

  DELETE FROM public.delivery_challan_items
  WHERE challan_id = p_challan_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_item_id := COALESCE(
      NULLIF(v_item->>'id', '')::uuid,
      gen_random_uuid()
    );
    v_product_id := (v_item->>'product_id')::uuid;
    v_batch_id := (v_item->>'batch_id')::uuid;
    v_quantity := (v_item->>'quantity')::numeric;

    IF v_quantity <= 0 THEN
      RAISE EXCEPTION 'Delivery Challan item quantity must be greater than zero';
    END IF;

    INSERT INTO public.delivery_challan_items (
      id,
      challan_id,
      product_id,
      batch_id,
      sales_order_item_id,
      quantity,
      pack_size,
      pack_type,
      number_of_packs
    ) VALUES (
      v_item_id,
      p_challan_id,
      v_product_id,
      v_batch_id,
      NULLIF(v_item->>'sales_order_item_id', '')::uuid,
      v_quantity,
      NULLIF(v_item->>'pack_size', ''),
      NULLIF(v_item->>'pack_type', ''),
      NULLIF(v_item->>'number_of_packs', '')::integer
    );

    PERFORM public.post_inventory_movement(
      public.uuid_from_text(
        'inventory-v1:dc-edit-apply:' || p_operation_id || ':' || v_item_id
      ),
      v_product_id,
      v_batch_id,
      'sale',
      v_quantity,
      CURRENT_DATE,
      v_challan.challan_number,
      'delivery_challan',
      p_challan_id,
      'Canonical delivery challan edit application',
      auth.uid(),
      NULL,
      NULL
    );
  END LOOP;

  IF v_challan.sales_order_id IS NOT NULL THEN
    PERFORM public.fn_recompute_so_delivered(v_challan.sales_order_id);
    PERFORM public.fn_reserve_stock_for_so_v2(v_challan.sales_order_id);
    PERFORM public.fn_recompute_so_status(v_challan.sales_order_id);
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'challan_id', p_challan_id,
    'operation_id', p_operation_id
  );
END;
$$;

-- 4. Update dc_item_invoice_status view
CREATE OR REPLACE VIEW public.dc_item_invoice_status WITH (security_invoker = true) AS
 SELECT dci.id AS dc_item_id,
    dci.challan_id,
    dc.challan_number,
    dc.challan_date,
    dc.customer_id,
    c.company_name AS customer_name,
    dci.product_id,
    p.product_name,
    dci.batch_id,
    b.batch_number,
    dci.quantity AS original_quantity,
    p.unit,
    dci.pack_size,
    dci.pack_type,
    dci.number_of_packs,
    COALESCE(sum(sii.quantity), 0::numeric) AS invoiced_quantity,
    (dci.quantity - COALESCE(sum(sii.quantity), 0::numeric)) AS remaining_quantity,
    CASE
        WHEN (COALESCE(sum(sii.quantity), 0::numeric) = 0::numeric) THEN 'not_invoiced'::text
        WHEN (COALESCE(sum(sii.quantity), 0::numeric) >= dci.quantity) THEN 'fully_invoiced'::text
        ELSE 'partially_invoiced'::text
    END AS status,
    array_agg(DISTINCT si.invoice_number ORDER BY si.invoice_number) FILTER (WHERE si.invoice_number IS NOT NULL) AS invoice_numbers,
    count(DISTINCT sii.invoice_id) AS invoice_count
   FROM public.delivery_challan_items dci
     JOIN public.delivery_challans dc ON dci.challan_id = dc.id
     LEFT JOIN public.customers c ON dc.customer_id = c.id
     LEFT JOIN public.products p ON dci.product_id = p.id
     LEFT JOIN public.batches b ON dci.batch_id = b.id
     LEFT JOIN (
       public.sales_invoice_items sii
       JOIN public.sales_invoices si ON si.id = sii.invoice_id
         AND NOT (si.notes LIKE '[CANCELLED%' OR LOWER(si.notes) LIKE 'cancelled%')
     ) ON dci.id = sii.delivery_challan_item_id
  GROUP BY dci.id, dci.challan_id, dc.challan_number, dc.challan_date, dc.customer_id, c.company_name, dci.product_id, p.product_name, p.unit, dci.batch_id, b.batch_number, dci.quantity, dci.pack_size, dci.pack_type, dci.number_of_packs;

GRANT SELECT ON public.dc_item_invoice_status TO authenticated;

-- 5. Update dc_invoicing_summary view
CREATE OR REPLACE VIEW public.dc_invoicing_summary WITH (security_invoker = true) AS
 SELECT dc.id AS challan_id,
    dc.challan_number,
    dc.customer_id,
    dc.challan_date,
    dc.approval_status,
    count(DISTINCT dci.id) AS total_items,
    count(DISTINCT
        CASE
            WHEN sii.id IS NULL THEN dci.id
            ELSE NULL::uuid
        END) AS not_invoiced_items,
    count(DISTINCT
        CASE
            WHEN sii.id IS NOT NULL THEN dci.id
            ELSE NULL::uuid
        END) AS invoiced_items,
    COALESCE(sum(dci.quantity), 0::numeric) AS total_quantity,
    COALESCE(sum(
        CASE
            WHEN sii.id IS NULL THEN dci.quantity
            ELSE 0::numeric
        END), 0::numeric) AS total_remaining_quantity,
    CASE
        WHEN count(DISTINCT sii.id) = 0 THEN 'not_invoiced'::text
        WHEN count(DISTINCT sii.id) < count(DISTINCT dci.id) THEN 'partially_invoiced'::text
        ELSE 'fully_invoiced'::text
    END AS dc_status,
    COALESCE(array_agg(DISTINCT si.invoice_number) FILTER (WHERE si.invoice_number IS NOT NULL), ARRAY[]::text[]) AS linked_invoices,
    COALESCE(array_agg(DISTINCT si.invoice_number) FILTER (WHERE si.invoice_number IS NOT NULL), ARRAY[]::text[]) AS linked_invoice_numbers
   FROM public.delivery_challans dc
     LEFT JOIN public.delivery_challan_items dci ON dc.id = dci.challan_id
     LEFT JOIN (
       public.sales_invoice_items sii
       JOIN public.sales_invoices si ON si.id = sii.invoice_id
         AND NOT (si.notes LIKE '[CANCELLED%' OR LOWER(si.notes) LIKE 'cancelled%')
     ) ON sii.delivery_challan_item_id = dci.id
  WHERE dc.approval_status = 'approved'::public.dc_approval_status
  GROUP BY dc.id, dc.challan_number, dc.customer_id, dc.challan_date, dc.approval_status;

GRANT SELECT ON public.dc_invoicing_summary TO authenticated;

-- 6. Update so_delivery_invoice_status view
CREATE OR REPLACE VIEW public.so_delivery_invoice_status WITH (security_invoker = true) AS
 WITH ordered AS (
   SELECT soi.sales_order_id AS so_id,
          COALESCE(sum(soi.quantity), 0::numeric) AS ordered_qty
   FROM public.sales_order_items soi
   GROUP BY soi.sales_order_id
 ),
 approved_delivery AS (
   SELECT dc.sales_order_id AS so_id,
          COALESCE(sum(dci.quantity), 0::numeric) AS approved_delivered_qty,
          count(DISTINCT dc.id) AS approved_dc_count
   FROM public.delivery_challans dc
     JOIN public.delivery_challan_items dci ON dci.challan_id = dc.id
   WHERE dc.approval_status = 'approved'::public.dc_approval_status
     AND dc.sales_order_id IS NOT NULL
   GROUP BY dc.sales_order_id
 ),
 invoice_items_by_so AS (
   SELECT DISTINCT sii.id AS invoice_item_id,
          COALESCE(si.sales_order_id, dc.sales_order_id) AS so_id,
          sii.quantity
   FROM public.sales_invoice_items sii
     JOIN public.sales_invoices si ON si.id = sii.invoice_id
     LEFT JOIN public.delivery_challan_items dci ON dci.id = sii.delivery_challan_item_id
     LEFT JOIN public.delivery_challans dc ON dc.id = dci.challan_id
   WHERE COALESCE(si.is_draft, false) = false
     AND si.invoice_number !~~* 'TEST-COGS-%'::text
     AND NOT (si.notes LIKE '[CANCELLED%' OR LOWER(si.notes) LIKE 'cancelled%')
     AND COALESCE(si.sales_order_id, dc.sales_order_id) IS NOT NULL
 ),
 invoiced AS (
   SELECT i_1.so_id,
          COALESCE(sum(i_1.quantity), 0::numeric) AS invoiced_qty,
          count(DISTINCT i_1.invoice_item_id) AS invoice_count
   FROM invoice_items_by_so i_1
   GROUP BY i_1.so_id
 )
 SELECT so.id AS so_id,
    so.so_number,
    so.customer_id,
    so.status AS so_status,
    CASE
        WHEN (COALESCE(ad.approved_delivered_qty, 0::numeric) = 0::numeric) THEN 'pending'::text
        WHEN (COALESCE(ad.approved_delivered_qty, 0::numeric) >= COALESCE(o.ordered_qty, 0::numeric) AND COALESCE(o.ordered_qty, 0::numeric) > 0::numeric) THEN 'completed'::text
        ELSE 'partial'::text
    END AS delivery_status,
    CASE
        WHEN (COALESCE(i.invoiced_qty, 0::numeric) = 0::numeric) THEN 'pending'::text
        WHEN (COALESCE(i.invoiced_qty, 0::numeric) >= COALESCE(o.ordered_qty, 0::numeric) AND COALESCE(o.ordered_qty, 0::numeric) > 0::numeric) THEN 'completed'::text
        ELSE 'partial'::text
    END AS invoice_status,
    CASE
        WHEN (COALESCE(i.invoiced_qty, 0::numeric) > 0::numeric AND COALESCE(ad.approved_delivered_qty, 0::numeric) = 0::numeric) THEN 'invoice_done_delivery_pending'::text
        ELSE NULL::text
    END AS special_status,
    COALESCE(ad.approved_dc_count, 0::bigint) AS approved_dc_count,
    COALESCE(i.invoice_count, 0::bigint) AS invoice_count,
    COALESCE(o.ordered_qty, 0::numeric) AS ordered_qty,
    COALESCE(ad.approved_delivered_qty, 0::numeric) AS approved_delivered_qty,
    COALESCE(i.invoiced_qty, 0::numeric) AS invoiced_qty
   FROM public.sales_orders so
     LEFT JOIN ordered o ON o.so_id = so.id
     LEFT JOIN approved_delivery ad ON ad.so_id = so.id
     LEFT JOIN invoiced i ON i.so_id = so.id;

GRANT SELECT ON public.so_delivery_invoice_status TO authenticated;

-- 7. Update fn_recompute_so_status
CREATE OR REPLACE FUNCTION public.fn_recompute_so_status(p_so_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
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
    FROM public.delivery_challans dc
    JOIN public.delivery_challan_items dci ON dci.challan_id = dc.id
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
    FROM public.sales_order_items soi
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
  UPDATE public.sales_order_items soi
     SET delivered_quantity = allocated.delivered_quantity
    FROM allocated
   WHERE soi.id = allocated.id;

  SELECT COALESCE(SUM(quantity), 0)
    INTO v_ordered
    FROM public.sales_order_items
   WHERE sales_order_id = p_so_id;

  SELECT COALESCE(SUM(dci.quantity), 0)
    INTO v_delivered
    FROM public.delivery_challans dc
    JOIN public.delivery_challan_items dci ON dci.challan_id = dc.id
   WHERE dc.sales_order_id = p_so_id
     AND dc.approval_status = 'approved';

  SELECT COALESCE(SUM(x.quantity), 0)
    INTO v_invoiced
    FROM (
      SELECT DISTINCT
        sii.id,
        sii.quantity
      FROM public.sales_invoice_items sii
      JOIN public.sales_invoices si ON si.id = sii.invoice_id
      LEFT JOIN public.delivery_challan_items dci ON dci.id = sii.delivery_challan_item_id
      LEFT JOIN public.delivery_challans dc ON dc.id = dci.challan_id
      WHERE COALESCE(si.is_draft, false) = false
        AND si.invoice_number NOT ILIKE 'TEST-COGS-%'
        AND NOT (si.notes LIKE '[CANCELLED%' OR LOWER(si.notes) LIKE 'cancelled%')
        AND COALESCE(si.sales_order_id, dc.sales_order_id) = p_so_id
    ) x;

  UPDATE public.sales_orders
     SET status = CASE
                    WHEN v_ordered > 0 AND v_delivered >= v_ordered AND v_invoiced >= v_ordered
                      THEN 'closed'::public.sales_order_status
                    WHEN v_ordered > 0 AND v_delivered >= v_ordered
                      THEN 'delivered'::public.sales_order_status
                    WHEN v_delivered > 0
                      THEN 'partially_delivered'::public.sales_order_status
                    ELSE status
                  END,
         updated_at = now()
   WHERE id = p_so_id
     AND status NOT IN ('closed', 'cancelled', 'rejected');
END;
$$;
