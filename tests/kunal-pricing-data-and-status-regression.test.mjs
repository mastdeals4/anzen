import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const pricingWorksheetCode = fs.readFileSync('src/pages/PricingWorksheet.tsx', 'utf8');
const evidenceDrawerCode = fs.readFileSync('src/components/pricing/KunalEmailEvidenceDrawer.tsx', 'utf8');

test('1. Four Distinct Price Concepts: Supplier Price, Landed, Suggested Quote, Quoted Price', () => {
  // Main table header must show Landed, Suggested Quote, and Quoted Price
  assert.ok(pricingWorksheetCode.includes('LANDED'), 'Table has LANDED header');
  assert.ok(pricingWorksheetCode.includes('SUGGESTED QUOTE'), 'Table has SUGGESTED QUOTE header');
  assert.ok(pricingWorksheetCode.includes('QUOTED PRICE'), 'Table has QUOTED PRICE header');
  assert.ok(pricingWorksheetCode.includes('SUPPLIER PRICE'), 'Table has SUPPLIER PRICE header');

  // Must have separate cells for each price concept in the grid row
  assert.ok(pricingWorksheetCode.includes('{row.landedCostUsd !== null ? `$${row.landedCostUsd.toFixed(2)}` : \'—\'}'), 'Renders Landed Cost cell');
  assert.ok(pricingWorksheetCode.includes('{row.suggestedQuoteUsd !== null ? `$${row.suggestedQuoteUsd.toFixed(2)}` : \'—\'}'), 'Renders Suggested Quote cell');
  assert.ok(pricingWorksheetCode.includes('value={quotePriceDraft}'), 'Renders Actual Quoted Price input cell');
  assert.ok(pricingWorksheetCode.includes('value={sourcePriceDraft}'), 'Renders Supplier Price input cell');
});

test('2. Load Existing Saved Quote: Selected Option selling_price with crm_inquiries.offered_price fallback', () => {
  assert.ok(
    pricingWorksheetCode.includes('selectedOpt?.selling_price !== undefined && selectedOpt?.selling_price !== null && Number(selectedOpt.selling_price) > 0'),
    'Checks selectedOpt selling_price first',
  );
  assert.ok(
    pricingWorksheetCode.includes('inq.offered_price !== undefined && inq.offered_price !== null && Number(inq.offered_price) > 0'),
    'Falls back to inq.offered_price when selling_price is null or zero',
  );
  assert.ok(
    pricingWorksheetCode.includes('quotePrice: actualQuotedPrice'),
    'Assigns resolved actualQuotedPrice to row',
  );
});

test('3. Pricing Engine: calculateCanonicalPricing does not default quotePrice to suggestedQuote', () => {
  assert.ok(
    pricingWorksheetCode.includes('finalQuote = (overrides?.quotePriceOverride !== undefined && overrides?.quotePriceOverride !== null && overrides.quotePriceOverride > 0)'),
    'finalQuote requires actual override and does not default to suggestedQuote',
  );
});

test('4. Completed Status Rule: Requires Actual Quoted Price', () => {
  // Status logic verification
  assert.ok(
    pricingWorksheetCode.includes('const hasQuotedPrice = actualQuotedPrice !== null && actualQuotedPrice > 0;'),
    'Checks whether an actual quoted price is present',
  );
  assert.ok(
    pricingWorksheetCode.includes("if (hasQuotedPrice) {\n          status = 'Completed';"),
    'Completed status requires actual quoted price',
  );
  assert.ok(
    pricingWorksheetCode.includes("actionReason = 'Quote marked sent but price missing'"),
    'Inconsistent quote_status = sent without price routes to Needs Review',
  );
  assert.ok(
    pricingWorksheetCode.includes("actionReason = 'Status entered but quote price missing'"),
    'Stale kunal_price_status = entered without price routes to Needs Review',
  );
  assert.ok(
    pricingWorksheetCode.includes("actionReason = 'Ready to quote'"),
    'Supplier price without quote routes to Ready to Quote',
  );
});

test('5. Unlinked AI Reviews with no_action do not inflate Completed tab', () => {
  assert.ok(
    pricingWorksheetCode.includes("status = 'Archived';\n            actionReason = 'Archived / Ignored';"),
    'Unmatched no_action reviews are marked Archived instead of Completed',
  );
  assert.ok(
    pricingWorksheetCode.includes("r.rowClassification === 'no_action' || r.status === 'Archived'"),
    'Excludes Archived and no_action rows from Needs Action',
  );
});

test('6. Gmail Evidence Drawer: Safe DOMPurify rendering without raw HTML tags', () => {
  assert.ok(evidenceDrawerCode.includes("import DOMPurify from 'dompurify'"), 'Imports DOMPurify');
  assert.ok(evidenceDrawerCode.includes('renderSafeEmailContent'), 'Implements renderSafeEmailContent');
  assert.ok(evidenceDrawerCode.includes('DOMPurify.sanitize('), 'Sanitizes HTML content');
  assert.ok(evidenceDrawerCode.includes('dangerouslySetInnerHTML={{ __html: sanitized }}'), 'Renders sanitized HTML safely');
  assert.ok(!evidenceDrawerCode.includes('msg.bodyText || msg.body || msg.snippet || \'No text content available in this message.\'}\n                                  </div>'), 'Does NOT render raw HTML inside whitespace-pre-wrap div');
});

test('7. Gmail Evidence Drawer: Full headers including To, CC, and ACE reference', () => {
  assert.ok(evidenceDrawerCode.includes('evidence?.to &&'), 'Displays To in header');
  assert.ok(evidenceDrawerCode.includes('evidence?.cc &&'), 'Displays CC in header');
  assert.ok(evidenceDrawerCode.includes('row.aceerpNo && row.aceerpNo !== \'-\''), 'Displays ACE reference in header');
  assert.ok(evidenceDrawerCode.includes('connectedEmail &&'), 'Displays Connected Gmail account in header');
});

test('8. AI Extraction Side Panel: Displays all requested commercial fields and lineage', () => {
  assert.ok(evidenceDrawerCode.includes('>Product<'), 'Displays Product');
  assert.ok(evidenceDrawerCode.includes('>Supplier<'), 'Displays Supplier');
  assert.ok(evidenceDrawerCode.includes('>Requested Make<'), 'Displays Requested Make');
  assert.ok(evidenceDrawerCode.includes('>Offered Make<'), 'Displays Offered Make');
  assert.ok(evidenceDrawerCode.includes('>Supplier Price<'), 'Displays Supplier Price');
  assert.ok(evidenceDrawerCode.includes('>Currency<'), 'Displays Currency');
  assert.ok(evidenceDrawerCode.includes('>Quantity<'), 'Displays Quantity');
  assert.ok(evidenceDrawerCode.includes('>MOQ & Availability<'), 'Displays MOQ & Availability');
  assert.ok(evidenceDrawerCode.includes('>Lead Time<'), 'Displays Lead Time');
  assert.ok(evidenceDrawerCode.includes('>Inquiry<'), 'Displays Inquiry');
  assert.ok(evidenceDrawerCode.includes('>ACE ERP<'), 'Displays ACE ERP');
});

test('9. Save Flow: Persists selling_price to crm_inquiry_pricing_options and offered_price to crm_inquiries', () => {
  assert.ok(pricingWorksheetCode.includes("from('crm_inquiry_pricing_options')"), 'Updates crm_inquiry_pricing_options');
  assert.ok(pricingWorksheetCode.includes('selling_price: row.quotePrice'), 'Persists selling_price on pricing options');
  assert.ok(pricingWorksheetCode.includes("from('crm_inquiries')"), 'Updates crm_inquiries');
  assert.ok(pricingWorksheetCode.includes('offered_price: row.quotePrice'), 'Persists offered_price on crm_inquiries');
  assert.ok(pricingWorksheetCode.includes("from('pricing_ledger')"), 'Records into pricing_ledger');
});
