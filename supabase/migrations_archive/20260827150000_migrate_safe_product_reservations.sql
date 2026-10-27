/*
 * Authorized production conversion of the 19 deterministic active legacy
 * reservations. The three HOLD_AMBIGUOUS_PENDING_DC rows are guarded by a
 * complete row fingerprint and are never selected for update.
 */
BEGIN;

LOCK TABLE public.stock_reservations IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.so_product_reservations IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.so_product_reservation_events IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.sales_orders,public.sales_order_items,public.delivery_challans,
  public.delivery_challan_items,public.batches,public.inventory_transactions IN SHARE MODE;

CREATE TEMP TABLE _safe_reservation_ids(id uuid PRIMARY KEY) ON COMMIT DROP;
INSERT INTO _safe_reservation_ids(id) VALUES
  ('75249644-06a6-4371-9301-5f3318d49308'),
  ('e855fd6d-dff6-40b9-8029-7c2b5a5674b6'),
  ('5be6ec8b-b34f-4e03-bf0f-5161f208058e'),
  ('db4a651a-3a7d-4c7f-84a3-121dfec0d56f'),
  ('2d3dcf0f-4d4c-431f-84aa-9384661939b0'),
  ('38b3cf1f-b3aa-4374-86fc-e99a918e8c2a'),
  ('96f444e7-d93c-4d03-9710-239adf6ced76'),
  ('a8d9c2b5-0106-486d-a45c-4ff5d5ac7310'),
  ('fc23616e-25ec-4d06-bb49-72fb6fd6fc86'),
  ('0d8aa034-3319-40a5-847a-c3a1b1fd82b9'),
  ('2c465132-d237-44e9-b8b6-04d938c28a9d'),
  ('4110243b-5684-4392-ae49-aacca9d9a036'),
  ('8a1ea422-4887-42ce-81c7-e9f983b13449'),
  ('e1284ad5-b687-49b6-9d15-86350090aa59'),
  ('4f1a4702-c3c1-4d3c-815d-ccaccf3072bc'),
  ('77c34940-d604-43db-bf61-afcb2094a5f3'),
  ('cff361a4-6f4c-4b5a-a86e-83eae167255d'),
  ('f1d4a52e-d238-4071-bbea-999c87d2c73c'),
  ('d73b569f-6406-4bb6-986a-21d6ee5fe011');

CREATE TEMP TABLE _hold_reservation_ids(id uuid PRIMARY KEY) ON COMMIT DROP;
INSERT INTO _hold_reservation_ids(id) VALUES
  ('b45e28c8-3a68-4398-ae2f-97b4b767bd78'),
  ('f7428c8d-68fd-473f-9d14-ce5b77a98768'),
  ('fcfc7045-b456-40df-b897-d8e7f6b066e1');

CREATE TEMP TABLE _hold_before ON COMMIT DROP AS
SELECT sr.id,to_jsonb(sr) row_fingerprint
FROM public.stock_reservations sr JOIN _hold_reservation_ids h ON h.id=sr.id;

CREATE TEMP TABLE _migration_before ON COMMIT DROP AS
SELECT
  (SELECT md5(COALESCE(string_agg(b.id::text||':'||b.current_stock::text,'|' ORDER BY b.id),'')) FROM public.batches b) physical_fingerprint,
  (SELECT md5(COALESCE(string_agg(soi.id::text||':'||soi.quantity::text||':'||COALESCE(soi.delivered_quantity,0)::text,'|' ORDER BY soi.id),'')) FROM public.sales_order_items soi) so_quantity_fingerprint,
  (SELECT COALESCE(sum(GREATEST(soi.quantity-COALESCE(soi.delivered_quantity,0),0)),0)
     FROM public.sales_order_items soi JOIN public.sales_orders so ON so.id=soi.sales_order_id
    WHERE so.status::text NOT IN ('rejected','cancelled','delivered','closed')) outstanding_so_quantity,
  (SELECT count(*) FROM public.inventory_transactions) inventory_transaction_count,
  (SELECT md5(COALESCE(string_agg(dci.id::text||':'||dci.quantity::text||':'||dci.batch_id::text,'|' ORDER BY dci.id),''))
     FROM public.delivery_challan_items dci JOIN public.delivery_challans dc ON dc.id=dci.challan_id
    WHERE dc.approval_status='pending_approval') pending_dc_fingerprint,
  (SELECT COALESCE(sum(dci.quantity),0)
     FROM public.delivery_challan_items dci JOIN public.delivery_challans dc ON dc.id=dci.challan_id
    WHERE dc.approval_status='pending_approval') pending_dc_quantity;

CREATE TEMP TABLE _migration_products ON COMMIT DROP AS
SELECT DISTINCT sr.product_id
FROM public.stock_reservations sr
JOIN (SELECT id FROM _safe_reservation_ids UNION ALL SELECT id FROM _hold_reservation_ids) x ON x.id=sr.id;

CREATE TEMP TABLE _atp_before ON COMMIT DROP AS
SELECT product_id,public.product_available_to_promise(product_id,NULL) atp
FROM _migration_products;

DO $validate_before$
DECLARE v_count integer; v_quantity numeric;
BEGIN
  SELECT count(*),COALESCE(sum(sr.reserved_quantity),0) INTO v_count,v_quantity
  FROM public.stock_reservations sr JOIN _safe_reservation_ids s ON s.id=sr.id
  WHERE sr.status='active' AND NOT sr.is_released;
  IF v_count<>19 OR v_quantity<>15630 THEN
    RAISE EXCEPTION 'SAFE reservation precondition failed: rows %, quantity %',v_count,v_quantity;
  END IF;
  IF (SELECT count(*) FROM _hold_before)<>3 OR
     (SELECT COALESCE(sum(sr.reserved_quantity),0) FROM public.stock_reservations sr JOIN _hold_reservation_ids h ON h.id=sr.id WHERE sr.status='active' AND NOT sr.is_released)<>1000 THEN
    RAISE EXCEPTION 'HOLD reservation precondition failed';
  END IF;
  IF EXISTS(SELECT 1 FROM _safe_reservation_ids s JOIN _hold_reservation_ids h ON h.id=s.id) THEN
    RAISE EXCEPTION 'SAFE and HOLD reservation sets overlap';
  END IF;
  IF EXISTS(
    SELECT 1 FROM public.stock_reservations sr JOIN _safe_reservation_ids s ON s.id=sr.id
    WHERE sr.status<>'active' OR sr.is_released
  ) THEN RAISE EXCEPTION 'Historical or released reservation selected'; END IF;
  IF EXISTS(
    WITH approved AS (
      SELECT dci.sales_order_item_id,COALESCE(sum(dci.quantity),0) quantity
      FROM public.delivery_challan_items dci JOIN public.delivery_challans dc ON dc.id=dci.challan_id
      WHERE dc.approval_status='approved' GROUP BY dci.sales_order_item_id
    ), legacy AS (
      SELECT sr.sales_order_item_id,sum(sr.reserved_quantity) quantity
      FROM public.stock_reservations sr JOIN _safe_reservation_ids s ON s.id=sr.id
      GROUP BY sr.sales_order_item_id
    )
    SELECT 1 FROM legacy l JOIN public.sales_order_items soi ON soi.id=l.sales_order_item_id
    LEFT JOIN approved a ON a.sales_order_item_id=soi.id
    WHERE l.quantity<>soi.quantity-COALESCE(a.quantity,0)
  ) THEN RAISE EXCEPTION 'SAFE reservation does not equal ordered minus valid delivered'; END IF;
  IF EXISTS(
    SELECT 1 FROM public.so_product_reservations r
    WHERE r.status='active' AND r.sales_order_item_id IN (
      SELECT sr.sales_order_item_id FROM public.stock_reservations sr JOIN _safe_reservation_ids s ON s.id=sr.id
    )
  ) THEN RAISE EXCEPTION 'Duplicate product reservation would be created'; END IF;
END
$validate_before$;

WITH grouped AS (
  SELECT sr.sales_order_id,sr.sales_order_item_id,sr.product_id,
         sum(sr.reserved_quantity) reserved_quantity,array_agg(sr.id ORDER BY sr.id) legacy_ids
  FROM public.stock_reservations sr JOIN _safe_reservation_ids s ON s.id=sr.id
  GROUP BY sr.sales_order_id,sr.sales_order_item_id,sr.product_id
), inserted AS (
  INSERT INTO public.so_product_reservations(
    sales_order_id,sales_order_item_id,product_id,reserved_quantity,status,legacy_reservation_ids,close_reason
  )
  SELECT sales_order_id,sales_order_item_id,product_id,reserved_quantity,'active',legacy_ids,
         'Migrated from deterministic active legacy reservations'
  FROM grouped ORDER BY sales_order_item_id
  RETURNING *
)
INSERT INTO public.so_product_reservation_events(
  reservation_id,sales_order_id,sales_order_item_id,event_type,quantity_delta,quantity_after,reason
)
SELECT id,sales_order_id,sales_order_item_id,'created',reserved_quantity,reserved_quantity,
       'Authorized production migration from legacy batch reservations'
FROM inserted;

UPDATE public.stock_reservations sr
SET status='released',is_released=true,released_at=now(),
    release_reason='Converted to product-level SO reservation; legacy ID retained for audit'
FROM _safe_reservation_ids s
WHERE sr.id=s.id;

DO $validate_after$
DECLARE
  v_product_quantity numeric; v_hold_quantity numeric; v_total_commitment numeric;
  v_duplicate_count integer; v_orphan_count integer; v_stale_count integer;
  v_before _migration_before%ROWTYPE;
BEGIN
  SELECT * INTO v_before FROM _migration_before;
  SELECT COALESCE(sum(r.reserved_quantity),0) INTO v_product_quantity
  FROM public.so_product_reservations r WHERE r.status='active';
  SELECT COALESCE(sum(sr.reserved_quantity),0) INTO v_hold_quantity
  FROM public.stock_reservations sr JOIN _hold_reservation_ids h ON h.id=sr.id
  WHERE sr.status='active' AND NOT sr.is_released;
  SELECT v_product_quantity+COALESCE(sum(sr.reserved_quantity),0) INTO v_total_commitment
  FROM public.stock_reservations sr
  WHERE sr.status='active' AND NOT sr.is_released
    AND NOT EXISTS(SELECT 1 FROM public.so_product_reservations r WHERE sr.id=ANY(r.legacy_reservation_ids));

  IF v_product_quantity<>15630 OR v_hold_quantity<>1000 OR v_total_commitment<>16630 THEN
    RAISE EXCEPTION 'Post-migration commitment mismatch: product %, hold %, total %',v_product_quantity,v_hold_quantity,v_total_commitment;
  END IF;
  IF EXISTS(
    SELECT 1 FROM _hold_before b LEFT JOIN public.stock_reservations sr ON sr.id=b.id
    WHERE sr.id IS NULL OR to_jsonb(sr)<>b.row_fingerprint
  ) THEN RAISE EXCEPTION 'A HOLD reservation changed'; END IF;
  IF (SELECT count(*) FROM _hold_before)<>3 THEN RAISE EXCEPTION 'HOLD fingerprint count changed'; END IF;
  IF EXISTS(SELECT 1 FROM _safe_reservation_ids s JOIN public.stock_reservations sr ON sr.id=s.id WHERE sr.status<>'released' OR NOT sr.is_released) THEN
    RAISE EXCEPTION 'A SAFE legacy row was not released';
  END IF;

  SELECT count(*) INTO v_duplicate_count FROM (
    SELECT sales_order_item_id FROM public.so_product_reservations WHERE status='active' GROUP BY sales_order_item_id HAVING count(*)>1
  ) d;
  IF v_duplicate_count<>0 THEN RAISE EXCEPTION 'Duplicate active product reservations: %',v_duplicate_count; END IF;
  IF EXISTS(SELECT 1 FROM public.so_product_reservations WHERE reserved_quantity<0) THEN RAISE EXCEPTION 'Negative product reservation'; END IF;
  SELECT count(*) INTO v_orphan_count
  FROM public.so_product_reservations r LEFT JOIN public.sales_order_items soi ON soi.id=r.sales_order_item_id
  LEFT JOIN public.sales_orders so ON so.id=r.sales_order_id LEFT JOIN public.products p ON p.id=r.product_id
  WHERE soi.id IS NULL OR so.id IS NULL OR p.id IS NULL OR soi.sales_order_id<>r.sales_order_id OR soi.product_id<>r.product_id;
  IF v_orphan_count<>0 THEN RAISE EXCEPTION 'Orphan product reservations: %',v_orphan_count; END IF;
  SELECT count(*) INTO v_stale_count
  FROM public.so_product_reservations r JOIN public.sales_orders so ON so.id=r.sales_order_id
  WHERE r.status='active' AND so.status::text IN ('rejected','cancelled','delivered','closed');
  IF v_stale_count<>0 THEN RAISE EXCEPTION 'Stale active product reservations: %',v_stale_count; END IF;

  IF v_before.physical_fingerprint<>(SELECT md5(COALESCE(string_agg(b.id::text||':'||b.current_stock::text,'|' ORDER BY b.id),'')) FROM public.batches b) THEN
    RAISE EXCEPTION 'Physical stock changed';
  END IF;
  IF v_before.so_quantity_fingerprint<>(SELECT md5(COALESCE(string_agg(soi.id::text||':'||soi.quantity::text||':'||COALESCE(soi.delivered_quantity,0)::text,'|' ORDER BY soi.id),'')) FROM public.sales_order_items soi) THEN
    RAISE EXCEPTION 'SO ordered or delivered quantity changed';
  END IF;
  IF v_before.outstanding_so_quantity<>(SELECT COALESCE(sum(GREATEST(soi.quantity-COALESCE(soi.delivered_quantity,0),0)),0) FROM public.sales_order_items soi JOIN public.sales_orders so ON so.id=soi.sales_order_id WHERE so.status::text NOT IN ('rejected','cancelled','delivered','closed')) THEN
    RAISE EXCEPTION 'Outstanding SO quantity changed';
  END IF;
  IF v_before.inventory_transaction_count<>(SELECT count(*) FROM public.inventory_transactions) THEN RAISE EXCEPTION 'Inventory movement was created'; END IF;
  IF v_before.pending_dc_fingerprint<>(SELECT md5(COALESCE(string_agg(dci.id::text||':'||dci.quantity::text||':'||dci.batch_id::text,'|' ORDER BY dci.id),'')) FROM public.delivery_challan_items dci JOIN public.delivery_challans dc ON dc.id=dci.challan_id WHERE dc.approval_status='pending_approval') OR
     v_before.pending_dc_quantity<>(SELECT COALESCE(sum(dci.quantity),0) FROM public.delivery_challan_items dci JOIN public.delivery_challans dc ON dc.id=dci.challan_id WHERE dc.approval_status='pending_approval') THEN
    RAISE EXCEPTION 'Pending DC data changed';
  END IF;
  IF EXISTS(SELECT 1 FROM _atp_before b WHERE b.atp<>public.product_available_to_promise(b.product_id,NULL)) THEN RAISE EXCEPTION 'ATP changed'; END IF;

  RAISE NOTICE 'SAFE_PRODUCT_RESERVATION_MIGRATION_OK product_units=%, hold_units=%, total_commitment=%, duplicates=%, negatives=0, orphans=%, stale=% physical_delta=0 delivered_delta=0 atp_delta=0 outstanding_delta=0 pending_dc_delta=0',
    v_product_quantity,v_hold_quantity,v_total_commitment,v_duplicate_count,v_orphan_count,v_stale_count;
END
$validate_after$;

COMMIT;
