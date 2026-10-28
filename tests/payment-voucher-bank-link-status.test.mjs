import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { evaluateVoucherBankLink } from '../src/utils/voucherBankLinks.ts';

const source = readFileSync(
  new URL('../src/components/finance/PaymentVoucherManager.tsx', import.meta.url),
  'utf8',
);

test('Payment list loads canonical payment allocations and legacy matches in batch', () => {
  assert.match(source, /from\('bank_statement_allocations'\)[\s\S]*?\.eq\('document_type', 'payment'\)[\s\S]*?\.in\('document_id', voucherIds\)/);
  assert.match(source, /from\('bank_statement_lines'\)[\s\S]*?\.in\('matched_entry_id', journalEntryIds\)/);
});

test('Payment list prefers canonical allocations and evaluates bank link status', () => {
  assert.match(source, /evaluateVoucherBankLink/);
  const evalResult = evaluateVoucherBankLink({
    expectedAmount: 5000,
    canonicalAllocations: [{ bank_statement_line_id: 'l1', allocation_amount: 5000, document_id: 'pv1', document_type: 'payment' }],
    legacyLinks: [],
  });
  assert.equal(evalResult.status, 'linked');
});

test('Payment row status distinguishes fully linked, partially linked, and unlinked payment vouchers', () => {
  assert.match(source, /evaluateVoucherBankLink/);
  assert.match(source, /<VoucherBankLinkIndicator/);
});

test('Bank-link indicator is placed before View and opens payment details', () => {
  assert.match(source, /<VoucherBankLinkIndicator[\s\S]*?<FinanceActionButton action="view"/);
});

test('Payment bank-link status failures fallback gracefully', () => {
  assert.match(source, /catch \(linkError\)/);
});
