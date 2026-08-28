/*
  # Fix Cefixime Trihydrate stale reservation from SO-2025-0003

  ## Problem
  Batch M1CFX10003725N (Cefixime Trihydrate Powder Micronized) has:
    current_stock  = 100 kg
    reserved_stock = 100 kg  (entire batch locked)

  The reservation belongs to SO-2025-0003 (status = 'stock_reserved', 0 delivered,
  created 2025-12-04). The order was never delivered and is stale — the full 100 kg
  should be freely available for new orders.

  ## Fix
  1. Release the active reservation record.
  2. Recompute batches.reserved_stock via the same recalc pattern used elsewhere
     (trg_sync_batch_reserved_stock will handle it, but we also do it explicitly).
  3. Mark SO-2025-0003 as 'cancelled' so it no longer blocks stock.

  ## Safety
  - current_stock on the batch is NOT changed (100 kg physical stock is correct).
  - No inventory transactions are created — this is a reservation-only correction.
*/

-- 1. Release the stale reservation
UPDATE stock_reservations
SET
  status         = 'released',
  is_released    = true,
  released_at    = now(),
  release_reason = 'Stale reservation — SO-2025-0003 never delivered; released to restore available stock'
WHERE id = 'bb4ecaa5-83c7-4f89-a366-20937c647078'
  AND status = 'active';

-- 2. Recompute batches.reserved_stock for this batch
UPDATE batches
SET reserved_stock = COALESCE((
  SELECT SUM(reserved_quantity)
  FROM stock_reservations
  WHERE batch_id = 'c6006905-45c4-40bf-bc49-05c86e6e1ad0'
    AND status = 'active'
), 0)
WHERE id = 'c6006905-45c4-40bf-bc49-05c86e6e1ad0';

-- 3. Mark SO-2025-0003 as cancelled (it was never progressed past stock_reserved)
UPDATE sales_orders
SET status = 'cancelled', updated_at = now()
WHERE so_number = 'SO-2025-0003'
  AND status = 'stock_reserved';
