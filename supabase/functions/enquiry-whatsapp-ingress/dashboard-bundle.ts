// Supabase Edge Function: enquiry-whatsapp-ingress (Self-Contained Dashboard Deployment)
// Fully compatible with Supabase Dashboard Web Editor (zero relative filesystem imports)
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { timingSafeEqual } from "node:crypto";

// ============================================================================
// 1. Inbound Attachment & Payload Interfaces
// ============================================================================
export interface InboundAttachmentDescriptor {
  filename: string;
  mimeType?: string;
  size?: number;
  attachmentId?: string;
  storagePath?: string;
}

export interface WhatsAppInboundPayload {
  messageId: string;
  chatId: string;
  senderPhone: string;
  senderName?: string | null;
  businessPhone?: string | null;
  text?: string | null;
  receivedAt?: string;
  isGroup?: boolean;
  quotedMessage?: {
    id?: string;
    body?: string;
    sender?: string;
  } | null;
  attachments?: InboundAttachmentDescriptor[];
  rawPayload?: Record<string, unknown> | null;
}

export interface MirrorResult {
  success: boolean;
  conversationId: string | null;
  messageId: string | null;
  linkedInquiryId: string | null;
  isDuplicate: boolean;
  error?: string;
}

// ============================================================================
// 2. Universal Communication Intelligence Module
// ============================================================================
// supabase/functions/_shared/whatsappAiIntelligence.ts
//
// Universal Communication Intelligence for Anzen ERP WhatsApp Integration.
// Ingests and understands every inbound message:
// - Language Detection (Indonesian, English, Mixed)
// - English Translation & Normalization
// - Intent Classification across 15 ERP Contexts
// - Structured Entity Extraction (product, make, qty, unit, price, batch, order, delivery, doc, payment, complaint, etc.)
// - Action Detection (strict "Needs Action" vs passive acknowledgment)
// - Concise Cumulative Conversation Summary in English
// - Reply Draft in Customer's Detected Language
// - Context Linking (Customer -> Inquiry -> ERP Context -> Unlinked)

export type WhatsAppLanguage = 'id' | 'en' | 'mixed';

export type WhatsAppErpContext =
  | 'New Inquiry'
  | 'Pricing'
  | 'Product Information'
  | 'Availability'
  | 'Sourcing'
  | 'Alternative Make'
  | 'Purchase/Order'
  | 'Delivery/Shipment'
  | 'COA/MSDS/GMP/TDS/Documents'
  | 'Payment/Receivable'
  | 'Complaint'
  | 'Quality Issue'
  | 'Follow-up'
  | 'General Information'
  | 'Other';

export interface WhatsAppExtractedEntities {
  product?: string | null;
  make?: string | null;
  quantity?: number | null;
  unit?: string | null;
  price?: number | null;
  currency?: string | null;
  batch?: string | null;
  grade?: string | null;
  sample_requested?: boolean;
  sample_details?: string | null;
  party_type?: 'customer' | 'supplier';
  order_reference?: string | null;
  delivery_details?: string | null;
  document_requested?: string | null;
  payment_info?: string | null;
  complaint_details?: string | null;
  quality_issue_details?: string | null;
  follow_up_requirement?: string | null;
  requested_action?: string | null;
  important_dates?: string[];
  commitments_promises?: string[];
}

export interface WhatsAppAnalysisResult {
  language: WhatsAppLanguage;
  language_label: string;
  original_text: string;
  english_translation: string;
  intent: WhatsAppErpContext;
  topic: string;
  entities: WhatsAppExtractedEntities;
  needs_action: boolean;
  action_required: string | null;
  running_summary: string;
  suggested_reply: string;
  linked_context_type: 'Inquiry' | 'Customer' | 'Order' | 'Delivery' | 'Document' | 'Finance' | 'General';
  confidence_tier: 'HIGH' | 'MEDIUM' | 'LOW';
  needs_review: boolean;
  analyzed_at: string;
}

// Indonesian linguistic indicators
const ID_WORDS = [
  'halo', 'selamat', 'pagi', 'siang', 'sore', 'malam', 'kami', 'saya', 'kita',
  'butuh', 'minta', 'mohon', 'tolong', 'kirim', 'kirimkan', 'harga', 'penawaran',
  'stok', 'ada', 'apakah', 'kapan', 'bisa', 'sudah', 'belum', 'kemarin', 'besok',
  'hari', 'ini', 'barang', 'pesanan', 'kemasan', 'rusak', 'pecah', 'bocor', 'kurang',
  'transfer', 'bayar', 'pembayaran', 'bukti', 'rekening', 'faktur', 'kwitansi',
  'terima', 'kasih', 'makasih', 'sama-sama', 'baik', 'siap', 'ya', 'dong', 'gan',
  'kak', 'pak', 'bu', 'dokumen', 'keluhan', 'komplain', 'kualitas', 'warna', 'gumpal',
  'gudang', 'sampai', 'tujuan', 'pengiriman', 'surat', 'jalan', 'po', 'spesifikasi',
];

const EN_WORDS = [
  'hello', 'hi', 'dear', 'we', 'i', 'our', 'need', 'request', 'please', 'send',
  'quote', 'quotation', 'price', 'pricing', 'stock', 'available', 'availability',
  'when', 'can', 'already', 'transfer', 'transferred', 'payment', 'receipt', 'proof',
  'thank', 'thanks', 'order', 'purchase', 'delivery', 'shipment', 'arrived', 'damage',
  'damaged', 'broken', 'complaint', 'quality', 'issue', 'spec', 'specification',
  'warehouse', 'urgent', 'asap', 'follow', 'batch', 'invoice', 'status',
];

/**
 * Detect language: Indonesian, English, or Mixed.
 */
export function detectLanguage(text: string): { language: WhatsAppLanguage; label: string } {
  if (!text || !text.trim()) {
    return { language: 'en', label: 'English' };
  }

  const lower = text.toLowerCase();
  const words = lower.split(/[^a-zA-Z0-9_-]+/).filter(w => w.length > 1);

  let idCount = 0;
  let enCount = 0;

  for (const w of words) {
    if (ID_WORDS.includes(w)) idCount++;
    if (EN_WORDS.includes(w)) enCount++;
  }

  // Regex patterns
  if (/\b(selamat (pagi|siang|sore|malam)|terima kasih|apakah ada|tolong kirim|sudah ditransfer|belum sampai)\b/i.test(lower)) {
    idCount += 3;
  }
  if (/\b(please send|when can you|payment sent|looking for|we need)\b/i.test(lower)) {
    enCount += 3;
  }

  if (idCount > 0 && enCount > 0 && Math.min(idCount, enCount) >= 2) {
    return { language: 'mixed', label: 'Indonesian / English Mixed' };
  }
  if (idCount > enCount) {
    return { language: 'id', label: 'Indonesian' };
  }
  if (enCount > idCount) {
    return { language: 'en', label: 'English' };
  }
  return { language: 'id', label: 'Indonesian' };
}

/**
 * Universal NLP rule-based entity and context extractor
 */
export function analyzeWhatsAppTextDeterministic(
  text: string,
  context?: {
    senderName?: string | null;
    senderPhone?: string | null;
    existingSummary?: string | null;
    hasAttachments?: boolean;
    linkedInquiryNumber?: string | null;
    customerCompanyName?: string | null;
  }
): WhatsAppAnalysisResult {
  const { language, label: language_label } = detectLanguage(text);
  const lower = text.toLowerCase();

  // 1. Entities Extraction
  const entities: WhatsAppExtractedEntities = {
    important_dates: [],
    commitments_promises: [],
  };

  // Product Detection - sorted by length descending so specific variants match first
  const pharmaProducts = [
    'Paracetamol BP', 'Paracetamol USP', 'Paracetamol',
    'Amoxicillin Trihydrate', 'Amoxicillin',
    'Citric Acid Anhydrous', 'Citric Acid Monohydrate', 'Citric Acid',
    'Dextrose Monohydrate', 'Dextrose Anhydrous', 'Dextrose',
    'Metformin HCl', 'Metformin',
    'Pregabalin', 'Gabapentin', 'Cefixime', 'Levofloxacin',
    'Microcrystalline Cellulose', 'Pregelatinized Starch',
    'Sodium Bicarbonate', 'Magnesium Stearate',
    'Ammonium Chloride', 'Ascorbic Acid', 'Vitamin C',
    'Ibuprofen', 'Aspirin', 'Ciprofloxacin', 'Ceftriaxone',
    'Azithromycin', 'Omeprazole', 'Pantoprazole', 'Lactose', 'PVP K30',
  ];
  for (const prod of pharmaProducts) {
    const reg = new RegExp(`\\b${prod.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    if (reg.test(text)) {
      entities.product = prod;
      break;
    }
  }

  // Make / Manufacturer
  const makes = ['Malladi', 'Anqiu Lu\'an', 'Farmson', 'Granules', 'Aarti', 'Hebei', 'Sinochem', 'DSM', 'BASF', 'Roquette', 'Colorcon'];
  for (const m of makes) {
    if (new RegExp(`\\b${m}\\b`, 'i').test(text)) {
      entities.make = m;
      break;
    }
  }

  // Quantity & Unit
  const qtyMatch = text.match(/(\d+(?:[.,]\d+)?)\s*(kg|kgs|drum|drums|mt|ton|tons|bag|bags|sak|liter|litres|l|box|karton)\b/i);
  if (qtyMatch) {
    entities.quantity = parseFloat(qtyMatch[1].replace(',', '.'));
    entities.unit = qtyMatch[2].toLowerCase();
  }

  // Price & Currency - parse Indonesian thousands separators (e.g. 45.000.000) and standard decimals
  const priceMatch = text.match(/(?:rp\.?|idr|usd|\$)\s*([\d.,]+)/i) ||
                     text.match(/([\d.,]+)\s*(?:idr|usd|\/kg|per kg)/i);
  if (priceMatch) {
    const raw = priceMatch[1].trim();
    if (/\d+\.\d{3}/.test(raw) || /\d+,\d{3}/.test(raw)) {
      entities.price = parseFloat(raw.replace(/[.,]/g, ''));
    } else {
      entities.price = parseFloat(raw.replace(',', '.'));
    }
    entities.currency = /usd|\$/i.test(text) ? 'USD' : 'IDR';
  }

  // Batch
  const batchMatch = text.match(/\b(?:batch|lot|no\.?\s*batch)\s*[:#]?\s*([a-zA-Z0-9._-]+)\b/i);
  if (batchMatch) {
    entities.batch = batchMatch[1].toUpperCase();
  }

  // Order / Ref - prioritize explicit standard formats like INV-2601, PO-2026-088, INQ-2026-015
  const codeMatch = text.match(/\b(?:PO|SO|INV|SPK|INQ)[-_][a-zA-Z0-9_-]+\b/i);
  if (codeMatch) {
    entities.order_reference = codeMatch[0].toUpperCase();
  } else if (context?.linkedInquiryNumber) {
    entities.order_reference = context.linkedInquiryNumber.toUpperCase();
  } else {
    const orderMatch = text.match(/\b(?:po|so|inv|invoice|spk|inq|inquiry|order|pesanan)\b\s*[:#-]?\s*([a-zA-Z0-9._-]+)\b/i);
    if (orderMatch) {
      entities.order_reference = orderMatch[1].toUpperCase();
    }
  }

  // Grade extraction (USP, BP, EP, IP, JP, Food Grade, Technical Grade)
  const gradeMatch = text.match(/\b(USP[-\s]?[0-9]+|USP|BP[-\s]?[0-9]+|BP|EP|IP|Ph\.?\s*Eur|JP|Food\s+Grade|Tech(?:nical)?\s+Grade)\b/i);
  if (gradeMatch) {
    const rawGrade = gradeMatch[1].toUpperCase().replace(/\s+/g, ' ');
    if (rawGrade.startsWith('USP')) entities.grade = 'USP';
    else if (rawGrade.startsWith('BP')) entities.grade = 'BP';
    else if (rawGrade.startsWith('EP') || rawGrade.startsWith('PH')) entities.grade = 'EP';
    else if (rawGrade.startsWith('IP')) entities.grade = 'IP';
    else if (rawGrade.startsWith('JP')) entities.grade = 'JP';
    else if (/FOOD/i.test(rawGrade)) entities.grade = 'Food Grade';
    else if (/TECH/i.test(rawGrade)) entities.grade = 'Technical Grade';
    else entities.grade = rawGrade;
  } else if (entities.product) {
    if (/\bBP\b/i.test(entities.product)) entities.grade = 'BP';
    else if (/\bUSP\b/i.test(entities.product)) entities.grade = 'USP';
    else if (/\bEP\b/i.test(entities.product)) entities.grade = 'EP';
    else if (/\bIP\b/i.test(entities.product)) entities.grade = 'IP';
  }

  // Sample request extraction
  const sampleMatch = text.match(/\b(?:minta|need|request|kirim)?\s*(?:sampel|sample|contoh|working\s+standard)\s*(\d+(?:[.,]\d+)?\s*(?:g|gram|grams|kg|ml))?/i);
  if (sampleMatch || /\b(sample|sampel|working\s+standard|contoh bahan)\b/i.test(text)) {
    entities.sample_requested = true;
    entities.sample_details = sampleMatch?.[0]?.trim() || 'Sample Requested';
  }

  // Party type distinction: Supplier offer vs Customer inquiry
  const isSupplier = /\b(we offer|we can offer|our offer|kami menawarkan|penawaran dari kami|fob\b|cif\b|cfr\b|ex-works|our factory|pabrik kami|price validity|lead time from port|packing in|moq is)\b/i.test(text);
  const isCustomer = /\b(we need|looking for|please quote|request for quote|rfq|kami butuh|minta harga|tolong info harga|minta penawaran|apakah ada stok|ready stock|can you supply|bisa suplai)\b/i.test(text);

  if (isSupplier && !isCustomer) {
    entities.party_type = 'supplier';
  } else {
    entities.party_type = 'customer';
  }

  // Document Request
  if (/\bcoa\b/i.test(text)) entities.document_requested = 'COA';
  else if (/\bmsds|sds\b/i.test(text)) entities.document_requested = 'MSDS';
  else if (/\bgmp\b/i.test(text)) entities.document_requested = 'GMP';
  else if (/\btds|spesifikasi|spec\b/i.test(text)) entities.document_requested = 'TDS/Spec';
  else if (/\bhalal\b/i.test(text)) entities.document_requested = 'Halal';

  // Delivery Details
  const deliveryMatch = text.match(/(?:kirim ke|pengiriman ke|delivery to|alamat|gudang|pabrik|eta)\s*[:]?\s*([^,.\n]+)/i);
  if (deliveryMatch) {
    entities.delivery_details = deliveryMatch[0].trim();
  }

  // Payment info
  const paymentMatch = text.match(/(?:sudah (?:di)?transfer|bukti transfer|payment sent|bca|mandiri|lunas|pelunasan)[^,.\n]*/i);
  if (paymentMatch) {
    entities.payment_info = paymentMatch[0].trim();
  }

  // Complaint / Quality Issue
  const complaintMatch = text.match(/(?:rusak|pecah|bocor|gumpal|warna kuning|kotor|terlambat|belum sampai|tidak sesuai|complaint|damaged)[^,.\n]*/i);
  if (complaintMatch) {
    entities.complaint_details = complaintMatch[0].trim();
  }

  // 2. Intent & ERP Context Classification
  let intent: WhatsAppErpContext = 'General Information';
  let linked_context_type: WhatsAppAnalysisResult['linked_context_type'] = 'General';
  let needs_action = false;
  let action_required: string | null = null;
  let topic = 'General WhatsApp Message';

  const words = lower.split(/[^a-zA-Z0-9_-]+/).filter(w => w.length > 1);

  // Check specific high-intent categories
  if (entities.document_requested || entities.sample_requested || /\b(minta coa|kirim coa|butuh msds|minta spesifikasi|minta sampel|sample request)\b/i.test(lower)) {
    intent = entities.document_requested ? 'COA/MSDS/GMP/TDS/Documents' : 'Product Information';
    linked_context_type = entities.document_requested ? 'Document' : 'Inquiry';
    needs_action = true;
    action_required = entities.sample_requested
      ? `Arrange sample dispatch (${entities.sample_details || 'Sample'}) to customer`
      : `Send ${entities.document_requested || 'COA/Technical Document'} to customer`;
    topic = entities.product
      ? `${entities.product} ${entities.document_requested || (entities.sample_requested ? 'Sample' : 'Document')} Request`
      : 'Technical Document / Sample Request';
  } else if (entities.complaint_details || /\b(komplain|keluhan|rusak|pecah|bocor|gumpal|beda warna)\b/i.test(lower)) {
    intent = /\b(gumpal|beda warna|kualitas|out of spec)\b/i.test(lower) ? 'Quality Issue' : 'Complaint';
    linked_context_type = 'Order';
    needs_action = true;
    action_required = 'Investigate quality/delivery complaint with warehouse & QA';
    topic = entities.product ? `${entities.product} Quality/Issue Report` : 'Customer Quality/Delivery Complaint';
  } else if (entities.payment_info || /\b(sudah transfer|bukti bayar|pembayaran|faktur|pelunasan)\b/i.test(lower)) {
    intent = 'Payment/Receivable';
    linked_context_type = 'Finance';
    needs_action = true;
    action_required = 'Verify bank payment receipt with Finance';
    topic = 'Payment Proof / Invoice Settlement';
  } else if (/\b(kami pesan|pesan ya|konfirmasi pesan|konfirmasi pesanan|order confirm|kami konfirmasi|terbitkan po|fix order)\b/i.test(lower) || (/\b(po|purchase order)\b/i.test(lower) && !/\b(truk|supir|status|posisi|jalan)\b/i.test(lower))) {
    intent = 'Purchase/Order';
    linked_context_type = 'Order';
    needs_action = true;
    action_required = 'Process customer Purchase Order & reserve stock';
    topic = entities.product ? `Purchase Order for ${entities.product}` : 'Customer Purchase Order';
  } else if (/\b(rfq|permintaan baru|inquiry baru|new inquiry|produk baru)\b/i.test(lower)) {
    intent = 'New Inquiry';
    linked_context_type = 'Inquiry';
    needs_action = true;
    action_required = 'Review new product inquiry requirements';
    topic = entities.product ? `New Inquiry for ${entities.product}` : 'New Customer Inquiry';
  } else if (/\b(penawaran|quotation|best price|quote|minta harga|butuh harga|harga berapa|diskon)\b/i.test(lower) || (entities.product && entities.quantity)) {
    intent = 'Pricing';
    linked_context_type = 'Inquiry';
    needs_action = true;
    action_required = entities.product
      ? `Provide price quotation for ${entities.quantity ? entities.quantity + ' ' + (entities.unit || 'kg') + ' ' : ''}${entities.product}`
      : 'Provide price quotation to customer';
    topic = entities.product
      ? `${entities.product}${entities.quantity ? ` (${entities.quantity} ${entities.unit || 'kg'})` : ''} Quotation`
      : 'Product Price Request';
  } else if (/\b(kapan\b.*?\b(?:sampai|tiba|dikirim)|kapan sampai|kapan dikirim|status pengiriman|belum sampai|jadwal kirim|posisi barang|truk|supir|driver|plat nomor|delivery|shipment|eta|sampai ke gudang)\b/i.test(lower)) {
    intent = 'Delivery/Shipment';
    linked_context_type = 'Delivery';
    needs_action = true;
    action_required = 'Check shipment status & ETA with warehouse logistics';
    topic = entities.product ? `${entities.product} Delivery Schedule Check` : 'Delivery Status & ETA Inquiry';
  } else if (/\b(apakah ada|ready stok|stok ready|ready stock|tersedia|ketersediaan)\b/i.test(lower)) {
    intent = 'Availability';
    linked_context_type = 'Inquiry';
    needs_action = true;
    action_required = `Check warehouse stock availability for ${entities.product || 'requested item'}`;
    topic = entities.product ? `${entities.product} Stock Availability` : 'Stock Availability Check';
  } else if (/\b(ada alternatif|pabrik lain|make lain|brand lain|alternative make)\b/i.test(lower)) {
    intent = 'Alternative Make';
    linked_context_type = 'Inquiry';
    needs_action = true;
    action_required = `Offer alternative manufacturers/grades for ${entities.product || 'requested chemical'}`;
    topic = entities.product ? `${entities.product} Alternative Make Request` : 'Alternative Manufacturer Inquiry';
  } else if (/\b(bisa carikan|bisa sourcing|punya barang ini|sumber|sourcing)\b/i.test(lower)) {
    intent = 'Sourcing';
    linked_context_type = 'Inquiry';
    needs_action = true;
    action_required = `Source supplier options for ${entities.product || 'specialty material'}`;
    topic = entities.product ? `${entities.product} Sourcing Request` : 'Specialty Chemical Sourcing';
  } else if (/\b(spesifikasi|mesh|assay|grade|origin|sertifikat)\b/i.test(lower)) {
    intent = 'Product Information';
    linked_context_type = 'Inquiry';
    needs_action = true;
    action_required = `Provide technical specifications for ${entities.product || 'item'}`;
    topic = entities.product ? `${entities.product} Technical Specifications` : 'Product Information Inquiry';
  } else if (/\b(noted|terima kasih|makasih|ok|oke|baik|siap|siap pak|siap bu|thank you|thanks)\b/i.test(lower) && words.length <= 6) {
    // Passive acknowledgment -> NO ACTION
    intent = 'General Information';
    linked_context_type = context?.customerCompanyName ? 'Customer' : 'General';
    needs_action = false;
    action_required = null;
    topic = 'Conversation Acknowledgment';
  } else if (/\b(follow up|follow-up|lanjutan|bagaimana kelanjutan|gimana kabarnya)\b/i.test(lower)) {
    intent = 'Follow-up';
    linked_context_type = context?.linkedInquiryNumber ? 'Inquiry' : 'Customer';
    needs_action = true;
    action_required = 'Respond to customer follow-up';
    topic = 'Inquiry / Order Follow-Up';
  }

  // 3. Translation to English
  let english_translation = text;
  if (language === 'id' || language === 'mixed') {
    english_translation = generateEnglishTranslation(text, intent, entities);
  }

  // 4. Running Summary Generation (English, concise, cumulative)
  const customerName = context?.customerCompanyName || context?.senderName || 'Customer';
  let running_summary = '';

  if (intent === 'Pricing' || intent === 'New Inquiry') {
    running_summary = `${customerName} requested quotation for ${entities.quantity ? entities.quantity + ' ' + (entities.unit || 'kg') + ' ' : ''}${entities.product || 'raw materials'}${entities.make ? ' (' + entities.make + ')' : ''}. SAPJ action: prepare official quote.`;
  } else if (intent === 'COA/MSDS/GMP/TDS/Documents') {
    running_summary = `${customerName} requested ${entities.document_requested || 'COA'}${entities.batch ? ' for batch ' + entities.batch : ''}${entities.product ? ' (' + entities.product + ')' : ''}. SAPJ action: dispatch document.`;
  } else if (intent === 'Delivery/Shipment') {
    running_summary = `${customerName} requested delivery schedule and ETA status${entities.product ? ' for ' + entities.product : ''}. Warehouse confirmation pending.`;
  } else if (intent === 'Payment/Receivable') {
    running_summary = `${customerName} reported payment settlement${entities.order_reference ? ' for ' + entities.order_reference : ''}. Finance reconciliation required.`;
  } else if (intent === 'Complaint' || intent === 'Quality Issue') {
    running_summary = `${customerName} reported a quality/delivery issue${entities.batch ? ' on batch ' + entities.batch : ''}${entities.product ? ' (' + entities.product + ')' : ''}: ${entities.complaint_details || 'investigation required'}.`;
  } else if (intent === 'Purchase/Order') {
    running_summary = `${customerName} confirmed purchase order${entities.product ? ' for ' + entities.product : ''}. Sales order booking required.`;
  } else if (!needs_action) {
    running_summary = `${customerName} acknowledged previous message. No pending action.`;
  } else {
    running_summary = `${customerName} communicated regarding ${topic.toLowerCase()}.`;
  }

  // If previous summary exists, combine smoothly
  if (context?.existingSummary && !context.existingSummary.includes(running_summary)) {
    running_summary = `${context.existingSummary} ${running_summary}`;
  }

  // 5. Suggested Reply Draft (in Customer's Detected Language)
  const suggested_reply = generateSuggestedReply(language, intent, entities, customerName);

  return {
    language,
    language_label,
    original_text: text,
    english_translation,
    intent,
    topic,
    entities,
    needs_action,
    action_required,
    running_summary,
    suggested_reply,
    linked_context_type,
    confidence_tier: 'HIGH',
    needs_review: false,
    analyzed_at: new Date().toISOString(),
  };
}

/**
 * Natural translation generator from Indonesian to English
 */
function generateEnglishTranslation(
  text: string,
  intent: WhatsAppErpContext,
  entities: WhatsAppExtractedEntities
): string {
  const lower = text.toLowerCase();

  if (/\b(minta coa|tolong kirimkan coa|butuh coa)\b/i.test(lower)) {
    return `Hello SAPJ team, please send the Certificate of Analysis (COA)${entities.batch ? ' for batch ' + entities.batch : ''}${entities.product ? ' for ' + entities.product : ''}.`;
  }
  if (/\b(apakah ada stok|ready stok|stok ready)\b/i.test(lower)) {
    return `Is there ready stock available for ${entities.product || 'the requested item'}${entities.quantity ? ' (' + entities.quantity + ' ' + (entities.unit || 'kg') + ')' : ''}?`;
  }
  if (/\b(minta penawaran|butuh penawaran|harga berapa|minta harga)\b/i.test(lower)) {
    return `Hello SAPJ, we need an official price quotation for ${entities.product || 'raw materials'}${entities.quantity ? ' quantity ' + entities.quantity + ' ' + (entities.unit || 'kg') : ''}. Please advise on current stock availability.`;
  }
  if (/\b(sudah ditransfer|sudah transfer|bukti transfer)\b/i.test(lower)) {
    return `Payment has been transferred${entities.order_reference ? ' for ' + entities.order_reference : ''}. Please find payment confirmation attached.`;
  }
  if (/\b(kapan\b.*?\b(?:sampai|tiba|dikirim)|kapan sampai|kapan dikirim|status pengiriman|belum sampai|jadwal kirim|truk|plat nomor|supir)\b/i.test(lower)) {
    return `Could you please provide an update on delivery timing and ETA for our order${entities.product ? ' of ' + entities.product : ''}?`;
  }
  if (/\b(rusak|pecah|bocor|gumpal)\b/i.test(lower)) {
    return `We received the goods${entities.product ? ' of ' + entities.product : ''}, but there is a quality/packaging defect (${entities.complaint_details || 'issue'}). Please investigate urgently.`;
  }
  if (/\b(noted|terima kasih|baik pak|oke|siap)\b/i.test(lower)) {
    return 'Noted with thanks. Will await further updates.';
  }

  // Word-by-word fallback replacements for Indonesian idioms
  let translated = text
    .replace(/\bhalo\b/gi, 'Hello')
    .replace(/\bselamat pagi\b/gi, 'Good morning')
    .replace(/\bselamat siang\b/gi, 'Good afternoon')
    .replace(/\bselamat sore\b/gi, 'Good afternoon')
    .replace(/\bselamat malam\b/gi, 'Good evening')
    .replace(/\bkami butuh\b/gi, 'we need')
    .replace(/\bpenawaran resmi\b/gi, 'official quotation')
    .replace(/\bmohon info\b/gi, 'please inform')
    .replace(/\bketersediaan stok\b/gi, 'stock availability')
    .replace(/\btolong kirimkan\b/gi, 'please send')
    .replace(/\bsudah ditransfer\b/gi, 'has been transferred')
    .replace(/\bterima kasih\b/gi, 'thank you');

  return translated;
}

/**
 * Suggested reply draft generated in the customer's native detected language
 */
function generateSuggestedReply(
  lang: WhatsAppLanguage,
  intent: WhatsAppErpContext,
  entities: WhatsAppExtractedEntities,
  customerName: string
): string {
  const isId = lang === 'id' || lang === 'mixed';

  if (isId) {
    if (intent === 'COA/MSDS/GMP/TDS/Documents') {
      return `Halo ${customerName}, baik kami siapkan dokumen ${entities.document_requested || 'COA'}${entities.batch ? ' batch ' + entities.batch : ''}${entities.product ? ' untuk ' + entities.product : ''}. Kami kirimkan segera ya. Terima kasih.`;
    }
    if (intent === 'Pricing' || intent === 'New Inquiry') {
      return `Halo ${customerName}, terima kasih atas permintaannya. Kami sedang menyiapkan penawaran resmi untuk ${entities.product || 'produk'}${entities.quantity ? ' ' + entities.quantity + ' ' + (entities.unit || 'kg') : ''}. Segera kami kirimkan ya.`;
    }
    if (intent === 'Availability') {
      return `Halo ${customerName}, untuk stok ${entities.product || 'produk tersebut'} sedang kami cek ke gudang. Akan segera kami kabari ketersediaannya. Terima kasih.`;
    }
    if (intent === 'Delivery/Shipment') {
      return `Halo ${customerName}, kami cek jadwal armada pengiriman ke gudang untuk ${entities.product || 'pesanan Anda'}. Estimasi akan kami infokan secepatnya.`;
    }
    if (intent === 'Payment/Receivable') {
      return `Halo ${customerName}, terima kasih konfirmasi pembayarannya. Kami teruskan ke tim finance untuk verifikasi rekening.`;
    }
    if (intent === 'Complaint' || intent === 'Quality Issue') {
      return `Halo ${customerName}, mohon maaf atas ketidaknyamanan ini. Laporan mengenai ${entities.complaint_details || 'kondisi barang'} segera kami koordinasikan dengan tim QA dan gudang untuk penanganan.`;
    }
    return `Halo ${customerName}, terima kasih. Pesan Anda sudah kami terima dan akan kami tindak lanjuti.`;
  }

  // English Reply
  if (intent === 'COA/MSDS/GMP/TDS/Documents') {
    return `Hello ${customerName}, thank you for your message. We are retrieving the ${entities.document_requested || 'COA'}${entities.batch ? ' for batch ' + entities.batch : ''} and will share it shortly.`;
  }
  if (intent === 'Pricing' || intent === 'New Inquiry') {
    return `Hello ${customerName}, thank you for your inquiry. Our commercial team is preparing the quotation for ${entities.product || 'the material'}${entities.quantity ? ' (' + entities.quantity + ' ' + (entities.unit || 'kg') + ')' : ''}. We will revert promptly.`;
  }
  if (intent === 'Delivery/Shipment') {
    return `Hello ${customerName}, we are coordinating with our logistics team regarding the dispatch schedule and ETA for ${entities.product || 'your order'}.`;
  }
  if (intent === 'Payment/Receivable') {
    return `Hello ${customerName}, thank you for the payment confirmation. Our finance team is verifying the transaction receipt.`;
  }
  if (intent === 'Complaint' || intent === 'Quality Issue') {
    return `Hello ${customerName}, we apologize for this inconvenience. Our QA and warehouse teams are reviewing the reported issue to resolve it immediately.`;
  }
  return `Hello ${customerName}, thank you for contacting SAPJ. Your message has been received and our team will assist you shortly.`;
}

// ============================================================================
// 3. Canonical Communication Helper Functions
// ============================================================================
function cleanTitle(subject: string | null | undefined): string {
  if (!subject) return "(No Subject)";
  return subject
    .replace(/^(\s*(re|fwd|fw|external)\s*:\s*)+/gi, "")
    .trim() || "(No Subject)";
}

/**
 * Extract exact INQ number pattern: INQ-2026-001 or INQ-26-015 or INQ-26-015.1
 */
export function extractExactInquiryNumber(text: string | null | undefined): string | null {
  if (!text) return null;
  const match = text.match(/\bINQ-\d{2,4}-\d{3,4}(\.\d+)?\b/i);
  return match ? match[0].toUpperCase() : null;
}

/**
 * Resolve or create canonical conversation header by channel and external_thread_id.
 */

export async function getOrCreateCanonicalConversation(
  supabase: SupabaseClient,
  threadId: string,
  title: string,
  participants: string[],
  lastMessageAt: string,
  customerId: string | null = null,
  channel: "email" | "whatsapp" = "email"
): Promise<{ id: string; isNew: boolean }> {
  // Check existing by channel + external_thread_id
  const { data: existing, error: findError } = await supabase
    .from("enquiry_conversations")
    .select("id, participant_identifiers")
    .eq("channel", channel)
    .eq("external_thread_id", threadId)
    .maybeSingle();

  if (findError) throw findError;

  if (existing) {
    // Merge new participants if any
    const existingSet = new Set((existing.participant_identifiers || []).map((p: string) => p.toLowerCase()));
    const merged = [...(existing.participant_identifiers || [])];
    let changed = false;
    for (const p of participants) {
      if (p && !existingSet.has(p.toLowerCase())) {
        existingSet.add(p.toLowerCase());
        merged.push(p);
        changed = true;
      }
    }

    const updates: Record<string, unknown> = {
      last_message_at: lastMessageAt,
    };
    if (changed) updates.participant_identifiers = merged;
    if (customerId) updates.customer_id = customerId;

    await supabase
      .from("enquiry_conversations")
      .update(updates)
      .eq("id", existing.id);

    return { id: existing.id, isNew: false };
  }

  // Insert new conversation
  const newPayload = {
    channel: channel,
    external_thread_id: threadId,
    title: cleanTitle(title),
    participant_identifiers: participants.filter(Boolean),
    last_message_at: lastMessageAt,
    customer_id: customerId,
    status: "active",
  };

  const { data: created, error: insertError } = await supabase
    .from("enquiry_conversations")
    .insert(newPayload)
    .select("id")
    .single();

  if (insertError) {
    // Collision on unique partial index: uq_enq_conv_channel_external_thread
    if (insertError.code === "23505") {
      const { data: winner } = await supabase
        .from("enquiry_conversations")
        .select("id")
        .eq("channel", channel)
        .eq("external_thread_id", threadId)
        .single();
      if (winner) return { id: winner.id, isNew: false };
    }
    throw insertError;
  }

  return { id: created.id, isNew: true };
}

/**
 * Mirror inbound email from crm_email_inbox to canonical communication tables.
 */

export function isEligibleForEnquiryBrainAnalysis(message: {
  direction: string;
  channel?: string;
  bodyText?: string | null;
  bodyHtml?: string | null;
  subject?: string | null;
}): boolean {
  if (message.direction !== "inbound") return false;
  if (message.channel && message.channel !== "email" && message.channel !== "whatsapp") return false;
  const content = `${message.subject || ""} ${message.bodyText || ""} ${message.bodyHtml || ""}`.trim();
  return content.length > 0;
}

/**
 * Triggers non-blocking background analysis of an inbound canonical message.
 */

export async function triggerEnquiryBrainAnalysis(
  supabase: SupabaseClient,
  messageId: string,
  options?: {
    supabaseUrl?: string;
    serviceKey?: string;
    force?: boolean;
  }
): Promise<{ triggered: boolean; error?: string }> {
  try {
    const supabaseUrl = options?.supabaseUrl || (typeof Deno !== "undefined" ? Deno.env.get("SUPABASE_URL") : null);
    const serviceKey = options?.serviceKey || (typeof Deno !== "undefined" ? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") : null);

    // If environment variables are missing (e.g. offline/testing), ensure message has pending marker
    if (!supabaseUrl || !serviceKey) {
      await supabase
        .from("enquiry_conversation_messages")
        .update({
          ai_proposal: {
            status: "pending",
            queued_at: new Date().toISOString(),
          },
        })
        .eq("id", messageId)
        .is("ai_proposal", null);

      return { triggered: false, error: "SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not configured" };
    }

    // Set pending status before dispatching
    await supabase
      .from("enquiry_conversation_messages")
      .update({
        ai_proposal: {
          status: "pending",
          queued_at: new Date().toISOString(),
        },
      })
      .eq("id", messageId)
      .is("ai_proposal", null);

    const callPromise = fetch(`${supabaseUrl}/functions/v1/enquiry-brain-analyze`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${serviceKey}`,
      },
      body: JSON.stringify({
        message_id: messageId,
        force_reanalyze: !!options?.force,
      }),
    }).catch((err) => {
      console.error(`[EnquiryBrain Trigger] Asynchronous invocation error for message ${messageId}:`, err);
    });

    if (typeof (globalThis as any).EdgeRuntime?.waitUntil === "function") {
      (globalThis as any).EdgeRuntime.waitUntil(callPromise);
    }

    return { triggered: true };
  } catch (err: any) {
    console.error(`[EnquiryBrain Trigger] Failed to trigger analysis for message ${messageId}:`, err);
    return { triggered: false, error: err.message };
  }
}

/**
 * Sweeps for unanalyzed or failed (retryable) inbound canonical messages and triggers analysis.
 */

export async function mirrorInboundWhatsApp(
  supabase: SupabaseClient,
  payload: WhatsAppInboundPayload
): Promise<MirrorResult> {
  const {
    messageId,
    chatId,
    senderPhone,
    senderName = null,
    businessPhone = null,
    text = null,
    receivedAt = new Date().toISOString(),
    isGroup = false,
    quotedMessage = null,
    attachments = [],
    rawPayload = null,
  } = payload;

  if (!messageId || !chatId || !senderPhone) {
    return {
      success: false,
      conversationId: null,
      messageId: null,
      linkedInquiryId: null,
      isDuplicate: false,
      error: "Missing required fields (messageId, chatId, senderPhone)",
    };
  }

  // 1. Thread scoping: Scope external_thread_id by business number if present
  const externalThreadId = businessPhone ? `${businessPhone}:${chatId}` : chatId;

  // Title
  const title = isGroup
    ? `WhatsApp Group: ${chatId}`
    : senderName
    ? `WhatsApp: ${senderName} (${senderPhone})`
    : `WhatsApp: ${senderPhone}`;

  const participants = [senderPhone, businessPhone].filter(Boolean) as string[];

  // Customer resolution by phone number
  let customerId: string | null = null;
  const cleanPhone = senderPhone.replace(/\D/g, "");
  if (cleanPhone.length >= 7) {
    const lastDigits = cleanPhone.slice(-8);
    const { data: cust } = await supabase
      .from("customers")
      .select("id")
      .ilike("phone", `%${lastDigits}%`)
      .limit(1)
      .maybeSingle();
    if (cust) customerId = cust.id;
  }

  const { id: conversationId } = await getOrCreateCanonicalConversation(
    supabase,
    externalThreadId,
    title,
    participants,
    receivedAt,
    customerId,
    "whatsapp"
  );

  // 2. Ingest message idempotently
  let canonicalMessageId: string | null = null;
  let isDuplicate = false;

  const { data: existingMsg } = await supabase
    .from("enquiry_conversation_messages")
    .select("id")
    .eq("channel", "whatsapp")
    .eq("external_message_id", messageId)
    .maybeSingle();

  if (existingMsg) {
    canonicalMessageId = existingMsg.id;
    isDuplicate = true;
  } else {
    // Run Universal Communication Intelligence for every inbound message
    let intelligence = null;
    if (text) {
      try {
        intelligence = analyzeWhatsAppTextDeterministic(text, {
          senderName,
          senderPhone,
          hasAttachments: !!(attachments && attachments.length > 0),
        });
      } catch (aiErr) {
        console.warn("[mirrorInboundWhatsApp] AI analysis error:", aiErr);
      }
    }

    const msgPayload = {
      conversation_id: conversationId,
      channel: "whatsapp",
      direction: "inbound",
      external_message_id: messageId,
      sender_address: senderPhone,
      sender_name: senderName,
      recipient_addresses: businessPhone ? [businessPhone] : [],
      subject: title,
      body_text: text,
      body_html: null,
      attachments: attachments || [],
      raw_payload: {
        ...(rawPayload || {}),
        isGroup,
        quotedMessage,
        intelligence,
      },
      received_or_sent_at: receivedAt,
      actor_type: "system",
      actor_id: null,
      ai_processed: !!intelligence,
      ai_summary: intelligence?.running_summary || null,
      ai_proposal: intelligence,
    };

    const { data: insertedMsg, error: insertError } = await supabase
      .from("enquiry_conversation_messages")
      .insert(msgPayload)
      .select("id")
      .single();

    if (insertError) {
      if (insertError.code === "23505") {
        // Unique index collision on (channel, external_message_id)
        const { data: winnerMsg } = await supabase
          .from("enquiry_conversation_messages")
          .select("id")
          .eq("channel", "whatsapp")
          .eq("external_message_id", messageId)
          .single();
        canonicalMessageId = winnerMsg?.id || null;
        isDuplicate = true;
      } else {
        throw insertError;
      }
    } else {
      canonicalMessageId = insertedMsg.id;
    }

    // Update conversation metadata & persist running conversation note
    if (intelligence) {
      await supabase
        .from("enquiry_conversations")
        .update({
          metadata: {
            language: intelligence.language,
            language_label: intelligence.language_label,
            topic: intelligence.topic,
            intent: intelligence.intent,
            needs_action: intelligence.needs_action,
            action_required: intelligence.action_required,
            latest_summary: intelligence.running_summary,
            english_translation: intelligence.english_translation,
            entities: intelligence.entities,
            linked_context_type: intelligence.linked_context_type,
            suggested_reply: intelligence.suggested_reply,
            last_analysis_at: intelligence.analyzed_at,
          },
        })
        .eq("id", conversationId)
        ;

      if (customerId) {
        await supabase
          .from("crm_activities")
          .insert({
            customer_id: customerId,
            activity_type: "Note",
            subject: `[WhatsApp AI] ${intelligence.running_summary}`,
            description: `Language: ${intelligence.language.toUpperCase()} | Intent: ${intelligence.intent} | Action: ${intelligence.action_required || "None"} | Original: "${(text || "").substring(0, 150)}..."`,
            is_completed: true,
          })
          ;
      }
    }
  }

  // 3. Strict Tier-1 Safe Inquiry Matching
  let targetInquiryId: string | null = null;

  // Signal 1: Existing active link on this conversation
  const { data: existingLink } = await supabase
    .from("enquiry_conversation_links")
    .select("inquiry_id")
    .eq("conversation_id", conversationId)
    .eq("is_active", true)
    .limit(1)
    .maybeSingle();

  if (existingLink) {
    targetInquiryId = existingLink.inquiry_id;
  }

  // Signal 2: Exact INQ number in text / caption
  if (!targetInquiryId && text) {
    const exactInqNo = extractExactInquiryNumber(text);
    if (exactInqNo) {
      const { data: inq } = await supabase
        .from("crm_inquiries")
        .select("id")
        .eq("inquiry_number", exactInqNo)
        .maybeSingle();
      if (inq) targetInquiryId = inq.id;
    }
  }

  // Create link if target inquiry resolved and not yet linked
  if (targetInquiryId) {
    const { data: linkExists } = await supabase
      .from("enquiry_conversation_links")
      .select("id")
      .eq("conversation_id", conversationId)
      .eq("inquiry_id", targetInquiryId)
      .maybeSingle();

    if (!linkExists) {
      const { data: activePrimary } = await supabase
        .from("enquiry_conversation_links")
        .select("id")
        .eq("inquiry_id", targetInquiryId)
        .eq("link_type", "primary")
        .eq("is_active", true)
        .maybeSingle();

      const linkType = activePrimary ? "related" : "primary";

      await supabase
        .from("enquiry_conversation_links")
        .insert({
          conversation_id: conversationId,
          inquiry_id: targetInquiryId,
          link_type: linkType,
          is_active: true,
        })
        ;
    }
  }

  // 4. Inbound Media / Technical Document Ingestion
  if (attachments && attachments.length > 0 && !isDuplicate) {
    for (const att of attachments) {
      const fn = att.filename || "document";
      const fnLower = fn.toLowerCase();
      const isTechDoc =
        fnLower.endsWith(".pdf") ||
        fnLower.endsWith(".png") ||
        fnLower.endsWith(".jpg") ||
        fnLower.endsWith(".jpeg") ||
        att.mimeType?.includes("pdf") ||
        att.mimeType?.includes("image");

      if (isTechDoc && targetInquiryId) {
        let docType = "OTHER";
        if (fnLower.includes("coa")) docType = "COA";
        else if (fnLower.includes("msds") || fnLower.includes("sds")) docType = "MSDS";
        else if (fnLower.includes("spec") || fnLower.includes("tds")) docType = "SPEC";

        const storagePath = att.storagePath || `whatsapp/${chatId}/${messageId}_${fn}`;

        // Insert into crm_product_documents if not already recorded
        const { data: existingDoc } = await supabase
          .from("crm_product_documents")
          .select("id")
          .eq("storage_path", storagePath)
          .maybeSingle();

        if (!existingDoc) {
          const { data: insertedDoc } = await supabase
            .from("crm_product_documents")
            .insert({
              inquiry_id: targetInquiryId,
              document_type: docType,
              original_file_name: fn,
              display_file_name: fn,
              storage_bucket: "crm-documents",
              storage_path: storagePath,
              source_email_subject: title,
              ai_extraction: null,
            })
            .select("id")
            .single();

          // If document was recorded, trigger 7.6E Document Intelligence if environment is configured
          if (insertedDoc?.id) {
            const supabaseUrl = typeof Deno !== "undefined" ? Deno.env.get("SUPABASE_URL") : null;
            const serviceKey = typeof Deno !== "undefined" ? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") : null;
            if (supabaseUrl && serviceKey) {
              fetch(`${supabaseUrl}/functions/v1/enquiry-brain-document`, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "Authorization": `Bearer ${serviceKey}`,
                },
                body: JSON.stringify({ document_id: insertedDoc.id }),
              }).catch((docErr) => {
                console.error(`[WhatsApp Document] Error triggering document intelligence for ${insertedDoc.id}:`, docErr);
              });
            }
          }
        }
      }
    }
  }

  // 5. Trigger Enquiry Brain automatic analysis for new canonical inbound messages
  if (!isDuplicate && canonicalMessageId) {
    const isEligible = isEligibleForEnquiryBrainAnalysis({
      direction: "inbound",
      channel: "whatsapp",
      bodyText: text,
      bodyHtml: null,
      subject: title,
    });

    if (isEligible) {
      triggerEnquiryBrainAnalysis(supabase, canonicalMessageId).catch((aiErr) => {
        console.error(`[Canonical Ingestion] WhatsApp auto analysis trigger error for message ${canonicalMessageId}:`, aiErr);
      });
    }
  }

  return {
    success: true,
    conversationId,
    messageId: canonicalMessageId,
    linkedInquiryId: targetInquiryId,
    isDuplicate,
  };
}

/**
 * Mirror outbound WhatsApp reply to canonical communication tables.
 */

// ============================================================================
// 4. Ingress Webhook Handler (Fail-Closed, Constant-Time Auth)
// ============================================================================
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey, X-Webhook-Secret",
};

interface InboundWebhookBody {
  messageId: string;
  chatId: string;
  senderPhone: string;
  senderName?: string | null;
  businessPhone?: string | null;
  text?: string | null;
  receivedAt?: string;
  isGroup?: boolean;
  quotedMessage?: {
    id?: string;
    body?: string;
    sender?: string;
  } | null;
  attachments?: Array<{
    filename: string;
    mimeType?: string;
    size?: number;
    base64Data?: string;
    storagePath?: string;
  }>;
  rawPayload?: Record<string, unknown> | null;
}

async function timingSafeEqualString(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [hashA, hashB] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  return timingSafeEqual(new Uint8Array(hashA), new Uint8Array(hashB));
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({ success: false, error: "Method not allowed" }),
      { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // 1. Authenticate webhook caller via shared secret (Fail closed: No fallback secrets permitted)
  const expectedSecret =
    Deno.env.get("WHATSAPP_WEBHOOK_SECRET") ||
    Deno.env.get("OPENWA_WEBHOOK_SECRET");

  if (!expectedSecret) {
    console.error("[WhatsApp Ingress] Missing WHATSAPP_WEBHOOK_SECRET in environment (failing closed)");
    return new Response(
      JSON.stringify({ success: false, error: "Webhook secret is not configured on server" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const secretHeader = req.headers.get("X-Webhook-Secret") || "";
  const authHeader = req.headers.get("Authorization") || "";
  const bearerToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";

  const providedSecret = secretHeader || bearerToken;
  const isMatch = providedSecret ? await timingSafeEqualString(providedSecret, expectedSecret) : false;

  if (!isMatch) {
    return new Response(
      JSON.stringify({ success: false, error: "Unauthorized webhook caller" }),
      { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // 2. Parse and validate payload
  let body: InboundWebhookBody;
  try {
    body = await req.json();
  } catch {
    return new Response(
      JSON.stringify({ success: false, error: "Invalid JSON body" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const { messageId, chatId, senderPhone } = body;
  if (!messageId || !chatId || !senderPhone) {
    return new Response(
      JSON.stringify({
        success: false,
        error: "Missing required fields: messageId, chatId, senderPhone",
      }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // 3. Handle media uploads if base64Data is present
  const processedAttachments: InboundAttachmentDescriptor[] = [];
  if (body.attachments && Array.isArray(body.attachments)) {
    for (const att of body.attachments) {
      let storagePath = att.storagePath;

      if (!storagePath && att.base64Data) {
        try {
          // Decode base64 to Uint8Array
          const binaryString = atob(att.base64Data);
          const bytes = new Uint8Array(binaryString.length);
          for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
          }

          const safeFilename = (att.filename || "file").replace(/[^a-zA-Z0-9._-]/g, "_");
          const targetPath = `whatsapp/${chatId}/${messageId}_${safeFilename}`;

          const { error: uploadError } = await supabase.storage
            .from("crm-documents")
            .upload(targetPath, bytes, {
              contentType: att.mimeType || "application/octet-stream",
              upsert: true,
            });

          if (!uploadError) {
            storagePath = targetPath;
          } else {
            console.error(`[WhatsApp Ingress] Media upload error for ${safeFilename}:`, uploadError);
          }
        } catch (mediaErr) {
          console.error(`[WhatsApp Ingress] Failed to decode/store media for ${att.filename}:`, mediaErr);
        }
      }

      processedAttachments.push({
        filename: att.filename,
        mimeType: att.mimeType,
        size: att.size,
        storagePath: storagePath || undefined,
      });
    }
  }

  // 4. Ingest into canonical communication layer
  try {
    const result = await mirrorInboundWhatsApp(supabase, {
      messageId: body.messageId,
      chatId: body.chatId,
      senderPhone: body.senderPhone,
      senderName: body.senderName,
      businessPhone: body.businessPhone,
      text: body.text,
      receivedAt: body.receivedAt,
      isGroup: body.isGroup,
      quotedMessage: body.quotedMessage,
      attachments: processedAttachments,
      rawPayload: body.rawPayload,
    });

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err: any) {
    console.error(`[WhatsApp Ingress] Ingestion error:`, err);
    return new Response(
      JSON.stringify({ success: false, error: err.message || "Failed to mirror WhatsApp message" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
