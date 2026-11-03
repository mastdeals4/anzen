import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeWhatsAppMessage, detectWhatsAppLanguage } from '../src/services/crm/whatsappIntelligenceService.ts';

test('1. AI Enquiry Brain detects pharmaceutical products and pharmacopeia grades', () => {
  // Case A: Paracetamol BP with quantity
  const resA = analyzeWhatsAppMessage('Selamat pagi, mohon penawaran harga untuk Paracetamol BP 1000 kg dari Farmson.');
  assert.equal(resA.entities.product, 'Paracetamol BP');
  assert.equal(resA.entities.grade, 'BP');
  assert.equal(resA.entities.quantity, 1000);
  assert.equal(resA.entities.unit, 'kg');
  assert.equal(resA.entities.make, 'Farmson');
  assert.equal(resA.entities.party_type, 'customer');

  // Case B: Pregabalin IP with sample request
  const resB = analyzeWhatsAppMessage('Hi, we need Pregabalin IP 50 kgs, please send COA and 100g sample for testing.');
  assert.ok(resB.entities.product?.toLowerCase().includes('pregabalin'), 'Should recognize Pregabalin');
  assert.equal(resB.entities.grade, 'IP');
  assert.equal(resB.entities.quantity, 50);
  assert.equal(resB.entities.document_requested, 'COA');
  assert.equal(resB.entities.sample_requested, true);
  assert.equal(resB.entities.party_type, 'customer');

  // Case C: Metformin HCl USP
  const resC = analyzeWhatsAppMessage('Tolong cek ketersediaan Metformin HCl USP 500 kg ready stock gudang Jakarta.');
  assert.ok(resC.entities.product?.includes('Metformin'), 'Should recognize Metformin');
  assert.equal(resC.entities.grade, 'USP');
  assert.equal(resC.entities.quantity, 500);
  assert.equal(resC.entities.party_type, 'customer');
});

test('2. Distinguishes supplier offer from customer inquiry', () => {
  // Supplier Offer
  const supplierMsg = 'Dear Sir, We offer Paracetamol BP at USD 3.10/kg FOB Shanghai, packing 25kg/drum, shipment prompt.';
  const resSup = analyzeWhatsAppMessage(supplierMsg);
  assert.equal(resSup.entities.party_type, 'supplier');
  assert.equal(resSup.entities.price, 3.1);
  assert.equal(resSup.entities.currency, 'USD');

  // Customer RFQ
  const customerMsg = 'Halo PT SAPJ, kami butuh penawaran harga untuk Citric Acid Anhydrous 2000 kg kirim ke Cikarang.';
  const resCust = analyzeWhatsAppMessage(customerMsg);
  assert.equal(resCust.entities.party_type, 'customer');
  assert.ok(resCust.entities.product?.includes('Citric Acid'));
  assert.equal(resCust.entities.quantity, 2000);
});

test('3. Detects pending document requests (COA, Specification/TDS, MSDS, Sample)', () => {
  const coaMsg = analyzeWhatsAppMessage('Tolong kirimkan COA dan spesifikasi teknis untuk batch terbaru.');
  assert.ok(coaMsg.entities.document_requested === 'COA' || coaMsg.entities.document_requested === 'TDS/Spec');
  assert.equal(coaMsg.needs_action, true);

  const sampleMsg = analyzeWhatsAppMessage('Apakah bisa kirim contoh sample bahan baku untuk trial R&D 250 gram?');
  assert.equal(sampleMsg.entities.sample_requested, true);
  assert.equal(sampleMsg.needs_action, true);
});

