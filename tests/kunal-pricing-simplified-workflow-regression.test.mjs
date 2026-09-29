import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const pricingWorksheetPath = resolve(process.cwd(), 'src/pages/PricingWorksheet.tsx');
const evidenceDrawerPath = resolve(process.cwd(), 'src/components/pricing/KunalEmailEvidenceDrawer.tsx');

const pricingWorksheetSrc = readFileSync(pricingWorksheetPath, 'utf8');
const evidenceDrawerSrc = readFileSync(evidenceDrawerPath, 'utf8');

test('1. Workflow Architecture: Need Action -> Review -> Actual Quoted Price -> Save -> Completed', () => {
  // Verify that handleSaveRow transitions directly to Completed when quote is entered
  assert.match(
    pricingWorksheetSrc,
    /if\s*\(\s*isQuoteEntered\s*\)\s*\{\s*nextStatus\s*=\s*['"]Completed['"];/s,
    'handleSaveRow must directly set status to Completed when isQuoteEntered is true',
  );

  // Verify that unquoted rows with supplier price remain in Needs Review (Need Action Now), NOT jumped back to Waiting Supplier
  assert.match(
    pricingWorksheetSrc,
    /else\s+if\s*\(\s*row\.sourcePrice\s*&&\s*row\.sourcePrice\s*>\s*0\s*\)\s*\{\s*nextStatus\s*=\s*['"]Needs Review['"];/s,
    'handleSaveRow must keep unquoted rows with supplier price in Needs Review so they stay in Need Action Now',
  );

  // Verify Waiting Supplier remains separate
  assert.match(
    pricingWorksheetSrc,
    /else\s*\{\s*nextStatus\s*=\s*['"]Waiting Supplier['"];/s,
    'handleSaveRow must keep rows with no supplier price in Waiting Supplier',
  );
});

test('2. Suggested Quote is a Recommendation Only and Not Customer Quote', () => {
  // calculateCanonicalPricing must not assign quotePrice to suggestedQuote
  assert.match(
    pricingWorksheetSrc,
    /const\s+finalQuote\s*=\s*\(overrides\?\.quotePriceOverride\s*!==\s*undefined\s*&&\s*overrides\?\.quotePriceOverride\s*!==\s*null\s*&&\s*overrides\.quotePriceOverride\s*>\s*0\)\s*\?\s*overrides\.quotePriceOverride\s*:\s*null;/,
    'calculateCanonicalPricing must only assign quotePrice if quotePriceOverride exists',
  );

  // In AI review calculation, quotePriceOverride must be passed to protect actual quote
  assert.match(
    pricingWorksheetSrc,
    /quotePriceOverride:\s*targetRow\.quotePrice/,
    'AI review processing must pass quotePriceOverride: targetRow.quotePrice',
  );
});

test('3. Primary Flow Tabs vs Informational Sub-Filters', () => {
  // Primary flow tabs must include NEED ACTION NOW, Waiting Supplier, Completed, All
  assert.ok(pricingWorksheetSrc.includes('NEED ACTION NOW'), 'NEED ACTION NOW tab must exist');
  assert.ok(pricingWorksheetSrc.includes('Waiting Supplier'), 'Waiting Supplier tab must exist');
  assert.ok(pricingWorksheetSrc.includes('Completed'), 'Completed tab must exist');

  // Informational sub-filters must be labeled as filters and separated
  assert.ok(pricingWorksheetSrc.includes('Informational Sub-filters'), 'Informational Sub-filters comment must exist');
  assert.ok(pricingWorksheetSrc.includes('title="Informational filter: inquiries where supplier price has been received"'), 'Price Received sub-filter tooltip must exist');
  assert.ok(pricingWorksheetSrc.includes('title="Informational filter: inquiries ready for customer quotation"'), 'Ready to Quote sub-filter tooltip must exist');
});

test('4. Direct Quoting in Evidence Drawer & Quick Use Actions', () => {
  // Table cell must have quick 'Use' button to populate suggested quote if empty
  assert.ok(
    pricingWorksheetSrc.includes('title={`Use Suggested Quote: $${row.suggestedQuoteUsd.toFixed(2)}`}'),
    'Table cell must have Use button for Suggested Quote',
  );

  // Expanded Column C must also have Use Suggested button
  assert.ok(
    pricingWorksheetSrc.includes('Use Suggested ($'),
    'Expanded column C must have Use Suggested button',
  );

  // Evidence drawer must display Landed Cost, Suggested Quote, and Actual Quoted Price
  assert.ok(evidenceDrawerSrc.includes('Landed Cost'), 'Drawer must display Landed Cost');
  assert.ok(evidenceDrawerSrc.includes('Suggested Quote'), 'Drawer must display Suggested Quote');
  assert.ok(evidenceDrawerSrc.includes('Actual Quoted Price'), 'Drawer must display Actual Quoted Price');
  assert.ok(evidenceDrawerSrc.includes('editQuotePrice'), 'Drawer edit form must support editQuotePrice');
});
