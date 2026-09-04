-- Inventory V1 mathematically provable historical metadata repairs.
--
-- Source report:
-- audit-reports/inventory-reconciliation-revalidation-20260801/
--
-- This migration never changes batches.current_stock, movement quantities,
-- reservations, Delivery Challans, invoices, or accounting records. It only
-- marks duplicate legacy Delivery Challan movement evidence as superseded.

BEGIN;

DO $inventory_v1_provable_repairs$
DECLARE
  v_updated integer;
BEGIN
  -- Batch 4001/1101/25/A-3145
  IF NOT EXISTS (
    SELECT 1
    FROM public.batches
    WHERE id = 'cb7b0b87-79be-40e5-844d-b2bcfed2727e'
      AND batch_number = '4001/1101/25/A-3145'
      AND current_stock = 0
  ) THEN
    RAISE EXCEPTION
      'Repair precondition changed for batch 4001/1101/25/A-3145';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.delivery_challan_items dci
    JOIN public.delivery_challans dc ON dc.id = dci.challan_id
    WHERE dci.id = '422748c3-4595-47a5-83c7-4cd1d60df2da'
      AND dci.batch_id = 'cb7b0b87-79be-40e5-844d-b2bcfed2727e'
      AND dci.quantity = 600
      AND dc.approval_status::text = 'approved'
  ) THEN
    RAISE EXCEPTION
      'Repair source document changed for batch 4001/1101/25/A-3145';
  END IF;

  IF (
    SELECT count(*)
    FROM public.inventory_transactions
    WHERE id IN (
      'bcb32e37-4ce5-4660-b9ef-59fa44fa2b67',
      'd3339284-bba1-4b11-9dfe-29413481c861'
    )
      AND batch_id = 'cb7b0b87-79be-40e5-844d-b2bcfed2727e'
      AND transaction_type = 'delivery_challan'
      AND quantity = -600
      AND reference_number = 'DO-25-0009'
      AND COALESCE((metadata->>'superseded')::boolean, false) = false
  ) <> 2 THEN
    RAISE EXCEPTION
      'Repair movement evidence changed for batch 4001/1101/25/A-3145';
  END IF;

  -- Batch 4001/1101/25/A-3146
  IF NOT EXISTS (
    SELECT 1
    FROM public.batches
    WHERE id = 'c20fe01a-fbe3-43ba-93cc-0a2175fee19a'
      AND batch_number = '4001/1101/25/A-3146'
      AND current_stock = 50
  ) THEN
    RAISE EXCEPTION
      'Repair precondition changed for batch 4001/1101/25/A-3146';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.delivery_challan_items dci
    JOIN public.delivery_challans dc ON dc.id = dci.challan_id
    WHERE dci.id = '69abdea3-8975-4a3e-955d-7db7e944937d'
      AND dci.batch_id = 'c20fe01a-fbe3-43ba-93cc-0a2175fee19a'
      AND dci.quantity = 50
      AND dc.approval_status::text = 'approved'
  ) THEN
    RAISE EXCEPTION
      'Repair source document changed for batch 4001/1101/25/A-3146';
  END IF;

  IF (
    SELECT count(*)
    FROM public.inventory_transactions
    WHERE id IN (
      '6165ec64-4f05-4038-98f0-253778bb248f',
      '7b7fee55-8466-40b3-8097-7b72570a4572',
      '6c4d2e70-c6eb-41e0-a7bd-4de5c169da34'
    )
      AND batch_id = 'c20fe01a-fbe3-43ba-93cc-0a2175fee19a'
      AND transaction_type = 'delivery_challan'
      AND quantity = -50
      AND reference_number = 'DO-25-0007'
      AND COALESCE((metadata->>'superseded')::boolean, false) = false
  ) <> 3 THEN
    RAISE EXCEPTION
      'Repair movement evidence changed for batch 4001/1101/25/A-3146';
  END IF;

  PERFORM set_config('app.canonical_stock_engine', 'on', true);

  UPDATE public.inventory_transactions
  SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
    'superseded', true,
    'superseded_reason',
      'Inventory V1 verified duplicate Delivery Challan movement',
    'superseded_at', clock_timestamp(),
    'superseded_by_migration',
      '20260801122000_inventory_v1_provable_legacy_metadata_repairs'
  )
  WHERE id IN (
    'bcb32e37-4ce5-4660-b9ef-59fa44fa2b67',
    '6165ec64-4f05-4038-98f0-253778bb248f',
    '7b7fee55-8466-40b3-8097-7b72570a4572'
  )
    AND COALESCE((metadata->>'superseded')::boolean, false) = false;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated <> 3 THEN
    RAISE EXCEPTION
      'Expected to supersede 3 duplicate movement rows, updated %',
      v_updated;
  END IF;

  PERFORM set_config('app.canonical_stock_engine', '', true);
END;
$inventory_v1_provable_repairs$;

COMMIT;
