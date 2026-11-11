import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatPersonalizedWhatsAppMessage,
  validateMediaCaption,
  WHATSAPP_MEDIA_CAPTION_LIMIT,
} from '../src/utils/whatsappPersonalization.ts';
import fs from 'fs';
import path from 'path';

test('WhatsApp Business Composer — Attachment Popup, Single-Attachment Rule & Personalisation Suite', async (t) => {
  // -----------------------------------------------------------------
  // TEST 1: Dynamic Tag Personalisation for Normal Text & Media Captions
  // -----------------------------------------------------------------
  await t.test('1. Dynamic tag personalization engine independently resolves CRM fields with fallbacks', () => {
    const template =
      'Halo {{contact_person}},\n\nSalam dari PT Shubham Anzen Pharma Jaya. Kami ingin menawarkan ready stock {{product_name}} untuk {{company_name}} di {{city}}, {{country}}.\n\nHubungi: {{sales_representative}}.';

    // Recipient A (Complete data)
    const recipientA = {
      id: 'rec-1',
      contact_person: 'Ibu Siti Aminah',
      company_name: 'PT Kalbe Farma Tbk',
      city: 'Cikarang',
      country: 'Indonesia',
      designation: 'Procurement Specialist',
      sales_representative: 'Budi Santoso',
    };

    const resolvedA = formatPersonalizedWhatsAppMessage(template, recipientA, {
      productName: 'Paracetamol USP',
    });

    assert.ok(resolvedA.includes('Halo Ibu Siti Aminah'), 'Must resolve contact_person');
    assert.ok(resolvedA.includes('ready stock Paracetamol USP'), 'Must resolve product_name');
    assert.ok(resolvedA.includes('untuk PT Kalbe Farma Tbk'), 'Must resolve company_name');
    assert.ok(resolvedA.includes('di Cikarang, Indonesia'), 'Must resolve city and country');
    assert.ok(resolvedA.includes('Hubungi: Budi Santoso'), 'Must resolve sales_representative');
    assert.ok(!resolvedA.includes('{{'), 'Must not contain any unresolved {{tags}}');

    // Recipient B (Missing optional fields -> Sensible fallbacks)
    const recipientB = {
      id: 'rec-2',
      contact_person: null,
      company_name: '',
      city: null,
      country: null,
      sales_representative: null,
    };

    const resolvedB = formatPersonalizedWhatsAppMessage(template, recipientB, {
      productName: 'Pregabalin IP',
      defaultSalesRepresentative: 'Tim Sales SAPJ',
    });

    assert.ok(resolvedB.includes('Halo Bapak/Ibu'), 'Must fallback contact_person to Bapak/Ibu');
    assert.ok(resolvedB.includes('ready stock Pregabalin IP'), 'Must resolve product_name');
    assert.ok(resolvedB.includes('untuk Rekan Bisnis'), 'Must fallback company_name to Rekan Bisnis');
    assert.ok(resolvedB.includes('di Jakarta, Indonesia'), 'Must fallback city and country');
    assert.ok(resolvedB.includes('Hubungi: Tim Sales SAPJ'), 'Must fallback sales_representative');
    assert.ok(!resolvedB.includes('{{'), 'Must not contain any unresolved {{tags}}');

    // Verify isolation: Recipient A details never appear in Recipient B
    assert.ok(!resolvedB.includes('Ibu Siti Aminah'), 'Recipient B must not contain Recipient A contact name');
    assert.ok(!resolvedB.includes('PT Kalbe Farma Tbk'), 'Recipient B must not contain Recipient A company');
  });

  // -----------------------------------------------------------------
  // TEST 2: Single-Attachment Rule & Removal/Replacement Verification
  // -----------------------------------------------------------------
  await t.test('2. Single-attachment contract: allows exactly ONE photo or document, with replace and remove', () => {
    const modalPath = path.join(process.cwd(), 'src/components/crm/campaigns/WhatsAppAttachmentModal.tsx');
    assert.ok(fs.existsSync(modalPath), 'WhatsAppAttachmentModal.tsx must exist');
    const modalCode = fs.readFileSync(modalPath, 'utf8');

    // Tab A: Document Bank Selection (Single selection)
    assert.match(modalCode, /A\.\s*Select from Document Bank/i, 'Must provide Tab A: Select from Document Bank');
    assert.match(modalCode, /vw_universal_document_bank/i, 'Must query Central Document Bank view');
    assert.match(modalCode, /selectedBankDocId/i, 'Must track strictly ONE selectedBankDocId');

    // Tab B: Upload New File
    assert.match(modalCode, /B\.\s*Upload New File/i, 'Must provide Tab B: Upload New File');
    assert.match(modalCode, /accept="\.pdf,image\/jpeg,image\/png,image\/webp"/i, 'Must support PDF and images');

    // Workspace attachment display and single-attachment rule
    const wsPath = path.join(process.cwd(), 'src/components/crm/campaigns/CrmCampaignsWorkspace.tsx');
    const wsCode = fs.readFileSync(wsPath, 'utf8');

    assert.match(wsCode, /WhatsAppAttachmentModal/i, 'CrmCampaignsWorkspace must use WhatsAppAttachmentModal');
    assert.match(wsCode, /Attach Photo \/ Document/i, 'Must have clear action button');
    assert.match(wsCode, /Single Attachment active/i, 'Must enforce and show single attachment contract');
    assert.match(wsCode, /Replace/i, 'Must provide Replace button');
    assert.match(wsCode, /Remove Attachment|Remove/i, 'Must provide Remove Attachment action');
  });

  // -----------------------------------------------------------------
  // TEST 3: Caption Limit (1024 chars) and File Size Safeguards
  // -----------------------------------------------------------------
  await t.test('3. WhatsApp caption length validation: strictly checks 1024 char limit for media attachments', () => {
    assert.equal(WHATSAPP_MEDIA_CAPTION_LIMIT, 1024, 'Limit must be 1024');

    // Valid short caption
    const shortCaption = 'Halo Bapak Budi, ini adalah COA Paracetamol USP terbaru.';
    const validCheck = validateMediaCaption(shortCaption, true);
    assert.equal(validCheck.isValid, true, 'Short caption must be valid');
    assert.equal(validCheck.error, undefined);

    // Invalid long caption (> 1024 characters)
    const longCaption = 'A'.repeat(1025);
    const invalidCheck = validateMediaCaption(longCaption, true);
    assert.equal(invalidCheck.isValid, false, 'Caption > 1024 characters must be rejected');
    assert.match(invalidCheck.error || '', /1024 characters/i, 'Must give clear error warning');

    // Pure text message allows up to 4096 characters
    const longTextOnly = 'B'.repeat(2000);
    const textOnlyCheck = validateMediaCaption(longTextOnly, false);
    assert.equal(textOnlyCheck.isValid, true, 'Pure text messages can exceed 1024 chars up to 4096');
  });

  // -----------------------------------------------------------------
  // TEST 4: Dispatch Adapter & OpenWA Media Message Integration
  // -----------------------------------------------------------------
  await t.test('4. WhatsApp transport adapter sends media + caption in single message and prevents silent fallback', () => {
    const transportPath = path.join(process.cwd(), 'src/services/whatsapp/whatsappTransportService.ts');
    const transportCode = fs.readFileSync(transportPath, 'utf8');

    // Meta Cloud API passes caption with document or image
    assert.match(transportCode, /payload\.document\s*=\s*\{[\s\S]*caption:/i, 'Meta provider must pass caption with document');
    assert.match(transportCode, /payload\.image\s*=\s*\{[\s\S]*caption:/i, 'Meta provider must pass caption with image');

    // OpenWA Adapter passes caption and validates 1024 limit
    assert.match(transportCode, /CAPTION_TOO_LONG/i, 'Transport must enforce CAPTION_TOO_LONG error');
    assert.ok(
      !transportCode.includes('text ? `${text}\\n\\n${docHeader}${options.documentUrl}`'),
      'Must NOT contaminate caption text with documentUrl string'
    );

    // OpenWA Provider in services/whatsapp-adapter
    const openwaPath = path.join(process.cwd(), 'services/whatsapp-adapter/src/providers/OpenWAProvider.ts');
    const openwaCode = fs.readFileSync(openwaPath, 'utf8');

    assert.match(openwaCode, /uploadFile\(tempFilePath\)/i, 'OpenWA must upload file using Puppeteer');
    assert.match(openwaCode, /media-caption-input-container|Add a caption/i, 'OpenWA must input caption in media drawer');
    assert.match(openwaCode, /Failed to download attachment from storage/i, 'OpenWA must error if media download fails');
  });

  // -----------------------------------------------------------------
  // TEST 5: Live Customer Preview Updates with Recipient Switcher & Media Presentation
  // -----------------------------------------------------------------
  await t.test('5. Live Customer Preview renders photo/document styling and switches recipient personalization', () => {
    const wsPath = path.join(process.cwd(), 'src/components/crm/campaigns/CrmCampaignsWorkspace.tsx');
    const wsCode = fs.readFileSync(wsPath, 'utf8');

    // Preview renders WhatsApp style bubble with media
    assert.match(wsCode, /mediaCategory === 'image'/i, 'Preview must check for image media');
    assert.match(wsCode, /PREVIEW — NOT SENT/i, 'Preview badge present');

    // Personalization applied in preview
    assert.match(
      wsCode,
      /formatPersonalizedWhatsAppMessage\(waMessageTemplate,\s*r/i,
      'Preview must format personalized message with recipient data'
    );

    // Recipient switcher controls
    assert.match(wsCode, /setWaPreviewIndex/i, 'Must support cycling preview recipients');
  });
});
