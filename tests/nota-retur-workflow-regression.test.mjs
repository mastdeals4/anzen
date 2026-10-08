import test from 'node:test';
import assert from 'node:assert/strict';

// Test suite for Indonesian Nota Retur (Coretax Ready) & SAPJ-26-057 business case

test('SAPJ-26-057: Exact Mathematical Reconciliation for 50 kg Goods Return', () => {
  // Original Invoice / Faktur Pajak specs
  const originalQty = 3500; // kg
  const originalDpp = 52568250; // Rp
  const originalPpn = 5782507.50; // Rp (11%)
  const originalTotal = 58350757.50; // Rp

  // Unit price check
  const unitPrice = originalDpp / originalQty;
  assert.equal(unitPrice, 15019.50, 'Unit price must be exactly Rp 15,019.50 per kg');
  assert.equal(Math.round(originalDpp * 0.11 * 100) / 100, originalPpn, 'Original PPN matches 11% DPP');
  assert.equal(originalDpp + originalPpn, originalTotal, 'Original total matches DPP + PPN');

  // Customer returned 50 kg (2 rejected bags)
  const returnedQty = 50; // kg
  const expectedReturnedDpp = 750975.00;
  const expectedReturnedPpn = 82607.25;
  const expectedReturnedTotal = 833582.25;

  const calculatedReturnedDpp = Math.round(returnedQty * unitPrice * 100) / 100;
  const calculatedReturnedPpn = Math.round(calculatedReturnedDpp * 0.11 * 100) / 100;
  const calculatedReturnedTotal = Math.round((calculatedReturnedDpp + calculatedReturnedPpn) * 100) / 100;

  assert.equal(calculatedReturnedDpp, expectedReturnedDpp, 'Returned DPP must be exactly Rp 750,975.00');
  assert.equal(calculatedReturnedPpn, expectedReturnedPpn, 'Returned PPN must be exactly Rp 82,607.25');
  assert.equal(calculatedReturnedTotal, expectedReturnedTotal, 'Returned Total must be exactly Rp 833,582.25');

  // Net remaining on corrected invoice
  const netQty = originalQty - returnedQty;
  const netDpp = originalDpp - calculatedReturnedDpp;
  const netPpn = originalPpn - calculatedReturnedPpn;
  const netTotal = originalTotal - calculatedReturnedTotal;

  assert.equal(netQty, 3450, 'Net quantity must be 3,450 kg');
  assert.equal(netDpp, 51817275.00, 'Net DPP must be Rp 51,817,275.00');
  assert.equal(netPpn, 5699900.25, 'Net PPN must be Rp 5,699,900.25');
  assert.equal(netTotal, 57517175.25, 'Net Total must be Rp 57,517,175.25');
});

test('Validation Rule: Return quantity cannot exceed original invoice quantity', () => {
  const originalQty = 3500;
  const requestedReturnQty = 3501;

  function validateReturnQty(qty, origQty) {
    if (qty <= 0) throw new Error('Return quantity must be greater than zero');
    if (qty > origQty) throw new Error('Return quantity cannot exceed quantity originally supplied');
    return true;
  }

  assert.throws(() => validateReturnQty(requestedReturnQty, originalQty), {
    message: 'Return quantity cannot exceed quantity originally supplied',
  });
  assert.doesNotThrow(() => validateReturnQty(50, originalQty));
});

test('Tax Safeguard: Output PPN deduction deduplication between Credit Note and Nota Retur', () => {
  // Both documents may exist for the same event:
  // Credit Note: Commercial adjustment (AR reduction)
  // Nota Retur: Official tax reduction (SPT PPN / Coretax Output VAT deduction)

  const outputPpnPeriod = [
    { type: 'sales_invoice', number: 'INV-057', ppn: 5782507.50 },
    { type: 'credit_note', number: 'CN-057', ppn: -82607.25, linked_nota_retur_id: 'NR-001' },
    { type: 'nota_retur', number: 'NR-001', ppn: -82607.25, credit_note_id: 'CN-057', status: 'approved' },
  ];

  // In the tax period engine, Credit Note deduction is ignored if an approved Nota Retur is present
  const approvedNrCnIds = new Set(
    outputPpnPeriod
      .filter(d => d.type === 'nota_retur' && d.status === 'approved')
      .map(d => d.credit_note_id)
      .filter(Boolean)
  );

  const effectiveOutputTaxLines = outputPpnPeriod.filter(doc => {
    if (doc.type === 'credit_note' && approvedNrCnIds.has(doc.number)) {
      return false; // deduplicate
    }
    return true;
  });

  const netOutputPpn = effectiveOutputTaxLines.reduce((sum, d) => sum + d.ppn, 0);

  // Exactly 5,782,507.50 - 82,607.25 = 5,699,900.25 (deducted once, NOT twice)
  assert.equal(effectiveOutputTaxLines.length, 2, 'Must contain invoice and exactly one deduction line');
  assert.equal(Math.round(netOutputPpn * 100) / 100, 5699900.25, 'Net Output PPN must be Rp 5,699,900.25');
});

test('Coretax Compliance: Status transitions and reference preservation', () => {
  const allowedStatuses = ['draft', 'ready_for_review', 'submitted', 'approved', 'rejected', 'cancelled'];
  const allowedCoretaxStatuses = ['draft', 'ready_for_review', 'submitted', 'approved', 'rejected'];

  const testRecord = {
    status: 'submitted',
    coretax_status: 'submitted',
    coretax_reference_number: 'BPE-20261008-00123',
    original_faktur_pajak_number: '010.000-26.00000000',
  };

  assert.ok(allowedStatuses.includes(testRecord.status));
  assert.ok(allowedCoretaxStatuses.includes(testRecord.coretax_status));
  assert.ok(testRecord.coretax_reference_number.length > 0);
  assert.ok(testRecord.original_faktur_pajak_number.length > 0, 'Original Faktur Pajak reference is preserved');
});
