/**
 * SAPJ ERP Master Data Constants & Helpers
 * Standardized Canonical Vocabularies for Packaging & Countries
 */

export const PACKAGING_TYPES = [
  'Bag',
  'Drum',
  'Tin',
  'Box',
  'Carton',
  'Pallet',
] as const;

export type PackagingType = (typeof PACKAGING_TYPES)[number];

/**
 * Normalizes packaging type strings to canonical values ('Bag', 'Drum', 'Tin', 'Box', 'Carton', 'Pallet')
 */
export function normalizePackagingType(input: string | null | undefined): PackagingType | null {
  if (!input) return null;
  const cleaned = input.trim().toLowerCase();

  if (cleaned.includes('drum') || cleaned.includes('durm')) return 'Drum';
  if (cleaned.includes('bag') || cleaned.includes('sack') || cleaned.includes('woven') || cleaned.includes('kg')) return 'Bag';
  if (cleaned.includes('tin')) return 'Tin';
  if (cleaned.includes('box')) return 'Box';
  if (cleaned.includes('carton') || cleaned.includes('ctn')) return 'Carton';
  if (cleaned.includes('pallet') || cleaned.includes('plt')) return 'Pallet';

  const exact = PACKAGING_TYPES.find(p => p.toLowerCase() === cleaned);
  return exact || null;
}

export interface CountryEntry {
  name: string;
  code: string;    // ISO 3166-1 alpha-2
  code3: string;   // ISO 3166-1 alpha-3
  aliases?: string[];
}

/**
 * Canonical ISO Country Master Dataset
 */
export const COUNTRIES: readonly CountryEntry[] = [
  { name: 'China', code: 'CN', code3: 'CHN', aliases: ['PRC', 'P.R. China', "People's Republic of China", 'CH'] },
  { name: 'India', code: 'IN', code3: 'IND', aliases: ['Bharat'] },
  { name: 'Indonesia', code: 'ID', code3: 'IDN' },
  { name: 'United States', code: 'US', code3: 'USA', aliases: ['USA', 'U.S.', 'U.S.A.', 'America'] },
  { name: 'Japan', code: 'JP', code3: 'JPN' },
  { name: 'Germany', code: 'DE', code3: 'DEU', aliases: ['Deutschland'] },
  { name: 'Singapore', code: 'SG', code3: 'SGP' },
  { name: 'United Kingdom', code: 'GB', code3: 'GBR', aliases: ['UK', 'U.K.', 'Britain', 'England'] },
  { name: 'South Korea', code: 'KR', code3: 'KOR', aliases: ['Korea', 'Republic of Korea'] },
  { name: 'Switzerland', code: 'CH', code3: 'CHE', aliases: ['Swiss', 'Schweiz'] },
  { name: 'Malaysia', code: 'MY', code3: 'MYS' },
  { name: 'Thailand', code: 'TH', code3: 'THA' },
  { name: 'Vietnam', code: 'VN', code3: 'VNM' },
  { name: 'Italy', code: 'IT', code3: 'ITA', aliases: ['Italia'] },
  { name: 'France', code: 'FR', code3: 'FRA' },
  { name: 'Spain', code: 'ES', code3: 'ESP', aliases: ['España'] },
  { name: 'Netherlands', code: 'NL', code3: 'NLD', aliases: ['Holland'] },
  { name: 'Belgium', code: 'BE', code3: 'BEL' },
  { name: 'Brazil', code: 'BR', code3: 'BRA', aliases: ['Brasil'] },
  { name: 'Canada', code: 'CA', code3: 'CAN' },
  { name: 'Australia', code: 'AU', code3: 'AUS' },
  { name: 'Mexico', code: 'MX', code3: 'MEX' },
  { name: 'Taiwan', code: 'TW', code3: 'TWN', aliases: ['ROC'] },
  { name: 'Turkey', code: 'TR', code3: 'TUR', aliases: ['Türkiye'] },
  { name: 'United Arab Emirates', code: 'AE', code3: 'ARE', aliases: ['UAE'] },
  { name: 'Saudi Arabia', code: 'SA', code3: 'SAU', aliases: ['KSA'] },
  { name: 'South Africa', code: 'ZA', code3: 'ZAF' },
  { name: 'Egypt', code: 'EG', code3: 'EGY' },
  { name: 'Russia', code: 'RU', code3: 'RUS', aliases: ['Russian Federation'] },
  { name: 'Poland', code: 'PL', code3: 'POL' },
  { name: 'Sweden', code: 'SE', code3: 'SWE' },
  { name: 'Norway', code: 'NO', code3: 'NOR' },
  { name: 'Denmark', code: 'DK', code3: 'DNK' },
  { name: 'Ireland', code: 'IE', code3: 'IRL' },
  { name: 'Austria', code: 'AT', code3: 'AUT' },
  { name: 'Hungary', code: 'HU', code3: 'HUN' },
  { name: 'Czech Republic', code: 'CZ', code3: 'CZE', aliases: ['Czechia'] },
  { name: 'Israel', code: 'IL', code3: 'ISR' },
  { name: 'Pakistan', code: 'PK', code3: 'PAK' },
  { name: 'Bangladesh', code: 'BD', code3: 'BGD' },
  { name: 'Philippines', code: 'PH', code3: 'PHL' },
  { name: 'New Zealand', code: 'NZ', code3: 'NZL' },
  { name: 'Argentina', code: 'AR', code3: 'ARG' },
  { name: 'Chile', code: 'CL', code3: 'CHL' },
  { name: 'Colombia', code: 'CO', code3: 'COL' },
  { name: 'Hong Kong', code: 'HK', code3: 'HKG' },
  { name: 'Finland', code: 'FI', code3: 'FIN' },
  { name: 'Portugal', code: 'PT', code3: 'PRT' },
  { name: 'Greece', code: 'GR', code3: 'GRC' },
  { name: 'Romania', code: 'RO', code3: 'ROU' },
  { name: 'Ukraine', code: 'UA', code3: 'UKR' },
  { name: 'Jordan', code: 'JO', code3: 'JOR' },
  { name: 'Iran', code: 'IR', code3: 'IRN' },
  { name: 'Sri Lanka', code: 'LK', code3: 'LKA' },
  { name: 'Myanmar', code: 'MM', code3: 'MMR', aliases: ['Burma'] },
  { name: 'Cambodia', code: 'KH', code3: 'KHM' },
  { name: 'Kuwait', code: 'KW', code3: 'KWT' },
  { name: 'Qatar', code: 'QA', code3: 'QAT' },
  { name: 'Oman', code: 'OM', code3: 'OMN' },
] as const;

/**
 * Normalizes country strings or codes to canonical English country names.
 * Returns null if input is ambiguous or unrecognized.
 */
export function normalizeCountry(input: string | null | undefined): string | null {
  if (!input) return null;
  const cleaned = input.trim();
  const lower = cleaned.toLowerCase();

  // Direct match on canonical name
  const exactMatch = COUNTRIES.find(c => c.name.toLowerCase() === lower);
  if (exactMatch) return exactMatch.name;

  // Match on alpha-2 or alpha-3 code
  const codeMatch = COUNTRIES.find(c => c.code.toLowerCase() === lower || c.code3.toLowerCase() === lower);
  if (codeMatch) return codeMatch.name;

  // Match on aliases
  const aliasMatch = COUNTRIES.find(c => c.aliases?.some(a => a.toLowerCase() === lower));
  if (aliasMatch) return aliasMatch.name;

  // Substring match on name (e.g. "China (CN)" -> "China")
  const prefixMatch = COUNTRIES.find(c => lower.startsWith(c.name.toLowerCase()) || lower.startsWith(c.code.toLowerCase()));
  if (prefixMatch) return prefixMatch.name;

  return null;
}

/**
 * Formats a packaging display string for Product view:
 * e.g. "Bag · 25 KG/pack" or "25 KG Bag" or "Bag"
 */
export function formatProductPackaging(
  packagingType: string | null | undefined,
  packSize: number | string | null | undefined,
  unit: string = 'KG'
): string {
  const normType = normalizePackagingType(packagingType) || packagingType || '';
  const numSize = typeof packSize === 'string' ? parseFloat(packSize) : packSize;
  const unitUpper = (unit || 'KG').toUpperCase();

  if (normType && numSize && !isNaN(numSize) && numSize > 0) {
    return `${normType} · ${numSize} ${unitUpper}/pack`;
  }
  if (normType) {
    return normType;
  }
  if (numSize && !isNaN(numSize) && numSize > 0) {
    return `${numSize} ${unitUpper}/pack`;
  }
  return '—';
}
