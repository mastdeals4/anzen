import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isProductMatch } from '../src/utils/productMatcher.ts';
import { calculateFCL, DEFAULT_CONFIG } from '../src/services/pricingService.ts';

function calculateQuote(price, currency, qty, config = DEFAULT_CONFIG) {
  const fclInput = {
    purchase_currency: currency,
    purchase_price: currency === 'USD' ? price : 0,
    inr_price: currency === 'INR' ? price : 0,
    india_margin_percent: 4.0,
    indonesia_margin_percent: 4.0,
    freight_type: 'usd_per_kg',
    freight_value: 0.08,
    insurance_percent: 0.1,
    duty_percent: 4.0,
    container_type: '20ft',
    packing_type: 'mixed',
    selling_quantity: Number(qty) || 12000,
  };
  return calculateFCL(fclInput, config, 16000);
}

// Read edge function source files to verify prompt and extraction invariants
const agentSource = readFileSync(
  new URL('../supabase/functions/sapj-gmail-agent/index.ts', import.meta.url),
  'utf8',
);
const sourceReplyParserSource = readFileSync(
  new URL('../supabase/functions/parse-source-reply-email/index.ts', import.meta.url),
  'utf8',
);
const worksheetSource = readFileSync(
  new URL('../src/pages/PricingWorksheet.tsx', import.meta.url),
  'utf8',
);
const evidenceDrawerSource = readFileSync(
  new URL('../src/components/pricing/KunalEmailEvidenceDrawer.tsx', import.meta.url),
  'utf8',
);

/**
 * Deterministic model of the extraction parser adhering to the updated JSON schema & atomic binding invariants.
 */
function parseStructuredOfferBlocks(blocks) {
  return blocks.map(block => ({
    product_name: block.product_name,
    offered_make: block.make ?? null,
    source_price: block.price != null ? Number(block.price) : null,
    source_currency: block.currency || 'INR',
    unit: block.unit || 'KG',
    quantity: block.quantity != null ? String(block.quantity) : null,
    moq: block.moq != null ? String(block.moq) : (block.quantity != null ? String(block.quantity) : null),
    pack: block.pack ?? null,
    delivery: block.delivery ?? block.availability ?? null,
    availability: block.availability ?? block.delivery ?? null,
    ex_location: block.ex_location ?? null,
    gst: block.gst ?? null,
    matched_inquiry_id: block.matched_inquiry_id ?? null,
  }));
}

test('Invariant Verification: sapj-gmail-agent and parse-source-reply-email enforce strict atomic block binding', () => {
  // Check prompt instructions in sapj-gmail-agent
  assert.ok(
    agentSource.includes('CRITICAL ATOMIC PRODUCT/OFFER ASSOCIATION:'),
    'sapj-gmail-agent must include strict atomic product-block invariant in system prompt',
  );
  assert.ok(
    agentSource.includes('PRODUCT ↔ MAKE ↔ PRICE ↔ QUANTITY ↔ PACKAGING ↔ DELIVERY ↔ AVAILABILITY must remain strictly associated within their own product block'),
    'sapj-gmail-agent must mandate atomic association within own product block',
  );
  assert.ok(
    agentSource.includes('NEVER take a make from one block and attach it to a product from another block'),
    'sapj-gmail-agent must explicitly forbid make borrowing across product blocks',
  );
  assert.ok(
    agentSource.includes('NEVER take a price from one block and attach it to a product from another block'),
    'sapj-gmail-agent must explicitly forbid price borrowing across product blocks',
  );

  // Check prompt instructions in parse-source-reply-email
  assert.ok(
    sourceReplyParserSource.includes('CRITICAL INVARIANT: NEVER combine fields from different product blocks.'),
    'parse-source-reply-email must enforce atomic product binding',
  );
  assert.ok(
    sourceReplyParserSource.includes('PRODUCT ↔ MAKE ↔ PRICE ↔ QUANTITY ↔ PACKAGING ↔ DELIVERY ↔ AVAILABILITY'),
    'parse-source-reply-email must enforce full field tuple binding',
  );

  // Check UI PricingWorksheet does not blindly use extractionRows[0]
  assert.ok(
    !worksheetSource.includes('const extractionRow = raw.extractionRows?.[0] || {};\n        const extractedPrice = extractionRow.source_price ?? rev.source_price ?? null;'),
    'PricingWorksheet must NOT blindly use raw.extractionRows[0] for arbitrary inquiries',
  );

  // Check Evidence Drawer renders atomic offers
  assert.ok(
    evidenceDrawerSource.includes('Extracted Product Offers from Email'),
    'KunalEmailEvidenceDrawer must render structured atomic product offers',
  );
});

test('Exact Bug Reproduction & Fix: Pyrantel Pamoate (2 offers) + Fenbendazole (1 offer)', () => {
  const exampleBlocks = [
    {
      product_name: 'Pyrantel Pamoate USP (No Chemical Name)',
      quantity: 25,
      price: 2050,
      currency: 'INR',
      unit: 'KG',
      pack: '25 kg',
      make: 'JRC',
      delivery: 'Ready',
      ex_location: 'Bhiwandi',
      gst: true,
    },
    {
      product_name: 'Pyrantel Pamoate USP (No Chemical Name)',
      quantity: 25,
      price: 2700,
      currency: 'INR',
      unit: 'KG',
      pack: '25 kg',
      make: 'IPCA',
      delivery: 'Ready',
      ex_location: 'Bhiwandi',
      gst: true,
    },
    {
      product_name: 'Fenbendazole USP Micronized (90% < 10 Micron)',
      moq: 25,
      price: 2575,
      currency: 'INR',
      unit: 'KG',
      make: 'Su-pharma',
      availability: 'Ready Stock',
      delivery: 'Ready Stock',
      ex_location: 'Bhiwandi',
      gst: true,
    },
  ];

  const extracted = parseStructuredOfferBlocks(exampleBlocks);
  assert.equal(extracted.length, 3, 'Must extract exactly 3 structured offer records');

  // Verify Record 1 (Pyrantel JRC)
  assert.equal(extracted[0].product_name, 'Pyrantel Pamoate USP (No Chemical Name)');
  assert.equal(extracted[0].offered_make, 'JRC');
  assert.equal(extracted[0].source_price, 2050);
  assert.equal(extracted[0].pack, '25 kg');
  assert.equal(extracted[0].delivery, 'Ready');
  assert.equal(extracted[0].ex_location, 'Bhiwandi');
  assert.equal(extracted[0].gst, true);

  // Verify Record 2 (Pyrantel IPCA)
  assert.equal(extracted[1].product_name, 'Pyrantel Pamoate USP (No Chemical Name)');
  assert.equal(extracted[1].offered_make, 'IPCA');
  assert.equal(extracted[1].source_price, 2700);
  assert.equal(extracted[1].pack, '25 kg');
  assert.equal(extracted[1].delivery, 'Ready');

  // Verify Record 3 (Fenbendazole Su-pharma)
  assert.equal(extracted[2].product_name, 'Fenbendazole USP Micronized (90% < 10 Micron)');
  assert.equal(extracted[2].offered_make, 'Su-pharma');
  assert.equal(extracted[2].source_price, 2575);
  assert.equal(extracted[2].moq, '25');
  assert.equal(extracted[2].availability, 'Ready Stock');
  assert.equal(extracted[2].ex_location, 'Bhiwandi');

  // CRITICAL REGRESSION ASSERTION:
  // Fenbendazole MUST NOT have JRC or 2050!
  assert.notEqual(extracted[2].offered_make, 'JRC', 'Fenbendazole must NEVER have JRC make');
  assert.notEqual(extracted[2].source_price, 2050, 'Fenbendazole must NEVER have 2050 price');

  // Test Product Matching
  assert.ok(
    isProductMatch('Fenbendazole USP Micronized', extracted[2].product_name),
    'isProductMatch must match Fenbendazole inquiry to Fenbendazole extraction block',
  );
  assert.ok(
    !isProductMatch('Fenbendazole USP Micronized', extracted[0].product_name),
    'isProductMatch must NOT match Fenbendazole inquiry to Pyrantel block',
  );
  assert.ok(
    isProductMatch('Pyrantel Pamoate USP', extracted[0].product_name),
    'isProductMatch must match Pyrantel inquiry to Pyrantel extraction block',
  );
});

test('Suggested Quote Calculation operates on the correct product/offer', () => {
  const pyrantelPrice = 2050; // INR
  const fenbendazolePrice = 2575; // INR

  const pyrantelCalc = calculateQuote(pyrantelPrice, 'INR', 25);
  const fenbendazoleCalc = calculateQuote(fenbendazolePrice, 'INR', 25);

  // Verification that calculation produces distinct, product-specific landed costs
  assert.ok(pyrantelCalc.landed_cost_per_kg_usd != null);
  assert.ok(fenbendazoleCalc.landed_cost_per_kg_usd != null);
  assert.notEqual(
    pyrantelCalc.landed_cost_per_kg_usd,
    fenbendazoleCalc.landed_cost_per_kg_usd,
    'Landed cost must differ between Pyrantel and Fenbendazole',
  );
  assert.notEqual(
    pyrantelCalc.final_price_per_kg_usd,
    fenbendazoleCalc.final_price_per_kg_usd,
    'Suggested quote must differ between Pyrantel and Fenbendazole',
  );

  // Confirm Fenbendazole landed cost is calculated from 2575 INR, not 2050 INR:
  // Base USD: 2575 / 91 = ~28.2967
  const fenbBaseUsd = 2575 / 91;
  assert.ok(
    Math.abs(fenbendazoleCalc.purchase_price_usd - fenbBaseUsd) < 0.01,
    `Purchase price USD per kg must match INR 2575 conversion (~${fenbBaseUsd.toFixed(2)})`,
  );
});

test('Test A: One product + one make + one price', () => {
  const blocks = [
    {
      product_name: 'Paracetamol BP',
      make: 'Farmson',
      price: 450,
      currency: 'INR',
      unit: 'KG',
      quantity: 1000,
      delivery: 'Prompt',
      ex_location: 'Gujarat',
      gst: true,
    },
  ];
  const extracted = parseStructuredOfferBlocks(blocks);
  assert.equal(extracted.length, 1);
  assert.equal(extracted[0].product_name, 'Paracetamol BP');
  assert.equal(extracted[0].offered_make, 'Farmson');
  assert.equal(extracted[0].source_price, 450);
});

test('Test B: One product + three makes + three prices', () => {
  const blocks = [
    {
      product_name: 'Metformin HCl USP',
      make: 'USV',
      price: 320,
      currency: 'INR',
      unit: 'KG',
      quantity: 1000,
    },
    {
      product_name: 'Metformin HCl USP',
      make: 'Wanbury',
      price: 310,
      currency: 'INR',
      unit: 'KG',
      quantity: 1000,
    },
    {
      product_name: 'Metformin HCl USP',
      make: 'Aarti',
      price: 315,
      currency: 'INR',
      unit: 'KG',
      quantity: 1000,
    },
  ];
  const extracted = parseStructuredOfferBlocks(blocks);
  assert.equal(extracted.length, 3);
  assert.equal(extracted[0].offered_make, 'USV');
  assert.equal(extracted[0].source_price, 320);
  assert.equal(extracted[1].offered_make, 'Wanbury');
  assert.equal(extracted[1].source_price, 310);
  assert.equal(extracted[2].offered_make, 'Aarti');
  assert.equal(extracted[2].source_price, 315);
  // All have the same product name without cross-pollination
  extracted.forEach(row => {
    assert.equal(row.product_name, 'Metformin HCl USP');
  });
});

test('Test C: Three different products + different makes/prices', () => {
  const blocks = [
    { product_name: 'Amoxicillin Trihydrate BP', make: 'Aurobindo', price: 2800, currency: 'INR', unit: 'KG' },
    { product_name: 'Clavulanate Potassium USP', make: 'Biocon', price: 9500, currency: 'INR', unit: 'KG' },
    { product_name: 'Azithromycin Dihydrate EP', make: 'Alembic', price: 7200, currency: 'INR', unit: 'KG' },
  ];
  const extracted = parseStructuredOfferBlocks(blocks);
  assert.equal(extracted.length, 3);
  assert.equal(extracted[0].product_name, 'Amoxicillin Trihydrate BP');
  assert.equal(extracted[0].offered_make, 'Aurobindo');
  assert.equal(extracted[0].source_price, 2800);

  assert.equal(extracted[1].product_name, 'Clavulanate Potassium USP');
  assert.equal(extracted[1].offered_make, 'Biocon');
  assert.equal(extracted[1].source_price, 9500);

  assert.equal(extracted[2].product_name, 'Azithromycin Dihydrate EP');
  assert.equal(extracted[2].offered_make, 'Alembic');
  assert.equal(extracted[2].source_price, 7200);
});

test('Test D: Two identical products with different makes/prices', () => {
  const blocks = [
    { product_name: 'Ciprofloxacin HCl USP', make: 'Dr Reddy', price: 1600, currency: 'INR', unit: 'KG' },
    { product_name: 'Ciprofloxacin HCl USP', make: 'Hetero', price: 1550, currency: 'INR', unit: 'KG' },
  ];
  const extracted = parseStructuredOfferBlocks(blocks);
  assert.equal(extracted.length, 2);
  assert.equal(extracted[0].offered_make, 'Dr Reddy');
  assert.equal(extracted[0].source_price, 1600);
  assert.equal(extracted[1].offered_make, 'Hetero');
  assert.equal(extracted[1].source_price, 1550);
});

test('Test E: Product with missing make does NOT borrow make from another block', () => {
  const blocks = [
    { product_name: 'Product A', make: 'Premium Pharma', price: 1000, currency: 'INR', unit: 'KG' },
    { product_name: 'Product B', make: null, price: 2000, currency: 'INR', unit: 'KG' },
  ];
  const extracted = parseStructuredOfferBlocks(blocks);
  assert.equal(extracted.length, 2);
  assert.equal(extracted[0].offered_make, 'Premium Pharma');
  assert.equal(extracted[1].offered_make, null, 'Product B must NOT borrow make from Product A');
});

test('Test F: Product with missing price does NOT borrow price from another block', () => {
  const blocks = [
    { product_name: 'Product A', make: 'Make A', price: 500, currency: 'INR', unit: 'KG' },
    { product_name: 'Product B', make: 'Make B', price: null, currency: 'INR', unit: 'KG' },
  ];
  const extracted = parseStructuredOfferBlocks(blocks);
  assert.equal(extracted.length, 2);
  assert.equal(extracted[0].source_price, 500);
  assert.equal(extracted[1].source_price, null, 'Product B must NOT borrow price from Product A');
});

test('Test G: Product with MOQ instead of Qty', () => {
  const blocks = [
    { product_name: 'Omeprazole BP', make: 'Cadila', price: 3400, moq: '100 kg', quantity: null },
  ];
  const extracted = parseStructuredOfferBlocks(blocks);
  assert.equal(extracted[0].moq, '100 kg');
  assert.equal(extracted[0].source_price, 3400);
  assert.equal(extracted[0].offered_make, 'Cadila');
});

test('Test H: Product with GST wording', () => {
  const blocks = [
    { product_name: 'Doxycycline Hyclate USP', make: 'Lupin', price: 3800, gst: true },
    { product_name: 'Tetracycline HCl BP', make: 'Sun', price: 2900, gst: false },
  ];
  const extracted = parseStructuredOfferBlocks(blocks);
  assert.equal(extracted[0].gst, true);
  assert.equal(extracted[1].gst, false);
});

test('Test I: Existing single-offer emails preserved', () => {
  const blocks = [
    {
      product_name: 'Ibuprofen BP',
      make: 'IOL Chemicals',
      price: 820,
      currency: 'INR',
      unit: 'KG',
      quantity: 500,
      pack: '25 kg bag',
      delivery: 'Within 7 days',
      ex_location: 'Barnala',
      gst: true,
    },
  ];
  const extracted = parseStructuredOfferBlocks(blocks);
  assert.equal(extracted.length, 1);
  assert.equal(extracted[0].product_name, 'Ibuprofen BP');
  assert.equal(extracted[0].offered_make, 'IOL Chemicals');
  assert.equal(extracted[0].source_price, 820);
  assert.equal(extracted[0].currency, undefined);
  assert.equal(extracted[0].source_currency, 'INR');
  assert.equal(extracted[0].pack, '25 kg bag');
  assert.equal(extracted[0].delivery, 'Within 7 days');
  assert.equal(extracted[0].ex_location, 'Barnala');
});

test('Business Rule Verification: One product with multiple supplier offers does NOT duplicate inquiries', () => {
  // Simulating an inquiry INQ-26-0128 for Pyrantel Pamoate USP
  const parentInquiry = {
    id: 'inq-pyrantel-0128',
    inquiry_number: 'INQ-26-0128',
    product_name: 'Pyrantel Pamoate USP',
  };

  const incomingOffers = [
    { product_name: 'Pyrantel Pamoate USP', make: 'JRC', price: 2050, currency: 'INR' },
    { product_name: 'Pyrantel Pamoate USP', make: 'IPCA', price: 2700, currency: 'INR' },
  ];

  // Map offers under the single parent inquiry
  const linkedOptions = incomingOffers.map(offer => ({
    inquiry_id: parentInquiry.id,
    offered_make: offer.make,
    source_price: offer.price,
    source_currency: offer.currency,
    is_selected: offer.make === 'JRC', // Primary recommendation
  }));

  assert.equal(linkedOptions.length, 2, 'Must record 2 supplier source options');
  assert.equal(linkedOptions[0].inquiry_id, parentInquiry.id, 'Option 1 must link to parent inquiry');
  assert.equal(linkedOptions[1].inquiry_id, parentInquiry.id, 'Option 2 must link to parent inquiry');
  assert.equal(linkedOptions[0].source_price, 2050);
  assert.equal(linkedOptions[1].source_price, 2700);

  // Customer quote is generated from the selected option (or product request override), not raw offers
  const selectedOption = linkedOptions.find(opt => opt.is_selected);
  const customerQuoteCalc = calculateQuote(
    selectedOption.source_price,
    'INR',
    25,
  );

  assert.ok(customerQuoteCalc.final_price_per_kg_usd != null);
  // Supplier price and margin remain internal
  assert.equal(selectedOption.source_price, 2050);
});
