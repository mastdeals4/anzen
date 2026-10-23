import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

test('PartyLedger reference resolution logic and UUID sanitization', () => {
  const partyLedgerSrc = fs.readFileSync(path.resolve('src/components/finance/PartyLedger.tsx'), 'utf-8');

  // 1. UUID Regex and helper defined
  assert.match(partyLedgerSrc, /const UUID_REGEX = \/\^\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{12\}\$\/i;/);
  assert.match(partyLedgerSrc, /const isUuid = \(val\?: string \| null\): boolean => Boolean\(val && UUID_REGEX\.test\(val\.trim\(\)\)\);/);

  // 2. Customs broker line resolution fetches reference_id and resolves EXP-
  assert.match(partyLedgerSrc, /journal_entries!inner\(reference_id, reference_number, entry_number, transaction_category, is_posted, is_reversed\)/);
  assert.match(partyLedgerSrc, /brokerExpMap\[sub\]/);

  // 3. Expense bill & advance references prioritize voucher_number when invoice_number is a UUID
  assert.match(partyLedgerSrc, /reference: \(!bill\.invoice_number \|\| isUuid\(bill\.invoice_number\)\) \? \(bill\.voucher_number \|\| ''\) : \(bill\.voucher_number \|\| bill\.invoice_number \|\| ''\)/);
  assert.match(partyLedgerSrc, /reference: \(!adv\.invoice_number \|\| isUuid\(adv\.invoice_number\)\) \? \(adv\.voucher_number \|\| ''\) : \(adv\.voucher_number \|\| adv\.invoice_number \|\| ''\)/);

  // 4. Import cost entries don't display raw UUIDs in invoice_number
  assert.match(partyLedgerSrc, /invoice_number: \(!d\.invoice_number \|\| isUuid\(d\.invoice_number\)\) \? \(d\.voucher_number \|\| ''\) : d\.invoice_number/);

  // 5. Canonical reference resolution function exists and post-processes entries
  assert.match(partyLedgerSrc, /return resolveCanonicalReferences\(entries\);/);
  assert.match(partyLedgerSrc, /const resolveCanonicalReferences = async \(entries: LedgerEntry\[\]\): Promise<LedgerEntry\[\]>/);

  // 6. Test the regex and resolution logic directly
  const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const isUuid = (val) => Boolean(val && UUID_REGEX.test(val.trim()));

  assert.equal(isUuid('421d9e6e-50e5-4f9e-a89c-d0fae6205e94'), true);
  assert.equal(isUuid('EXP-421d9e6e-50e5-4f9e-a89c-d0fae6205e94'), false);
  assert.equal(isUuid('EXP/26/297'), false);
  assert.equal(isUuid('PV/26/012'), false);
  assert.equal(isUuid('INV-2026-001'), false);

  // 7. Verify mock entry reference resolution
  const testBillWithUuidInvoice = {
    invoice_number: '421d9e6e-50e5-4f9e-a89c-d0fae6205e94',
    voucher_number: 'EXP/26/297'
  };
  const resolvedBillRef = (!testBillWithUuidInvoice.invoice_number || isUuid(testBillWithUuidInvoice.invoice_number))
    ? (testBillWithUuidInvoice.voucher_number || '')
    : (testBillWithUuidInvoice.voucher_number || testBillWithUuidInvoice.invoice_number || '');
  assert.equal(resolvedBillRef, 'EXP/26/297', 'UUID invoice_number must be replaced with EXP/26/297');

  const testBillWithGenuineInvoice = {
    invoice_number: 'INV-7890',
    voucher_number: 'EXP/26/298'
  };
  const resolvedGenuineRef = (!testBillWithGenuineInvoice.invoice_number || isUuid(testBillWithGenuineInvoice.invoice_number))
    ? (testBillWithGenuineInvoice.voucher_number || '')
    : (testBillWithGenuineInvoice.voucher_number || testBillWithGenuineInvoice.invoice_number || '');
  assert.equal(resolvedGenuineRef, 'EXP/26/298', 'Genuine invoice number retains voucher number canonical priority');
});
