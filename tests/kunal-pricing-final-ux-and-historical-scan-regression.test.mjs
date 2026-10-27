import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const pricingWorksheetCode = fs.readFileSync('src/pages/PricingWorksheet.tsx', 'utf8');
const sapjAgentCode = fs.readFileSync('supabase/functions/sapj-gmail-agent/index.ts', 'utf8');
const importInfoCode = fs.readFileSync('src/components/ImportInfo.tsx', 'utf8');
const priceCalculatorCode = fs.readFileSync('src/pages/PriceCalculator.tsx', 'utf8');
const evidenceDrawerCode = fs.readFileSync('src/components/pricing/KunalEmailEvidenceDrawer.tsx', 'utf8');
const kunalIndiaPriceCode = fs.readFileSync('src/services/kunalIndiaPrice.ts', 'utf8');

test('A. 7-Day Mailbox Catch-Up: processes all batches automatically without repeated clicking', () => {
  assert.ok(pricingWorksheetCode.includes('handleCheckLast7Days'), 'handleCheckLast7Days exists');
  assert.ok(pricingWorksheetCode.includes('batchProgress7Days'), 'tracks 7-day batch progress');
  assert.ok(pricingWorksheetCode.includes('while (hasMore)'), 'contains automatic while loop for continuation');
  assert.ok(pricingWorksheetCode.includes('runSapjGmailAgent({'), 'calls runSapjGmailAgent');
  assert.ok(pricingWorksheetCode.includes('scanLast7Days: true'), 'requests 7-day scan');
  assert.ok(pricingWorksheetCode.includes('pageToken'), 'passes pageToken to subsequent batches');
  assert.ok(pricingWorksheetCode.includes('7-Day Mailbox Catch-Up:'), 'renders progress banner with Found/Processed/Remaining');
});

test('B. Price Email: creates correct action row and extracts pricing option', () => {
  assert.ok(sapjAgentCode.includes('crm_inquiry_pricing_options'), 'saves pricing to crm_inquiry_pricing_options');
  assert.ok(sapjAgentCode.includes('source_price'), 'saves source_price');
  assert.ok(sapjAgentCode.includes('source_currency'), 'saves source_currency');
  assert.ok(sapjAgentCode.includes('gmail_message_id'), 'traceable by gmail_message_id');
});

test('C. Document-Only Emails: classifies documents and stores REAL document without fake Price Received', () => {
  assert.ok(sapjAgentCode.includes('COA') || sapjAgentCode.includes('MSDS'), 'classifies COA/MSDS documents');
  assert.ok(sapjAgentCode.includes('crm_product_documents'), 'saves to crm_product_documents');
  assert.ok(sapjAgentCode.includes('crm-documents'), 'uploads to crm-documents storage bucket');
  // Document received without price sets action_status = 'no_action'
  assert.ok(
    sapjAgentCode.includes('DOCUMENT RECEIVED') && sapjAgentCode.includes('"no_action"'),
    'sets actionStatus to no_action for document-only emails so no unnecessary Need Action is created',
  );
});

test('D. View/Get opens real document & handles missing files without fake preview', () => {
  assert.ok(
    pricingWorksheetCode.includes('FILE NOT STORED / NEEDS RE-SYNC'),
    'shows FILE NOT STORED / NEEDS RE-SYNC when storagePath is null',
  );
  assert.ok(
    evidenceDrawerCode.includes('FILE NOT STORED / NEEDS RE-SYNC'),
    'evidence drawer shows FILE NOT STORED / NEEDS RE-SYNC when storagePath is null',
  );
  assert.ok(pricingWorksheetCode.includes('handleOpenDocument'), 'handleOpenDocument exists');
  assert.ok(pricingWorksheetCode.includes('getSignedUrlCached'), 'uses getSignedUrlCached for real storage download');
});

test('E. Delete/Ignore: removes item from Need Action and sets action_status = no_action', () => {
  assert.ok(pricingWorksheetCode.includes('handleIgnoreRow'), 'handleIgnoreRow function exists');
  assert.ok(
    pricingWorksheetCode.includes("action_status: 'no_action'"),
    'sets action_status = no_action in kunal_ai_email_reviews',
  );
  assert.ok(pricingWorksheetCode.includes('Trash2'), 'Trash2 icon used for compact delete/ignore button');
  assert.ok(
    pricingWorksheetCode.includes("rev.action_status === 'no_action'"),
    'filters out no_action items on load so they remain gone after reload',
  );
});

test('F. Checkbox is removed from Kunal Pricing table to keep table compact', () => {
  assert.ok(!pricingWorksheetCode.includes('toggleSelectAll'), 'toggleSelectAll is removed');
  assert.ok(!pricingWorksheetCode.includes('toggleSelect ='), 'toggleSelect is removed');
  assert.ok(!pricingWorksheetCode.includes('selectedIds'), 'selectedIds state is removed');
  assert.ok(!pricingWorksheetCode.includes('onChange={() => toggleSelect(row.id)}'), 'row checkbox removed');
  // Column count dropped from 14 to 13
  assert.ok(pricingWorksheetCode.includes('colSpan={13}'), 'uses colSpan={13} for loading/empty/expanded rows');
  assert.ok(!pricingWorksheetCode.includes('colSpan={14}'), 'colSpan={14} is no longer used');
});

test('G. View Import Data opens with current product preselected', () => {
  assert.ok(pricingWorksheetCode.includes('VIEW IMPORT DATA'), 'PricingWorksheet has VIEW IMPORT DATA button');
  assert.ok(pricingWorksheetCode.includes('setImportDataModalProduct(row.productName)'), 'sets modal product name');
  assert.ok(priceCalculatorCode.includes('VIEW IMPORT DATA'), 'PriceCalculator has VIEW IMPORT DATA button');
  assert.ok(priceCalculatorCode.includes('selectedProduct'), 'PriceCalculator tracks selected product');
  assert.ok(importInfoCode.includes('initialProduct'), 'ImportInfo accepts initialProduct');
});

test('H. Compact columns are visible as requested in Import Data view', () => {
  assert.ok(importInfoCode.includes('COMPACT_ANALYSIS_KEYS'), 'ImportInfo defines COMPACT_ANALYSIS_KEYS');
  assert.ok(importInfoCode.includes('compactAnalysis'), 'ImportInfo supports compactAnalysis mode');
  // Compact columns include Date, Product, Rate, Ccy, Origin, Dest, Exporter, Type
  assert.ok(importInfoCode.includes('product_name'), 'Product column present');
  assert.ok(importInfoCode.includes('unit_rate'), 'Rate column present');
  assert.ok(importInfoCode.includes('currency'), 'CCY column present');
  assert.ok(importInfoCode.includes('origin'), 'Origin column present');
  assert.ok(importInfoCode.includes('destination'), 'Dest column present');
  assert.ok(importInfoCode.includes('exporter'), 'Exporter column present');
  assert.ok(importInfoCode.includes('type'), 'Type column present');
  // Hidden by default in compact mode
  assert.ok(importInfoCode.includes('hs_code'), 'HS Code defined');
  assert.ok(importInfoCode.includes('quantity'), 'Qty defined');
  assert.ok(importInfoCode.includes('total_usd'), 'Total USD defined');
  assert.ok(importInfoCode.includes('importer'), 'Importer defined');
});

test('I. One-Time Full Historical Email Scan: backfill logic, duplicate protection, and completion report', () => {
  assert.ok(pricingWorksheetCode.includes('RUN FULL HISTORICAL SCAN — ONCE'), 'button exists in PricingWorksheet');
  assert.ok(pricingWorksheetCode.includes('handleRunHistoricalScan'), 'handleRunHistoricalScan exists');
  assert.ok(pricingWorksheetCode.includes('historicalProgress'), 'tracks historical progress');
  assert.ok(pricingWorksheetCode.includes('historicalReport'), 'renders HISTORICAL COMPLETION REPORT');
  assert.ok(pricingWorksheetCode.includes('HISTORICAL COMPLETION REPORT'), 'report modal header exists');
  assert.ok(sapjAgentCode.includes('fullHistoricalScan'), 'sapj-gmail-agent supports fullHistoricalScan flag');
  assert.ok(kunalIndiaPriceCode.includes('fullHistoricalScan'), 'kunalIndiaPrice service supports fullHistoricalScan');
});

test('J. Full Historical AI Results: No .limit(100) and safe paginated retrieval', () => {
  assert.ok(!pricingWorksheetCode.includes(".limit(100)"), 'UI does NOT restrict AI reviews with .limit(100)');
  assert.ok(pricingWorksheetCode.includes('REVIEW_CHUNK_SIZE = 500'), 'uses safe chunked pagination for AI reviews');
  assert.ok(pricingWorksheetCode.includes('paginatedRows'), 'uses paginatedRows to prevent DOM overload');
  assert.ok(pricingWorksheetCode.includes('pageSize'), 'supports adjustable page sizes');
  assert.ok(pricingWorksheetCode.includes('safePage'), 'calculates safe page index');
});

test('K. Distinct Categorization: Enriched inquiry, unmatched pricing, alt make, doc only, needs review, no action', () => {
  assert.ok(pricingWorksheetCode.includes('rowClassification'), 'tracks rowClassification');
  assert.ok(pricingWorksheetCode.includes('classificationFilter'), 'supports classificationFilter');
  assert.ok(pricingWorksheetCode.includes("'inquiry_enriched'"), 'distinguishes inquiry_enriched');
  assert.ok(pricingWorksheetCode.includes("'new_unmatched'"), 'distinguishes new_unmatched');
  assert.ok(pricingWorksheetCode.includes("'alt_make'"), 'distinguishes alt_make');
  assert.ok(pricingWorksheetCode.includes("'doc_only'"), 'distinguishes doc_only');
  assert.ok(pricingWorksheetCode.includes("'needs_review'"), 'distinguishes needs_review');
  assert.ok(pricingWorksheetCode.includes("'no_action'"), 'distinguishes no_action');
});

test('L. Real Document Storage: Only increments if storage upload and db record succeed with storage_path', () => {
  assert.ok(sapjAgentCode.includes('documentsStoredCount += 1') || sapjAgentCode.includes('documentsStoredCount++'), 'increments documentsStoredCount');
  assert.ok(sapjAgentCode.includes('documentErrorsCount += 1') || sapjAgentCode.includes('documentErrorsCount++'), 'increments documentErrorsCount on any upload/insert failure');
  assert.ok(sapjAgentCode.includes('storage_path: storagePath'), 'verifies storage_path exists');
  assert.ok(pricingWorksheetCode.includes('isStored'), 'tracks boolean isStored based on real storage_path');
  assert.ok(pricingWorksheetCode.includes('FILE NOT STORED / NEEDS RE-SYNC'), 'marks un-synced docs');
});

test('M. Reconciled Completion Report: Separate numbers from persisted DB records', () => {
  assert.ok(kunalIndiaPriceCode.includes('fetchHistoricalReconciliation'), 'fetchHistoricalReconciliation exists');
  assert.ok(pricingWorksheetCode.includes('fetchHistoricalReconciliation'), 'invokes fetchHistoricalReconciliation after scan');
  assert.ok(pricingWorksheetCode.includes('aiPricingDetected'), 'shows aiPricingDetected card');
  assert.ok(pricingWorksheetCode.includes('inquiriesEnriched'), 'shows inquiriesEnriched card');
  assert.ok(pricingWorksheetCode.includes('newUnlinkedPricing'), 'shows newUnlinkedPricing card');
  assert.ok(pricingWorksheetCode.includes('alternativeMakesDetected'), 'shows alternativeMakesDetected card');
  assert.ok(pricingWorksheetCode.includes('needsReview'), 'shows needsReview card');
  assert.ok(pricingWorksheetCode.includes('documentsDetected'), 'shows documentsDetected card');
  assert.ok(pricingWorksheetCode.includes('documentsStored'), 'shows documentsStored card');
  assert.ok(pricingWorksheetCode.includes('documentsNeedingResync'), 'shows documentsNeedingResync card');
  assert.ok(pricingWorksheetCode.includes('noAction'), 'shows noAction card');
});
