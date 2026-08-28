import assert from 'node:assert/strict';
import fs from 'node:fs';

const migration = fs.readFileSync('supabase/migrations/20260827140000_product_so_reservation_dc_batch_allocation.sql', 'utf8');
const dc = fs.readFileSync('src/pages/DeliveryChallan.tsx', 'utf8');

assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.so_product_reservations/);
assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.dc_batch_allocations/);
assert.match(migration, /consume_so_product_reservation_v2/);
assert.match(migration, /DC quantities exceed remaining SO product reservation/);
assert.match(migration, /Selected batch is invalid, expired, or has insufficient physical stock/);
assert.match(migration, /fn_reserve_stock_for_so_v2[\s\S]*approve_sales_order_product_reservation_v2/);
assert.match(migration, /Batch reservation alignment is retired/);
assert.doesNotMatch(migration, /INSERT INTO public\.stock_reservations/);
assert.match(dc, /SO reservations are product-level/);
assert.match(dc, /\.from\('so_product_reservations'\)/);
assert.doesNotMatch(dc, /realign_reservation_for_delivery_challan/);
assert.match(dc, /Pending DCs are not deliveries/);
assert.match(dc, /if \(reservationsResult\.error\) throw reservationsResult\.error/);
assert.match(dc, /Unavailable \(reservation query failed\)/);
assert.doesNotMatch(dc, /soReservations\.get\(source\.id\) \|\| 0/);

console.log('delivery challan product-reservation regression checks passed');
