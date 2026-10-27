/**
 * Utility for searching and matching Indonesian company / party / supplier names.
 *
 * In Indonesia, business entities often have formal legal prefixes (PT, CV, UD, Fa, etc.)
 * or legal suffixes (Tbk, Ltd, etc.), but users search colloquially without them (e.g.
 * searching "Transliner" or "TR" to find "PT Transliner Maritime Indonesia",
 * "Anzen" to find "PT Anzen Exports", "Jasa Angkasa" to find "PT JASA ANGKASA SEMESTA TBK").
 *
 * This utility preserves the official legal names in database records and UI displays,
 * while allowing frictionless search matching across:
 *   - Raw text substring
 *   - Legal entity prefix/suffix stripped text
 *   - Word-boundary and word-start tokens (e.g. "TR" -> "Transliner")
 *   - Punctuation variations ("PT." vs "PT", "CV." vs "CV")
 */

const LEGAL_PREFIX_REGEX = /^(?:pt|p\.t|cv|c\.v|ud|u\.d|fa|f\.a|firma|po|p\.o|perum|perseroan terbatas|persero|yayasan|koperasi)\.?\s+/i;
const LEGAL_SUFFIX_REGEX = /\s+(?:tbk|t\.b\.k|ltd|limited|inc|incorporated|corp|corporation|llc|co|c\.o|bhd|pte|pte\.?\s*ltd)\.?$/i;
const INLINE_LEGAL_TOKENS_REGEX = /\b(?:pt|cv|ud|fa|po|tbk|ltd|co)\.?\b/gi;

/**
 * Normalizes an Indonesian company name by stripping legal prefixes/suffixes,
 * punctuation, and excessive whitespace for comparison.
 */
export function normalizeIndonesianCompanyName(name: string | null | undefined): string {
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

/**
 * Checks whether an option or party name matches the user's search query,
 * using Indonesian entity normalization and multi-token matching.
 */
export function matchesIndonesianCompanySearch(
  candidateName: string | null | undefined,
  searchQuery: string | null | undefined,
  keywords?: string[]
): boolean {
  if (!searchQuery || !searchQuery.trim()) return true;
  if (!candidateName) return false;

  const rawCandidate = candidateName.toLowerCase().trim();
  const rawQuery = searchQuery.toLowerCase().trim();

  // 1. Direct raw substring match
  if (rawCandidate.includes(rawQuery)) return true;

  // 2. Extra keywords match (e.g. NPWP, code, alias)
  if (keywords && keywords.some(k => k && k.toLowerCase().includes(rawQuery))) {
    return true;
  }

  // 3. Normalized string matching (strips PT., CV., TBK., punctuation)
  const normCandidate = normalizeIndonesianCompanyName(candidateName);
  const normQuery = normalizeIndonesianCompanyName(searchQuery);

  if (normCandidate && normQuery && normCandidate.includes(normQuery)) {
    return true;
  }

  // 4. Token-level matching: each search token must match either a full word,
  // the start of a word, or a substring in the candidate
  const queryTokens = (normQuery || rawQuery).split(/\s+/).filter(Boolean);
  if (queryTokens.length === 0) return false;

  const candidateTokens = normCandidate.split(/\s+/).filter(Boolean);
  const rawCandidateTokens = rawCandidate.split(/\s+/).filter(Boolean);

  const allCandidateTokens = Array.from(new Set([...candidateTokens, ...rawCandidateTokens]));

  // Every token in query must match at least one candidate token
  const allTokensMatch = queryTokens.every(qTok => {
    // Exact or prefix match on any word (e.g., "tr" matches start of "transliner")
    return allCandidateTokens.some(cTok => cTok.startsWith(qTok) || cTok.includes(qTok));
  });

  if (allTokensMatch) return true;

  // 5. Acronym / Initials match (e.g. "TR" matching "Transliner Maritime" or "JAS" matching "Jasa Angkasa Semesta")
  const significantTokens = candidateTokens.length > 0 ? candidateTokens : rawCandidateTokens;
  if (significantTokens.length > 1 && queryTokens.length === 1 && queryTokens[0].length >= 2 && queryTokens[0].length <= 5) {
    const acronym = significantTokens.map(t => t[0]).join('');
    if (acronym.startsWith(queryTokens[0])) {
      return true;
    }
  }

  return false;
}
