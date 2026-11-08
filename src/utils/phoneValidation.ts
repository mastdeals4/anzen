// src/utils/phoneValidation.ts
//
// Phone number normalization, verification, and WhatsApp eligibility analysis.
// Built on top of the Canonical Shared Phone Service (libphonenumber-js).
// Strictly enforces separation between Phone Country, Company City, and Phone Type.
// Strictly prevents landline and service numbers from being marked as WhatsApp eligible.
// Supports multi-phone records per company and contact person with full department segregation.

import {
  classifyCanonicalPhone,
  type CanonicalPhoneClassification,
  type CanonicalPhoneType,
  getCountryMetadata,
} from '../services/crm/canonicalPhoneService.ts';

export type PhoneNumberType =
  | 'valid_mobile'
  | 'landline'
  | 'missing_number'
  | 'invalid_number'
  | 'duplicate_number'
  | 'international_number';

export type WhatsAppVerificationStatus =
  | 'whatsapp_confirmed'
  | 'whatsapp_unknown'
  | 'not_whatsapp';

export interface PhoneValidationResult {
  raw: string;
  normalized: string;
  type: PhoneNumberType;
  countryCode: string;
  isWhatsAppEligible: boolean;
  reason: string;
  whatsappStatus: WhatsAppVerificationStatus;
  canonical?: CanonicalPhoneClassification;
}

// Major Indonesian Landline Area Codes (kept for explicit reference and UI hints)
export const INDONESIA_LANDLINE_AREA_CODES = [
  '21',  // Jakarta, Tangerang, Bekasi, Depok
  '22',  // Bandung, Cimahi
  '23',  // Cirebon, Indramayu, Majalengka, Kuningan
  '24',  // Semarang
  '251', // Bogor
  '252', // Lebak
  '253', // Pandeglang
  '254', // Serang, Cilegon
  '260', // Subang
  '261', // Sumedang
  '262', // Garut
  '263', // Cianjur
  '264', // Purwakarta
  '265', // Tasikmalaya, Ciamis, Banjar
  '266', // Sukabumi
  '267', // Karawang
  '271', // Solo, Surakarta
  '272', // Klaten
  '273', // Wonogiri
  '274', // Yogyakarta, Sleman, Bantul
  '275', // Purworejo
  '276', // Boyolali
  '280', // Cilacap
  '281', // Purwokerto, Banyumas
  '282', // Cilacap
  '283', // Tegal, Brebes
  '284', // Pemalang
  '285', // Pekalongan, Batang
  '286', // Banjarnegara, Wonosobo
  '287', // Kebumen
  '291', // Kudus, Jepara, Demak
  '292', // Grobogan
  '293', // Magelang, Temanggung
  '294', // Kendal
  '295', // Pati, Rembang
  '296', // Blora
  '297', // Karimunjawa
  '298', // Salatiga
  '31',  // Surabaya, Sidoarjo, Gresik
  '321', // Mojokerto, Jombang
  '322', // Lamongan
  '323', // Sampang
  '324', // Pamekasan
  '325', // Bawean
  '327', // Sumenep
  '328', // Sumenep
  '331', // Jember
  '332', // Bondowoso
  '333', // Banyuwangi
  '334', // Lumajang
  '335', // Probolinggo
  '336', // Ambulu
  '338', // Situbondo
  '341', // Malang, Batu
  '342', // Blitar
  '343', // Pasuruan
  '351', // Madiun, Magetan, Ngawi
  '352', // Ponorogo
  '353', // Bojonegoro
  '354', // Kediri
  '355', // Tulungagung, Trenggalek
  '356', // Tuban
  '357', // Pacitan
  '358', // Nganjuk
  '361', // Denpasar, Badung, Gianyar, Tabanan (Bali)
  '362', // Singaraja
  '363', // Karangasem
  '365', // Negara
  '366', // Klungkung, Bangli
  '368', // Baturiti
  '370', // Mataram, Lombok
  '371', // Sumbawa
  '380', // Kupang
  '411', // Makassar
  '431', // Manado
  '511', // Banjarmasin
  '542', // Balikpapan
  '561', // Pontianak
  '61',  // Medan, Binjai, Deli Serdang
  '711', // Palembang
  '721', // Bandar Lampung
  '741', // Jambi
  '751', // Padang
  '761', // Pekanbaru
  '778', // Batam
];

// Valid Indonesian Mobile Prefixes (after +62 or 0)
export const INDONESIA_MOBILE_PREFIXES = [
  '811', '812', '813', '821', '822', '823', '851', '852', '853', // Telkomsel
  '814', '815', '816', '855', '856', '857', '858',               // Indosat Ooredoo
  '817', '818', '819', '859', '877', '878',                       // XL Axiata
  '895', '896', '897', '898', '899',                               // Tri (3)
  '881', '882', '883', '884', '885', '886', '887', '888', '889', // Smartfren
  '831', '832', '833', '838',                                     // Axis
];

/**
 * Normalizes a phone number to standard E.164.
 * Returns empty string if number is invalid or cannot be normalized.
 */
export function normalizeE164(rawNumber?: string | null, trustedRegion = 'ID'): string {
  if (!rawNumber) return '';
  const canonical = classifyCanonicalPhone(rawNumber, { trustedRegion });
  return canonical.e164 || '';
}

/**
 * Authoritative phone number validation function.
 * Wraps classifyCanonicalPhone and preserves backward-compatible PhoneValidationResult interface.
 */
export function validatePhoneNumber(rawNumber?: string | null, trustedRegion = 'ID'): PhoneValidationResult {
  const canonical = classifyCanonicalPhone(rawNumber, { trustedRegion });

  let type: PhoneNumberType;
  if (canonical.phoneType === 'missing') {
    type = 'missing_number';
  } else if (canonical.phoneType === 'invalid' || canonical.phoneType === 'needs_review') {
    type = 'invalid_number';
  } else if (canonical.phoneType === 'fixed_line' || canonical.phoneType === 'service_special') {
    type = 'landline';
  } else if (canonical.phoneType === 'mobile') {
    type = canonical.countryCode === 'ID' ? 'valid_mobile' : 'international_number';
  } else if (canonical.phoneType === 'fixed_line_or_mobile') {
    type = 'invalid_number'; // ambiguous range requires review
  } else {
    type = 'invalid_number';
  }

  const isEligible = canonical.isWhatsAppEligibleCandidate;
  const whatsappStatus: WhatsAppVerificationStatus = isEligible
    ? 'whatsapp_unknown'
    : 'not_whatsapp';

  return {
    raw: canonical.rawPhone,
    normalized: canonical.e164 || canonical.rawPhone.replace(/[^\d+]/g, ''),
    type,
    countryCode: canonical.callingCode || '',
    isWhatsAppEligible: isEligible,
    reason: canonical.validationReason,
    whatsappStatus,
    canonical,
  };
}

export interface ParsedPhoneItem {
  raw: string;
  cleaned: string;
  contactPerson?: string | null;
  department?: string | null;
  extension?: string;
  validation: PhoneValidationResult;
}

/**
 * Multi-phone parser that extracts individual phone numbers from compound strings.
 * Safely splits on commas, semicolons, newlines, pipes, or ' / ' between digits.
 * Preserves area codes, extensions, and contact person/department annotations.
 */
export function parsePhoneEntries(
  raw?: string | null,
  defaultPerson?: string | null,
  defaultDept?: string | null,
  trustedRegion = 'ID'
): ParsedPhoneItem[] {
  if (!raw || typeof raw !== 'string') return [];
  const text = raw.trim();
  if (!text) return [];

  // 1. If parens contain a full phone number (>=9 digits) followed by another phone number, separate them
  let preprocessed = text.replace(/\((\+?0?\d{9,14}[^)]*)\)\s*(?=\+?0?\d{6,})/g, '($1) , ');

  // 2. Normalize area codes in parens: '(021) 1234567' -> '021 1234567', '(+62-22) 1234567' -> '022 1234567'
  preprocessed = preprocessed.replace(/\((?:\+?62[- ]?)?0?(\d{2,4})\)/g, '0$1 ');

  // 3. Split on comma, semicolon, newline, pipe, or ' / '
  const rawSegments = preprocessed.split(/[,;\n|]|\s+\/\s+/).map(s => s.trim()).filter(Boolean);

  const results: ParsedPhoneItem[] = [];
  let lastAreaCode: string | null = null;

  for (let i = 0; i < rawSegments.length; i++) {
    let seg = rawSegments[i];
    let detectedPerson = defaultPerson || null;
    let detectedDept = defaultDept || null;

    // Check if segment is purely an extension belonging to prior number, e.g. 'Ext: 1861'
    if (/^(?:ext\.?|extension)\s*:?\s*\d+$/i.test(seg) || !/\d{3,}/.test(seg)) {
      if (results.length > 0 && /ext/i.test(seg)) {
        results[results.length - 1].extension = seg;
      }
      continue;
    }

    // Detect and extract non-numeric notes inside parens e.g. (MRS MESSI), (Purchasing), (PSTN), (Hunting)
    seg = seg.replace(/\(([^)]+)\)/g, (_match, inside) => {
      const trimmedInside = inside.trim();
      const phoneInParen = trimmedInside.match(/(\+?0?\d{9,14})/);
      if (phoneInParen) {
        const namePart = trimmedInside.replace(phoneInParen[0], '').trim();
        if (namePart) detectedPerson = namePart;
        return phoneInParen[0];
      }
      if (/purchas|procure/i.test(trimmedInside)) detectedDept = 'Purchasing';
      else if (/import/i.test(trimmedInside)) detectedDept = 'Import';
      else if (/qa|qc|quality/i.test(trimmedInside)) detectedDept = 'QA / QC';
      else if (/sales|market/i.test(trimmedInside)) detectedDept = 'Sales';
      else if (/finance|acc/i.test(trimmedInside)) detectedDept = 'Finance';
      else if (/[A-Za-z]{2,}/.test(trimmedInside)) {
        detectedPerson = trimmedInside;
      }
      return '';
    }).trim();

    // Clean Excel export '.0'
    seg = seg.replace(/\.0+$/, '').trim();

    // Strip inline extension
    const extMatch = seg.match(/\s*(?:ext\.?|extension)\s*:?\s*(\d+)/i);
    let extension: string | undefined = undefined;
    if (extMatch) {
      extension = extMatch[1];
      seg = seg.replace(extMatch[0], '').trim();
    }

    // Strip trailing slash or dash
    seg = seg.replace(/[\/\-, ]+$/, '').trim();

    // Check if this segment is a local 5-8 digit number following an area code e.g. '724336' after '0271 – 715627'
    const digitsOnly = seg.replace(/\D/g, '');
    if (digitsOnly.length >= 5 && digitsOnly.length <= 8 && !seg.startsWith('0') && !seg.startsWith('+') && lastAreaCode) {
      seg = `${lastAreaCode} ${seg}`;
    }

    // Extract area code if it looks like an Indonesian landline
    const areaMatch = seg.match(/^(?:\+?62|0)(21|22|24|31|271|274|251|341|343)\b/);
    if (areaMatch) {
      lastAreaCode = '0' + areaMatch[1];
    }

    const validation = validatePhoneNumber(seg, trustedRegion);
    if (validation.type !== 'missing_number') {
      results.push({
        raw: rawSegments[i],
        cleaned: seg,
        contactPerson: detectedPerson,
        department: detectedDept,
        extension,
        validation,
      });
    }
  }

  return results;
}

export interface ContactPhoneRecord {
  id: string;
  contact_id: string;
  company_name: string;
  contact_person: string | null;
  department: string;
  raw_phone: string;
  normalized_phone: string;
  country_code: string;
  country_name: string;
  country_flag?: string;
  phone_type: PhoneNumberType;
  canonical_type?: CanonicalPhoneType;
  is_whatsapp_eligible: boolean;
  is_primary: boolean;
  consent_status: 'opted_in' | 'opted_out' | 'pending';
  extension?: string | null;
  notes?: string | null;
  is_duplicate?: boolean;
  duplicate_group_type?: 'same_company' | 'cross_company';
  duplicate_reason?: string;
  company_city?: string | null;
}

export interface CompanyPhoneGroup {
  companyId: string;
  companyName: string;
  city: string | null;
  customerType: string | null;
  phones: ContactPhoneRecord[];
  primaryPhone: ContactPhoneRecord | null;
  contacts: Array<{
    name: string;
    department: string;
    phones: ContactPhoneRecord[];
  }>;
}

export interface VerifiedContactItem {
  id: string;
  contact_id?: string;
  company_name: string;
  contact_person: string | null;
  department?: string;
  email: string | null;
  raw_phone: string | null;
  city: string | null; // Strictly company city from CRM address
  customer_type: string | null;
  validation: PhoneValidationResult;
  consent_status: 'opted_in' | 'opted_out' | 'unspecified' | 'pending';
  is_primary?: boolean;
  extension?: string | null;
  is_duplicate: boolean;
  duplicate_group_type?: 'same_company' | 'cross_company';
  is_eligible: boolean;
  exclusion_reason?: string;
  last_contact_date?: string | null;
}

export interface PhoneAuditStats {
  total: number;
  totalCompanies?: number;
  totalContacts?: number;
  totalPhones?: number;
  eligible: number;
  landline: number;
  missing: number;
  invalid: number;
  duplicates: number;
  international: number;
  optedOut: number;
}

export interface PhoneAuditResult {
  items: VerifiedContactItem[];
  companyGroups?: CompanyPhoneGroup[];
  phoneRecords?: ContactPhoneRecord[];
  stats: PhoneAuditStats;
}

export type PhoneAuditSummary = PhoneAuditResult;

/**
 * Standard audit that verifies CRM contacts.
 */
export function auditAndVerifyContacts(
  contacts: Array<{
    id: string;
    company_name: string;
    contact_person?: string | null;
    designation?: string | null;
    email?: string | null;
    phone?: string | null;
    mobile?: string | null;
    landline?: string | null;
    city?: string | null;
    country?: string | null;
    customer_type?: string | null;
    notes?: string | null;
    last_contact?: string | null;
  }>,
  options?: { multiPhone?: boolean }
): PhoneAuditResult {
  if (options?.multiPhone) {
    return auditContactsMultiPhone(contacts);
  }

  return auditContactsMultiPhone(contacts);
}

/**
 * Authoritative multi-phone audit that evaluates individual phone numbers across all companies.
 * Uses the canonical phone classification service.
 */
export function auditContactsMultiPhone(
  contacts: Array<{
    id: string;
    company_name: string;
    contact_person?: string | null;
    designation?: string | null;
    email?: string | null;
    phone?: string | null;
    mobile?: string | null;
    landline?: string | null;
    city?: string | null;
    country?: string | null;
    customer_type?: string | null;
    notes?: string | null;
    last_contact?: string | null;
  }>,
  existingPhonesTable?: ContactPhoneRecord[]
): PhoneAuditResult {
  const items: VerifiedContactItem[] = [];
  const phoneRecords: ContactPhoneRecord[] = [];
  const companyGroups: CompanyPhoneGroup[] = [];

  // Pass 1: Parse and collect all individual phones
  const phoneInstancesMap = new Map<string, Array<{ companyId: string; companyName: string }>>();

  for (const c of contacts) {
    const rawSources = [
      { raw: c.mobile, defaultDept: 'Purchasing' },
      { raw: c.phone, defaultDept: 'General Office' },
      { raw: c.landline, defaultDept: 'General Office' },
    ].filter(s => s.raw && s.raw.trim());

    const noteText = (c.notes || '').toLowerCase();
    const consentStatus: 'opted_in' | 'opted_out' | 'pending' =
      noteText.includes('opt-out') || noteText.includes('stop wa') || noteText.includes('unsubscribe')
        ? 'opted_out'
        : noteText.includes('opt-in') || noteText.includes('verified wa')
        ? 'opted_in'
        : 'pending';

    const seenCleaned = new Set<string>();
    const parsedList: ParsedPhoneItem[] = [];

    // If pre-seeded records exist for this contact, use them
    const preSeeded = existingPhonesTable?.filter(p => p.contact_id === c.id);
    if (preSeeded && preSeeded.length > 0) {
      for (const p of preSeeded) {
        const val = validatePhoneNumber(p.raw_phone);
        parsedList.push({
          raw: p.raw_phone,
          cleaned: p.normalized_phone || p.raw_phone,
          contactPerson: p.contact_person,
          department: p.department,
          extension: p.extension || undefined,
          validation: val,
        });
      }
    } else {
      for (const src of rawSources) {
        const parsed = parsePhoneEntries(src.raw, c.contact_person, c.designation || src.defaultDept);
        for (const p of parsed) {
          const key = p.validation.normalized || p.cleaned;
          if (!seenCleaned.has(key)) {
            seenCleaned.add(key);
            parsedList.push(p);
          }
        }
      }
    }

    if (parsedList.length === 0) {
      // Company has no numbers recorded
      const missingItem: VerifiedContactItem = {
        id: `${c.id}_missing`,
        contact_id: c.id,
        company_name: c.company_name || '(Unnamed Company)',
        contact_person: c.contact_person || null,
        department: c.designation || 'General Office',
        email: c.email || null,
        raw_phone: null,
        city: c.city || null,
        customer_type: c.customer_type || 'Prospect',
        validation: {
          raw: '',
          normalized: '',
          type: 'missing_number',
          countryCode: '',
          isWhatsAppEligible: false,
          reason: 'No phone or mobile number provided',
          whatsappStatus: 'not_whatsapp',
          canonical: classifyCanonicalPhone('', { companyCity: c.city }),
        },
        consent_status: consentStatus,
        is_primary: true,
        is_duplicate: false,
        is_eligible: false,
        exclusion_reason: 'Missing telephone number',
        last_contact_date: c.last_contact || null,
      };
      items.push(missingItem);

      companyGroups.push({
        companyId: c.id,
        companyName: c.company_name,
        city: c.city || null,
        customerType: c.customer_type || null,
        phones: [],
        primaryPhone: null,
        contacts: c.contact_person ? [{ name: c.contact_person, department: c.designation || 'General Office', phones: [] }] : [],
      });
    } else {
      const companyPhones: ContactPhoneRecord[] = [];
      const firstMobileIdx = parsedList.findIndex(p => p.validation.isWhatsAppEligible);
      const primaryIdx = firstMobileIdx >= 0 ? firstMobileIdx : 0;

      for (let i = 0; i < parsedList.length; i++) {
        const p = parsedList[i];
        const key = p.validation.normalized || p.cleaned;
        if (!phoneInstancesMap.has(key)) {
          phoneInstancesMap.set(key, []);
        }
        phoneInstancesMap.get(key)!.push({ companyId: c.id, companyName: c.company_name });

        const canonical = p.validation.canonical || classifyCanonicalPhone(p.raw, { companyCity: c.city });
        const record: ContactPhoneRecord = {
          id: `${c.id}_${i}`,
          contact_id: c.id,
          company_name: c.company_name,
          contact_person: p.contactPerson || c.contact_person || null,
          department: p.department || (p.validation.isWhatsAppEligible ? 'Purchasing' : 'General Office'),
          raw_phone: p.raw,
          normalized_phone: p.validation.normalized || p.cleaned,
          country_code: canonical.callingCode || '+62',
          country_name: canonical.phoneCountryName || 'Indonesia',
          country_flag: canonical.phoneCountryFlag || '🇮🇩',
          phone_type: p.validation.type,
          canonical_type: canonical.phoneType,
          is_whatsapp_eligible: canonical.isWhatsAppEligibleCandidate,
          is_primary: i === primaryIdx,
          consent_status: consentStatus,
          extension: p.extension || null,
          notes: canonical.validationReason,
          company_city: c.city || null,
        };

        companyPhones.push(record);
        phoneRecords.push(record);

        const vItem: VerifiedContactItem = {
          id: record.id,
          contact_id: c.id,
          company_name: c.company_name,
          contact_person: record.contact_person,
          department: record.department,
          email: c.email || null,
          raw_phone: record.raw_phone,
          city: c.city || null,
          customer_type: c.customer_type || 'Prospect',
          validation: p.validation,
          consent_status: consentStatus,
          is_primary: record.is_primary,
          extension: record.extension,
          is_duplicate: false, // will update in pass 2
          is_eligible: canonical.isWhatsAppEligibleCandidate && consentStatus !== 'opted_out',
          exclusion_reason: !canonical.isWhatsAppEligibleCandidate
            ? canonical.validationReason
            : consentStatus === 'opted_out'
            ? 'Contact opted out from WhatsApp communications'
            : undefined,
          last_contact_date: c.last_contact || null,
        };
        items.push(vItem);
      }

      companyGroups.push({
        companyId: c.id,
        companyName: c.company_name,
        city: c.city || null,
        customerType: c.customer_type || null,
        phones: companyPhones,
        primaryPhone: companyPhones.find(p => p.is_primary) || companyPhones[0] || null,
        contacts: [
          {
            name: c.contact_person || 'General Contact',
            department: c.designation || 'General Office',
            phones: companyPhones,
          },
        ],
      });
    }
  }

  // Pass 2: Mark duplicates across individual numbers
  let duplicateInstancesCount = 0;
  for (const item of items) {
    const key = item.validation.normalized || item.raw_phone;
    if (key && phoneInstancesMap.has(key)) {
      const instances = phoneInstancesMap.get(key)!;
      if (instances.length > 1) {
        duplicateInstancesCount++;
        item.is_duplicate = true;

        const comps = Array.from(new Set(instances.map(x => x.companyName)));
        const cleanNames = comps.map(cn =>
          cn.toUpperCase()
            .replace(/\b(PT|PT\.|CV|CV\.|UD|UD\.|INC|LTD|TBK|PERSERO|LABORATORIES|INDUSTRI|INDUSTRY|PHARMACEUTICAL|PHARMA|FARMA|MEDICA|SKINCARE|HOLDING|GROUP)\b/g, '')
            .replace(/[()[\]-]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
        );
        const firstWordSet = new Set(cleanNames.map(n => n.split(' ').filter(w => w.length > 2)[0]));
        const isSameCompanyGroup = comps.length === 1 || firstWordSet.size === 1;

        item.duplicate_group_type = isSameCompanyGroup ? 'same_company' : 'cross_company';
        item.exclusion_reason = item.exclusion_reason || `Duplicate phone number shared across ${comps.length} company records`;
      }
    }
  }

  // Compute accurate multi-phone stats
  const eligibleCount = items.filter(i => i.is_eligible).length;
  const landlineCount = items.filter(i => i.validation.type === 'landline').length;
  const missingCount = items.filter(i => i.validation.type === 'missing_number').length;
  const invalidCount = items.filter(i => i.validation.type === 'invalid_number').length;
  const internationalCount = items.filter(i => i.validation.type === 'international_number').length;
  const optedOutCount = items.filter(i => i.consent_status === 'opted_out').length;
  const uniqueContactsCount = new Set(contacts.map(c => c.contact_person).filter(Boolean)).size;

  return {
    items,
    companyGroups,
    phoneRecords,
    stats: {
      total: items.length,
      totalCompanies: contacts.length,
      totalContacts: uniqueContactsCount,
      totalPhones: items.filter(i => i.raw_phone).length,
      eligible: eligibleCount,
      landline: landlineCount,
      missing: missingCount,
      invalid: invalidCount,
      duplicates: duplicateInstancesCount,
      international: internationalCount,
      optedOut: optedOutCount,
    },
  };
}

export interface CountryInfo {
  name: string;
  code: string;
  flag: string;
}

/**
 * Derives telephone country metadata strictly from the parsed telephone number.
 * NEVER infers country from company city or company address.
 */
export function detectCountryInfo(
  rawPhone?: string | null,
  _countryHint?: string | null,
  _cityHint?: string | null
): CountryInfo {
  if (!rawPhone || !rawPhone.trim()) {
    return { name: 'Missing', code: '', flag: '—' };
  }

  const canonical = classifyCanonicalPhone(rawPhone, { trustedRegion: 'ID' });
  if (canonical.countryCode) {
    return {
      name: canonical.phoneCountryName,
      code: canonical.callingCode || '',
      flag: canonical.phoneCountryFlag,
    };
  }

  return {
    name: canonical.phoneCountryName,
    code: canonical.callingCode || '',
    flag: canonical.phoneCountryFlag,
  };
}

/**
 * Suggests a safe, cleaned mobile number formatting for unambiguous mobile numbers.
 * Converts 08... to +628... and removes dashes/spaces.
 * Does NOT convert landlines (021, 022, etc.) to mobile.
 */
export function suggestCleanMobileNumber(raw: string): string {
  if (!raw) return '';
  const trimmed = raw.trim();

  // Strip trailing notes, e.g. " (Hunting)", " ext 123"
  let cleaned = trimmed
    .replace(/\s*\(hunting\)/i, '')
    .replace(/\s+hunting/i, '')
    .replace(/\s+ext\.?\s*\d+/i, '')
    .replace(/\s+[A-Za-z]$/, '')
    .trim();

  cleaned = cleaned.replace(/^(telepon|telp|phone|mobile|wa|hp|handphone)[\s.:]*/i, '').trim();

  const canonical = classifyCanonicalPhone(cleaned, { trustedRegion: 'ID' });
  if (canonical.isWhatsAppEligibleCandidate && canonical.e164) {
    return canonical.e164;
  }

  return '';
}

export interface DuplicateGroup {
  normalizedPhone: string;
  count: number;
  contacts: VerifiedContactItem[];
  groupType: 'same_company' | 'cross_company';
  companies: string[];
}

/**
 * Groups duplicate contacts by normalized phone number.
 */
export function groupDuplicates(items: VerifiedContactItem[]): DuplicateGroup[] {
  const groups = new Map<string, VerifiedContactItem[]>();

  for (const item of items) {
    const key = item.validation.normalized || item.raw_phone;
    if (key && item.is_duplicate) {
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(item);
    }
  }

  const result: DuplicateGroup[] = [];
  for (const [phone, contactList] of groups.entries()) {
    const companies = Array.from(new Set(contactList.map(c => c.company_name)));
    const cleanNames = companies.map(cn =>
      cn.toUpperCase()
        .replace(/\b(PT|PT\.|CV|CV\.|UD|UD\.|INC|LTD|TBK|PERSERO|LABORATORIES|INDUSTRI|INDUSTRY|PHARMACEUTICAL|PHARMA|FARMA|MEDICA|SKINCARE|HOLDING|GROUP)\b/g, '')
        .replace(/[()[\]-]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
    );
    const firstWordSet = new Set(cleanNames.map(n => n.split(' ').filter(w => w.length > 2)[0]));
    const isSameCompanyGroup = companies.length === 1 || firstWordSet.size === 1;

    result.push({
      normalizedPhone: phone,
      count: contactList.length,
      contacts: contactList,
      groupType: isSameCompanyGroup ? 'same_company' : 'cross_company',
      companies,
    });
  }

  return result.sort((a, b) => b.count - a.count);
}

export interface BulkNormalizationCandidate {
  id: string;
  contactId: string;
  companyName: string;
  contactPerson: string | null;
  currentRaw: string;
  proposedNormalized: string;
  company_name?: string;
  contact_person?: string | null;
  department?: string;
  original_raw?: string;
  suggested_normalized?: string;
  is_selected?: boolean;
}

/**
 * Gathers candidate numbers that can be safely normalized.
 */
export function getBulkNormalizationCandidates(items: VerifiedContactItem[]): BulkNormalizationCandidate[] {
  const candidates: BulkNormalizationCandidate[] = [];

  for (const item of items) {
    if (!item.raw_phone) continue;
    const clean = suggestCleanMobileNumber(item.raw_phone);
    if (clean && clean !== item.raw_phone) {
      candidates.push({
        id: item.id,
        contactId: item.contact_id || item.id,
        companyName: item.company_name,
        contactPerson: item.contact_person,
        currentRaw: item.raw_phone,
        proposedNormalized: clean,
        company_name: item.company_name,
        contact_person: item.contact_person,
        department: item.department || 'Purchasing',
        original_raw: item.raw_phone,
        suggested_normalized: clean,
        is_selected: true,
      });
    }
  }

  return candidates;
}
