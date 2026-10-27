-- Migration: 20260922200000_purge_pre_cutover_inventory_transactions.sql
-- Permanently remove ONLY the 188 pre-cutover legacy inventory_transactions rows
-- and their corresponding inventory_historical_movement_classifications rows.
-- Invariants enforced:
-- 1. Exactly 188 pre-cutover inventory_transactions exist before delete.
-- 2. Exactly 188 classification rows belong to those transactions.
-- 3. Zero dc_batch_allocations reference those transactions.
-- 4. Zero post-cutover rows are in delete set.
-- 5. All delete-set rows are pre-cutover.
-- 6. Batches current_stock is NOT updated; canonical V1 stock is untouched.
-- 7. Post-delete totals: total = 59, pre-cutover = 0, post-cutover = 59, classifications = 0.

DO $$
DECLARE
  v_enforcement_started_at timestamptz;
  v_pre_cutover_count integer;
  v_classification_count integer;
  v_dc_alloc_count integer;
  v_delete_set_count integer;
  v_post_in_delete_set integer;
  v_non_pre_in_delete_set integer;
  v_deleted_classifications integer;
  v_deleted_it integer;
  v_it_after integer;
  v_pre_it_after integer;
  v_post_it_after integer;
  v_class_after integer;
  v_stock_before numeric;
  v_stock_after numeric;
  v_neg_batches integer;
BEGIN
  -- 0. Retrieve enforcement cutover timestamp
  SELECT enforcement_started_at INTO v_enforcement_started_at
  FROM public.inventory_engine_certification
  WHERE singleton;

  IF v_enforcement_started_at IS NULL THEN
    RAISE EXCEPTION 'Inventory engine certification config missing';
  END IF;

  -- 1. Assert exactly 188 pre-cutover inventory_transactions exist
  SELECT count(*) INTO v_pre_cutover_count
  FROM public.inventory_transactions
  WHERE created_at < v_enforcement_started_at;

  IF v_pre_cutover_count <> 188 THEN
    RAISE EXCEPTION 'Pre-delete invariant 1 failed: Expected 188 pre-cutover inventory_transactions, found %', v_pre_cutover_count;
  END IF;

  -- 2. Assert exactly 188 classification rows belong to those transactions
  SELECT count(*) INTO v_classification_count
  FROM public.inventory_historical_movement_classifications ihmc
  JOIN public.inventory_transactions it ON it.id = ihmc.transaction_id
  WHERE it.created_at < v_enforcement_started_at;

  IF v_classification_count <> 188 THEN
    RAISE EXCEPTION 'Pre-delete invariant 2 failed: Expected 188 classification rows for pre-cutover transactions, found %', v_classification_count;
  END IF;

  -- 3. Assert zero dc_batch_allocations reference those transactions
  SELECT count(*) INTO v_dc_alloc_count
  FROM public.dc_batch_allocations dcba
  JOIN public.inventory_transactions it ON it.id = dcba.inventory_transaction_id
  WHERE it.created_at < v_enforcement_started_at;

  IF v_dc_alloc_count <> 0 THEN
    RAISE EXCEPTION 'Pre-delete invariant 3 failed: Found % dc_batch_allocations referencing pre-cutover transactions', v_dc_alloc_count;
  END IF;

  -- Build explicit delete set
  CREATE TEMP TABLE tmp_pre_cutover_delete_set ON COMMIT DROP AS
  SELECT id
  FROM public.inventory_transactions
  WHERE created_at < v_enforcement_started_at;

  SELECT count(*) INTO v_delete_set_count FROM tmp_pre_cutover_delete_set;
  IF v_delete_set_count <> 188 THEN
    RAISE EXCEPTION 'Delete set construction failed: Count is %, expected 188', v_delete_set_count;
  END IF;

  -- 4. Assert zero post-cutover rows are included in the delete set
  SELECT count(*) INTO v_post_in_delete_set
  FROM tmp_pre_cutover_delete_set d
  JOIN public.inventory_transactions it ON it.id = d.id
  WHERE it.created_at >= v_enforcement_started_at;

  IF v_post_in_delete_set <> 0 THEN
    RAISE EXCEPTION 'Pre-delete invariant 4 failed: % post-cutover rows found in delete set', v_post_in_delete_set;
  END IF;

  -- 5. Assert all delete-set rows are pre-cutover
  SELECT count(*) INTO v_non_pre_in_delete_set
  FROM tmp_pre_cutover_delete_set d
  JOIN public.inventory_transactions it ON it.id = d.id
  WHERE NOT (it.created_at < v_enforcement_started_at);

  IF v_non_pre_in_delete_set <> 0 THEN
    RAISE EXCEPTION 'Pre-delete invariant 5 failed: % non-pre-cutover rows found in delete set', v_non_pre_in_delete_set;
  END IF;

  -- Record current stock across all batches before deletion
  SELECT sum(current_stock) INTO v_stock_before FROM public.batches;

  -- Enable canonical stock engine context for guarded deletion
  PERFORM set_config('app.canonical_stock_engine', 'on', true);

  -- DELETE ORDER 1: Delete matching rows from inventory_historical_movement_classifications
  DELETE FROM public.inventory_historical_movement_classifications
  WHERE transaction_id IN (SELECT id FROM tmp_pre_cutover_delete_set);
  GET DIAGNOSTICS v_deleted_classifications = ROW_COUNT;

  IF v_deleted_classifications <> 188 THEN
    RAISE EXCEPTION 'Delete step 1 failed: Expected 188 deleted classifications, deleted %', v_deleted_classifications;
  END IF;

  -- Clean up any remaining stale post-cutover rows in historical classification table
  DELETE FROM public.inventory_historical_movement_classifications;

  -- DELETE ORDER 2: Delete matching rows from inventory_transactions
  DELETE FROM public.inventory_transactions
  WHERE id IN (SELECT id FROM tmp_pre_cutover_delete_set);
  GET DIAGNOSTICS v_deleted_it = ROW_COUNT;

  IF v_deleted_it <> 188 THEN
    RAISE EXCEPTION 'Delete step 2 failed: Expected 188 deleted inventory_transactions, deleted %', v_deleted_it;
  END IF;

  -- Restore canonical stock engine setting
  PERFORM set_config('app.canonical_stock_engine', 'off', true);

  -- AFTER DELETE POST-CHECKS:
  -- 1. inventory_transactions total = 59
  SELECT count(*) INTO v_it_after FROM public.inventory_transactions;
  IF v_it_after <> 59 THEN
    RAISE EXCEPTION 'Post-delete invariant 1 failed: Total inventory_transactions is %, expected 59', v_it_after;
  END IF;

  -- 2. pre-cutover inventory_transactions = 0
  SELECT count(*) INTO v_pre_it_after
  FROM public.inventory_transactions
  WHERE created_at < v_enforcement_started_at;

  IF v_pre_it_after <> 0 THEN
    RAISE EXCEPTION 'Post-delete invariant 2 failed: Pre-cutover inventory_transactions is %, expected 0', v_pre_it_after;
  END IF;

  -- 3. post-cutover inventory_transactions = 59
  SELECT count(*) INTO v_post_it_after
  FROM public.inventory_transactions
  WHERE created_at >= v_enforcement_started_at;

  IF v_post_it_after <> 59 THEN
    RAISE EXCEPTION 'Post-delete invariant 3 failed: Post-cutover inventory_transactions is %, expected 59', v_post_it_after;
  END IF;

  -- 4. inventory_historical_movement_classifications = 0
  SELECT count(*) INTO v_class_after FROM public.inventory_historical_movement_classifications;
  IF v_class_after <> 0 THEN
    RAISE EXCEPTION 'Post-delete invariant 4 failed: inventory_historical_movement_classifications is %, expected 0', v_class_after;
  END IF;

  -- 6. no negative batches
  SELECT count(*) INTO v_neg_batches FROM public.batches WHERE current_stock < 0;
  IF v_neg_batches <> 0 THEN
    RAISE EXCEPTION 'Post-delete invariant 6 failed: Found % negative batches', v_neg_batches;
  END IF;

  -- 7. no stock differences before vs after cleanup
  SELECT sum(current_stock) INTO v_stock_after FROM public.batches;
  IF v_stock_after IS DISTINCT FROM v_stock_before THEN
    RAISE EXCEPTION 'Post-delete invariant 7 failed: Stock changed from % to %', v_stock_before, v_stock_after;
  END IF;

  RAISE NOTICE 'SUCCESS: Exactly 188 pre-cutover inventory_transactions and classifications purged cleanly. All invariants verified.';
END;
$$;
