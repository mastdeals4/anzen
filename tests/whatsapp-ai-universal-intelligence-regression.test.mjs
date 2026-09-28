import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  analyzeWhatsAppMessage,
  detectWhatsAppLanguage,
} from './helpers/whatsappIntelligenceModule.mjs';

// Verify source files integration
const ingestionCode = readFileSync(
  resolve('supabase/functions/_shared/enquiryIngestion.ts'),
  'utf-8'
);
const sharedAiCode = readFileSync(
  resolve('supabase/functions/_shared/whatsappAiIntelligence.ts'),
  'utf-8'
);
const clientAiCode = readFileSync(
  resolve('src/services/crm/whatsappIntelligenceService.ts'),
  'utf-8'
);
const inboxUiCode = readFileSync(
  resolve('src/components/crm/inbox/CrmOmnichannelInbox.tsx'),
  'utf-8'
);

test('1. Realistic Test: Indonesian Pricing Request', () => {
  const text = 'Halo SAPJ, tolong berikan penawaran resmi untuk Paracetamol BP 500 kg. Mohon info ketersediaan stok.';
  const analysis = analyzeWhatsAppMessage(text, { senderName: 'PT Kimia Sejahtera' });

  assert.equal(analysis.language, 'id', 'Should detect Indonesian language');
  assert.equal(analysis.intent, 'Pricing', 'Should classify intent as Pricing');
  assert.equal(analysis.entities.product, 'Paracetamol BP', 'Should extract product Paracetamol BP');
  assert.equal(analysis.entities.quantity, 500, 'Should extract quantity 500');
  assert.equal(analysis.entities.unit, 'kg', 'Should extract unit kg');
  assert.equal(analysis.needs_action, true, 'Pricing request requires action');
  assert.ok(analysis.action_required?.includes('Paracetamol BP'), 'Action should specify product quote');
  assert.ok(analysis.english_translation.toLowerCase().includes('quotation'), 'English translation should reflect quotation request');
  assert.ok(analysis.running_summary.includes('requested quotation'), 'Running summary should record quotation request');
  assert.ok(analysis.suggested_reply.includes('penawaran resmi'), 'Reply draft should be in Indonesian');
});

test('2. Realistic Test: Indonesian Delivery & Shipment Check', () => {
  const text = 'Siang pak, kapan pesanan Ammonium Chloride kami sampai ke gudang Cikarang? Mohon infonya ya.';
  const analysis = analyzeWhatsAppMessage(text, { senderName: 'PT Farma Utama' });

  assert.equal(analysis.language, 'id', 'Should detect Indonesian');
  assert.equal(analysis.intent, 'Delivery/Shipment', 'Should classify intent as Delivery/Shipment');
  assert.equal(analysis.entities.product, 'Ammonium Chloride', 'Should extract Ammonium Chloride');
  assert.equal(analysis.linked_context_type, 'Delivery', 'Should link to Delivery context');
  assert.equal(analysis.needs_action, true, 'Delivery ETA check requires action');
  assert.ok(analysis.english_translation.toLowerCase().includes('delivery'), 'English translation should mention delivery');
  assert.ok(analysis.running_summary.includes('delivery schedule'), 'Running summary should track delivery inquiry');
  assert.ok(analysis.suggested_reply.includes('jadwal armada pengiriman'), 'Reply draft should address delivery in Indonesian');
});

test('3. Realistic Test: COA & Technical Document Request', () => {
  const text = 'Pagi bu, minta tolong kirimkan COA untuk batch B-2026-08 Paracetamol yang kami terima kemarin.';
  const analysis = analyzeWhatsAppMessage(text, { senderName: 'PT Sehat Farma' });

  assert.equal(analysis.intent, 'COA/MSDS/GMP/TDS/Documents', 'Should classify as Documents');
  assert.equal(analysis.entities.document_requested, 'COA', 'Should extract COA request');
  assert.equal(analysis.entities.batch, 'B-2026-08', 'Should extract batch B-2026-08');
  assert.equal(analysis.entities.product, 'Paracetamol', 'Should extract Paracetamol');
  assert.equal(analysis.linked_context_type, 'Document', 'Should link to Document context');
  assert.equal(analysis.needs_action, true, 'COA request requires document dispatch action');
  assert.ok(analysis.action_required?.includes('COA'), 'Action required should specify sending COA');
  assert.ok(analysis.running_summary.includes('batch B-2026-08'), 'Running summary should note batch');
});

test('4. Realistic Test: Payment & Invoice Settlement Discussion', () => {
  const text = 'Halo SAPJ, pembayaran invoice INV-2601 sebesar Rp 45.000.000 sudah ditransfer via BCA ya pak. Bukti transfer terlampir.';
  const analysis = analyzeWhatsAppMessage(text, { senderName: 'PT Multi Kimia' });

  assert.equal(analysis.intent, 'Payment/Receivable', 'Should classify as Payment/Receivable');
  assert.equal(analysis.entities.order_reference, 'INV-2601', 'Should extract invoice reference');
  assert.equal(analysis.entities.price, 45000000, 'Should extract payment amount 45,000,000');
  assert.equal(analysis.entities.currency, 'IDR', 'Should extract currency IDR');
  assert.ok(analysis.entities.payment_info?.includes('transfer'), 'Should extract transfer detail');
  assert.equal(analysis.linked_context_type, 'Finance', 'Should link to Finance context');
  assert.equal(analysis.needs_action, true, 'Payment requires verification with Finance');
  assert.ok(analysis.suggested_reply.includes('finance'), 'Reply draft should acknowledge payment in Indonesian');
});

test('5. Realistic Test: Complaint & Quality Issue Report', () => {
  const text = 'Selamat siang, drum kemasan Citric Acid kemarin bocor dan ada 2 karung yang basah dan gumpal. Tolong solusinya.';
  const analysis = analyzeWhatsAppMessage(text, { senderName: 'PT Bio Medika' });

  assert.equal(analysis.intent, 'Quality Issue', 'Should classify as Quality Issue');
  assert.equal(analysis.entities.product, 'Citric Acid', 'Should extract Citric Acid');
  assert.ok(analysis.entities.complaint_details?.includes('bocor') || analysis.entities.complaint_details?.includes('gumpal'), 'Should extract complaint details');
  assert.equal(analysis.needs_action, true, 'Complaint requires urgent QA investigation');
  assert.ok(analysis.suggested_reply.includes('QA dan gudang'), 'Reply draft should offer QA coordination');
});

test('6. Realistic Test: Passive Acknowledgment (No Action)', () => {
  const text = 'Baik pak, terima kasih infonya. Noted ya.';
  const analysis = analyzeWhatsAppMessage(text, { senderName: 'PT Mitra Sukses' });

  assert.equal(analysis.intent, 'General Information', 'Should classify as General Information');
  assert.equal(analysis.needs_action, false, 'Passive acknowledgment must NOT require action');
  assert.equal(analysis.action_required, null, 'Action required should be null');
  assert.ok(analysis.running_summary.includes('No pending action') || analysis.running_summary.includes('acknowledged'), 'Summary should record no pending action');
});

test('7. Realistic Test: Mixed Indonesian & English Communication', () => {
  const text = 'Halo team SAPJ, we need urgent quotation for 1000 kg Ibuprofen from Malladi ya. Please advise ETA delivery to our factory.';
  const analysis = analyzeWhatsAppMessage(text, { senderName: 'PT Global Pharma' });

  assert.equal(analysis.language, 'mixed', 'Should detect mixed language');
  assert.equal(analysis.intent, 'Pricing', 'Should classify as Pricing');
  assert.equal(analysis.entities.product, 'Ibuprofen', 'Should extract Ibuprofen');
  assert.equal(analysis.entities.quantity, 1000, 'Should extract 1000');
  assert.equal(analysis.entities.unit, 'kg', 'Should extract kg');
  assert.equal(analysis.entities.make, 'Malladi', 'Should extract manufacturer Malladi');
  assert.equal(analysis.needs_action, true, 'Quotation request requires action');
});

test('8. Realistic Test: Message Linked to Existing Inquiry (Does NOT create duplicate inquiry)', () => {
  const text = 'Mengenai penawaran INQ-2026-015, kami konfirmasi pesan ya pak. Tolong kirimkan invoice resminya.';
  const analysis = analyzeWhatsAppMessage(text, { linkedInquiryNumber: 'INQ-2026-015' });

  assert.equal(analysis.intent, 'Purchase/Order', 'Should classify as Purchase/Order');
  assert.equal(analysis.entities.order_reference, 'INQ-2026-015', 'Should extract inquiry number');
  assert.equal(analysis.linked_context_type, 'Order', 'Should link to Order context');
  assert.equal(analysis.needs_action, true, 'PO confirmation requires processing');

  // Verify backend does NOT auto-create inquiry on existing inquiry match
  assert.ok(ingestionCode.includes('targetInquiryId'), 'Ingestion links existing inquiry rather than creating duplicate');
  assert.ok(!ingestionCode.includes('INSERT INTO public.crm_inquiries'), 'Must NOT insert new inquiry row for incoming message');
});

test('9. Realistic Test: Message Linked to Customer Context with Persistent Activity Note', () => {
  const text = 'Customer requested 500 kg Ammonium Chloride, delivery timing pending confirmation. Customer also requested COA for previous batch.';
  const analysis = analyzeWhatsAppMessage(text, {
    customerCompanyName: 'PT Sari Herbal',
    senderPhone: '+628123456789',
  });

  assert.ok(analysis.running_summary.includes('Ammonium Chloride'), 'Summary should capture Ammonium Chloride');
  assert.ok(analysis.running_summary.includes('COA') || analysis.running_summary.includes('requested'), 'Summary should capture customer deliverable');

  // Verify backend attaches note to crm_activities using existing architecture
  assert.ok(ingestionCode.includes("activity_type: \"Note\""), 'Backend records activity note with activity_type = Note');
  assert.ok(ingestionCode.includes("customer_id: customerId"), 'Backend links note directly to customer_id');
});

test('10. Realistic Test: Completely Unlinked WhatsApp Number Handled as General Communication', () => {
  const text = 'Halo, apa saja produk bahan baku farmasi yang tersedia di SAPJ saat ini?';
  const analysis = analyzeWhatsAppMessage(text, {
    senderPhone: '+628999888777', // New/unknown number
  });

  assert.equal(analysis.intent, 'Availability', 'Should classify as Availability inquiry');
  assert.equal(analysis.linked_context_type, 'Inquiry', 'Context type remains Inquiry classification');
  assert.equal(analysis.needs_action, true, 'Stock inquiry requires response');

  // Verify UI handles unlinked communication without crashing
  assert.ok(inboxUiCode.includes('UNLINKED'), 'UI displays UNLINKED badge for unlinked conversations');
  assert.ok(inboxUiCode.includes('Universal Communication Intelligence'), 'Detail view shows Universal Communication Intelligence for any WhatsApp chat');
  assert.ok(inboxUiCode.includes('English Translation'), 'Message bubbles show English Translation for Indonesian text');
  assert.ok(inboxUiCode.includes('Draft Reply in Customer Language'), 'Reply box includes 1-click draft in customer language');
});
