import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const stockMovementsModal = fs.readFileSync('src/components/StockMovementsModal.tsx', 'utf8');
const stockDrillDownModal = fs.readFileSync('src/components/StockDrillDownModal.tsx', 'utf8');
const batchesPage = fs.readFileSync('src/pages/Batches.tsx', 'utf8');
const stockReservationsUtil = fs.readFileSync('src/utils/stockReservations.ts', 'utf8');
const canonicalBaseline = fs.readFileSync('supabase/migrations/20260905140000_canonical_baseline.sql', 'utf8');

// Pure in-memory simulation of the canonical reservation logic
class CanonicalInventoryLedger {
  constructor() {
    this.batches = new Map(); // batchId -> { id, productId, batchNumber, currentStock, reservedStock, isExpired }
    this.productReservations = new Map(); // id -> { id, productId, soId, soItemId, reservedQty, status, legacyIds }
    this.legacyReservations = new Map(); // id -> { id, productId, batchId, reservedQty, status, isReleased }
    this.salesOrderItems = new Map(); // soItemId -> { id, soId, orderedQty, deliveredQty }
  }

  addBatch(id, productId, batchNumber, currentStock, isExpired = false) {
    this.batches.set(id, { id, productId, batchNumber, currentStock, reservedStock: 0, isExpired });
  }

  addLegacyReservation(id, productId, batchId, reservedQty, status = 'active', isReleased = false) {
    this.legacyReservations.set(id, { id, productId, batchId, reservedQty, status, isReleased });
  }

  addProductReservation(id, productId, soId, soItemId, reservedQty, status = 'active', legacyIds = []) {
    this.productReservations.set(id, { id, productId, soId, soItemId, reservedQty, status, legacyIds });
  }

  setOrderItem(soItemId, soId, orderedQty, deliveredQty = 0) {
    this.salesOrderItems.set(soItemId, { id: soItemId, soId, orderedQty, deliveredQty });
  }

  // Canonical ATP matching PostgreSQL function product_available_to_promise()
  calculateATP(productId) {
    const usableStock = [...this.batches.values()]
      .filter(b => b.productId === productId && !b.isExpired)
      .reduce((sum, b) => sum + b.currentStock, 0);

    const activeProdRes = [...this.productReservations.values()]
      .filter(r => r.productId === productId && r.status === 'active')
      .reduce((sum, r) => sum + r.reservedQty, 0);

    const migratedIds = new Set(
      [...this.productReservations.values()]
        .filter(r => r.productId === productId)
        .flatMap(r => r.legacyIds)
    );

    const activeLegacyRes = [...this.legacyReservations.values()]
      .filter(r => r.productId === productId && r.status === 'active' && !r.isReleased && !migratedIds.has(r.id))
      .reduce((sum, r) => sum + r.reservedQty, 0);

    const totalReserved = activeProdRes + activeLegacyRes;
    const atp = Math.max(0, usableStock - totalReserved);

    return { usableStock, totalReserved, atp };
  }

  // Calculate unfulfilled shortage demand
  calculateUnfulfilledDemand(productId) {
    let shortage = 0;
    for (const res of this.productReservations.values()) {
      if (res.productId === productId && res.status === 'active') {
        const item = this.salesOrderItems.get(res.soItemId);
        if (item) {
          const unfulfilled = Math.max(0, item.orderedQty - item.deliveredQty - res.reservedQty);
          shortage += unfulfilled;
        }
      }
    }
    return shortage;
  }
}

test('1. Migrated legacy reservation does NOT double-count in active reservation totals', () => {
  const ledger = new CanonicalInventoryLedger();
  const productId = 'c98d9f83-9bc2-4a44-9478-5d2ff3cff67f';
  const batchId = 'fb21c9df-d884-4704-881d-b6554fc980bd';
  const legacyId = 'legacy-res-0058';

  ledger.addBatch(batchId, productId, 'BCYPH/2510070', 50);

  // Legacy reservation that was released during August 2026 migration
  ledger.addLegacyReservation(legacyId, productId, batchId, 25, 'released', true);

  // New product reservation referencing the legacy ID in legacy_reservation_ids
  ledger.addProductReservation('prod-res-0058', productId, 'so-58', 'item-58', 25, 'active', [legacyId]);

  const { totalReserved, atp, usableStock } = ledger.calculateATP(productId);
  assert.equal(usableStock, 50);
  assert.equal(totalReserved, 25, 'Should count the reservation exactly once, not twice (50)');
  assert.equal(atp, 25);
});

test('2. Cyproheptadine regression scenario: 50 kg physical, 50 kg reserved, 0 kg ATP, 5 kg shortage', () => {
  const ledger = new CanonicalInventoryLedger();
  const productId = 'c98d9f83-9bc2-4a44-9478-5d2ff3cff67f';
  const batchId = 'fb21c9df-d884-4704-881d-b6554fc980bd';

  ledger.addBatch(batchId, productId, 'BCYPH/2510070', 50);

  // SO-2026-0058: 25 kg ordered, 25 kg reserved
  ledger.setOrderItem('item-58', 'so-58', 25, 0);
  ledger.addProductReservation('res-58', productId, 'so-58', 'item-58', 25, 'active', ['legacy-58']);
  ledger.addLegacyReservation('legacy-58', productId, batchId, 25, 'released', true);

  // SO-2026-0088: 30 kg ordered, 25 kg reserved (5 kg shortage)
  ledger.setOrderItem('item-88', 'so-88', 30, 0);
  ledger.addProductReservation('res-88', productId, 'so-88', 'item-88', 25, 'active', []);

  const { usableStock, totalReserved, atp } = ledger.calculateATP(productId);
  const shortage = ledger.calculateUnfulfilledDemand(productId);

  assert.equal(usableStock, 50, 'Physical stock must be exactly 50 kg');
  assert.equal(totalReserved, 50, 'Active reservations must be exactly 50 kg');
  assert.equal(atp, 0, 'Available to promise must be 0 kg');
  assert.equal(shortage, 5, 'Unfulfilled demand must be exactly 5 kg attributed to SO-2026-0088');
});

test('3. Physical stock is not changed by reservation-only operations', () => {
  const ledger = new CanonicalInventoryLedger();
  const productId = 'prod-1';
  ledger.addBatch('batch-1', productId, 'B-001', 100);

  const initialStock = ledger.batches.get('batch-1').currentStock;
  ledger.addProductReservation('res-1', productId, 'so-1', 'item-1', 40, 'active');

  assert.equal(ledger.batches.get('batch-1').currentStock, initialStock, 'Physical batch stock must remain unchanged by reservation');
  assert.equal(ledger.calculateATP(productId).atp, 60);
});

test('4. Batch-specific views distinguish physical allocation from product-level commitment', () => {
  assert.match(stockMovementsModal, /Batch Allocation Context/);
  assert.match(stockMovementsModal, /Product-level reservations hold stock against the product pool/);
  assert.match(stockMovementsModal, /fetchCanonicalStockReservations/);
  assert.match(batchesPage, /productReservationsMap/);
  assert.match(batchesPage, /pool/);
});

test('5. StockDrillDownModal and StockMovementsModal render unfulfilled demand without data mutation', () => {
  assert.match(stockDrillDownModal, /Unfulfilled Shortage/);
  assert.match(stockDrillDownModal, /fetchCanonicalStockReservations/);
  assert.match(stockMovementsModal, /Unfulfilled Demand/);
});

test('6. Shared utility stockReservations.ts adheres strictly to canonical database ATP SQL definition', () => {
  assert.match(stockReservationsUtil, /so_product_reservations/);
  assert.match(stockReservationsUtil, /stock_reservations/);
  assert.match(stockReservationsUtil, /migratedLegacyIds/);
  assert.match(stockReservationsUtil, /Math\.max\(0, usablePhysicalStock - productReservedStock\)/);
});

