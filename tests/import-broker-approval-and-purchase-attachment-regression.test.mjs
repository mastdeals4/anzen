import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const migration = await readFile('supabase/migrations/20260830138000_fix_import_broker_approval_trigger_order.sql', 'utf8');
const purchaseInvoiceManager = await readFile('src/components/finance/PurchaseInvoiceManager.tsx', 'utf8');
const signedUrlCache = await readFile('src/utils/signedUrlCache.ts', 'utf8');

assert.match(migration, /DROP TRIGGER IF EXISTS zzzzz_post_customs_broker_canonical_insert/);
assert.match(migration, /DROP TRIGGER IF EXISTS zzzzz_post_customs_broker_canonical_update/);
assert.match(migration, /CREATE TRIGGER a_post_customs_broker_canonical_insert/);
assert.match(migration, /CREATE TRIGGER a_post_customs_broker_canonical_update/);
assert.equal((migration.match(/EXECUTE FUNCTION public\.post_customs_broker_canonical\(\)/g) || []).length, 2);
assert.doesNotMatch(migration, /CREATE OR REPLACE FUNCTION public\.post_customs_broker_canonical/);

assert.match(purchaseInvoiceManager, /import \{ downloadStorageDocument, openStorageDocument, resolveStorageUrlCached \}/);
assert.match(purchaseInvoiceManager, /await openStorageDocument\(url\)/);
assert.match(purchaseInvoiceManager, /await downloadStorageDocument\(url, filename\)/);
assert.doesNotMatch(purchaseInvoiceManager, /href=\{signedUrlCache\[url\] \|\| url\}/);
assert.doesNotMatch(purchaseInvoiceManager, /href=\{signedUrlCache\[selectedInvoice\.document_urls\[0\]\] \|\| selectedInvoice\.document_urls\[0\]\}/);
assert.ok(signedUrlCache.includes('/storage\\/v1\\/object\\/(?:public|sign)\\/'));
assert.match(signedUrlCache, /Unable to create a signed URL for this attachment/);

console.log('import broker approval and purchase attachment regression checks passed');
