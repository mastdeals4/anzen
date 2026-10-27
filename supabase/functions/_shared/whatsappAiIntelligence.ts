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
  if (entities.document_requested || /\b(minta coa|kirim coa|butuh msds|minta spesifikasi)\b/i.test(lower)) {
    intent = 'COA/MSDS/GMP/TDS/Documents';
    linked_context_type = 'Document';
    needs_action = true;
    action_required = `Send ${entities.document_requested || 'COA/Technical Document'} to customer`;
    topic = entities.product ? `${entities.product} ${entities.document_requested || 'Document'} Request` : 'Technical Document Request';
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
