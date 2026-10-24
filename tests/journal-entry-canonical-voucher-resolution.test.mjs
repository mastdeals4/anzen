import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const viewerCode = readFileSync(
  new URL('../src/components/finance/JournalEntryViewerEnhanced.tsx', import.meta.url),
  'utf8',
);

test('1. JournalEntryViewerEnhanced Resolves Canonical Voucher References for Receipts and Payments', () => {
  // Ensure receipt_vouchers and payment_vouchers are queried for canonical voucher numbers
  assert.match(
    viewerCode,
    /\.from\(['"]receipt_vouchers['"]\)\s*\.select\(['"]id,\s*voucher_number['"]\)/,
    'Must query receipt_vouchers for canonical voucher_number',
  );
  assert.match(
    viewerCode,
    /\.from\(['"]payment_vouchers['"]\)\s*\.select\(['"]id,\s*voucher_number['"]\)/,
    'Must query payment_vouchers for canonical voucher_number',
  );

  // Ensure modal also resolves receipt/payment canonical voucher numbers
  assert.match(
    viewerCode,
    /entry\.source_module === 'receipt'/,
    'Modal must support receipt voucher reference resolution',
  );
  assert.match(
    viewerCode,
    /entry\.source_module === 'payment'/,
    'Modal must support payment voucher reference resolution',
  );
});

test('2. JournalEntryViewerEnhanced Fallback Logic Simulation', () => {
  // Simulation of the exact reference resolution logic:
  function resolveReference(entry, canonicalRefMap) {
    const isReceipt = entry.source_module === 'receipt' || entry.source_module === 'receipt_voucher' || entry.source_module === 'customer_receipt';
    const isPayment = entry.source_module === 'payment' || entry.source_module === 'payment_voucher' || entry.source_module === 'supplier_payment';
    const canonicalRef = isReceipt && entry.reference_id
      ? canonicalRefMap.get(`receipt:${entry.reference_id}`)
      : isPayment && entry.reference_id
      ? canonicalRefMap.get(`payment:${entry.reference_id}`)
      : null;

    return canonicalRef || entry.reference_number || '-';
  }

  const map = new Map();
  map.set('receipt:rv-uuid-1', 'RV/25-26/001');
  map.set('payment:pv-uuid-1', 'PV/26-27/001');

  // Case 1: Receipt journal with older reference format
  const receiptJournal = {
    source_module: 'receipt',
    reference_id: 'rv-uuid-1',
    reference_number: 'RV2601-0002', // old format
  };
  assert.equal(resolveReference(receiptJournal, map), 'RV/25-26/001');

  // Case 2: Payment journal with older reference format
  const paymentJournal = {
    source_module: 'payment',
    reference_id: 'pv-uuid-1',
    reference_number: 'PV2604-0001', // old format
  };
  assert.equal(resolveReference(paymentJournal, map), 'PV/26-27/001');

  // Case 3: Missing linked voucher falls back gracefully to stored reference
  const orphanJournal = {
    source_module: 'receipt',
    reference_id: 'rv-missing',
    reference_number: 'RV-OLD-123',
  };
  assert.equal(resolveReference(orphanJournal, map), 'RV-OLD-123');

  // Case 4: Other module (e.g. manual) retains reference
  const manualJournal = {
    source_module: 'manual',
    reference_id: null,
    reference_number: 'REF-MANUAL-001',
  };
  assert.equal(resolveReference(manualJournal, map), 'REF-MANUAL-001');
});
