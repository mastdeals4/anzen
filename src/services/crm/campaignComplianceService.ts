// src/services/crm/campaignComplianceService.ts
//
// Meta Business Messaging Policy & Compliance Gate for WhatsApp Campaigns.
// Strictly enforces recipient opt-in consent, opt-out suppression, approved templates,
// and pharmaceutical B2B marketing restrictions.

import { classifyCanonicalPhone } from './canonicalPhoneService.ts';

export interface RecipientConsentRecord {
  id?: string;
  phone: string;
  companyName: string;
  contactPerson?: string | null;
  optInSource?: 'web_inquiry' | 'inbound_whatsapp' | 'contract' | 'explicit_form';
  optInTimestamp?: string;
  permittedCategories: Array<'customer_service' | 'price_alerts' | 'regulatory_updates'>;
  isOptedOut: boolean;
  optedOutAt?: string | null;
  notes?: string;
}

export interface MetaTemplateDefinition {
  name: string;
  category: 'MARKETING' | 'UTILITY' | 'AUTHENTICATION';
  language: string;
  status: 'APPROVED' | 'PENDING' | 'REJECTED';
  body: string;
  headerType?: 'TEXT' | 'DOCUMENT' | 'IMAGE' | 'NONE';
  components?: any[];
  pharmaComplianceApproved: boolean;
}

export interface CampaignAudienceFilter {
  companyType?: string;
  tags?: string[];
  hasActiveInquiriesOnly?: boolean;
  permittedCategory: 'customer_service' | 'price_alerts' | 'regulatory_updates';
}

export interface AudienceValidationResult {
  totalCandidates: number;
  eligibleRecipients: RecipientConsentRecord[];
  suppressedOptOuts: RecipientConsentRecord[];
  excludedMissingConsent: Array<{ phone: string; companyName: string; reason: string }>;
  isCompliant: boolean;
  complianceWarning?: string;
}

export class CampaignComplianceService {
  // Global suppression list of phone numbers that opted out (STOP, UNSUBSCRIBE, BATAL)
  private static suppressionSet = new Set<string>();

  static registerOptOut(rawPhone: string): void {
    const digits = rawPhone.replace(/\D/g, '');
    if (digits) {
      this.suppressionSet.add(digits);
      if (digits.length >= 8) {
        this.suppressionSet.add(digits.slice(-8));
      }
    }
  }

  static isOptedOut(rawPhone: string): boolean {
    const digits = rawPhone.replace(/\D/g, '');
    if (!digits) return false;
    if (this.suppressionSet.has(digits)) return true;
    if (digits.length >= 8 && this.suppressionSet.has(digits.slice(-8))) return true;
    return false;
  }

  /**
   * Pre-approved Meta Message Templates for SAPJ ERP communications.
   */
  static getApprovedTemplates(): MetaTemplateDefinition[] {
    return [
      {
        name: 'sapj_product_price_update',
        category: 'UTILITY',
        language: 'id',
        status: 'APPROVED',
        body: 'Halo {{1}}, berikut pembaruan harga penawaran resmi untuk produk {{2}} dari PT Shubham Anzen Pharma Jaya. Silakan hubungi kami untuk informasi lebih lanjut.',
        headerType: 'DOCUMENT',
        pharmaComplianceApproved: true,
      },
      {
        name: 'sapj_technical_document_notification',
        category: 'UTILITY',
        language: 'id',
        status: 'APPROVED',
        body: 'Halo {{1}}, dokumen teknis (COA/Spesifikasi) yang Anda minta untuk produk {{2}} batch {{3}} telah siap dan kami lampirkan di pesan ini.',
        headerType: 'DOCUMENT',
        pharmaComplianceApproved: true,
      },
      {
        name: 'sapj_inquiry_followup_check',
        category: 'UTILITY',
        language: 'id',
        status: 'APPROVED',
        body: 'Halo {{1}}, menindaklanjuti permintaan penawaran nomor {{2}} untuk {{3}}, apakah ada hal teknis atau komersial yang dapat kami bantu?',
        headerType: 'NONE',
        pharmaComplianceApproved: true,
      },
      {
        name: 'sapj_general_announcement_restricted',
        category: 'MARKETING',
        language: 'id',
        status: 'PENDING',
        body: 'Pemberitahuan operasional PT Shubham Anzen Pharma Jaya.',
        headerType: 'NONE',
        pharmaComplianceApproved: false, // Gated pending written Meta policy approval for pharma raw materials
      },
    ];
  }

  /**
   * Filters candidate recipients against opt-in consent and suppression lists.
   */
  static validateAudience(
    candidates: Array<{
      phone: string;
      companyName: string;
      contactPerson?: string | null;
      consent?: RecipientConsentRecord | null;
      trustedRegion?: string | null;
    }>,
    filter: CampaignAudienceFilter,
    options?: { trustedRegion?: string | null }
  ): AudienceValidationResult {
    const eligibleRecipients: RecipientConsentRecord[] = [];
    const suppressedOptOuts: RecipientConsentRecord[] = [];
    const excludedMissingConsent: Array<{ phone: string; companyName: string; reason: string }> = [];
    const seenE164 = new Set<string>();

    // First detect any cross-company duplicate conflicts
    const phoneToCompanies = new Map<string, Set<string>>();
    for (const cand of candidates) {
      const trusted = cand.trustedRegion !== undefined ? cand.trustedRegion : options?.trustedRegion;
      const canonical = classifyCanonicalPhone(cand.phone, { trustedRegion: trusted });
      if (canonical.e164) {
        if (!phoneToCompanies.has(canonical.e164)) {
          phoneToCompanies.set(canonical.e164, new Set());
        }
        phoneToCompanies.get(canonical.e164)!.add(cand.companyName);
      }
    }

    for (const cand of candidates) {
      const trusted = cand.trustedRegion !== undefined ? cand.trustedRegion : options?.trustedRegion;
      const canonical = classifyCanonicalPhone(cand.phone, { trustedRegion: trusted });

      if (!canonical.isValid || !canonical.e164) {
        excludedMissingConsent.push({
          phone: cand.phone || '',
          companyName: cand.companyName,
          reason: `Invalid telephone number: ${canonical.validationReason}`,
        });
        continue;
      }

      if (canonical.phoneType !== 'mobile') {
        excludedMissingConsent.push({
          phone: cand.phone || '',
          companyName: cand.companyName,
          reason: `Excluded non-mobile number (${canonical.phoneType}): cannot receive WhatsApp mobile broadcasts`,
        });
        continue;
      }

      // Check cross-company ambiguity
      const comps = phoneToCompanies.get(canonical.e164);
      if (comps && comps.size > 1) {
        excludedMissingConsent.push({
          phone: cand.phone,
          companyName: cand.companyName,
          reason: `Ambiguous company association: number shared across ${comps.size} distinct customer companies (${Array.from(comps).join(', ')})`,
        });
        continue;
      }

      // Deduplicate on unique normalized E.164 (max 1 recipient per number)
      if (seenE164.has(canonical.e164)) {
        excludedMissingConsent.push({
          phone: cand.phone,
          companyName: cand.companyName,
          reason: `Duplicate recipient suppressed: E.164 ${canonical.e164} already selected once in this campaign`,
        });
        continue;
      }

      // Check opt-out suppression
      if (this.isOptedOut(cand.phone) || cand.consent?.isOptedOut) {
        suppressedOptOuts.push({
          phone: cand.phone,
          companyName: cand.companyName,
          contactPerson: cand.contactPerson,
          optInSource: cand.consent?.optInSource,
          optInTimestamp: cand.consent?.optInTimestamp,
          permittedCategories: cand.consent?.permittedCategories || [],
          isOptedOut: true,
          optedOutAt: cand.consent?.optedOutAt || new Date().toISOString(),
        });
        continue;
      }

      // Check explicit recorded individual consent
      if (!cand.consent) {
        excludedMissingConsent.push({
          phone: cand.phone,
          companyName: cand.companyName,
          reason: 'No verifiable opt-in consent record on file (unknown individual consent)',
        });
        continue;
      }

      if (!cand.consent.permittedCategories.includes(filter.permittedCategory)) {
        excludedMissingConsent.push({
          phone: cand.phone,
          companyName: cand.companyName,
          reason: `Consent does not cover requested category '${filter.permittedCategory}'`,
        });
        continue;
      }

      seenE164.add(canonical.e164);
      eligibleRecipients.push(cand.consent);
    }

    // Pharmaceutical Policy Warning
    let complianceWarning: string | undefined;
    if (filter.permittedCategory === 'price_alerts') {
      complianceWarning =
        'Meta Business Messaging Policy Advisory: API / excipients pricing updates are restricted to confirmed B2B customers with explicit commercial opt-in. Unsolicited outreach is prohibited.';
    }

    return {
      totalCandidates: candidates.length,
      eligibleRecipients,
      suppressedOptOuts,
      excludedMissingConsent,
      isCompliant: eligibleRecipients.length > 0 && excludedMissingConsent.length === 0,
      complianceWarning,
    };
  }

  /**
   * Checks if an inbound WhatsApp message from a customer constitutes an opt-out.
   */
  static detectOptOutTrigger(messageText: string): boolean {
    if (!messageText) return false;
    const lower = messageText.trim().toLowerCase();
    const optOutPhrases = [
      'stop',
      'unsubscribe',
      'berhenti',
      'batal',
      'jangan kirim lagi',
      'hapus nomor saya',
      'opt out',
      'optout',
    ];
    return optOutPhrases.some((phrase) => lower === phrase || lower.startsWith(`${phrase} `));
  }

  /**
   * Checks whether the conversation is within Meta's 24-hour customer service window.
   */
  static check24HourCustomerWindow(lastInboundTimestamp?: string | null): {
    withinWindow: boolean;
    hoursRemaining: number;
  } {
    if (!lastInboundTimestamp) {
      return { withinWindow: false, hoursRemaining: 0 };
    }
    const elapsedMs = Date.now() - new Date(lastInboundTimestamp).getTime();
    const windowMs = 24 * 3600 * 1000;
    if (elapsedMs < windowMs) {
      const hoursRemaining = Math.max(0, Math.round((windowMs - elapsedMs) / 3600000));
      return { withinWindow: true, hoursRemaining };
    }
    return { withinWindow: false, hoursRemaining: 0 };
  }
}
