// src/services/crm/canonicalPhoneService.ts
//
// Canonical Shared International Telephone Number Parsing & Classification Service for Anzen ERP.
// Driven strictly by libphonenumber-js metadata.
// Enforces complete separation between:
//   1. Phone Country (derived strictly from parsed telephone digits)
//   2. Company City / Region (derived strictly from CRM company address)
//   3. Phone Type (mobile, fixed_line, service_special, invalid, missing, needs_review)
// Strictly prevents:
//   - Misclassifying Indonesian +62 as US +1
//   - Misclassifying Indonesian fixed lines (021/022) as foreign or international mobiles
//   - Converting malformed +021 numbers into foreign countries
//   - Mixing city names into country metadata or country filters

import { parsePhoneNumberFromString, PhoneNumber } from 'libphonenumber-js/max';

export type CanonicalPhoneType =
  | 'mobile'
  | 'fixed_line'
  | 'fixed_line_or_mobile'
  | 'service_special'
  | 'unknown'
  | 'invalid'
  | 'missing'
  | 'needs_review';

export interface CanonicalPhoneClassification {
  rawPhone: string;
  isValid: boolean;
  isPossible: boolean;
  e164: string | null;
  countryCode: string | null; // e.g. 'ID', 'IN', 'GB', 'KR', 'US'
  callingCode: string | null; // e.g. '+62', '+91', '+44', '+82', '+1'
  phoneCountryName: string;   // e.g. 'Indonesia', 'India', 'United Kingdom', 'South Korea'
  phoneCountryFlag: string;   // e.g. '🇮🇩', '🇮🇳', '🇬🇧', '🇰🇷'
  nationalNumber: string | null;
  phoneType: CanonicalPhoneType;
  validationReason: string;
  needsManualReview: boolean;
  isWhatsAppEligibleCandidate: boolean; // Strictly true ONLY if valid AND mobile
  companyCity: string | null; // Derived from CRM address, never mixed with country
}

export const ISO_COUNTRY_NAMES: Record<string, { name: string; flag: string }> = {
  ID: { name: 'Indonesia', flag: '🇮🇩' },
  IN: { name: 'India', flag: '🇮🇳' },
  GB: { name: 'United Kingdom', flag: '🇬🇧' },
  KR: { name: 'South Korea', flag: '🇰🇷' },
  US: { name: 'United States', flag: '🇺🇸' },
  CA: { name: 'Canada', flag: '🇨🇦' },
  SG: { name: 'Singapore', flag: '🇸🇬' },
  MY: { name: 'Malaysia', flag: '🇲🇾' },
  CN: { name: 'China', flag: '🇨🇳' },
  JP: { name: 'Japan', flag: '🇯🇵' },
  DE: { name: 'Germany', flag: '🇩🇪' },
  AU: { name: 'Australia', flag: '🇦🇺' },
  FR: { name: 'France', flag: '🇫🇷' },
  IT: { name: 'Italy', flag: '🇮🇹' },
  CH: { name: 'Switzerland', flag: '🇨🇭' },
  NL: { name: 'Netherlands', flag: '🇳🇱' },
  TH: { name: 'Thailand', flag: '🇹🇭' },
  VN: { name: 'Vietnam', flag: '🇻🇳' },
  PH: { name: 'Philippines', flag: '🇵🇭' },
  AE: { name: 'United Arab Emirates', flag: '🇦🇪' },
  HK: { name: 'Hong Kong', flag: '🇭🇰' },
  TW: { name: 'Taiwan', flag: '🇹🇼' },
  BR: { name: 'Brazil', flag: '🇧🇷' },
  RU: { name: 'Russia', flag: '🇷🇺' },
  ZA: { name: 'South Africa', flag: '🇿🇦' },
  ES: { name: 'Spain', flag: '🇪🇸' },
  NZ: { name: 'New Zealand', flag: '🇳🇿' },
};

/**
 * Returns canonical country metadata from an ISO 3166-1 alpha-2 code.
 */
export function getCountryMetadata(countryCode?: string | null): { name: string; flag: string } {
  if (!countryCode) return { name: 'Unknown / Undetermined', flag: '🌐' };
  const upper = countryCode.toUpperCase();
  if (ISO_COUNTRY_NAMES[upper]) return ISO_COUNTRY_NAMES[upper];
  return { name: upper, flag: '🌐' };
}

export interface ClassifyPhoneOptions {
  trustedRegion?: string | null;
  companyCity?: string | null;
}

/**
 * Authoritative canonical phone classification function.
 * Single source of truth used across all CRM, campaign, and inbox modules.
 */
export function classifyCanonicalPhone(
  rawPhone?: string | null,
  options?: ClassifyPhoneOptions
): CanonicalPhoneClassification {
  const companyCity = options?.companyCity?.trim() || null;

  // 1. Missing / Empty number
  if (!rawPhone || !rawPhone.trim()) {
    return {
      rawPhone: rawPhone || '',
      isValid: false,
      isPossible: false,
      e164: null,
      countryCode: null,
      callingCode: null,
      phoneCountryName: 'Missing',
      phoneCountryFlag: '—',
      nationalNumber: null,
      phoneType: 'missing',
      validationReason: 'No phone number provided',
      needsManualReview: false,
      isWhatsAppEligibleCandidate: false,
      companyCity,
    };
  }

  const trimmed = rawPhone.trim();
  const digitsOnly = trimmed.replace(/[^\d+]/g, '');

  // 2. Malformed international prefix starting with +0 (e.g. +021...)
  // In ITU-T E.164, country calling codes never begin with 0.
  // Numbers like +021 are malformed local numbers entered with an erroneous plus.
  // Must NOT be silently mapped to foreign countries (+44 UK, +1 US, etc.).
  if (digitsOnly.startsWith('+0')) {
    return {
      rawPhone,
      isValid: false,
      isPossible: false,
      e164: null,
      countryCode: null,
      callingCode: null,
      phoneCountryName: 'Needs Review',
      phoneCountryFlag: '⚠️',
      nationalNumber: digitsOnly.slice(2),
      phoneType: 'invalid',
      validationReason: 'Malformed international prefix (+0 is invalid; manual operator verification required)',
      needsManualReview: true,
      isWhatsAppEligibleCandidate: false,
      companyCity,
    };
  }

  // Check if string contains any digits at all
  const rawDigits = trimmed.replace(/\D/g, '');
  if (rawDigits.length === 0) {
    return {
      rawPhone,
      isValid: false,
      isPossible: false,
      e164: null,
      countryCode: null,
      callingCode: null,
      phoneCountryName: 'Invalid',
      phoneCountryFlag: '⚠️',
      nationalNumber: null,
      phoneType: 'invalid',
      validationReason: 'Phone field contains no numeric digits',
      needsManualReview: true,
      isWhatsAppEligibleCandidate: false,
      companyCity,
    };
  }

  // 3. International format vs National format parsing
  let parsed: PhoneNumber | undefined;

  if (digitsOnly.startsWith('+')) {
    // Explicit international format: derive country calling code STRICTLY from parsed digits.
    // Never pass a default region when leading + is present!
    parsed = parsePhoneNumberFromString(trimmed);
  } else {
    // National format without +: only use trusted region if explicitly provided and non-empty.
    // If trustedRegion is omitted, undefined, or null: strictly return 'needs_review'.
    // Do NOT silently default to 'ID' without trusted regional configuration.
    const trusted = options?.trustedRegion;
    if (trusted && typeof trusted === 'string' && trusted.trim().length > 0) {
      parsed = parsePhoneNumberFromString(trimmed, trusted.trim().toUpperCase() as any);
    } else {
      // National format without a trusted regional configuration
      return {
        rawPhone,
        isValid: false,
        isPossible: false,
        e164: null,
        countryCode: null,
        callingCode: null,
        phoneCountryName: 'Needs Review',
        phoneCountryFlag: '❓',
        nationalNumber: rawDigits,
        phoneType: 'needs_review',
        validationReason: 'National format number without a trusted regional configuration',
        needsManualReview: true,
        isWhatsAppEligibleCandidate: false,
        companyCity,
      };
    }
  }

  // 4. Failed parsing
  if (!parsed) {
    return {
      rawPhone,
      isValid: false,
      isPossible: false,
      e164: null,
      countryCode: null,
      callingCode: null,
      phoneCountryName: 'Invalid / Unrecognized',
      phoneCountryFlag: '⚠️',
      nationalNumber: rawDigits,
      phoneType: 'invalid',
      validationReason: 'Unrecognized phone number format or invalid length',
      needsManualReview: true,
      isWhatsAppEligibleCandidate: false,
      companyCity,
    };
  }

  // 5. Metadata extraction
  const countryCode = parsed.country || null;
  const callingCode = parsed.countryCallingCode ? `+${parsed.countryCallingCode}` : null;
  const { name: phoneCountryName, flag: phoneCountryFlag } = getCountryMetadata(countryCode);
  const nationalNumber = parsed.nationalNumber ? String(parsed.nationalNumber) : null;
  const isValid = parsed.isValid();
  const isPossible = parsed.isPossible();
  const e164 = isValid ? parsed.number : null;
  const rawType = parsed.getType(); // 'MOBILE' | 'FIXED_LINE' | 'FIXED_LINE_OR_MOBILE' | 'UAN' | etc.

  let phoneType: CanonicalPhoneType = 'unknown';
  let isWhatsAppEligibleCandidate = false;
  let validationReason = '';
  let needsManualReview = false;

  // 6. Type and eligibility classification
  if (rawType === 'MOBILE') {
    if (isValid) {
      phoneType = 'mobile';
      isWhatsAppEligibleCandidate = true;
      validationReason = `Valid mobile number (${phoneCountryName} ${callingCode})`;
    } else {
      phoneType = 'invalid';
      needsManualReview = true;
      validationReason = `Invalid mobile number structure for ${phoneCountryName}`;
    }
  } else if (rawType === 'FIXED_LINE') {
    phoneType = 'fixed_line';
    validationReason = `Fixed line / Landline (${phoneCountryName})`;
  } else if (rawType === 'FIXED_LINE_OR_MOBILE') {
    // Shared numbering plans (e.g. North America +1)
    phoneType = 'fixed_line_or_mobile';
    needsManualReview = true;
    validationReason = `Fixed line or mobile ambiguous range (${phoneCountryName})`;
  } else if (
    rawType === 'UAN' ||
    rawType === 'TOLL_FREE' ||
    rawType === 'SHARED_COST' ||
    rawType === 'PREMIUM_RATE' ||
    rawType === 'VOIP' ||
    rawType === 'PERSONAL_NUMBER'
  ) {
    phoneType = 'service_special';
    validationReason = `Special / Service / UAN number (${phoneCountryName} ${rawType})`;
  } else {
    // Undetermined or failed validity
    if (!isValid) {
      phoneType = 'invalid';
      needsManualReview = true;
      validationReason = `Invalid number format for ${phoneCountryName}`;
    } else {
      phoneType = 'needs_review';
      needsManualReview = true;
      validationReason = `Number type undetermined (${phoneCountryName})`;
    }
  }

  return {
    rawPhone,
    isValid,
    isPossible,
    e164,
    countryCode,
    callingCode,
    phoneCountryName,
    phoneCountryFlag,
    nationalNumber,
    phoneType,
    validationReason,
    needsManualReview,
    isWhatsAppEligibleCandidate,
    companyCity,
  };
}

/**
 * Splits compound multi-phone strings (e.g. "021-5678123 / 08123456789, Ext: 102")
 * into distinct independent phone records.
 */
export interface ExtractedPhoneRecord {
  raw: string;
  cleaned: string;
  contactPerson?: string | null;
  department?: string | null;
  extension?: string;
  classification: CanonicalPhoneClassification;
}

export function extractMultiplePhones(
  rawInput?: string | null,
  options?: {
    defaultContactPerson?: string | null;
    defaultDepartment?: string | null;
    trustedRegion?: string | null;
    companyCity?: string | null;
  }
): ExtractedPhoneRecord[] {
  if (!rawInput || !rawInput.trim()) return [];

  const records: ExtractedPhoneRecord[] = [];
  const segments = rawInput.split(/[\n;,|]+|\s+\/\s+/);

  for (const seg of segments) {
    const trimmed = seg.trim();
    if (!trimmed) continue;

    let contactPerson = options?.defaultContactPerson || null;
    let department = options?.defaultDepartment || null;
    let extension: string | undefined = undefined;
    let phonePart = trimmed;

    // Check for inline extension e.g. Ext: 1861 or x123
    const extMatch = phonePart.match(/(?:ext\.?|x|ex)\s*[:#]?\s*(\d+)/i);
    if (extMatch) {
      extension = extMatch[1];
      phonePart = phonePart.replace(/(?:ext\.?|x|ex)\s*[:#]?\s*\d+/i, '').trim();
    }

    const cleanDigits = phonePart.replace(/[^\d+]/g, '');
    if (cleanDigits.length >= 3) {
      const classification = classifyCanonicalPhone(phonePart, {
        trustedRegion: options?.trustedRegion,
        companyCity: options?.companyCity,
      });

      records.push({
        raw: trimmed,
        cleaned: classification.e164 || cleanDigits,
        contactPerson,
        department,
        extension,
        classification,
      });
    }
  }

  return records;
}
