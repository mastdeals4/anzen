import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { Layout } from '../components/Layout';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { loadMakeSuggestions } from '../services/makeSuggestions';
import { runSapjGmailAgent, fetchHistoricalReconciliation, resyncHistoricalDocuments, type AgentScanSummary } from '../services/kunalIndiaPrice';
import { showToast } from '../components/ToastNotification';
import {
  calculateFCL,
  loadPricingConfig,
  getEffectiveINRRate,
  type PricingConfig,
  type FCLInput,
  type FCLPackingType,
  DEFAULT_CONFIG,
} from '../services/pricingService';
import {
  KunalInternalReplyModal,
  type KunalReplyInquiry,
  type KunalReplyDraft,
  type KunalReplySourceOption,
} from '../components/crm/KunalInternalReplyModal';
import { KunalEmailEvidenceDrawer } from '../components/pricing/KunalEmailEvidenceDrawer';
import { ImportInfo } from '../components/ImportInfo';
import { getSignedUrlCached } from '../utils/signedUrlCache';
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  RefreshCw,
  Save,
  Send,
  Sparkles,
  Search,
  AlertCircle,
  Eye,
  Calendar,
  Clock,
  Trash2,
  Database,
  Plus,
  Upload,
  Download,
  FileText,
  X,
} from 'lucide-react';

export const MANUAL_DOC_TYPES = [
  'COA',
  'MSDS',
  'GMP',
  'TDS',
  'SPEC',
  'COC',
  'ISO',
  'DMF',
  'Catalogue',
  'Price List',
  'Other',
] as const;

export type PricingRowStatus =
  | 'Needs Review'
  | 'Price Received'
  | 'Ready to Quote'
  | 'Waiting Supplier'
  | 'Completed'
  | 'Archived';

import { isProductMatch } from '../services/sourceReplyParser';
export { isProductMatch };

export interface UnifiedPricingRow {
  id: string; // unique row id (inquiry id or ai review id)
  aiReviewId?: string | null;
  inquiryId?: string | null;
  pricingOptionId?: string | null;
  inquiryNumber: string;
  aceerpNo: string;
  customerName: string;
  productName: string;
  specification: string;
  quantity: string;
  requestedMake: string;
  offeredMake: string;
  supplierName: string;

  // Source Rate (Source of Truth for calculation)
  sourcePrice: number | null;
  sourceCurrency: 'INR' | 'USD';
  unit: string;
  moq: string;
  availability: 'available' | 'partial' | 'na';
  leadTime: string;
  remarks: string;

  // Real Canonical FCL Assumptions (from pricingService)
  containerType: '20ft' | '40ft';
  packingType: FCLPackingType;
  capacityKg: number;
  effectiveInrRate: number;
  indiaMarginPct: number;
  freightUsdPerKg: number;
  dutyPct: number;
  insurancePct: number;
  clearanceUsd: number;
  indonesiaMarginPct: number;

  // Real Calculated Engine Outputs
  purchasePriceUsdPerKg: number | null;
  landedCostUsd: number | null;
  suggestedQuoteUsd: number | null;
  quotePrice: number | null; // Kunal override
  quoteCurrency: 'USD' | 'IDR';
  quoteFxIdr: number;
  totalQuoteAmount: number | null;
  calcBreakdown?: Record<string, number> | null;

  // State, Workflow & Action Badges
  status: PricingRowStatus;
  actionReason?: string | null;
  rowClassification: 'inquiry_enriched' | 'new_unmatched' | 'needs_review' | 'alt_make' | 'doc_only' | 'standard_inquiry' | 'no_action';
  actionStatus?: string;
  emailDate?: string | null;
  isAiPrepared: boolean;
  alternativeMakeDetected: boolean;
  needsManualLink: boolean;

  // Documents Checklist
  documents: Array<{
    id?: string;
    documentType: string;
    filename: string;
    storagePath?: string;
    storageBucket?: string;
    batchNumber?: string | null;
    status: 'MATCHED' | 'REVIEW' | 'AMBIGUOUS' | 'MISSING';
  }>;
  docActionNotice?: string | null;

  // Preserved atomic extraction rows from source email
  rawExtractionRows?: any[];
  allPricingOptions?: any[];

  evidence?: {
    hasRealGmail: boolean;
    sourceType: 'gmail' | 'crm';
    from?: string | null;
    to?: string | null;
    cc?: string | null;
    subject?: string | null;
    date?: string | null;
    quote?: string | null;
    why?: string | null;
    bodyText?: string | null;
    bodyHtml?: string | null;
    threadId?: string | null;
    messageId?: string | null;
    attachments?: Array<{
      id?: string;
      attachmentId?: string;
      filename: string;
      mimeType?: string;
      size?: number;
      documentType?: string;
      matchStatus?: string;
      storagePath?: string;
      storageBucket?: string;
    }>;
  } | null;
  sourceType: 'india' | 'china' | 'local';
}

interface CrmInquiryItem {
  id: string;
  inquiry_number: string;
  aceerp_no: string | null;
  company_name: string;
  product_name: string;
  specification: string | null;
  quantity: string;
  supplier_name: string | null;
  source_status: string;
  document_status: string;
  kunal_price_status: string;
  quote_status: string;
  purchase_price: number | null;
  offered_price: number | null;
  purchase_price_currency: string | null;
  offered_price_currency: string | null;
  remarks: string | null;
  kunal_pricing_requested_at: string | null;
  created_at: string;
}

// Canonical Calculation Helper calling pricingService.calculateFCL
function calculateCanonicalPricing(
  sourcePrice: number | null,
  sourceCurrency: 'INR' | 'USD',
  quantityStr: string,
  config: PricingConfig,
  overrides?: {
    containerType?: '20ft' | '40ft';
    packingType?: FCLPackingType;
    effectiveInrRate?: number;
    indiaMarginPct?: number;
    freightUsdPerKg?: number;
    dutyPct?: number;
    insurancePct?: number;
    clearanceUsd?: number;
    indonesiaMarginPct?: number;
    quotePriceOverride?: number | null;
  },
): {
  purchasePriceUsdPerKg: number | null;
  landedCostUsd: number | null;
  suggestedQuoteUsd: number | null;
  quotePrice: number | null;
  totalQuoteAmount: number | null;
  calcBreakdown: Record<string, number> | null;
} {
  if (sourcePrice === null || sourcePrice <= 0) {
    return {
      purchasePriceUsdPerKg: null,
      landedCostUsd: null,
      suggestedQuoteUsd: null,
      quotePrice: overrides?.quotePriceOverride ?? null,
      totalQuoteAmount: null,
      calcBreakdown: null,
    };
  }

  const containerType = overrides?.containerType || '20ft';
  const packingType = overrides?.packingType || 'mixed';
  const indiaMarginPct = overrides?.indiaMarginPct ?? 4.0;
  const freightUsdPerKg = overrides?.freightUsdPerKg ?? 0.08;
  const dutyPct = overrides?.dutyPct ?? 4.0;
  const insurancePct = overrides?.insurancePct ?? 0.1;
  const indonesiaMarginPct = overrides?.indonesiaMarginPct ?? 4.0;
  const clearanceUsd = overrides?.clearanceUsd ?? (config.fcl[containerType]?.clearance || 1100);

  const parsedQty = parseFloat(String(quantityStr || '0').replace(/[^0-9.]/g, ''));
  const sellingQty = parsedQty > 0 ? parsedQty : 12000;

  // Custom copy of config with overridden clearance and effective INR rate
  const rowConfig: PricingConfig = JSON.parse(JSON.stringify(config));
  rowConfig.fcl[containerType].clearance = clearanceUsd;
  if (overrides?.effectiveInrRate && overrides.effectiveInrRate > 0) {
    rowConfig.general.inr_usd_mode = 'manual';
    rowConfig.general.inr_usd_manual_rate = overrides.effectiveInrRate;
  }

  const fclInput: FCLInput = {
    purchase_currency: sourceCurrency,
    purchase_price: sourceCurrency === 'USD' ? sourcePrice : 0,
    inr_price: sourceCurrency === 'INR' ? sourcePrice : 0,
    india_margin_percent: indiaMarginPct,
    indonesia_margin_percent: indonesiaMarginPct,
    freight_type: 'usd_per_kg',
    freight_value: freightUsdPerKg,
    insurance_percent: insurancePct,
    duty_percent: dutyPct,
    container_type: containerType,
    packing_type: packingType,
    selling_quantity: sellingQty,
  };

  const res = calculateFCL(fclInput, rowConfig, 16000);
  if (res.is_zero) {
    return {
      purchasePriceUsdPerKg: null,
      landedCostUsd: null,
      suggestedQuoteUsd: null,
      quotePrice: overrides?.quotePriceOverride ?? null,
      totalQuoteAmount: null,
      calcBreakdown: null,
    };
  }

  const landedCost = Math.round(res.landed_cost_per_kg_usd * 100) / 100;
  const suggestedQuote = Math.round(res.final_price_per_kg_usd * 100) / 100;
  // CRITICAL: Preserve difference between Suggested Quote (recommendation) and Actual Quoted Price (approved quote)
  const finalQuote = (overrides?.quotePriceOverride !== undefined && overrides?.quotePriceOverride !== null && overrides.quotePriceOverride > 0)
    ? overrides.quotePriceOverride
    : null;

  const totalQuote = finalQuote ? Math.round(finalQuote * sellingQty * 100) / 100 : null;

  return {
    purchasePriceUsdPerKg: Math.round(res.purchase_price_usd * 100) / 100,
    landedCostUsd: landedCost,
    suggestedQuoteUsd: suggestedQuote,
    quotePrice: finalQuote,
    totalQuoteAmount: totalQuote,
    calcBreakdown: res.breakdown,
  };
}

export function PricingWorksheet() {
  const { profile } = useAuth();

  // Canonical Pricing Settings
  const [config, setConfig] = useState<PricingConfig>(DEFAULT_CONFIG);

  // Primary dataset
  const [rows, setRows] = useState<UnifiedPricingRow[]>([]);
  const [allInquiriesList, setAllInquiriesList] = useState<CrmInquiryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [ignoringId, setIgnoringId] = useState<string | null>(null);
  const [makeOptions, setMakeOptions] = useState<string[]>([]);

  // STABLE LOCAL STRING DRAFTS FOR NUMERIC INPUT
  // Prevents re-renders, bucket shifts, and focus loss during typing
  const [priceDrafts, setPriceDrafts] = useState<Record<string, { sourcePrice?: string; quotePrice?: string }>>({});

  // Background Gmail AI Agent widget state
  const [isScanning, setIsScanning] = useState(false);
  const [isScanning7Days, setIsScanning7Days] = useState(false);
  const [batchProgress7Days, setBatchProgress7Days] = useState<{
    batch: number;
    found: number;
    processed: number;
    remaining: number;
  } | null>(null);

  // One-time historical scan state
  const [isScanningHistorical, setIsScanningHistorical] = useState(false);
  const [isResyncingDocs, setIsResyncingDocs] = useState(false);
  const [historicalProgress, setHistoricalProgress] = useState<{
    batch: number;
    found: number;
    processed: number;
    pricingFound: number;
    pricingCreated: number;
    pricingEnriched: number;
    docsFound: number;
    docsStored: number;
    inquiriesMatched: number;
    needsReview: number;
    duplicatesSkipped: number;
    errors: string[];
    remaining: number;
  } | null>(null);

  const [historicalReport, setHistoricalReport] = useState<{
    mailbox: string;
    dateRange: string;
    totalFound: number;
    totalProcessed: number;
    aiPricingDetected: number;
    inquiriesEnriched: number;
    newUnlinkedPricing: number;
    alternativeMakesDetected: number;
    needsReview: number;
    documentsDetected: number;
    documentsStored: number;
    documentsLinked: number;
    documentsNeedingResync: number;
    documentsUnavailable: number;
    storageVerificationFailures: number;
    noAction: number;
    duplicatesSkipped: number;
    errors: string[];
  } | null>(null);

  // Import Data Analysis modal target product
  const [importDataModalProduct, setImportDataModalProduct] = useState<string | null>(null);

  const [lastCheckedTime, setLastCheckedTime] = useState<string | null>(null);
  const [nextCheckWibTime, setNextCheckWibTime] = useState<string>('6:00 PM');

  // Filters & Top Bar Controls
  const [search, setSearch] = useState('');
  const [customerFilter, setCustomerFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState<string>('Needs Action');
  const [sourceFilter, setSourceFilter] = useState<string>('all');
  const [classificationFilter, setClassificationFilter] = useState<string>('all');

  // Table Pagination Controls (Requirement #1: Do not overload browser DOM)
  const [page, setPage] = useState<number>(1);
  const [pageSize, setPageSize] = useState<number>(50);

  // Send to Team Modal target
  const [replyTarget, setReplyTarget] = useState<{
    inquiry: KunalReplyInquiry;
    draft: KunalReplyDraft;
    sourceOption: KunalReplySourceOption | null;
  } | null>(null);

  // Internal Email Evidence Drawer target
  const [evidenceDrawerRow, setEvidenceDrawerRow] = useState<UnifiedPricingRow | null>(null);

  // Document Upload State in Expanded Row
  const [uploadingDocRowId, setUploadingDocRowId] = useState<string | null>(null);
  const [uploadDocType, setUploadDocType] = useState<string>('COA');
  const [uploadDocFile, setUploadDocFile] = useState<File | null>(null);
  const [isUploadingDoc, setIsUploadingDoc] = useState(false);

  // Helper to open / download documents via signed URL
  const handleOpenDocument = async (storagePath?: string, filename?: string, isDownload = false) => {
    if (!storagePath) {
      showToast({ type: 'warning', title: 'File Missing', message: 'No file storage path recorded for this document.' });
      return;
    }
    try {
      const url = await getSignedUrlCached('crm-documents', storagePath, 600, {
        download: isDownload ? filename : undefined,
      });
      if (url) {
        window.open(url, '_blank', 'noopener,noreferrer');
      } else {
        showToast({ type: 'error', title: 'Open Failed', message: 'Could not generate signed document URL.' });
      }
    } catch (err: any) {
      showToast({ type: 'error', title: 'Document Error', message: err.message || 'Could not open document' });
    }
  };

  // Helper to upload document to Supabase storage and attach to crm_product_documents
  const handleUploadDocument = async (row: UnifiedPricingRow) => {
    if (!uploadDocFile) {
      showToast({ type: 'warning', title: 'File Required', message: 'Please select a document file to upload.' });
      return;
    }
    if (!row.inquiryId) {
      showToast({ type: 'error', title: 'Inquiry Required', message: 'Row must be linked to an inquiry to attach documents.' });
      return;
    }

    setIsUploadingDoc(true);
    try {
      const ext = uploadDocFile.name.split('.').pop() || 'pdf';
      const cleanFileName = uploadDocFile.name.replace(/[^a-zA-Z0-9._-]/g, '_');
      const storagePath = `${row.inquiryId}/${uploadDocType}_${Date.now()}_${cleanFileName}`;

      // 1. Upload to Supabase Storage 'crm-documents' bucket
      const { error: uploadErr } = await supabase.storage
        .from('crm-documents')
        .upload(storagePath, uploadDocFile, {
          cacheControl: '3600',
          upsert: true,
        });

      if (uploadErr) {
        throw new Error(`Storage upload failed: ${uploadErr.message}`);
      }

      // 2. Insert record into crm_product_documents (marked permanent since manually uploaded/banked)
      const displayFileName = `${row.productName || 'Product'}_${uploadDocType}.${ext}`;
      const { data: newDoc, error: insertErr } = await supabase
        .from('crm_product_documents')
        .insert({
          inquiry_id: row.inquiryId,
          product_name: row.productName,
          make: row.offeredMake || row.requestedMake || null,
          document_type: uploadDocType,
          specification: row.specification || null,
          pricing_option_id: row.pricingOptionId || null,
          is_permanent: true,
          original_file_name: uploadDocFile.name,
          display_file_name: displayFileName,
          storage_bucket: 'crm-documents',
          storage_path: storagePath,
          uploaded_by: profile?.id || null,
        })
        .select('id, inquiry_id, document_type, display_file_name, original_file_name, storage_path, storage_bucket, make, specification, pricing_option_id, is_permanent')
        .single();

      if (insertErr) {
        throw new Error(`Database record creation failed: ${insertErr.message}`);
      }

      // If document is COA, update parent inquiry document_status to 'received'
      if (uploadDocType === 'COA') {
        await supabase
          .from('crm_inquiries')
          .update({ document_status: 'received', updated_at: new Date().toISOString() })
          .eq('id', row.inquiryId);
      }

      // 3. Immediately update row documents in state
      const addedDoc = {
        id: newDoc.id,
        documentType: uploadDocType,
        filename: newDoc.display_file_name || uploadDocFile.name,
        storagePath: storagePath,
        storageBucket: 'crm-documents',
        status: 'MATCHED' as const,
        make: newDoc.make,
        specification: newDoc.specification,
        pricingOptionId: newDoc.pricing_option_id,
        isPermanent: true,
      };

      const nextDocs = [...row.documents.filter(d => d.filename !== addedDoc.filename), addedDoc];
      updateRow(row.id, { documents: nextDocs });

      // Also update evidenceDrawerRow if open for this row
      if (evidenceDrawerRow?.id === row.id) {
        setEvidenceDrawerRow(prev => prev ? { ...prev, documents: nextDocs } : null);
      }

      showToast({
        type: 'success',
        title: 'Document Uploaded & Banked',
        message: `${uploadDocType} document (${uploadDocFile.name}) attached and banked successfully.`,
      });

      // Reset upload form
      setUploadDocFile(null);
      setUploadingDocRowId(null);
    } catch (err: any) {
      showToast({
        type: 'error',
        title: 'Upload Failed',
        message: err.message || 'Could not upload document',
      });
    } finally {
      setIsUploadingDoc(false);
    }
  };

  // Accept and validate AI extraction
  const handleAcceptExtraction = async (rowId: string) => {
    const targetRow = rows.find(r => r.id === rowId);
    if (!targetRow) return;

    if (targetRow.aiReviewId) {
      await supabase
        .from('kunal_ai_email_reviews')
        .update({
          action_status: 'reviewed',
          updated_at: new Date().toISOString(),
        })
        .eq('id', targetRow.aiReviewId);
    }

    const nextStatus: PricingRowStatus = (targetRow.quotePrice && targetRow.quotePrice > 0) ? 'Completed' : 'Needs Review';
    updateRow(rowId, {
      status: nextStatus,
      actionReason: null,
      needsManualLink: false,
    });
    showToast({
      type: 'success',
      title: 'Extraction Confirmed',
      message: `Verified and confirmed pricing for ${targetRow.inquiryNumber}`,
    });
  };

  // Direct manual correction from evidence drawer
  // Direct manual correction from evidence drawer
  const handleSaveCorrection = async (
    rowId: string,
    correction: {
      inquiryId?: string;
      productName?: string;
      offeredMake?: string;
      supplierName?: string;
      sourcePrice?: number | null;
      sourceCurrency?: 'INR' | 'USD';
      unit?: string;
      quotePrice?: number | null;
    },
  ) => {
    const targetRow = rows.find(r => r.id === rowId);
    if (!targetRow) return;

    const matchedInquiry = allInquiriesList.find(i => i.id === correction.inquiryId);
    const updatedInqId = correction.inquiryId || targetRow.inquiryId;
    const effectiveQuotePrice = correction.quotePrice !== undefined ? correction.quotePrice : targetRow.quotePrice;
    const isQuoteReady = Boolean(effectiveQuotePrice && effectiveQuotePrice > 0);

    const finalSourcePrice = correction.sourcePrice !== undefined ? correction.sourcePrice : targetRow.sourcePrice;
    const finalSourceCurrency = correction.sourceCurrency || targetRow.sourceCurrency;

    let purchasePriceUsdPerKg = targetRow.purchasePriceUsdPerKg;
    let landedCostUsd = targetRow.landedCostUsd;
    let suggestedQuoteUsd = targetRow.suggestedQuoteUsd;
    let totalQuoteAmount = targetRow.totalQuoteAmount;
    let calcBreakdown = targetRow.calcBreakdown;

    if (finalSourcePrice && finalSourcePrice > 0) {
      const calc = calculateCanonicalPricing(
        finalSourcePrice,
        finalSourceCurrency,
        targetRow.quantity,
        config,
        {
          containerType: targetRow.containerType,
          packingType: targetRow.packingType,
          effectiveInrRate: targetRow.effectiveInrRate,
          indiaMarginPct: targetRow.indiaMarginPct,
          freightUsdPerKg: targetRow.freightUsdPerKg,
          dutyPct: targetRow.dutyPct,
          insurancePct: targetRow.insurancePct,
          clearanceUsd: targetRow.clearanceUsd,
          indonesiaMarginPct: targetRow.indonesiaMarginPct,
          quotePriceOverride: effectiveQuotePrice,
        },
      );
      purchasePriceUsdPerKg = calc.purchasePriceUsdPerKg;
      landedCostUsd = calc.landedCostUsd;
      suggestedQuoteUsd = calc.suggestedQuoteUsd;
      totalQuoteAmount = calc.totalQuoteAmount;
      calcBreakdown = calc.calcBreakdown;
    }

    const patch: Partial<UnifiedPricingRow> = {
      ...correction,
      quotePrice: effectiveQuotePrice,
      purchasePriceUsdPerKg,
      landedCostUsd,
      suggestedQuoteUsd,
      totalQuoteAmount,
      calcBreakdown,
      inquiryId: updatedInqId,
      inquiryNumber: matchedInquiry?.inquiry_number || targetRow.inquiryNumber,
      aceerpNo: matchedInquiry?.aceerp_no || targetRow.aceerpNo,
      customerName: matchedInquiry?.company_name || targetRow.customerName,
      productName: correction.productName || targetRow.productName,
      needsManualLink: false,
      actionReason: isQuoteReady ? null : 'Pending quoted price',
      status: isQuoteReady ? 'Completed' : 'Needs Review',
    };

    updateRow(rowId, patch);

    const now = new Date().toISOString();
    if (updatedInqId) {
      await supabase
        .from('crm_inquiries')
        .update({
          purchase_price: landedCostUsd,
          offered_price: effectiveQuotePrice,
          purchase_price_currency: 'USD',
          offered_price_currency: targetRow.quoteCurrency,
          kunal_price_status: isQuoteReady ? 'entered' : 'requested',
          price_ready: isQuoteReady,
          quote_status: 'not_sent',
          supplier_name: patch.offeredMake || targetRow.requestedMake,
          source_status: finalSourcePrice ? 'received' : 'waiting',
          updated_at: now,
        })
        .eq('id', updatedInqId);
    }

    if (targetRow.aiReviewId) {
      await supabase
        .from('kunal_ai_email_reviews')
        .update({
          matched_inquiry_id: updatedInqId,
          product_name: patch.productName,
          offered_make: patch.offeredMake,
          source_price: patch.sourcePrice,
          source_currency: patch.sourceCurrency,
          action_status: isQuoteReady ? 'price_saved' : 'reviewed',
          updated_at: now,
        })
        .eq('id', targetRow.aiReviewId);
    }
  };

  // Calculate Next Check time in WIB (08:00, 13:00, 18:00 WIB)
  const computeNextWib = useCallback(() => {
    const now = new Date();
    const wibMs = 7 * 60 * 60 * 1000;
    const wibDate = new Date(now.getTime() + wibMs);
    const mins = wibDate.getUTCHours() * 60 + wibDate.getUTCMinutes();
    if (mins < 480) return '8:00 AM WIB';
    if (mins < 780) return '1:00 PM WIB';
    if (mins < 1080) return '6:00 PM WIB';
    return '8:00 AM WIB (Tomorrow)';
  }, []);

  // Main data loader
  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      setNextCheckWibTime(computeNextWib());

      // 1. Load canonical pricing config from settings table
      const loadedConfig = await loadPricingConfig(supabase);
      setConfig(loadedConfig);
      const effectiveInr = getEffectiveINRRate(loadedConfig);
      const clearance20ft = loadedConfig.fcl['20ft']?.clearance || 1100;
      const capacity20ftMixed = loadedConfig.fcl['20ft']?.capacity?.mixed || 12000;

      // 2. Fetch CRM Inquiries
      const { data: inqsData, error: inqsErr } = await supabase
        .from('crm_inquiries')
        .select(`
          id, inquiry_number, aceerp_no, company_name, product_name, specification,
          quantity, supplier_name, source_status, document_status, kunal_price_status,
          quote_status, purchase_price, offered_price, purchase_price_currency,
          offered_price_currency, remarks, kunal_pricing_requested_at, created_at
        `)
        .order('created_at', { ascending: false })
        .limit(300);

      if (inqsErr) throw inqsErr;
      const inqs: CrmInquiryItem[] = inqsData || [];
      setAllInquiriesList(inqs);

      // 3. Fetch Pricing Options for these inquiries
      const inqIds = inqs.map(i => i.id);
      const optionsMap: Record<string, any[]> = {};
      if (inqIds.length > 0) {
        const { data: optsData } = await supabase
          .from('crm_inquiry_pricing_options')
          .select('*')
          .in('inquiry_id', inqIds);
        for (const opt of optsData || []) {
          if (!optionsMap[opt.inquiry_id]) optionsMap[opt.inquiry_id] = [];
          optionsMap[opt.inquiry_id].push(opt);
        }
      }

      // 4. Fetch ALL AI Email Reviews using safe chunked pagination (Requirement #1: complete retrieval without hardcoded truncation)
      const allAiReviews: any[] = [];
      let reviewOffset = 0;
      const REVIEW_CHUNK_SIZE = 500;
      while (true) {
        const { data: chunk, error: chunkErr } = await supabase
          .from('kunal_ai_email_reviews')
          .select('*')
          .order('scanned_at', { ascending: false })
          .range(reviewOffset, reviewOffset + REVIEW_CHUNK_SIZE - 1);
        if (chunkErr) {
          console.warn('AI reviews fetch chunk warning:', chunkErr);
          break;
        }
        if (!chunk || chunk.length === 0) break;
        allAiReviews.push(...chunk);
        if (chunk.length < REVIEW_CHUNK_SIZE) break;
        reviewOffset += REVIEW_CHUNK_SIZE;
      }
      const aiReviews = allAiReviews;

      // 5. Fetch ALL Documents to reconcile real storage vs detected AI attachments (Requirement #5)
      const { data: allDocsData } = await supabase
        .from('crm_product_documents')
        .select('id, inquiry_id, document_type, display_file_name, original_file_name, storage_path, storage_bucket, make, specification, pricing_option_id, is_permanent, source_gmail_message_id');

      const docsMap: Record<string, any[]> = {};
      const docsByMessageId: Record<string, any[]> = {};
      const docsByFilename: Record<string, any> = {};

      for (const doc of allDocsData || []) {
        const docObj = {
          id: doc.id,
          documentType: doc.document_type || 'DOC',
          filename: doc.display_file_name || doc.original_file_name || 'document.pdf',
          storagePath: doc.storage_path,
          storageBucket: doc.storage_bucket || 'crm-documents',
          status: (doc.storage_path ? 'MATCHED' : 'FILE NOT STORED / NEEDS RE-SYNC') as any,
          isStored: Boolean(doc.storage_path),
          make: doc.make,
          specification: doc.specification,
          pricingOptionId: doc.pricing_option_id,
          isPermanent: doc.is_permanent,
        };

        if (doc.inquiry_id) {
          if (!docsMap[doc.inquiry_id]) docsMap[doc.inquiry_id] = [];
          docsMap[doc.inquiry_id].push(docObj);
        }
        if (doc.source_gmail_message_id) {
          if (!docsByMessageId[doc.source_gmail_message_id]) docsByMessageId[doc.source_gmail_message_id] = [];
          docsByMessageId[doc.source_gmail_message_id].push(docObj);
        }
        if (doc.display_file_name) {
          docsByFilename[doc.display_file_name.toLowerCase()] = docObj;
        }
        if (doc.original_file_name) {
          docsByFilename[doc.original_file_name.toLowerCase()] = docObj;
        }
      }

      // Map inquiries into unified rows
      const unifiedMap = new Map<string, UnifiedPricingRow>();

      // First pass: Active Inquiries
      for (const inq of inqs) {
        const inqOpts = optionsMap[inq.id] || [];
        const selectedOpt = inqOpts.find(o => o.is_selected) || inqOpts[0] || null;

        // CRITICAL FIX: Only use actual source_price from pricing_options.
        // DO NOT use old CRM purchase_price as calculated landed cost or source price!
        const sourcePrice: number | null = selectedOpt?.source_price != null ? Number(selectedOpt.source_price) : null;
        const sourceCurrency: 'INR' | 'USD' = (selectedOpt?.source_currency as any) === 'USD' ? 'USD' : 'INR';
        const requestedMake = inq.supplier_name || '';
        const offeredMake = selectedOpt?.offered_make || inq.supplier_name || '';
        const supplierName = selectedOpt?.supplier || '';

        // REQUIREMENT #2: Load existing saved customer quote correctly.
        // First resolve actual saved customer quote from selected pricing option selling_price.
        // BUT if no usable selected option selling_price, use crm_inquiries.offered_price when populated.
        const actualQuotedPrice: number | null =
          (selectedOpt?.selling_price !== undefined && selectedOpt?.selling_price !== null && Number(selectedOpt.selling_price) > 0)
            ? Number(selectedOpt.selling_price)
            : (inq.offered_price !== undefined && inq.offered_price !== null && Number(inq.offered_price) > 0)
              ? Number(inq.offered_price)
              : null;

        const quoteCurrency: 'USD' | 'IDR' =
          (selectedOpt?.selling_currency === 'IDR' || inq.offered_price_currency === 'IDR') ? 'IDR' : 'USD';

        // Default Canonical FCL Assumptions
        const containerType: '20ft' | '40ft' = '20ft';
        const packingType: FCLPackingType = 'mixed';
        const capacityKg = capacity20ftMixed;
        const indiaMarginPct = 4.0;
        const freightUsdPerKg = 0.08;
        const dutyPct = 4.0;
        const insurancePct = 0.1;
        const clearanceUsd = clearance20ft;
        const indonesiaMarginPct = 4.0;

        // Perform canonical FCL calculation ONLY if a genuine source price exists
        let calcResult = {
          purchasePriceUsdPerKg: null as number | null,
          landedCostUsd: null as number | null,
          suggestedQuoteUsd: null as number | null,
          quotePrice: actualQuotedPrice,
          totalQuoteAmount: null as number | null,
          calcBreakdown: null as Record<string, number> | null,
        };

        if (sourcePrice !== null && sourcePrice > 0) {
          calcResult = calculateCanonicalPricing(
            sourcePrice,
            sourceCurrency,
            inq.quantity,
            loadedConfig,
            {
              containerType,
              packingType,
              effectiveInrRate: effectiveInr,
              indiaMarginPct,
              freightUsdPerKg,
              dutyPct,
              insurancePct,
              clearanceUsd,
              indonesiaMarginPct,
              quotePriceOverride: actualQuotedPrice,
            },
          );
        } else {
          calcResult.quotePrice = actualQuotedPrice;
        }

        // REQUIREMENT #4: Fix Completed Status.
        // COMPLETED must mean there is an actual completed quotation state (actual quote exists and is saved/sent).
        // If supplier price exists but customer quote missing -> Ready to Quote
        // If supplier price missing -> Waiting Supplier
        // If quote_status = 'sent' or entered but quote price is missing -> Needs Review (data inconsistency)
        const hasQuotedPrice = actualQuotedPrice !== null && actualQuotedPrice > 0;
        const isQuoteSent = inq.quote_status === 'sent';
        const isQuoteEntered = inq.kunal_price_status === 'entered';
        const hasSupplierPrice = sourcePrice !== null && sourcePrice > 0;

        let status: PricingRowStatus = 'Waiting Supplier';
        let actionReason: string | null = null;

        if (hasQuotedPrice) {
          status = 'Completed';
        } else {
          if (isQuoteSent) {
            status = 'Needs Review';
            actionReason = 'Quote marked sent but price missing';
          } else if (isQuoteEntered) {
            status = 'Needs Review';
            actionReason = 'Status entered but quote price missing';
          } else if (hasSupplierPrice) {
            status = 'Ready to Quote';
            actionReason = 'Ready to quote';
          } else {
            status = 'Waiting Supplier';
          }
        }

        const docs = docsMap[inq.id] || [];

        unifiedMap.set(inq.id, {
          id: inq.id,
          inquiryId: inq.id,
          pricingOptionId: selectedOpt?.id || null,
          inquiryNumber: inq.inquiry_number,
          aceerpNo: inq.aceerp_no || '-',
          customerName: inq.company_name,
          productName: inq.product_name,
          specification: selectedOpt?.specification || inq.specification || '',
          quantity: inq.quantity || '1,000 kg',
          requestedMake,
          offeredMake,
          supplierName,
          sourcePrice,
          sourceCurrency,
          unit: 'KG',
          moq: selectedOpt?.moq || '500 kg',
          availability: (selectedOpt?.availability as any) || 'available',
          leadTime: selectedOpt?.lead_time || '2-3 weeks',
          remarks: inq.remarks || selectedOpt?.remark || '',
          containerType,
          packingType,
          capacityKg,
          effectiveInrRate: effectiveInr,
          indiaMarginPct,
          freightUsdPerKg,
          dutyPct,
          insurancePct,
          clearanceUsd,
          indonesiaMarginPct,
          purchasePriceUsdPerKg: calcResult.purchasePriceUsdPerKg,
          landedCostUsd: calcResult.landedCostUsd,
          suggestedQuoteUsd: calcResult.suggestedQuoteUsd,
          quotePrice: calcResult.quotePrice,
          quoteCurrency,
          quoteFxIdr: 16200,
          totalQuoteAmount: calcResult.totalQuoteAmount,
          calcBreakdown: calcResult.calcBreakdown,
          status,
          actionReason,
          rowClassification: 'standard_inquiry',
          actionStatus: inq.kunal_price_status || 'requested',
          emailDate: inq.created_at,
          isAiPrepared: false,
          alternativeMakeDetected: Boolean(
            requestedMake && offeredMake && requestedMake.toLowerCase() !== offeredMake.toLowerCase(),
          ),
          needsManualLink: false,
          documents: docs,
          docActionNotice: null,
          evidence: {
            hasRealGmail: false,
            sourceType: 'crm',
            from: null,
            to: null,
            cc: null,
            subject: null,
            date: inq.created_at,
            quote: null,
            why: null,
            bodyText: null,
            bodyHtml: null,
            threadId: null,
            messageId: null,
            attachments: docs.map((d: any) => ({
              id: d.id,
              filename: d.filename,
              documentType: d.documentType,
              matchStatus: d.status,
              storagePath: d.storagePath,
              storageBucket: d.storageBucket,
            })),
          },
          sourceType: (selectedOpt?.source_type as any) || 'india',
          rawExtractionRows: [],
          allPricingOptions: inqOpts,
        });
      }

      // Second pass: Merge ALL AI Reviews (Requirement #1, #2, #3, #5)
      for (const rev of aiReviews || []) {
        const raw = rev.raw_result || {};
        if (raw.fastFiltered) continue;

        // Collect all extracted product blocks from raw_result or rev
        const allRawRows: any[] = Array.isArray(raw.extractionRows) && raw.extractionRows.length > 0
          ? raw.extractionRows
          : (Array.isArray(raw.pricing_rows) && raw.pricing_rows.length > 0
              ? raw.pricing_rows
              : (rev.product_name || rev.source_price != null
                  ? [{
                      product_name: rev.product_name || '',
                      offered_make: rev.offered_make || '',
                      source_price: rev.source_price ?? null,
                      source_currency: rev.source_currency || 'INR',
                      unit: 'KG',
                      matched_inquiry_id: rev.matched_inquiry_id || raw.suggestedInquiryId || null,
                    }]
                  : []));

        const detectedDocs = raw.detectedDocuments || [];
        const sourceEmail = raw.sourceEmail || {};
        const realMessageId = rev.gmail_message_id || sourceEmail.messageId || null;
        const realThreadId = rev.gmail_thread_id || sourceEmail.threadId || null;
        const hasRealGmail = Boolean(realMessageId);

        // Requirement #5: Reconcile detected documents against real crm_product_documents & storage_path
        const reconciledDocs = detectedDocs.map((d: any) => {
          const fname = (d.filename || '').toLowerCase();
          const matchedDoc = (realMessageId && docsByMessageId[realMessageId]?.find((x: any) => x.filename.toLowerCase() === fname))
            || docsByFilename[fname]
            || (d.storagePath ? { storagePath: d.storagePath, isStored: true } : null);

          const realStoragePath = matchedDoc?.storagePath || d.storagePath || null;
          const isStored = Boolean(realStoragePath);
          const isUnavailable = Boolean(d.matchStatus === 'FILE UNAVAILABLE / NEEDS REVIEW' || d.isUnavailable);

          return {
            id: matchedDoc?.id,
            documentType: d.documentType || 'DOC',
            filename: d.filename || 'attachment.pdf',
            storagePath: realStoragePath,
            storageBucket: d.storageBucket || 'crm-documents',
            batchNumber: d.batchNumber,
            status: (isStored ? 'MATCHED' : (isUnavailable ? 'FILE UNAVAILABLE / NEEDS REVIEW' : 'FILE NOT STORED / NEEDS RE-SYNC')) as any,
            isStored,
            isUnavailable,
          };
        });

        // Determine Document Action Notice
        let docActionNotice: string | null = null;
        const hasAmbiguousDoc = detectedDocs.some((d: any) => d.matchStatus === 'AMBIGUOUS');
        const hasReviewDoc = detectedDocs.some((d: any) => d.matchStatus === 'REVIEW');
        const hasUnstoredDoc = reconciledDocs.some((d: any) => !d.isStored && !d.isUnavailable);
        const hasUnavailableDoc = reconciledDocs.some((d: any) => d.isUnavailable);
        if (hasAmbiguousDoc) {
          docActionNotice = 'Document match ambiguous';
        } else if (hasReviewDoc || hasUnavailableDoc) {
          docActionNotice = 'COA needs review';
        } else if (hasUnstoredDoc) {
          docActionNotice = 'Attachment needs re-sync';
        }

        const evidenceObj = {
          hasRealGmail,
          sourceType: hasRealGmail ? ('gmail' as const) : ('crm' as const),
          from: hasRealGmail ? (sourceEmail.from || rev.from_email || null) : null,
          to: hasRealGmail ? (sourceEmail.to || null) : null,
          cc: hasRealGmail ? (sourceEmail.cc || null) : null,
          subject: hasRealGmail ? (sourceEmail.subject || rev.subject || null) : null,
          date: hasRealGmail ? (sourceEmail.date || rev.email_date || null) : null,
          quote: raw.evidence?.sourceQuote || raw.summary || null,
          why: raw.evidence?.why || rev.summary || null,
          bodyText: hasRealGmail ? (sourceEmail.bodyText || raw.evidence?.sourceQuote || raw.summary || null) : null,
          bodyHtml: hasRealGmail ? (sourceEmail.bodyHtml || null) : null,
          threadId: realThreadId,
          messageId: realMessageId,
          attachments: (hasRealGmail && sourceEmail.attachments?.length > 0)
            ? sourceEmail.attachments.map((a: any) => {
                const fname = (a.filename || '').toLowerCase();
                const matchedDoc = (realMessageId && docsByMessageId[realMessageId]?.find((x: any) => x.filename.toLowerCase() === fname)) || docsByFilename[fname];
                const realPath = matchedDoc?.storagePath || a.storagePath || null;
                return {
                  attachmentId: a.attachmentId,
                  filename: a.filename,
                  mimeType: a.mimeType,
                  size: a.size,
                  documentType: a.documentType,
                  matchStatus: realPath ? (a.matchStatus || 'MATCHED') : 'FILE NOT STORED / NEEDS RE-SYNC',
                  storagePath: realPath,
                };
              })
            : (reconciledDocs.length > 0 ? reconciledDocs : []),
        };

        const matchedIndices = new Set<number>();

        // Try to match each extracted block to active inquiries in unifiedMap
        allRawRows.forEach((block, idx) => {
          let targetInqId = block.matched_inquiry_id || null;
          if (!targetInqId && (rev.matched_inquiry_id || raw.suggestedInquiryId)) {
            const candidate = unifiedMap.get(rev.matched_inquiry_id || raw.suggestedInquiryId);
            if (candidate && isProductMatch(candidate.productName, block.product_name)) {
              targetInqId = candidate.id;
            }
          }
          if (!targetInqId) {
            for (const [inqId, row] of unifiedMap.entries()) {
              if (row.inquiryId && isProductMatch(row.productName, block.product_name)) {
                targetInqId = inqId;
                break;
              }
            }
          }

          if (targetInqId && unifiedMap.has(targetInqId)) {
            matchedIndices.add(idx);
            const targetRow = unifiedMap.get(targetInqId)!;
            targetRow.aiReviewId = rev.id;
            targetRow.isAiPrepared = true;
            targetRow.rowClassification = 'inquiry_enriched';
            targetRow.actionStatus = rev.action_status;
            targetRow.emailDate = rev.email_date;
            targetRow.rawExtractionRows = allRawRows;

            if (hasRealGmail || !targetRow.evidence) {
              targetRow.evidence = evidenceObj;
            }

            const extractedPrice = block.source_price ?? null;
            const extractedCurrency: 'INR' | 'USD' = block.source_currency === 'USD' ? 'USD' : 'INR';
            const extractedMake = block.offered_make || '';

            // Rule 5: Do not use AI Gmail extraction to overwrite a manually entered supplier value.
            const hasManualSourcePrice = targetRow.sourcePrice !== null && targetRow.sourcePrice > 0;
            if (extractedPrice !== null && !hasManualSourcePrice) {
              targetRow.sourcePrice = extractedPrice;
              targetRow.sourceCurrency = extractedCurrency;
              const calc = calculateCanonicalPricing(
                extractedPrice,
                extractedCurrency,
                targetRow.quantity,
                loadedConfig,
                {
                  containerType: targetRow.containerType,
                  packingType: targetRow.packingType,
                  effectiveInrRate: targetRow.effectiveInrRate,
                  indiaMarginPct: targetRow.indiaMarginPct,
                  freightUsdPerKg: targetRow.freightUsdPerKg,
                  dutyPct: targetRow.dutyPct,
                  insurancePct: targetRow.insurancePct,
                  clearanceUsd: targetRow.clearanceUsd,
                  indonesiaMarginPct: targetRow.indonesiaMarginPct,
                  quotePriceOverride: targetRow.quotePrice,
                },
              );
              targetRow.purchasePriceUsdPerKg = calc.purchasePriceUsdPerKg;
              targetRow.landedCostUsd = calc.landedCostUsd;
              targetRow.suggestedQuoteUsd = calc.suggestedQuoteUsd;
              targetRow.quotePrice = calc.quotePrice;
              targetRow.totalQuoteAmount = calc.totalQuoteAmount;
              targetRow.calcBreakdown = calc.calcBreakdown;
            }

            if (extractedMake && !targetRow.offeredMake) {
              targetRow.offeredMake = extractedMake;
            }
            if (raw.alternativeMake?.detected) {
              targetRow.alternativeMakeDetected = true;
            }
            if (reconciledDocs.length > 0) {
              targetRow.documents = [
                ...targetRow.documents,
                ...reconciledDocs,
              ];
              if (docActionNotice) {
                targetRow.docActionNotice = docActionNotice;
              }
            }

            const isPendingReview = rev.action_status === 'pending_review' || rev.action_status === 'needs_manual_link';
            if (isPendingReview && targetRow.status !== 'Completed') {
              targetRow.status = 'Needs Review';
              if (raw.needsManualLink) {
                targetRow.needsManualLink = true;
                targetRow.actionReason = 'Inquiry match ambiguous';
              } else if (raw.alternativeMake?.detected) {
                targetRow.actionReason = 'Confirm make';
              } else if (docActionNotice) {
                targetRow.actionReason = docActionNotice;
              } else {
                targetRow.actionReason = 'Supplier price received - pending quote';
              }
            }
          }
        });

        // Unmatched blocks or non-pricing reviews -> create unlinked rows
        const unmatchedBlocks = allRawRows.filter((_, idx) => !matchedIndices.has(idx));
        const blocksToEmit = unmatchedBlocks.length > 0 ? unmatchedBlocks : (allRawRows.length === 0 ? [{}] : []);

        blocksToEmit.forEach((block: any, uIdx: number) => {
          const isNoAction = rev.action_status === 'no_action' || rev.ai_type === 'No Action' || rev.ai_type === 'NO ACTION';
          const isAltMake = rev.ai_type === 'ALTERNATIVE MAKE' || Boolean(raw.alternativeMake?.detected);
          const extractedPrice = block.source_price ?? rev.source_price ?? null;
          const extractedCurrency: 'INR' | 'USD' = (block.source_currency || rev.source_currency) === 'USD' ? 'USD' : 'INR';
          const extractedMake = block.offered_make || rev.offered_make || '';
          const isDocOnly = (rev.ai_type === 'DOCUMENT RECEIVED' || (reconciledDocs.length > 0 && extractedPrice === null)) && !isNoAction;
          const isNewPrice = extractedPrice !== null && !isNoAction;

          let rowClassification: UnifiedPricingRow['rowClassification'] = 'needs_review';
          let status: PricingRowStatus = 'Needs Review';
          let actionReason = 'Inquiry match ambiguous';

          if (isNoAction) {
            rowClassification = 'no_action';
            status = 'Archived';
            actionReason = 'Archived / Ignored';
          } else if (isAltMake) {
            rowClassification = 'alt_make';
            status = 'Needs Review';
            actionReason = 'Alternative make offered';
          } else if (isDocOnly) {
            rowClassification = 'doc_only';
            status = 'Needs Review';
            actionReason = 'Document received';
          } else if (isNewPrice) {
            rowClassification = 'new_unmatched';
            status = 'Needs Review';
            actionReason = 'New supplier pricing';
          }

          const fallbackId = blocksToEmit.length > 1 ? `ai-${rev.id}-${uIdx}` : `ai-${rev.id}`;
          const calc = calculateCanonicalPricing(
            extractedPrice,
            extractedCurrency,
            '1000',
            loadedConfig,
            {
              containerType: '20ft',
              packingType: 'mixed',
              effectiveInrRate: effectiveInr,
              indiaMarginPct: 4.0,
              freightUsdPerKg: 0.08,
              dutyPct: 4.0,
              insurancePct: 0.1,
              clearanceUsd: clearance20ft,
              indonesiaMarginPct: 4.0,
            },
          );

          unifiedMap.set(fallbackId, {
            id: fallbackId,
            aiReviewId: rev.id,
            inquiryId: null,
            inquiryNumber: raw.matchedInquiryNumber || 'UNLINKED',
            aceerpNo: raw.aceerpNo || '-',
            customerName: isNoAction ? 'Archived Mail' : 'Pending Link',
            productName: block.product_name || rev.product_name || 'Chemical Item',
            specification: block.specification || '',
            quantity: block.quantity ? `${block.quantity} ${block.unit || 'kg'}` : '1,000 kg',
            requestedMake: block.preferred_manufacturer || '',
            offeredMake: extractedMake,
            supplierName: rev.from_email || '',
            sourcePrice: extractedPrice,
            sourceCurrency: extractedCurrency,
            unit: block.unit || 'KG',
            moq: block.quantity ? `${block.quantity} ${block.unit || 'kg'}` : '500 kg',
            availability: block.availability || block.delivery || 'available',
            leadTime: block.lead_time || '2 weeks',
            remarks: rev.summary || '',
            containerType: '20ft',
            packingType: 'mixed',
            capacityKg: capacity20ftMixed,
            effectiveInrRate: effectiveInr,
            indiaMarginPct: 4.0,
            freightUsdPerKg: 0.08,
            dutyPct: 4.0,
            insurancePct: 0.1,
            clearanceUsd: clearance20ft,
            indonesiaMarginPct: 4.0,
            purchasePriceUsdPerKg: calc.purchasePriceUsdPerKg,
            landedCostUsd: calc.landedCostUsd,
            suggestedQuoteUsd: calc.suggestedQuoteUsd,
            quotePrice: calc.quotePrice,
            quoteCurrency: 'USD',
            quoteFxIdr: 16200,
            totalQuoteAmount: calc.totalQuoteAmount,
            calcBreakdown: calc.calcBreakdown,
            status,
            actionReason,
            rowClassification,
            actionStatus: rev.action_status,
            emailDate: rev.email_date,
            isAiPrepared: true,
            alternativeMakeDetected: isAltMake,
            needsManualLink: !isNoAction,
            documents: reconciledDocs,
            docActionNotice: docActionNotice || (reconciledDocs.some((d: any) => !d.isStored) ? 'Attachment needs re-sync' : null),
            evidence: evidenceObj,
            sourceType: 'india',
            rawExtractionRows: allRawRows,
            allPricingOptions: [],
          });
        });
      }

      setRows(Array.from(unifiedMap.values()));
    } catch (err: any) {
      showToast({ type: 'error', title: 'Load Error', message: err.message || 'Failed to load pricing rows' });
    } finally {
      setLoading(false);
    }
  }, [computeNextWib]);

  useEffect(() => {
    loadData();
    loadMakeSuggestions().then(setMakeOptions);
  }, [loadData]);

  // Handle CHECK NOW button (normal scan)
  const handleCheckNow = async () => {
    if (isScanning || isScanning7Days) return;
    setIsScanning(true);
    try {
      const summary: AgentScanSummary = await runSapjGmailAgent({ maxMessages: 25 });
      setLastCheckedTime(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
      setNextCheckWibTime(computeNextWib());
      if (!summary.success || (summary.errors && summary.errors.length > 0)) {
        showToast({
          type: 'error',
          title: 'Background Agent Scan Failed',
          message: summary.errors?.join('; ') || summary.message || 'Processing failed for connected mailbox',
        });
      } else {
        const processed = summary.messages_processed ?? summary.scanned;
        const pricing = summary.pricing_detected ?? summary.pricing;
        const docs = summary.documents_detected ?? summary.documents;
        const needsRev = summary.needs_review ?? 0;
        showToast({
          type: 'success',
          title: 'Background Agent Scan Complete',
          message: `${processed} scanned • ${pricing} pricing • ${docs} docs • ${needsRev} needs review`,
        });
      }
      await loadData();
    } catch (err: any) {
      showToast({ type: 'error', title: 'Scan Failed', message: err.message || 'Check Now failed' });
    } finally {
      setIsScanning(false);
    }
  };

  // Handle CHECK LAST 7 DAYS button (Processes full 7-day mailbox automatically across safe batches)
  const handleCheckLast7Days = async () => {
    if (isScanning || isScanning7Days || isScanningHistorical) return;
    setIsScanning7Days(true);
    let batchCount = 0;
    let totalFound = 0;
    let totalProcessed = 0;
    let totalPricing = 0;
    let totalDocs = 0;
    let pageToken: string | undefined = undefined;
    let hasMore = true;

    try {
      while (hasMore) {
        batchCount += 1;
        setBatchProgress7Days({
          batch: batchCount,
          found: totalFound,
          processed: totalProcessed,
          remaining: 0,
        });

        const summary: AgentScanSummary = await runSapjGmailAgent({
          scanLast7Days: true,
          maxMessages: 50,
          pageToken,
        });

        if (!summary.success && summary.errors && summary.errors.length > 0) {
          showToast({
            type: 'error',
            title: `7-Day Scan Batch ${batchCount} Error`,
            message: summary.errors.join('; '),
          });
          break;
        }

        totalFound += summary.messages_found || 0;
        totalProcessed += summary.messages_processed ?? summary.scanned ?? 0;
        totalPricing += summary.pricing_detected ?? summary.pricing ?? 0;
        totalDocs += summary.documents_detected ?? summary.documents ?? 0;

        const remaining = summary.remaining ?? 0;
        setBatchProgress7Days({
          batch: batchCount,
          found: totalFound,
          processed: totalProcessed,
          remaining,
        });

        if (summary.has_more && summary.next_page_token) {
          pageToken = summary.next_page_token;
          hasMore = true;
        } else {
          hasMore = false;
          pageToken = undefined;
        }
      }

      setLastCheckedTime(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
      setNextCheckWibTime(computeNextWib());
      showToast({
        type: 'success',
        title: '7-Day Historical Scan Complete',
        message: `Completed ${batchCount} safe batches • ${totalProcessed} emails processed • ${totalPricing} pricing • ${totalDocs} docs`,
      });
      await loadData();
    } catch (err: any) {
      showToast({
        type: 'error',
        title: '7-Day Scan Failed',
        message: err.message || 'Check Last 7 Days failed',
      });
    } finally {
      setIsScanning7Days(false);
      setBatchProgress7Days(null);
    }
  };

  // ONE-TIME FULL HISTORICAL SCAN
  // Scans Kunal mailbox from earliest available Gmail history up to today in safe automatic batches
  const handleRunHistoricalScan = async () => {
    if (isScanning || isScanning7Days || isScanningHistorical) return;
    setIsScanningHistorical(true);

    let batchCount = 0;
    let totalFound = 0;
    let totalProcessed = 0;
    let totalPricing = 0;
    let totalPricingCreated = 0;
    let totalPricingEnriched = 0;
    let totalDocs = 0;
    let totalDocsStored = 0;
    let totalInquiriesMatched = 0;
    let totalNeedsReview = 0;
    let totalDuplicatesSkipped = 0;
    const allErrors: string[] = [];
    let minDateScanned: string | null = null;
    let maxDateScanned: string | null = null;
    let mailboxName = 'Kunal Mailbox';

    let pageToken: string | undefined = undefined;
    let hasMore = true;

    try {
      while (hasMore) {
        batchCount += 1;
        setHistoricalProgress({
          batch: batchCount,
          found: totalFound,
          processed: totalProcessed,
          pricingFound: totalPricing,
          pricingCreated: totalPricingCreated,
          pricingEnriched: totalPricingEnriched,
          docsFound: totalDocs,
          docsStored: totalDocsStored,
          inquiriesMatched: totalInquiriesMatched,
          needsReview: totalNeedsReview,
          duplicatesSkipped: totalDuplicatesSkipped,
          errors: allErrors,
          remaining: 0,
        });

        const summary: AgentScanSummary = await runSapjGmailAgent({
          fullHistoricalScan: true,
          maxMessages: 50,
          pageToken,
        });

        if (summary.mailbox && summary.mailbox !== 'unknown') {
          mailboxName = summary.mailbox;
        }

        if (summary.date_range_scanned?.min) {
          if (!minDateScanned || summary.date_range_scanned.min < minDateScanned) {
            minDateScanned = summary.date_range_scanned.min;
          }
        }
        if (summary.date_range_scanned?.max) {
          if (!maxDateScanned || summary.date_range_scanned.max > maxDateScanned) {
            maxDateScanned = summary.date_range_scanned.max;
          }
        }

        totalFound += summary.messages_found || 0;
        totalProcessed += summary.messages_processed ?? summary.scanned ?? 0;
        totalPricing += summary.pricing_detected ?? summary.pricing ?? 0;
        totalPricingCreated += summary.pricing_records_created ?? 0;
        totalPricingEnriched += summary.pricing_records_enriched ?? 0;
        totalDocs += summary.documents_detected ?? summary.documents ?? 0;
        totalDocsStored += summary.documents_stored ?? 0;
        totalInquiriesMatched += summary.inquiries_matched ?? 0;
        totalNeedsReview += summary.needs_review ?? 0;
        totalDuplicatesSkipped += summary.skipped_duplicate ?? 0;

        if (summary.errors && summary.errors.length > 0) {
          allErrors.push(...summary.errors);
        }

        const remaining = summary.remaining ?? 0;
        setHistoricalProgress({
          batch: batchCount,
          found: totalFound,
          processed: totalProcessed,
          pricingFound: totalPricing,
          pricingCreated: totalPricingCreated,
          pricingEnriched: totalPricingEnriched,
          docsFound: totalDocs,
          docsStored: totalDocsStored,
          inquiriesMatched: totalInquiriesMatched,
          needsReview: totalNeedsReview,
          duplicatesSkipped: totalDuplicatesSkipped,
          errors: allErrors,
          remaining,
        });

        if (summary.has_more && summary.next_page_token) {
          pageToken = summary.next_page_token;
          hasMore = true;
        } else {
          hasMore = false;
          pageToken = undefined;
        }
      }

      const dateRangeStr = minDateScanned && maxDateScanned
        ? `${new Date(minDateScanned).toLocaleDateString()} — ${new Date(maxDateScanned).toLocaleDateString()}`
        : 'Full Mailbox History';

      // Automatically run document recovery for newly detected documents
      try {
        await resyncHistoricalDocuments();
      } catch (docErr) {
        console.warn('Post-scan document recovery warning:', docErr);
      }

      // Requirement #6: All counts come from actual persisted records, not only in-memory counters
      const reconciledReport = await fetchHistoricalReconciliation(
        mailboxName,
        dateRangeStr,
        allErrors,
        totalDuplicatesSkipped,
      );

      setHistoricalReport(reconciledReport);

      showToast({
        type: 'success',
        title: 'Historical Scan Complete',
        message: `Processed ${reconciledReport.totalProcessed} historical emails: ${reconciledReport.aiPricingDetected} pricing, ${reconciledReport.documentsStored} docs stored, ${reconciledReport.documentsNeedingResync} need re-sync.`,
      });

      await loadData();
    } catch (err: any) {
      showToast({
        type: 'error',
        title: 'Historical Scan Error',
        message: err.message || 'Historical scan failed',
      });
    } finally {
      setIsScanningHistorical(false);
    }
  };

  const handleResyncDocuments = async () => {
    if (isScanning || isScanning7Days || isScanningHistorical || isResyncingDocs) return;
    setIsResyncingDocs(true);
    try {
      showToast({
        type: 'info',
        title: 'Document Re-Sync Started',
        message: 'Recovering unpersisted attachments from Gmail directly into Supabase Storage...',
      });
      const result = await resyncHistoricalDocuments();
      const reconciledReport = await fetchHistoricalReconciliation();
      setHistoricalReport(reconciledReport);
      await loadData();
      showToast({
        type: 'success',
        title: 'Document Re-Sync Complete',
        message: `Stored: ${result.documentsStored}, Linked: ${result.documentsLinked}, Needing Re-Sync: ${result.documentsNeedingResync}, Unavailable: ${result.documentsUnavailable}`,
      });
    } catch (err: any) {
      showToast({
        type: 'error',
        title: 'Document Re-Sync Failed',
        message: err.message || 'Failed to re-sync documents',
      });
    } finally {
      setIsResyncingDocs(false);
    }
  };

  // Status Counts
  const counts = useMemo(() => {
    const c = {
      needsAction: 0,
      priceReceived: 0,
      readyToQuote: 0,
      waitingSupplier: 0,
      completed: 0,
      total: rows.length,
    };
    for (const r of rows) {
      if (r.status === 'Completed') {
        c.completed++;
      } else if (r.status === 'Waiting Supplier') {
        c.waitingSupplier++;
      } else if (r.status === 'Price Received') {
        c.priceReceived++;
        c.needsAction++;
      } else if (r.status === 'Ready to Quote') {
        c.readyToQuote++;
        c.needsAction++;
      } else if (r.status === 'Needs Review') {
        c.needsAction++;
      }
    }
    return c;
  }, [rows]);

  // Unique Customers for filter dropdown
  const customerList = useMemo(() => {
    return Array.from(new Set(rows.map(r => r.customerName).filter(Boolean))).sort();
  }, [rows]);

  // Filtered rows for the Excel-like table
  const displayedRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter(r => {
      // Classification filter (Requirement #2)
      if (classificationFilter !== 'all' && r.rowClassification !== classificationFilter) {
        return false;
      }
      // Status filter
      if (statusFilter === 'Needs Action') {
        // EXCLUDE ordinary 'Waiting Supplier' and 'no_action' / 'Archived' rows from 'Needs Action'
        if (r.rowClassification === 'no_action' || r.status === 'Archived') return false;
        if (r.status !== 'Needs Review' && r.status !== 'Price Received' && r.status !== 'Ready to Quote') {
          return false;
        }
      } else if (statusFilter !== 'all' && r.status !== statusFilter) {
        return false;
      }
      // Customer filter
      if (customerFilter !== 'all' && r.customerName !== customerFilter) return false;
      // Source filter
      if (sourceFilter !== 'all' && r.sourceType !== sourceFilter) return false;
      // Search term
      if (q) {
        const hay = [
          r.inquiryNumber,
          r.aceerpNo,
          r.customerName,
          r.productName,
          r.requestedMake,
          r.offeredMake,
          r.supplierName,
          r.remarks,
        ].join(' ').toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [rows, statusFilter, customerFilter, sourceFilter, classificationFilter, search]);

  // Safe table pagination (Requirement #1: Avoid overloading DOM while allowing full access)
  const totalPages = Math.max(1, Math.ceil(displayedRows.length / pageSize));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const paginatedRows = useMemo(() => {
    const startIndex = (safePage - 1) * pageSize;
    return displayedRows.slice(startIndex, startIndex + pageSize);
  }, [displayedRows, safePage, pageSize]);

  // STABLE LOCAL DRAFT INPUT HANDLERS
  // Allows user to type "1", "1250", "4600.50" without losing focus or moving buckets
  const handleSourcePriceDraftChange = (id: string, textVal: string) => {
    // 1. Maintain local string draft exactly as typed
    setPriceDrafts(prev => ({
      ...prev,
      [id]: { ...prev[id], sourcePrice: textVal },
    }));

    // 2. Parse numeric value if valid
    const parsed = parseFloat(textVal);
    const validNum = !isNaN(parsed) && parsed > 0 ? parsed : null;

    // 3. Recalculate landed cost and quote price WITHOUT MODIFYING row.status
    setRows(current =>
      current.map(row => {
        if (row.id !== id) return row;
        const calc = calculateCanonicalPricing(
          validNum,
          row.sourceCurrency,
          row.quantity,
          config,
          {
            containerType: row.containerType,
            packingType: row.packingType,
            effectiveInrRate: row.effectiveInrRate,
            indiaMarginPct: row.indiaMarginPct,
            freightUsdPerKg: row.freightUsdPerKg,
            dutyPct: row.dutyPct,
            insurancePct: row.insurancePct,
            clearanceUsd: row.clearanceUsd,
            indonesiaMarginPct: row.indonesiaMarginPct,
            quotePriceOverride: row.quotePrice,
          },
        );

        return {
          ...row,
          sourcePrice: validNum,
          purchasePriceUsdPerKg: calc.purchasePriceUsdPerKg,
          landedCostUsd: calc.landedCostUsd,
          suggestedQuoteUsd: calc.suggestedQuoteUsd,
          quotePrice: row.quotePrice,
          totalQuoteAmount: row.quotePrice ? Math.round(row.quotePrice * (parseFloat(String(row.quantity || '0').replace(/[^0-9.]/g, '')) || 12000) * 100) / 100 : null,
          calcBreakdown: calc.calcBreakdown,
          // CRITICAL: DO NOT MODIFY row.status during typing!
        };
      }),
    );
  };

  const handleQuotePriceDraftChange = (id: string, textVal: string) => {
    setPriceDrafts(prev => ({
      ...prev,
      [id]: { ...prev[id], quotePrice: textVal },
    }));

    const parsed = parseFloat(textVal);
    const validNum = !isNaN(parsed) && parsed > 0 ? parsed : null;

    setRows(current =>
      current.map(row => {
        if (row.id !== id) return row;
        const qtyNum = parseFloat(String(row.quantity || '0').replace(/[^0-9.]/g, '')) || 12000;
        return {
          ...row,
          quotePrice: validNum,
          totalQuoteAmount: validNum ? Math.round(validNum * qtyNum * 100) / 100 : null,
          // CRITICAL: DO NOT MODIFY row.status during typing!
        };
      }),
    );
  };

  // Inline row updates (for assumptions, currency, unit, supplier, etc.)
  const updateRow = (id: string, patch: Partial<UnifiedPricingRow>) => {
    setRows(current =>
      current.map(row => {
        if (row.id !== id) return row;
        const merged = { ...row, ...patch };

        // Recalculate using canonical engine if assumptions or source parameters changed
        const calc = calculateCanonicalPricing(
          merged.sourcePrice,
          merged.sourceCurrency,
          merged.quantity,
          config,
          {
            containerType: merged.containerType,
            packingType: merged.packingType,
            effectiveInrRate: merged.effectiveInrRate,
            indiaMarginPct: merged.indiaMarginPct,
            freightUsdPerKg: merged.freightUsdPerKg,
            dutyPct: merged.dutyPct,
            insurancePct: merged.insurancePct,
            clearanceUsd: merged.clearanceUsd,
            indonesiaMarginPct: merged.indonesiaMarginPct,
            quotePriceOverride: 'quotePrice' in patch ? patch.quotePrice : merged.quotePrice,
          },
        );

        return {
          ...merged,
          purchasePriceUsdPerKg: calc.purchasePriceUsdPerKg,
          landedCostUsd: calc.landedCostUsd,
          suggestedQuoteUsd: calc.suggestedQuoteUsd,
          quotePrice: calc.quotePrice,
          totalQuoteAmount: calc.totalQuoteAmount,
          calcBreakdown: calc.calcBreakdown,
        };
      }),
    );
  };

  // Helper to delete temporary AI documents belonging to an exact source/option
  const deleteTemporaryDocumentsForSource = async (opts: {
    inquiryId?: string | null;
    pricingOptionId?: string | null;
    make?: string | null;
  }) => {
    try {
      let query = supabase
        .from('crm_product_documents')
        .select('id, storage_bucket, storage_path, is_permanent')
        .eq('is_permanent', false);

      if (opts.pricingOptionId) {
        query = query.eq('pricing_option_id', opts.pricingOptionId);
      } else if (opts.inquiryId && opts.make) {
        query = query.eq('inquiry_id', opts.inquiryId).ilike('make', opts.make);
      } else {
        return;
      }

      const { data: tempDocs, error } = await query;
      if (error || !tempDocs || tempDocs.length === 0) return;

      for (const d of tempDocs) {
        if (d.storage_path) {
          await supabase.storage
            .from(d.storage_bucket || 'crm-documents')
            .remove([d.storage_path]);
        }
        await supabase.from('crm_product_documents').delete().eq('id', d.id);
      }
    } catch (err) {
      console.warn('Failed to delete temporary documents:', err);
    }
  };

  // Switch alternate source option for an inquiry
  const handleSwitchPricingOption = (row: UnifiedPricingRow, opt: any) => {
    const nextPrice = opt.source_price != null ? Number(opt.source_price) : null;
    const nextCurrency: 'INR' | 'USD' = opt.source_currency === 'USD' ? 'USD' : 'INR';
    const nextMake = opt.offered_make || row.requestedMake || '';
    const nextSupplier = opt.supplier || '';
    const nextMoq = opt.moq || row.moq;
    const nextLeadTime = opt.lead_time || row.leadTime;
    const nextSpec = opt.specification || row.specification;
    const nextAvailability = (opt.availability as any) || row.availability;

    // Recalculate canonical pricing for new source
    let calc = {
      purchasePriceUsdPerKg: null as number | null,
      landedCostUsd: null as number | null,
      suggestedQuoteUsd: null as number | null,
      quotePrice: row.quotePrice,
      totalQuoteAmount: null as number | null,
      calcBreakdown: null as Record<string, number> | null,
    };

    if (nextPrice !== null && nextPrice > 0) {
      calc = calculateCanonicalPricing(
        nextPrice,
        nextCurrency,
        row.quantity,
        config,
        {
          containerType: row.containerType,
          packingType: row.packingType,
          effectiveInrRate: row.effectiveInrRate,
          indiaMarginPct: row.indiaMarginPct,
          freightUsdPerKg: row.freightUsdPerKg,
          dutyPct: row.dutyPct,
          insurancePct: row.insurancePct,
          clearanceUsd: row.clearanceUsd,
          indonesiaMarginPct: row.indonesiaMarginPct,
          quotePriceOverride: row.quotePrice,
        },
      );
    }

    setPriceDrafts(prev => ({
      ...prev,
      [row.id]: { ...prev[row.id], sourcePrice: nextPrice !== null ? String(nextPrice) : '' },
    }));

    updateRow(row.id, {
      pricingOptionId: opt.id || null,
      offeredMake: nextMake,
      sourcePrice: nextPrice,
      sourceCurrency: nextCurrency,
      supplierName: nextSupplier,
      moq: nextMoq,
      leadTime: nextLeadTime,
      specification: nextSpec,
      availability: nextAvailability,
      purchasePriceUsdPerKg: calc.purchasePriceUsdPerKg,
      landedCostUsd: calc.landedCostUsd,
      suggestedQuoteUsd: calc.suggestedQuoteUsd,
      totalQuoteAmount: calc.totalQuoteAmount,
      calcBreakdown: calc.calcBreakdown,
    });
  };

  // DELETE / IGNORE FROM NEED ACTION (Requirement #4)
  const handleIgnoreRow = async (row: UnifiedPricingRow) => {
    setIgnoringId(row.id);
    try {
      const now = new Date().toISOString();
      if (row.aiReviewId) {
        const { error } = await supabase
          .from('kunal_ai_email_reviews')
          .update({
            action_status: 'no_action',
            updated_at: now,
          })
          .eq('id', row.aiReviewId);
        if (error) console.warn('Ignore review update warning:', error);
      }

      // Delete temporary documents belonging ONLY to this exact AI row
      if (row.id.startsWith('review-') || row.aiReviewId) {
        await deleteTemporaryDocumentsForSource({
          inquiryId: row.inquiryId,
          pricingOptionId: row.pricingOptionId,
          make: row.offeredMake || row.requestedMake,
        });
      }

      // If unlinked review fallback row, remove it completely from rows
      if (row.id.startsWith('review-')) {
        setRows(prev => prev.filter(r => r.id !== row.id));
      } else {
        // Linked inquiry row: remove from Need Action by reverting to Waiting Supplier or Completed
        let nextStatus: PricingRowStatus = 'Waiting Supplier';
        if (row.quotePrice && row.quotePrice > 0) {
          nextStatus = 'Completed';
        }
        updateRow(row.id, {
          status: nextStatus,
          needsManualLink: false,
          actionReason: null,
        });
      }

      showToast({ type: 'info', title: 'Removed', message: `Item removed from Need Action.` });
    } catch (err: any) {
      showToast({ type: 'error', title: 'Action Failed', message: err.message || 'Could not ignore item' });
    } finally {
      setIgnoringId(null);
    }
  };

  // SAVE action (Explicit confirmation that transitions status)
  const handleSaveRow = async (row: UnifiedPricingRow) => {
    setSavingId(row.id);
    try {
      const targetInquiryId = row.inquiryId;
      if (!targetInquiryId) {
        showToast({ type: 'error', title: 'Inquiry Required', message: 'Please link an inquiry before saving.' });
        setSavingId(null);
        return;
      }

      const now = new Date().toISOString();

      // 1. Save pricing option correctly without invalid onConflict constraint
      let optionId = row.pricingOptionId;
      const optionPayload = {
        inquiry_id: targetInquiryId,
        source_type: row.sourceType || 'india',
        offered_make: row.offeredMake || row.requestedMake,
        source_price: row.sourcePrice,
        source_currency: row.sourceCurrency,
        specification: row.specification || null,
        availability: row.availability,
        document_status: row.documents.length > 0 ? 'received' : 'pending',
        supplier: row.supplierName,
        moq: row.moq,
        lead_time: row.leadTime,
        margin_pct: row.indonesiaMarginPct,
        selling_price: row.quotePrice,
        selling_currency: row.quoteCurrency,
        is_selected: true,
        updated_at: now,
      };

      // Unselect siblings under the same inquiry
      await supabase
        .from('crm_inquiry_pricing_options')
        .update({ is_selected: false })
        .eq('inquiry_id', targetInquiryId);

      if (optionId) {
        const { error: optUpdateErr } = await supabase
          .from('crm_inquiry_pricing_options')
          .update(optionPayload)
          .eq('id', optionId);
        if (optUpdateErr) console.warn('Pricing option update warning:', optUpdateErr);
      } else {
        const { data: newOpt, error: optInsertErr } = await supabase
          .from('crm_inquiry_pricing_options')
          .insert({
            ...optionPayload,
            created_by: profile?.id || null,
          })
          .select('id')
          .single();
        if (optInsertErr) console.warn('Pricing option insert warning:', optInsertErr);
        if (newOpt) {
          optionId = newOpt.id;
          updateRow(row.id, { pricingOptionId: optionId });
        }
      }

      // 2. Update CRM Inquiry with validated landed cost and quote price
      const isQuoteEntered = Boolean(row.quotePrice && row.quotePrice > 0);
      const hasCoaDoc = row.documents.some(d => d.documentType?.toUpperCase() === 'COA');
      const { error: inqErr } = await supabase
        .from('crm_inquiries')
        .update({
          purchase_price: row.landedCostUsd,
          offered_price: row.quotePrice,
          purchase_price_currency: 'USD',
          offered_price_currency: row.quoteCurrency,
          kunal_price_status: isQuoteEntered ? 'entered' : 'requested',
          price_ready: isQuoteEntered,
          quote_status: 'not_sent',
          supplier_name: row.offeredMake || row.requestedMake,
          remarks: row.remarks || null,
          source_status: row.sourcePrice ? 'received' : 'waiting',
          document_status: hasCoaDoc ? 'received' : (row.documents.length > 0 ? 'received' : 'pending'),
          updated_at: now,
        })
        .eq('id', targetInquiryId);

      if (inqErr) throw inqErr;

      // 3. Insert into pricing_ledger
      await Promise.resolve(
        supabase.from('pricing_ledger').insert({
          inquiry_id: targetInquiryId,
          aceerp_no: row.aceerpNo !== '-' ? row.aceerpNo : null,
          customer_name: row.customerName,
          product_name: row.productName,
          preferred_make: row.requestedMake,
          offered_make: row.offeredMake,
          source_price: row.sourcePrice,
          source_currency: row.sourceCurrency,
          purchase_price: row.landedCostUsd,
          selling_price: row.quotePrice,
          final_quoted_price: row.quotePrice,
          final_quote_currency: row.quoteCurrency,
          kunal_remark: row.remarks || null,
          final_selected_option_id: optionId || null,
          quoted_by: profile?.id || null,
          created_by: profile?.id || null,
          quote_date: now,
          updated_at: now,
        }),
      ).catch(() => {});

      // 4. Insert into CRM timeline
      await Promise.resolve(
        supabase.from('crm_inquiry_timeline').insert({
          inquiry_id: targetInquiryId,
          event_type: 'kunal_price_submitted',
          actor_id: profile?.id || null,
          actor_name: profile?.full_name || 'Kunal',
          description: `Kunal price saved: Landed USD ${row.landedCostUsd || '-'}, Quote ${row.quoteCurrency} ${row.quotePrice || '-'}`,
          metadata: {
            landedCostUsd: row.landedCostUsd,
            quotePrice: row.quotePrice,
            marginPct: row.indonesiaMarginPct,
          },
        }),
      ).catch(() => {});

      // 5. Update AI review if linked
      if (row.aiReviewId) {
        await supabase
          .from('kunal_ai_email_reviews')
          .update({
            action_status: 'price_saved',
            matched_inquiry_id: targetInquiryId,
            updated_at: now,
          })
          .eq('id', row.aiReviewId);
      }

      // Direct transition to Completed when Actual Quoted Price exists.
      // If unquoted:
      //   - if supplier price exists, it remains in 'Needs Review' (so it stays in 'NEED ACTION NOW' ready for quote)
      //   - if no supplier price exists, it remains in 'Waiting Supplier'.
      let nextStatus: PricingRowStatus;
      if (isQuoteEntered) {
        nextStatus = 'Completed';
      } else if (row.sourcePrice && row.sourcePrice > 0) {
        nextStatus = 'Needs Review';
      } else {
        nextStatus = 'Waiting Supplier';
      }
      updateRow(row.id, {
        status: nextStatus,
        needsManualLink: false,
        actionReason: isQuoteEntered ? null : 'Pending quoted price',
      });
      showToast({ type: 'success', title: 'Saved', message: `Pricing saved for ${row.inquiryNumber}.` });
    } catch (err: any) {
      showToast({ type: 'error', title: 'Save Failed', message: err.message || 'Could not save pricing' });
    } finally {
      setSavingId(null);
    }
  };

  // SEND TO TEAM action
  const handleSendToTeam = (row: UnifiedPricingRow) => {
    setReplyTarget({
      inquiry: {
        id: row.inquiryId || '',
        inquiry_number: row.inquiryNumber,
        aceerp_no: row.aceerpNo !== '-' ? row.aceerpNo : null,
        product_name: row.productName,
        supplier_name: row.requestedMake,
        quantity: row.quantity,
        remarks: row.remarks,
      },
      draft: {
        india_price: row.sourcePrice ? String(row.sourcePrice) : '',
        india_price_currency: row.sourceCurrency,
        purchase_price: row.landedCostUsd ? String(row.landedCostUsd) : '',
        purchase_currency: 'USD',
        offered_price: row.quotePrice ? String(row.quotePrice) : '',
        offered_currency: row.quoteCurrency,
        kunal_remark: row.remarks,
      },
      sourceOption: {
        offered_make: row.offeredMake,
      },
    });
  };

  return (
    <Layout>
      <datalist id="make-options-list">
        {makeOptions.map(m => (
          <option key={m} value={m} />
        ))}
      </datalist>

      <div className="p-4 md:p-6 space-y-3">
        {/* ============================================================ */}
        {/* 1. TOP BAR & BACKGROUND AGENT CONTROLS */}
        {/* ============================================================ */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 bg-white p-3 rounded-lg border border-gray-200 shadow-2xs">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-bold text-gray-900 tracking-tight">KUNAL PRICING AI</h1>
              <span className="text-[10px] font-semibold uppercase px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 tracking-wider">
                Canonical Engine
              </span>
            </div>
            <p className="text-xs text-gray-500 mt-0.5">
              AI prepares pricing from supplier emails. Review assumptions, verify documents, and save.
            </p>
          </div>

          {/* Supplier AI Scan Controls */}
          <div className="flex items-center gap-2 bg-gray-50 border border-gray-200 px-3 py-1.5 rounded-md text-xs">
            <div className="text-right hidden sm:block pr-2 border-r border-gray-200">
              <div className="text-[11px] text-gray-500">
                Last checked: <span className="font-medium text-gray-700">{lastCheckedTime || 'Recent'}</span>
              </div>
              <div className="text-[10px] text-gray-400">
                Next check: <span className="font-semibold text-blue-600">{nextCheckWibTime}</span>
              </div>
            </div>

            <div className="flex items-center gap-1.5">
              <button
                id="btn-check-now"
                onClick={handleCheckNow}
                disabled={isScanning || isScanning7Days || isScanningHistorical}
                className="px-2.5 py-1 bg-blue-600 hover:bg-blue-700 text-white rounded font-medium text-xs flex items-center gap-1.5 shadow-2xs disabled:opacity-50 transition-colors cursor-pointer"
                title="Run immediate Gmail Agent scan"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isScanning ? 'animate-spin' : ''}`} />
                <span>{isScanning ? 'Scanning...' : 'CHECK NOW'}</span>
              </button>

              <button
                id="btn-check-7-days"
                onClick={handleCheckLast7Days}
                disabled={isScanning || isScanning7Days || isScanningHistorical}
                className="px-2.5 py-1 bg-white hover:bg-gray-100 text-gray-700 border border-gray-300 rounded font-medium text-xs flex items-center gap-1.5 shadow-2xs disabled:opacity-50 transition-colors cursor-pointer"
                title="Scan last 7 days of supplier emails with automatic batch continuation"
              >
                <Calendar className={`w-3.5 h-3.5 text-blue-600 ${isScanning7Days ? 'animate-spin' : ''}`} />
                <span>{isScanning7Days ? 'Scanning 7D...' : 'Check Last 7 Days'}</span>
              </button>

              <button
                id="btn-run-historical-scan"
                onClick={handleRunHistoricalScan}
                disabled={isScanning || isScanning7Days || isScanningHistorical || isResyncingDocs}
                className="px-2.5 py-1 bg-amber-50 hover:bg-amber-100 text-amber-900 border border-amber-300 rounded font-semibold text-xs flex items-center gap-1.5 shadow-2xs disabled:opacity-50 transition-colors cursor-pointer"
                title="Run one-time historical scan across all mailbox history"
              >
                <Clock className={`w-3.5 h-3.5 text-amber-700 ${isScanningHistorical ? 'animate-spin' : ''}`} />
                <span>{isScanningHistorical ? 'Scanning History...' : 'RUN FULL HISTORICAL SCAN — ONCE'}</span>
              </button>

              <button
                id="btn-resync-documents"
                onClick={handleResyncDocuments}
                disabled={isScanning || isScanning7Days || isScanningHistorical || isResyncingDocs}
                className="px-2.5 py-1 bg-indigo-50 hover:bg-indigo-100 text-indigo-900 border border-indigo-300 rounded font-semibold text-xs flex items-center gap-1.5 shadow-2xs disabled:opacity-50 transition-colors cursor-pointer"
                title="Automatically re-sync and verify historical email attachments"
              >
                <RefreshCw className={`w-3.5 h-3.5 text-indigo-700 ${isResyncingDocs ? 'animate-spin' : ''}`} />
                <span>{isResyncingDocs ? 'Re-Syncing Docs...' : 'RE-SYNC DOCUMENTS'}</span>
              </button>
            </div>
          </div>
        </div>

        {/* 7-Day Multi-Batch Progress Banner */}
        {batchProgress7Days && (
          <div className="bg-blue-50 border border-blue-200 rounded p-2.5 text-xs flex items-center justify-between text-blue-900 shadow-2xs">
            <div className="flex items-center gap-2">
              <RefreshCw className="w-4 h-4 animate-spin text-blue-600" />
              <span className="font-bold">7-Day Mailbox Catch-Up:</span>
              <span className="font-mono bg-blue-100 px-1.5 py-0.5 rounded text-[11px]">Batch {batchProgress7Days.batch}</span>
              <span>•</span>
              <span>Found: <b>{batchProgress7Days.found}</b></span>
              <span>•</span>
              <span>Processed: <b>{batchProgress7Days.processed}</b></span>
              <span>•</span>
              <span>Remaining: <b>{batchProgress7Days.remaining}</b></span>
            </div>
            <span className="text-[10px] text-blue-700 italic">Processing safe batches automatically until finished...</span>
          </div>
        )}

        {/* Full Historical Scan Live Progress Banner */}
        {historicalProgress && (
          <div className="bg-amber-50 border border-amber-300 rounded p-3 text-xs space-y-2 text-amber-950 shadow-2xs">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 font-bold text-amber-900">
                <Clock className="w-4 h-4 text-amber-700 animate-spin" />
                <span>Full Historical Email Scan in Progress — Batch {historicalProgress.batch}</span>
              </div>
              <span className="text-[11px] font-mono text-amber-800 bg-amber-100 px-2 py-0.5 rounded">
                Remaining in Mailbox: ~{historicalProgress.remaining}
              </span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-8 gap-2 text-center text-[10px]">
              <div className="bg-white p-1 rounded border border-amber-200">
                <div className="text-gray-500 font-medium">Found</div>
                <div className="font-bold text-gray-900 text-xs">{historicalProgress.found}</div>
              </div>
              <div className="bg-white p-1 rounded border border-amber-200">
                <div className="text-gray-500 font-medium">Processed</div>
                <div className="font-bold text-blue-700 text-xs">{historicalProgress.processed}</div>
              </div>
              <div className="bg-white p-1 rounded border border-amber-200">
                <div className="text-gray-500 font-medium">Pricing Found</div>
                <div className="font-bold text-green-700 text-xs">{historicalProgress.pricingFound}</div>
              </div>
              <div className="bg-white p-1 rounded border border-amber-200">
                <div className="text-gray-500 font-medium">Enriched</div>
                <div className="font-bold text-green-700 text-xs">{historicalProgress.pricingEnriched}</div>
              </div>
              <div className="bg-white p-1 rounded border border-amber-200">
                <div className="text-gray-500 font-medium">Docs Stored</div>
                <div className="font-bold text-purple-700 text-xs">{historicalProgress.docsStored}</div>
              </div>
              <div className="bg-white p-1 rounded border border-amber-200">
                <div className="text-gray-500 font-medium">Inq. Matched</div>
                <div className="font-bold text-blue-900 text-xs">{historicalProgress.inquiriesMatched}</div>
              </div>
              <div className="bg-white p-1 rounded border border-amber-200">
                <div className="text-gray-500 font-medium">Needs Review</div>
                <div className="font-bold text-amber-800 text-xs">{historicalProgress.needsReview}</div>
              </div>
              <div className="bg-white p-1 rounded border border-amber-200">
                <div className="text-gray-500 font-medium">Duplicates</div>
                <div className="font-bold text-gray-600 text-xs">{historicalProgress.duplicatesSkipped}</div>
              </div>
            </div>
          </div>
        )}

        {/* ============================================================ */}
        {/* 2. STATUS TABS & SEARCH FILTERS */}
        {/* ============================================================ */}
        <div className="space-y-2">
          {/* Main Workflow Tabs */}
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            {/* Primary Flow Tabs */}
            <button
              onClick={() => { setStatusFilter('Needs Action'); setPage(1); }}
              className={`px-3 py-1.5 rounded-md font-semibold transition-colors flex items-center gap-2 ${
                statusFilter === 'Needs Action'
                  ? 'bg-amber-600 text-white shadow-2xs'
                  : 'bg-white text-gray-700 hover:bg-gray-100 border border-gray-200'
              }`}
            >
              <AlertCircle className="w-3.5 h-3.5" />
              <span>NEED ACTION NOW</span>
              <span className={`text-[10px] px-1.5 py-0.2 rounded-full ${
                statusFilter === 'Needs Action' ? 'bg-amber-800 text-white' : 'bg-amber-100 text-amber-800'
              }`}>
                {counts.needsAction}
              </span>
            </button>

            <button
              onClick={() => { setStatusFilter('Waiting Supplier'); setPage(1); }}
              className={`px-3 py-1.5 rounded-md font-semibold transition-colors flex items-center gap-1.5 ${
                statusFilter === 'Waiting Supplier'
                  ? 'bg-blue-600 text-white shadow-2xs'
                  : 'bg-white text-gray-700 hover:bg-gray-100 border border-gray-200'
              }`}
            >
              <span>Waiting Supplier</span>
              <span className="text-[10px] opacity-75 font-semibold">({counts.waitingSupplier})</span>
            </button>

            <button
              onClick={() => { setStatusFilter('Completed'); setPage(1); }}
              className={`px-3 py-1.5 rounded-md font-semibold transition-colors flex items-center gap-1.5 ${
                statusFilter === 'Completed'
                  ? 'bg-green-700 text-white shadow-2xs'
                  : 'bg-white text-gray-700 hover:bg-gray-100 border border-gray-200'
              }`}
            >
              <span>Completed</span>
              <span className="text-[10px] opacity-75 font-semibold">({counts.completed})</span>
            </button>

            <button
              onClick={() => { setStatusFilter('all'); setPage(1); }}
              className={`px-2.5 py-1.5 rounded-md font-medium transition-colors flex items-center gap-1.5 ${
                statusFilter === 'all'
                  ? 'bg-gray-800 text-white shadow-2xs'
                  : 'bg-white text-gray-600 hover:bg-gray-100 border border-gray-200'
              }`}
            >
              <span>All ({counts.total})</span>
            </button>

            {/* Informational Sub-filters */}
            <div className="h-4 w-px bg-gray-300 mx-1 hidden sm:block" />
            <span className="text-[10px] text-gray-400 font-semibold uppercase hidden md:inline">Filters:</span>

            <button
              onClick={() => { setStatusFilter('Price Received'); setPage(1); }}
              className={`px-2 py-1 rounded text-[11px] font-medium transition-colors flex items-center gap-1 ${
                statusFilter === 'Price Received'
                  ? 'bg-slate-700 text-white shadow-2xs'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200 border border-gray-200'
              }`}
              title="Informational filter: inquiries where supplier price has been received"
            >
              <span>Price Received</span>
              <span className="text-[10px] opacity-75 font-semibold">({counts.priceReceived})</span>
            </button>

            <button
              onClick={() => { setStatusFilter('Ready to Quote'); setPage(1); }}
              className={`px-2 py-1 rounded text-[11px] font-medium transition-colors flex items-center gap-1 ${
                statusFilter === 'Ready to Quote'
                  ? 'bg-slate-700 text-white shadow-2xs'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200 border border-gray-200'
              }`}
              title="Informational filter: inquiries ready for customer quotation"
            >
              <span>Ready to Quote</span>
              <span className="text-[10px] opacity-75 font-semibold">({counts.readyToQuote})</span>
            </button>
          </div>

          {/* Search & Select Bar */}
          <div className="flex flex-wrap items-center gap-2 bg-white p-2 rounded border border-gray-200 text-xs">
            <div className="relative flex-1 min-w-[220px]">
              <Search className="w-3.5 h-3.5 absolute left-2.5 top-2 text-gray-400" />
              <input
                id="pricing-search"
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search inquiry / ACE ERP / product / customer / make..."
                className="w-full pl-8 pr-2 py-1 border border-gray-200 rounded text-xs focus:ring-1 focus:ring-blue-500 focus:outline-none"
              />
            </div>

            <select
              aria-label="Customer Filter"
              value={customerFilter}
              onChange={e => setCustomerFilter(e.target.value)}
              className="border border-gray-200 rounded px-2 py-1 text-xs bg-white focus:outline-none"
            >
              <option value="all">All Customers</option>
              {customerList.map(c => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>

            <select
              aria-label="Classification Filter"
              value={classificationFilter}
              onChange={e => {
                setClassificationFilter(e.target.value);
                setPage(1);
              }}
              className="border border-gray-200 rounded px-2 py-1 text-xs bg-white focus:outline-none font-medium"
            >
              <option value="all">All Classifications</option>
              <option value="inquiry_enriched">Enriched Inquiries</option>
              <option value="new_unmatched">New Unmatched Pricing</option>
              <option value="alt_make">Alternative Makes</option>
              <option value="needs_review">Needs Review</option>
              <option value="doc_only">Document Only</option>
              <option value="no_action">No Action / Archived</option>
            </select>

            {(search || customerFilter !== 'all' || sourceFilter !== 'all' || classificationFilter !== 'all') && (
              <button
                onClick={() => {
                  setSearch('');
                  setCustomerFilter('all');
                  setSourceFilter('all');
                  setClassificationFilter('all');
                  setPage(1);
                }}
                className="text-[11px] text-blue-600 hover:underline px-1 cursor-pointer"
              >
                Clear Filters
              </button>
            )}
          </div>
        </div>

        {/* ============================================================ */}
        {/* 3. OPERATIONAL PRICING SPREADSHEET TABLE */}
        {/* ============================================================ */}
        <div className="bg-white border border-gray-200 rounded-lg shadow-2xs overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs border-collapse">
              <thead className="bg-gray-50 border-b border-gray-200 text-gray-600 font-semibold text-[10px] uppercase tracking-wider select-none">
                <tr>
                  <th className="py-2 px-2 w-32 border-r border-gray-200">INQUIRY / ACE</th>
                  <th className="py-2 px-2 w-36 border-r border-gray-200">CUSTOMER</th>
                  <th className="py-2 px-2 w-48 border-r border-gray-200">PRODUCT</th>
                  <th className="py-2 px-2 w-28 border-r border-gray-200">REQ. MAKE</th>
                  <th className="py-2 px-2 w-32 border-r border-gray-200">OFFERED MAKE</th>
                  <th className="py-2 px-2 w-32 border-r border-gray-200">SUPPLIER</th>
                  <th className="py-2 px-2 w-24 text-right border-r border-gray-200 bg-amber-50/40 text-amber-950 font-bold">
                    SUPPLIER PRICE
                  </th>
                  <th className="py-2 px-1 text-center w-16 border-r border-gray-200">CURR/UNIT</th>
                  <th className="py-2 px-2 w-20 text-right bg-blue-50/60 text-blue-950 border-r border-gray-200 font-bold" title="Calculated Landed Cost per kg">
                    LANDED
                  </th>
                  <th className="py-2 px-2 w-24 text-right bg-emerald-50/60 text-emerald-950 border-r border-gray-200 font-bold" title="Canonical Pricing Engine Recommended Quote">
                    SUGGESTED QUOTE
                  </th>
                  <th className="py-2 px-2.5 w-28 text-right bg-green-50/60 text-green-950 border-r border-gray-200 font-bold" title="Actual Customer Quoted Price">
                    QUOTED PRICE
                  </th>
                  <th className="py-2 px-2 text-center w-32 border-r border-gray-200">STATUS / REASON</th>
                  <th className="py-2 px-2 text-center w-24">ACTIONS</th>
                </tr>
              </thead>

              <tbody className="divide-y divide-gray-100 font-normal text-gray-800">
                {loading ? (
                  <tr>
                    <td colSpan={13} className="py-12 text-center text-gray-400">
                      <RefreshCw className="w-5 h-5 animate-spin mx-auto mb-2 text-blue-600" />
                      Loading pricing worksheet...
                    </td>
                  </tr>
                ) : displayedRows.length === 0 ? (
                  <tr>
                    <td colSpan={13} className="py-12 text-center">
                      <CheckCircle2 className="w-8 h-8 text-green-500 mx-auto mb-2 opacity-80" />
                      <p className="text-sm font-semibold text-gray-700">No rows in this view.</p>
                      <p className="text-xs text-gray-500 mt-1">
                        All actionable items are up to date. Click [ CHECK NOW ] to scan supplier emails.
                      </p>
                    </td>
                  </tr>
                ) : (
                  paginatedRows.map(row => {
                    const isExpanded = expandedId === row.id;
                    const sourcePriceDraft =
                      priceDrafts[row.id]?.sourcePrice ?? (row.sourcePrice != null ? String(row.sourcePrice) : '');
                    const quotePriceDraft =
                      priceDrafts[row.id]?.quotePrice ?? (row.quotePrice != null ? String(row.quotePrice) : '');

                    return (
                      <Fragment key={row.id}>
                        {/* Main Grid Row */}
                        <tr
                          className={`transition-colors text-[11px] group ${
                            isExpanded
                              ? 'bg-gray-50/90 font-medium'
                              : row.isAiPrepared
                              ? 'bg-amber-50/20 hover:bg-amber-50/40'
                              : 'hover:bg-gray-50'
                          }`}
                        >
                          {/* ACE / Inquiry Cell */}
                          <td className="py-1 px-2 border-r border-gray-200">
                            <div className="flex items-center gap-1 font-mono font-medium">
                              {row.inquiryId ? (
                                <button
                                  type="button"
                                  className="text-blue-700 hover:underline cursor-pointer text-left font-mono font-medium"
                                  onClick={() => setEvidenceDrawerRow(row)}
                                  title="Click to preview email & source evidence"
                                >
                                  {row.inquiryNumber}
                                </button>
                              ) : (
                                <select
                                  aria-label="Link Inquiry"
                                  value=""
                                  onChange={e => {
                                    const inq = allInquiriesList.find(i => i.id === e.target.value);
                                    if (inq) {
                                      updateRow(row.id, {
                                        inquiryId: inq.id,
                                        inquiryNumber: inq.inquiry_number,
                                        aceerpNo: inq.aceerp_no || '-',
                                        customerName: inq.company_name,
                                        needsManualLink: false,
                                        actionReason: null,
                                      });
                                    }
                                  }}
                                  className="w-full text-[10px] bg-amber-50 text-amber-800 border border-amber-300 rounded px-1 py-0.5"
                                >
                                  <option value="">Link Inquiry ▼</option>
                                  {allInquiriesList.map(i => (
                                    <option key={i.id} value={i.id}>
                                      {i.inquiry_number} ({i.aceerp_no || 'No ACE'}) - {i.product_name.slice(0, 16)}
                                    </option>
                                  ))}
                                </select>
                              )}
                            </div>
                            <div className="text-[10px] text-gray-500 font-mono">{row.aceerpNo}</div>
                          </td>

                          {/* Customer */}
                          <td
                            className="py-1 px-2 border-r border-gray-200 truncate max-w-[150px]"
                            title={row.customerName}
                          >
                            <input
                              value={row.customerName}
                              onChange={e => updateRow(row.id, { customerName: e.target.value })}
                              className="w-full bg-transparent border-none text-[11px] p-0 focus:outline-none focus:ring-1 focus:ring-blue-400 rounded truncate"
                            />
                          </td>

                          {/* Product */}
                          <td
                            className="py-1 px-2 border-r border-gray-200 truncate max-w-[180px] cursor-pointer hover:bg-amber-50/40"
                            title="Click to preview email & source evidence"
                            onClick={() => setEvidenceDrawerRow(row)}
                          >
                            <div className="font-medium text-gray-900 truncate hover:text-blue-700">{row.productName}</div>
                            <div className="flex items-center gap-1 mt-0.5">
                              {row.rowClassification === 'inquiry_enriched' && (
                                <span className="inline-flex items-center gap-0.5 text-[9px] font-semibold text-blue-700 bg-blue-100/70 border border-blue-200 px-1 py-0.2 rounded" title="Existing inquiry enriched by AI">
                                  <Sparkles className="w-2.5 h-2.5" /> Enriched
                                </span>
                              )}
                              {row.rowClassification === 'new_unmatched' && (
                                <span className="inline-flex items-center gap-0.5 text-[9px] font-semibold text-amber-800 bg-amber-100 border border-amber-300 px-1 py-0.2 rounded" title="New unmatched AI pricing result">
                                  <Sparkles className="w-2.5 h-2.5" /> Unmatched
                                </span>
                              )}
                              {row.rowClassification === 'alt_make' && (
                                <span className="inline-flex items-center text-[9px] font-semibold text-purple-700 bg-purple-100 border border-purple-200 px-1 py-0.2 rounded" title="Alternative make detected">
                                  Alt Make
                                </span>
                              )}
                              {row.rowClassification === 'doc_only' && (
                                <span className="inline-flex items-center text-[9px] font-semibold text-cyan-800 bg-cyan-100 border border-cyan-200 px-1 py-0.2 rounded" title="Document-only email">
                                  Doc Only
                                </span>
                              )}
                              {row.rowClassification === 'needs_review' && (
                                <span className="inline-flex items-center text-[9px] font-semibold text-amber-900 bg-amber-100 border border-amber-300 px-1 py-0.2 rounded" title="Needs review">
                                  Needs Review
                                </span>
                              )}
                              {row.rowClassification === 'no_action' && (
                                <span className="inline-flex items-center text-[9px] font-semibold text-gray-500 bg-gray-100 border border-gray-200 px-1 py-0.2 rounded" title="Archived / Ignored">
                                  Archived
                                </span>
                              )}
                              {row.isAiPrepared && !row.rowClassification && (
                                <span className="inline-flex items-center gap-0.5 text-[9px] text-amber-700 bg-amber-100 px-1 rounded">
                                  <Sparkles className="w-2.5 h-2.5" /> AI Prepared
                                </span>
                              )}
                            </div>
                          </td>

                          {/* Requested Make */}
                          <td
                            className="py-1 px-2 border-r border-gray-200 truncate max-w-[110px]"
                            title={row.requestedMake}
                          >
                            <span className="text-gray-600">{row.requestedMake || '-'}</span>
                          </td>

                          {/* Offered Make */}
                          <td className="py-1 px-2 border-r border-gray-200">
                            <div className="flex items-center gap-1">
                              <input
                                list="make-options-list"
                                value={row.offeredMake}
                                onChange={e => updateRow(row.id, { offeredMake: e.target.value })}
                                className="w-full bg-transparent border border-gray-200 rounded px-1 py-0.5 text-[11px] focus:outline-none focus:bg-white focus:ring-1 focus:ring-blue-400"
                                placeholder="Make..."
                              />
                              {row.alternativeMakeDetected && (
                                <span
                                  className="text-[9px] bg-purple-100 text-purple-700 font-bold px-1 rounded flex-shrink-0"
                                  title="Alternative make detected"
                                >
                                  ALT
                                </span>
                              )}
                            </div>
                          </td>

                          {/* Supplier */}
                          <td className="py-1 px-2 border-r border-gray-200">
                            <input
                              value={row.supplierName}
                              onChange={e => updateRow(row.id, { supplierName: e.target.value })}
                              className="w-full bg-transparent border border-gray-200 rounded px-1 py-0.5 text-[11px] focus:outline-none focus:bg-white focus:ring-1 focus:ring-blue-400"
                              placeholder="Supplier..."
                            />
                          </td>

                          {/* SUPPLIER PRICE (Rock-solid local string draft input) */}
                          <td className="py-1 px-1.5 border-r border-gray-200 text-right bg-amber-50/20">
                            <input
                              type="text"
                              inputMode="decimal"
                              value={sourcePriceDraft}
                              onChange={e => handleSourcePriceDraftChange(row.id, e.target.value)}
                              className="w-20 text-right font-mono font-bold text-gray-900 border border-gray-200 rounded px-1.5 py-0.5 bg-white focus:outline-none focus:ring-1 focus:ring-blue-500 shadow-2xs"
                              placeholder="0.00"
                            />
                          </td>

                          {/* Currency & Unit */}
                          <td className="py-1 px-1 border-r border-gray-200 text-center">
                            <div className="flex items-center justify-center gap-0.5">
                              <select
                                aria-label="Currency"
                                value={row.sourceCurrency}
                                onChange={e => updateRow(row.id, { sourceCurrency: e.target.value as any })}
                                className="text-[10px] bg-transparent font-medium border-none p-0 focus:outline-none cursor-pointer"
                              >
                                <option value="INR">INR</option>
                                <option value="USD">USD</option>
                              </select>
                              <span className="text-gray-300">/</span>
                              <select
                                aria-label="Unit"
                                value={row.unit}
                                onChange={e => updateRow(row.id, { unit: e.target.value })}
                                className="text-[10px] bg-transparent font-medium border-none p-0 focus:outline-none cursor-pointer"
                              >
                                <option value="KG">KG</option>
                                <option value="MT">MT</option>
                              </select>
                            </div>
                          </td>

                          {/* LANDED COST (Real Canonical calculateFCL Output) */}
                          <td className="py-1 px-2 border-r border-gray-200 text-right font-mono font-bold bg-blue-50/40 text-blue-950">
                            {row.landedCostUsd !== null ? `$${row.landedCostUsd.toFixed(2)}` : '—'}
                          </td>

                          {/* SUGGESTED QUOTE (Canonical Pricing Engine Recommendation) */}
                          <td className="py-1 px-2 border-r border-gray-200 text-right font-mono font-bold bg-emerald-50/40 text-emerald-950">
                            {row.suggestedQuoteUsd !== null ? `$${row.suggestedQuoteUsd.toFixed(2)}` : '—'}
                          </td>

                          {/* ACTUAL QUOTED PRICE (Approved Customer Quoted Price) */}
                          <td className="py-1 px-1.5 border-r border-gray-200 text-right bg-green-50/40">
                            <div className="flex items-center justify-end gap-1">
                              <span className="text-[10px] font-semibold text-green-800">{row.quoteCurrency || 'USD'}</span>
                              <input
                                type="text"
                                inputMode="decimal"
                                value={quotePriceDraft}
                                onChange={e => handleQuotePriceDraftChange(row.id, e.target.value)}
                                className="w-18 text-right font-mono font-bold text-green-950 border border-green-300 rounded px-1.5 py-0.5 bg-white focus:outline-none focus:ring-1 focus:ring-green-500 shadow-2xs"
                                placeholder="—"
                                title="Actual Customer Quoted Price"
                              />
                              {row.suggestedQuoteUsd !== null && !quotePriceDraft && (
                                <button
                                  type="button"
                                  onClick={() => handleQuotePriceDraftChange(row.id, String(row.suggestedQuoteUsd))}
                                  className="text-[9px] text-emerald-800 hover:text-emerald-950 bg-emerald-100 hover:bg-emerald-200 px-1 py-0.5 rounded font-bold cursor-pointer"
                                  title={`Use Suggested Quote: $${row.suggestedQuoteUsd.toFixed(2)}`}
                                >
                                  Use
                                </button>
                              )}
                            </div>
                          </td>

                          {/* Status & Reason Badge */}
                          <td
                            className="py-1 px-2 border-r border-gray-200 text-center cursor-pointer hover:bg-gray-100/70"
                            onClick={() => setEvidenceDrawerRow(row)}
                            title="Click to preview email & source evidence"
                          >
                            <div className="flex flex-col items-center gap-0.5">
                              <span
                                className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold whitespace-nowrap ${
                                  row.status === 'Needs Review'
                                    ? 'bg-amber-100 text-amber-800'
                                    : row.status === 'Price Received'
                                    ? 'bg-blue-100 text-blue-800'
                                    : row.status === 'Ready to Quote'
                                    ? 'bg-indigo-100 text-indigo-800'
                                    : row.status === 'Completed'
                                    ? 'bg-green-100 text-green-800'
                                    : 'bg-gray-100 text-gray-600'
                                }`}
                              >
                                {row.status}
                              </span>
                              {row.actionReason && (
                                <span className="text-[9px] text-amber-700 font-medium">
                                  {row.actionReason}
                                </span>
                              )}
                            </div>
                          </td>

                          {/* Actions */}
                          <td className="py-1 px-2 text-center">
                            <div className="flex items-center justify-center gap-1">
                              <button
                                onClick={() => setEvidenceDrawerRow(row)}
                                className="p-1 hover:bg-blue-50 text-blue-600 rounded cursor-pointer"
                                title="Preview Email & AI Evidence"
                              >
                                <Eye className="w-3.5 h-3.5" />
                              </button>
                              <button
                                onClick={() => setExpandedId(isExpanded ? null : row.id)}
                                className="p-1 hover:bg-gray-200 text-gray-600 rounded cursor-pointer"
                                title="Expand Details"
                              >
                                {isExpanded ? (
                                  <ChevronDown className="w-4 h-4 text-blue-600" />
                                ) : (
                                  <ChevronRight className="w-4 h-4" />
                                )}
                              </button>
                              <button
                                onClick={() => handleSaveRow(row)}
                                disabled={savingId === row.id}
                                className="p-1 text-blue-600 hover:bg-blue-100 rounded cursor-pointer disabled:opacity-50"
                                title="Save Pricing"
                              >
                                <Save className="w-3.5 h-3.5" />
                              </button>
                              <button
                                onClick={() => handleIgnoreRow(row)}
                                disabled={ignoringId === row.id}
                                className="p-1 text-red-500 hover:bg-red-50 rounded cursor-pointer disabled:opacity-50"
                                title="Remove from Need Action"
                              >
                                {ignoringId === row.id ? (
                                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                                ) : (
                                  <Trash2 className="w-3.5 h-3.5" />
                                )}
                              </button>
                            </div>
                          </td>
                        </tr>

                        {/* ============================================================ */}
                        {/* 4. EXPANDED PRICING WORKSHEET & CANONICAL CALCULATOR */}
                        {/* ============================================================ */}
                        {isExpanded && (
                          <tr className="bg-gray-50 border-b-2 border-blue-200">
                            <td colSpan={13} className="p-3">
                              <div className="bg-white border border-gray-200 rounded-lg p-3 shadow-2xs space-y-3">
                                {/* Grid Layout: Supplier Source Rate | Real Import Calculation | Quote & Actions */}
                                <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
                                  {/* Column A: SOURCE PRICE / RATE WORKSHEET */}
                                  <div className="border border-gray-200 rounded-md p-2.5 bg-gray-50/50 space-y-2">
                                    <div className="text-[11px] font-bold text-gray-800 uppercase tracking-wide flex items-center justify-between">
                                      <span>Supplier Rate Worksheet</span>
                                      {row.evidence && (
                                        <button
                                          onClick={() => setEvidenceDrawerRow(row)}
                                          className="text-[10px] text-blue-600 hover:underline flex items-center gap-1 cursor-pointer"
                                        >
                                          <Eye className="w-3 h-3" />
                                          View Email & Evidence
                                        </button>
                                      )}
                                    </div>

                                    {/* Alternate Sourcing Options (Multiple Sources under SAME CRM Inquiry) */}
                                    {row.allPricingOptions && row.allPricingOptions.length > 0 && (
                                      <div className="bg-blue-50/60 border border-blue-200 rounded p-1.5 space-y-1">
                                        <div className="text-[10px] font-bold text-blue-900 flex items-center justify-between">
                                          <span>Sourcing Options ({row.allPricingOptions.length}):</span>
                                          <span className="text-[9px] text-blue-600 font-normal">Click to switch active price & source</span>
                                        </div>
                                        <div className="flex flex-wrap gap-1.5">
                                          {row.allPricingOptions.map((opt: any) => {
                                            const isCurrent = opt.id
                                              ? opt.id === row.pricingOptionId
                                              : (opt.offered_make === row.offeredMake && Number(opt.source_price) === Number(row.sourcePrice));
                                            return (
                                              <button
                                                key={opt.id || `${opt.offered_make}-${opt.source_price}`}
                                                type="button"
                                                onClick={() => handleSwitchPricingOption(row, opt)}
                                                className={`px-2 py-0.5 rounded text-[11px] font-medium border cursor-pointer transition-all ${
                                                  isCurrent
                                                    ? 'bg-blue-600 text-white border-blue-700 shadow-2xs font-semibold'
                                                    : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-100 hover:border-gray-400'
                                                }`}
                                              >
                                                {opt.offered_make || 'Unknown'} • {opt.source_currency || 'INR'} {Number(opt.source_price || 0).toLocaleString()}
                                                {opt.specification ? ` (${opt.specification})` : ''}
                                                {isCurrent ? ' ✓ Active' : ''}
                                              </button>
                                            );
                                          })}
                                        </div>
                                      </div>
                                    )}

                                    {/* Alternative Make Alert Banner */}
                                    {row.alternativeMakeDetected && (
                                      <div className="bg-purple-50 border border-purple-200 p-2 rounded text-xs space-y-1">
                                        <div className="font-semibold text-purple-900 flex items-center gap-1">
                                          <AlertCircle className="w-3.5 h-3.5 text-purple-600" />
                                          Alternative Make Detected
                                        </div>
                                        <div className="text-[11px] text-purple-800">
                                          Requested:{' '}
                                          <span className="font-medium">{row.requestedMake || 'None'}</span> • Offered:{' '}
                                          <span className="font-medium">{row.offeredMake}</span>
                                        </div>
                                        <div className="flex gap-1.5 pt-0.5">
                                          <button
                                            onClick={() => updateRow(row.id, { alternativeMakeDetected: false })}
                                            className="px-2 py-0.5 bg-purple-600 hover:bg-purple-700 text-white rounded text-[10px] font-medium cursor-pointer"
                                          >
                                            USE ALTERNATIVE MAKE
                                          </button>
                                          <button
                                            onClick={() =>
                                              updateRow(row.id, {
                                                offeredMake: row.requestedMake,
                                                alternativeMakeDetected: false,
                                              })
                                            }
                                            className="px-2 py-0.5 bg-white border border-purple-300 text-purple-800 hover:bg-purple-50 rounded text-[10px] font-medium cursor-pointer"
                                          >
                                            KEEP REQUESTED MAKE
                                          </button>
                                        </div>
                                      </div>
                                    )}

                                    <div className="grid grid-cols-2 gap-2 text-xs">
                                      <div>
                                        <label className="text-[10px] text-gray-500 font-medium">Supplier Rate</label>
                                        <input
                                          type="text"
                                          inputMode="decimal"
                                          value={sourcePriceDraft}
                                          onChange={e => handleSourcePriceDraftChange(row.id, e.target.value)}
                                          className="w-full border border-gray-200 rounded px-1.5 py-1 text-xs font-mono font-semibold bg-white"
                                          placeholder="3650"
                                        />
                                      </div>
                                      <div>
                                        <label className="text-[10px] text-gray-500 font-medium">Currency & Unit</label>
                                        <div className="flex gap-1">
                                          <select
                                            value={row.sourceCurrency}
                                            onChange={e => updateRow(row.id, { sourceCurrency: e.target.value as any })}
                                            className="w-1/2 border border-gray-200 rounded px-1 py-1 text-xs bg-white font-bold"
                                          >
                                            <option value="INR">INR</option>
                                            <option value="USD">USD</option>
                                          </select>
                                          <select
                                            value={row.unit}
                                            onChange={e => updateRow(row.id, { unit: e.target.value })}
                                            className="w-1/2 border border-gray-200 rounded px-1 py-1 text-xs bg-white font-bold"
                                          >
                                            <option value="KG">KG</option>
                                            <option value="MT">MT</option>
                                          </select>
                                        </div>
                                      </div>
                                      <div>
                                        <label className="text-[10px] text-gray-500 font-medium">Supplier Name</label>
                                        <input
                                          value={row.supplierName}
                                          onChange={e => updateRow(row.id, { supplierName: e.target.value })}
                                          className="w-full border border-gray-200 rounded px-1.5 py-1 text-xs bg-white"
                                        />
                                      </div>
                                      <div>
                                        <label className="text-[10px] text-gray-500 font-medium">Availability</label>
                                        <select
                                          value={row.availability}
                                          onChange={e => updateRow(row.id, { availability: e.target.value as any })}
                                          className="w-full border border-gray-200 rounded px-1.5 py-1 text-xs bg-white"
                                        >
                                          <option value="available">Available</option>
                                          <option value="partial">Partial</option>
                                          <option value="na">Not Available</option>
                                        </select>
                                      </div>
                                    </div>

                                    {/* Document Checklist & Upload Section */}
                                    <div className="pt-2 border-t border-gray-200 space-y-2">
                                      <div className="text-[10px] text-gray-500 font-semibold flex items-center justify-between">
                                        <div className="flex items-center gap-1.5">
                                          <FileText className="w-3.5 h-3.5 text-blue-600" />
                                          <span>Product Documents & Checklist</span>
                                        </div>
                                        <div className="flex items-center gap-2">
                                          {row.docActionNotice && (
                                            <span className="text-amber-700 font-medium">
                                              {row.docActionNotice}
                                            </span>
                                          )}
                                          <button
                                            type="button"
                                            onClick={() => {
                                              if (uploadingDocRowId === row.id) {
                                                setUploadingDocRowId(null);
                                                setUploadDocFile(null);
                                              } else {
                                                setUploadingDocRowId(row.id);
                                                setUploadDocType('COA');
                                                setUploadDocFile(null);
                                              }
                                            }}
                                            className="px-2 py-0.5 bg-blue-50 hover:bg-blue-100 text-blue-700 border border-blue-200 rounded text-[10px] font-bold flex items-center gap-1 cursor-pointer transition-colors"
                                          >
                                            <Plus className="w-3 h-3" />
                                            <span>ADD DOCUMENT</span>
                                          </button>
                                        </div>
                                      </div>

                                      {/* Checklist Badges */}
                                      <div className="flex flex-wrap gap-1">
                                        {MANUAL_DOC_TYPES.map(docType => {
                                          const found = row.documents.find(
                                            d => d.documentType.toUpperCase() === docType.toUpperCase(),
                                          );
                                          const isMatched = found?.status === 'MATCHED';
                                          const isReview = found?.status === 'REVIEW';
                                          const isAmbiguous = found?.status === 'AMBIGUOUS';

                                          return (
                                            <span
                                              key={docType}
                                              className={`px-1.5 py-0.5 rounded text-[10px] font-bold flex items-center gap-0.5 border ${
                                                isMatched
                                                  ? 'bg-green-50 text-green-700 border-green-200'
                                                  : isReview
                                                  ? 'bg-amber-50 text-amber-800 border-amber-300'
                                                  : isAmbiguous
                                                  ? 'bg-purple-50 text-purple-700 border-purple-200'
                                                  : 'bg-gray-100 text-gray-400 border-gray-200'
                                              }`}
                                            >
                                              {isMatched ? '✓' : isReview ? '⚠️' : isAmbiguous ? '❓' : '✗'} {docType}
                                            </span>
                                          );
                                        })}
                                      </div>

                                      {/* Inline Upload Form */}
                                      {uploadingDocRowId === row.id && (
                                        <div className="bg-blue-50/70 border border-blue-200 rounded p-2 text-xs space-y-2">
                                          <div className="flex items-center justify-between text-[11px] font-bold text-blue-900">
                                            <div className="flex items-center gap-1">
                                              <Upload className="w-3.5 h-3.5 text-blue-700" />
                                              <span>Upload Document for {row.inquiryNumber}</span>
                                            </div>
                                            <button
                                              type="button"
                                              onClick={() => {
                                                setUploadingDocRowId(null);
                                                setUploadDocFile(null);
                                              }}
                                              className="text-gray-400 hover:text-gray-600 cursor-pointer"
                                            >
                                              <X className="w-3.5 h-3.5" />
                                            </button>
                                          </div>

                                          {/* Auto-associated context notice */}
                                          <div className="bg-white/90 border border-blue-200 rounded px-2 py-1 text-[10px] text-gray-700 flex flex-wrap gap-x-3 gap-y-0.5 shadow-2xs">
                                            <span><strong className="text-gray-900">Inquiry:</strong> {row.inquiryNumber}</span>
                                            <span><strong className="text-gray-900">Product:</strong> {row.productName}</span>
                                            <span><strong className="text-gray-900">Source:</strong> {row.offeredMake || row.requestedMake || 'General'}</span>
                                            {row.specification && <span><strong className="text-gray-900">Spec:</strong> {row.specification}</span>}
                                          </div>

                                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                                            <div>
                                              <label className="text-[10px] text-gray-600 font-semibold block mb-0.5">Document Type</label>
                                              <select
                                                value={uploadDocType}
                                                onChange={e => setUploadDocType(e.target.value)}
                                                className="w-full border border-gray-300 rounded px-2 py-1 text-xs bg-white font-medium"
                                              >
                                                {MANUAL_DOC_TYPES.map(t => (
                                                  <option key={t} value={t}>{t}</option>
                                                ))}
                                              </select>
                                            </div>

                                            <div>
                                              <label className="text-[10px] text-gray-600 font-semibold block mb-0.5">Select File (PDF / Image)</label>
                                              <input
                                                type="file"
                                                onChange={e => {
                                                  if (e.target.files?.[0]) setUploadDocFile(e.target.files[0]);
                                                }}
                                                className="w-full border border-gray-300 rounded px-1.5 py-0.5 text-xs bg-white file:mr-2 file:py-0.5 file:px-2 file:rounded file:border-0 file:text-[10px] file:font-semibold file:bg-blue-100 file:text-blue-700 cursor-pointer"
                                              />
                                            </div>
                                          </div>

                                          <div className="flex justify-end gap-1.5 pt-1">
                                            <button
                                              type="button"
                                              onClick={() => {
                                                setUploadingDocRowId(null);
                                                setUploadDocFile(null);
                                              }}
                                              className="px-2 py-1 bg-white border border-gray-300 text-gray-700 rounded text-[11px] hover:bg-gray-50 cursor-pointer"
                                            >
                                              Cancel
                                            </button>
                                            <button
                                              type="button"
                                              disabled={!uploadDocFile || isUploadingDoc}
                                              onClick={() => handleUploadDocument(row)}
                                              className="px-3 py-1 bg-blue-600 hover:bg-blue-700 text-white rounded text-[11px] font-semibold flex items-center gap-1 shadow-2xs disabled:opacity-50 cursor-pointer"
                                            >
                                              <Upload className="w-3 h-3" />
                                              <span>{isUploadingDoc ? 'Uploading...' : 'Save & Attach'}</span>
                                            </button>
                                          </div>
                                        </div>
                                      )}

                                      {/* Uploaded Documents List */}
                                      {row.documents.length > 0 && (
                                        <div className="space-y-1 pt-1">
                                          <div className="text-[10px] font-bold text-gray-600 uppercase">Attached Documents ({row.documents.length}):</div>
                                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                                            {row.documents.map((doc, idx) => (
                                              <div
                                                key={doc.id || idx}
                                                className="bg-white border border-gray-200 rounded p-1.5 flex items-center justify-between gap-1 text-[11px]"
                                              >
                                                <div className="flex items-center gap-1.5 min-w-0">
                                                  <span className="font-bold text-[9px] bg-blue-50 text-blue-700 border border-blue-200 px-1 rounded flex-shrink-0">
                                                    {doc.documentType}
                                                  </span>
                                                  {(doc as any).make && (
                                                    <span className="text-[9px] bg-gray-100 text-gray-700 border border-gray-200 px-1 rounded flex-shrink-0">
                                                      {(doc as any).make}
                                                    </span>
                                                  )}
                                                  {(doc as any).specification && (
                                                    <span className="text-[9px] bg-purple-50 text-purple-700 border border-purple-200 px-1 rounded flex-shrink-0">
                                                      {(doc as any).specification}
                                                    </span>
                                                  )}
                                                  {(doc as any).isPermanent && (
                                                    <span className="text-[8px] bg-emerald-50 text-emerald-700 border border-emerald-200 px-1 rounded flex-shrink-0 font-medium">
                                                      Banked
                                                    </span>
                                                  )}
                                                  <span className="truncate text-gray-800 font-medium" title={doc.filename}>
                                                    {doc.filename}
                                                  </span>
                                                  {doc.storagePath ? (
                                                    <span className="text-[9px] text-green-700 font-semibold flex-shrink-0">
                                                      ✓ Uploaded
                                                    </span>
                                                  ) : (
                                                    <span className="text-[9px] text-amber-700 font-semibold flex-shrink-0 bg-amber-50 px-1 rounded border border-amber-200">
                                                      FILE NOT STORED / NEEDS RE-SYNC
                                                    </span>
                                                  )}
                                                </div>

                                                <div className="flex items-center gap-1 flex-shrink-0">
                                                  <button
                                                    type="button"
                                                    onClick={() => handleOpenDocument(doc.storagePath, doc.filename, false)}
                                                    className="px-1.5 py-0.5 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded text-[10px] flex items-center gap-0.5 cursor-pointer"
                                                    title="View document"
                                                  >
                                                    <Eye className="w-3 h-3" />
                                                    <span>View</span>
                                                  </button>
                                                  <button
                                                    type="button"
                                                    onClick={() => handleOpenDocument(doc.storagePath, doc.filename, true)}
                                                    className="px-1.5 py-0.5 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded text-[10px] flex items-center gap-0.5 cursor-pointer"
                                                    title="Download document"
                                                  >
                                                    <Download className="w-3 h-3" />
                                                    <span>Get</span>
                                                  </button>
                                                </div>
                                              </div>
                                            ))}
                                          </div>
                                        </div>
                                      )}
                                    </div>
                                  </div>

                                  {/* Column B: IMPORT CALCULATION (Real PriceCalculator Logic) */}
                                  <div className="border border-blue-200 rounded-md p-2.5 bg-blue-50/20 space-y-2">
                                    <div className="text-[11px] font-bold text-blue-950 uppercase tracking-wide flex items-center justify-between">
                                      <div className="flex items-center gap-1.5">
                                        <span>Import Calculation (FCL)</span>
                                        <button
                                          type="button"
                                          onClick={() => setImportDataModalProduct(row.productName)}
                                          className="text-[10px] bg-blue-100 hover:bg-blue-200 text-blue-800 font-semibold px-2 py-0.5 rounded flex items-center gap-1 cursor-pointer transition-colors"
                                          title="View historical customs import data for this product"
                                        >
                                          <Database className="w-3 h-3" />
                                          <span>VIEW IMPORT DATA</span>
                                        </button>
                                      </div>
                                      <span className="text-[10px] text-blue-700 font-semibold">
                                        20ft Mixed • 12,000 kg
                                      </span>
                                    </div>

                                    <div className="grid grid-cols-2 gap-2 text-xs">
                                      <div>
                                        <label className="text-[10px] text-gray-500 font-medium">
                                          Purchase USD / kg
                                        </label>
                                        <div className="border border-gray-200 rounded px-1.5 py-1 text-xs bg-gray-50 font-mono font-medium text-gray-700">
                                          {row.purchasePriceUsdPerKg !== null
                                            ? `$${row.purchasePriceUsdPerKg.toFixed(2)}`
                                            : '— (auto)'}
                                        </div>
                                      </div>

                                      <div>
                                        <label className="text-[10px] text-gray-500 font-medium">
                                          Effective INR Rate
                                        </label>
                                        <input
                                          type="number"
                                          step="0.1"
                                          value={row.effectiveInrRate}
                                          onChange={e =>
                                            updateRow(row.id, {
                                              effectiveInrRate: parseFloat(e.target.value) || 91,
                                            })
                                          }
                                          className="w-full border border-gray-200 rounded px-1.5 py-1 text-xs bg-white font-mono"
                                        />
                                      </div>

                                      <div>
                                        <label className="text-[10px] text-gray-500 font-medium">
                                          India Margin %
                                        </label>
                                        <input
                                          type="number"
                                          step="0.5"
                                          value={row.indiaMarginPct}
                                          onChange={e =>
                                            updateRow(row.id, {
                                              indiaMarginPct: parseFloat(e.target.value) || 0,
                                            })
                                          }
                                          className="w-full border border-gray-200 rounded px-1.5 py-1 text-xs bg-white font-mono"
                                        />
                                      </div>

                                      <div>
                                        <label className="text-[10px] text-gray-500 font-medium">
                                          Freight ($/kg)
                                        </label>
                                        <input
                                          type="number"
                                          step="0.01"
                                          value={row.freightUsdPerKg}
                                          onChange={e =>
                                            updateRow(row.id, {
                                              freightUsdPerKg: parseFloat(e.target.value) || 0,
                                            })
                                          }
                                          className="w-full border border-gray-200 rounded px-1.5 py-1 text-xs bg-white font-mono"
                                        />
                                      </div>

                                      <div>
                                        <label className="text-[10px] text-gray-500 font-medium">Duty %</label>
                                        <input
                                          type="number"
                                          step="0.5"
                                          value={row.dutyPct}
                                          onChange={e =>
                                            updateRow(row.id, { dutyPct: parseFloat(e.target.value) || 0 })
                                          }
                                          className="w-full border border-gray-200 rounded px-1.5 py-1 text-xs bg-white font-mono"
                                        />
                                      </div>

                                      <div>
                                        <label className="text-[10px] text-gray-500 font-medium">Clearance ($)</label>
                                        <input
                                          type="number"
                                          step="50"
                                          value={row.clearanceUsd}
                                          onChange={e =>
                                            updateRow(row.id, {
                                              clearanceUsd: parseFloat(e.target.value) || 0,
                                            })
                                          }
                                          className="w-full border border-gray-200 rounded px-1.5 py-1 text-xs bg-white font-mono"
                                        />
                                      </div>
                                    </div>

                                    {/* Suggested Landed Cost Callout */}
                                    <div className="bg-blue-100/90 border border-blue-300 rounded p-2 flex items-center justify-between mt-2">
                                      <span className="text-xs font-bold text-blue-950">SUGGESTED LANDED:</span>
                                      <span className="text-base font-black text-blue-950 font-mono">
                                        {row.landedCostUsd !== null ? `$${row.landedCostUsd.toFixed(2)} / kg` : '—'}
                                      </span>
                                    </div>
                                  </div>

                                  {/* Column C: QUOTE & ACTIONS */}
                                  <div className="border border-green-200 rounded-md p-2.5 bg-green-50/20 space-y-2">
                                    <div className="text-[11px] font-bold text-green-950 uppercase tracking-wide flex items-center justify-between">
                                      <span>Quote Worksheet</span>
                                      <span className="text-[10px] text-green-700 font-semibold">USD</span>
                                    </div>

                                    <div className="grid grid-cols-2 gap-2 text-xs">
                                      <div>
                                        <label className="text-[10px] text-gray-500 font-medium">
                                          Indonesia Margin %
                                        </label>
                                        <input
                                          type="number"
                                          step="0.5"
                                          value={row.indonesiaMarginPct}
                                          onChange={e =>
                                            updateRow(row.id, {
                                              indonesiaMarginPct: parseFloat(e.target.value) || 0,
                                            })
                                          }
                                          className="w-full border border-gray-200 rounded px-1.5 py-1 text-xs bg-white font-mono font-semibold"
                                        />
                                      </div>

                                      <div>
                                        <label className="text-[10px] text-gray-500 font-medium">
                                          Suggested Quote
                                        </label>
                                        <div className="border border-gray-200 rounded px-1.5 py-1 text-xs bg-gray-50 font-mono font-bold text-green-800">
                                          {row.suggestedQuoteUsd !== null
                                            ? `$${row.suggestedQuoteUsd.toFixed(2)} / kg`
                                            : '— (auto)'}
                                        </div>
                                      </div>

                                      <div className="col-span-2">
                                        <div className="flex items-center justify-between mb-1">
                                          <label className="text-[10px] text-gray-700 font-bold">
                                            Actual Quoted Price ($/kg)
                                          </label>
                                          {row.suggestedQuoteUsd !== null && (
                                            <button
                                              type="button"
                                              onClick={() => handleQuotePriceDraftChange(row.id, String(row.suggestedQuoteUsd))}
                                              className="text-[10px] text-blue-600 hover:text-blue-800 font-medium underline cursor-pointer"
                                            >
                                              Use Suggested (${row.suggestedQuoteUsd.toFixed(2)})
                                            </button>
                                          )}
                                        </div>
                                        <input
                                          type="text"
                                          inputMode="decimal"
                                          value={quotePriceDraft}
                                          onChange={e => handleQuotePriceDraftChange(row.id, e.target.value)}
                                          className="w-full border border-green-400 rounded px-2 py-1 text-xs bg-white font-mono font-bold text-green-950"
                                          placeholder="Enter actual customer quoted price..."
                                        />
                                      </div>

                                      <div>
                                        <label className="text-[10px] text-gray-500 font-medium">Selling Qty</label>
                                        <input
                                          value={row.quantity}
                                          onChange={e => updateRow(row.id, { quantity: e.target.value })}
                                          className="w-full border border-gray-200 rounded px-1.5 py-1 text-xs bg-white font-mono"
                                        />
                                      </div>

                                      <div>
                                        <label className="text-[10px] text-gray-500 font-medium">
                                          Total Quote Value
                                        </label>
                                        <div className="border border-gray-200 rounded px-1.5 py-1 text-xs bg-gray-50 font-mono font-semibold text-gray-800">
                                          {row.totalQuoteAmount !== null
                                            ? `$${row.totalQuoteAmount.toLocaleString()}`
                                            : '—'}
                                        </div>
                                      </div>
                                    </div>

                                    {/* Action Buttons: SAVE and SEND TO TEAM */}
                                    <div className="pt-2 flex items-center gap-2">
                                      <button
                                        onClick={() => handleSaveRow(row)}
                                        disabled={savingId === row.id}
                                        className="flex-1 py-1.5 px-3 bg-blue-600 hover:bg-blue-700 text-white rounded text-xs font-semibold flex items-center justify-center gap-1.5 shadow-2xs disabled:opacity-50 cursor-pointer"
                                      >
                                        <Save className="w-3.5 h-3.5" />
                                        <span>{savingId === row.id ? 'Saving...' : 'SAVE'}</span>
                                      </button>

                                      <button
                                        onClick={() => handleSendToTeam(row)}
                                        className="flex-1 py-1.5 px-3 bg-green-600 hover:bg-green-700 text-white rounded text-xs font-semibold flex items-center justify-center gap-1.5 shadow-2xs cursor-pointer"
                                      >
                                        <Send className="w-3.5 h-3.5" />
                                        <span>SEND TO TEAM</span>
                                      </button>
                                    </div>
                                  </div>
                                </div>
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          {/* Table Pagination Bar (Requirement #1: Full retrieval with safe DOM footprint) */}
          <div className="flex flex-col sm:flex-row items-center justify-between gap-2 px-3 py-2 bg-gray-50 border-t border-gray-200 text-xs text-gray-600">
            <div className="flex items-center gap-2">
              <span>
                Showing{' '}
                <strong className="text-gray-900 font-mono">
                  {displayedRows.length === 0 ? 0 : (safePage - 1) * pageSize + 1}
                </strong>{' '}
                to{' '}
                <strong className="text-gray-900 font-mono">
                  {Math.min(safePage * pageSize, displayedRows.length)}
                </strong>{' '}
                of <strong className="text-gray-900 font-mono">{displayedRows.length}</strong> items
              </span>
              <span className="text-gray-300">|</span>
              <div className="flex items-center gap-1">
                <span>Per page:</span>
                <select
                  value={pageSize}
                  onChange={e => {
                    setPageSize(Number(e.target.value));
                    setPage(1);
                  }}
                  className="border border-gray-200 bg-white rounded px-1.5 py-0.5 text-xs font-medium focus:outline-none"
                >
                  <option value={25}>25</option>
                  <option value={50}>50</option>
                  <option value={100}>100</option>
                  <option value={250}>250</option>
                </select>
              </div>
            </div>

            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={safePage <= 1}
                className="px-2.5 py-1 bg-white border border-gray-200 hover:bg-gray-100 rounded text-xs font-medium disabled:opacity-40 disabled:cursor-not-allowed shadow-2xs transition-colors cursor-pointer"
              >
                Previous
              </button>
              <span className="px-2 text-xs font-medium text-gray-700">
                Page <strong className="font-mono">{safePage}</strong> of{' '}
                <strong className="font-mono">{totalPages}</strong>
              </span>
              <button
                type="button"
                onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                disabled={safePage >= totalPages}
                className="px-2.5 py-1 bg-white border border-gray-200 hover:bg-gray-100 rounded text-xs font-medium disabled:opacity-40 disabled:cursor-not-allowed shadow-2xs transition-colors cursor-pointer"
              >
                Next
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* ============================================================ */}
      {/* 5. SEND TO TEAM INTERNAL REPLY MODAL */}
      {/* ============================================================ */}
      {replyTarget && (
        <KunalInternalReplyModal
          isOpen={Boolean(replyTarget)}
          onClose={() => {
            setReplyTarget(null);
            loadData();
          }}
          inquiry={replyTarget.inquiry}
          draft={replyTarget.draft}
          sourceOption={replyTarget.sourceOption}
        />
      )}

      {/* ============================================================ */}
      {/* 6. INTERNAL EMAIL EVIDENCE PREVIEW DRAWER */}
      {/* ============================================================ */}
      <KunalEmailEvidenceDrawer
        isOpen={Boolean(evidenceDrawerRow)}
        onClose={() => setEvidenceDrawerRow(null)}
        row={evidenceDrawerRow}
        allInquiries={allInquiriesList}
        makeOptions={makeOptions}
        onAccept={handleAcceptExtraction}
        onSaveCorrection={handleSaveCorrection}
      />

      {/* 7. ONE-TIME HISTORICAL SCAN COMPLETION REPORT MODAL (Requirement #6) */}
      {historicalReport && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-3xl overflow-hidden border border-gray-200">
            <div className="bg-blue-900 text-white px-5 py-4 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="w-5 h-5 text-green-400" />
                <div>
                  <h3 className="font-bold text-sm">HISTORICAL COMPLETION REPORT</h3>
                  <p className="text-[10px] text-blue-200">Reconciled directly from persisted database records</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setHistoricalReport(null)}
                className="text-blue-200 hover:text-white cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-5 space-y-4 max-h-[75vh] overflow-y-auto text-xs">
              <div className="bg-gray-50 border border-gray-200 rounded p-3 grid grid-cols-2 gap-2 text-gray-700">
                <div><strong>Mailbox:</strong> {historicalReport.mailbox}</div>
                <div><strong>Date Range:</strong> {historicalReport.dateRange}</div>
              </div>

              {/* Requirement #6: 12 Distinct Metrics derived from persisted DB records */}
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2.5">
                <div className="border border-gray-200 rounded p-2.5 bg-white">
                  <div className="text-[10px] text-gray-500 font-medium">Total Processed</div>
                  <div className="text-base font-bold text-gray-900 font-mono mt-0.5">{historicalReport.totalProcessed}</div>
                </div>

                <div className="border border-blue-200 rounded p-2.5 bg-blue-50/50">
                  <div className="text-[10px] text-blue-700 font-medium">AI Pricing Detected</div>
                  <div className="text-base font-bold text-blue-900 font-mono mt-0.5">{historicalReport.aiPricingDetected}</div>
                </div>

                <div className="border border-green-200 rounded p-2.5 bg-green-50/50">
                  <div className="text-[10px] text-green-700 font-medium">Inquiries Enriched</div>
                  <div className="text-base font-bold text-green-900 font-mono mt-0.5">{historicalReport.inquiriesEnriched}</div>
                </div>

                <div className="border border-amber-200 rounded p-2.5 bg-amber-50/50">
                  <div className="text-[10px] text-amber-700 font-medium">New Unlinked Pricing</div>
                  <div className="text-base font-bold text-amber-900 font-mono mt-0.5">{historicalReport.newUnlinkedPricing}</div>
                </div>

                <div className="border border-purple-200 rounded p-2.5 bg-purple-50/50">
                  <div className="text-[10px] text-purple-700 font-medium">Alternative Makes</div>
                  <div className="text-base font-bold text-purple-900 font-mono mt-0.5">{historicalReport.alternativeMakesDetected}</div>
                </div>

                <div className="border border-amber-300 rounded p-2.5 bg-amber-50/70">
                  <div className="text-[10px] text-amber-800 font-medium">Needs Review</div>
                  <div className="text-base font-bold text-amber-950 font-mono mt-0.5">{historicalReport.needsReview}</div>
                </div>

                <div className="border border-indigo-200 rounded p-2.5 bg-indigo-50/50">
                  <div className="text-[10px] text-indigo-700 font-medium">Documents Detected</div>
                  <div className="text-base font-bold text-indigo-900 font-mono mt-0.5">{historicalReport.documentsDetected}</div>
                </div>

                <div className="border border-green-200 rounded p-2.5 bg-green-50/50">
                  <div className="text-[10px] text-green-700 font-medium">Documents Actually Stored</div>
                  <div className="text-base font-bold text-green-900 font-mono mt-0.5">{historicalReport.documentsStored}</div>
                </div>

                <div className="border border-emerald-200 rounded p-2.5 bg-emerald-50/50">
                  <div className="text-[10px] text-emerald-700 font-medium">Documents Successfully Linked</div>
                  <div className="text-base font-bold text-emerald-900 font-mono mt-0.5">{historicalReport.documentsLinked}</div>
                </div>

                <div className="border border-red-200 rounded p-2.5 bg-red-50/50">
                  <div className="text-[10px] text-red-700 font-medium">Documents Needing Re-Sync</div>
                  <div className="text-base font-bold text-red-900 font-mono mt-0.5">{historicalReport.documentsNeedingResync}</div>
                </div>

                <div className="border border-gray-200 rounded p-2.5 bg-gray-50/80">
                  <div className="text-[10px] text-gray-700 font-medium">Documents Unavailable</div>
                  <div className="text-base font-bold text-gray-900 font-mono mt-0.5">{historicalReport.documentsUnavailable}</div>
                </div>

                <div className="border border-amber-200 rounded p-2.5 bg-amber-50/50">
                  <div className="text-[10px] text-amber-700 font-medium">Storage Verification Failures</div>
                  <div className="text-base font-bold text-amber-900 font-mono mt-0.5">{historicalReport.storageVerificationFailures}</div>
                </div>

                <div className="border border-gray-200 rounded p-2.5 bg-gray-50">
                  <div className="text-[10px] text-gray-500 font-medium">No Action / Archived</div>
                  <div className="text-base font-bold text-gray-700 font-mono mt-0.5">{historicalReport.noAction}</div>
                </div>

                <div className="border border-gray-200 rounded p-2.5 bg-gray-50">
                  <div className="text-[10px] text-gray-500 font-medium">Duplicates Skipped</div>
                  <div className="text-base font-bold text-gray-700 font-mono mt-0.5">{historicalReport.duplicatesSkipped}</div>
                </div>

                <div className="border border-red-200 rounded p-2.5 bg-red-50/50">
                  <div className="text-[10px] text-red-700 font-medium">Errors Encountered</div>
                  <div className="text-base font-bold text-red-900 font-mono mt-0.5">{historicalReport.errors.length}</div>
                </div>
              </div>

              {historicalReport.errors.length > 0 && (
                <div className="bg-red-50 border border-red-200 rounded p-2.5 text-[11px] text-red-900 space-y-1">
                  <div className="font-bold">Errors encountered during scan:</div>
                  <ul className="list-disc pl-4 space-y-0.5">
                    {historicalReport.errors.map((e, i) => (
                      <li key={i}>{e}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>

            <div className="bg-gray-50 px-5 py-3 border-t border-gray-200 flex justify-end">
              <button
                type="button"
                onClick={() => setHistoricalReport(null)}
                className="px-4 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded text-xs font-semibold cursor-pointer"
              >
                Close Report
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 8. IMPORT DATA ANALYSIS MODAL */}
      {importDataModalProduct && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-5xl max-h-[90vh] overflow-y-auto">
            <ImportInfo
              initialProduct={importDataModalProduct}
              compactAnalysis={true}
              onClose={() => setImportDataModalProduct(null)}
            />
          </div>
        </div>
      )}
    </Layout>
  );
}
export default PricingWorksheet;
