/*
  # Fix stale stock reservation for SO-2026-0022 / Corn Starch BP

  ## Problem
  After DO-26-0014 was approved (delivering 11,000 kg: 2,550 from B108/2026 + 8,450
  from B109/2026), the SO-level reservation of 3,900 kg on batch B108/2026 was never
  released. This leaves batches.reserved_stock = 3,900 on B108/2026, which blocks
  creation of a new delivery challan for the remaining 7,000 kg because the trigger
  `trg_delivery_challan_item_inventory` rejects any insert where:
    reserved_stock + new_quantity > current_stock
    (3,900 + 7,000 = 10,900 > 6,450 → ERROR)

  ## Fix
  1. Mark the stale active reservation (id=5d79a25d) as released.
  2. Zero out batches.reserved_stock on B108/2026 — no other active reservations
     reference it, so the correct value is 0.

  ## Data safety
  - current_stock on B108/2026 (6,450 kg) is correct and is NOT changed.
  - Releasing this reservation does not affect any other SO or transaction.
  - After this fix the user can create a new DC for up to 7,025 kg (all available
    Corn Starch stock: 6,450 + 550 + 25) against SO-2026-0022.
*/

-- 1. Release the stale SO-level reservation on B108/2026 for SO-2026-0022
UPDATE stock_reservations
SET
  status      = 'released',
  is_released = true,
  released_at = now(),
  release_reason = 'Stale reservation — stock already delivered via DO-26-0014 approval; released to unblock remaining DC creation'
WHERE id = '5d79a25d-9a70-4a86-8cb5-6caf1aa50de7'
  AND sales_order_id = '3baff7a7-40da-44bc-a0dc-6f50098a4ecd'
  AND batch_id       = 'fbe27e70-5828-4a2d-a1d7-a8b5394328eb'
  AND status         = 'active';

-- 2. Correct batches.reserved_stock on B108/2026 to 0
--    (verified: no other active reservations reference this batch)
UPDATE batches
SET reserved_stock = 0
WHERE id = 'fbe27e70-5828-4a2d-a1d7-a8b5394328eb'
  AND product_id   = '76a03a5b-c02d-49b0-8ed3-6f53d61a62c9';
