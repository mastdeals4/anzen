import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../../lib/supabase';
import {
  Download,
  ExternalLink,
  FileText,
  Search,
  Trash2,
  Upload,
  X,
  ShieldCheck,
  Clock,
  CheckCircle,
  CheckCircle2,
  Archive,
  MessageSquare,
  Mail,
  Eye,
  ChevronLeft,
  ChevronRight,
  HardDrive,
  Filter,
  RefreshCw,
  Info,
  FileSpreadsheet,
  Play,
  AlertTriangle,
  CheckSquare,
  Square,
  MinusSquare,
  ZoomIn,
  ZoomOut,
  RotateCcw,
  Sparkles,
  Layers,
  Tag,
  Building2,
  Package,
} from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { useLanguage } from '../../contexts/LanguageContext';
import { showToast } from '../ToastNotification';
import { getSignedUrlCached, invalidateSignedUrl } from '../../utils/signedUrlCache';
import { uploadOptimizedFile } from '../../services/storage/uploadOptimizationService';
import { FloatingField, FLOAT_INPUT } from '../finance/FloatingField';
import { SapRow } from '../finance/SapLayout';
import {
  formatBytes,
  buildDeletionPlan,
  executeSafeDeletion,
  fetchDocumentBankStats,
  fetchUnlinkedStorageObjects,
  updateDocumentLifecycle,
  type CrmProductDocumentRecord,
  type DocumentBankStats,
  type UnlinkedStorageObject,
  type DeletionPlan,
  type DeletionExecutionResult,
  type DocumentLifecycleStatus,
} from '../../services/crm/documentBankService';

export type CrmProductDocument = CrmProductDocumentRecord;

type InquiryOption = { id: string; inquiry_number: string; product_name: string };
type MasterProductOption = { id: string; product_name: string; product_code?: string };
type ProductSourceOption = { id: string; product_id: string; supplier_name: string; grade?: string; country?: string };

const DOC_TYPES = [
  'COA',
  'MSDS',
  'GMP',
  'HALAL',
  'SPEC',
  'TDS',
  'DMF',
  'MANUFACTURING_LICENCE',
  'PURCHASE_ORDER',
  'SALES_INVOICE',
  'OTHER_TECHNICAL',
  'PRODUCT_CATALOGUE',
  'PRICE_LIST',
  'OTHER',
] as const;

const COMMON_SPECS = ['USP', 'BP', 'EP', 'IP', 'JP', 'Ph.Eur.', 'Technical', 'Food Grade'] as const;

const DOC_TYPE_COLOR: Record<string, string> = {
  COA: 'bg-emerald-50 text-emerald-800 border-emerald-200',
  MSDS: 'bg-rose-50 text-rose-800 border-rose-200',
  HALAL: 'bg-teal-50 text-teal-800 border-teal-200',
  GMP: 'bg-purple-50 text-purple-800 border-purple-200',
  DMF: 'bg-indigo-50 text-indigo-800 border-indigo-200',
  SPEC: 'bg-amber-50 text-amber-800 border-amber-200',
  TDS: 'bg-blue-50 text-blue-800 border-blue-200',
  MANUFACTURING_LICENCE: 'bg-cyan-50 text-cyan-800 border-cyan-200',
  OTHER_TECHNICAL: 'bg-sky-50 text-sky-800 border-sky-200',
  PURCHASE_ORDER: 'bg-orange-50 text-orange-800 border-orange-200',
  SALES_INVOICE: 'bg-amber-50 text-amber-800 border-amber-200',
  PRODUCT_CATALOGUE: 'bg-violet-50 text-violet-800 border-violet-200',
  PRICE_LIST: 'bg-sky-50 text-sky-800 border-sky-200',
  OTHER: 'bg-gray-100 text-gray-700 border-gray-200',
};

export function ProductDocumentsPanel() {
  const { profile } = useAuth();
  const { t } = useLanguage();
  const canUpload = profile?.role === 'admin' || profile?.role === 'manager';

  const [documents, setDocuments] = useState<CrmProductDocument[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [productFilter, setProductFilter] = useState('');
  const [supplierFilter, setSupplierFilter] = useState('');
  const [specificationFilter, setSpecificationFilter] = useState('all');
  const [documentTypeFilter, setDocumentTypeFilter] = useState('all');
  const [lifecycleFilter, setLifecycleFilter] = useState<'all' | 'BANKED' | 'REVIEWED' | 'TEMP' | 'ARCHIVED' | 'CLEANUP'>('all');
  const [cleanupCandidatesOnly, setCleanupCandidatesOnly] = useState(false);

  // Master product & source options
  const [masterProducts, setMasterProducts] = useState<MasterProductOption[]>([]);
  const [productSources, setProductSources] = useState<ProductSourceOption[]>([]);

  // Pagination state
  const [pageIndex, setPageIndex] = useState(1);
  const [pageSize, setPageSize] = useState<number | 'all'>(50);

  // Multi-select state
  const [selectedDocIds, setSelectedDocIds] = useState<Set<string>>(new Set());

  // Instant in-page preview modal / lightbox state
  const [previewDoc, setPreviewDoc] = useState<CrmProductDocument | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  // Zoom & presentation controls for preview lightbox
  const [zoomLevel, setZoomLevel] = useState(100);

  // Deletion modal state
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [activePlan, setActivePlan] = useState<DeletionPlan | null>(null);
  const [deletionRunning, setDeletionRunning] = useState(false);
  const [deletionProgress, setDeletionProgress] = useState<{ completed: number; total: number; currentItem: string } | null>(null);
  const [deletionResult, setDeletionResult] = useState<DeletionExecutionResult | null>(null);

  // Review & Bank Modal state
  const [reviewDoc, setReviewDoc] = useState<CrmProductDocument | null>(null);
  const [reviewProductId, setReviewProductId] = useState<string>('');
  const [reviewProductName, setReviewProductName] = useState<string>('');
  const [reviewProductSourceId, setReviewProductSourceId] = useState<string>('');
  const [reviewMake, setReviewMake] = useState<string>('');
  const [reviewDocType, setReviewDocType] = useState<string>('COA');
  const [reviewSpec, setReviewSpec] = useState<string>('');
  const [reviewBatchNumber, setReviewBatchNumber] = useState<string>('');
  const [reviewSaving, setReviewSaving] = useState(false);

  // Upload modal state
  const [showUpload, setShowUpload] = useState(false);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [selectedInquiryId, setSelectedInquiryId] = useState('');
  const [uploadDocType, setUploadDocType] = useState<typeof DOC_TYPES[number]>('COA');
  const [uploadMake, setUploadMake] = useState('');
  const [uploadSpec, setUploadSpec] = useState('');
  const [uploadBatchNumber, setUploadBatchNumber] = useState('');
  const [uploadProductId, setUploadProductId] = useState('');
  const [uploading, setUploading] = useState(false);
  const [inquiryOptions, setInquiryOptions] = useState<InquiryOption[]>([]);

  // Storage audit modal
  const [showStorageAuditModal, setShowStorageAuditModal] = useState(false);
  const [bankStats, setBankStats] = useState<DocumentBankStats | null>(null);
  const [unlinkedObjects, setUnlinkedObjects] = useState<UnlinkedStorageObject[]>([]);
  const [unlinkedLoading, setUnlinkedLoading] = useState(false);

  useEffect(() => {
    loadDocuments();
    loadStats();
    loadMasters();
  }, []);

  const loadStats = async () => {
    const stats = await fetchDocumentBankStats();
    if (stats) setBankStats(stats);
  };

  const loadMasters = async () => {
    try {
      const [pRes, psRes] = await Promise.all([
        supabase.from('products').select('id,product_name,product_code').order('product_name'),
        supabase.from('product_sources').select('id,product_id,supplier_name,grade,country').order('supplier_name'),
      ]);
      if (pRes.data) setMasterProducts(pRes.data as MasterProductOption[]);
      if (psRes.data) setProductSources(psRes.data as ProductSourceOption[]);
    } catch (e) {
      console.warn('Could not load masters for document bank:', e);
    }
  };

  const loadDocuments = async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('crm_product_documents')
        .select(`
          id,
          inquiry_id,
          product_name,
          make,
          product_id,
          product_source_id,
          document_type,
          specification,
          is_permanent,
          lifecycle_status,
          batch_number,
          batch_id,
          sha256,
          valid_until,
          pricing_option_id,
          original_file_name,
          display_file_name,
          storage_bucket,
          storage_path,
          source_gmail_message_id,
          source_email_subject,
          file_size,
          mime_type,
          uploaded_by,
          reviewed_by,
          reviewed_at,
          created_at,
          enquiry_request_id,
          crm_inquiries(inquiry_number),
          products(id, product_name, product_code),
          product_sources(id, supplier_name, grade, country)
        `)
        .order('created_at', { ascending: false })
        .limit(1000);

      if (error) {
        console.warn('Document bank query notice:', error);
      }
      setDocuments((data || []) as unknown as CrmProductDocument[]);
    } catch (err) {
      console.error('Failed to load CRM documents:', err);
    } finally {
      setLoading(false);
    }
  };

  const loadInquiries = async () => {
    const { data } = await supabase
      .from('crm_inquiries')
      .select('id,inquiry_number,product_name')
      .order('created_at', { ascending: false })
      .limit(300);
    setInquiryOptions((data || []) as InquiryOption[]);
  };

  const openUploadPanel = () => {
    if (!canUpload) return;
    setShowUpload(true);
    if (!inquiryOptions.length) loadInquiries();
  };

  const openStorageAuditModal = async () => {
    setShowStorageAuditModal(true);
    setUnlinkedLoading(true);
    const objects = await fetchUnlinkedStorageObjects();
    setUnlinkedObjects(objects);
    setUnlinkedLoading(false);
  };

  // Filtered Documents Calculation
  const filteredDocuments = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const product = productFilter.trim().toLowerCase();
    const supplier = supplierFilter.trim().toLowerCase();

    return documents.filter(doc => {
      // If cleanup candidates quick toggle is active:
      if (cleanupCandidatesOnly || lifecycleFilter === 'CLEANUP') {
        const isCandidate =
          doc.document_type === 'OTHER' &&
          (doc.lifecycle_status === 'TEMP' || !doc.is_permanent) &&
          !doc.inquiry_id &&
          !doc.pricing_option_id &&
          !doc.enquiry_request_id;
        if (!isCandidate) return false;
      }

      const pName = (doc.product_name || doc.products?.product_name || '').toLowerCase();
      const mName = (doc.make || doc.product_sources?.supplier_name || '').toLowerCase();
      const sName = (doc.specification || '').toLowerCase();
      const fName = (doc.original_file_name || doc.display_file_name || '').toLowerCase();
      const inqNum = ((doc.crm_inquiries as any)?.[0]?.inquiry_number || '').toLowerCase();
      const subject = (doc.source_email_subject || '').toLowerCase();
      const batchNo = (doc.batch_number || '').toLowerCase();

      const matchesSearch =
        !q ||
        pName.includes(q) ||
        mName.includes(q) ||
        sName.includes(q) ||
        fName.includes(q) ||
        inqNum.includes(q) ||
        subject.includes(q) ||
        batchNo.includes(q) ||
        doc.document_type.toLowerCase().includes(q);

      const productOk = !product || pName.includes(product);
      const supplierOk = !supplier || mName.includes(supplier);
      const specOk = specificationFilter === 'all' || doc.specification === specificationFilter;
      const typeOk = documentTypeFilter === 'all' || doc.document_type === documentTypeFilter;

      // 4-state lifecycle filter
      let lifecycleOk = true;
      if (lifecycleFilter !== 'all' && lifecycleFilter !== 'CLEANUP') {
        const status = doc.lifecycle_status || (doc.is_permanent ? 'BANKED' : 'TEMP');
        lifecycleOk = status === lifecycleFilter;
      }

      return matchesSearch && productOk && supplierOk && specOk && typeOk && lifecycleOk;
    });
  }, [
    documents,
    searchQuery,
    productFilter,
    supplierFilter,
    specificationFilter,
    documentTypeFilter,
    lifecycleFilter,
    cleanupCandidatesOnly,
  ]);

  // Pagination calculation
  const totalPages = useMemo(() => {
    if (pageSize === 'all') return 1;
    return Math.max(1, Math.ceil(filteredDocuments.length / pageSize));
  }, [filteredDocuments.length, pageSize]);

  const currentPageDocs = useMemo(() => {
    if (pageSize === 'all') return filteredDocuments;
    const start = (pageIndex - 1) * pageSize;
    return filteredDocuments.slice(start, start + pageSize);
  }, [filteredDocuments, pageIndex, pageSize]);

  // Selection Metrics & Helpers
  const selectedDocs = useMemo(() => {
    return documents.filter(d => selectedDocIds.has(d.id));
  }, [documents, selectedDocIds]);

  const selectedBytes = useMemo(() => {
    return selectedDocs.reduce((acc, d) => acc + (d.file_size || 0), 0);
  }, [selectedDocs]);

  const isAllCurrentPageSelected = useMemo(() => {
    if (currentPageDocs.length === 0) return false;
    return currentPageDocs.every(d => selectedDocIds.has(d.id));
  }, [currentPageDocs, selectedDocIds]);

  const isSomeCurrentPageSelected = useMemo(() => {
    if (currentPageDocs.length === 0) return false;
    return currentPageDocs.some(d => selectedDocIds.has(d.id)) && !isAllCurrentPageSelected;
  }, [currentPageDocs, selectedDocIds, isAllCurrentPageSelected]);

  const toggleSelectDoc = (id: string) => {
    setSelectedDocIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAllCurrentPage = () => {
    setSelectedDocIds(prev => {
      const next = new Set(prev);
      if (isAllCurrentPageSelected) {
        currentPageDocs.forEach(d => next.delete(d.id));
      } else {
        currentPageDocs.forEach(d => next.add(d.id));
      }
      return next;
    });
  };

  const selectAllFiltered = () => {
    setSelectedDocIds(new Set(filteredDocuments.map(d => d.id)));
  };

  const clearSelection = () => {
    setSelectedDocIds(new Set());
  };

  // Preview Handling
  const handleOpenPreview = async (doc: CrmProductDocument) => {
    setPreviewDoc(doc);
    setPreviewUrl(null);
    setPreviewLoading(true);
    setPreviewError(null);
    setZoomLevel(100);

    try {
      const bucket = doc.storage_bucket || 'crm-documents';
      const signed = await getSignedUrlCached(bucket, doc.storage_path, 3600);
      if (!signed) {
        throw new Error('Unable to generate secure signed URL for document.');
      }
      setPreviewUrl(signed);
    } catch (err: any) {
      console.error('Preview signed URL error:', err);
      setPreviewError(err.message || 'Failed to load preview');
    } finally {
      setPreviewLoading(false);
    }
  };

  const handleClosePreview = () => {
    setPreviewDoc(null);
    setPreviewUrl(null);
    setPreviewError(null);
  };

  // Keyboard navigation for preview modal
  const currentPreviewIndex = useMemo(() => {
    if (!previewDoc) return -1;
    return filteredDocuments.findIndex(d => d.id === previewDoc.id);
  }, [previewDoc, filteredDocuments]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!previewDoc) return;
      if (e.key === 'Escape') {
        handleClosePreview();
      } else if (e.key === 'ArrowLeft') {
        if (currentPreviewIndex > 0) {
          e.preventDefault();
          handleOpenPreview(filteredDocuments[currentPreviewIndex - 1]);
        }
      } else if (e.key === 'ArrowRight') {
        if (currentPreviewIndex >= 0 && currentPreviewIndex < filteredDocuments.length - 1) {
          e.preventDefault();
          handleOpenPreview(filteredDocuments[currentPreviewIndex + 1]);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [previewDoc, currentPreviewIndex, filteredDocuments]);

  // Open Review & Bank Modal for a document
  const openReviewModal = (doc: CrmProductDocument) => {
    setReviewDoc(doc);
    setReviewProductId(doc.product_id || '');
    setReviewProductName(doc.product_name || doc.products?.product_name || '');
    setReviewProductSourceId(doc.product_source_id || '');
    setReviewMake(doc.make || doc.product_sources?.supplier_name || '');
    setReviewDocType(doc.document_type || 'COA');
    setReviewSpec(doc.specification || '');
    setReviewBatchNumber(doc.batch_number || '');
  };

  // Available Makes for the currently selected Product in Review Modal
  const availableSourcesForProduct = useMemo(() => {
    if (!reviewProductId) return [];
    return productSources.filter(ps => ps.product_id === reviewProductId);
  }, [reviewProductId, productSources]);

  // Handle Review Lifecycle Update
  const handleSaveLifecycle = async (targetStatus: DocumentLifecycleStatus) => {
    if (!reviewDoc) return;
    setReviewSaving(true);

    try {
      const selectedProd = masterProducts.find(p => p.id === reviewProductId);
      const selectedSrc = productSources.find(ps => ps.id === reviewProductSourceId);

      const resolvedProductName = selectedProd?.product_name || reviewProductName || reviewDoc.product_name;
      const resolvedMake = selectedSrc?.supplier_name || reviewMake || reviewDoc.make;

      const res = await updateDocumentLifecycle(reviewDoc.id, targetStatus, {
        product_id: reviewProductId || null,
        product_source_id: reviewProductSourceId || null,
        product_name: resolvedProductName || null,
        make: resolvedMake || null,
        document_type: reviewDocType,
        specification: reviewSpec || null,
        batch_number: reviewDocType === 'COA' ? reviewBatchNumber || null : null,
      });

      if (!res.success) throw new Error(res.error || 'Failed to update lifecycle');

      showToast({
        type: 'success',
        title: targetStatus === 'BANKED' ? 'Approved into Bank' : targetStatus === 'REVIEWED' ? 'Marked Reviewed' : 'Document Archived',
        message: `${reviewDoc.display_file_name || reviewDoc.original_file_name} is now ${targetStatus}.`,
      });

      setDocuments(prev =>
        prev.map(d =>
          d.id === reviewDoc.id
            ? {
                ...d,
                lifecycle_status: targetStatus,
                is_permanent: targetStatus === 'BANKED',
                product_id: reviewProductId || null,
                product_source_id: reviewProductSourceId || null,
                product_name: resolvedProductName || null,
                make: resolvedMake || null,
                document_type: reviewDocType,
                specification: reviewSpec || null,
                batch_number: reviewDocType === 'COA' ? reviewBatchNumber || null : null,
              }
            : d
        )
      );

      setReviewDoc(null);
      loadStats();
    } catch (err: any) {
      showToast({ type: 'error', title: 'Action Failed', message: err.message || 'Could not update document' });
    } finally {
      setReviewSaving(false);
    }
  };

  // Bulk promote to Banked
  const handleBulkPromote = async () => {
    if (selectedDocs.length === 0) return;
    try {
      const ids = Array.from(selectedDocIds);
      const { error } = await supabase
        .from('crm_product_documents')
        .update({ is_permanent: true, lifecycle_status: 'BANKED' })
        .in('id', ids);

      if (error) throw error;
      setDocuments(prev =>
        prev.map(d => (selectedDocIds.has(d.id) ? { ...d, is_permanent: true, lifecycle_status: 'BANKED' } : d))
      );
      showToast({
        type: 'success',
        title: 'Documents Banked',
        message: `${ids.length} selected documents approved into permanent Banked Library.`,
      });
      clearSelection();
      loadStats();
    } catch (err: any) {
      showToast({ type: 'error', title: 'Action Failed', message: err.message });
    }
  };

  // Open Safe Bulk Deletion Modal
  const openBulkDeleteModal = () => {
    if (selectedDocs.length === 0) return;
    const plan = buildDeletionPlan(selectedDocs, documents);
    setActivePlan(plan);
    setDeletionResult(null);
    setDeletionProgress(null);
    setShowDeleteModal(true);
  };

  // Execute Deletion Plan
  const handleRunDeletion = async (dryRun: boolean) => {
    if (!activePlan) return;
    setDeletionRunning(true);
    setDeletionProgress({ completed: 0, total: activePlan.eligible.length, currentItem: 'Initializing...' });

    const result = await executeSafeDeletion(activePlan, {
      dryRun,
      onProgress: (completed, total, currentItem) => {
        setDeletionProgress({ completed, total, currentItem });
      },
    });

    setDeletionResult(result);
    setDeletionRunning(false);

    if (!dryRun && result.deletedRecordIds.length > 0) {
      const deletedSet = new Set(result.deletedRecordIds);
      setDocuments(prev => prev.filter(d => !deletedSet.has(d.id)));
      setSelectedDocIds(prev => {
        const next = new Set(prev);
        result.deletedRecordIds.forEach(id => next.delete(id));
        return next;
      });
      if (previewDoc && deletedSet.has(previewDoc.id)) {
        handleClosePreview();
      }
      showToast({
        type: 'success',
        title: 'Cleanup Complete',
        message: `Permanently removed ${result.deletedRecordIds.length} records. Reclaimed ${formatBytes(result.reclaimedBytes)}.`,
      });
      loadStats();
    }
  };

  // Single Document Delete
  const handleDeleteSingle = (doc: CrmProductDocument) => {
    const plan = buildDeletionPlan([doc], documents);
    setActivePlan(plan);
    setDeletionResult(null);
    setDeletionProgress(null);
    setShowDeleteModal(true);
  };

  // Upload Submission — Starts strictly as TEMP per policy
  const submitUpload = async () => {
    if (!uploadFile) {
      showToast({ type: 'error', title: 'No file', message: 'Select a file first.' });
      return;
    }
    const selectedInq = inquiryOptions.find(i => i.id === selectedInquiryId);
    const selectedProd = masterProducts.find(p => p.id === uploadProductId);
    setUploading(true);

    const {
      data: { user },
    } = await supabase.auth.getUser();

    const ext = uploadFile.name.split('.').pop() || 'bin';
    const cleanName = uploadFile.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const path = `${selectedInquiryId || 'manual'}/${uploadDocType}_${Date.now()}_${cleanName}`;

    const { error: upErr, optimization } = await uploadOptimizedFile(supabase, 'crm-documents', path, uploadFile);
    if (upErr) {
      showToast({ type: 'error', title: 'Upload failed', message: upErr.message });
      setUploading(false);
      return;
    }

    const resolvedProductName = selectedProd?.product_name || selectedInq?.product_name || 'Document';
    const displayFileName = `${resolvedProductName}_${uploadDocType}.${ext}`;

    await supabase.from('crm_product_documents').insert({
      inquiry_id: selectedInquiryId || null,
      product_id: uploadProductId || null,
      product_name: selectedProd?.product_name || selectedInq?.product_name || null,
      make: uploadMake || null,
      document_type: uploadDocType,
      specification: uploadSpec || null,
      batch_number: uploadDocType === 'COA' ? uploadBatchNumber || null : null,
      is_permanent: false, // Strictly TEMP on initial upload
      lifecycle_status: 'TEMP', // Strictly TEMP on initial upload
      original_file_name: uploadFile.name,
      display_file_name: displayFileName,
      storage_bucket: 'crm-documents',
      storage_path: path,
      file_size: optimization.optimizedSize,
      mime_type: optimization.mimeType || uploadFile.type || 'application/octet-stream',
      uploaded_by: user?.id || null,
    });

    showToast({
      type: 'success',
      title: 'Uploaded to Temporary Inbox',
      message: `${uploadDocType} uploaded as TEMP. Review to approve into Banked Library.`,
    });

    setUploadFile(null);
    setUploadMake('');
    setUploadSpec('');
    setUploadBatchNumber('');
    setUploadProductId('');
    setSelectedInquiryId('');
    setShowUpload(false);
    setUploading(false);
    loadDocuments();
    loadStats();
  };

  // Determine file type category for preview
  const previewDocExt = useMemo(() => {
    if (!previewDoc) return '';
    const name = previewDoc.display_file_name || previewDoc.original_file_name || previewDoc.storage_path;
    return name.split('.').pop()?.toLowerCase() || '';
  }, [previewDoc]);

  const isPdf = previewDocExt === 'pdf';
  const isImage = ['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(previewDocExt);
  const isOffice = ['xlsx', 'xls', 'docx', 'doc', 'csv'].includes(previewDocExt);

  return (
    <div className="space-y-4">
      {/* 1. Header + Storage Metric Cards */}
      <div className="bg-white border border-gray-200 rounded-xl p-4 shadow-2xs">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <div>
            <h3 className="text-base font-bold text-gray-900 flex items-center gap-2">
              <FileText className="w-5 h-5 text-blue-600" />
              <span>{t('crm.documentBank.title', 'CRM Document Bank & Technical Library')}</span>
            </h3>
            <p className="text-xs text-gray-500 mt-0.5">
              Canonical pharmaceutical library organized by Product + Make with strict 4-state lifecycle governance.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={openStorageAuditModal}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-slate-100 text-slate-700 hover:bg-slate-200 rounded-lg border border-slate-200 transition cursor-pointer"
              title="Inspect CRM storage buckets and orphaned objects"
            >
              <HardDrive className="w-3.5 h-3.5 text-slate-600" />
              <span>Storage Audit</span>
            </button>
            {canUpload && (
              <button
                onClick={openUploadPanel}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-blue-600 text-white rounded-lg hover:bg-blue-700 shadow-2xs cursor-pointer transition min-h-[34px]"
              >
                <Upload className="w-3.5 h-3.5" />
                <span>+ Upload Document (TEMP)</span>
              </button>
            )}
          </div>
        </div>

        {/* Dynamic Lifecycle & Storage Metrics */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5 mb-4 bg-slate-50 border border-slate-200 rounded-lg p-3">
          <div
            onClick={() => setLifecycleFilter('BANKED')}
            className={`p-2 rounded-lg cursor-pointer transition border ${
              lifecycleFilter === 'BANKED' ? 'bg-emerald-50 border-emerald-300 ring-1 ring-emerald-400' : 'bg-white border-slate-200/80 hover:bg-emerald-50/50'
            }`}
          >
            <div className="text-[10px] uppercase font-bold text-emerald-700 flex items-center gap-1">
              <ShieldCheck className="w-3 h-3 text-emerald-600" />
              <span>Banked Library</span>
            </div>
            <div className="text-base font-black text-emerald-900">{bankStats ? `${bankStats.banked_count}` : '—'}</div>
            <div className="text-[11px] text-emerald-600 font-medium">Approved Permanent</div>
          </div>

          <div
            onClick={() => setLifecycleFilter('REVIEWED')}
            className={`p-2 rounded-lg cursor-pointer transition border ${
              lifecycleFilter === 'REVIEWED' ? 'bg-blue-50 border-blue-300 ring-1 ring-blue-400' : 'bg-white border-slate-200/80 hover:bg-blue-50/50'
            }`}
          >
            <div className="text-[10px] uppercase font-bold text-blue-700 flex items-center gap-1">
              <CheckCircle2 className="w-3 h-3 text-blue-600" />
              <span>Reviewed</span>
            </div>
            <div className="text-base font-black text-blue-900">{bankStats ? `${bankStats.reviewed_count}` : '—'}</div>
            <div className="text-[11px] text-blue-600 font-medium">Verified Product/Make</div>
          </div>

          <div
            onClick={() => setLifecycleFilter('TEMP')}
            className={`p-2 rounded-lg cursor-pointer transition border ${
              lifecycleFilter === 'TEMP' ? 'bg-amber-50 border-amber-300 ring-1 ring-amber-400' : 'bg-white border-slate-200/80 hover:bg-amber-50/50'
            }`}
          >
            <div className="text-[10px] uppercase font-bold text-amber-700 flex items-center gap-1">
              <Clock className="w-3 h-3 text-amber-600" />
              <span>Temporary / Inbox</span>
            </div>
            <div className="text-base font-black text-amber-900">{bankStats ? `${bankStats.temp_count}` : '—'}</div>
            <div className="text-[11px] text-amber-600 font-medium">Needs Verification</div>
          </div>

          <div
            onClick={() => setLifecycleFilter('ARCHIVED')}
            className={`p-2 rounded-lg cursor-pointer transition border ${
              lifecycleFilter === 'ARCHIVED' ? 'bg-slate-200 border-slate-300 ring-1 ring-slate-400' : 'bg-white border-slate-200/80 hover:bg-slate-100'
            }`}
          >
            <div className="text-[10px] uppercase font-bold text-slate-700 flex items-center gap-1">
              <Archive className="w-3 h-3 text-slate-500" />
              <span>Archived</span>
            </div>
            <div className="text-base font-black text-slate-900">{bankStats ? `${bankStats.archived_count}` : '0'}</div>
            <div className="text-[11px] text-slate-500 font-medium">Superseded / Expired</div>
          </div>

          <div className="bg-white border border-slate-200/80 rounded-lg p-2">
            <div className="text-[10px] uppercase font-bold text-slate-500 flex items-center gap-1">
              <HardDrive className="w-3 h-3 text-slate-400" />
              <span>Storage Bucket</span>
            </div>
            <div className="text-base font-black text-slate-900">{bankStats ? `${bankStats.bucket_total_objects} obj` : '—'}</div>
            <div className="text-[11px] text-slate-500 font-mono">{bankStats ? formatBytes(bankStats.bucket_total_bytes) : '—'}</div>
          </div>

          <div className="bg-white border border-slate-200/80 rounded-lg p-2">
            <div className="text-[10px] uppercase font-bold text-blue-700 flex items-center gap-1">
              <CheckSquare className="w-3 h-3 text-blue-600" />
              <span>Selected Storage</span>
            </div>
            <div className="text-base font-black text-blue-700 font-mono">{formatBytes(selectedBytes)}</div>
            <div className="text-[11px] text-blue-600 font-medium">{selectedDocIds.size} records</div>
          </div>
        </div>

        {/* Upload Form (TEMP Ingestion) */}
        {showUpload && (
          <div className="mb-4 p-4 border border-blue-200 bg-blue-50/70 rounded-lg space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs font-bold text-blue-900">Upload Ingestion (Starts in Temporary Queue)</p>
                <p className="text-[11px] text-blue-700">Documents start as TEMP until verified and approved into the Banked Library.</p>
              </div>
              <button onClick={() => setShowUpload(false)} className="text-gray-400 hover:text-gray-600 cursor-pointer">
                <X className="w-4 h-4" />
              </button>
            </div>
            <SapRow>
              <FloatingField label="Master Product (optional)" filled={!!uploadProductId} span={4}>
                <select
                  value={uploadProductId}
                  onChange={e => setUploadProductId(e.target.value)}
                  className={FLOAT_INPUT}
                >
                  <option value="">Select master product...</option>
                  {masterProducts.map(p => (
                    <option key={p.id} value={p.id}>
                      {p.product_name} {p.product_code ? `(${p.product_code})` : ''}
                    </option>
                  ))}
                </select>
              </FloatingField>
              <FloatingField label="Linked Inquiry (optional)" filled={!!selectedInquiryId} span={4}>
                <select
                  value={selectedInquiryId}
                  onChange={e => setSelectedInquiryId(e.target.value)}
                  className={FLOAT_INPUT}
                >
                  <option value="">No specific inquiry</option>
                  {inquiryOptions.map(i => (
                    <option key={i.id} value={i.id}>
                      {i.inquiry_number} — {i.product_name}
                    </option>
                  ))}
                </select>
              </FloatingField>
              <FloatingField label="Document Type" filled={!!uploadDocType} span={4}>
                <select
                  value={uploadDocType}
                  onChange={e => setUploadDocType(e.target.value as typeof DOC_TYPES[number])}
                  className={FLOAT_INPUT}
                >
                  {DOC_TYPES.map(t => (
                    <option key={t}>{t}</option>
                  ))}
                </select>
              </FloatingField>
              <FloatingField label="Make / Manufacturer" filled={!!uploadMake} span={4}>
                <input
                  value={uploadMake}
                  onChange={e => setUploadMake(e.target.value)}
                  placeholder="e.g. Aarti Drugs, IPCA, Curequest"
                  className={FLOAT_INPUT}
                />
              </FloatingField>
              <FloatingField label="Specification / Standard" filled={!!uploadSpec} span={4}>
                <input
                  value={uploadSpec}
                  onChange={e => setUploadSpec(e.target.value)}
                  placeholder="e.g. USP, BP, EP, IP"
                  className={FLOAT_INPUT}
                />
              </FloatingField>
              {uploadDocType === 'COA' && (
                <FloatingField label="Batch Number (for COA)" filled={!!uploadBatchNumber} span={4}>
                  <input
                    value={uploadBatchNumber}
                    onChange={e => setUploadBatchNumber(e.target.value)}
                    placeholder="e.g. 2610712 / B-4277"
                    className={FLOAT_INPUT}
                  />
                </FloatingField>
              )}
              <FloatingField label="Select File (PDF / Images / Docs)" staticLabel span={12}>
                <input
                  type="file"
                  accept=".pdf,.doc,.docx,.xls,.xlsx,.png,.jpg,.jpeg"
                  onChange={e => setUploadFile(e.target.files?.[0] || null)}
                  className="w-full text-xs file:mr-2 file:py-1 file:px-2.5 file:rounded file:border-0 file:text-xs file:font-semibold file:bg-blue-100 file:text-blue-700 cursor-pointer"
                />
              </FloatingField>
            </SapRow>
            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setShowUpload(false)}
                className="px-3 py-1 bg-white border border-gray-300 text-gray-700 rounded text-xs hover:bg-gray-50 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={submitUpload}
                disabled={!uploadFile || uploading}
                className="flex items-center gap-1 px-4 py-1 text-xs font-semibold bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 cursor-pointer shadow-2xs"
              >
                <Upload className="w-3.5 h-3.5" />
                <span>{uploading ? 'Uploading…' : 'Upload to Temporary Queue'}</span>
              </button>
            </div>
          </div>
        )}

        {/* Multi-Field Search & Lifecycle Toolbar */}
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-6 gap-2">
          <div className="relative md:col-span-2">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
            <input
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder="Search product, make, batch, file, inquiry, or spec..."
              className="w-full border border-slate-200 rounded-lg pl-8 pr-2.5 py-1.5 text-xs bg-slate-50 focus:bg-white focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>
          <select
            value={documentTypeFilter}
            onChange={e => setDocumentTypeFilter(e.target.value)}
            className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-xs font-medium text-slate-700 bg-white"
          >
            <option value="all">All Document Types</option>
            {DOC_TYPES.map(type => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
          <select
            value={specificationFilter}
            onChange={e => setSpecificationFilter(e.target.value)}
            className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-xs text-slate-700 bg-white"
          >
            <option value="all">All Specifications</option>
            {COMMON_SPECS.map(s => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <select
            value={lifecycleFilter}
            onChange={e => setLifecycleFilter(e.target.value as any)}
            className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-xs font-semibold text-slate-700 bg-white"
          >
            <option value="all">All Lifecycle States</option>
            <option value="BANKED">Banked Library (Permanent)</option>
            <option value="REVIEWED">Reviewed Documents</option>
            <option value="TEMP">Temporary / Ingestion Queue</option>
            <option value="ARCHIVED">Archived / Superseded</option>
            <option value="CLEANUP">Cleanup Pool (Unlinked Junk)</option>
          </select>
          <button
            type="button"
            onClick={() => {
              setSearchQuery('');
              setDocumentTypeFilter('all');
              setSpecificationFilter('all');
              setLifecycleFilter('all');
              setCleanupCandidatesOnly(false);
            }}
            className="px-2.5 py-1.5 text-xs text-slate-600 hover:text-slate-800 bg-slate-100 hover:bg-slate-200 rounded-lg transition text-center font-medium"
          >
            Reset Filters
          </button>
        </div>
      </div>

      {/* 2. Bulk Selection Action Bar */}
      {selectedDocIds.size > 0 && (
        <div className="bg-blue-50 border border-blue-200 rounded-xl px-4 py-2.5 flex flex-wrap items-center justify-between gap-3 shadow-2xs animate-in fade-in duration-150">
          <div className="flex items-center gap-3">
            <span className="text-xs font-bold text-blue-900">
              {selectedDocIds.size} document{selectedDocIds.size > 1 ? 's' : ''} selected ({formatBytes(selectedBytes)})
            </span>
            {selectedDocIds.size < filteredDocuments.length && (
              <button
                type="button"
                onClick={selectAllFiltered}
                className="text-xs text-blue-700 hover:text-blue-900 underline font-medium cursor-pointer"
              >
                Select all {filteredDocuments.length} matching filtered records
              </button>
            )}
            <button
              type="button"
              onClick={clearSelection}
              className="text-xs text-slate-500 hover:text-slate-700 underline cursor-pointer"
            >
              Clear selection
            </button>
          </div>

          <div className="flex items-center gap-2">
            {canUpload && (
              <>
                <button
                  type="button"
                  onClick={handleBulkPromote}
                  className="flex items-center gap-1 px-3 py-1.5 text-xs font-semibold bg-white text-emerald-700 border border-emerald-300 hover:bg-emerald-50 rounded-lg cursor-pointer transition shadow-2xs"
                  title="Approve all selected documents into Banked Library"
                >
                  <ShieldCheck className="w-3.5 h-3.5 text-emerald-600" />
                  <span>Approve to Banked</span>
                </button>
                <button
                  type="button"
                  onClick={openBulkDeleteModal}
                  className="flex items-center gap-1 px-3 py-1.5 text-xs font-semibold bg-red-600 text-white hover:bg-red-700 rounded-lg cursor-pointer transition shadow-2xs"
                  title="Safely review and delete selected documents"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>Delete Selected ({selectedDocIds.size})</span>
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {/* 3. Main Workspace: Documents Table */}
      <div className="w-full">
        <div className="bg-white border border-slate-200/90 rounded-xl overflow-hidden shadow-2xs">
          {/* Table pagination & scope toolbar */}
          <div className="px-3 py-2 bg-slate-50 border-b border-slate-200 flex flex-wrap items-center justify-between text-xs text-slate-600 gap-2">
            <div className="flex items-center gap-2">
              <span className="font-semibold text-slate-800">
                {filteredDocuments.length} document{filteredDocuments.length !== 1 ? 's' : ''}
              </span>
              {lifecycleFilter !== 'all' && (
                <span className="text-[10px] bg-blue-100 text-blue-800 px-1.5 py-0.5 rounded font-semibold border border-blue-200">
                  {lifecycleFilter}
                </span>
              )}
            </div>
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-1">
                <span className="text-[11px] text-slate-500">Rows:</span>
                <select
                  value={pageSize}
                  onChange={e => {
                    setPageSize(e.target.value === 'all' ? 'all' : Number(e.target.value));
                    setPageIndex(1);
                  }}
                  className="border border-slate-200 rounded px-1.5 py-0.5 text-xs bg-white text-slate-700"
                >
                  <option value={25}>25</option>
                  <option value={50}>50</option>
                  <option value={100}>100</option>
                  <option value="all">All</option>
                </select>
              </div>
              {pageSize !== 'all' && (
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    disabled={pageIndex <= 1}
                    onClick={() => setPageIndex(p => Math.max(1, p - 1))}
                    className="p-1 border border-slate-200 rounded bg-white hover:bg-slate-50 disabled:opacity-40 cursor-pointer"
                  >
                    <ChevronLeft className="w-3.5 h-3.5" />
                  </button>
                  <span className="text-[11px] px-1 font-mono">
                    {pageIndex} / {totalPages}
                  </span>
                  <button
                    type="button"
                    disabled={pageIndex >= totalPages}
                    onClick={() => setPageIndex(p => Math.min(totalPages, p + 1))}
                    className="p-1 border border-slate-200 rounded bg-white hover:bg-slate-50 disabled:opacity-40 cursor-pointer"
                  >
                    <ChevronRight className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="min-w-full text-xs">
              <thead className="bg-slate-50 border-b border-slate-200 text-slate-600 font-semibold uppercase text-[10px] tracking-wider">
                <tr className="h-8">
                  <th className="w-8 px-2 py-1 text-center">
                    <button
                      type="button"
                      onClick={toggleSelectAllCurrentPage}
                      className="text-slate-500 hover:text-blue-600 cursor-pointer"
                      title={isAllCurrentPageSelected ? 'Deselect current page' : 'Select current page'}
                    >
                      {isAllCurrentPageSelected ? (
                        <CheckSquare className="w-4 h-4 text-blue-600" />
                      ) : isSomeCurrentPageSelected ? (
                        <MinusSquare className="w-4 h-4 text-blue-600" />
                      ) : (
                        <Square className="w-4 h-4 text-slate-400" />
                      )}
                    </button>
                  </th>
                  <th className="px-2 py-1 text-left">Product</th>
                  <th className="px-2 py-1 text-left">Make / Source</th>
                  <th className="px-2 py-1 text-left">Doc Type</th>
                  <th className="px-2 py-1 text-left">File Name</th>
                  <th className="px-2 py-1 text-right">Size</th>
                  <th className="px-2 py-1 text-left">Inquiry / Batch</th>
                  <th className="px-2 py-1 text-left">Lifecycle</th>
                  <th className="px-2 py-1 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {loading ? (
                  <tr>
                    <td colSpan={9} className="px-4 py-8 text-center text-gray-500">
                      Loading documents from bank…
                    </td>
                  </tr>
                ) : filteredDocuments.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="px-4 py-8 text-center text-gray-500">
                      No documents match the active search filters.
                    </td>
                  </tr>
                ) : (
                  currentPageDocs.map(doc => {
                    const isSelected = selectedDocIds.has(doc.id);
                    const isPreviewActive = previewDoc?.id === doc.id;
                    const status = doc.lifecycle_status || (doc.is_permanent ? 'BANKED' : 'TEMP');

                    return (
                      <tr
                        key={doc.id}
                        className={`h-8 transition-colors ${
                          isPreviewActive
                            ? 'bg-blue-50/70 border-l-4 border-l-blue-600 font-medium'
                            : isSelected
                            ? 'bg-blue-50/30'
                            : 'hover:bg-slate-50'
                        }`}
                      >
                        <td className="w-8 px-2 py-1 text-center">
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => toggleSelectDoc(doc.id)}
                            className="w-3.5 h-3.5 rounded text-blue-600 border-slate-300 focus:ring-blue-500 cursor-pointer"
                          />
                        </td>
                        <td className="px-2 py-1 font-semibold text-slate-900 max-w-[140px] truncate" title={doc.product_name || 'Unassigned'}>
                          <div className="flex items-center gap-1 truncate">
                            {doc.product_id ? (
                              <span title="Linked to Master Product">
                                <Package className="w-3 h-3 text-emerald-600 shrink-0" />
                              </span>
                            ) : null}
                            <span className="truncate">{doc.product_name || doc.products?.product_name || 'Unassigned'}</span>
                          </div>
                        </td>
                        <td className="px-2 py-1 text-slate-700 max-w-[110px] truncate" title={doc.make || '-'}>
                          <div className="flex items-center gap-1 truncate">
                            {doc.product_source_id ? (
                              <span title="Linked to Master Make (Product Source)">
                                <Building2 className="w-3 h-3 text-blue-600 shrink-0" />
                              </span>
                            ) : null}
                            <span className="truncate">{doc.make || doc.product_sources?.supplier_name || '-'}</span>
                          </div>
                        </td>
                        <td className="px-2 py-1 whitespace-nowrap">
                          <span
                            className={`px-1.5 py-0.5 rounded text-[9.5px] font-bold border ${
                              DOC_TYPE_COLOR[doc.document_type] || 'bg-slate-100 text-slate-600 border-slate-200'
                            }`}
                          >
                            {doc.document_type}
                          </span>
                        </td>
                        <td
                          className="px-2 py-1 text-slate-700 max-w-[190px] truncate font-mono text-[11px]"
                          title={doc.display_file_name || doc.original_file_name || doc.storage_path}
                        >
                          <button
                            type="button"
                            onClick={() => handleOpenPreview(doc)}
                            className="text-left font-mono text-[11px] text-blue-700 hover:text-blue-900 hover:underline truncate max-w-full cursor-pointer"
                            title={`Click to preview: ${doc.display_file_name || doc.original_file_name}`}
                          >
                            <span className="truncate">{doc.display_file_name || doc.original_file_name || doc.storage_path.split('/').pop()}</span>
                          </button>
                        </td>
                        <td className="px-2 py-1 text-right font-mono text-[11px] text-slate-500 whitespace-nowrap">
                          {formatBytes(doc.file_size)}
                        </td>
                        <td className="px-2 py-1 text-slate-700 whitespace-nowrap">
                          <div className="flex flex-col">
                            <span>{(doc.crm_inquiries as any)?.[0]?.inquiry_number || '-'}</span>
                            {doc.batch_number && (
                              <span className="text-[10px] text-purple-700 font-mono font-medium">
                                Batch: {doc.batch_number}
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="px-2 py-1 whitespace-nowrap">
                          {status === 'BANKED' ? (
                            <span className="inline-flex items-center gap-1 text-[9.5px] text-emerald-700 font-semibold bg-emerald-50 border border-emerald-200 px-1.5 py-0.5 rounded">
                              <ShieldCheck className="w-2.5 h-2.5" />
                              Banked
                            </span>
                          ) : status === 'REVIEWED' ? (
                            <span className="inline-flex items-center gap-1 text-[9.5px] text-blue-700 font-semibold bg-blue-50 border border-blue-200 px-1.5 py-0.5 rounded">
                              <CheckCircle2 className="w-2.5 h-2.5" />
                              Reviewed
                            </span>
                          ) : status === 'ARCHIVED' ? (
                            <span className="inline-flex items-center gap-1 text-[9.5px] text-slate-600 font-medium bg-slate-100 border border-slate-200 px-1.5 py-0.5 rounded">
                              <Archive className="w-2.5 h-2.5" />
                              Archived
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-[9.5px] text-amber-700 font-medium bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded">
                              <Clock className="w-2.5 h-2.5" />
                              Temp
                            </span>
                          )}
                        </td>
                        <td className="px-2 py-1 text-right whitespace-nowrap">
                          <div className="flex items-center justify-end gap-1">
                            {/* Instant Preview */}
                            <button
                              type="button"
                              onClick={() => handleOpenPreview(doc)}
                              className={`p-1.5 rounded cursor-pointer transition flex items-center justify-center ${
                                isPreviewActive
                                  ? 'bg-blue-600 text-white shadow-2xs'
                                  : 'text-blue-600 hover:bg-blue-50 hover:text-blue-800'
                              }`}
                              title="Instant In-Page Preview"
                            >
                              <Eye className="w-3.5 h-3.5" />
                            </button>

                            {/* Review & Bank Action */}
                            {canUpload && (
                              <button
                                type="button"
                                onClick={() => openReviewModal(doc)}
                                className="px-1.5 py-0.5 text-[9.5px] font-semibold text-blue-700 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded cursor-pointer transition"
                                title="Review, classify Product + Make, and manage lifecycle"
                              >
                                <Sparkles className="w-3 h-3 inline mr-0.5 text-blue-600" />
                                Review
                              </button>
                            )}

                            <a
                              href={`https://wa.me/?text=${encodeURIComponent(
                                `Halo, berikut dokumen teknis ${doc.document_type} untuk produk ${doc.product_name || 'Bahan Baku'} (${
                                  doc.make || ''
                                }): ${doc.display_file_name || doc.original_file_name || ''}`
                              )}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="p-1 text-emerald-600 hover:bg-emerald-50 rounded cursor-pointer"
                              title="Share via WhatsApp"
                            >
                              <MessageSquare className="w-3.5 h-3.5" />
                            </a>

                            {canUpload && (
                              <button
                                type="button"
                                onClick={() => handleDeleteSingle(doc)}
                                className="p-1 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded cursor-pointer"
                                title="Delete Document"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* 4. Review & Bank Lifecycle Modal */}
      {reviewDoc && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-3 animate-in fade-in duration-150">
          <div className="bg-white rounded-2xl max-w-xl w-full flex flex-col shadow-2xl overflow-hidden border border-slate-200">
            <div className="p-4 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="p-2 bg-blue-100 rounded-lg text-blue-700">
                  <ShieldCheck className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-slate-900">Review & Bank Document</h3>
                  <p className="text-xs text-slate-500">
                    Verify Product + Make master ownership and approve into permanent library.
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setReviewDoc(null)}
                className="text-slate-400 hover:text-slate-600 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-4 space-y-3.5 text-xs overflow-y-auto max-h-[75vh]">
              {/* Document Summary Info */}
              <div className="bg-slate-50 border border-slate-200 rounded-xl p-3 space-y-1 font-mono text-[11px]">
                <div className="flex justify-between text-slate-600">
                  <span className="text-slate-500">File:</span>
                  <span className="font-semibold text-slate-900 truncate max-w-[320px]">
                    {reviewDoc.display_file_name || reviewDoc.original_file_name}
                  </span>
                </div>
                <div className="flex justify-between text-slate-600">
                  <span className="text-slate-500">Size:</span>
                  <span>{formatBytes(reviewDoc.file_size)}</span>
                </div>
                <div className="flex justify-between text-slate-600">
                  <span className="text-slate-500">Current Lifecycle:</span>
                  <span className="font-bold text-blue-700">
                    {reviewDoc.lifecycle_status || (reviewDoc.is_permanent ? 'BANKED' : 'TEMP')}
                  </span>
                </div>
              </div>

              {/* Product Selection */}
              <div>
                <label className="block text-[11px] font-bold text-slate-700 uppercase tracking-wide mb-1">
                  Master Product
                </label>
                <select
                  value={reviewProductId}
                  onChange={e => {
                    const pid = e.target.value;
                    setReviewProductId(pid);
                    const prod = masterProducts.find(p => p.id === pid);
                    if (prod) setReviewProductName(prod.product_name);
                    setReviewProductSourceId('');
                  }}
                  className="w-full border border-slate-300 rounded-lg px-2.5 py-1.5 text-xs bg-white text-slate-800 focus:ring-1 focus:ring-blue-500"
                >
                  <option value="">-- Match to Master Product (or keep text) --</option>
                  {masterProducts.map(p => (
                    <option key={p.id} value={p.id}>
                      {p.product_name} {p.product_code ? `(${p.product_code})` : ''}
                    </option>
                  ))}
                </select>
                {!reviewProductId && (
                  <input
                    value={reviewProductName}
                    onChange={e => setReviewProductName(e.target.value)}
                    placeholder="Or enter custom product name..."
                    className="w-full mt-1.5 border border-slate-200 rounded-lg px-2.5 py-1 text-xs bg-slate-50"
                  />
                )}
              </div>

              {/* Make / Product Source Selection */}
              <div>
                <label className="block text-[11px] font-bold text-slate-700 uppercase tracking-wide mb-1">
                  Make / Manufacturer / Source
                </label>
                {availableSourcesForProduct.length > 0 ? (
                  <select
                    value={reviewProductSourceId}
                    onChange={e => {
                      const sid = e.target.value;
                      setReviewProductSourceId(sid);
                      const src = availableSourcesForProduct.find(s => s.id === sid);
                      if (src) setReviewMake(src.supplier_name);
                    }}
                    className="w-full border border-slate-300 rounded-lg px-2.5 py-1.5 text-xs bg-white text-slate-800 focus:ring-1 focus:ring-blue-500"
                  >
                    <option value="">-- Select Master Make for this Product --</option>
                    {availableSourcesForProduct.map(s => (
                      <option key={s.id} value={s.id}>
                        {s.supplier_name} {s.grade ? `(${s.grade})` : ''} {s.country ? `— ${s.country}` : ''}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    value={reviewMake}
                    onChange={e => setReviewMake(e.target.value)}
                    placeholder="e.g. Aarti Drugs, IPCA, Curequest"
                    className="w-full border border-slate-300 rounded-lg px-2.5 py-1.5 text-xs bg-white text-slate-800 focus:ring-1 focus:ring-blue-500"
                  />
                )}
              </div>

              {/* Document Type & Spec */}
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-[11px] font-bold text-slate-700 uppercase tracking-wide mb-1">
                    Document Type
                  </label>
                  <select
                    value={reviewDocType}
                    onChange={e => setReviewDocType(e.target.value)}
                    className="w-full border border-slate-300 rounded-lg px-2.5 py-1.5 text-xs bg-white text-slate-800"
                  >
                    {DOC_TYPES.map(t => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-[11px] font-bold text-slate-700 uppercase tracking-wide mb-1">
                    Specification
                  </label>
                  <input
                    value={reviewSpec}
                    onChange={e => setReviewSpec(e.target.value)}
                    placeholder="e.g. USP, BP, EP, IP"
                    className="w-full border border-slate-300 rounded-lg px-2.5 py-1.5 text-xs bg-white text-slate-800"
                  />
                </div>
              </div>

              {/* COA Batch Number Field (Batch Specificity Requirement) */}
              {reviewDocType === 'COA' && (
                <div className="p-2.5 bg-purple-50 border border-purple-200 rounded-xl space-y-1">
                  <label className="block text-[11px] font-bold text-purple-900 uppercase tracking-wide">
                    COA Batch Number (Required for Batch Traceability)
                  </label>
                  <input
                    value={reviewBatchNumber}
                    onChange={e => setReviewBatchNumber(e.target.value)}
                    placeholder="Enter batch number (e.g. 2610712 / B-4277)"
                    className="w-full border border-purple-300 rounded-lg px-2.5 py-1.5 text-xs bg-white text-purple-950 font-mono focus:ring-1 focus:ring-purple-500"
                  />
                  <p className="text-[10px] text-purple-700">
                    COAs in the pharmaceutical library remain tied to their specific manufacturing batch.
                  </p>
                </div>
              )}
            </div>

            {/* Modal Actions */}
            <div className="p-3 bg-slate-50 border-t border-slate-200 flex flex-wrap items-center justify-between gap-2">
              <button
                type="button"
                disabled={reviewSaving}
                onClick={() => handleSaveLifecycle('ARCHIVED')}
                className="flex items-center gap-1 px-3 py-1.5 bg-slate-200 hover:bg-slate-300 text-slate-700 text-xs font-semibold rounded-lg cursor-pointer transition"
                title="Archive as obsolete or superseded"
              >
                <Archive className="w-3.5 h-3.5" />
                <span>Archive</span>
              </button>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={reviewSaving}
                  onClick={() => handleSaveLifecycle('REVIEWED')}
                  className="flex items-center gap-1 px-3 py-1.5 bg-blue-100 hover:bg-blue-200 text-blue-800 text-xs font-semibold rounded-lg cursor-pointer transition"
                >
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  <span>Save as Reviewed</span>
                </button>
                <button
                  type="button"
                  disabled={reviewSaving}
                  onClick={() => handleSaveLifecycle('BANKED')}
                  className="flex items-center gap-1 px-4 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold rounded-lg cursor-pointer transition shadow-2xs"
                >
                  <ShieldCheck className="w-3.5 h-3.5" />
                  <span>Approve to Banked Library</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 5. Centred In-App Document Preview Modal / Lightbox */}
      {previewDoc && (
        <div
          className="fixed inset-0 z-[9999] bg-slate-950/80 backdrop-blur-xs flex items-center justify-center p-2 sm:p-4 md:p-6 animate-in fade-in duration-150"
          onClick={handleClosePreview}
          role="dialog"
          aria-modal="true"
        >
          <div
            className="relative w-full h-full sm:w-[90vw] sm:max-w-6xl sm:h-[88vh] sm:max-h-[920px] bg-white rounded-xl sm:rounded-2xl shadow-2xl flex flex-col overflow-hidden border border-slate-200"
            onClick={e => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div className="px-4 py-3 bg-slate-900 text-white flex items-center justify-between shrink-0 border-b border-slate-800">
              <div className="flex items-center gap-2.5 min-w-0 pr-2">
                <div className="p-1.5 bg-blue-600/30 text-blue-400 rounded-lg shrink-0">
                  <FileText className="w-4 h-4" />
                </div>
                <div className="min-w-0">
                  <h4 className="text-xs sm:text-sm font-bold text-white truncate max-w-sm sm:max-w-md md:max-w-xl">
                    {previewDoc.display_file_name || previewDoc.original_file_name || previewDoc.storage_path.split('/').pop()}
                  </h4>
                  <div className="flex items-center gap-2 text-[10.5px] text-slate-400 font-mono truncate">
                    <span
                      className={`px-1.5 py-0.2 rounded font-sans font-bold text-[9px] uppercase border ${
                        DOC_TYPE_COLOR[previewDoc.document_type] || 'bg-slate-800 text-slate-300 border-slate-700'
                      }`}
                    >
                      {previewDoc.document_type}
                    </span>
                    <span>•</span>
                    <span>{formatBytes(previewDoc.file_size)}</span>
                    {previewDoc.product_name && (
                      <>
                        <span>•</span>
                        <span className="text-slate-300 font-sans truncate">{previewDoc.product_name}</span>
                      </>
                    )}
                    {previewDoc.make && (
                      <>
                        <span>•</span>
                        <span className="text-slate-400 font-sans truncate">({previewDoc.make})</span>
                      </>
                    )}
                  </div>
                </div>
              </div>

              {/* Header Right Actions */}
              <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
                {/* Image Zoom Controls */}
                {isImage && previewUrl && (
                  <div className="hidden sm:flex items-center bg-slate-800 rounded-lg p-0.5 border border-slate-700 mr-1">
                    <button
                      type="button"
                      onClick={() => setZoomLevel(z => Math.max(25, z - 25))}
                      className="p-1 text-slate-300 hover:text-white hover:bg-slate-700 rounded cursor-pointer"
                      title="Zoom Out (-25%)"
                    >
                      <ZoomOut className="w-3.5 h-3.5" />
                    </button>
                    <span className="px-1.5 text-[10.5px] font-mono text-slate-300">{zoomLevel}%</span>
                    <button
                      type="button"
                      onClick={() => setZoomLevel(z => Math.min(300, z + 25))}
                      className="p-1 text-slate-300 hover:text-white hover:bg-slate-700 rounded cursor-pointer"
                      title="Zoom In (+25%)"
                    >
                      <ZoomIn className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setZoomLevel(100)}
                      className="p-1 text-slate-400 hover:text-white hover:bg-slate-700 rounded cursor-pointer border-l border-slate-700 ml-0.5"
                      title="Reset Zoom (100%)"
                    >
                      <RotateCcw className="w-3 h-3" />
                    </button>
                  </div>
                )}

                {/* External Download / Open */}
                {previewUrl && (
                  <a
                    href={previewUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1 px-2.5 py-1 text-xs font-semibold bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition shadow-2xs"
                    title="Open or download file in external tab"
                  >
                    <Download className="w-3.5 h-3.5" />
                    <span className="hidden sm:inline">Download</span>
                  </a>
                )}

                {/* Lightbox Close */}
                <button
                  type="button"
                  onClick={handleClosePreview}
                  className="p-1.5 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition cursor-pointer"
                  title="Close preview (Esc)"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            {/* Modal Body */}
            <div className="flex-1 bg-slate-900/95 relative overflow-hidden flex items-center justify-center">
              {previewLoading ? (
                <div className="flex flex-col items-center justify-center text-slate-400 gap-2">
                  <RefreshCw className="w-6 h-6 animate-spin text-blue-500" />
                  <span className="text-xs">Generating secure preview token…</span>
                </div>
              ) : previewError ? (
                <div className="p-6 max-w-md bg-slate-800/80 border border-slate-700 rounded-xl text-center space-y-3">
                  <AlertTriangle className="w-8 h-8 text-amber-400 mx-auto" />
                  <div className="text-sm font-semibold text-white">Preview Unavailable</div>
                  <div className="text-xs text-slate-400">{previewError}</div>
                </div>
              ) : previewUrl ? (
                isPdf ? (
                  <iframe
                    src={`${previewUrl}#toolbar=1&navpanes=0`}
                    title={previewDoc.display_file_name || 'PDF Preview'}
                    className="w-full h-full border-0 bg-white"
                  />
                ) : isImage ? (
                  <div className="w-full h-full overflow-auto flex items-center justify-center p-4">
                    <img
                      src={previewUrl}
                      alt={previewDoc.display_file_name || 'Document'}
                      style={{
                        transform: `scale(${zoomLevel / 100})`,
                        transition: 'transform 0.15s ease-out',
                      }}
                      className="max-w-full max-h-full object-contain rounded-lg shadow-lg select-none"
                    />
                  </div>
                ) : (
                  <div className="p-8 max-w-lg bg-slate-800 border border-slate-700 rounded-2xl text-center space-y-4">
                    <div className="p-4 bg-emerald-500/10 text-emerald-400 rounded-2xl w-16 h-16 mx-auto flex items-center justify-center">
                      <FileSpreadsheet className="w-8 h-8" />
                    </div>
                    <div>
                      <h4 className="text-base font-bold text-white mb-1">
                        {previewDoc.display_file_name || previewDoc.original_file_name}
                      </h4>
                      <p className="text-xs text-slate-400">
                        Spreadsheet & Office files are securely stored. Click below to download and open locally.
                      </p>
                    </div>
                    <div className="text-xs font-mono text-slate-400 bg-slate-900/60 p-2.5 rounded-lg border border-slate-800">
                      <div>Size: {formatBytes(previewDoc.file_size)}</div>
                      <div>Path: {previewDoc.storage_path}</div>
                    </div>
                    <a
                      href={previewUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-2 px-5 py-2 text-xs font-bold bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl shadow-md transition"
                    >
                      <Download className="w-4 h-4" />
                      <span>Download Document</span>
                    </a>
                  </div>
                )
              ) : null}
            </div>

            {/* Modal Footer */}
            <div className="px-4 py-2 bg-slate-900 border-t border-slate-800 flex items-center justify-between text-xs text-slate-400 shrink-0">
              <div className="flex items-center gap-2">
                <span className="font-mono text-[11px]">
                  {currentPreviewIndex + 1} of {filteredDocuments.length}
                </span>
                <span className="hidden sm:inline text-slate-600">•</span>
                <span className="hidden sm:inline text-[11px] text-slate-500">
                  Use Left / Right arrow keys to navigate, Esc to close
                </span>
              </div>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  disabled={currentPreviewIndex <= 0}
                  onClick={() => handleOpenPreview(filteredDocuments[currentPreviewIndex - 1])}
                  className="p-1 rounded hover:bg-slate-800 disabled:opacity-30 cursor-pointer"
                  title="Previous document"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  disabled={currentPreviewIndex >= filteredDocuments.length - 1}
                  onClick={() => handleOpenPreview(filteredDocuments[currentPreviewIndex + 1])}
                  className="p-1 rounded hover:bg-slate-800 disabled:opacity-30 cursor-pointer"
                  title="Next document"
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 6. Safe Deletion Review & Confirmation Modal */}
      {showDeleteModal && activePlan && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-2xl w-full max-h-[90vh] flex flex-col shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150">
            {/* Modal Header */}
            <div className="p-4 bg-red-50 border-b border-red-100 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="p-2 bg-red-100 rounded-lg text-red-700">
                  <AlertTriangle className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-red-950">Safe Deletion & Reference Check</h3>
                  <p className="text-xs text-red-700">
                    Review protected records and calculate reclaimable storage before proceeding.
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowDeleteModal(false)}
                className="text-gray-400 hover:text-gray-600 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Modal Body */}
            <div className="p-4 space-y-4 overflow-y-auto flex-1 text-xs">
              {/* Deletion Metrics Summary */}
              <div className="grid grid-cols-3 gap-2.5 bg-slate-50 border border-slate-200 rounded-xl p-3">
                <div>
                  <span className="text-[10px] text-slate-500 uppercase font-bold block">Selected</span>
                  <span className="text-base font-black text-slate-900">{activePlan.totalSelected}</span>
                </div>
                <div>
                  <span className="text-[10px] text-emerald-600 uppercase font-bold block">Eligible to Remove</span>
                  <span className="text-base font-black text-emerald-700">{activePlan.eligible.length}</span>
                </div>
                <div>
                  <span className="text-[10px] text-amber-600 uppercase font-bold block">Reclaimable Storage</span>
                  <span className="text-base font-black text-amber-700 font-mono">
                    {formatBytes(activePlan.reclaimableBytes)}
                  </span>
                </div>
              </div>

              {/* Protected Records Notice */}
              {activePlan.protected.length > 0 && (
                <div className="border border-amber-200 bg-amber-50/70 rounded-xl p-3 space-y-2">
                  <div className="flex items-center gap-1.5 text-amber-900 font-bold">
                    <ShieldCheck className="w-4 h-4 text-amber-600 shrink-0" />
                    <span>Protected Documents ({activePlan.protected.length}) — Will NOT be deleted</span>
                  </div>
                  <div className="max-h-28 overflow-y-auto space-y-1 font-mono text-[11px] pr-1">
                    {activePlan.protected.map((item, idx) => (
                      <div key={idx} className="flex items-center justify-between text-slate-700 bg-white/80 p-1.5 rounded border border-amber-100">
                        <span className="truncate max-w-[280px]" title={item.doc.display_file_name || item.doc.storage_path}>
                          {item.doc.display_file_name || item.doc.original_file_name}
                        </span>
                        <span className="text-[10px] text-amber-800 font-sans font-medium">{item.reason}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Progress Display */}
              {deletionRunning && deletionProgress && (
                <div className="border border-blue-200 bg-blue-50/70 rounded-xl p-3 space-y-2 animate-pulse">
                  <div className="flex items-center justify-between text-blue-900 font-bold">
                    <span>Executing Safe Deletion...</span>
                    <span>
                      {deletionProgress.completed} / {deletionProgress.total}
                    </span>
                  </div>
                  <div className="w-full bg-blue-200 rounded-full h-1.5 overflow-hidden">
                    <div
                      className="bg-blue-600 h-1.5 transition-all duration-150"
                      style={{ width: `${(deletionProgress.completed / deletionProgress.total) * 100}%` }}
                    />
                  </div>
                  <div className="text-[11px] text-blue-700 font-mono truncate">{deletionProgress.currentItem}</div>
                </div>
              )}

              {/* Deletion Execution Result */}
              {deletionResult && (
                <div
                  className={`border rounded-xl p-3 space-y-2 ${
                    deletionResult.success ? 'bg-emerald-50 border-emerald-200 text-emerald-900' : 'bg-red-50 border-red-200 text-red-900'
                  }`}
                >
                  <div className="flex items-center gap-1.5 font-bold">
                    {deletionResult.success ? <CheckCircle className="w-4 h-4 text-emerald-600" /> : <AlertTriangle className="w-4 h-4 text-red-600" />}
                    <span>{deletionResult.dryRun ? 'Dry Run Simulation Complete' : 'Deletion Execution Complete'}</span>
                  </div>
                  <p className="text-[11px]">
                    {deletionResult.dryRun ? 'Simulated removal of ' : 'Successfully deleted '}
                    <strong>{deletionResult.deletedRecordIds.length}</strong> records and{' '}
                    <strong>{deletionResult.deletedStoragePaths.length}</strong> physical files.{' '}
                    Reclaimed <strong>{formatBytes(deletionResult.reclaimedBytes)}</strong>.
                  </p>
                  {deletionResult.failedItems.length > 0 && (
                    <div className="text-red-700 font-mono text-[10.5px] max-h-24 overflow-y-auto">
                      <ul>
                        {deletionResult.failedItems.map(f => (
                          <li key={f.id}>
                            {f.filename}: {f.error}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Modal Actions */}
            <div className="p-3 bg-slate-50 border-t border-slate-200 flex flex-wrap items-center justify-between gap-2">
              <span className="text-[11px] text-slate-500">
                Supabase Storage API removes physical objects before metadata records are deleted.
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={deletionRunning}
                  onClick={() => setShowDeleteModal(false)}
                  className="px-3 py-1.5 bg-white border border-slate-300 text-slate-700 rounded-lg text-xs hover:bg-slate-50 cursor-pointer"
                >
                  {deletionResult && !deletionResult.dryRun ? 'Close' : 'Cancel'}
                </button>
                <button
                  type="button"
                  disabled={deletionRunning || activePlan.eligible.length === 0}
                  onClick={() => handleRunDeletion(true)}
                  className="flex items-center gap-1 px-3 py-1.5 bg-slate-200 hover:bg-slate-300 text-slate-800 text-xs font-semibold rounded-lg cursor-pointer transition"
                >
                  <Play className="w-3.5 h-3.5" />
                  <span>Simulate Dry Run</span>
                </button>
                <button
                  type="button"
                  disabled={deletionRunning || activePlan.eligible.length === 0}
                  onClick={() => handleRunDeletion(false)}
                  className="flex items-center gap-1 px-4 py-1.5 bg-red-600 hover:bg-red-700 text-white text-xs font-bold rounded-lg cursor-pointer transition shadow-2xs disabled:opacity-50"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>Permanently Delete ({activePlan.eligible.length})</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 7. Storage Audit Modal */}
      {showStorageAuditModal && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-3xl w-full max-h-[90vh] flex flex-col shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150">
            <div className="p-4 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="p-2 bg-indigo-100 rounded-lg text-indigo-700">
                  <HardDrive className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-slate-900">Storage Audit & Unlinked Objects Explorer</h3>
                  <p className="text-xs text-slate-500">Forensic inspection of crm-documents bucket usage</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowStorageAuditModal(false)}
                className="text-slate-400 hover:text-slate-600 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-4 space-y-4 overflow-y-auto flex-1 text-xs">
              <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-xl space-y-1">
                <div className="flex items-center gap-1.5 text-emerald-900 font-bold">
                  <ShieldCheck className="w-4 h-4 text-emerald-600 shrink-0" />
                  <span>Our Catalog Purge Complete</span>
                </div>
                <p className="text-[11px] text-emerald-800 leading-relaxed">
                  All 15 historical "Our Catalog" duplicate PDFs (136.48 MB) have been permanently purged from the storage bucket.
                  Current bucket footprint is down to <strong>64.11 MB</strong> (reduced by 68%).
                </p>
              </div>

              <div>
                <p className="font-bold text-slate-900 mb-1.5 flex items-center justify-between">
                  <span>Detected Unlinked Storage Objects ({unlinkedObjects.length}):</span>
                  {unlinkedLoading && <RefreshCw className="w-3.5 h-3.5 animate-spin text-blue-600" />}
                </p>
                <div className="border border-slate-200 rounded-xl overflow-hidden max-h-64 overflow-y-auto">
                  <table className="min-w-full text-xs">
                    <thead className="bg-slate-50 border-b border-slate-200 text-slate-500 font-semibold text-[10px] uppercase">
                      <tr>
                        <th className="px-2.5 py-1 text-left">Object Path</th>
                        <th className="px-2.5 py-1 text-left">Folder</th>
                        <th className="px-2.5 py-1 text-left">Reference Source</th>
                        <th className="px-2.5 py-1 text-right">Size</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 font-mono text-[11px]">
                      {unlinkedObjects.map(obj => (
                        <tr key={obj.id} className="hover:bg-slate-50">
                          <td className="px-2.5 py-1 text-slate-900 truncate max-w-[280px]" title={obj.name}>
                            {obj.name}
                          </td>
                          <td className="px-2.5 py-1 font-sans">
                            <span className="text-[10px] font-semibold text-slate-700 bg-slate-100 px-1 py-0.5 rounded">
                              {obj.folder}
                            </span>
                          </td>
                          <td className="px-2.5 py-1 font-sans">
                            <span
                              className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${
                                obj.detected_reference === 'bulk_email_campaigns'
                                  ? 'bg-purple-50 text-purple-700 border border-purple-200'
                                  : obj.detected_reference === 'import_requirements'
                                  ? 'bg-blue-50 text-blue-700 border border-blue-200'
                                  : 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                              }`}
                            >
                              {obj.detected_reference}
                            </span>
                          </td>
                          <td className="px-2.5 py-1 text-right text-slate-700 font-semibold">{formatBytes(obj.size_bytes)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>

            <div className="p-3 bg-slate-50 border-t border-slate-200 flex justify-end">
              <button
                type="button"
                onClick={() => setShowStorageAuditModal(false)}
                className="px-4 py-1.5 bg-slate-800 text-white rounded-lg text-xs font-semibold hover:bg-slate-900 cursor-pointer"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
