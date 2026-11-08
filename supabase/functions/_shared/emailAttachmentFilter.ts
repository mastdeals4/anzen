/**
 * supabase/functions/_shared/emailAttachmentFilter.ts
 *
 * Shared attachment filtering and document categorization engine for Supabase Edge Functions.
 * Excludes junk/bounce/signature/bill files, prioritizes pharma certificates and catalogues,
 * and flags uncertain documents for review before upload.
 */

export interface AttachmentEvaluationInput {
  filename: string;
  mimeType?: string | null;
  size?: number | null;
  emailSubject?: string | null;
  emailSender?: string | null;
  emailBody?: string | null;
  hasMatchedInquiry?: boolean;
  matchedProductName?: string | null;
  contentId?: string | null;
  disposition?: string | null;
}

export interface EmailAttachmentMeta {
  filename: string;
  mimeType: string;
  size: number;
  attachmentId: string;
  contentId: string | null;
  disposition: string | null;
}

export type AttachmentFilterDisposition = 'EXCLUDE' | 'STORE_AUTOMATICALLY' | 'REVIEW_BEFORE_IMPORT';

export type RecognizedDocType =
  | 'COA'
  | 'MSDS'
  | 'GMP'
  | 'SPEC'
  | 'TDS'
  | 'HALAL'
  | 'DMF'
  | 'COC'
  | 'ISO'
  | 'MHD'
  | 'PURCHASE_ORDER'
  | 'PRODUCT_CATALOGUE'
  | 'CATALOGUE'
  | 'PRICE_LIST'
  | 'OTHER';

export interface AttachmentEvaluationResult {
  disposition: AttachmentFilterDisposition;
  documentType: RecognizedDocType;
  reason: string;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  isImageCertCandidate: boolean;
}

// Common signature, logo, and inline image patterns
const SIGNATURE_OR_ICON_REGEX = /^(?:image\d{1,4}|logo[-_]?\d*|icon[-_]?\d*|signature[-_]?\d*|banner[-_]?\d*|footer[-_]?\d*|header[-_]?\d*|stamp[-_]?\d*|outlook[-_]?logo|clip_image\d*|smime|badge|social[-_]?\w+|invertin_logo)\.(?:png|jpe?g|gif|bmp|webp)$/i;

// Mail bounce / delivery delay patterns
const BOUNCE_SENDER_REGEX = /(?:mailer-daemon|postmaster|noreply|no-reply|bounce)@/i;
const BOUNCE_SUBJECT_REGEX = /(?:delivery status notification|undelivered mail|failure notice|mail delivery failed|delivery failure|delayed mail)/i;

// Telecom bills & generic household/utility statements
const UTILITY_BILL_REGEX = /(?:tagihan telkom|tagihan indihome|tagihan pln|tagihan pdam|telecom bill|rekening koran|tagihan listrik|informasi tagihan)/i;

// Media files that should never be in Document Bank
const MEDIA_EXTENSIONS = /\.(?:mp4|avi|mov|mkv|wmv|flv|webm|mp3|wav|ogg|m4a|aac)$/i;

// Explicit certificate indicators in filenames
const CERT_FILENAME_REGEX = /(?:coa|certificate|sertifikat|analisa|msds|sds|gmp|cgmp|spec|spesifikasi|tds|halal|bpjph|sihalal|dmf|coc|iso)/i;

export function evaluateEmailAttachment(input: AttachmentEvaluationInput): AttachmentEvaluationResult {
  const filename = (input.filename || '').trim();
  const lowerFilename = filename.toLowerCase();
  const ext = lowerFilename.split('.').pop() || '';
  const size = input.size ?? 0;
  const mimeType = (input.mimeType || '').toLowerCase();
  const subject = (input.emailSubject || '').trim();
  const lowerSubject = subject.toLowerCase();
  const sender = (input.emailSender || '').trim();

  // 1. Check Media Files (mp4, avi, mp3, etc.)
  if (MEDIA_EXTENSIONS.test(filename) || mimeType.startsWith('video/') || mimeType.startsWith('audio/')) {
    return {
      disposition: 'EXCLUDE',
      documentType: 'OTHER',
      reason: 'Multimedia audio/video file excluded from CRM Document Bank.',
      confidence: 'HIGH',
      isImageCertCandidate: false,
    };
  }

  // 2. Check Mail Delivery Subsystem / Bounce Notifications
  if (BOUNCE_SENDER_REGEX.test(sender) || BOUNCE_SUBJECT_REGEX.test(subject)) {
    return {
      disposition: 'EXCLUDE',
      documentType: 'OTHER',
      reason: 'Automated mail delivery failure or bounce notification attachment.',
      confidence: 'HIGH',
      isImageCertCandidate: false,
    };
  }

  // 3. Check Utility & Telecom bills
  if (UTILITY_BILL_REGEX.test(subject) || UTILITY_BILL_REGEX.test(filename)) {
    return {
      disposition: 'EXCLUDE',
      documentType: 'OTHER',
      reason: 'Personal or utility bill statement excluded from CRM Document Bank.',
      confidence: 'HIGH',
      isImageCertCandidate: false,
    };
  }

  // 4. Check Tracking Pixels & Tiny Files (<= 1500 bytes)
  if (size > 0 && size <= 1500) {
    return {
      disposition: 'EXCLUDE',
      documentType: 'OTHER',
      reason: 'Tracking pixel, spacer, or miniature inline asset (<= 1.5 KB).',
      confidence: 'HIGH',
      isImageCertCandidate: false,
    };
  }

  const isImage = mimeType.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp'].includes(ext);

  // 5. Check Signatures, Logos, Footer Graphics, and Inline CID Assets
  const isSignatureName = SIGNATURE_OR_ICON_REGEX.test(filename) ||
    /(?:logo|signature|banner|footer|header|stamp|social_icon|invertin_logo)/i.test(lowerFilename) ||
    /^(?:image\d{1,4})\./i.test(lowerFilename);

  const hasCertKeywords = CERT_FILENAME_REGEX.test(lowerFilename);

  const isInlineEmbedded = !!input.contentId && input.disposition === 'inline';

  if (isImage) {
    // Inline CID images are embedded in the email body; exclude them unless the filename names a certificate
    if ((isSignatureName || isInlineEmbedded) && !hasCertKeywords) {
      return {
        disposition: 'EXCLUDE',
        documentType: 'OTHER',
        reason: 'Email signature logo, footer graphic, or icon.',
        confidence: 'HIGH',
        isImageCertCandidate: false,
      };
    }

    // Small images under 25KB without cert keywords are almost always email styling/decorations
    if (size > 0 && size < 25000 && !hasCertKeywords && !input.hasMatchedInquiry) {
      return {
        disposition: 'EXCLUDE',
        documentType: 'OTHER',
        reason: 'Small email graphic or decorative asset (< 25 KB).',
        confidence: 'HIGH',
        isImageCertCandidate: false,
      };
    }
  }

  // 6. Identify Purchase Orders First (Must NOT be misclassified as technical docs or generic OTHER)
  const isPO =
    /(?:^|[^a-z0-9])(?:po\s*[-_#]?\s*\d+|purchase[-_\s]order|pesanan[-_\s]pembelian)(?:[^a-z0-9]|$)/i.test(lowerFilename) ||
    /^(?:po\s*[-_#]?\s*\d+)/i.test(filename) ||
    (/(?:^|[^a-z0-9])(?:po\s*[-_#]?\s*\d+|purchase[-_\s]order)(?:[^a-z0-9]|$)/i.test(lowerSubject) && (ext === 'pdf' || ext === 'docx' || ext === 'xlsx'));

  if (isPO) {
    return {
      disposition: 'STORE_AUTOMATICALLY',
      documentType: 'PURCHASE_ORDER',
      reason: `Customer/supplier purchase order document (${filename})`,
      confidence: 'HIGH',
      isImageCertCandidate: false,
    };
  }

  // 7. Identify Product Catalogues and Price Lists
  const isPriceList =
    /(?:price[-_\s]list|pricelist|daftar[-_\s]harga)/i.test(lowerFilename) ||
    (/(?:price[-_\s]list|pricelist)/i.test(lowerSubject) && (ext === 'xlsx' || ext === 'xls' || ext === 'pdf'));

  if (isPriceList) {
    return {
      disposition: 'STORE_AUTOMATICALLY',
      documentType: 'PRICE_LIST',
      reason: `Supplier price list document (${filename})`,
      confidence: 'HIGH',
      isImageCertCandidate: false,
    };
  }

  const isCatalogue =
    /(?:catalogue|catalog|product[-_\s]list|product[-_\s]catalogue|katalog)/i.test(lowerFilename) ||
    (/(?:product[-_\s]list|catalog|catalogue)/i.test(lowerSubject) && (ext === 'xlsx' || ext === 'xls' || ext === 'pdf'));

  if (isCatalogue) {
    return {
      disposition: 'STORE_AUTOMATICALLY',
      documentType: 'PRODUCT_CATALOGUE',
      reason: `Product catalogue / product list document (${filename})`,
      confidence: 'HIGH',
      isImageCertCandidate: false,
    };
  }

  // 8. Identify Pharma Certificates and Technical Document Types
  // NOTE: For images with generic names, NEVER rely on subject alone to avoid signature misclassification!
  let docType: RecognizedDocType = 'OTHER';

  const matchesFilenameOrDocSubject = (pattern: RegExp) =>
    pattern.test(lowerFilename) || ((ext === 'pdf' || ext === 'docx') && pattern.test(lowerSubject));

  if (matchesFilenameOrDocSubject(/(?:^|[^a-z0-9])(?:coa|certificate[-_\s]of[-_\s]analysis|sertifikat[-_\s]analisa|c[-_\s]of[-_\s]a)(?:[^a-z0-9]|$)/i)) {
    docType = 'COA';
  } else if (matchesFilenameOrDocSubject(/(?:^|[^a-z0-9])(?:msds|sds|safety[-_\s]data[-_\s]sheet)(?:[^a-z0-9]|$)/i)) {
    docType = 'MSDS';
  } else if (matchesFilenameOrDocSubject(/(?:^|[^a-z0-9])(?:gmp|cgmp|good[-_\s]manufacturing[-_\s]practice)(?:[^a-z0-9]|$)/i)) {
    docType = 'GMP';
  } else if (matchesFilenameOrDocSubject(/(?:^|[^a-z0-9])(?:spec|specs|specification|spesifikasi)(?:[^a-z0-9]|$)/i)) {
    docType = 'SPEC';
  } else if (matchesFilenameOrDocSubject(/(?:^|[^a-z0-9])(?:tds|technical[-_\s]data[-_\s]sheet)(?:[^a-z0-9]|$)/i)) {
    docType = 'TDS';
  } else if (matchesFilenameOrDocSubject(/(?:^|[^a-z0-9])(?:halal|bpjph|sihalal)(?:[^a-z0-9]|$)/i)) {
    docType = 'HALAL';
  } else if (matchesFilenameOrDocSubject(/(?:^|[^a-z0-9])(?:dmf|drug[-_\s]master[-_\s]file)(?:[^a-z0-9]|$)/i)) {
    docType = 'DMF';
  } else if (matchesFilenameOrDocSubject(/(?:^|[^a-z0-9])(?:coc|certificate[-_\s]of[-_\s]conformity)(?:[^a-z0-9]|$)/i)) {
    docType = 'COC';
  } else if (matchesFilenameOrDocSubject(/(?:^|[^a-z0-9])(?:iso|iso[-_\s]*9001|iso[-_\s]*22000|iso[-_\s]*14001)(?:[^a-z0-9]|$)/i)) {
    docType = 'ISO';
  } else if (matchesFilenameOrDocSubject(/(?:^|[^a-z0-9])(?:mhd)(?:[^a-z0-9]|$)/i)) {
    docType = 'MHD';
  }

  // 9. Scanned Certificate Image Safety
  const isImageCertCandidate = isImage && (
    docType !== 'OTHER' ||
    hasCertKeywords ||
    lowerFilename.includes('cert') ||
    lowerFilename.includes('test') ||
    (size > 50000 && !!input.hasMatchedInquiry)
  );

  // 10. Final Disposition Determination
  if (docType !== 'OTHER') {
    return {
      disposition: 'STORE_AUTOMATICALLY',
      documentType: docType,
      reason: `Recognized technical document (${docType}): ${filename}`,
      confidence: 'HIGH',
      isImageCertCandidate,
    };
  }

  // Document associated with a confirmed active inquiry
  if (input.hasMatchedInquiry && (ext === 'pdf' || ext === 'docx' || ext === 'xlsx')) {
    return {
      disposition: 'STORE_AUTOMATICALLY',
      documentType: 'OTHER',
      reason: `Document associated with active inquiry (${input.matchedProductName || 'CRM Inquiry'}).`,
      confidence: 'MEDIUM',
      isImageCertCandidate: false,
    };
  }

  // Potential scanned certificate image
  if (isImageCertCandidate) {
    return {
      disposition: 'REVIEW_BEFORE_IMPORT',
      documentType: 'OTHER',
      reason: 'Potential scanned certificate image. Queued for operator review prior to storage.',
      confidence: 'MEDIUM',
      isImageCertCandidate: true,
    };
  }

  // Unclassified PDF or office docs without direct inquiry match -> review queue
  if (ext === 'pdf' || ext === 'docx' || ext === 'xlsx') {
    return {
      disposition: 'REVIEW_BEFORE_IMPORT',
      documentType: 'OTHER',
      reason: 'General attachment without verified inquiry or cert classification. Queued for review before storage.',
      confidence: 'LOW',
      isImageCertCandidate: false,
    };
  }

  // All other unrecognized generic assets
  return {
    disposition: 'EXCLUDE',
    documentType: 'OTHER',
    reason: 'Generic or unrecognized attachment without technical document relevance.',
    confidence: 'LOW',
    isImageCertCandidate: false,
  };
}
