import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  rankSuggestions,
  rankCountrySuggestions,
  invalidateInquirySuggestionsCache,
  registerRecentInquiryValues,
} from '../src/services/crmInquirySuggestions.ts';

test('1. Product Name Autocomplete Ranking & Prefix Priority', () => {
  const historicalProducts = [
    'Fenbendazole',
    'Fluconazole',
    'Folic Acid',
    'Paracetamol',
    'Paracetamol 250mg',
    'Caffeine', // contains 'f', but not prefix
    'paracetamol', // duplicate in different casing
  ];

  // Test typing "F"
  const fResults = rankSuggestions(historicalProducts, 'F');
  assert.ok(fResults.length > 0, 'Should return results for F');
  // Prefix matches must come before substring matches
  assert.ok(fResults.indexOf('Fenbendazole') < fResults.indexOf('Caffeine'), 'Prefix Fenbendazole before Caffeine');
  assert.ok(fResults.includes('Fluconazole'), 'Includes Fluconazole');
  assert.ok(fResults.includes('Folic Acid'), 'Includes Folic Acid');

  // Test typing "Fen"
  const fenResults = rankSuggestions(historicalProducts, 'Fen');
  assert.deepEqual(fenResults, ['Fenbendazole']);

  // Test typing "Par"
  const parResults = rankSuggestions(historicalProducts, 'Par');
  assert.ok(parResults.includes('Paracetamol'), 'Includes Paracetamol');
  assert.ok(parResults.includes('Paracetamol 250mg'), 'Includes Paracetamol 250mg');
  // Deduplication check: only one 'Paracetamol' should appear
  const paracetamolCount = parResults.filter(p => p.toLowerCase() === 'paracetamol').length;
  assert.equal(paracetamolCount, 1, 'Paracetamol must be deduplicated');

  // Test empty query returns empty array
  assert.deepEqual(rankSuggestions(historicalProducts, ''), []);
  assert.deepEqual(rankSuggestions(historicalProducts, '   '), []);
});

test('2. Specification Autocomplete Ranking & Deduplication', () => {
  const historicalSpecs = [
    'USP',
    'USP/BP',
    'USP Grade',
    'EP',
    'EP/BP',
    'IP',
    'usp', // duplicate casing
  ];

  // Test typing "U"
  const uResults = rankSuggestions(historicalSpecs, 'U');
  assert.ok(uResults.length >= 3, 'Returns U specifications');
  assert.ok(uResults.includes('USP'));
  assert.ok(uResults.includes('USP/BP'));
  assert.ok(uResults.includes('USP Grade'));
  assert.equal(uResults.filter(s => s.toLowerCase() === 'usp').length, 1, 'USP is deduplicated');

  // Test typing "EP"
  const epResults = rankSuggestions(historicalSpecs, 'EP');
  assert.ok(epResults.includes('EP'));
  assert.ok(epResults.includes('EP/BP'));
  assert.ok(!epResults.includes('USP'));
});

test('3. Country of Origin Suggestions & India/China Prominence', () => {
  const historicalCountries = [
    'Germany',
    'Taiwan',
    'Korea',
    'Indonesia',
    'China',
    'India',
  ];

  // Initial / empty text: India and China must be first
  const initial = rankCountrySuggestions(historicalCountries, '');
  assert.equal(initial[0], 'India', 'India must be #1 when no query');
  assert.equal(initial[1], 'China', 'China must be #2 when no query');
  assert.ok(initial.includes('Germany'), 'Includes historical Germany');
  assert.ok(initial.includes('Taiwan'), 'Includes historical Taiwan');

  // Typing "I": India must immediately be first
  const iResults = rankCountrySuggestions(historicalCountries, 'I');
  assert.equal(iResults[0], 'India', 'Typing I immediately shows India first');
  assert.ok(iResults.includes('Indonesia'), 'Also includes prefix match Indonesia');
  assert.ok(iResults.includes('China'), 'China remains prominently available');

  // Typing "C": China must immediately be first
  const cResults = rankCountrySuggestions(historicalCountries, 'C');
  assert.equal(cResults[0], 'China', 'Typing C immediately shows China first');
  assert.ok(cResults.includes('India'), 'India remains prominently available');

  // Typing "Ger": Germany first, with India & China prominently included
  const gResults = rankCountrySuggestions(historicalCountries, 'Ger');
  assert.equal(gResults[0], 'Germany', 'Matching country Germany is first');
  assert.ok(gResults.includes('India'), 'India is prominently available');
  assert.ok(gResults.includes('China'), 'China is prominently available');

  // Deduplication test
  const dupeCountries = ['india', 'India', 'INDIA', 'China', 'china'];
  const dupeResults = rankCountrySuggestions(dupeCountries, '');
  assert.equal(dupeResults.filter(c => c.toLowerCase() === 'india').length, 1);
  assert.equal(dupeResults.filter(c => c.toLowerCase() === 'china').length, 1);
});

test('4. Dynamic Growth & Cache Invalidation when New Inquiry is Added', () => {
  invalidateInquirySuggestionsCache();

  // Register a new inquiry with previously unseen values
  registerRecentInquiryValues({
    product_name: 'Amoxicillin Trihydrate',
    specification: 'USP43',
    supplier_country: 'Vietnam',
  });

  // Check product suggestion now includes Amoxicillin
  const prodResults = rankSuggestions(['Amoxicillin Trihydrate'], 'Amox');
  assert.ok(prodResults.includes('Amoxicillin Trihydrate'), 'New product is immediately suggested');

  // Check specification suggestion now includes USP43
  const specResults = rankSuggestions(['USP43'], 'USP4');
  assert.ok(specResults.includes('USP43'), 'New spec is immediately suggested');

  // Check country suggestion now includes Vietnam on typing V
  const countryResults = rankCountrySuggestions(['Vietnam'], 'V');
  assert.equal(countryResults[0], 'Vietnam', 'Typing V suggests Vietnam');
  assert.ok(countryResults.includes('India'), 'Major countries still present');
  assert.ok(countryResults.includes('China'), 'Major countries still present');
});

test('5. Architectural Invariants — No Master Tables & Freeform Compatibility', () => {
  const searchableSelectCode = fs.readFileSync('src/components/SearchableSelect.tsx', 'utf8');
  const compactFormCode = fs.readFileSync('src/components/crm/CompactInquiryForm.tsx', 'utf8');
  const crmPageCode = fs.readFileSync('src/pages/CRM.tsx', 'utf8');

  // 1. SearchableSelect supports freeSolo mode
  assert.ok(searchableSelectCode.includes('freeSolo'), 'SearchableSelect supports freeSolo prop');
  assert.ok(searchableSelectCode.includes('handleInputKeyDown'), 'Supports keyboard navigation on input');
  assert.ok(searchableSelectCode.includes('ArrowDown'), 'Supports ArrowDown navigation');
  assert.ok(searchableSelectCode.includes('ArrowUp'), 'Supports ArrowUp navigation');
  assert.ok(searchableSelectCode.includes('Enter'), 'Supports Enter selection');
  assert.ok(searchableSelectCode.includes('Escape'), 'Supports Escape closing');

  // 2. CompactInquiryForm uses SearchableSelect with freeSolo for Product, Spec, and Country
  assert.ok(compactFormCode.includes('id="inquiry_product_name"'), 'Product Name uses SearchableSelect');
  assert.ok(compactFormCode.includes('id="inquiry_specification"'), 'Specification uses SearchableSelect');
  assert.ok(compactFormCode.includes('id="inquiry_country_of_origin"'), 'Country of Origin uses SearchableSelect');
  assert.ok(compactFormCode.includes('debouncedProductQuery'), 'Product has debounced searching');
  assert.ok(compactFormCode.includes('debouncedSpecQuery'), 'Spec has debounced searching');
  assert.ok(compactFormCode.includes('debouncedCountryQuery'), 'Country has debounced searching');

  // 3. Confirm NO master tables were added to migrations
  const migrationFiles = fs.readdirSync('supabase/migrations');
  for (const file of migrationFiles) {
    if (file.endsWith('.sql')) {
      const sql = fs.readFileSync(`supabase/migrations/${file}`, 'utf8');
      assert.ok(!sql.includes('CREATE TABLE "public"."product_master"'), 'No product_master table');
      assert.ok(!sql.includes('CREATE TABLE "public"."specification_master"'), 'No specification_master table');
      assert.ok(!sql.includes('CREATE TABLE "public"."country_master"'), 'No country_master table');
    }
  }

  // 4. CRM.tsx registers recently saved values on form submission
  assert.ok(crmPageCode.includes('registerRecentInquiryValues'), 'CRM page registers saved inquiry values');
});
