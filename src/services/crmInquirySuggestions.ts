import type { SupabaseClient } from '@supabase/supabase-js';

interface CacheEntry {
  timestamp: number;
  results: string[];
}

const CACHE_TTL_MS = 60_000; // 1 minute in-memory cache

const productCache = new Map<string, CacheEntry>();
const specCache = new Map<string, CacheEntry>();
let countryCache: { timestamp: number; countries: string[] } | null = null;

// Track values added during this session for instant typeahead feedback
const sessionRecentProducts = new Set<string>();
const sessionRecentSpecs = new Set<string>();
const sessionRecentCountries = new Set<string>();

let _client: SupabaseClient | null = null;

async function getClient(): Promise<SupabaseClient | null> {
  if (_client) return _client;
  try {
    const mod = await import('../lib/supabase.ts');
    _client = mod.supabase as unknown as SupabaseClient;
  } catch {
    _client = null;
  }
  return _client;
}

export function setTestSupabaseClient(client: SupabaseClient | null): void {
  _client = client;
}

/** Escape characters in string for PostgREST pattern matching */
function escapePostgrest(str: string): string {
  return str.replace(/[%_\\]/g, '\\$&');
}

/**
 * Standardize string casing while preserving clean original capitalization.
 */
function canonicalizeCasing(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  return trimmed;
}

/**
 * Core ranking function for product & specification suggestions:
 * 1. Prefix matches first
 * 2. Substring matches second
 * 3. Most frequently used / recently used preferred
 * 4. Deduplication (case-insensitive key, canonical casing displayed)
 */
export function rankSuggestions(
  items: (string | null | undefined)[],
  query: string,
  limit = 25
): string[] {
  const trimmedQ = query.trim().toLowerCase();
  if (!trimmedQ) return [];

  const counts = new Map<string, number>();
  const displayNames = new Map<string, string>();

  for (const raw of items) {
    if (!raw) continue;
    const cleaned = canonicalizeCasing(raw);
    if (!cleaned) continue;
    const lower = cleaned.toLowerCase();
    counts.set(lower, (counts.get(lower) || 0) + 1);
    if (!displayNames.has(lower)) {
      displayNames.set(lower, cleaned);
    }
  }

  const prefixMatches: { name: string; count: number }[] = [];
  const substringMatches: { name: string; count: number }[] = [];

  for (const [lower, count] of counts.entries()) {
    const name = displayNames.get(lower)!;
    if (lower.startsWith(trimmedQ)) {
      prefixMatches.push({ name, count });
    } else if (lower.includes(trimmedQ)) {
      substringMatches.push({ name, count });
    }
  }

  // Sort: highest count first; if equal count, alphabetical
  prefixMatches.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  substringMatches.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  const result: string[] = [
    ...prefixMatches.map(m => m.name),
    ...substringMatches.map(m => m.name),
  ];

  return result.slice(0, limit);
}

/**
 * Country of origin ranking:
 * India and China are our two major sourcing countries.
 * ALWAYS make these two prominently available even if there is no current text match.
 * Sort:
 * 1. Matching major countries (India when typing I, China when typing C, or both if empty)
 * 2. Matching historical countries (prefix first, then substring)
 * 3. Non-matching major countries (so India and China are always present)
 * 4. Deduplicated
 */
export function rankCountrySuggestions(
  historicalCountries: (string | null | undefined)[],
  query = '',
  limit = 25
): string[] {
  const trimmedQ = query.trim().toLowerCase();
  const majorCountries = ['India', 'China'];

  // Collect distinct historical countries
  const counts = new Map<string, number>();
  const displayNames = new Map<string, string>();

  // Seed with major countries
  for (const m of majorCountries) {
    counts.set(m.toLowerCase(), 1000);
    displayNames.set(m.toLowerCase(), m);
  }

  // Add historical countries
  for (const raw of historicalCountries) {
    if (!raw) continue;
    const cleaned = canonicalizeCasing(raw);
    if (!cleaned) continue;
    const lower = cleaned.toLowerCase();
    counts.set(lower, (counts.get(lower) || 0) + 1);
    if (!displayNames.has(lower)) {
      displayNames.set(lower, cleaned);
    }
  }

  if (!trimmedQ) {
    // If no query, return India, China first, then other historical countries
    const others: { name: string; count: number }[] = [];
    for (const [lower, count] of counts.entries()) {
      if (lower !== 'india' && lower !== 'china') {
        others.push({ name: displayNames.get(lower)!, count });
      }
    }
    others.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    return ['India', 'China', ...others.map(o => o.name)].slice(0, limit);
  }

  // With a query:
  const matchingMajor: string[] = [];
  const otherMajor: string[] = [];
  const matchingHistoricalPrefix: { name: string; count: number }[] = [];
  const matchingHistoricalSub: { name: string; count: number }[] = [];

  for (const m of majorCountries) {
    const lower = m.toLowerCase();
    if (lower.startsWith(trimmedQ) || lower.includes(trimmedQ)) {
      matchingMajor.push(m);
    } else {
      otherMajor.push(m);
    }
  }

  for (const [lower, count] of counts.entries()) {
    if (lower === 'india' || lower === 'china') continue;
    const name = displayNames.get(lower)!;
    if (lower.startsWith(trimmedQ)) {
      matchingHistoricalPrefix.push({ name, count });
    } else if (lower.includes(trimmedQ)) {
      matchingHistoricalSub.push({ name, count });
    }
  }

  matchingHistoricalPrefix.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  matchingHistoricalSub.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  const result: string[] = [
    ...matchingMajor,
    ...matchingHistoricalPrefix.map(m => m.name),
    ...matchingHistoricalSub.map(m => m.name),
    ...otherMajor, // prominently available even if no current text match
  ];

  // Deduplicate preserving order
  const seen = new Set<string>();
  const deduplicated: string[] = [];
  for (const item of result) {
    const key = item.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      deduplicated.push(item);
    }
  }

  return deduplicated.slice(0, limit);
}

/**
 * Searches historical crm_inquiries.product_name.
 * Returns distinct ranked suggestions.
 */
export async function searchHistoricalProducts(query: string, limit = 25): Promise<string[]> {
  const trimmed = query.trim();
  if (trimmed.length < 1) return [];

  const cacheKey = trimmed.toLowerCase();
  const cached = productCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.results;
  }

  const escaped = escapePostgrest(trimmed);
  const items: string[] = [...sessionRecentProducts];

  try {
    const client = await getClient();
    if (client) {
      const [prefixRes, substringRes] = await Promise.all([
        client
          .from('crm_inquiries')
          .select('product_name')
          .not('product_name', 'is', null)
          .ilike('product_name', `${escaped}%`)
          .order('created_at', { ascending: false })
          .limit(30),
        client
          .from('crm_inquiries')
          .select('product_name')
          .not('product_name', 'is', null)
          .ilike('product_name', `%${escaped}%`)
          .order('created_at', { ascending: false })
          .limit(30),
      ]);

      if (prefixRes.data) {
        for (const row of prefixRes.data) {
          if (row.product_name) items.push(row.product_name);
        }
      }
      if (substringRes.data) {
        for (const row of substringRes.data) {
          if (row.product_name) items.push(row.product_name);
        }
      }
    }
  } catch (err) {
    console.warn('Error fetching historical product suggestions:', err);
  }

  const ranked = rankSuggestions(items, trimmed, limit);
  productCache.set(cacheKey, { timestamp: Date.now(), results: ranked });
  return ranked;
}

/**
 * Searches historical crm_inquiries.specification.
 * Returns distinct ranked suggestions.
 */
export async function searchHistoricalSpecifications(query: string, limit = 20): Promise<string[]> {
  const trimmed = query.trim();
  if (trimmed.length < 1) return [];

  const cacheKey = trimmed.toLowerCase();
  const cached = specCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.results;
  }

  const escaped = escapePostgrest(trimmed);
  const items: string[] = [...sessionRecentSpecs];

  try {
    const client = await getClient();
    if (client) {
      const [prefixRes, substringRes] = await Promise.all([
        client
          .from('crm_inquiries')
          .select('specification')
          .not('specification', 'is', null)
          .ilike('specification', `${escaped}%`)
          .order('created_at', { ascending: false })
          .limit(30),
        client
          .from('crm_inquiries')
          .select('specification')
          .not('specification', 'is', null)
          .ilike('specification', `%${escaped}%`)
          .order('created_at', { ascending: false })
          .limit(30),
      ]);

      if (prefixRes.data) {
        for (const row of prefixRes.data) {
          if (row.specification) items.push(row.specification);
        }
      }
      if (substringRes.data) {
        for (const row of substringRes.data) {
          if (row.specification) items.push(row.specification);
        }
      }
    }
  } catch (err) {
    console.warn('Error fetching historical specification suggestions:', err);
  }

  const ranked = rankSuggestions(items, trimmed, limit);
  specCache.set(cacheKey, { timestamp: Date.now(), results: ranked });
  return ranked;
}

/**
 * Loads distinct countries from historical crm_inquiries.supplier_country.
 * Prioritizes India and China.
 */
export async function getHistoricalCountrySuggestions(query = '', limit = 25): Promise<string[]> {
  const trimmed = query.trim();

  let countryList: string[] = [];
  if (countryCache && Date.now() - countryCache.timestamp < CACHE_TTL_MS) {
    countryList = countryCache.countries;
  } else {
    try {
      const client = await getClient();
      if (client) {
        const { data } = await client
          .from('crm_inquiries')
          .select('supplier_country')
          .not('supplier_country', 'is', null)
          .order('created_at', { ascending: false })
          .limit(150);

        const fetched: string[] = [];
        if (data) {
          for (const row of data) {
            if (row.supplier_country) fetched.push(row.supplier_country);
          }
        }
        countryCache = {
          timestamp: Date.now(),
          countries: fetched,
        };
        countryList = fetched;
      }
    } catch (err) {
      console.warn('Error fetching historical country suggestions:', err);
    }
  }

  const allItems = [...sessionRecentCountries, ...countryList];
  return rankCountrySuggestions(allItems, trimmed, limit);
}

/**
 * Invalidates suggestion caches when an inquiry is saved or updated.
 */
export function invalidateInquirySuggestionsCache(): void {
  productCache.clear();
  specCache.clear();
  countryCache = null;
}

/**
 * Registers newly saved values immediately into the session cache.
 */
export function registerRecentInquiryValues(values: {
  product_name?: string | null;
  specification?: string | null;
  supplier_country?: string | null;
}): void {
  if (values.product_name) sessionRecentProducts.add(values.product_name.trim());
  if (values.specification) sessionRecentSpecs.add(values.specification.trim());
  if (values.supplier_country) sessionRecentCountries.add(values.supplier_country.trim());
  invalidateInquirySuggestionsCache();
}
