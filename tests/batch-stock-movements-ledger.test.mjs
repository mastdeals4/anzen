import test from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

function runSql(sql) {
  const tmpFile = path.join(os.tmpdir(), `query_${Date.now()}_${Math.random().toString(36).slice(2)}.sql`);
  fs.writeFileSync(tmpFile, sql, 'utf-8');
  try {
    const res = execSync(`npx supabase db query --linked -f "${tmpFile}"`, {
      encoding: 'utf-8',
      maxBuffer: 50 * 1024 * 1024,
      shell: '/bin/zsh'
    });
    const jsonMatch = res.match(/\{[\s\S]*"rows":[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return parsed.rows;
    }
    return [];
  } finally {
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  }
}

const BATCH_E441_ID = 'dd162acf-2ce7-4d27-8515-9652c7d17bd5';

test('1. Batch E441/2026 stock summary matches exact values (In: 9,000, Out: 9,000, Reserved: 0, Free: 0)', () => {
  const txns = runSql(`
    SELECT transaction_type, quantity, is_effective
    FROM inventory_v1_effective_ledger
    WHERE batch_id = '${BATCH_E441_ID}'
      AND (metadata->>'superseded' IS NULL OR metadata->>'superseded' != 'true');
  `);

  const reservations = runSql(`
    SELECT id, reserved_quantity, status
    FROM stock_reservations
    WHERE batch_id = '${BATCH_E441_ID}';
  `);

  const totalIn = txns
    .filter(t => parseFloat(t.quantity) > 0)
    .reduce((s, t) => s + parseFloat(t.quantity), 0);

  const totalOut = txns
    .filter(t => parseFloat(t.quantity) < 0)
    .reduce((s, t) => s + Math.abs(parseFloat(t.quantity)), 0);

  const activeRes = reservations.filter(r => r.status === 'active');
  const totalReserved = activeRes.reduce((s, r) => s + parseFloat(r.reserved_quantity), 0);
  const currentStock = totalIn - totalOut;
  const freeStock = currentStock - totalReserved;

  assert.equal(totalIn, 9000, 'Total In must be 9,000 KG');
  assert.equal(totalOut, 9000, 'Total Out must be 9,000 KG');
  assert.equal(totalReserved, 0, 'Total Reserved must be 0 KG');
  assert.equal(currentStock, 0, 'Current Stock must be 0 KG');
  assert.equal(freeStock, 0, 'Free Stock must be 0 KG');
});

test('2. Running physical stock ledger calculates chronological balance without mutation from reservations', () => {
  const txns = runSql(`
    SELECT id, created_at, transaction_date, transaction_type, quantity, reference_number, is_effective
    FROM inventory_v1_effective_ledger
    WHERE batch_id = '${BATCH_E441_ID}'
      AND (metadata->>'superseded' IS NULL OR metadata->>'superseded' != 'true')
    ORDER BY created_at ASC;
  `);

  const reservations = runSql(`
    SELECT id, reserved_at as created_at, reserved_quantity as quantity, status, release_reason
    FROM stock_reservations
    WHERE batch_id = '${BATCH_E441_ID}'
    ORDER BY reserved_at ASC;
  `);

  const mappedTxns = txns.map(t => ({ ...t, _type: 'transaction' }));
  const mappedRes = reservations.map(r => ({
    ...r,
    _type: 'reservation',
    transaction_type: r.status === 'active' ? 'reserved' : 'reservation_released'
  }));

  // Chronological sort
  const combined = [...mappedTxns, ...mappedRes].sort((a, b) => {
    const timeA = new Date(a.created_at).getTime();
    const timeB = new Date(b.created_at).getTime();
    if (timeA !== timeB) return timeA - timeB;
    return (parseFloat(b.quantity) || 0) - (parseFloat(a.quantity) || 0);
  });

  let runningStock = 0;
  const ledger = combined.map(item => {
    const isPhysical = item._type === 'transaction' && item.is_effective !== false;
    const qty = parseFloat(item.quantity) || 0;
    const stockBefore = runningStock;
    if (isPhysical) {
      runningStock += qty;
    }
    const stockAfter = runningStock;
    return {
      ...item,
      stock_before: stockBefore,
      stock_after: stockAfter
    };
  });

  // Purchase of 9000
  const purchase = ledger.find(l => l.transaction_type === 'purchase');
  assert.ok(purchase, 'Purchase record must exist');
  assert.equal(purchase.stock_after, 9000, 'Stock after purchase must be 9000');

  // Reservation events must NOT change running physical stock
  const resEvents = ledger.filter(l => l._type === 'reservation');
  assert.ok(resEvents.length > 0, 'Reservation events must exist');
  for (const r of resEvents) {
    assert.equal(r.stock_before, r.stock_after, 'Reservation must not alter physical stock balance');
  }

  // Final delivery DO-26-0050 must bring stock to 0
  const do50 = ledger.find(l => l.reference_number === 'DO-26-0050');
  assert.ok(do50, 'DO-26-0050 record must exist');
  assert.equal(do50.stock_after, 0, 'Stock after DO-26-0050 must be 0 KG');
});

test('3. Movement category classification maps properly for filtering', () => {
  function getMovementCategory(item) {
    if (item._type === 'reservation') return 'reservations';
    const type = (item.transaction_type || '').toLowerCase();
    if (type === 'adjustment') return 'adjustments';
    const qty = parseFloat(item.quantity) || 0;
    if (type === 'sales_return' || type === 'return' || qty > 0) return 'in';
    if (qty < 0) return 'out';
    return 'other';
  }

  assert.equal(getMovementCategory({ _type: 'reservation', status: 'active' }), 'reservations');
  assert.equal(getMovementCategory({ _type: 'reservation', status: 'released' }), 'reservations');
  assert.equal(getMovementCategory({ _type: 'transaction', transaction_type: 'purchase', quantity: '9000' }), 'in');
  assert.equal(getMovementCategory({ _type: 'transaction', transaction_type: 'delivery_challan', quantity: '-4175' }), 'out');
  assert.equal(getMovementCategory({ _type: 'transaction', transaction_type: 'sale', quantity: '-100' }), 'out');
  assert.equal(getMovementCategory({ _type: 'transaction', transaction_type: 'sales_return', quantity: '50' }), 'in');
  assert.equal(getMovementCategory({ _type: 'transaction', transaction_type: 'adjustment', quantity: '-10' }), 'adjustments');
});
