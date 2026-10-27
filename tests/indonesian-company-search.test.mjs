import test from 'node:test';
import assert from 'node:assert/strict';

// Test runner directly imports or mirrors the logic for node:test
const LEGAL_PREFIX_REGEX = /^(?:pt|p\.t|cv|c\.v|ud|u\.d|fa|f\.a|firma|po|p\.o|perum|perseroan terbatas|persero|yayasan|koperasi)\.?\s+/i;
const LEGAL_SUFFIX_REGEX = /\s+(?:tbk|t\.b\.k|ltd|limited|inc|incorporated|corp|corporation|llc|co|c\.o|bhd|pte|pte\.?\s*ltd)\.?$/i;
const INLINE_LEGAL_TOKENS_REGEX = /\b(?:pt|cv|ud|fa|po|tbk|ltd|co)\.?\b/gi;

function normalizeIndonesianCompanyName(name) {
  if (!name) return '';
  return name
    .toLowerCase()
    .replace(LEGAL_PREFIX_REGEX, '')
    .replace(LEGAL_SUFFIX_REGEX, '')
    .replace(INLINE_LEGAL_TOKENS_REGEX, ' ')
    .replace(/[.,/#!$%^&*;:{}=\-_`~()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function matchesIndonesianCompanySearch(candidateName, searchQuery, keywords) {
  if (!searchQuery || !searchQuery.trim()) return true;
  if (!candidateName) return false;

  const rawCandidate = candidateName.toLowerCase().trim();
  const rawQuery = searchQuery.toLowerCase().trim();

  if (rawCandidate.includes(rawQuery)) return true;

  if (keywords && keywords.some(k => k && k.toLowerCase().includes(rawQuery))) {
    return true;
  }

  const normCandidate = normalizeIndonesianCompanyName(candidateName);
  const normQuery = normalizeIndonesianCompanyName(searchQuery);

  if (normCandidate && normQuery && normCandidate.includes(normQuery)) {
    return true;
  }

  const queryTokens = (normQuery || rawQuery).split(/\s+/).filter(Boolean);
  if (queryTokens.length === 0) return false;

  const candidateTokens = normCandidate.split(/\s+/).filter(Boolean);
  const rawCandidateTokens = rawCandidate.split(/\s+/).filter(Boolean);
  const allCandidateTokens = Array.from(new Set([...candidateTokens, ...rawCandidateTokens]));

  const allTokensMatch = queryTokens.every(qTok => {
    return allCandidateTokens.some(cTok => cTok.startsWith(qTok) || cTok.includes(qTok));
  });

  if (allTokensMatch) return true;

  const significantTokens = candidateTokens.length > 0 ? candidateTokens : rawCandidateTokens;
  if (significantTokens.length > 1 && queryTokens.length === 1 && queryTokens[0].length >= 2 && queryTokens[0].length <= 5) {
    const acronym = significantTokens.map(t => t[0]).join('');
    if (acronym.startsWith(queryTokens[0])) {
      return true;
    }
  }

  return false;
}

test('Indonesian Company Search - User Requirements and Edge Cases', async (t) => {
  await t.test('Searching "TR" matches "PT Transliner Maritime Indonesia"', () => {
    const stored = 'PT Transliner Maritime Indonesia';
    assert.equal(matchesIndonesianCompanySearch(stored, 'TR'), true);
    assert.equal(matchesIndonesianCompanySearch(stored, 'tr'), true);
    assert.equal(matchesIndonesianCompanySearch(stored, 'Transliner'), true);
  });

  await t.test('Searching "Anzen" matches "PT Anzen Exports"', () => {
    const stored = 'PT Anzen Exports';
    assert.equal(matchesIndonesianCompanySearch(stored, 'Anzen'), true);
    assert.equal(matchesIndonesianCompanySearch(stored, 'anzen'), true);
    assert.equal(matchesIndonesianCompanySearch(stored, 'PT Anzen'), true);
  });

  await t.test('Searching "Jasa Angkasa" matches "PT JASA ANGKASA SEMESTA TBK"', () => {
    const stored = 'PT JASA ANGKASA SEMESTA TBK';
    assert.equal(matchesIndonesianCompanySearch(stored, 'Jasa Angkasa'), true);
    assert.equal(matchesIndonesianCompanySearch(stored, 'jasa angkasa'), true);
    assert.equal(matchesIndonesianCompanySearch(stored, 'Angkasa'), true);
    assert.equal(matchesIndonesianCompanySearch(stored, 'JAS'), true);
  });

  await t.test('Punctuation variations: "PT." vs "PT" vs "CV."', () => {
    assert.equal(matchesIndonesianCompanySearch('PT. Rania Kalani Indonesia', 'Rania'), true);
    assert.equal(matchesIndonesianCompanySearch('PT Rania Kalani Indonesia', 'PT. Rania'), true);
    assert.equal(matchesIndonesianCompanySearch('CV. Berkah Abadi', 'Berkah'), true);
    assert.equal(matchesIndonesianCompanySearch('UD. Sinar Terang', 'Sinar'), true);
  });

  await t.test('Query with prefix matches candidate stored without prefix', () => {
    assert.equal(matchesIndonesianCompanySearch('Transliner Maritime Indonesia', 'PT Transliner'), true);
    assert.equal(matchesIndonesianCompanySearch('Anzen Exports Indonesia', 'PT. Anzen'), true);
  });

  await t.test('Keyword matching: NPWP or alias matches', () => {
    assert.equal(matchesIndonesianCompanySearch('PT Anzen Exports', '01.234.567', ['01.234.567.8-001.000']), true);
  });

  await t.test('Preserves official names (normalization is for search comparison only)', () => {
    const stored = 'PT Transliner Maritime Indonesia';
    const normalized = normalizeIndonesianCompanyName(stored);
    assert.equal(stored, 'PT Transliner Maritime Indonesia');
    assert.equal(normalized, 'transliner maritime indonesia');
  });
});
