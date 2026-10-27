import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(
  new URL('../src/components/finance/ReceiptVoucherManager.tsx', import.meta.url),
  'utf8',
);

test('Receipt list loads canonical receipt allocations and legacy receipt matches in batch', () => {
  assert.match(source, /from\('bank_statement_allocations'\)[\s\S]{0,180}\.eq\('document_type', 'receipt'\)[\s\S]{0,100}\.in\('document_id', voucherIds\)/);
  assert.match(source, /from\('bank_statement_lines'\)[\s\S]{0,180}\.in\('matched_receipt_id', voucherIds\)/);
});

test('Receipt list prefers canonical allocations and falls back to legacy links without double counting', () => {
  assert.match(source, /Prefer canonical[\s\S]{0,130}legacy[\s\S]{0,160}double-counting/i);
  assert.match(source, /canonicalAmount > 0\.01 \? canonicalAmount : \(legacyAmounts\.get\(voucher\.id\) \|\| 0\)/);
});

test('Receipt row status distinguishes fully linked, partially linked, and unlinked receipts', () => {
  assert.match(source, /linkedAmount >= amount - 0\.01[\s\S]{0,100}'linked'[\s\S]{0,90}'partial'[\s\S]{0,90}'unlinked'/);
  assert.match(source, /voucher\.bank_link_status === 'linked'[\s\S]{0,160}Bank transaction linked/);
  assert.match(source, /voucher\.bank_link_status === 'partial'[\s\S]{0,180}Partially linked/);
  assert.match(source, /voucher\.bank_link_status === 'unlinked'[\s\S]{0,180}Not linked to a bank transaction/);
});

test('Bank-link indicator is placed before View and opens receipt details for linking', () => {
  const indicator = source.indexOf('aria-label={`Bank reconciliation status for ${voucher.voucher_number}');
  const view = source.indexOf('FinanceActionButton action="view" label="View Details"', indicator);
  assert.ok(indicator >= 0, 'Receipt row must show a bank-link status icon');
  assert.ok(view > indicator, 'Status icon must appear before the View icon');
  assert.match(source.slice(indicator, view), /onClick=\{\(\) => handleView\(voucher\)\}/);
});

test('Bank-link status failures are marked unknown instead of falsely shown as unlinked', () => {
  assert.match(source, /status: 'unknown', amount: 0/);
  assert.match(source, /Bank-link status unavailable · Click to check details/);
});
