import test from 'node:test';
import assert from 'node:assert/strict';
import { CampaignComplianceService } from '../src/services/crm/campaignComplianceService.ts';
import { WhatsAppTransportService } from '../src/services/whatsapp/whatsappTransportService.ts';
import { classifyCanonicalPhone } from '../src/services/crm/canonicalPhoneService.ts';
import { auditContactsMultiPhone } from '../src/utils/phoneValidation.ts';

test('WhatsApp Final Safety Correction & Live Readiness Suite', async (t) => {
  // -------------------------------------------------------------------------
  // TEST 1: Removal of Fabricated Consent Defaults (Missing Consent = NOT VERIFIED)
  // -------------------------------------------------------------------------
  await t.test('1. Candidate audience validation rejects unverified contacts without fabricated defaults', () => {
    // 3 contacts with valid phone numbers, but NO explicit persisted opt-in record
    const candidates = [
      {
        phone: '+6281234567890',
        companyName: 'PT Kimia Farma Partner',
        contactPerson: 'Budi Santoso',
        consent: null, // No persisted opt-in record
      },
      {
        phone: '+628111222333',
        companyName: 'PT Dexa Medica Partner',
        contactPerson: 'Siti Rahma',
        consent: null, // No persisted opt-in record
      },
    ];

    const result = CampaignComplianceService.validateAudience(candidates, {
      permittedCategory: 'price_alerts',
    });

    assert.equal(result.totalCandidates, 2, 'Must inspect both candidates');
    assert.equal(result.eligibleRecipients.length, 0, 'Eligible recipients must be 0 without verified opt-in records');
    assert.equal(result.excludedMissingConsent.length, 2, 'Both must be excluded under missing consent');
    assert.match(
      result.excludedMissingConsent[0].reason,
      /No verifiable opt-in consent record on file/,
      'Reason must clearly indicate missing opt-in record'
    );
  });

  // -------------------------------------------------------------------------
  // TEST 2: Genuine Persisted Consent vs Synthetic Consent
  // -------------------------------------------------------------------------
  await t.test('2. Only explicit persisted opt-in with category coverage becomes eligible', () => {
    const candidates = [
      {
        phone: '+6281234567890',
        companyName: 'PT Authorized Partner',
        contactPerson: 'Dr. Hendra',
        consent: {
          phone: '+6281234567890',
          companyName: 'PT Authorized Partner',
          optInSource: 'contract',
          optInTimestamp: '2026-05-10T10:00:00Z',
          permittedCategories: ['customer_service', 'price_alerts'],
          isOptedOut: false,
        },
      },
      {
        phone: '+628999888777',
        companyName: 'PT Customer Service Only',
        contactPerson: 'Rina',
        consent: {
          phone: '+628999888777',
          companyName: 'PT Customer Service Only',
          optInSource: 'inbound_whatsapp',
          optInTimestamp: '2026-06-01T10:00:00Z',
          permittedCategories: ['customer_service'], // Does NOT cover price_alerts
          isOptedOut: false,
        },
      },
    ];

    const result = CampaignComplianceService.validateAudience(candidates, {
      permittedCategory: 'price_alerts',
    });

    assert.equal(result.eligibleRecipients.length, 1, 'Only partner with price_alerts category must be eligible');
    assert.equal(result.eligibleRecipients[0].companyName, 'PT Authorized Partner');
    assert.equal(result.excludedMissingConsent.length, 1, 'Mismatched category must be excluded');
    assert.match(result.excludedMissingConsent[0].reason, /Consent does not cover requested category/);
  });

  // -------------------------------------------------------------------------
  // TEST 3: Separation of Operator Attestation from Customer Consent (6 Distinct Counts)
  // -------------------------------------------------------------------------
  await t.test('3. Verification matrix computes 6 distinct counts without operator conflation', () => {
    // Candidates simulating a mixed CRM dataset
    const rawRecipients = [
      { id: '1', mobile: '+6281234567890', company_name: 'Co A', consent_status: 'pending' },
      { id: '2', mobile: '+6281234567890', company_name: 'Co A (Duplicate)', consent_status: 'pending' }, // Duplicate
      { id: '3', mobile: '+628111222333', company_name: 'Co B', consent_status: 'opted_out', isOptedOut: true }, // Opted Out
      { id: '4', mobile: '0215551234', company_name: 'Co C', consent_status: 'pending' }, // Landline (non-mobile)
      { id: '5', mobile: '+628555666777', company_name: 'Co D', consent_status: 'opted_in', consent: { optInSource: 'explicit_form', permittedCategories: ['price_alerts'], isOptedOut: false } }, // Genuine opt-in
    ];

    const seenE164 = new Set();
    let validMobileCount = 0;
    let duplicateCount = 0;
    let optedOutCount = 0;
    let verifiedOptInCount = 0;
    let missingConsentCount = 0;

    for (const r of rawRecipients) {
      const canonical = classifyCanonicalPhone(r.mobile, { trustedRegion: 'ID' });
      const isValidMobile = canonical.isValid && canonical.phoneType === 'mobile';
      if (isValidMobile) validMobileCount++;

      if (canonical.e164) {
        if (seenE164.has(canonical.e164)) {
          duplicateCount++;
          continue;
        }
        seenE164.add(canonical.e164);
      }

      if (r.isOptedOut || r.consent_status === 'opted_out') {
        optedOutCount++;
        continue;
      }

      if (r.consent_status === 'opted_in' && r.consent?.optInSource) {
        verifiedOptInCount++;
      } else if (isValidMobile) {
        missingConsentCount++;
      }
    }

    assert.equal(validMobileCount, 4, '4 recipients have mobile formatting');
    assert.equal(duplicateCount, 1, 'Exactly 1 duplicate number detected and suppressed');
    assert.equal(optedOutCount, 1, 'Exactly 1 opted-out contact');
    assert.equal(verifiedOptInCount, 1, 'Exactly 1 verified opt-in record');
    assert.equal(missingConsentCount, 1, 'Exactly 1 mobile with missing consent (pending)');
  });

  // -------------------------------------------------------------------------
  // TEST 4: Hard Bulk Safety Lock (UI & Execution Block)
  // -------------------------------------------------------------------------
  await t.test('4. Bulk campaign dispatch is blocked at execution function level', async () => {
    // Calling WhatsAppTransportService directly with isBulk: true or isCampaign: true must reject
    const res = await WhatsAppTransportService.sendMessage({
      to: '+6281234567890',
      text: 'Bulk marketing message',
      isCampaign: true,
      isBulk: true,
    });

    assert.equal(res.success, false, 'Must fail bulk dispatch');
    assert.equal(res.errorCode, 'BULK_DISPATCH_LOCKED', 'Must return BULK_DISPATCH_LOCKED');
    assert.match(res.error, /Bulk WhatsApp dispatch is blocked/, 'Error message must state bulk lock');
  });

  // -------------------------------------------------------------------------
  // TEST 5: OpenWA Adapter Health & Authenticated Session
  // -------------------------------------------------------------------------
  await t.test('5. OpenWA adapter is live, responsive, and reports connected session', async () => {
    WhatsAppTransportService.setConfig({
      providerType: 'openwa_adapter',
      adapterUrl: 'http://127.0.0.1:3100',
    });
    const health = await WhatsAppTransportService.checkHealth();
    assert.ok(health, 'Health response must exist');
    assert.equal(health.provider, 'openwa_adapter');
    assert.equal(health.status, 'connected', 'Adapter must be connected to WhatsApp session');
    assert.ok(health.businessPhone, 'Business phone must be detected from active session');
    assert.equal(health.businessPhone, '+6285888600999', 'Verified active session is +6285888600999');
  });
});
