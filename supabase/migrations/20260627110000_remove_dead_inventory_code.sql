/*
  # Cleanup: Remove dead inventory functions and duplicate trigger

  ## What is removed and why

  ### fn_approve_sales_order + fn_approve_sales_order_with_import
  These RPCs wrap fn_reserve_stock_for_so (v1) and approve a SO.
  No frontend code calls them — SalesOrders.tsx calls fn_reserve_stock_for_so_v2
  directly after updating SO status. Dead code confirmed by grep.

  ### fn_reserve_stock_for_so (v1)
  The old reservation function. Called only by the two RPC wrappers above.
  Differences from v2: creates 'reservation' inventory_transactions (deprecated type)
  and did not mark existing reservations as released before re-reserving.
  v2 is the canonical path: called by SalesOrders.tsx and fn_auto_rereserve_on_batch_arrival.

  ### fn_deduct_stock_and_release_reservation
  One-off function that directly updates batches.current_stock and calls
  fn_release_partial_reservation. Never called from frontend or any trigger.
  Stock deduction is canonical in trg_dc_approval_deduct_stock.

  ### fn_approve_delivery_challan
  Old RPC that updated delivery_challans.approval_status (firing the trigger) AND
  independently inserted inventory_transactions + updated stock_reservations.
  If called it would cause double deduction. No frontend calls confirmed.
  DC approval goes through: frontend UPDATE → trg_dc_approval_deduct_stock trigger.

  ### update_batch_stock
  Simple helper that adjusts batches.current_stock without logging a transaction.
  No callers anywhere. Direct stock manipulation without audit trail.

  ### trg_delivery_challan_item_inventory
  Function definition for a DC-item INSERT/DELETE trigger that directly manipulated
  batches.reserved_stock. NOT installed as a trigger on any table. Dead code left
  over from a previous architecture (replaced by trg_auto_release_reservation_on_dc_item).

  ### DUPLICATE TRIGGER: trigger_update_product_stock
  Both trigger_update_product_current_stock and trigger_update_product_stock call
  update_product_current_stock AFTER INSERT OR UPDATE OR DELETE on batches.
  This means the function fires twice per batch change. Drop the duplicate.

  ## What remains (single sources of truth)
  - Stock deduction:      trg_dc_approval_deduct_stock (DC approval trigger)
                          trg_sales_invoice_item_inventory (direct invoices only, no DC)
  - Stock reservation:    fn_reserve_stock_for_so_v2 (frontend + auto-rereserve trigger)
  - Reservation release:  trg_dc_approval_deduct_stock (primary, on DC approval)
                          fn_auto_release_on_so_status_change (safety net on SO terminal state)
                          fn_release_reservation_by_so_id / fn_cancel_sales_order (manual paths)
  - reserved_stock sync:  trg_sync_batch_reserved_stock (on stock_reservations changes)
  - product.current_stock: update_product_current_stock (via trigger_update_product_current_stock)
*/

-- Remove duplicate batches trigger (fires same function twice per change)
DROP TRIGGER IF EXISTS trigger_update_product_stock ON public.batches;

-- Remove dead SO approval wrappers (both call fn_reserve_stock_for_so v1)
DROP FUNCTION IF EXISTS public.fn_approve_sales_order(uuid, uuid, text);
DROP FUNCTION IF EXISTS public.fn_approve_sales_order_with_import(uuid, uuid, text);

-- Remove fn_reserve_stock_for_so v1 (superseded by v2)
DROP FUNCTION IF EXISTS public.fn_reserve_stock_for_so(uuid);

-- Remove dangerous dead DC approval RPC (would double-deduct if called)
DROP FUNCTION IF EXISTS public.fn_approve_delivery_challan(uuid, uuid, text);

-- Remove dead stock deduction helper (no callers, no audit trail)
DROP FUNCTION IF EXISTS public.fn_deduct_stock_and_release_reservation(uuid, uuid, uuid, numeric, uuid);

-- Remove direct stock adjustment helper (no callers, bypasses audit trail)
DROP FUNCTION IF EXISTS public.update_batch_stock(uuid, numeric);

-- Remove orphan trigger function (not installed on any table)
DROP FUNCTION IF EXISTS public.trg_delivery_challan_item_inventory();
