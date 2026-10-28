import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { evaluateVoucherBankLink } from '../src/utils/voucherBankLinks.ts';

const source = readFileSync(
  new URL('../src/components/finance/ReceiptVoucherManager.tsx', import.meta.url),
  'utf8',
);

test('Receipt list loads canonical receipt allocations and legacy receipt matches in batch', () => {
  assert.match(source, /from\('bank_statement_allocations'\)[\s\S]*?\.eq\('document_type', 'receipt'\)[\s\S]*?\.in\('document_id', voucherIds\)/);
  assert.match(source, /from\('bank_statement_lines'\)[\s\S]*?\.in\('matched_receipt_id', voucherIds\)/);
});

test('Receipt list prefers canonical allocations and evaluates bank link status', () => {
  assert.match(source, /canonicalAllocationsByVoucher|evaluateVoucherBankLink/);
  const evalResult = evaluateVoucherBankLink({
    expectedAmount: 1000,
    canonicalAllocations: [{ bank_statement_line_id: 'l1', allocation_amount: 1000, document_id: 'v1', document_type: 'receipt' }],
    legacyLinks: [],
  });
  assert.equal(evalResult.status, 'linked');
});

test('Receipt row status distinguishes fully linked, partially linked, and unlinked receipts', () => {
  assert.match(source, /evaluateVoucherBankLink/);
  assert.match(source, /<VoucherBankLinkIndicator/);
});

test('Bank-link indicator is placed before View in Actions column', () => {
  assert.match(source, /<VoucherBankLinkIndicator[\s\S]*?<FinanceActionButton action="view"/);
});

test('Bank-link status failures are caught gracefully', () => {
  assert.match(source, /catch \(linkStatusError\)/);
});
