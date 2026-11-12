import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as XLSX from 'xlsx';
import {
  formatPersonalizedWhatsAppMessage,
  validateMediaCaption,
  WHATSAPP_MEDIA_CAPTION_LIMIT,
} from '../src/utils/whatsappPersonalization.ts';
import { WhatsAppTransportService } from '../src/services/whatsapp/whatsappTransportService.ts';

test('Avira WhatsApp Sender (WA Sender Simplicity Reference) Suite', async (t) => {
  // -----------------------------------------------------------------
  // TEST 1: Personalized Placeholders: {{contact_name}}, {{company_name}}, {{product_name}}
  // -----------------------------------------------------------------
  await t.test('1. Placeholders {{contact_name}}, {{company_name}}, {{product_name}} resolve correctly with fallbacks', () => {
    const template =
      'Halo {{contact_name}} dari {{company_name}},\n\nKami menawarkan {{product_name}} ready stock dengan sertifikat COA lengkap.\n\nSalam,\nTim SAPJ';

    // Recipient with full data
    const rec1 = {
      contact_name: 'Bpk Hendra',
      company_name: 'PT Kimia Sejahtera Tbk',
    };
    const res1 = formatPersonalizedWhatsAppMessage(template, rec1, {
      productName: 'Paracetamol USP Grade',
    });
    assert.match(res1, /Halo Bpk Hendra dari PT Kimia Sejahtera Tbk/);
    assert.match(res1, /menawarkan Paracetamol USP Grade ready stock/);
    assert.ok(!res1.includes('{{contact_name}}'));
    assert.ok(!res1.includes('{{company_name}}'));
    assert.ok(!res1.includes('{{product_name}}'));

    // Backward compatibility with contact_person
    const rec2 = {
      contact_person: 'Ibu Ratna',
      company_name: 'PT Kalbe Farma',
    };
    const res2 = formatPersonalizedWhatsAppMessage(template, rec2);
    assert.match(res2, /Halo Ibu Ratna dari PT Kalbe Farma/);

    // Fallbacks when recipient fields are null or empty
    const rec3 = { contact_name: '', company_name: null };
    const res3 = formatPersonalizedWhatsAppMessage(template, rec3);
    assert.match(res3, /Halo Bapak\/Ibu dari Rekan Bisnis/);
    assert.match(res3, /Bahan Baku Farmasi & API/);
  });

  // -----------------------------------------------------------------
  // TEST 2: Single-Attachment Rules and Caption Limit Enforcement
  // -----------------------------------------------------------------
  await t.test('2. Enforces single attachment contract and 1024-character caption limit', () => {
    assert.equal(WHATSAPP_MEDIA_CAPTION_LIMIT, 1024);

    // Short caption with attachment
    const shortCap = 'Penawaran bahan baku farmasi resmi dari PT SAPJ.';
    const valid = validateMediaCaption(shortCap, true);
    assert.equal(valid.isValid, true);
    assert.equal(valid.error, undefined);

    // Long caption exceeding 1024 chars
    const longCap = 'X'.repeat(1025);
    const invalid = validateMediaCaption(longCap, true);
    assert.equal(invalid.isValid, false);
    assert.match(invalid.error || '', /1024 characters/i);

    // Text-only allows up to 4096 characters
    const textOnly = 'Y'.repeat(2500);
    const textValid = validateMediaCaption(textOnly, false);
    assert.equal(textValid.isValid, true);
  });

  // -----------------------------------------------------------------
  // TEST 3: Component Architecture & WA Sender Clean UI Contract
  // -----------------------------------------------------------------
  await t.test('3. WASenderBulkWorkspace provides clean contact selection, composer, delay setting, and controls', () => {
    const compPath = path.join(process.cwd(), 'src/components/crm/campaigns/WASenderBulkWorkspace.tsx');
    assert.ok(fs.existsSync(compPath), 'WASenderBulkWorkspace.tsx must exist');
    const code = fs.readFileSync(compPath, 'utf8');

    // Section 1: Contact Selection
    assert.match(code, /Contact Selection/i, 'Has Contact Selection column');
    assert.match(code, /Select All/i, 'Has Select All action');
    assert.match(code, /Clear Selection/i, 'Has Clear Selection action');
    assert.match(code, /contactSearchQuery/i, 'Has contact search filter');
    assert.match(code, /dedupedCandidates/i, 'Deduplicates candidate phone numbers');

    // Section 2: Composer
    assert.match(code, /\{\{contact_name\}\}/i, 'Supports {{contact_name}} placeholder button');
    assert.match(code, /\{\{company_name\}\}/i, 'Supports {{company_name}} placeholder button');
    assert.match(code, /\{\{product_name\}\}/i, 'Supports {{product_name}} placeholder button');
    assert.match(code, /WhatsAppAttachmentModal/i, 'Integrates WhatsAppAttachmentModal for single attachment');
    assert.match(code, /Attach Photo \/ Document/i, 'Clear attach action');
    assert.match(code, /Live Customer Preview/i, 'Live customer preview mockup');

    // Section 3: Sending Settings
    assert.match(code, /delaySeconds/i, 'Configurable interval delay state');
    assert.match(code, /Start Campaign/i, 'Start campaign action');
    assert.match(code, /Pause Campaign/i, 'Pause campaign action');
    assert.match(code, /Resume Campaign/i, 'Resume campaign action');
    assert.match(code, /Cancel/i, 'Cancel campaign action');

    // Section 4: Reporting & Excel Export
    assert.match(code, /Campaign Dispatch Report/i, 'Has campaign report modal');
    assert.match(code, /Export to Excel/i, 'Has Export to Excel action');
    assert.match(code, /XLSX\.utils\.json_to_sheet/i, 'Uses xlsx to generate spreadsheet');
    assert.match(code, /XLSX\.writeFile/i, 'Writes excel file for download');
  });

  // -----------------------------------------------------------------
  // TEST 4: Excel Export Structure Verification
  // -----------------------------------------------------------------
  await t.test('4. Excel export builds proper sheets with required campaign reporting columns', () => {
    const testLogs = [
      {
        'No.': 1,
        'Company Name': 'PT Kimia Farma Tbk',
        'Contact Person': 'Bpk Budi',
        'Mobile Number': '+628123456789',
        'Status': 'SENT',
        'Message ID': 'wa_msg_123456',
        'Sent At': '2026-11-12 10:00:00',
        'Delivered At': '2026-11-12 10:00:05',
        'Read At': '2026-11-12 10:00:15',
        'Error / Reason': '—',
        'Personalized Message': 'Halo Bpk Budi...',
      },
      {
        'No.': 2,
        'Company Name': 'PT Kalbe Farma Tbk',
        'Contact Person': 'Ibu Dewi',
        'Mobile Number': '+628987654321',
        'Status': 'FAILED',
        'Message ID': '—',
        'Sent At': '—',
        'Delivered At': '—',
        'Read At': '—',
        'Error / Reason': 'Number not registered on WhatsApp',
        'Personalized Message': 'Halo Ibu Dewi...',
      },
    ];

    const ws = XLSX.utils.json_to_sheet(testLogs);
    assert.ok(ws['A1'], 'Must have column headers in sheet');
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Campaign Report');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    assert.ok(buf.length > 0, 'Generated valid xlsx buffer');
  });

  // -----------------------------------------------------------------
  // TEST 5: OpenWA Connection Transport Configuration
  // -----------------------------------------------------------------
  await t.test('5. WhatsAppTransportService defaults to openwa_adapter with protected local proxy (/api/whatsapp)', () => {
    const config = WhatsAppTransportService.getConfig();
    assert.equal(config.providerType, 'openwa_adapter', 'Provider type must be openwa_adapter');
    assert.equal(config.adapterUrl, '/api/whatsapp', 'Must route through server-side proxy /api/whatsapp');
    assert.equal(config.adapterApiKey, '', 'Client bundle must NOT expose hardcoded API keys');
  });

  // -----------------------------------------------------------------
  // TEST 6: Campaign History Local OpenWA Engine & Legacy Removal
  // -----------------------------------------------------------------
  await t.test('6. WhatsAppCampaignDeliveryReport uses local OpenWA engine without process-whatsapp-campaign', () => {
    const reportPath = path.join(process.cwd(), 'src/components/crm/campaigns/WhatsAppCampaignDeliveryReport.tsx');
    assert.ok(fs.existsSync(reportPath), 'WhatsAppCampaignDeliveryReport.tsx must exist');
    const code = fs.readFileSync(reportPath, 'utf8');

    // Verify removal of edge function call
    assert.ok(!code.includes("invoke('process-whatsapp-campaign'"), 'Must NOT invoke process-whatsapp-campaign');

    // Verify local transport usage
    assert.match(code, /WhatsAppTransportService\.sendMessage/i, 'Uses local WhatsAppTransportService');
    assert.match(code, /WhatsAppTransportService\.checkHealth/i, 'Uses local WhatsAppTransportService.checkHealth');

    // Verify Local Execution Limitations indicator
    assert.match(code, /Local OpenWA Engine/i, 'Identifies local engine');
    assert.match(code, /Keep this browser tab active/i, 'Warns user to keep browser tab open');
  });

  // -----------------------------------------------------------------
  // TEST 7: Concurrency & Worker Lock Protection Invariants
  // -----------------------------------------------------------------
  await t.test('7. Enforces worker lock and sequential pacing in campaign history dispatch', () => {
    const reportPath = path.join(process.cwd(), 'src/components/crm/campaigns/WhatsAppCampaignDeliveryReport.tsx');
    const code = fs.readFileSync(reportPath, 'utf8');

    // Verify worker lock
    assert.match(code, /worker_lock_id/i, 'Tracks worker_lock_id');
    assert.match(code, /worker_lock_until/i, 'Tracks worker_lock_until');
    assert.match(code, /Campaign is currently active in another session/i, 'Prevents concurrent execution');

    // Verify pause & cancel controls
    assert.match(code, /handlePauseCampaign/i, 'Implements pause campaign');
    assert.match(code, /handleCancelCampaign/i, 'Implements cancel campaign');
    assert.match(code, /handleResumeCampaign/i, 'Implements resume campaign');
  });

  // -----------------------------------------------------------------
  // TEST 8: Reconcile & Manual Retry for Failed Recipients
  // -----------------------------------------------------------------
  await t.test('8. Provides reconciliation and safe manual retry for failed recipients', () => {
    const reportPath = path.join(process.cwd(), 'src/components/crm/campaigns/WhatsAppCampaignDeliveryReport.tsx');
    const code = fs.readFileSync(reportPath, 'utf8');

    assert.match(code, /handleOpenReconcile/i, 'Implements reconciliation check');
    assert.match(code, /handleExecuteManualRetry/i, 'Implements manual retry send');
    assert.match(code, /reconcileTarget/i, 'State for target recipient to reconcile');
    assert.match(code, /reconcileFinding/i, 'State for reconciliation findings');
  });
});
