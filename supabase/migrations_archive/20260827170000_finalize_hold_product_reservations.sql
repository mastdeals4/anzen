/*
 * Final conversion of the two verified Corn Starch SO commitments that were
 * deliberately held out of 20260827150000 while their pending DC source links
 * were ambiguous. The live fingerprints below make this migration fail closed.
 *
 * Quantity effect: representation only. No physical stock, ordered/delivered
 * quantity, DC approval state, or inventory movement is changed.
 */
BEGIN;

LOCK TABLE public.stock_reservations IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.so_product_reservations IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.so_product_reservation_events IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.sales_orders, public.sales_order_items,
  public.delivery_challans, public.delivery_challan_items,
  public.batches, public.inventory_transactions IN SHARE MODE;

CREATE TEMP TABLE _hold_ids(id uuid PRIMARY KEY) ON COMMIT DROP;
INSERT INTO _hold_ids(id) VALUES
  ('b45e28c8-3a68-4398-ae2f-97b4b767bd78'),
  ('f7428c8d-68fd-473f-9d14-ce5b77a98768'),
  ('fcfc7045-b456-40df-b897-d8e7f6b066e1');

CREATE TEMP TABLE _final_before ON COMMIT DROP AS
SELECT
  (SELECT count(*) FROM public.stock_reservations
    WHERE status='active' AND NOT is_released) active_legacy_count,
  (SELECT COALESCE(sum(reserved_quantity),0) FROM public.stock_reservations
    WHERE status='active' AND NOT is_released) active_legacy_quantity,
  (SELECT count(*) FROM public.so_product_reservations WHERE status='active') active_product_count,
  (SELECT COALESCE(sum(reserved_quantity),0) FROM public.so_product_reservations
    WHERE status='active') active_product_quantity,
  (SELECT md5(COALESCE(string_agg(id::text||':'||current_stock::text,'|' ORDER BY id),''))
    FROM public.batches) physical_fingerprint,
  (SELECT md5(COALESCE(string_agg(id::text||':'||quantity::text||':'||COALESCE(delivered_quantity,0)::text,'|' ORDER BY id),''))
    FROM public.sales_order_items) so_quantity_fingerprint,
  (SELECT COALESCE(sum(GREATEST(soi.quantity-COALESCE(soi.delivered_quantity,0),0)),0)
    FROM public.sales_order_items soi JOIN public.sales_orders so ON so.id=soi.sales_order_id
    WHERE so.status::text NOT IN ('rejected','cancelled','delivered','closed')) outstanding_so_quantity,
  (SELECT count(*) FROM public.inventory_transactions) inventory_transaction_count,
  (SELECT COALESCE(sum(dci.quantity),0)
    FROM public.delivery_challan_items dci JOIN public.delivery_challans dc ON dc.id=dci.challan_id
    WHERE dc.approval_status='pending_approval') pending_dc_quantity,
  (SELECT md5(COALESCE(string_agg(dci.id::text||':'||dci.quantity::text||':'||dci.batch_id::text,'|' ORDER BY dci.id),''))
    FROM public.delivery_challan_items dci JOIN public.delivery_challans dc ON dc.id=dci.challan_id
    WHERE dc.approval_status='pending_approval') pending_dc_fingerprint,
  public.product_available_to_promise('76a03a5b-c02d-49b0-8ed3-6f53d61a62c9',NULL) corn_starch_atp;

DO $validate_before$
DECLARE v public.stock_reservations%ROWTYPE;
BEGIN
  IF to_regclass('public.so_product_reservations') IS NULL
     OR to_regclass('public.so_product_reservation_status') IS NULL
     OR to_regclass('public.so_product_reservation_events') IS NULL
     OR to_regclass('public.dc_batch_allocations') IS NULL THEN
    RAISE EXCEPTION 'Product reservation architecture is not deployed';
  END IF;

  IF (SELECT active_legacy_count FROM _final_before)<>3
     OR (SELECT active_legacy_quantity FROM _final_before)<>1000
     OR (SELECT active_product_count FROM _final_before)<>11
     OR (SELECT active_product_quantity FROM _final_before)<>15630 THEN
    RAISE EXCEPTION 'Unexpected production reservation totals';
  END IF;

  IF EXISTS(
    SELECT 1 FROM public.stock_reservations sr
    WHERE sr.status='active' AND NOT sr.is_released
      AND NOT EXISTS(SELECT 1 FROM _hold_ids h WHERE h.id=sr.id)
  ) THEN RAISE EXCEPTION 'An unapproved active legacy reservation exists'; END IF;

  SELECT * INTO v FROM public.stock_reservations WHERE id='b45e28c8-3a68-4398-ae2f-97b4b767bd78';
  IF NOT FOUND OR v.sales_order_id<>'8e0e1b59-2985-43aa-81a1-79a1a7e71270'
     OR v.sales_order_item_id<>'8b71b173-be85-4dce-8dfd-731f08e3ed0e'
     OR v.product_id<>'76a03a5b-c02d-49b0-8ed3-6f53d61a62c9'
     OR v.batch_id<>'3f33b652-59ec-4fbb-91a5-0cc01f2a0266'
     OR v.reserved_quantity<>25 OR v.status<>'active' OR v.is_released THEN
    RAISE EXCEPTION 'SO-2026-0033 25kg HOLD fingerprint changed';
  END IF;

  SELECT * INTO v FROM public.stock_reservations WHERE id='f7428c8d-68fd-473f-9d14-ce5b77a98768';
  IF NOT FOUND OR v.sales_order_id<>'8e0e1b59-2985-43aa-81a1-79a1a7e71270'
     OR v.sales_order_item_id<>'8b71b173-be85-4dce-8dfd-731f08e3ed0e'
     OR v.product_id<>'76a03a5b-c02d-49b0-8ed3-6f53d61a62c9'
     OR v.batch_id<>'dd162acf-2ce7-4d27-8515-9652c7d17bd5'
     OR v.reserved_quantity<>475 OR v.status<>'active' OR v.is_released THEN
    RAISE EXCEPTION 'SO-2026-0033 475kg HOLD fingerprint changed';
  END IF;

  SELECT * INTO v FROM public.stock_reservations WHERE id='fcfc7045-b456-40df-b897-d8e7f6b066e1';
  IF NOT FOUND OR v.sales_order_id<>'0ec5fe1c-2a9b-45ba-8ba5-49ff87e27649'
     OR v.sales_order_item_id<>'2b56a673-7b97-4bad-8617-99407588d8ad'
     OR v.product_id<>'76a03a5b-c02d-49b0-8ed3-6f53d61a62c9'
     OR v.batch_id<>'dd162acf-2ce7-4d27-8515-9652c7d17bd5'
     OR v.reserved_quantity<>500 OR v.status<>'active' OR v.is_released THEN
    RAISE EXCEPTION 'SO-2026-0034 500kg HOLD fingerprint changed';
  END IF;

  IF EXISTS(
    SELECT 1 FROM public.sales_orders so JOIN public.sales_order_items soi ON soi.sales_order_id=so.id
    WHERE so.so_number IN ('SO-2026-0033','SO-2026-0034')
      AND (so.status::text NOT IN ('approved','stock_reserved','pending_delivery','partially_delivered')
        OR soi.product_id<>'76a03a5b-c02d-49b0-8ed3-6f53d61a62c9'
        OR soi.quantity<>500 OR COALESCE(soi.delivered_quantity,0)<>0)
  ) OR (SELECT count(*) FROM public.sales_order_items WHERE sales_order_id IN
      ('8e0e1b59-2985-43aa-81a1-79a1a7e71270','0ec5fe1c-2a9b-45ba-8ba5-49ff87e27649'))<>2 THEN
    RAISE EXCEPTION 'HOLD Sales Order state changed';
  END IF;

  IF EXISTS(
    SELECT 1 FROM public.delivery_challans dc JOIN public.delivery_challan_items dci ON dci.challan_id=dc.id
    WHERE dc.id IN ('b35bf359-8d1e-482d-9915-0ae193ddb55d','f8cf0f00-fe5f-4801-8f5d-7d84499c21f1')
      AND (dc.approval_status<>'pending_approval' OR dci.sales_order_item_id IS NOT NULL
        OR dci.product_id<>'76a03a5b-c02d-49b0-8ed3-6f53d61a62c9'
        OR dci.batch_id<>'9639ae2c-3629-40be-89d1-4b8a141e868d' OR dci.quantity<>500)
  ) OR (SELECT count(*) FROM public.delivery_challan_items WHERE challan_id IN
      ('b35bf359-8d1e-482d-9915-0ae193ddb55d','f8cf0f00-fe5f-4801-8f5d-7d84499c21f1'))<>2 THEN
    RAISE EXCEPTION 'Pending HOLD DC fingerprint changed';
  END IF;

  IF EXISTS(
    SELECT 1 FROM public.delivery_challans dc JOIN public.delivery_challan_items dci ON dci.challan_id=dc.id
    WHERE dc.sales_order_id IN ('8e0e1b59-2985-43aa-81a1-79a1a7e71270','0ec5fe1c-2a9b-45ba-8ba5-49ff87e27649')
      AND dc.approval_status='approved'
  ) THEN RAISE EXCEPTION 'An approved DC already consumed a HOLD SO'; END IF;

  IF EXISTS(SELECT 1 FROM public.so_product_reservations WHERE sales_order_item_id IN
      ('8b71b173-be85-4dce-8dfd-731f08e3ed0e','2b56a673-7b97-4bad-8617-99407588d8ad')) THEN
    RAISE EXCEPTION 'Product reservation history already exists for a HOLD SO item';
  END IF;

  IF EXISTS(SELECT 1 FROM public.inventory_transactions WHERE reference_id IN
      ('b35bf359-8d1e-482d-9915-0ae193ddb55d','f8cf0f00-fe5f-4801-8f5d-7d84499c21f1'))
     OR EXISTS(SELECT 1 FROM public.dc_batch_allocations WHERE delivery_challan_id IN
      ('b35bf359-8d1e-482d-9915-0ae193ddb55d','f8cf0f00-fe5f-4801-8f5d-7d84499c21f1')) THEN
    RAISE EXCEPTION 'A HOLD DC already has inventory or allocation history';
  END IF;
END
$validate_before$;

CREATE TEMP TABLE _new_hold_product_reservations ON COMMIT DROP AS
WITH grouped AS (
  SELECT sr.sales_order_id,sr.sales_order_item_id,sr.product_id,
    sum(sr.reserved_quantity) reserved_quantity,array_agg(sr.id ORDER BY sr.id) legacy_ids
  FROM public.stock_reservations sr JOIN _hold_ids h ON h.id=sr.id
  GROUP BY sr.sales_order_id,sr.sales_order_item_id,sr.product_id
), inserted AS (
  INSERT INTO public.so_product_reservations(
    sales_order_id,sales_order_item_id,product_id,reserved_quantity,status,
    legacy_reservation_ids,close_reason
  )
  SELECT sales_order_id,sales_order_item_id,product_id,reserved_quantity,'active',legacy_ids,
    'Final conversion of verified HOLD legacy reservations'
  FROM grouped ORDER BY sales_order_item_id
  RETURNING *
)
SELECT * FROM inserted;

INSERT INTO public.so_product_reservation_events(
  reservation_id,sales_order_id,sales_order_item_id,event_type,
  quantity_delta,quantity_after,reason
)
SELECT id,sales_order_id,sales_order_item_id,'created',reserved_quantity,reserved_quantity,
  'Authorized final conversion of verified HOLD legacy reservations'
FROM _new_hold_product_reservations;

-- Restore the canonical source-item links proven by the DC header FK, the
-- unique SO item, matching product, and the legacy reservation relationship.
UPDATE public.delivery_challan_items
SET sales_order_item_id='8b71b173-be85-4dce-8dfd-731f08e3ed0e'
WHERE id='493ba84e-62df-4655-9027-f80988bbc16b'
  AND challan_id='b35bf359-8d1e-482d-9915-0ae193ddb55d'
  AND sales_order_item_id IS NULL;
UPDATE public.delivery_challan_items
SET sales_order_item_id='2b56a673-7b97-4bad-8617-99407588d8ad'
WHERE id='930ebe35-4458-4ad7-9203-5e814168acb8'
  AND challan_id='f8cf0f00-fe5f-4801-8f5d-7d84499c21f1'
  AND sales_order_item_id IS NULL;

UPDATE public.stock_reservations sr
SET status='released',is_released=true,released_at=now(),
  release_reason='Converted to product-level SO reservation; legacy ID retained for audit'
FROM _hold_ids h WHERE h.id=sr.id;

-- These legacy mutation RPCs are not used by the current application. Keep
-- them available to service_role for historical administration, but prevent
-- normal authenticated workflows from mutating batch-level SO reservations.
REVOKE EXECUTE ON FUNCTION public.inventory_v1_consume_reservation(uuid,uuid,uuid,numeric,uuid) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_release_partial_reservation(uuid,uuid,numeric,uuid) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_release_reservation_by_so_id(uuid,uuid) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_release_stock_reservations(uuid,text,uuid) FROM PUBLIC,anon,authenticated;

DO $validate_after$
DECLARE v_before _final_before%ROWTYPE;
BEGIN
  SELECT * INTO v_before FROM _final_before;

  IF (SELECT count(*) FROM _new_hold_product_reservations)<>2
     OR (SELECT sum(reserved_quantity) FROM _new_hold_product_reservations)<>1000 THEN
    RAISE EXCEPTION 'Final HOLD product reservation insert mismatch';
  END IF;
  IF EXISTS(SELECT 1 FROM public.stock_reservations sr JOIN _hold_ids h ON h.id=sr.id
    WHERE sr.status<>'released' OR NOT sr.is_released OR sr.released_at IS NULL) THEN
    RAISE EXCEPTION 'A HOLD legacy row was not preserved as released history';
  END IF;
  IF EXISTS(SELECT 1 FROM public.stock_reservations WHERE status='active' AND NOT is_released) THEN
    RAISE EXCEPTION 'An active batch-level SO reservation remains';
  END IF;
  IF (SELECT count(*) FROM public.so_product_reservations WHERE status='active')<>v_before.active_product_count+2
     OR (SELECT COALESCE(sum(reserved_quantity),0) FROM public.so_product_reservations WHERE status='active')<>v_before.active_product_quantity+1000 THEN
    RAISE EXCEPTION 'Active product reservation totals changed unexpectedly';
  END IF;
  IF v_before.active_legacy_quantity+v_before.active_product_quantity <>
     (SELECT COALESCE(sum(reserved_quantity),0) FROM public.so_product_reservations WHERE status='active') THEN
    RAISE EXCEPTION 'Total active commitment changed';
  END IF;

  IF v_before.physical_fingerprint<>(SELECT md5(COALESCE(string_agg(id::text||':'||current_stock::text,'|' ORDER BY id),'')) FROM public.batches)
    THEN RAISE EXCEPTION 'Physical stock changed'; END IF;
  IF v_before.so_quantity_fingerprint<>(SELECT md5(COALESCE(string_agg(id::text||':'||quantity::text||':'||COALESCE(delivered_quantity,0)::text,'|' ORDER BY id),'')) FROM public.sales_order_items)
    THEN RAISE EXCEPTION 'SO ordered or delivered quantity changed'; END IF;
  IF v_before.outstanding_so_quantity<>(SELECT COALESCE(sum(GREATEST(soi.quantity-COALESCE(soi.delivered_quantity,0),0)),0) FROM public.sales_order_items soi JOIN public.sales_orders so ON so.id=soi.sales_order_id WHERE so.status::text NOT IN ('rejected','cancelled','delivered','closed'))
    THEN RAISE EXCEPTION 'SO outstanding quantity changed'; END IF;
  IF v_before.inventory_transaction_count<>(SELECT count(*) FROM public.inventory_transactions)
    THEN RAISE EXCEPTION 'An inventory movement was created'; END IF;
  IF v_before.pending_dc_quantity<>(SELECT COALESCE(sum(dci.quantity),0) FROM public.delivery_challan_items dci JOIN public.delivery_challans dc ON dc.id=dci.challan_id WHERE dc.approval_status='pending_approval')
     OR v_before.pending_dc_fingerprint<>(SELECT md5(COALESCE(string_agg(dci.id::text||':'||dci.quantity::text||':'||dci.batch_id::text,'|' ORDER BY dci.id),'')) FROM public.delivery_challan_items dci JOIN public.delivery_challans dc ON dc.id=dci.challan_id WHERE dc.approval_status='pending_approval')
    THEN RAISE EXCEPTION 'Pending DC quantity or batch selection changed'; END IF;
  IF v_before.corn_starch_atp<>public.product_available_to_promise('76a03a5b-c02d-49b0-8ed3-6f53d61a62c9',NULL)
    THEN RAISE EXCEPTION 'Corn Starch ATP changed'; END IF;

  IF EXISTS(SELECT 1 FROM (SELECT sales_order_item_id FROM public.so_product_reservations WHERE status='active' GROUP BY sales_order_item_id HAVING count(*)>1)d)
    THEN RAISE EXCEPTION 'Duplicate active product reservation'; END IF;
  IF EXISTS(SELECT 1 FROM public.so_product_reservations WHERE reserved_quantity<0)
    THEN RAISE EXCEPTION 'Negative product reservation'; END IF;
  IF EXISTS(SELECT 1 FROM public.so_product_reservations r LEFT JOIN public.sales_order_items soi ON soi.id=r.sales_order_item_id LEFT JOIN public.sales_orders so ON so.id=r.sales_order_id LEFT JOIN public.products p ON p.id=r.product_id WHERE soi.id IS NULL OR so.id IS NULL OR p.id IS NULL OR soi.sales_order_id<>r.sales_order_id OR soi.product_id<>r.product_id)
    THEN RAISE EXCEPTION 'Orphan product reservation'; END IF;
  IF EXISTS(SELECT 1 FROM public.so_product_reservations r JOIN public.sales_orders so ON so.id=r.sales_order_id WHERE r.status='active' AND so.status::text IN ('rejected','cancelled','delivered','closed'))
    THEN RAISE EXCEPTION 'Stale active product reservation'; END IF;
  IF EXISTS(SELECT 1 FROM public.so_product_reservations r JOIN public.sales_order_items soi ON soi.id=r.sales_order_item_id WHERE r.status='active' AND r.reserved_quantity>soi.quantity-COALESCE((SELECT sum(dci.quantity) FROM public.delivery_challan_items dci JOIN public.delivery_challans dc ON dc.id=dci.challan_id WHERE dci.sales_order_item_id=soi.id AND dc.approval_status='approved'),0))
    THEN RAISE EXCEPTION 'Active reservation exceeds SO outstanding quantity'; END IF;
  IF EXISTS(SELECT 1 FROM public.batches b WHERE b.reserved_stock<>COALESCE((SELECT sum(sr.reserved_quantity) FROM public.stock_reservations sr WHERE sr.batch_id=b.id AND sr.status='active' AND NOT sr.is_released),0))
    THEN RAISE EXCEPTION 'batches.reserved_stock is inconsistent with active legacy rows'; END IF;
  IF EXISTS(SELECT 1 FROM public.delivery_challan_items WHERE id='493ba84e-62df-4655-9027-f80988bbc16b' AND sales_order_item_id<>'8b71b173-be85-4dce-8dfd-731f08e3ed0e')
     OR EXISTS(SELECT 1 FROM public.delivery_challan_items WHERE id='930ebe35-4458-4ad7-9203-5e814168acb8' AND sales_order_item_id<>'2b56a673-7b97-4bad-8617-99407588d8ad') THEN
    RAISE EXCEPTION 'Pending DC source-item link was not restored';
  END IF;

  RAISE NOTICE 'FINAL_HOLD_PRODUCT_RESERVATION_OK product_count=13 product_quantity=16630 active_legacy=0 commitment_delta=0 physical_delta=0 delivered_delta=0 outstanding_delta=0 pending_dc_delta=0 inventory_movement_delta=0';
END
$validate_after$;

COMMIT;
