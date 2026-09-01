import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile('src/components/finance/PurchaseInvoiceManager.tsx', 'utf8');
assert.match(source, /extractPurchaseInvoicePdf\(file\)/);
assert.match(source, /document_urls: \[\.\.\.prev\.document_urls, \.\.\.uploadedUrls\]/);
assert.match(source, /draft\.lines\.length > 0 && lineItems\.length === 0/);
assert.match(source, /PDF extraction unavailable/);
console.log('purchase invoice PDF attachment/extraction regression checks passed');
