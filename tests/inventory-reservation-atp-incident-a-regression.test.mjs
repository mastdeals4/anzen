import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const stockMovementsModal = fs.readFileSync('src/components/StockMovementsModal.tsx', 'utf8');
const stockDrillDownModal = fs.readFileSync('src/components/StockDrillDownModal.tsx', 'utf8');
const batchesPage = fs.readFileSync('src/pages/Batches.tsx', 'utf8');
const stockPage = fs.readFileSync('src/pages/Stock.tsx', 'utf8');
const stockReservationsUtil = fs.readFileSync('src/utils/stockReservations.ts', 'utf8');
const canonicalBaseline = fs.readFileSync('supabase/migrations/20260905140000_canonical_baseline.sql', 'utf8');

// ---------------------------------------------------------------------------
// Pure implementation mirroring calculateStockMetrics from stockReservations.ts
// ---------------------------------------------------------------------------
function calculateStockMetrics({
  batches,
  productReservations,
  legacyReservations = [],
  importRequirements = [],
  excludeSalesOrderItemId = null,
  asOfDate = '2026-10-27',
}) {
  const getReserved = (r) => Number(r.reservedQuantity ?? r.reserved_quantity ?? 0);
  const getOrdered = (r) => r.orderedQuantity != null ? Number(r.orderedQuantity) : (r.ordered_quantity != null ? Number(r.ordered_quantity) : null);
  const getDelivered = (r) => Number(r.deliveredQuantity ?? r.delivered_quantity ?? 0);
  const getShortage = (r) => r.shortageQuantity != null ? Number(r.shortageQuantity) : (r.shortage_quantity != null ? Number(r.shortage_quantity) : null);
  const getSoItemId = (r) => r.salesOrderItemId ?? r.sales_order_item_id;
  const getIsReleased = (r) => Boolean(r.isReleased ?? r.is_released);
  const getLegacyIds = (r) => r.legacyReservationIds ?? r.legacy_reservation_ids;

  // 1. Migrated legacy reservation IDs
  const migratedLegacyIds = new Set();
  (productReservations || []).forEach(r => {
    const ids = getLegacyIds(r);
    if (Array.isArray(ids)) {
      ids.forEach(id => migratedLegacyIds.add(id));
    }
  });

  // 2. Active Batches & Usable Physical Stock
  const activeBatches = (batches || []).filter(b => b.is_active !== false);
  const totalPhysicalStock = activeBatches.reduce((sum, b) => sum + (Number(b.current_stock) || 0), 0);
  const usablePhysicalStock = activeBatches
    .filter(b => !b.expiry_date || b.expiry_date > asOfDate)
    .reduce((sum, b) => sum + (Number(b.current_stock) || 0), 0);

  // 3. Active Product-Level Reservations (excluding current order item if requested)
  const activeProductReservations = (productReservations || []).filter(r => {
    if (r.status !== 'active') return false;
    const soItemId = getSoItemId(r);
    if (excludeSalesOrderItemId && soItemId === excludeSalesOrderItemId) {
      return false;
    }
    return getReserved(r) > 0;
  });

  const productReservedStock = activeProductReservations.reduce(
    (sum, r) => sum + getReserved(r),
    0
  );

  // 4. Active Legacy Batch Reservations (excluding migrated and excluded SO item)
  const activeLegacyReservations = (legacyReservations || []).filter(sr => {
    if (sr.status !== 'active' || getIsReleased(sr)) return false;
    if (migratedLegacyIds.has(sr.id)) return false;
    const soItemId = getSoItemId(sr);
    if (excludeSalesOrderItemId && soItemId === excludeSalesOrderItemId) {
      return false;
    }
    return getReserved(sr) > 0;
  });

  const legacyReservedStock = activeLegacyReservations.reduce(
    (sum, sr) => sum + getReserved(sr),
    0
  );

  const totalReservedStock = productReservedStock + legacyReservedStock;
  const availableToPromise = Math.max(0, usablePhysicalStock - totalReservedStock);

  // 5. Shortages and Unfulfilled Demand
  const reservationShortage = activeProductReservations.reduce((sum, r) => {
    const explicitShortage = getShortage(r);
    if (explicitShortage != null) {
      return sum + explicitShortage;
    }
    const ordered = getOrdered(r) ?? 0;
    const delivered = getDelivered(r);
    const reserved = getReserved(r);
    return sum + (ordered > 0 ? Math.max(0, ordered - delivered - reserved) : 0);
  }, 0);

  const importShortage = (importRequirements || [])
    .filter(ir => ['pending', 'ordered'].includes(ir.status))
    .reduce((sum, ir) => sum + (Number(ir.shortage_quantity) || 0), 0);

  const unfulfilledDemand = Math.max(reservationShortage, importShortage);

  // 6. Per-batch breakdown
  const batchSummaries = {};
  activeBatches.forEach(b => {
    const batchPhysical = Number(b.current_stock) || 0;
    const batchLegacyAllocated = activeLegacyReservations
      .filter(lr => (lr.batchId === b.id || lr.batch_id === b.id))
      .reduce((sum, lr) => sum + getReserved(lr), 0);
    const batchAllocatedStock = Math.max(Number(b.reserved_stock) || 0, batchLegacyAllocated);

    const isExpired = Boolean(b.expiry_date && b.expiry_date <= asOfDate);
    const effectiveFreeStock = isExpired
      ? 0
      : Math.max(0, Math.min(batchPhysical - batchAllocatedStock, availableToPromise));

    batchSummaries[b.id] = {
      batchId: b.id,
      batchNumber: b.batch_number || '',
      productId: b.product_id || '',
      batchPhysicalStock: batchPhysical,
      batchAllocatedStock,
      productReservedStock: totalReservedStock,
      productAvailableToPromise: availableToPromise,
      effectiveFreeStock,
      unfulfilledDemand,
      isProductLevelCommitment: batchAllocatedStock === 0 && totalReservedStock > 0,
      isExpired,
    };
  });

  return {
    totalPhysicalStock,
    usablePhysicalStock,
    productReservedStock,
    legacyReservedStock,
    totalReservedStock,
    availableToPromise,
    unfulfilledDemand,
    activeProductReservationCount: activeProductReservations.length,
    activeLegacyReservationCount: activeLegacyReservations.length,
    batchSummaries,
  };
}

// ---------------------------------------------------------------------------
// Scenario 1: Cyproheptadine regression scenario
// ---------------------------------------------------------------------------
test('1. Cyproheptadine regression scenario: 50 kg physical, 50 kg reserved, 0 kg ATP, 5 kg shortage', () => {
  const productId = 'c98d9f83-9bc2-4a44-9478-5d2ff3cff67f';
  const batchId = 'fb21c9df-d884-4704-881d-b6554fc980bd';

  const batches = [
    {
      id: batchId,
      product_id: productId,
      batch_number: 'BCYPH/2510070',
      current_stock: 50,
      reserved_stock: 0, // In database, reservations are tracked via so_product_reservations
      expiry_date: '2028-10-01',
      is_active: true,
    },
  ];

  const productReservations = [
    // SO-2026-0058: 25 kg ordered, 25 kg reserved, migrated legacy
    {
      id: 'res-58',
      product_id: productId,
      sales_order_id: 'so-58',
      sales_order_item_id: 'item-58',
      so_number: 'SO-2026-0058',
      customer_name: 'PT Menjangan Sakti',
      ordered_quantity: 25,
      delivered_quantity: 0,
      reserved_quantity: 25,
      shortage_quantity: 0,
      status: 'active',
      legacy_reservation_ids: ['legacy-res-58'],
    },
    // SO-2026-0088: 30 kg ordered, 25 kg reserved, 5 kg shortage
    {
      id: 'res-88',
      product_id: productId,
      sales_order_id: 'so-88',
      sales_order_item_id: 'item-88',
      so_number: 'SO-2026-0088',
      customer_name: 'PT Generic Pharma',
      ordered_quantity: 30,
      delivered_quantity: 0,
      reserved_quantity: 25,
      shortage_quantity: 5,
      status: 'active',
      legacy_reservation_ids: [],
    },
  ];

  const legacyReservations = [
    // Legacy record from initial SO creation (now migrated)
    {
      id: 'legacy-res-58',
      product_id: productId,
      batch_id: batchId,
      sales_order_id: 'so-58',
      sales_order_item_id: 'item-58',
      so_number: 'SO-2026-0058',
      reserved_quantity: 25,
      status: 'released',
      is_released: true,
    },
  ];

  const importRequirements = [
    {
      product_id: productId,
      shortage_quantity: 5,
      status: 'pending',
    },
  ];

  const metrics = calculateStockMetrics({
    batches,
    productReservations,
    legacyReservations,
    importRequirements,
  });

  // Verify exact table specifications:
  assert.equal(metrics.batchSummaries[batchId].batchPhysicalStock, 50, 'Physical batch stock must be 50 kg');
  assert.equal(metrics.totalPhysicalStock, 50, 'Total physical product stock must be 50 kg');
  assert.equal(metrics.productReservedStock, 50, 'Active product reservations must be 50 kg');
  assert.equal(metrics.legacyReservedStock, 0, 'Active legacy batch reservation must be 0 kg');
  assert.equal(metrics.availableToPromise, 0, 'Available to promise must be 0 kg');
  assert.equal(metrics.unfulfilledDemand, 5, 'Pending import requirement / shortage must be 5 kg');
  assert.equal(metrics.batchSummaries[batchId].effectiveFreeStock, 0, 'Effective free stock on batch must be 0 kg, NOT 50 kg');
  assert.equal(metrics.batchSummaries[batchId].isProductLevelCommitment, true);
});

// ---------------------------------------------------------------------------
// Scenario 2: Migrated legacy reservation referenced by legacy_reservation_ids
// ---------------------------------------------------------------------------
test('2. Migrated legacy reservation referenced by legacy_reservation_ids is not double-counted', () => {
  const productId = 'prod-migrated';
  const batchId = 'batch-migrated';

  const batches = [
    { id: batchId, product_id: productId, current_stock: 100, is_active: true, expiry_date: '2028-01-01' },
  ];

  // Both tables have the record, but so_product_reservations explicitly references the legacy id
  const legacyReservations = [
    { id: 'legacy-1', product_id: productId, batch_id: batchId, reserved_quantity: 40, status: 'active', is_released: false },
  ];
  const productReservations = [
    { id: 'prod-res-1', product_id: productId, reserved_quantity: 40, status: 'active', legacy_reservation_ids: ['legacy-1'] },
  ];

  const metrics = calculateStockMetrics({ batches, productReservations, legacyReservations });
  assert.equal(metrics.productReservedStock, 40);
  assert.equal(metrics.legacyReservedStock, 0, 'Migrated legacy row must be skipped');
  assert.equal(metrics.totalReservedStock, 40, 'Total reserved must be 40, NOT 80');
  assert.equal(metrics.availableToPromise, 60, 'ATP must be 100 - 40 = 60');
});

// ---------------------------------------------------------------------------
// Scenario 3: Unrelated active legacy reservation that has not been migrated
// ---------------------------------------------------------------------------
test('3. Unrelated active legacy reservation that has not been migrated is counted in total reserved', () => {
  const productId = 'prod-legacy-active';
  const batchId = 'batch-legacy';

  const batches = [
    { id: batchId, product_id: productId, current_stock: 100, is_active: true, expiry_date: '2028-01-01' },
  ];

  // Legacy reservation exists and has NOT been migrated to so_product_reservations
  const legacyReservations = [
    { id: 'legacy-unmigrated', product_id: productId, batch_id: batchId, reserved_quantity: 35, status: 'active', is_released: false },
  ];
  const productReservations = [
    { id: 'prod-res-other', product_id: productId, reserved_quantity: 20, status: 'active', legacy_reservation_ids: [] },
  ];

  const metrics = calculateStockMetrics({ batches, productReservations, legacyReservations });
  assert.equal(metrics.productReservedStock, 20);
  assert.equal(metrics.legacyReservedStock, 35, 'Unmigrated legacy reservation must be counted');
  assert.equal(metrics.totalReservedStock, 55, 'Total reserved = 20 + 35 = 55');
  assert.equal(metrics.availableToPromise, 45, 'ATP must be 100 - 55 = 45');
});

// ---------------------------------------------------------------------------
// Scenario 4: Product with stock but no reservations
// ---------------------------------------------------------------------------
test('4. Product with stock but no reservations has ATP equal to usable physical stock', () => {
  const productId = 'prod-no-res';
  const batches = [
    { id: 'b-1', product_id: productId, current_stock: 150, is_active: true, expiry_date: '2028-06-01' },
  ];

  const metrics = calculateStockMetrics({ batches, productReservations: [], legacyReservations: [] });
  assert.equal(metrics.totalPhysicalStock, 150);
  assert.equal(metrics.totalReservedStock, 0);
  assert.equal(metrics.availableToPromise, 150);
  assert.equal(metrics.unfulfilledDemand, 0);
  assert.equal(metrics.batchSummaries['b-1'].effectiveFreeStock, 150);
});

// ---------------------------------------------------------------------------
// Scenario 5: Product with partial reservations and a remaining shortage
// ---------------------------------------------------------------------------
test('5. Product with partial reservations and remaining shortage has 0 ATP and records shortage', () => {
  const productId = 'prod-shortage';
  const batches = [
    { id: 'b-1', product_id: productId, current_stock: 30, is_active: true, expiry_date: '2028-01-01' },
  ];

  const productReservations = [
    {
      id: 'res-order-1',
      product_id: productId,
      ordered_quantity: 50,
      delivered_quantity: 0,
      reserved_quantity: 30,
      shortage_quantity: 20,
      status: 'active',
    },
  ];

  const importRequirements = [
    { product_id: productId, shortage_quantity: 20, status: 'pending' },
  ];

  const metrics = calculateStockMetrics({ batches, productReservations, importRequirements });
  assert.equal(metrics.totalPhysicalStock, 30);
  assert.equal(metrics.totalReservedStock, 30);
  assert.equal(metrics.availableToPromise, 0);
  assert.equal(metrics.unfulfilledDemand, 20);
  assert.equal(metrics.batchSummaries['b-1'].effectiveFreeStock, 0);
});

// ---------------------------------------------------------------------------
// Scenario 6: Excluding the current sales-order item when calculating its own availability
// ---------------------------------------------------------------------------
test('6. Excluding the current sales-order item when calculating its own availability', () => {
  const productId = 'prod-exclude';
  const batches = [
    { id: 'b-1', product_id: productId, current_stock: 100, is_active: true, expiry_date: '2028-01-01' },
  ];

  const productReservations = [
    { id: 'res-other', product_id: productId, sales_order_item_id: 'item-other', reserved_quantity: 40, status: 'active' },
    { id: 'res-self', product_id: productId, sales_order_item_id: 'item-self', reserved_quantity: 60, status: 'active' },
  ];

  // Without exclusion
  const fullMetrics = calculateStockMetrics({ batches, productReservations });
  assert.equal(fullMetrics.availableToPromise, 0);

  // Excluding current sales order item
  const selfMetrics = calculateStockMetrics({
    batches,
    productReservations,
    excludeSalesOrderItemId: 'item-self',
  });
  assert.equal(selfMetrics.totalReservedStock, 40, 'Only the other SO item must be counted as reserved');
  assert.equal(selfMetrics.availableToPromise, 60, 'Available stock for self is 100 - 40 = 60');
});

// ---------------------------------------------------------------------------
// Scenario 7: Multiple batches belonging to the same product
// ---------------------------------------------------------------------------
test('7. Multiple batches belonging to the same product sum stock and cap effective free stock', () => {
  const productId = 'prod-multi-batch';
  const batches = [
    { id: 'batch-a', product_id: productId, batch_number: 'BA-01', current_stock: 40, is_active: true, expiry_date: '2028-01-01' },
    { id: 'batch-b', product_id: productId, batch_number: 'BB-02', current_stock: 60, is_active: true, expiry_date: '2028-01-01' },
  ];

  // Active reservation of 70 kg holding stock across the product pool
  const productReservations = [
    { id: 'res-1', product_id: productId, reserved_quantity: 70, status: 'active' },
  ];

  const metrics = calculateStockMetrics({ batches, productReservations });
  assert.equal(metrics.totalPhysicalStock, 100);
  assert.equal(metrics.totalReservedStock, 70);
  assert.equal(metrics.availableToPromise, 30);

  // Neither batch can show more than the product's overall ATP of 30 kg!
  assert.equal(metrics.batchSummaries['batch-a'].effectiveFreeStock, 30, 'Batch A free stock capped by ATP (30 kg)');
  assert.equal(metrics.batchSummaries['batch-b'].effectiveFreeStock, 30, 'Batch B free stock capped by ATP (30 kg)');
});

// ---------------------------------------------------------------------------
// Scenario 8: Expired or inactive batches, consistent with authoritative availability rules
// ---------------------------------------------------------------------------
test('8. Expired or inactive batches are excluded from usable stock and ATP', () => {
  const productId = 'prod-expired-inactive';
  const asOfDate = '2026-10-27';

  const batches = [
    // Usable batch: active and valid expiry
    { id: 'batch-good', product_id: productId, current_stock: 50, is_active: true, expiry_date: '2027-12-31' },
    // Expired batch: active but expired yesterday
    { id: 'batch-expired', product_id: productId, current_stock: 40, is_active: true, expiry_date: '2026-10-26' },
    // Inactive / archived batch
    { id: 'batch-inactive', product_id: productId, current_stock: 30, is_active: false, expiry_date: '2028-01-01' },
  ];

  const productReservations = [
    { id: 'res-1', product_id: productId, reserved_quantity: 20, status: 'active' },
  ];

  const metrics = calculateStockMetrics({ batches, productReservations, asOfDate });
  // Total physical stock of active batches = 50 + 40 = 90 (inactive is excluded)
  assert.equal(metrics.totalPhysicalStock, 90);
  // Usable stock for sales ATP = only the unexpired batch = 50
  assert.equal(metrics.usablePhysicalStock, 50);
  assert.equal(metrics.totalReservedStock, 20);
  // ATP = usable 50 - reserved 20 = 30
  assert.equal(metrics.availableToPromise, 30);
  // Expired batch summary has 0 effective free stock
  assert.equal(metrics.batchSummaries['batch-expired'].isExpired, true);
  assert.equal(metrics.batchSummaries['batch-expired'].effectiveFreeStock, 0);
  assert.equal(metrics.batchSummaries['batch-good'].effectiveFreeStock, 30);
});

// ---------------------------------------------------------------------------
// Scenario 9: Architectural checks across components
// ---------------------------------------------------------------------------
test('9. Architectural check: StockMovementsModal distinguishes batch stock from product ATP', () => {
  assert.match(stockMovementsModal, /BATCH STOCK/);
  assert.match(stockMovementsModal, /POOL RESERVED/);
  assert.match(stockMovementsModal, /PRODUCT ATP/);
  assert.match(stockMovementsModal, /fetchProductStockAuditSummary/);
  assert.match(stockMovementsModal, /Batch Allocation Context/);
});

test('10. Architectural check: StockDrillDownModal and Batches cap batch available by product ATP', () => {
  assert.match(stockDrillDownModal, /availableToPromise/);
  assert.match(stockDrillDownModal, /0 \(Pool\)/);
  assert.match(batchesPage, /productAtpMap/);
  assert.match(batchesPage, /inventory_v1_stock_summary/);
  assert.match(stockPage, /0 \(Pool\)/);
});
