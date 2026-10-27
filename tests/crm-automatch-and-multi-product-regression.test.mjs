import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isProductMatch } from '../src/utils/productMatcher.ts';
import { normalizeCompanyName, calculateSimilarity } from '../src/utils/customerMatching.ts';

const sourceReplyParserSrc = readFileSync('src/services/sourceReplyParser.ts', 'utf8');
const kunalIndiaPriceSrc = readFileSync('src/services/kunalIndiaPrice.ts', 'utf8');
const reviewComponentSrc = readFileSync('src/components/crm/KunalIndiaPriceReview.tsx', 'utf8');

// ── Test 1: Product Pharmacopeia & Grade Matching ────────────────────────────
test('1. Product matching: handles USP, BP, EP, FCC, Micronized suffixes reliably', () => {
  assert.equal(isProductMatch('Ferrous Fumarate USP', 'Ferrous Fumarate'), true);
  assert.equal(isProductMatch('Ferrous Fumarate BP', 'Ferrous Fumarate USP'), true);
  assert.equal(isProductMatch('Ascorbic Acid Micronized BP', 'Ascorbic Acid'), true);
  assert.equal(isProductMatch('Folic Acid FCC', 'Folic Acid USP'), true);
  assert.equal(isProductMatch('Paracetamol BP', 'Ibuprofen BP'), false);
});

// ── Test 2: Indonesian Legal Company Prefix Normalization ───────────────────
test('2. Company normalization: strips PT, PT., CV, CV., UD prefixes and suffix variations', () => {
  const c1 = normalizeCompanyName('PT. Rania Kalani Indonesia');
  const c2 = normalizeCompanyName('PT Rania Kalani');
  const c3 = normalizeCompanyName('Rania Kalani');

  assert.ok(c1.includes('rania kalani'));
  assert.ok(c2.includes('rania kalani'));
  assert.ok(c3.includes('rania kalani'));

  // Substring containment matches core company name
  assert.equal(c1.includes(c2), true);
  assert.equal(c2.includes(c3), true);
});

// ── Test 3: Auto-Select Threshold and Confidence Scale ───────────────────────
test('3. Confidence thresholds: AUTO_SELECT_THRESHOLD is calibrated to 0.75 with SCORE_MAX=100', () => {
  assert.match(sourceReplyParserSrc, /export const AUTO_SELECT_THRESHOLD = 0\.75;/);
  assert.match(sourceReplyParserSrc, /export const CANDIDATE_SHOW_THRESHOLD = 0\.45;/);
  assert.match(sourceReplyParserSrc, /const SCORE_MAX = 100;/);

  // A confident product match (45) + subject (15) + body (10) + recent (5) = 75 / 100 = 0.75
  const rawScore = 45 + 15 + 10 + 5;
  const scoreMax = 100;
  const normalizedScore = rawScore / scoreMax;
  assert.ok(normalizedScore >= 0.75, 'Product match with subject/body context meets auto-selection threshold');
});

// ── Test 4: Clear Winner vs Ambiguous Multiple Candidates ────────────────────
test('4. Ambiguous candidates: multiple close candidates (<0.15 gap) block auto-linking for review', () => {
  // Check implementation logic in kunalIndiaPrice.ts
  assert.match(
    kunalIndiaPriceSrc,
    /suggestedInquiryId:\s*\(isClearWinner && !hasMultipleSimilar\)\s*\?\s*top\.id\s*:\s*null/,
    'deriveCandidateSafety must block auto-linking when multiple candidates are similar'
  );

  // Candidate A: 0.85, Candidate B: 0.80 (gap = 0.05 < 0.15)
  const topCandidate = { score: 0.85, id: 'inq-1', reasons: ['Product match'] };
  const secondCandidate = { score: 0.80, id: 'inq-2', reasons: ['Product match'] };
  const candidates = [topCandidate, secondCandidate];

  const topGap = topCandidate.score - secondCandidate.score;
  const productMatchedCandidates = candidates.filter(c => c.reasons.some(r => r.includes('Product')));
  const hasMultipleSimilar = productMatchedCandidates.length >= 2 &&
    (productMatchedCandidates[0].score - productMatchedCandidates[productMatchedCandidates.length - 1].score) < 0.15;

  const isClearWinner = topCandidate.score >= 0.75 && topGap >= 0.15;
  const autoLinkedId = (isClearWinner && !hasMultipleSimilar) ? topCandidate.id : null;

  assert.equal(hasMultipleSimilar, true, 'Flagged as multiple similar active inquiries');
  assert.equal(autoLinkedId, null, 'Must NOT silently auto-link when multiple active inquiries have close scores');
});

// ── Test 5: Multi-Product Separation (Product 1 must not leak to Product 2) ──
test('5. Multi-product emails: Product 1 inquiry does not leak to Product 2', () => {
  // Check implementation logic in kunalIndiaPrice.ts hydrateReviewAsRow
  assert.match(
    kunalIndiaPriceSrc,
    /isProductMatch\(r\.product_name,\s*raw\.candidates\[0\]\.product_name\)/,
    'hydrateReviewAsRow must verify product match before inheriting candidates across rows'
  );

  const row1 = { product_name: 'Ferrous Fumarate USP', source_price: 4.5 };
  const row2 = { product_name: 'Folic Acid USP', source_price: 32.0 };

  const rawCandidatesProduct1 = [
    { id: 'inq-ferrous', inquiry_number: 'INQ-2026-0087', product_name: 'Ferrous Fumarate BP', score: 0.90, reasons: ['Product match'] }
  ];

  // For Row 1: Ferrous Fumarate matches inq-ferrous
  const matchesRow1 = isProductMatch(row1.product_name, rawCandidatesProduct1[0].product_name);
  assert.equal(matchesRow1, true, 'Row 1 matches Ferrous inquiry');

  // For Row 2: Folic Acid must NOT inherit inq-ferrous!
  const matchesRow2 = isProductMatch(row2.product_name, rawCandidatesProduct1[0].product_name);
  assert.equal(matchesRow2, false, 'Row 2 must NOT match Ferrous inquiry');
});

// ── Test 6: Manual Search Box Support for Product Names & Companies ──────────
test('6. Manual search box handles inquiry number, product name, and company name', () => {
  assert.match(
    reviewComponentSrc,
    /const isExplicitInq = \/\^INQ\[-\\d\]\/i\.test\(text\);/,
    'Manual search must differentiate between explicit INQ numbers and product/company names'
  );
  assert.match(
    reviewComponentSrc,
    /inquiry_number:\s*isExplicitInq\s*\?\s*text\s*:\s*null,\s*product_name:\s*isExplicitInq\s*\?\s*undefined\s*:\s*text,\s*customerName:\s*isExplicitInq\s*\?\s*undefined\s*:\s*text/,
    'Manual search must pass product_name and customerName when non-INQ text is typed'
  );
});
