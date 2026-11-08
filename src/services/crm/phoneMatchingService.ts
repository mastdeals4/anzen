// src/services/crm/phoneMatchingService.ts
//
// Automatic Customer and Contact Recognition for WhatsApp & Inbound Communications.
// Scans customers, crm_contacts, and crm_inquiries across phone, mobile, landline,
// and contact-person records.
// Strictly prevents silent false-positive attributions when a number is ambiguous.

import { supabase } from '../../lib/supabase';
import { normalizeE164 } from '../../utils/phoneValidation';

export interface PhoneMatchCandidate {
  customerId?: string | null;
  crmContactId?: string | null;
  companyName: string;
  contactPerson?: string | null;
  phone: string;
  normalizedE164?: string;
  isFullMatch?: boolean;
  email?: string | null;
  source: 'customers' | 'crm_contacts' | 'crm_contact_phones' | 'crm_inquiries';
  designation?: string | null;
}

export interface CustomerRecognitionResult {
  rawPhone: string;
  normalizedE164: string;
  matchType: 'exact_single' | 'ambiguous_multiple' | 'none';
  matchedCompany?: {
    id?: string | null;
    crmContactId?: string | null;
    companyName: string;
    contactPerson?: string | null;
    phone: string;
    email?: string | null;
    designation?: string | null;
  } | null;
  candidates: PhoneMatchCandidate[];
}

/**
 * Extracts normalized digits and significant suffix (last 8-9 digits)
 * for resilient Indonesian and international phone comparisons.
 */
export function extractPhoneMatchKeys(raw: string): { e164: string; suffix: string } {
  const e164 = normalizeE164(raw);
  const digits = raw.replace(/\D/g, '');
  const suffix = digits.length >= 7 ? digits.slice(-8) : digits;
  return { e164, suffix };
}

export class PhoneMatchingService {
  /**
   * Identifies customer/contact from an inbound or recognized WhatsApp phone number.
   * Checks customers, crm_contacts, and inquiries.
   */
  static async matchPhoneNumber(rawPhone: string): Promise<CustomerRecognitionResult> {
    if (!rawPhone || !rawPhone.trim()) {
      return {
        rawPhone: '',
        normalizedE164: '',
        matchType: 'none',
        candidates: [],
      };
    }

    const { e164, suffix } = extractPhoneMatchKeys(rawPhone);
    const inputDigits = rawPhone.replace(/\D/g, '');
    const candidateMap = new Map<string, PhoneMatchCandidate>();

    const evaluateFullMatch = (candPhone: string) => {
      if (!candPhone) return false;
      const candE164 = normalizeE164(candPhone);
      const candDigits = candPhone.replace(/\D/g, '');
      if (e164 && candE164 && e164 === candE164) return true;
      if (inputDigits && candDigits) {
        if (inputDigits === candDigits) return true;
        // Check for 08 vs +628 prefix variations
        if (inputDigits.length >= 9 && candDigits.length >= 9) {
          const inputSub = inputDigits.startsWith('62') ? inputDigits.slice(2) : inputDigits.startsWith('0') ? inputDigits.slice(1) : inputDigits;
          const candSub = candDigits.startsWith('62') ? candDigits.slice(2) : candDigits.startsWith('0') ? candDigits.slice(1) : candDigits;
          if (inputSub === candSub) return true;
        }
      }
      return false;
    };

    // 1. Search customers master
    if (suffix) {
      const { data: custRows } = await supabase
        .from('customers')
        .select('id, company_name, contact_person, phone, email')
        .ilike('phone', `%${suffix}%`)
        .limit(10);

      (custRows || []).forEach((c) => {
        const key = `cust-${c.id}`;
        if (!candidateMap.has(key)) {
          const candPhone = c.phone || rawPhone;
          candidateMap.set(key, {
            customerId: c.id,
            crmContactId: null,
            companyName: c.company_name,
            contactPerson: c.contact_person,
            phone: candPhone,
            normalizedE164: normalizeE164(candPhone),
            isFullMatch: evaluateFullMatch(candPhone),
            email: c.email,
            source: 'customers',
          });
        }
      });
    }

    // 2. Search crm_contacts (mobile, phone, landline, additional_contacts)
    if (suffix) {
      const { data: contactRows } = await supabase
        .from('crm_contacts')
        .select('id, company_name, contact_person, phone, mobile, landline, email, designation, additional_contacts')
        .or(`mobile.ilike.%${suffix}%,phone.ilike.%${suffix}%,landline.ilike.%${suffix}%`)
        .limit(10);

      (contactRows || []).forEach((ct) => {
        const key = `crm-${ct.id}`;
        if (!candidateMap.has(key)) {
          const candPhone = ct.mobile || ct.phone || rawPhone;
          candidateMap.set(key, {
            customerId: null,
            crmContactId: ct.id,
            companyName: ct.company_name,
            contactPerson: ct.contact_person,
            phone: candPhone,
            normalizedE164: normalizeE164(candPhone),
            isFullMatch: evaluateFullMatch(candPhone),
            email: ct.email,
            designation: ct.designation,
            source: 'crm_contacts',
          });
        }
      });
    }

    // 3. Search crm_contact_phones (multi-phone WhatsApp records)
    if (suffix) {
      const { data: phoneRows } = await supabase
        .from('crm_contact_phones')
        .select('id, contact_id, company_name, contact_person, department, raw_phone, normalized_phone')
        .or(`normalized_phone.ilike.%${suffix}%,raw_phone.ilike.%${suffix}%`)
        .limit(10);

      (phoneRows || []).forEach((pr) => {
        const key = `phone-${pr.id}`;
        if (!candidateMap.has(key)) {
          const candPhone = pr.normalized_phone || pr.raw_phone || rawPhone;
          candidateMap.set(key, {
            customerId: null,
            crmContactId: pr.contact_id,
            companyName: pr.company_name,
            contactPerson: pr.contact_person,
            phone: candPhone,
            normalizedE164: normalizeE164(candPhone),
            isFullMatch: evaluateFullMatch(candPhone),
            designation: pr.department,
            source: 'crm_contact_phones',
          });
        }
      });
    }

    // 4. Fallback search on crm_inquiries for direct operator-saved contact phone
    if (candidateMap.size === 0 && suffix) {
      const { data: inqRows } = await supabase
        .from('crm_inquiries')
        .select('customer_id, crm_contact_id, company_name, contact_person, contact_phone, contact_email')
        .ilike('contact_phone', `%${suffix}%`)
        .order('created_at', { ascending: false })
        .limit(5);

      (inqRows || []).forEach((inq) => {
        const normComp = inq.company_name?.trim();
        if (normComp) {
          const key = `inq-${normComp.toLowerCase()}`;
          if (!candidateMap.has(key)) {
            const candPhone = inq.contact_phone || rawPhone;
            candidateMap.set(key, {
              customerId: inq.customer_id || null,
              crmContactId: inq.crm_contact_id || null,
              companyName: inq.company_name,
              contactPerson: inq.contact_person,
              phone: candPhone,
              normalizedE164: normalizeE164(candPhone),
              isFullMatch: evaluateFullMatch(candPhone),
              email: inq.contact_email,
              source: 'crm_inquiries',
            });
          }
        }
      });
    }

    const candidates = Array.from(candidateMap.values());

    if (candidates.length === 0) {
      return {
        rawPhone,
        normalizedE164: e164,
        matchType: 'none',
        candidates: [],
      };
    }

    // Filter candidates that have an exact, full-number match
    const fullMatchCandidates = candidates.filter((c) => c.isFullMatch);

    // Group full match candidates by unique company
    const fullCompanyBuckets = new Map<string, PhoneMatchCandidate[]>();
    fullMatchCandidates.forEach((cand) => {
      const normName = cand.companyName
        .toLowerCase()
        .replace(/^pt\.?\s+/i, '')
        .replace(/^cv\.?\s+/i, '')
        .replace(/[^\w\s]/gi, '')
        .trim();
      const list = fullCompanyBuckets.get(normName) || [];
      list.push(cand);
      fullCompanyBuckets.set(normName, list);
    });

    // Exactly one unique company has a verified full normalized number match: safe to auto-link!
    if (fullCompanyBuckets.size === 1) {
      const [matchedCandidates] = Array.from(fullCompanyBuckets.values());
      const primary = matchedCandidates[0];
      return {
        rawPhone,
        normalizedE164: e164,
        matchType: 'exact_single',
        matchedCompany: {
          id: primary.customerId,
          crmContactId: primary.crmContactId,
          companyName: primary.companyName,
          contactPerson: primary.contactPerson,
          phone: primary.phone,
          email: primary.email,
          designation: primary.designation,
        },
        candidates,
      };
    }

    // Multiple companies match on full number, OR only partial suffix candidates exist
    // Never auto-link on suffix alone! Show disambiguation dialog so operator selects safely.
    return {
      rawPhone,
      normalizedE164: e164,
      matchType: 'ambiguous_multiple',
      matchedCompany: null,
      candidates,
    };
  }

  /**
   * Fetches inquiries belonging strictly to the recognized company.
   * Prevents leaking unrelated inquiries into this customer's conversation.
   */
  static async getCompanyInquiries(
    companyName: string,
    customerId?: string | null
  ): Promise<any[]> {
    if (!companyName && !customerId) return [];

    let query = supabase
      .from('crm_inquiries')
      .select(`
        id, inquiry_number, product_name, quantity, status, pipeline_status,
        company_name, customer_id, purchase_price, purchase_price_currency,
        offered_price, offered_price_currency, created_at, next_follow_up
      `)
      .order('created_at', { ascending: false })
      .limit(20);

    if (customerId) {
      query = query.eq('customer_id', customerId);
    } else {
      // Fuzzy search stripped name
      const cleanName = companyName
        .replace(/^pt\.?\s+/i, '')
        .replace(/^cv\.?\s+/i, '')
        .trim();
      query = query.ilike('company_name', `%${cleanName}%`);
    }

    const { data, error } = await query;
    if (error) {
      console.warn('[PhoneMatchingService] Error loading company inquiries:', error);
      return [];
    }
    return data || [];
  }

  /**
   * Pre-fills a new inquiry payload directly from a WhatsApp conversation.
   */
  static buildInquiryPrefill(
    rawPhone: string,
    matched?: {
      id?: string | null;
      crmContactId?: string | null;
      companyName?: string;
      contactPerson?: string | null;
      email?: string | null;
    } | null,
    initialMessageSnippet?: string
  ): Record<string, any> {
    return {
      company_name: matched?.companyName || '',
      customer_id: matched?.id || null,
      crm_contact_id: matched?.crmContactId || null,
      contact_person: matched?.contactPerson || '',
      contact_phone: matched ? matched.companyName ? rawPhone : '' : rawPhone,
      contact_email: matched?.email || '',
      product_name: '',
      quantity: '',
      remarks: initialMessageSnippet ? `Inquiry initiated via WhatsApp: "${initialMessageSnippet.slice(0, 200)}"` : 'Initiated via WhatsApp CRM',
      source_type: 'whatsapp',
      source_status: 'needs_sourcing',
    };
  }
}

