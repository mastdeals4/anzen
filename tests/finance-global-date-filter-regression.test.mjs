import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const cases = [
  ['src/components/finance/ReceiptVoucherManager.tsx', 'receipt_vouchers', 'voucher_date'],
  ['src/components/finance/PaymentVoucherManager.tsx', 'payment_vouchers', 'voucher_date'],
  ['src/components/finance/FundTransferManager.tsx', 'vw_fund_transfers_detailed', 'transfer_date'],
  ['src/components/finance/JournalEntryViewerEnhanced.tsx', 'journal_entries', 'entry_date'],
  ['src/components/finance/PurchaseInvoiceManager.tsx', 'purchase_invoices', 'invoice_date'],
  ['src/components/finance/PayablesManager.tsx', 'vendor_bills', 'bill_date'],
  ['src/components/finance/PayablesManager.tsx', 'vendor_payments', 'payment_date'],
];

for (const [file, table, dateColumn] of cases) {
  const source = await readFile(file, 'utf8');
  assert.match(source, /useFinance/, `${file} must use the existing global Finance context`);
  const chunks = source.split(`.from('${table}')`).slice(1);
  assert.ok(chunks.length > 0, `${file} must query ${table}`);
  const hasDateFilter = chunks.some(chunk => {
    const snippet = chunk.slice(0, 1500);
    return new RegExp(`\\.gte\\('${dateColumn}', dateRange\\.startDate\\)`).test(snippet) &&
      new RegExp(`\\.lte\\('${dateColumn}', dateRange\\.endDate\\)`).test(snippet);
  });
  assert.ok(hasDateFilter, `${table} must apply the global start and end date to ${dateColumn}`);
}

console.log('finance global date-filter regression passed');
