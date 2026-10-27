-- Product reservation/DC lifecycle regression against the deployed schema.
-- Every write is enclosed in this transaction and rolled back at EOF.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

DO $regression$
DECLARE
  v_customer uuid := 'ecee37f8-13fb-4c4f-a4da-7bae788131ce';
  v_actor uuid;
  v_product uuid := '76a03a5b-c02d-49b0-8ed3-6f53d61a62c9';
  v_batch uuid := '9639ae2c-3629-40be-89d1-4b8a141e868d';
  v_so uuid := gen_random_uuid();
  v_item uuid := gen_random_uuid();
  v_dc1 uuid := gen_random_uuid();
  v_dci1 uuid := gen_random_uuid();
  v_dc2 uuid := gen_random_uuid();
  v_dci2 uuid := gen_random_uuid();
  v_fail_so uuid := gen_random_uuid();
  v_fail_item uuid := gen_random_uuid();
  v_fail_dc uuid := gen_random_uuid();
  v_fail_dci uuid := gen_random_uuid();
  v_small_batch uuid := gen_random_uuid();
  v_before_stock numeric;
  v_before_tx_count bigint;
  v_failed boolean;
BEGIN
  SELECT created_by INTO v_actor FROM public.sales_orders WHERE so_number='SO-2026-0033';
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Regression actor is unavailable'; END IF;

  INSERT INTO public.sales_orders(
    id,so_number,customer_id,customer_po_number,customer_po_date,so_date,
    status,subtotal_amount,tax_amount,total_amount,created_by
  ) VALUES(v_so,'TEST-PRODUCT-RES-'||substr(v_so::text,1,8),v_customer,
    'ROLLBACK-ONLY',CURRENT_DATE,CURRENT_DATE,'draft',500,0,500,v_actor);
  INSERT INTO public.sales_order_items(
    id,sales_order_id,product_id,quantity,unit_price,line_total
  ) VALUES(v_item,v_so,v_product,500,1,500);

  PERFORM public.approve_sales_order_product_reservation_v2(v_so,v_actor);
  IF (SELECT reserved_quantity FROM public.so_product_reservations WHERE sales_order_item_id=v_item AND status='active')<>500
    THEN RAISE EXCEPTION 'Approval did not create the 500-unit product reservation'; END IF;
  IF EXISTS(SELECT 1 FROM public.stock_reservations WHERE sales_order_item_id=v_item)
    THEN RAISE EXCEPTION 'Approval recreated a batch-level reservation'; END IF;

  -- APPROVE -> REJECT -> RE-APPROVE.
  UPDATE public.sales_orders SET status='rejected',rejected_by=v_actor,rejected_at=now(),rejection_reason='rollback regression' WHERE id=v_so;
  IF EXISTS(SELECT 1 FROM public.so_product_reservations WHERE sales_order_item_id=v_item AND status='active')
    THEN RAISE EXCEPTION 'Rejected SO retained an active reservation'; END IF;
  PERFORM public.approve_sales_order_product_reservation_v2(v_so,v_actor);
  IF (SELECT reserved_quantity FROM public.so_product_reservations WHERE sales_order_item_id=v_item AND status='active')<>500
    THEN RAISE EXCEPTION 'Re-approval did not recreate the reservation'; END IF;

  -- APPROVE -> REJECT -> EDIT -> RE-APPROVE.
  UPDATE public.sales_orders SET status='rejected',rejected_by=v_actor,rejected_at=now(),rejection_reason='rollback edit regression' WHERE id=v_so;
  UPDATE public.sales_order_items SET quantity=400,line_total=400 WHERE id=v_item;
  PERFORM public.approve_sales_order_product_reservation_v2(v_so,v_actor);
  IF (SELECT reserved_quantity FROM public.so_product_reservations WHERE sales_order_item_id=v_item AND status='active')<>400
    THEN RAISE EXCEPTION 'Edited SO re-approval did not reserve the recalculated quantity'; END IF;

  SELECT current_stock INTO v_before_stock FROM public.batches WHERE id=v_batch;
  SELECT count(*) INTO v_before_tx_count FROM public.inventory_transactions;

  -- Two independent DC batch selections: partial 150 then remaining 250.
  INSERT INTO public.delivery_challans(id,challan_number,customer_id,challan_date,delivery_address,created_by,sales_order_id)
    VALUES(v_dc1,'TEST-DC-PARTIAL-'||substr(v_dc1::text,1,8),v_customer,CURRENT_DATE,'rollback only',v_actor,v_so);
  INSERT INTO public.delivery_challan_items(id,challan_id,sales_order_item_id,product_id,batch_id,quantity)
    VALUES(v_dci1,v_dc1,v_item,v_product,v_batch,150);
  UPDATE public.delivery_challans SET approval_status='approved',approval_operation_id=gen_random_uuid(),approved_by=v_actor,approved_at=now() WHERE id=v_dc1;
  IF (SELECT reserved_quantity FROM public.so_product_reservations WHERE sales_order_item_id=v_item AND status='active')<>250
     OR (SELECT delivered_quantity FROM public.sales_order_items WHERE id=v_item)<>150
     OR (SELECT current_stock FROM public.batches WHERE id=v_batch)<>v_before_stock-150
     OR NOT EXISTS(SELECT 1 FROM public.dc_batch_allocations WHERE delivery_challan_item_id=v_dci1 AND status='consumed')
    THEN RAISE EXCEPTION 'Partial DC did not atomically consume reservation, batch, allocation and delivery'; END IF;

  INSERT INTO public.delivery_challans(id,challan_number,customer_id,challan_date,delivery_address,created_by,sales_order_id)
    VALUES(v_dc2,'TEST-DC-FINAL-'||substr(v_dc2::text,1,8),v_customer,CURRENT_DATE,'rollback only',v_actor,v_so);
  INSERT INTO public.delivery_challan_items(id,challan_id,sales_order_item_id,product_id,batch_id,quantity)
    VALUES(v_dci2,v_dc2,v_item,v_product,v_batch,250);
  UPDATE public.delivery_challans SET approval_status='approved',approval_operation_id=gen_random_uuid(),approved_by=v_actor,approved_at=now() WHERE id=v_dc2;
  IF EXISTS(SELECT 1 FROM public.so_product_reservations WHERE sales_order_item_id=v_item AND status='active')
     OR (SELECT reserved_quantity FROM public.so_product_reservations WHERE sales_order_item_id=v_item ORDER BY created_at DESC LIMIT 1)<>0
     OR (SELECT delivered_quantity FROM public.sales_order_items WHERE id=v_item)<>400
     OR (SELECT current_stock FROM public.batches WHERE id=v_batch)<>v_before_stock-400
     OR (SELECT count(*) FROM public.inventory_transactions)<>v_before_tx_count+2
    THEN RAISE EXCEPTION 'Final partial DC did not close the product reservation atomically'; END IF;

  -- Failure matrix: insufficient selected-batch stock rolls the entire approval back.
  PERFORM set_config('app.canonical_stock_engine','on',true);
  INSERT INTO public.batches(id,batch_number,product_id,import_date,import_quantity,current_stock,import_price,expiry_date,is_active)
    VALUES(v_small_batch,'TEST-SMALL-'||substr(v_small_batch::text,1,8),v_product,CURRENT_DATE,10,10,1,CURRENT_DATE+365,true);
  PERFORM set_config('app.canonical_stock_engine','',true);
  INSERT INTO public.sales_orders(id,so_number,customer_id,customer_po_number,customer_po_date,so_date,status,subtotal_amount,tax_amount,total_amount,created_by)
    VALUES(v_fail_so,'TEST-PRODUCT-FAIL-'||substr(v_fail_so::text,1,8),v_customer,'ROLLBACK-ONLY',CURRENT_DATE,CURRENT_DATE,'draft',100,0,100,v_actor);
  INSERT INTO public.sales_order_items(id,sales_order_id,product_id,quantity,unit_price,line_total)
    VALUES(v_fail_item,v_fail_so,v_product,100,1,100);
  PERFORM public.approve_sales_order_product_reservation_v2(v_fail_so,v_actor);
  v_failed:=false;
  BEGIN
    INSERT INTO public.so_product_reservations(sales_order_id,sales_order_item_id,product_id,reserved_quantity)
      VALUES(v_fail_so,v_fail_item,v_product,1);
  EXCEPTION WHEN unique_violation THEN v_failed:=true;
  END;
  IF NOT v_failed THEN RAISE EXCEPTION 'Duplicate active reservation was accepted'; END IF;
  INSERT INTO public.delivery_challans(id,challan_number,customer_id,challan_date,delivery_address,created_by,sales_order_id)
    VALUES(v_fail_dc,'TEST-DC-FAIL-'||substr(v_fail_dc::text,1,8),v_customer,CURRENT_DATE,'rollback only',v_actor,v_fail_so);
  INSERT INTO public.delivery_challan_items(id,challan_id,sales_order_item_id,product_id,batch_id,quantity)
    VALUES(v_fail_dci,v_fail_dc,v_fail_item,v_product,v_small_batch,20);
  v_failed:=false;
  BEGIN
    UPDATE public.delivery_challans SET approval_status='approved',approval_operation_id=gen_random_uuid(),approved_by=v_actor,approved_at=now() WHERE id=v_fail_dc;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT ILIKE '%insufficient physical stock%' THEN RAISE; END IF;
    v_failed:=true;
  END;
  IF NOT v_failed
     OR (SELECT approval_status FROM public.delivery_challans WHERE id=v_fail_dc)<>'pending_approval'
     OR (SELECT current_stock FROM public.batches WHERE id=v_small_batch)<>10
     OR (SELECT reserved_quantity FROM public.so_product_reservations WHERE sales_order_item_id=v_fail_item AND status='active')<>100
     OR (SELECT delivered_quantity FROM public.sales_order_items WHERE id=v_fail_item)<>0
     OR EXISTS(SELECT 1 FROM public.dc_batch_allocations WHERE delivery_challan_item_id=v_fail_dci)
    THEN RAISE EXCEPTION 'Insufficient-stock approval was not atomic'; END IF;

  -- Insufficient reservation also leaves DC, batch and delivered quantity untouched.
  UPDATE public.delivery_challan_items SET batch_id=v_batch,quantity=100 WHERE id=v_fail_dci;
  UPDATE public.so_product_reservations SET reserved_quantity=50 WHERE sales_order_item_id=v_fail_item AND status='active';
  v_failed:=false;
  BEGIN
    UPDATE public.delivery_challans SET approval_status='approved',approval_operation_id=gen_random_uuid(),approved_by=v_actor,approved_at=now() WHERE id=v_fail_dc;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT ILIKE '%exceeds remaining SO product reservation%' THEN RAISE; END IF;
    v_failed:=true;
  END;
  IF NOT v_failed
     OR (SELECT approval_status FROM public.delivery_challans WHERE id=v_fail_dc)<>'pending_approval'
     OR (SELECT current_stock FROM public.batches WHERE id=v_batch)<>v_before_stock-400
     OR (SELECT delivered_quantity FROM public.sales_order_items WHERE id=v_fail_item)<>0
     OR EXISTS(SELECT 1 FROM public.dc_batch_allocations WHERE delivery_challan_item_id=v_fail_dci)
    THEN RAISE EXCEPTION 'Insufficient-reservation approval was not atomic'; END IF;

  IF EXISTS(SELECT 1 FROM public.so_product_reservations r JOIN public.sales_orders so ON so.id=r.sales_order_id WHERE r.status='active' AND so.status::text IN ('rejected','cancelled','delivered','closed'))
    THEN RAISE EXCEPTION 'Regression created a stale active reservation'; END IF;

  RAISE NOTICE 'PRODUCT_RESERVATION_V2_LIVE_REGRESSION_OK';
END
$regression$;

ROLLBACK;
