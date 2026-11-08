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
} from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
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
  type CrmProductDocumentRecord,
  type DocumentBankStats,
  type UnlinkedStorageObject,
  type DeletionPlan,
  type DeletionExecutionResult,
} from '../../services/crm/documentBankService';

export type CrmProductDocument = CrmProductDocumentRecord;

type InquiryOption = { id: string; inquiry_number: string; product_name: string };

const DOC_TYPES = ['COA', 'MSDS', 'HALAL', 'GMP', 'SPEC', 'DMF', 'TDS', 'MHD', 'COC', 'ISO', 'PURCHASE_ORDER', 'PRODUCT_CATALOGUE', 'PRICE_LIST', 'OTHER'] as const;
const COMMON_SPECS = ['USP', 'BP', 'EP', 'IP', 'JP', 'Ph.Eur.', 'Technical', 'Food Grade'] as const;

const DOC_TYPE_COLOR: Record<string, string> = {
  COA: 'bg-emerald-50 text-emerald-800 border-emerald-200',
  MSDS: 'bg-rose-50 text-rose-800 border-rose-200',
  HALAL: 'bg-teal-50 text-teal-800 border-teal-200',
  GMP: 'bg-purple-50 text-purple-800 border-purple-200',
  DMF: 'bg-indigo-50 text-indigo-800 border-indigo-200',
  SPEC: 'bg-amber-50 text-amber-800 border-amber-200',
  TDS: 'bg-blue-50 text-blue-800 border-blue-200',
  MHD: 'bg-cyan-50 text-cyan-800 border-cyan-200',
  COC: 'bg-slate-50 text-slate-800 border-slate-200',
  ISO: 'bg-lime-50 text-lime-800 border-lime-200',
  PURCHASE_ORDER: 'bg-orange-50 text-orange-800 border-orange-200',
  PRODUCT_CATALOGUE: 'bg-violet-50 text-violet-800 border-violet-200',
  CATALOGUE: 'bg-violet-50 text-violet-800 border-violet-200',
  PRICE_LIST: 'bg-sky-50 text-sky-800 border-sky-200',
  OTHER: 'bg-gray-100 text-gray-700 border-gray-200',
};

export function ProductDocumentsPanel() {
  const { profile } = useAuth();
  const canUpload = profile?.role === 'admin' || profile?.role === 'manager';

  const [documents, setDocuments] = useState<CrmProductDocument[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [productFilter, setProductFilter] = useState('');
  const [supplierFilter, setSupplierFilter] = useState('');
  const [specificationFilter, setSpecificationFilter] = useState('all');
  const [documentTypeFilter, setDocumentTypeFilter] = useState('all');
  const [lifecycleFilter, setLifecycleFilter] = useState<'all' | 'permanent' | 'temporary'>('all');
  const [cleanupCandidatesOnly, setCleanupCandidatesOnly] = useState(false);

  // Pagination state
  const [pageIndex, setPageIndex] = useState(1);
  const [pageSize, setPageSize] = useState<number | 'all'>(50);

  // Multi-select state
  const [selectedDocIds, setSelectedDocIds] = useState<Set<string>>(new Set());

  // Instant in-page preview state
  const [previewDoc, setPreviewDoc] = useState<CrmProductDocument | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [imageZoom, setImageZoom] = useState(1);

  // Storage Stats & Audit state
  const [bankStats, setBankStats] = useState<DocumentBankStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);
  const [showStorageAuditModal, setShowStorageAuditModal] = useState(false);
  const [unlinkedObjects, setUnlinkedObjects] = useState<UnlinkedStorageObject[]>([]);
  const [unlinkedLoading, setUnlinkedLoading] = useState(false);

  // Bulk Deletion Modal state
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [activePlan, setActivePlan] = useState<DeletionPlan | null>(null);
  const [deletionProgress, setDeletionProgress] = useState<{ completed: number; total: number; currentItem: string } | null>(null);
  const [deletionResult, setDeletionResult] = useState<DeletionExecutionResult | null>(null);
  const [deletionRunning, setDeletionRunning] = useState(false);

  // Upload form state
  const [showUpload, setShowUpload] = useState(false);
  const [inquiryOptions, setInquiryOptions] = useState<InquiryOption[]>([]);
  const [selectedInquiryId, setSelectedInquiryId] = useState('');
  const [uploadDocType, setUploadDocType] = useState<typeof DOC_TYPES[number]>('COA');
  const [uploadMake, setUploadMake] = useState('');
  const [uploadSpec, setUploadSpec] = useState('USP');
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    loadDocuments();
    loadStats();
  }, []);

  const loadStats = async () => {
    setStatsLoading(true);
    const stats = await fetchDocumentBankStats();
    if (stats) setBankStats(stats);
    setStatsLoading(false);
  };

  const loadDocuments = async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('crm_product_documents')
        .select('id,inquiry_id,product_name,make,document_type,specification,is_permanent,pricing_option_id,original_file_name,display_file_name,storage_bucket,storage_path,source_gmail_message_id,source_email_subject,file_size,mime_type,uploaded_by,created_at,enquiry_request_id,crm_inquiries(inquiry_number)')
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
      if (cleanupCandidatesOnly) {
        const isCandidate =
          doc.document_type === 'OTHER' &&
          !doc.is_permanent &&
          !doc.inquiry_id &&
          !doc.pricing_option_id &&
          !doc.enquiry_request_id;
        if (!isCandidate) return false;
      }

      const pName = (doc.product_name || '').toLowerCase();
      const mName = (doc.make || '').toLowerCase();
      const sName = (doc.specification || '').toLowerCase();
      const fName = (doc.original_file_name || doc.display_file_name || '').toLowerCase();
      const inqNum = ((doc.crm_inquiries as any)?.[0]?.inquiry_number || '').toLowerCase();
      const subject = (doc.source_email_subject || '').toLowerCase();

      const matchesSearch =
        !q ||
        pName.includes(q) ||
        mName.includes(q) ||
        sName.includes(q) ||
        fName.includes(q) ||
        inqNum.includes(q) ||
        subject.includes(q) ||
        doc.document_type.toLowerCase().includes(q);

      const productOk = !product || pName.includes(product);
      const supplierOk = !supplier || mName.includes(supplier);
      const specOk = specificationFilter === 'all' || doc.specification === specificationFilter;
      const typeOk = documentTypeFilter === 'all' || doc.document_type === documentTypeFilter;
      const lifecycleOk =
        lifecycleFilter === 'all' ||
        (lifecycleFilter === 'permanent' ? doc.is_permanent : !doc.is_permanent);

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

  const isAllFilteredSelected = useMemo(() => {
    if (filteredDocuments.length === 0) return false;
    return filteredDocuments.every(d => selectedDocIds.has(d.id));
  }, [filteredDocuments, selectedDocIds]);

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

  // Instant In-Page Preview Handlers
  const handleOpenPreview = async (doc: CrmProductDocument) => {
    setImageZoom(1);
    setPreviewDoc(doc);
    setPreviewLoading(true);
    try {
      const bucket = doc.storage_bucket || 'crm-documents';
      if (!doc.storage_path) {
        showToast({
          type: 'error',
          title: 'Document Unavailable',
          message: 'No storage path recorded for this document.',
        });
        setPreviewUrl(null);
        return;
      }
      const url = await getSignedUrlCached(bucket, doc.storage_path, 3600);
      setPreviewUrl(url || null);
      if (!url) {
        showToast({
          type: 'error',
          title: 'Document Unavailable',
          message: `The file "${doc.display_file_name || doc.original_file_name}" could not be loaded from private storage.`,
        });
      }
    } catch (e: any) {
      console.error('Failed to get signed URL for preview:', e);
      setPreviewUrl(null);
      showToast({
        type: 'error',
        title: 'Preview Failed',
        message: e?.message || 'Could not load document preview.',
      });
    } finally {
      setPreviewLoading(false);
    }
  };

  const handleClosePreview = () => {
    setPreviewDoc(null);
    setPreviewUrl(null);
    setImageZoom(1);
  };

  const currentPreviewIndex = useMemo(() => {
    if (!previewDoc) return -1;
    return filteredDocuments.findIndex(d => d.id === previewDoc.id);
  }, [previewDoc, filteredDocuments]);

  const handlePrevPreview = () => {
    if (currentPreviewIndex > 0) {
      handleOpenPreview(filteredDocuments[currentPreviewIndex - 1]);
    }
  };

  const handleNextPreview = () => {
    if (currentPreviewIndex >= 0 && currentPreviewIndex < filteredDocuments.length - 1) {
      handleOpenPreview(filteredDocuments[currentPreviewIndex + 1]);
    }
  };

  // Keyboard shortcut listener for modal: ESC to close, Left/Right for pagination
  useEffect(() => {
    if (!previewDoc) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
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

  // Promote to permanent
  const handlePromoteToPermanent = async (doc: CrmProductDocument) => {
    try {
      const { error } = await supabase
        .from('crm_product_documents')
        .update({ is_permanent: true })
        .eq('id', doc.id);

      if (error) throw error;
      setDocuments(prev => prev.map(d => (d.id === doc.id ? { ...d, is_permanent: true } : d)));
      showToast({ type: 'success', title: 'Document Retained', message: 'Document is now permanent in CRM Document Bank.' });
      loadStats();
    } catch (err: any) {
      showToast({ type: 'error', title: 'Action Failed', message: err.message || 'Could not update document status' });
    }
  };

  // Bulk promote to permanent
  const handleBulkPromote = async () => {
    if (selectedDocs.length === 0) return;
    try {
      const ids = Array.from(selectedDocIds);
      const { error } = await supabase
        .from('crm_product_documents')
        .update({ is_permanent: true })
        .in('id', ids);

      if (error) throw error;
      setDocuments(prev => prev.map(d => (selectedDocIds.has(d.id) ? { ...d, is_permanent: true } : d)));
      showToast({
        type: 'success',
        title: 'Documents Retained',
        message: `${ids.length} selected documents marked as permanent in CRM Document Bank.`,
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
      // Remove deleted records from local state
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

  // Upload Submission
  const submitUpload = async () => {
    if (!uploadFile) {
      showToast({ type: 'error', title: 'No file', message: 'Select a file first.' });
      return;
    }
    const selectedInq = inquiryOptions.find(i => i.id === selectedInquiryId);
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

    const displayFileName = `${selectedInq?.product_name || 'Doc'}_${uploadDocType}.${ext}`;
    await supabase.from('crm_product_documents').insert({
      inquiry_id: selectedInquiryId || null,
      product_name: selectedInq?.product_name || null,
      make: uploadMake || null,
      document_type: uploadDocType,
      specification: uploadSpec || null,
      is_permanent: true,
      original_file_name: uploadFile.name,
      display_file_name: displayFileName,
      storage_bucket: 'crm-documents',
      storage_path: path,
      file_size: optimization.optimizedSize,
      mime_type: optimization.mimeType || uploadFile.type || 'application/octet-stream',
      uploaded_by: user?.id || null,
    });
    showToast({ type: 'success', title: 'Uploaded', message: `${uploadDocType} saved as permanent document in CRM Bank.` });
    setUploadFile(null);
    setUploadMake('');
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
              <span>CRM Document Bank</span>
            </h3>
            <p className="text-xs text-gray-500 mt-0.5">
              Canonical repository for customer inquiries, supplier technical documents, and verified pharmaceutical COAs.
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
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-blue-600 text-white rounded-lg hover:bg-blue-700 shadow-2xs cursor-pointer transition"
              >
                <Upload className="w-3.5 h-3.5" />
                <span>+ Upload Document</span>
              </button>
            )}
          </div>
        </div>

        {/* Dynamic Storage & Document Metrics */}
        <div className="grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-5 gap-2.5 mb-4 bg-slate-50 border border-slate-200 rounded-lg p-3">
          <div>
            <div className="text-[10px] uppercase font-bold text-gray-500">Document Bank</div>
            <div className="text-base font-black text-gray-900">
              {bankStats ? `${bankStats.total_documents} docs` : `${documents.length} docs`}
            </div>
            <div className="text-[11px] text-gray-500 font-mono">
              {bankStats ? formatBytes(bankStats.total_document_bytes) : '—'}
            </div>
          </div>
          <div>
            <div className="text-[10px] uppercase font-bold text-gray-500">Storage Bucket</div>
            <div className="text-base font-black text-gray-900">
              {bankStats ? `${bankStats.bucket_total_objects} objects` : '—'}
            </div>
            <div className="text-[11px] text-gray-500 font-mono">
              {bankStats ? formatBytes(bankStats.bucket_total_bytes) : '—'}
            </div>
          </div>
          <div>
            <div className="text-[10px] uppercase font-bold text-gray-500">Unlinked Objects</div>
            <div className="text-base font-black text-indigo-700">
              {bankStats ? `${bankStats.unlinked_objects_count} objects` : '—'}
            </div>
            <div className="text-[11px] text-gray-500 font-mono">
              {bankStats ? formatBytes(bankStats.unlinked_objects_bytes) : '—'} (Campaign/Reqs)
            </div>
          </div>
          <div>
            <div className="text-[10px] uppercase font-bold text-gray-500">Cleanup Candidates</div>
            <div className="text-base font-black text-amber-700">
              {bankStats ? `${bankStats.junk_other_count} temporary` : '—'}
            </div>
            <div className="text-[11px] text-amber-600 font-mono">
              {bankStats ? formatBytes(bankStats.junk_other_bytes) : '—'} reclaimable
            </div>
          </div>
          <div className="col-span-2 sm:col-span-2 lg:col-span-1 border-t sm:border-t-0 pt-2 sm:pt-0">
            <div className="text-[10px] uppercase font-bold text-gray-500">Selected Storage</div>
            <div className="text-base font-black text-blue-700 font-mono">{formatBytes(selectedBytes)}</div>
            <div className="text-[11px] text-blue-600 font-medium">
              {selectedDocIds.size > 0 ? `${selectedDocIds.size} records chosen` : '0 records chosen'}
            </div>
          </div>
        </div>

        {/* Upload Form */}
        {showUpload && (
          <div className="mb-4 p-4 border border-blue-200 bg-blue-50/70 rounded-lg space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-xs font-bold text-blue-900">Upload New Permanent Document</p>
              <button onClick={() => setShowUpload(false)} className="text-gray-400 hover:text-gray-600 cursor-pointer">
                <X className="w-4 h-4" />
              </button>
            </div>
            <SapRow>
              <FloatingField label="Linked Inquiry (optional)" filled={!!selectedInquiryId} span={3}>
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
              <FloatingField label="Document Type" filled={!!uploadDocType} span={3}>
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
              <FloatingField label="Make / Supplier" filled={!!uploadMake} span={3}>
                <input
                  value={uploadMake}
                  onChange={e => setUploadMake(e.target.value)}
                  placeholder="e.g. JRC, IPCA, Curequest"
                  className={FLOAT_INPUT}
                />
              </FloatingField>
              <FloatingField label="Specification / Standard" filled={!!uploadSpec} span={3}>
                <input
                  value={uploadSpec}
                  onChange={e => setUploadSpec(e.target.value)}
                  placeholder="e.g. USP, BP, EP, IP"
                  className={FLOAT_INPUT}
                />
              </FloatingField>
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
                className="flex items-center gap-1 px-4 py-1 text-xs font-semibold bg-green-600 text-white rounded hover:bg-green-700 disabled:opacity-50 cursor-pointer shadow-2xs"
              >
                <Upload className="w-3.5 h-3.5" />
                <span>{uploading ? 'Uploading…' : 'Save & Bank Document'}</span>
              </button>
            </div>
          </div>
        )}

        {/* Global Multi-Field Filters */}
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-6 gap-2">
          <div className="relative md:col-span-2">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
            <input
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder="Search product, make, file, email, inquiry, or spec..."
              className="w-full border border-slate-200 rounded-lg pl-8 pr-2.5 py-1.5 text-xs bg-slate-50 focus:bg-white focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>
          <select
            value={documentTypeFilter}
            onChange={e => setDocumentTypeFilter(e.target.value)}
            className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-xs bg-slate-50 font-medium text-slate-700"
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
            className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-xs bg-slate-50 text-slate-700"
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
            className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-xs bg-slate-50 text-slate-700"
          >
            <option value="all">All Lifecycle States</option>
            <option value="permanent">Permanent / Banked</option>
            <option value="temporary">AI Temporary</option>
          </select>
          <button
            type="button"
            onClick={() => setCleanupCandidatesOnly(!cleanupCandidatesOnly)}
            className={`w-full px-2 py-1.5 text-xs font-semibold rounded-lg border transition cursor-pointer flex items-center justify-center gap-1 ${
              cleanupCandidatesOnly
                ? 'bg-amber-600 text-white border-amber-600 shadow-2xs'
                : 'bg-amber-50 text-amber-800 border-amber-200 hover:bg-amber-100'
            }`}
            title="Filter to the 171 unlinked non-permanent OTHER records ready for safe cleanup"
          >
            <Filter className="w-3.5 h-3.5" />
            <span>Cleanup Pool ({bankStats ? bankStats.junk_other_count : '171'})</span>
          </button>
        </div>

        {/* Certificate Type Pills */}
        <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5 pt-1.5 text-xs">
          {(['all', 'COA', 'MSDS', 'HALAL', 'GMP', 'SPEC', 'DMF', 'TDS', 'CATALOGUE', 'PRICE_LIST', 'OTHER'] as const).map(pill => (
            <button
              key={pill}
              type="button"
              onClick={() => {
                setDocumentTypeFilter(pill);
                setCleanupCandidatesOnly(false);
              }}
              className={`px-2.5 py-1 rounded-md text-[11px] font-semibold transition shrink-0 cursor-pointer ${
                documentTypeFilter === pill && !cleanupCandidatesOnly
                  ? 'bg-blue-600 text-white shadow-2xs'
                  : 'bg-white text-slate-600 border border-slate-200 hover:bg-slate-100/70'
              }`}
            >
              {pill === 'all' ? 'All Types' : pill}
            </button>
          ))}
        </div>
      </div>

      {/* 2. Selection & Bulk Action Bar (Visible when rows selected) */}
      {selectedDocIds.size > 0 && (
        <div className="bg-blue-50 border border-blue-200 rounded-xl p-3 shadow-2xs flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-xs font-bold text-blue-900 flex items-center gap-1.5">
              <CheckSquare className="w-4 h-4 text-blue-600" />
              <span>
                {selectedDocIds.size} record{selectedDocIds.size > 1 ? 's' : ''} selected
              </span>
              <span className="font-mono text-blue-700 bg-blue-100 px-2 py-0.5 rounded text-[11px]">
                {formatBytes(selectedBytes)}
              </span>
            </span>

            {/* Pagination Scope Indicator */}
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
                  title="Mark all selected documents as permanent in Document Bank"
                >
                  <ShieldCheck className="w-3.5 h-3.5 text-emerald-600" />
                  <span>Retain Selected</span>
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

      {/* 3. Main Workspace: Full Width Documents Table */}
      <div className="w-full">
        {/* Documents Table Container */}
        <div className="w-full">
          <div className="bg-white border border-slate-200/90 rounded-xl overflow-hidden shadow-2xs">
            {/* Table pagination & scope toolbar */}
            <div className="px-3 py-2 bg-slate-50 border-b border-slate-200 flex flex-wrap items-center justify-between text-xs text-slate-600 gap-2">
              <div className="flex items-center gap-2">
                <span className="font-semibold text-slate-800">
                  {filteredDocuments.length} document{filteredDocuments.length !== 1 ? 's' : ''}
                </span>
                {cleanupCandidatesOnly && (
                  <span className="text-[10px] bg-amber-100 text-amber-800 px-1.5 py-0.5 rounded font-semibold border border-amber-200">
                    Cleanup Pool
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
                    <th className="px-2 py-1 text-left">Inquiry</th>
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
                            {doc.product_name || 'Unassigned'}
                          </td>
                          <td className="px-2 py-1 text-slate-700 max-w-[100px] truncate" title={doc.make || '-'}>
                            {doc.make || '-'}
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
                            className="px-2 py-1 text-slate-700 max-w-[200px] truncate font-mono text-[11px]"
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
                            {(doc.crm_inquiries as any)?.[0]?.inquiry_number || '-'}
                          </td>
                          <td className="px-2 py-1 whitespace-nowrap">
                            {doc.is_permanent ? (
                              <span className="inline-flex items-center gap-1 text-[9.5px] text-emerald-700 font-semibold bg-emerald-50 border border-emerald-200 px-1.5 py-0.5 rounded">
                                <CheckCircle className="w-2.5 h-2.5" />
                                Banked
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
                              {/* Instant In-Page Preview Trigger */}
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

                              {!doc.is_permanent && canUpload && (
                                <button
                                  type="button"
                                  onClick={() => handlePromoteToPermanent(doc)}
                                  className="px-1.5 py-0.5 text-[9.5px] font-semibold text-blue-700 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded cursor-pointer transition"
                                  title="Promote to permanent document"
                                >
                                  <ShieldCheck className="w-3 h-3 inline mr-0.5" />
                                  Retain
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
      </div>

      {/* 4. Large Centred In-App Document Preview Modal / Lightbox */}
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
            <div className="px-4 py-3 bg-slate-900 text-white flex items-center justify-between gap-3 shrink-0 border-b border-slate-800">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 mb-1 flex-wrap">
                  <span className={`px-2 py-0.5 rounded text-[10px] font-bold border ${DOC_TYPE_COLOR[previewDoc.document_type]}`}>
                    {previewDoc.document_type}
                  </span>
                  <span className="font-mono text-xs text-slate-300 font-semibold">
                    {formatBytes(previewDoc.file_size)}
                  </span>
                  <span className="text-[11px] text-slate-400">
                    ({currentPreviewIndex + 1} of {filteredDocuments.length})
                  </span>
                  {previewDoc.product_name && (
                    <span className="text-[11px] text-slate-300 border-l border-slate-700 pl-2">
                      Product: <strong className="text-white">{previewDoc.product_name}</strong>
                    </span>
                  )}
                  {previewDoc.make && (
                    <span className="text-[11px] text-slate-300 border-l border-slate-700 pl-2 hidden md:inline">
                      Make: <strong className="text-white">{previewDoc.make}</strong>
                    </span>
                  )}
                </div>
                <h4
                  className="text-sm font-bold text-white truncate font-mono"
                  title={previewDoc.display_file_name || previewDoc.original_file_name || ''}
                >
                  {previewDoc.display_file_name || previewDoc.original_file_name || previewDoc.storage_path.split('/').pop()}
                </h4>
              </div>

              {/* Controls: Zoom, Prev/Next, Download, Close */}
              <div className="flex items-center gap-1.5 shrink-0">
                {/* Image Zoom Controls */}
                {isImage && previewUrl && (
                  <div className="hidden sm:flex items-center gap-1 mr-2 bg-slate-800 rounded-lg p-0.5 border border-slate-700">
                    <button
                      type="button"
                      onClick={() => setImageZoom(z => Math.max(0.5, +(z - 0.25).toFixed(2)))}
                      className="p-1 rounded text-slate-300 hover:text-white hover:bg-slate-700 cursor-pointer transition"
                      title="Zoom Out"
                    >
                      <ZoomOut className="w-4 h-4" />
                    </button>
                    <span className="text-[11px] font-mono px-1.5 text-slate-300 select-none min-w-[42px] text-center">
                      {Math.round(imageZoom * 100)}%
                    </span>
                    <button
                      type="button"
                      onClick={() => setImageZoom(z => Math.min(3, +(z + 0.25).toFixed(2)))}
                      className="p-1 rounded text-slate-300 hover:text-white hover:bg-slate-700 cursor-pointer transition"
                      title="Zoom In"
                    >
                      <ZoomIn className="w-4 h-4" />
                    </button>
                    {imageZoom !== 1 && (
                      <button
                        type="button"
                        onClick={() => setImageZoom(1)}
                        className="p-1 rounded text-slate-300 hover:text-white hover:bg-slate-700 cursor-pointer transition"
                        title="Reset Zoom"
                      >
                        <RotateCcw className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                )}

                {/* Prev / Next Navigation */}
                <button
                  type="button"
                  disabled={currentPreviewIndex <= 0}
                  onClick={handlePrevPreview}
                  className="p-1.5 rounded-lg border border-slate-700 bg-slate-800 hover:bg-slate-700 disabled:opacity-30 cursor-pointer text-slate-200"
                  title="Previous Document (Left Arrow)"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  disabled={currentPreviewIndex >= filteredDocuments.length - 1}
                  onClick={handleNextPreview}
                  className="p-1.5 rounded-lg border border-slate-700 bg-slate-800 hover:bg-slate-700 disabled:opacity-30 cursor-pointer text-slate-200"
                  title="Next Document (Right Arrow)"
                >
                  <ChevronRight className="w-4 h-4" />
                </button>

                {/* Download Button */}
                {previewUrl && (
                  <a
                    href={previewUrl}
                    download={previewDoc.display_file_name || previewDoc.original_file_name || 'document'}
                    className="p-1.5 rounded-lg border border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-200 cursor-pointer"
                    title="Download File"
                  >
                    <Download className="w-4 h-4" />
                  </a>
                )}

                {/* Close Button */}
                <button
                  type="button"
                  onClick={handleClosePreview}
                  className="p-1.5 rounded-lg border border-slate-700 bg-slate-800 hover:bg-red-900/60 text-slate-300 hover:text-red-200 cursor-pointer ml-1 transition"
                  title="Close Modal (ESC)"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            {/* Email / Origin Context subtitle bar */}
            {previewDoc.source_email_subject && (
              <div className="px-4 py-1.5 bg-blue-950/40 border-b border-blue-900/30 text-xs text-blue-200 flex items-center gap-2 shrink-0">
                <Mail className="w-3.5 h-3.5 text-blue-400 shrink-0" />
                <span className="truncate">Email Subject: <em>{previewDoc.source_email_subject}</em></span>
              </div>
            )}

            {/* Modal Body / Viewer */}
            <div className="flex-1 bg-slate-100 overflow-hidden relative flex flex-col">
              {previewLoading ? (
                <div className="w-full h-full flex flex-col items-center justify-center text-slate-500 gap-2">
                  <RefreshCw className="w-8 h-8 animate-spin text-blue-600" />
                  <p className="text-sm font-medium">Generating secure temporary preview...</p>
                </div>
              ) : !previewUrl ? (
                <div className="w-full h-full flex flex-col items-center justify-center text-slate-500 p-6 text-center">
                  <AlertTriangle className="w-10 h-10 text-amber-500 mb-2" />
                  <p className="text-sm font-semibold text-slate-800">Preview URL could not be generated</p>
                  <p className="text-xs text-slate-400 mt-1">The physical file may be missing from the private storage bucket.</p>
                </div>
              ) : isPdf ? (
                <div className="w-full h-full flex-1 bg-slate-200/50">
                  <iframe
                    src={`${previewUrl}#view=FitH`}
                    title={previewDoc.display_file_name || 'Document PDF Preview'}
                    className="w-full h-full border-0 bg-white"
                  />
                </div>
              ) : isImage ? (
                <div className="w-full h-full flex-1 flex items-center justify-center p-4 overflow-auto bg-slate-900/10">
                  <img
                    src={previewUrl}
                    alt={previewDoc.display_file_name || 'Document Image'}
                    style={{
                      transform: `scale(${imageZoom})`,
                      transformOrigin: 'center center',
                      transition: 'transform 0.15s ease-out',
                    }}
                    className="max-w-full max-h-full object-contain rounded shadow-lg select-none"
                  />
                </div>
              ) : isOffice ? (
                <div className="w-full h-full flex flex-col items-center justify-center p-8 text-center bg-white">
                  <div className="p-4 bg-emerald-50 rounded-2xl border border-emerald-100 mb-4">
                    <FileSpreadsheet className="w-16 h-16 text-emerald-600" />
                  </div>
                  <h5 className="text-base font-bold text-slate-900">Microsoft Office / Spreadsheet File</h5>
                  <p className="text-xs text-slate-600 mt-1 max-w-md font-mono bg-slate-50 px-3 py-1.5 rounded-lg border border-slate-200">
                    {previewDoc.display_file_name || previewDoc.original_file_name}
                  </p>
                  <p className="text-xs text-slate-400 mt-3 max-w-sm">
                    In-browser interactive spreadsheet rendering is not supported for Office formats. Download the document below to view it in Excel or LibreOffice.
                  </p>
                  <a
                    href={previewUrl}
                    download={previewDoc.display_file_name || previewDoc.original_file_name || 'document'}
                    className="mt-6 flex items-center gap-2 px-5 py-2.5 bg-emerald-600 text-white font-semibold text-xs rounded-xl hover:bg-emerald-700 shadow-sm transition"
                  >
                    <Download className="w-4 h-4" />
                    <span>Download File ({formatBytes(previewDoc.file_size)})</span>
                  </a>
                </div>
              ) : (
                <div className="w-full h-full flex flex-col items-center justify-center p-8 text-center bg-white">
                  <div className="p-4 bg-blue-50 rounded-2xl border border-blue-100 mb-4">
                    <FileText className="w-16 h-16 text-blue-600" />
                  </div>
                  <h5 className="text-base font-bold text-slate-900">Binary Document File</h5>
                  <p className="text-xs text-slate-600 mt-1 max-w-md font-mono bg-slate-50 px-3 py-1.5 rounded-lg border border-slate-200">
                    {previewDoc.display_file_name || previewDoc.original_file_name}
                  </p>
                  <p className="text-xs text-slate-400 mt-3 max-w-sm">
                    This file format cannot be rendered in the browser preview. Download the file to open it locally.
                  </p>
                  <a
                    href={previewUrl}
                    download={previewDoc.display_file_name || previewDoc.original_file_name || 'document'}
                    className="mt-6 flex items-center gap-2 px-5 py-2.5 bg-blue-600 text-white font-semibold text-xs rounded-xl hover:bg-blue-700 shadow-sm transition"
                  >
                    <Download className="w-4 h-4" />
                    <span>Download File ({formatBytes(previewDoc.file_size)})</span>
                  </a>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 6. Safe Bulk Deletion Modal */}
      {showDeleteModal && activePlan && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-2xl w-full max-h-[90vh] flex flex-col shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150">
            {/* Modal Header */}
            <div className="p-4 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="p-2 bg-red-100 rounded-lg text-red-600">
                  <Trash2 className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-slate-900">Safe Document Deletion Workflow</h3>
                  <p className="text-xs text-slate-500">Coordinated physical file removal and metadata cleanup</p>
                </div>
              </div>
              <button
                type="button"
                disabled={deletionRunning}
                onClick={() => setShowDeleteModal(false)}
                className="text-slate-400 hover:text-slate-600 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Modal Body */}
            <div className="p-4 space-y-4 overflow-y-auto flex-1 text-xs">
              {/* Summary Stats */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 bg-slate-50 border border-slate-200 rounded-xl p-3">
                <div>
                  <span className="text-[10px] uppercase font-bold text-slate-500">Selected</span>
                  <p className="text-base font-black text-slate-900">{activePlan.totalSelected}</p>
                </div>
                <div>
                  <span className="text-[10px] uppercase font-bold text-emerald-600">Protected (Kept)</span>
                  <p className="text-base font-black text-emerald-700">{activePlan.protected.length}</p>
                </div>
                <div>
                  <span className="text-[10px] uppercase font-bold text-red-600">Eligible to Delete</span>
                  <p className="text-base font-black text-red-700">{activePlan.eligible.length}</p>
                </div>
                <div>
                  <span className="text-[10px] uppercase font-bold text-blue-600">Reclaimable Storage</span>
                  <p className="text-base font-black text-blue-700 font-mono">{formatBytes(activePlan.reclaimableBytes)}</p>
                </div>
              </div>

              {/* Protected Items Notice */}
              {activePlan.protected.length > 0 && (
                <div className="p-3 bg-amber-50 border border-amber-200 rounded-xl space-y-2">
                  <div className="flex items-center gap-1.5 text-amber-800 font-bold">
                    <ShieldCheck className="w-4 h-4 text-amber-600 shrink-0" />
                    <span>{activePlan.protected.length} Protected Documents Excluded from Deletion</span>
                  </div>
                  <p className="text-[11px] text-amber-700">
                    These records are marked as Permanent or are actively referenced by CRM inquiries and pricing options. They will NOT be deleted.
                  </p>
                  <div className="max-h-24 overflow-y-auto space-y-1 text-[11px] font-mono bg-white/60 p-2 rounded border border-amber-200">
                    {activePlan.protected.map(p => (
                      <div key={p.doc.id} className="flex justify-between text-slate-700 gap-2">
                        <span className="truncate">{p.doc.display_file_name || p.doc.original_file_name}</span>
                        <span className="text-amber-800 shrink-0 font-sans font-semibold">[{p.reason}]</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Eligible Files to Delete */}
              <div>
                <p className="font-bold text-slate-900 mb-1.5">
                  Files to be Permanently Removed ({activePlan.eligible.length} records · {activePlan.filesToDeleteCount} storage files):
                </p>
                <div className="border border-slate-200 rounded-xl overflow-hidden max-h-48 overflow-y-auto">
                  <table className="min-w-full text-xs">
                    <thead className="bg-slate-50 border-b border-slate-200 text-slate-500 font-semibold text-[10px] uppercase">
                      <tr>
                        <th className="px-2.5 py-1 text-left">File Name</th>
                        <th className="px-2.5 py-1 text-left">Type</th>
                        <th className="px-2.5 py-1 text-right">Size</th>
                        <th className="px-2.5 py-1 text-left">Storage Path</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 font-mono text-[11px]">
                      {activePlan.eligible.map(item => (
                        <tr key={item.doc.id} className="hover:bg-slate-50">
                          <td className="px-2.5 py-1 text-slate-900 truncate max-w-[180px]">
                            {item.doc.display_file_name || item.doc.original_file_name}
                          </td>
                          <td className="px-2.5 py-1 font-sans">
                            <span className="text-[10px] font-bold text-slate-600 bg-slate-100 px-1 py-0.5 rounded">
                              {item.doc.document_type}
                            </span>
                          </td>
                          <td className="px-2.5 py-1 text-right text-slate-600">{formatBytes(item.doc.file_size)}</td>
                          <td className="px-2.5 py-1 text-slate-400 text-[10px] truncate max-w-[200px]" title={item.doc.storage_path}>
                            {item.doc.storage_path}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Progress Indicator */}
              {deletionProgress && (
                <div className="p-3 bg-blue-50 border border-blue-200 rounded-xl space-y-1.5">
                  <div className="flex justify-between font-semibold text-blue-900 text-xs">
                    <span>
                      Progress: {deletionProgress.completed} of {deletionProgress.total}
                    </span>
                    <span className="font-mono">
                      {Math.round((deletionProgress.completed / deletionProgress.total) * 100)}%
                    </span>
                  </div>
                  <div className="w-full bg-blue-200 h-2 rounded-full overflow-hidden">
                    <div
                      className="bg-blue-600 h-full transition-all duration-150"
                      style={{ width: `${(deletionProgress.completed / deletionProgress.total) * 100}%` }}
                    />
                  </div>
                  <p className="text-[11px] text-blue-700 truncate font-mono">Current: {deletionProgress.currentItem}</p>
                </div>
              )}

              {/* Result Summary */}
              {deletionResult && (
                <div
                  className={`p-3 rounded-xl border space-y-1 ${
                    deletionResult.success
                      ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                      : 'bg-red-50 border-red-200 text-red-800'
                  }`}
                >
                  <p className="font-bold">
                    {deletionResult.dryRun ? 'Simulation (Dry Run) Complete:' : 'Permanent Deletion Complete:'}
                  </p>
                  <p className="text-xs">
                    {deletionResult.dryRun
                      ? `Successfully verified ${deletionResult.deletedRecordIds.length} records. Would remove ${deletionResult.deletedStoragePaths.length} physical storage files and reclaim ${formatBytes(deletionResult.reclaimedBytes)}.`
                      : `Successfully removed ${deletionResult.deletedRecordIds.length} records and ${deletionResult.deletedStoragePaths.length} storage files. Reclaimed ${formatBytes(deletionResult.reclaimedBytes)}.`}
                  </p>
                  {deletionResult.failedItems.length > 0 && (
                    <div className="mt-2 text-[11px] text-red-700">
                      <p className="font-bold">Failures ({deletionResult.failedItems.length}):</p>
                      <ul className="list-disc pl-4 space-y-0.5">
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
                Supabase Storage API will remove physical objects before metadata records are deleted.
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

      {/* 7. Storage Audit & Orphan Explorer Modal */}
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
              {/* Important Reference Safety Banner */}
              <div className="p-3 bg-amber-50 border border-amber-200 rounded-xl space-y-1.5">
                <div className="flex items-center gap-1.5 text-amber-900 font-bold">
                  <Info className="w-4 h-4 text-amber-600 shrink-0" />
                  <span>Crucial Reference Policy for Unlinked Bucket Objects</span>
                </div>
                <p className="text-[11px] text-amber-800 leading-relaxed">
                  There are <strong>44 objects (151.05 MiB)</strong> stored in the <code>crm-documents</code> bucket that are not mapped to rows in <code>crm_product_documents</code>.
                  Our database reference harvest proves these objects belong to <strong>Bulk Email Marketing Campaigns</strong> (39 catalogs/stocklists) and <strong>Import Requirements</strong> (3 brochures/COAs).
                  They are actively referenced in ERP workflows and <strong>MUST NOT</strong> be deleted during Document Bank cleanup.
                </p>
              </div>

              {/* Unlinked Objects Table */}
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
