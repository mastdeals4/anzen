import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(
  new URL('../src/components/finance/PaymentVoucherManager.tsx', import.meta.url),
  'utf8',
);

test('Payment list loads canonical payment allocations and legacy matches in batch', () => {
  assert.match(source, /from\('bank_statement_allocations'\)[\s\S]{0,400}\.eq\('document_type', 'payment'\)[\s\S]{0,100}\.in\('document_id', voucherIds\)/);
  assert.match(source, /from\('bank_statement_lines'\)[\s\S]{0,400}\.in\('matched_entry_id', journalEntryIds\)/);
});

test('Payment list prefers canonical allocations and falls back to legacy links without double counting', () => {
  assert.match(source, /Prefer canonical allocations; only fall back to legacy journal matches/i);
  assert.match(source, /canonicalAmount > 0\.01 \? canonicalAmount : legacyAmount/);
});

test('Payment row status distinguishes fully linked, partially linked, and unlinked payment vouchers', () => {
  assert.match(source, /linkedAmount >= debitRequired - 0\.01[\s\S]{0,100}'linked'[\s\S]{0,90}'partial'[\s\S]{0,90}'unlinked'/);
  assert.match(source, /v\.bank_link_status === 'linked'[\s\S]{0,160}Bank transaction linked/);
  assert.match(source, /v\.bank_link_status === 'partial'[\s\S]{0,180}Partially linked/);
  assert.match(source, /v\.bank_link_status === 'unlinked'[\s\S]{0,180}Not linked to a bank transaction/);
  assert.match(source, /text-green-700 hover:bg-green-50/);
  assert.match(source, /text-amber-700 hover:bg-amber-50/);
  assert.match(source, /text-red-600 hover:bg-red-50/);
  assert.match(source, /text-gray-400 hover:bg-gray-100/);
});

test('Bank-link indicator is placed before View and opens payment details', () => {
  const indicator = source.indexOf('aria-label={`Bank reconciliation status for ${v.voucher_number}:');
  const view = source.indexOf('<FinanceActionButton action="view"', indicator);
  assert.ok(indicator >= 0, 'Payment row must show a bank-link status icon');
  assert.ok(view > indicator, 'Status icon must appear before the View action button');
  assert.match(source.slice(indicator, view), /onClick=\{\(e\) => \{ e\.stopPropagation\(\); handleView\(v\); \}\}/);
});

test('Payment bank-link status failures fallback to unknown gracefully', () => {
  assert.match(source, /bankLinkStatus = 'unknown'/);
  assert.match(source, /Bank-link status unavailable · Click to check details/);
});
