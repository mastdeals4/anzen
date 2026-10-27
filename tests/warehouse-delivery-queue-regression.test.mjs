import assert from 'node:assert/strict';
import { getWarehouseDeliveryPriority } from '../src/utils/deliveryPriority.ts';

const today = new Date('2026-08-14T10:00:00');
assert.equal(getWarehouseDeliveryPriority('2026-08-13', today), 'overdue');
assert.equal(getWarehouseDeliveryPriority('2026-08-14', today), 'today');
assert.equal(getWarehouseDeliveryPriority('2026-08-15', today), 'tomorrow');
assert.equal(getWarehouseDeliveryPriority('2026-08-21', today), 'upcoming');
console.log('warehouse delivery priority regression passed');
