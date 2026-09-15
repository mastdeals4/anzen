import assert from 'node:assert/strict';
import fs from 'node:fs';

const migrationPath = fs.existsSync('supabase/migrations_archive/20260827140000_product_so_reservation_dc_batch_allocation.sql')
  ? 'supabase/migrations_archive/20260827140000_product_so_reservation_dc_batch_allocation.sql'
  : 'supabase/migrations_archive/20260827140000_product_so_reservation_dc_batch_allocation.sql';
const migration = fs.readFileSync(migrationPath, 'utf8');
const fixMigration = fs.readFileSync('supabase/migrations/20260915170000_fix_dc_creation_and_approval_for_unreserved_sales_orders.sql', 'utf8');
const dc = fs.readFileSync('src/pages/DeliveryChallan.tsx', 'utf8');

assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.so_product_reservations/);
assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.dc_batch_allocations/);
assert.match(fixMigration, /consume_so_product_reservation_v2/);
assert.match(fixMigration, /validate_dc_item_product_reservation_v2/);
assert.match(fixMigration, /Selected batch is invalid, expired, or has insufficient physical stock/);
assert.match(dc, /exceeds the remaining Sales Order quantity/);
assert.doesNotMatch(dc, /Delivery quantity exceeds the remaining Sales Order product reservation/);
assert.doesNotMatch(dc, /realign_reservation_for_delivery_challan/);

console.log('delivery challan product-reservation regression checks passed');

