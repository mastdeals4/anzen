/* Atomic creation of sales invoices and their source-linked lines. */
CREATE OR REPLACE FUNCTION public.create_sales_invoice_atomic(
  p_invoice jsonb,
  p_items jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_role text;
  v_invoice_id uuid;
  v_subtotal numeric := 0;
  v_tax numeric := 0;
  v_discount numeric := COALESCE((p_invoice->>'discount_amount')::numeric, 0);
  v_stamp numeric := COALESCE((p_invoice->>'stamp_duty_amount')::numeric, 0);
  v_total numeric;
  v_count integer := 0;
  v_item jsonb;
  v_product uuid;
  v_batch uuid;
  v_dc_item uuid;
  v_qty numeric;
  v_price numeric;
  v_rate numeric;
  v_dc record;
  v_linked_challans uuid[];
  v_invoice_so_id uuid := NULLIF(p_invoice->>'sales_order_id','')::uuid;
BEGIN
  SELECT role INTO v_role FROM public.user_profiles WHERE id = auth.uid();
  IF v_role IS NULL OR v_role NOT IN ('admin','accounts','sales','manager','warehouse') THEN
    RAISE EXCEPTION 'Permission denied: role % cannot create sales invoices', v_role;
  END IF;
  IF jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Sales invoice requires at least one product line';
  END IF;
  IF NULLIF(p_invoice->>'invoice_number','') IS NULL OR NULLIF(p_invoice->>'customer_id','') IS NULL THEN
    RAISE EXCEPTION 'Invoice number and customer are required';
  END IF;
  IF EXISTS (SELECT 1 FROM public.sales_invoices WHERE invoice_number=p_invoice->>'invoice_number') THEN
    RAISE EXCEPTION 'Invoice number already exists';
  END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_items)
  LOOP
    v_product := NULLIF(v_item->>'product_id','')::uuid;
    v_batch := NULLIF(v_item->>'batch_id','')::uuid;
    v_dc_item := NULLIF(v_item->>'delivery_challan_item_id','')::uuid;
    v_qty := (v_item->>'quantity')::numeric;
    v_price := (v_item->>'unit_price')::numeric;
    v_rate := COALESCE((v_item->>'tax_rate')::numeric, 0);
    IF v_product IS NULL OR v_dc_item IS NULL OR COALESCE(v_qty,0) <= 0 OR COALESCE(v_price,0) < 0 THEN
      RAISE EXCEPTION 'Every invoice line must have a source Delivery Challan item, product, quantity, and price';
    END IF;
    SELECT dci.product_id,dci.batch_id,dci.quantity,dc.customer_id,dc.approval_status
      INTO v_dc
    FROM public.delivery_challan_items dci
    JOIN public.delivery_challans dc ON dc.id=dci.challan_id
    WHERE dci.id=v_dc_item
    FOR SHARE;
    IF NOT FOUND OR v_dc.product_id IS DISTINCT FROM v_product OR v_dc.batch_id IS DISTINCT FROM v_batch
       OR v_dc.customer_id IS DISTINCT FROM (p_invoice->>'customer_id')::uuid
       OR v_dc.approval_status <> 'approved' THEN
      RAISE EXCEPTION 'Invoice line source Delivery Challan is invalid or not approved';
    END IF;
    IF v_invoice_so_id IS NOT NULL AND v_dc.sales_order_id IS DISTINCT FROM v_invoice_so_id THEN
      RAISE EXCEPTION 'Invoice Sales Order does not match its Delivery Challan source';
    END IF;
    IF v_qty > v_dc.quantity - COALESCE((SELECT sum(sii.quantity) FROM public.sales_invoice_items sii
      WHERE sii.delivery_challan_item_id=v_dc_item),0) THEN
      RAISE EXCEPTION 'Invoice quantity exceeds remaining Delivery Challan quantity';
    END IF;
    v_subtotal := v_subtotal + (v_qty * v_price);
    v_tax := v_tax + (v_qty * v_price * v_rate / 100);
    v_count := v_count + 1;
  END LOOP;
  v_total := v_subtotal + v_tax - v_discount + v_stamp;
  SELECT array_agg(DISTINCT dc.id) INTO v_linked_challans
  FROM public.delivery_challan_items dci
  JOIN public.delivery_challans dc ON dc.id=dci.challan_id
  WHERE dci.id IN (SELECT (value->>'delivery_challan_item_id')::uuid FROM jsonb_array_elements(p_items));
  IF p_invoice ? 'subtotal' AND abs(v_subtotal - (p_invoice->>'subtotal')::numeric) > 0.01
     OR p_invoice ? 'tax_amount' AND abs(v_tax - (p_invoice->>'tax_amount')::numeric) > 0.01
     OR p_invoice ? 'total_amount' AND abs(v_total - (p_invoice->>'total_amount')::numeric) > 0.01 THEN
    RAISE EXCEPTION 'Invoice totals do not match persisted product lines';
  END IF;

  INSERT INTO public.sales_invoices (
    invoice_number,customer_id,sales_order_id,invoice_date,due_date,discount_amount,
    delivery_challan_number,po_number,payment_terms_days,notes,subtotal,tax_amount,
    stamp_duty_amount,total_amount,payment_status,created_by,linked_challan_ids
  ) VALUES (
    p_invoice->>'invoice_number',(p_invoice->>'customer_id')::uuid,v_invoice_so_id,
    COALESCE((p_invoice->>'invoice_date')::date,CURRENT_DATE),(p_invoice->>'due_date')::date,v_discount,
    NULL,p_invoice->>'po_number',(p_invoice->>'payment_terms_days')::integer,p_invoice->>'notes',
    v_subtotal,v_tax,v_stamp,v_total,'pending',COALESCE(NULLIF(p_invoice->>'created_by','')::uuid,auth.uid()),
    COALESCE(v_linked_challans, CASE WHEN jsonb_typeof(p_invoice->'linked_challan_ids')='array' THEN
      ARRAY(SELECT jsonb_array_elements_text(p_invoice->'linked_challan_ids')::uuid) ELSE NULL END)
  ) RETURNING id INTO v_invoice_id;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_items)
  LOOP
    INSERT INTO public.sales_invoice_items
      (invoice_id,product_id,batch_id,quantity,unit_price,tax_rate,delivery_challan_item_id)
    VALUES (v_invoice_id,(v_item->>'product_id')::uuid,NULLIF(v_item->>'batch_id','')::uuid,
      (v_item->>'quantity')::numeric,(v_item->>'unit_price')::numeric,
      COALESCE((v_item->>'tax_rate')::numeric,0),(v_item->>'delivery_challan_item_id')::uuid);
  END LOOP;

  IF (SELECT count(*) FROM public.sales_invoice_items WHERE invoice_id=v_invoice_id) <> v_count THEN
    RAISE EXCEPTION 'Invoice line count verification failed';
  END IF;
  RETURN v_invoice_id;
END;
$$;

REVOKE ALL ON FUNCTION public.create_sales_invoice_atomic(jsonb,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_sales_invoice_atomic(jsonb,jsonb) TO authenticated,service_role;
