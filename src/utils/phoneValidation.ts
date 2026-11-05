// src/utils/phoneValidation.ts
//
// Phone number normalization, verification, and WhatsApp eligibility analysis.
// Distinguishes between Indonesian mobile, landline, international, and invalid numbers.
// Strictly prevents landline numbers from being marked as WhatsApp eligible.
// Supports multi-phone records per company and contact person with full department segregation.

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
}

// Major Indonesian Landline Area Codes
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
 * Normalizes and analyzes a phone number for WhatsApp campaign eligibility.
 */
export function normalizeE164(rawNumber?: string | null): string {
  if (!rawNumber) return '';
  const result = validatePhoneNumber(rawNumber);
  return result.normalized || '';
}

export function validatePhoneNumber(rawNumber?: string | null): PhoneValidationResult {
  const raw = (rawNumber || '').trim();

  if (!raw) {
    return {
      raw: '',
      normalized: '',
      type: 'missing_number',
      countryCode: '',
      isWhatsAppEligible: false,
      reason: 'No phone or mobile number provided',
      whatsappStatus: 'not_whatsapp',
    };
  }

  // Strip spaces, dashes, brackets, dots, slashes
  const digitsOnly = raw.replace(/[^\d+]/g, '');
  const digitsNoPlus = digitsOnly.replace(/^\+/, '');

  if (digitsNoPlus.length < 7) {
    return {
      raw,
      normalized: digitsOnly,
      type: 'invalid_number',
      countryCode: '',
      isWhatsAppEligible: false,
      reason: 'Number is too short (< 7 digits)',
      whatsappStatus: 'not_whatsapp',
    };
  }

  // 1. Detect Indonesian number formats (08..., 628..., +628..., 021..., +6221...)
  let idNumberBody = '';
  let isExplicitIndonesia = false;

  if (digitsOnly.startsWith('+62')) {
    idNumberBody = digitsOnly.slice(3);
    isExplicitIndonesia = true;
  } else if (digitsOnly.startsWith('62')) {
    idNumberBody = digitsOnly.slice(2);
    isExplicitIndonesia = true;
  } else if (digitsOnly.startsWith('0')) {
    idNumberBody = digitsOnly.slice(1);
    isExplicitIndonesia = true;
  }

  if (isExplicitIndonesia) {
    // Check if it's an Indonesian mobile number (starts with 8...)
    if (idNumberBody.startsWith('8')) {
      const prefix3 = idNumberBody.slice(0, 3);
      const isKnownMobilePrefix = INDONESIA_MOBILE_PREFIXES.includes(prefix3);

      // Mobile numbers in Indonesia are typically 9 to 13 digits after 0 (i.e. body length 9-13)
      if (idNumberBody.length >= 9 && idNumberBody.length <= 13) {
        const normalized = `+62${idNumberBody}`;
        return {
          raw,
          normalized,
          type: 'valid_mobile',
          countryCode: '+62',
          isWhatsAppEligible: true,
          reason: isKnownMobilePrefix
            ? 'Valid Indonesian mobile number'
            : 'Indonesian mobile series (starts with 8)',
          whatsappStatus: 'whatsapp_unknown', // Unverified until checked or confirmed
        };
      } else {
        return {
          raw,
          normalized: `+62${idNumberBody}`,
          type: 'invalid_number',
          countryCode: '+62',
          isWhatsAppEligible: false,
          reason: `Invalid Indonesian mobile length (${idNumberBody.length} digits, expected 9-13)`,
          whatsappStatus: 'not_whatsapp',
        };
      }
    }

    // Check if it matches an Indonesian landline area code
    const isLandline = INDONESIA_LANDLINE_AREA_CODES.some(area => idNumberBody.startsWith(area));
    if (isLandline || idNumberBody.startsWith('2') || idNumberBody.startsWith('3') || idNumberBody.startsWith('4') || idNumberBody.startsWith('7')) {
      return {
        raw,
        normalized: `+62${idNumberBody}`,
        type: 'landline',
        countryCode: '+62',
        isWhatsAppEligible: false,
        reason: 'Fixed landline number (cannot receive WhatsApp messages)',
        whatsappStatus: 'not_whatsapp',
      };
    }
  }

  // 2. Detect International numbers (starts with + or non-62 prefix)
  if (digitsOnly.startsWith('+')) {
    const intlDigits = digitsOnly.slice(1);
    // International mobile standard: 8 to 15 digits
    if (intlDigits.length >= 8 && intlDigits.length <= 15) {
      // Determine country code prefix
      let cc = '+1';
      if (intlDigits.startsWith('91')) cc = '+91'; // India
      else if (intlDigits.startsWith('86')) cc = '+86'; // China
      else if (intlDigits.startsWith('65')) cc = '+65'; // Singapore
      else if (intlDigits.startsWith('60')) cc = '+60'; // Malaysia
      else if (intlDigits.startsWith('44')) cc = '+44'; // UK
      else if (intlDigits.startsWith('49')) cc = '+49'; // Germany
      else if (intlDigits.startsWith('81')) cc = '+81'; // Japan
      else if (intlDigits.startsWith('82')) cc = '+82'; // South Korea

      return {
        raw,
        normalized: `+${intlDigits}`,
        type: 'international_number',
        countryCode: cc,
        isWhatsAppEligible: true,
        reason: `International mobile number (${cc})`,
        whatsappStatus: 'whatsapp_unknown',
      };
    }
  }

  // Non-+ numbers without leading 0 that are 10-14 digits long
  if (digitsNoPlus.length >= 9 && digitsNoPlus.length <= 14) {
    if (digitsNoPlus.startsWith('8')) {
      // Missing 0 or 62 prefix, e.g. 8129999999
      return {
        raw,
        normalized: `+62${digitsNoPlus}`,
        type: 'valid_mobile',
        countryCode: '+62',
        isWhatsAppEligible: true,
        reason: 'Indonesian mobile with recovered +62 country prefix',
        whatsappStatus: 'whatsapp_unknown',
      };
    }
  }

  return {
    raw,
    normalized: digitsOnly,
    type: 'invalid_number',
    countryCode: '',
    isWhatsAppEligible: false,
    reason: 'Unrecognized phone format or unroutable number',
    whatsappStatus: 'not_whatsapp',
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
 * Advanced multi-phone parser that extracts individual phone numbers from compound strings.
 * Safely splits on commas, semicolons, newlines, pipes, or ' / ' between digits.
 * Preserves area codes in parens e.g. (021), extensions e.g. Ext: 1861,
 * and person/department annotations e.g. (08564621222 MRS MESSI).
 */
export function parsePhoneEntries(
  raw?: string | null,
  defaultPerson?: string | null,
  defaultDept?: string | null
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
      // If it contains a full phone number plus a person name e.g. '08564621222 MRS MESSI'
      const phoneInParen = trimmedInside.match(/(\+?0?\d{9,14})/);
      if (phoneInParen) {
        const namePart = trimmedInside.replace(phoneInParen[0], '').trim();
        if (namePart) detectedPerson = namePart;
        return phoneInParen[0];
      }
      // If department or label
      if (/purchas|procure/i.test(trimmedInside)) detectedDept = 'Purchasing';
      else if (/import/i.test(trimmedInside)) detectedDept = 'Import';
      else if (/qa|qc|quality/i.test(trimmedInside)) detectedDept = 'QA / QC';
      else if (/sales|market/i.test(trimmedInside)) detectedDept = 'Sales';
      else if (/finance|acc/i.test(trimmedInside)) detectedDept = 'Finance';
      else if (/pstn|hunting|kantor|office|fax/i.test(trimmedInside)) {
        // label
      } else if (/[A-Za-z]{2,}/.test(trimmedInside)) {
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

    const validation = validatePhoneNumber(seg);
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
  is_whatsapp_eligible: boolean;
  is_primary: boolean;
  consent_status: 'opted_in' | 'opted_out' | 'pending';
  extension?: string | null;
  notes?: string | null;
  is_duplicate?: boolean;
  duplicate_group_type?: 'same_company' | 'cross_company';
  duplicate_reason?: string;
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
  city: string | null;
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
 * By default with multiPhone: false, performs exact single-partition reconciliation on 521 companies.
 * When multiPhone: true, extracts all compound numbers per company and provides multi-phone breakdowns.
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

  // Legacy single-string partition: maps 1-to-1 per contact
  const normalizedSeen = new Map<string, number>();

  const intermediate = contacts.map(c => {
    const rawNum = c.mobile || c.phone || '';
    const validation = validatePhoneNumber(rawNum);

    const noteText = (c.notes || '').toLowerCase();
    const isOptedOut =
      noteText.includes('opt-out') ||
      noteText.includes('optout') ||
      noteText.includes('stop wa') ||
      noteText.includes('do not contact') ||
      noteText.includes('unsubscribe');

    const consentStatus: 'opted_in' | 'opted_out' | 'unspecified' = isOptedOut
      ? 'opted_out'
      : noteText.includes('opt-in') || noteText.includes('verified wa')
      ? 'opted_in'
      : 'unspecified';

    if (validation.normalized && validation.isWhatsAppEligible) {
      normalizedSeen.set(validation.normalized, (normalizedSeen.get(validation.normalized) || 0) + 1);
    }

    return {
      id: c.id,
      company_name: c.company_name || '(Unnamed Company)',
      contact_person: c.contact_person || null,
      email: c.email || null,
      raw_phone: rawNum || null,
      city: c.city || null,
      customer_type: c.customer_type || 'Prospect',
      validation,
      consent_status: consentStatus,
      last_contact_date: c.last_contact || null,
    };
  });

  let eligibleCount = 0;
  let landlineCount = 0;
  let missingCount = 0;
  let invalidCount = 0;
  let duplicateCount = 0;
  let internationalCount = 0;
  let optedOutCount = 0;

  const items: VerifiedContactItem[] = intermediate.map(item => {
    const norm = item.validation.normalized;
    const isDupe = norm ? (normalizedSeen.get(norm) || 0) > 1 : false;

    let isEligible = item.validation.isWhatsAppEligible;
    let exclusionReason: string | undefined = undefined;

    if (item.validation.type === 'missing_number') {
      missingCount++;
      isEligible = false;
      exclusionReason = 'Missing telephone number';
    } else if (item.validation.type === 'landline') {
      landlineCount++;
      isEligible = false;
      exclusionReason = 'Landline number (cannot receive WhatsApp)';
    } else if (item.validation.type === 'invalid_number') {
      invalidCount++;
      isEligible = false;
      exclusionReason = item.validation.reason;
    } else if (item.consent_status === 'opted_out') {
      optedOutCount++;
      isEligible = false;
      exclusionReason = 'Customer opted out from WhatsApp broadcasts';
    } else if (isDupe) {
      duplicateCount++;
      exclusionReason = 'Duplicate telephone number shared across multiple records';
    }

    if (item.validation.type === 'international_number') {
      internationalCount++;
    }

    if (isEligible) {
      eligibleCount++;
    }

    return {
      ...item,
      is_duplicate: isDupe,
      is_eligible: isEligible,
      exclusion_reason: exclusionReason,
    };
  });

  return {
    items,
    stats: {
      total: contacts.length,
      totalCompanies: contacts.length,
      totalContacts: new Set(contacts.map(c => c.contact_person).filter(Boolean)).size,
      totalPhones: contacts.filter(c => c.mobile || c.phone).length,
      eligible: eligibleCount,
      landline: landlineCount,
      missing: missingCount,
      invalid: invalidCount,
      duplicates: duplicateCount,
      international: internationalCount,
      optedOut: optedOutCount,
    },
  };
}

/**
 * Enhanced multi-phone audit that evaluates individual phone numbers across all companies.
 * Unlocks multiple mobile numbers per company and preserves all landlines.
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
      { raw: c.landline, defaultDept: 'General Office' }
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
        parsedList.push({
          raw: p.raw_phone,
          cleaned: p.normalized_phone || p.raw_phone,
          contactPerson: p.contact_person,
          department: p.department,
          extension: p.extension || undefined,
          validation: {
            raw: p.raw_phone,
            normalized: p.normalized_phone || p.raw_phone,
            type: p.phone_type,
            countryCode: p.country_code,
            isWhatsAppEligible: p.is_whatsapp_eligible,
            reason: p.notes || (p.is_whatsapp_eligible ? 'WhatsApp Eligible' : 'Excluded'),
            whatsappStatus: p.is_whatsapp_eligible ? 'whatsapp_unknown' : 'not_whatsapp',
          }
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

        const country = detectCountryInfo(key, c.country, c.city);
        const record: ContactPhoneRecord = {
          id: `${c.id}_${i}`,
          contact_id: c.id,
          company_name: c.company_name,
          contact_person: p.contactPerson || c.contact_person || null,
          department: p.department || (p.validation.isWhatsAppEligible ? 'Purchasing' : 'General Office'),
          raw_phone: p.raw,
          normalized_phone: p.validation.normalized || p.cleaned,
          country_code: country.code || '+62',
          country_name: country.name || 'Indonesia',
          country_flag: country.flag,
          phone_type: p.validation.type,
          is_whatsapp_eligible: p.validation.isWhatsAppEligible,
          is_primary: i === primaryIdx,
          consent_status: consentStatus,
          extension: p.extension || null,
          notes: p.validation.reason,
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
          is_eligible: record.is_whatsapp_eligible && consentStatus !== 'opted_out',
          exclusion_reason: record.is_whatsapp_eligible ? undefined : p.validation.reason,
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
          }
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

        // Classify whether same-company/sister group or cross-company
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
      total: contacts.length, // 521 companies
      totalCompanies: contacts.length,
      totalContacts: uniqueContactsCount,
      totalPhones: phoneRecords.length,
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
 * Detects country and dial code from raw phone number and customer metadata.
 */
export function detectCountryInfo(
  rawPhone?: string | null,
  countryHint?: string | null,
  cityHint?: string | null
): CountryInfo {
  const phone = (rawPhone || '').trim();
  const digits = phone.replace(/[^\d+]/g, '');
  const cHint = (countryHint || '').toLowerCase();
  const city = (cityHint || '').toLowerCase();

  if (digits.startsWith('+91') || digits.startsWith('91') && digits.length >= 12 || cHint.includes('india') || cHint.includes('bharat')) {
    return { name: 'India', code: '+91', flag: '🇮🇳' };
  }
  if (digits.startsWith('+86') || digits.startsWith('86') && digits.length >= 13 || cHint.includes('china')) {
    return { name: 'China', code: '+86', flag: '🇨🇳' };
  }
  if (digits.startsWith('+65') || cHint.includes('singapore')) {
    return { name: 'Singapore', code: '+65', flag: '🇸🇬' };
  }
  if (digits.startsWith('+60') || cHint.includes('malaysia')) {
    return { name: 'Malaysia', code: '+60', flag: '🇲🇾' };
  }
  if (digits.startsWith('+81') || cHint.includes('japan')) {
    return { name: 'Japan', code: '+81', flag: '🇯🇵' };
  }
  if (digits.startsWith('+82') || cHint.includes('korea')) {
    return { name: 'South Korea', code: '+82', flag: '🇰🇷' };
  }
  if (digits.startsWith('+49') || cHint.includes('germany') || cHint.includes('deutschland')) {
    return { name: 'Germany', code: '+49', flag: '🇩🇪' };
  }
  if (digits.startsWith('+44') || cHint.includes('united kingdom') || cHint.includes('uk')) {
    return { name: 'United Kingdom', code: '+44', flag: '🇬🇧' };
  }
  if (digits.startsWith('+1') || cHint.includes('usa') || cHint.includes('united states')) {
    return { name: 'United States', code: '+1', flag: '🇺🇸' };
  }
  if (digits.startsWith('+41') || cHint.includes('switzerland')) {
    return { name: 'Switzerland', code: '+41', flag: '🇨🇭' };
  }
  if (digits.startsWith('+33') || cHint.includes('france')) {
    return { name: 'France', code: '+33', flag: '🇫🇷' };
  }
  if (digits.startsWith('+39') || cHint.includes('italy')) {
    return { name: 'Italy', code: '+39', flag: '🇮🇹' };
  }
  if (digits.startsWith('+34') || cHint.includes('spain')) {
    return { name: 'Spain', code: '+34', flag: '🇪🇸' };
  }
  if (digits.startsWith('+61') || cHint.includes('australia')) {
    return { name: 'Australia', code: '+61', flag: '🇦🇺' };
  }

  // Indonesian default
  return { name: countryHint || 'Indonesia', code: '+62', flag: '🇮🇩' };
}

/**
 * Suggests a safe, cleaned mobile number formatting for unambiguous numbers.
 * Converts 08... to +628... and removes dashes/spaces.
 * Does NOT convert landlines (021, 022, etc.) to mobile.
 */
export function suggestCleanMobileNumber(raw: string): string {
  if (!raw) return '';
  const trimmed = raw.trim();

  // Handle multiple numbers separated by comma, slash, semicolon, or newline
  const parts = parsePhoneEntries(trimmed);
  if (parts.length > 1) {
    for (const part of parts) {
      if (part.validation.type === 'valid_mobile' || part.validation.type === 'international_number') {
        return part.validation.normalized;
      }
    }
  }

  // Strip trailing notes, e.g. " I", " (Hunting)", " ext 123", " hunting"
  let cleaned = trimmed
    .replace(/\s*\(hunting\)/i, '')
    .replace(/\s+hunting/i, '')
    .replace(/\s+ext\.?\s*\d+/i, '')
    .replace(/\s+[A-Za-z]$/, '')
    .trim();

  // Strip internal labels like "Telepon " or "Mobile " or "WA: "
  cleaned = cleaned.replace(/^(telepon|telp|phone|mobile|wa|hp|handphone)[\s.:]*/i, '').trim();

  // Check if standard validation already yields valid mobile
  const v = validatePhoneNumber(cleaned);
  if (v.type === 'valid_mobile' || v.type === 'international_number') {
    return v.normalized;
  }

  // If starts with 08 and has 10 to 14 digits total: 081234567890 -> +6281234567890
  const digitsOnly = cleaned.replace(/[^\d+]/g, '');
  if (digitsOnly.startsWith('08') && digitsOnly.length >= 10 && digitsOnly.length <= 14) {
    return `+62${digitsOnly.slice(1)}`;
  }

  // If starts with 628: 6281234567890 -> +6281234567890
  if (digitsOnly.startsWith('628') && digitsOnly.length >= 11 && digitsOnly.length <= 15) {
    return `+${digitsOnly}`;
  }

  // If starts with 8 and has 9 to 13 digits: 81234567890 -> +6281234567890
  if (digitsOnly.startsWith('8') && digitsOnly.length >= 9 && digitsOnly.length <= 13) {
    return `+62${digitsOnly}`;
  }

  return v.normalized || digitsOnly;
}

export interface DuplicateGroup {
  normalizedPhone: string;
  count: number;
  isSameCompanyGroup: boolean;
  groupType: 'same_company' | 'cross_company';
  companies: string[];
  contacts: VerifiedContactItem[];
}

/**
 * Groups duplicate contacts sharing identical phone numbers and classifies
 * whether they belong to the same enterprise group/sister companies or cross-customer accounts.
 */
export function groupDuplicates(items: VerifiedContactItem[]): DuplicateGroup[] {
  const groupsMap = new Map<string, VerifiedContactItem[]>();

  for (const item of items) {
    if (item.is_duplicate && item.validation.normalized) {
      const norm = item.validation.normalized;
      if (!groupsMap.has(norm)) {
        groupsMap.set(norm, []);
      }
      groupsMap.get(norm)!.push(item);
    }
  }

  const result: DuplicateGroup[] = [];

  for (const [norm, groupItems] of groupsMap.entries()) {
    const companies = Array.from(new Set(groupItems.map(i => i.company_name)));

    // Normalize company names to detect same-group sister companies (e.g. PT Surya Dermato vs PT Surya Dermato Medica)
    const cleanNames = companies.map(c =>
      c.toUpperCase()
        .replace(/\b(PT|PT\.|CV|CV\.|UD|UD\.|INC|LTD|TBK|PERSERO|LABORATORIES|INDUSTRI|INDUSTRY|PHARMACEUTICAL|PHARMA|FARMA|MEDICA|SKINCARE|HOLDING|GROUP)\b/g, '')
        .replace(/[()[\]-]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
    );
    const firstWordSet = new Set(cleanNames.map(n => n.split(' ').filter(w => w.length > 2)[0]));
    const isSameCompanyGroup = companies.length === 1 || firstWordSet.size === 1;

    result.push({
      normalizedPhone: norm,
      count: groupItems.length,
      isSameCompanyGroup,
      groupType: isSameCompanyGroup ? 'same_company' : 'cross_company',
      companies,
      contacts: groupItems,
    });
  }

  // Sort groups: cross-company duplicates first, then by count descending
  return result.sort((a, b) => {
    if (a.groupType !== b.groupType) {
      return a.groupType === 'cross_company' ? -1 : 1;
    }
    return b.count - a.count;
  });
}

export interface BulkNormalizationCandidate {
  contactId: string;
  companyName: string;
  contactPerson: string | null;
  currentRaw: string;
  proposedNormalized: string;
  currentType: PhoneNumberType;
  newType: PhoneNumberType;
  reason: string;
}

/**
 * Identifies contacts that qualify for safe, unambiguous bulk formatting normalization.
 * Strictly excludes landlines, missing numbers, and ambiguous short numbers.
 */
export function getBulkNormalizationCandidates(items: VerifiedContactItem[]): BulkNormalizationCandidate[] {
  const candidates: BulkNormalizationCandidate[] = [];

  for (const item of items) {
    const raw = item.raw_phone || '';
    if (!raw.trim()) continue;

    // Never bulk-normalize landlines
    if (item.validation.type === 'landline') continue;

    const suggested = suggestCleanMobileNumber(raw);
    if (!suggested) continue;

    // Must be at least 10 digits and at most 15 digits (excluding non-digits)
    const digitsOnly = suggested.replace(/[^\d]/g, '');
    if (digitsOnly.length < 10 || digitsOnly.length > 15) continue;

    const newValidation = validatePhoneNumber(suggested);
    // Only accept if proposed becomes a valid mobile or international mobile
    if (newValidation.type === 'valid_mobile' || newValidation.type === 'international_number') {
      if (suggested !== raw) {
        candidates.push({
          contactId: item.contact_id || item.id,
          companyName: item.company_name,
          contactPerson: item.contact_person,
          currentRaw: raw,
          proposedNormalized: suggested,
          currentType: item.validation.type,
          newType: newValidation.type,
          reason: `Normalize "${raw}" → "${suggested}" (${newValidation.reason})`,
        });
      }
    }
  }

  return candidates;
}
