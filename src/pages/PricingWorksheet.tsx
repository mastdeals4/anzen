import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { Layout } from '../components/Layout';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { loadMakeSuggestions } from '../services/makeSuggestions';
import { runSapjGmailAgent, type AgentScanSummary } from '../services/kunalIndiaPrice';
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
  | 'Completed';

export interface UnifiedPricingRow {
  id: string; // unique row id (inquiry id or ai review id)
  aiReviewId?: string | null;
  inquiryId?: string | null;
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
  const finalQuote = overrides?.quotePriceOverride !== undefined
    ? overrides.quotePriceOverride
    : suggestedQuote;

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
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [makeOptions, setMakeOptions] = useState<string[]>([]);

  // STABLE LOCAL STRING DRAFTS FOR NUMERIC INPUT
  // Prevents re-renders, bucket shifts, and focus loss during typing
  const [priceDrafts, setPriceDrafts] = useState<Record<string, { sourcePrice?: string; quotePrice?: string }>>({});

  // Background Gmail AI Agent widget state
  const [isScanning, setIsScanning] = useState(false);
  const [isScanning7Days, setIsScanning7Days] = useState(false);
  const [lastCheckedTime, setLastCheckedTime] = useState<string | null>(null);
  const [nextCheckWibTime, setNextCheckWibTime] = useState<string>('6:00 PM');

  // Filters & Top Bar Controls
  const [search, setSearch] = useState('');
  const [customerFilter, setCustomerFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState<string>('Needs Action');
  const [sourceFilter, setSourceFilter] = useState<string>('all');

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

      // 2. Insert record into crm_product_documents
      const displayFileName = `${row.productName || 'Product'}_${uploadDocType}.${ext}`;
      const { data: newDoc, error: insertErr } = await supabase
        .from('crm_product_documents')
        .insert({
          inquiry_id: row.inquiryId,
          product_name: row.productName,
          make: row.offeredMake || row.requestedMake || null,
          document_type: uploadDocType,
          original_file_name: uploadDocFile.name,
          display_file_name: displayFileName,
          storage_bucket: 'crm-documents',
          storage_path: storagePath,
          uploaded_by: profile?.id || null,
        })
        .select('id, inquiry_id, document_type, display_file_name, original_file_name, storage_path, storage_bucket, make')
        .single();

      if (insertErr) {
        throw new Error(`Database record creation failed: ${insertErr.message}`);
      }

      // 3. Immediately update row documents in state
      const addedDoc = {
        id: newDoc.id,
        documentType: uploadDocType,
        filename: newDoc.display_file_name || uploadDocFile.name,
        storagePath: storagePath,
        storageBucket: 'crm-documents',
        status: 'MATCHED' as const,
      };

      const nextDocs = [...row.documents.filter(d => d.filename !== addedDoc.filename), addedDoc];
      updateRow(row.id, { documents: nextDocs });

      // Also update evidenceDrawerRow if open for this row
      if (evidenceDrawerRow?.id === row.id) {
        setEvidenceDrawerRow(prev => prev ? { ...prev, documents: nextDocs } : null);
      }

      showToast({
        type: 'success',
        title: 'Document Uploaded',
        message: `${uploadDocType} document (${uploadDocFile.name}) attached successfully.`,
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

    const nextStatus: PricingRowStatus = targetRow.quotePrice ? 'Ready to Quote' : 'Price Received';
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
    },
  ) => {
    const targetRow = rows.find(r => r.id === rowId);
    if (!targetRow) return;

    const matchedInquiry = allInquiriesList.find(i => i.id === correction.inquiryId);
    const updatedInqId = correction.inquiryId || targetRow.inquiryId;

    const patch: Partial<UnifiedPricingRow> = {
      ...correction,
      inquiryId: updatedInqId,
      inquiryNumber: matchedInquiry?.inquiry_number || targetRow.inquiryNumber,
      aceerpNo: matchedInquiry?.aceerp_no || targetRow.aceerpNo,
      customerName: matchedInquiry?.company_name || targetRow.customerName,
      productName: correction.productName || targetRow.productName,
      needsManualLink: false,
      actionReason: null,
      status: (correction.sourcePrice && correction.sourcePrice > 0) ? 'Ready to Quote' : 'Price Received',
    };

    updateRow(rowId, patch);

    if (targetRow.aiReviewId) {
      await supabase
        .from('kunal_ai_email_reviews')
        .update({
          matched_inquiry_id: updatedInqId,
          product_name: patch.productName,
          offered_make: patch.offeredMake,
          source_price: patch.sourcePrice,
          source_currency: patch.sourceCurrency,
          action_status: 'reviewed',
          updated_at: new Date().toISOString(),
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

      // 4. Fetch AI Email Reviews (recent 100)
      const { data: aiReviews } = await supabase
        .from('kunal_ai_email_reviews')
        .select('*')
        .order('scanned_at', { ascending: false })
        .limit(100);

      // 5. Fetch Documents for inquiries
      const docsMap: Record<string, any[]> = {};
      if (inqIds.length > 0) {
        const { data: docsData } = await supabase
          .from('crm_product_documents')
          .select('id, inquiry_id, document_type, display_file_name, original_file_name, storage_path, storage_bucket, make')
          .in('inquiry_id', inqIds);
        for (const doc of docsData || []) {
          if (!docsMap[doc.inquiry_id]) docsMap[doc.inquiry_id] = [];
          docsMap[doc.inquiry_id].push({
            id: doc.id,
            documentType: doc.document_type || 'DOC',
            filename: doc.display_file_name || doc.original_file_name || 'document.pdf',
            storagePath: doc.storage_path,
            storageBucket: doc.storage_bucket,
            status: 'MATCHED' as const,
          });
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
        const sourcePrice: number | null = selectedOpt?.source_price ?? null;
        const sourceCurrency: 'INR' | 'USD' = (selectedOpt?.source_currency as any) === 'USD' ? 'USD' : 'INR';
        const requestedMake = inq.supplier_name || '';
        const offeredMake = selectedOpt?.offered_make || inq.supplier_name || '';
        const supplierName = selectedOpt?.supplier || '';

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
          quotePrice: null as number | null,
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
              quotePriceOverride: selectedOpt?.selling_price ?? null,
            },
          );
        }

        // Status Determination:
        // Inquiries without active incoming AI email reviews remain in 'Waiting Supplier'
        // or 'Completed' if a customer quote was entered/sent.
        // They must NOT jump to 'Needs Action' ('Price Received' / 'Ready to Quote').
        let status: PricingRowStatus = 'Waiting Supplier';
        const actionReason: string | null = null;

        if (inq.quote_status === 'sent' || inq.kunal_price_status === 'entered') {
          status = 'Completed';
        }

        const docs = docsMap[inq.id] || [];

        unifiedMap.set(inq.id, {
          id: inq.id,
          inquiryId: inq.id,
          inquiryNumber: inq.inquiry_number,
          aceerpNo: inq.aceerp_no || '-',
          customerName: inq.company_name,
          productName: inq.product_name,
          specification: inq.specification || '',
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
          quoteCurrency: 'USD',
          quoteFxIdr: 16200,
          totalQuoteAmount: calcResult.totalQuoteAmount,
          calcBreakdown: calcResult.calcBreakdown,
          status,
          actionReason,
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
        });
      }

      // Second pass: Merge AI Reviews
      for (const rev of aiReviews || []) {
        const raw = rev.raw_result || {};
        if (raw.fastFiltered || rev.action_status === 'no_action') continue;

        const matchedInqId = rev.matched_inquiry_id || raw.suggestedInquiryId;
        const targetRow = matchedInqId ? unifiedMap.get(matchedInqId) : null;

        const extractionRow = raw.extractionRows?.[0] || {};
        const extractedPrice = extractionRow.source_price ?? rev.source_price ?? null;
        const extractedCurrency: 'INR' | 'USD' =
          (extractionRow.source_currency || rev.source_currency) === 'USD' ? 'USD' : 'INR';
        const extractedMake = extractionRow.offered_make || rev.offered_make || '';
        const detectedDocs = raw.detectedDocuments || [];

        const sourceEmail = raw.sourceEmail || {};
        const realMessageId = rev.gmail_message_id || sourceEmail.messageId || null;
        const realThreadId = rev.gmail_thread_id || sourceEmail.threadId || null;
        const hasRealGmail = Boolean(realMessageId);

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
            ? sourceEmail.attachments.map((a: any) => ({
                attachmentId: a.attachmentId,
                filename: a.filename,
                mimeType: a.mimeType,
                size: a.size,
                documentType: a.documentType,
                matchStatus: a.matchStatus,
                storagePath: a.storagePath,
              }))
            : (detectedDocs.length > 0
              ? detectedDocs.map((d: any) => ({
                  filename: d.filename,
                  documentType: d.documentType,
                  matchStatus: d.matchStatus,
                  storagePath: d.storagePath,
                }))
              : targetRow?.evidence?.attachments || []),
        };

        // Determine Document Action Notice
        let docActionNotice: string | null = null;
        const hasAmbiguousDoc = detectedDocs.some((d: any) => d.matchStatus === 'AMBIGUOUS');
        const hasReviewDoc = detectedDocs.some((d: any) => d.matchStatus === 'REVIEW');
        if (hasAmbiguousDoc) {
          docActionNotice = 'Document match ambiguous';
        } else if (hasReviewDoc) {
          docActionNotice = 'COA needs review';
        }

        if (targetRow) {
          // Enrich inquiry row with live AI extraction
          targetRow.aiReviewId = rev.id;
          targetRow.isAiPrepared = true;
          // When Gmail AI finds a supplier reply for an existing inquiry,
          // replace CRM fallback evidence with the REAL Gmail evidence
          if (hasRealGmail || !targetRow.evidence) {
            targetRow.evidence = evidenceObj;
          }

          // Rule 5: Do not use AI Gmail extraction to overwrite a manually entered supplier value.
          // Manual verified data has priority until a new AI result is explicitly reviewed.
          const hasManualSourcePrice = targetRow.sourcePrice !== null && targetRow.sourcePrice > 0;
          if (extractedPrice && !hasManualSourcePrice) {
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
          if (detectedDocs.length > 0) {
            targetRow.documents = [
              ...targetRow.documents,
              ...detectedDocs.map((d: any) => ({
                documentType: d.documentType || 'DOC',
                filename: d.filename || 'attachment.pdf',
                storagePath: d.storagePath,
                batchNumber: d.batchNumber,
                status: (d.matchStatus as any) || 'MATCHED',
              })),
            ];
            if (docActionNotice) {
              targetRow.docActionNotice = docActionNotice;
            }
          }

          // Transition to action statuses ONLY if the review is pending review and row is not Completed
          const isPendingReview = rev.action_status === 'pending_review' || rev.action_status === 'needs_manual_link';
          if (isPendingReview && targetRow.status !== 'Completed') {
            if (raw.needsManualLink) {
              targetRow.status = 'Needs Review';
              targetRow.needsManualLink = true;
              targetRow.actionReason = 'Inquiry match ambiguous';
            } else if (raw.alternativeMake?.detected) {
              targetRow.actionReason = 'Confirm make';
            } else if (docActionNotice) {
              targetRow.actionReason = docActionNotice;
            } else if (targetRow.quotePrice && targetRow.landedCostUsd) {
              targetRow.status = 'Ready to Quote';
              targetRow.actionReason = 'Ready to quote';
            } else if (targetRow.sourcePrice) {
              targetRow.status = 'Price Received';
              targetRow.actionReason = 'Price received';
            }
          }
        } else if (extractedPrice || detectedDocs.length > 0) {
          // AI review without exact matched inquiry row -> standalone item requiring action
          const fallbackId = `ai-${rev.id}`;
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
            customerName: 'Pending Link',
            productName: rev.product_name || extractionRow.product_name || 'Chemical Item',
            specification: extractionRow.specification || '',
            quantity: extractionRow.quantity || '1,000 kg',
            requestedMake: extractionRow.preferred_manufacturer || '',
            offeredMake: extractedMake,
            supplierName: rev.from_email || '',
            sourcePrice: extractedPrice,
            sourceCurrency: extractedCurrency,
            unit: extractionRow.unit || 'KG',
            moq: extractionRow.quantity || '500 kg',
            availability: extractionRow.availability || 'available',
            leadTime: extractionRow.lead_time || '2 weeks',
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
            status: 'Needs Review',
            actionReason: raw.needsManualLink ? 'Inquiry match ambiguous' : 'Link inquiry',
            isAiPrepared: true,
            alternativeMakeDetected: Boolean(raw.alternativeMake?.detected),
            needsManualLink: true,
            documents: detectedDocs.map((d: any) => ({
              documentType: d.documentType || 'DOC',
              filename: d.filename || 'attachment.pdf',
              batchNumber: d.batchNumber,
              status: (d.matchStatus as any) || 'REVIEW',
            })),
            docActionNotice: docActionNotice || (detectedDocs.length > 0 ? 'Document match ambiguous' : null),
            evidence: evidenceObj,
            sourceType: 'india',
          });
        }
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

  // Handle CHECK LAST 7 DAYS button
  const handleCheckLast7Days = async () => {
    if (isScanning || isScanning7Days) return;
    setIsScanning7Days(true);
    try {
      const summary: AgentScanSummary = await runSapjGmailAgent({ scanLast7Days: true, maxMessages: 50 });
      setLastCheckedTime(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
      setNextCheckWibTime(computeNextWib());
      if (!summary.success || (summary.errors && summary.errors.length > 0)) {
        showToast({
          type: 'error',
          title: '7-Day Historical Scan Failed',
          message: summary.errors?.join('; ') || summary.message || 'Processing failed for connected mailbox',
        });
      } else {
        const processed = summary.messages_processed ?? summary.scanned;
        const pricing = summary.pricing_detected ?? summary.pricing;
        const docs = summary.documents_detected ?? summary.documents;
        showToast({
          type: 'success',
          title: '7-Day Historical Scan Complete',
          message: `${processed} emails inspected • ${pricing} pricing detected • ${docs} docs synced`,
        });
      }
      await loadData();
    } catch (err: any) {
      showToast({ type: 'error', title: '7-Day Scan Failed', message: err.message || 'Check Last 7 Days failed' });
    } finally {
      setIsScanning7Days(false);
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
      // Status filter
      if (statusFilter === 'Needs Action') {
        // EXCLUDE ordinary 'Waiting Supplier' rows from 'Needs Action'
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
  }, [rows, statusFilter, customerFilter, sourceFilter, search]);

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
          },
        );

        return {
          ...row,
          sourcePrice: validNum,
          purchasePriceUsdPerKg: calc.purchasePriceUsdPerKg,
          landedCostUsd: calc.landedCostUsd,
          suggestedQuoteUsd: calc.suggestedQuoteUsd,
          quotePrice: calc.quotePrice,
          totalQuoteAmount: calc.totalQuoteAmount,
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

  // Selection toggle
  const toggleSelect = (id: string) => {
    setSelectedIds(cur => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === displayedRows.length) setSelectedIds(new Set());
    else setSelectedIds(new Set(displayedRows.map(r => r.id)));
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

      // 1. Upsert pricing option
      const { data: optionData, error: optErr } = await supabase
        .from('crm_inquiry_pricing_options')
        .upsert(
          {
            inquiry_id: targetInquiryId,
            source_type: row.sourceType || 'india',
            offered_make: row.offeredMake || row.requestedMake,
            source_price: row.sourcePrice,
            source_currency: row.sourceCurrency,
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
          },
          { onConflict: 'inquiry_id' },
        )
        .select('id')
        .maybeSingle();

      if (optErr) console.warn('Pricing option upsert warning:', optErr);

      // 2. Update CRM Inquiry with validated landed cost and quote price
      const isQuoteEntered = Boolean(row.quotePrice && row.quotePrice > 0);
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
          final_selected_option_id: optionData?.id || null,
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

      // Transition row status after save:
      // A Waiting Supplier record that has been manually entered and saved must NOT jump to Needs Action!
      // If quote price was entered and saved, it transitions to 'Completed'.
      // If no quote price was entered, it remains in 'Waiting Supplier'.
      let nextStatus: PricingRowStatus = 'Waiting Supplier';
      if (isQuoteEntered) {
        nextStatus = 'Completed';
      } else if (row.status === 'Waiting Supplier') {
        nextStatus = 'Waiting Supplier';
      } else if (row.status === 'Needs Review' || row.status === 'Price Received') {
        nextStatus = 'Waiting Supplier';
      } else {
        nextStatus = row.status;
      }
      updateRow(row.id, { status: nextStatus, needsManualLink: false, actionReason: null });
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
                disabled={isScanning || isScanning7Days}
                className="px-2.5 py-1 bg-blue-600 hover:bg-blue-700 text-white rounded font-medium text-xs flex items-center gap-1.5 shadow-2xs disabled:opacity-50 transition-colors cursor-pointer"
                title="Run immediate Gmail Agent scan"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isScanning ? 'animate-spin' : ''}`} />
                <span>{isScanning ? 'Scanning...' : 'CHECK NOW'}</span>
              </button>

              <button
                id="btn-check-7-days"
                onClick={handleCheckLast7Days}
                disabled={isScanning || isScanning7Days}
                className="px-2.5 py-1 bg-white hover:bg-gray-100 text-gray-700 border border-gray-300 rounded font-medium text-xs flex items-center gap-1.5 shadow-2xs disabled:opacity-50 transition-colors cursor-pointer"
                title="Scan last 7 days of supplier emails"
              >
                <Calendar className={`w-3.5 h-3.5 text-blue-600 ${isScanning7Days ? 'animate-spin' : ''}`} />
                <span>{isScanning7Days ? 'Scanning 7D...' : 'Check Last 7 Days'}</span>
              </button>
            </div>
          </div>
        </div>

        {/* ============================================================ */}
        {/* 2. STATUS TABS & SEARCH FILTERS */}
        {/* ============================================================ */}
        <div className="space-y-2">
          {/* Main Workflow Tabs */}
          <div className="flex flex-wrap items-center gap-1 text-xs">
            <button
              onClick={() => setStatusFilter('Needs Action')}
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
              onClick={() => setStatusFilter('Waiting Supplier')}
              className={`px-2.5 py-1 rounded font-medium transition-colors flex items-center gap-1.5 ${
                statusFilter === 'Waiting Supplier'
                  ? 'bg-blue-600 text-white shadow-2xs'
                  : 'bg-white text-gray-700 hover:bg-gray-100 border border-gray-200'
              }`}
            >
              <span>Waiting Supplier</span>
              <span className="text-[10px] opacity-75 font-semibold">({counts.waitingSupplier})</span>
            </button>

            <button
              onClick={() => setStatusFilter('Price Received')}
              className={`px-2.5 py-1 rounded font-medium transition-colors flex items-center gap-1.5 ${
                statusFilter === 'Price Received'
                  ? 'bg-blue-600 text-white shadow-2xs'
                  : 'bg-white text-gray-700 hover:bg-gray-100 border border-gray-200'
              }`}
            >
              <span>Price Received</span>
              <span className="text-[10px] opacity-75 font-semibold">({counts.priceReceived})</span>
            </button>

            <button
              onClick={() => setStatusFilter('Ready to Quote')}
              className={`px-2.5 py-1 rounded font-medium transition-colors flex items-center gap-1.5 ${
                statusFilter === 'Ready to Quote'
                  ? 'bg-blue-600 text-white shadow-2xs'
                  : 'bg-white text-gray-700 hover:bg-gray-100 border border-gray-200'
              }`}
            >
              <span>Ready to Quote</span>
              <span className="text-[10px] opacity-75 font-semibold">({counts.readyToQuote})</span>
            </button>

            <button
              onClick={() => setStatusFilter('Completed')}
              className={`px-2.5 py-1 rounded font-medium transition-colors flex items-center gap-1.5 ${
                statusFilter === 'Completed'
                  ? 'bg-blue-600 text-white shadow-2xs'
                  : 'bg-white text-gray-700 hover:bg-gray-100 border border-gray-200'
              }`}
            >
              <span>Completed</span>
              <span className="text-[10px] opacity-75 font-semibold">({counts.completed})</span>
            </button>

            <button
              onClick={() => setStatusFilter('all')}
              className={`px-2.5 py-1 rounded font-medium transition-colors flex items-center gap-1.5 ${
                statusFilter === 'all'
                  ? 'bg-gray-800 text-white shadow-2xs'
                  : 'bg-white text-gray-600 hover:bg-gray-100 border border-gray-200'
              }`}
            >
              <span>All ({counts.total})</span>
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
              aria-label="Source Filter"
              value={sourceFilter}
              onChange={e => setSourceFilter(e.target.value)}
              className="border border-gray-200 rounded px-2 py-1 text-xs bg-white focus:outline-none"
            >
              <option value="all">All Sources</option>
              <option value="india">India</option>
              <option value="china">China</option>
              <option value="local">Local</option>
            </select>

            {(search || customerFilter !== 'all' || sourceFilter !== 'all') && (
              <button
                onClick={() => {
                  setSearch('');
                  setCustomerFilter('all');
                  setSourceFilter('all');
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
                  <th className="py-2 px-2 text-center w-8 border-r border-gray-200">
                    <input
                      type="checkbox"
                      checked={displayedRows.length > 0 && selectedIds.size === displayedRows.length}
                      onChange={toggleSelectAll}
                      className="cursor-pointer rounded border-gray-300"
                    />
                  </th>
                  <th className="py-2 px-2 w-32 border-r border-gray-200">INQUIRY / ACE</th>
                  <th className="py-2 px-2 w-36 border-r border-gray-200">CUSTOMER</th>
                  <th className="py-2 px-2 w-48 border-r border-gray-200">PRODUCT</th>
                  <th className="py-2 px-2 w-28 border-r border-gray-200">REQ. MAKE</th>
                  <th className="py-2 px-2 w-32 border-r border-gray-200">OFFERED MAKE</th>
                  <th className="py-2 px-2 w-32 border-r border-gray-200">SUPPLIER</th>
                  <th className="py-2 px-2 w-24 text-right border-r border-gray-200 bg-amber-50/40 text-amber-950 font-bold">
                    SUPPLIER PRICE
                  </th>
                  <th className="py-2 px-1 text-center w-14 border-r border-gray-200">CURR</th>
                  <th className="py-2 px-1 text-center w-12 border-r border-gray-200">UNIT</th>
                  <th className="py-2 px-2.5 w-28 text-right bg-blue-50/60 text-blue-900 border-r border-gray-200 font-bold">
                    SUGGESTED LANDED
                  </th>
                  <th className="py-2 px-2.5 w-28 text-right bg-green-50/60 text-green-900 border-r border-gray-200 font-bold">
                    SUGGESTED QUOTE
                  </th>
                  <th className="py-2 px-2 text-center w-32 border-r border-gray-200">STATUS / REASON</th>
                  <th className="py-2 px-2 text-center w-24">ACTIONS</th>
                </tr>
              </thead>

              <tbody className="divide-y divide-gray-100 font-normal text-gray-800">
                {loading ? (
                  <tr>
                    <td colSpan={14} className="py-12 text-center text-gray-400">
                      <RefreshCw className="w-5 h-5 animate-spin mx-auto mb-2 text-blue-600" />
                      Loading pricing worksheet...
                    </td>
                  </tr>
                ) : displayedRows.length === 0 ? (
                  <tr>
                    <td colSpan={14} className="py-12 text-center">
                      <CheckCircle2 className="w-8 h-8 text-green-500 mx-auto mb-2 opacity-80" />
                      <p className="text-sm font-semibold text-gray-700">No rows in this view.</p>
                      <p className="text-xs text-gray-500 mt-1">
                        All actionable items are up to date. Click [ CHECK NOW ] to scan supplier emails.
                      </p>
                    </td>
                  </tr>
                ) : (
                  displayedRows.map(row => {
                    const isExpanded = expandedId === row.id;
                    const isSelected = selectedIds.has(row.id);
                    const sourcePriceDraft =
                      priceDrafts[row.id]?.sourcePrice ?? (row.sourcePrice != null ? String(row.sourcePrice) : '');
                    const quotePriceDraft =
                      priceDrafts[row.id]?.quotePrice ?? (row.quotePrice != null ? String(row.quotePrice) : '');

                    return (
                      <Fragment key={row.id}>
                        {/* Main Grid Row */}
                        <tr
                          className={`transition-colors text-[11px] group ${
                            isSelected
                              ? 'bg-blue-50/40'
                              : isExpanded
                              ? 'bg-gray-50/90 font-medium'
                              : row.isAiPrepared
                              ? 'bg-amber-50/20 hover:bg-amber-50/40'
                              : 'hover:bg-gray-50'
                          }`}
                        >
                          {/* Checkbox */}
                          <td className="py-1.5 px-2 text-center border-r border-gray-200">
                            <input
                              type="checkbox"
                              checked={isSelected}
                              onChange={() => toggleSelect(row.id)}
                              className="cursor-pointer rounded border-gray-300"
                            />
                          </td>

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
                            {row.isAiPrepared && (
                              <span className="inline-flex items-center gap-0.5 text-[9px] text-amber-700 bg-amber-100 px-1 rounded">
                                <Sparkles className="w-2.5 h-2.5" /> AI Prepared
                              </span>
                            )}
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

                          {/* Currency */}
                          <td className="py-1 px-1 border-r border-gray-200 text-center">
                            <select
                              aria-label="Currency"
                              value={row.sourceCurrency}
                              onChange={e => updateRow(row.id, { sourceCurrency: e.target.value as any })}
                              className="text-[10px] bg-transparent font-medium border-none p-0 focus:outline-none"
                            >
                              <option value="INR">INR</option>
                              <option value="USD">USD</option>
                            </select>
                          </td>

                          {/* Unit */}
                          <td className="py-1 px-1 border-r border-gray-200 text-center">
                            <select
                              aria-label="Unit"
                              value={row.unit}
                              onChange={e => updateRow(row.id, { unit: e.target.value })}
                              className="text-[10px] bg-transparent font-medium border-none p-0 focus:outline-none"
                            >
                              <option value="KG">KG</option>
                              <option value="MT">MT</option>
                            </select>
                          </td>

                          {/* SUGGESTED LANDED COST (Real Canonical calculateFCL Output) */}
                          <td className="py-1 px-2 border-r border-gray-200 text-right font-mono font-bold bg-blue-50/40 text-blue-950">
                            {row.landedCostUsd !== null ? `$${row.landedCostUsd.toFixed(2)}` : '—'}
                          </td>

                          {/* SUGGESTED QUOTE (Editable Excel-like Cell with local string draft) */}
                          <td className="py-1 px-1.5 border-r border-gray-200 text-right bg-green-50/40">
                            <input
                              type="text"
                              inputMode="decimal"
                              value={quotePriceDraft}
                              onChange={e => handleQuotePriceDraftChange(row.id, e.target.value)}
                              className="w-20 text-right font-mono font-bold text-green-900 border border-green-200 rounded px-1.5 py-0.5 bg-white focus:outline-none focus:ring-1 focus:ring-green-500"
                              placeholder="—"
                            />
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
                            </div>
                          </td>
                        </tr>

                        {/* ============================================================ */}
                        {/* 4. EXPANDED PRICING WORKSHEET & CANONICAL CALCULATOR */}
                        {/* ============================================================ */}
                        {isExpanded && (
                          <tr className="bg-gray-50 border-b-2 border-blue-200">
                            <td colSpan={14} className="p-3">
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
                                                  <span className="truncate text-gray-800 font-medium" title={doc.filename}>
                                                    {doc.filename}
                                                  </span>
                                                  <span className="text-[9px] text-green-700 font-semibold flex-shrink-0">
                                                    ✓ Uploaded
                                                  </span>
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
                                      <span>Import Calculation (FCL)</span>
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
                                        <label className="text-[10px] text-gray-600 font-bold">
                                          Quote Price Override ($/kg)
                                        </label>
                                        <input
                                          type="text"
                                          inputMode="decimal"
                                          value={quotePriceDraft}
                                          onChange={e => handleQuotePriceDraftChange(row.id, e.target.value)}
                                          className="w-full border border-green-400 rounded px-2 py-1 text-xs bg-white font-mono font-bold text-green-950"
                                          placeholder="Enter or override quote price..."
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
    </Layout>
  );
}
export default PricingWorksheet;
