import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { Download, ExternalLink, FileText, Search, Trash2, Upload, X, ShieldCheck, Clock, CheckCircle } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { showToast } from '../ToastNotification';
import { getSignedUrlCached, invalidateSignedUrl } from '../../utils/signedUrlCache';

export type CrmProductDocument = {
  id: string;
  inquiry_id: string | null;
  product_name: string | null;
  make: string | null;
  document_type: string;
  specification: string | null;
  is_permanent: boolean;
  pricing_option_id: string | null;
  original_file_name: string | null;
  display_file_name: string | null;
  storage_path: string;
  uploaded_by: string | null;
  source_gmail_message_id: string | null;
  created_at: string;
  crm_inquiries?: { inquiry_number: string }[] | null;
};

type InquiryOption = { id: string; inquiry_number: string; product_name: string };

const DOC_TYPES = ['COA', 'MSDS', 'MHD', 'TDS', 'SPEC', 'COC', 'GMP', 'ISO', 'DMF', 'OTHER'] as const;
const COMMON_SPECS = ['USP', 'BP', 'EP', 'IP', 'JP', 'Ph.Eur.', 'Technical', 'Food Grade'] as const;

const DOC_TYPE_COLOR: Record<string, string> = {
  COA: 'bg-green-100 text-green-800 border-green-200',
  MSDS: 'bg-red-100 text-red-800 border-red-200',
  TDS: 'bg-blue-100 text-blue-800 border-blue-200',
  SPEC: 'bg-amber-100 text-amber-800 border-amber-200',
  MHD: 'bg-teal-100 text-teal-800 border-teal-200',
  GMP: 'bg-purple-100 text-purple-800 border-purple-200',
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

  // Upload state
  const [showUpload, setShowUpload] = useState(false);
  const [inquiryOptions, setInquiryOptions] = useState<InquiryOption[]>([]);
  const [selectedInquiryId, setSelectedInquiryId] = useState('');
  const [uploadDocType, setUploadDocType] = useState<typeof DOC_TYPES[number]>('COA');
  const [uploadMake, setUploadMake] = useState('');
  const [uploadSpec, setUploadSpec] = useState('USP');
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);

  useEffect(() => { loadDocuments(); }, []);

  const loadDocuments = async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('crm_product_documents')
      .select('id,inquiry_id,product_name,make,document_type,specification,is_permanent,pricing_option_id,original_file_name,display_file_name,storage_path,source_gmail_message_id,uploaded_by,created_at,crm_inquiries(inquiry_number)')
      .order('created_at', { ascending: false })
      .limit(500);
    if (error) console.error(error);
    setDocuments((data || []) as unknown as CrmProductDocument[]);
    setLoading(false);
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

  const filteredDocuments = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const product = productFilter.trim().toLowerCase();
    const supplier = supplierFilter.trim().toLowerCase();

    return documents.filter(doc => {
      const pName = (doc.product_name || '').toLowerCase();
      const mName = (doc.make || '').toLowerCase();
      const sName = (doc.specification || '').toLowerCase();
      const fName = (doc.original_file_name || doc.display_file_name || '').toLowerCase();
      const inqNum = ((doc.crm_inquiries as any)?.[0]?.inquiry_number || '').toLowerCase();

      const matchesSearch = !q || (
        pName.includes(q) ||
        mName.includes(q) ||
        sName.includes(q) ||
        fName.includes(q) ||
        inqNum.includes(q) ||
        doc.document_type.toLowerCase().includes(q)
      );

      const productOk = !product || pName.includes(product);
      const supplierOk = !supplier || mName.includes(supplier);
      const specOk = specificationFilter === 'all' || doc.specification === specificationFilter;
      const typeOk = documentTypeFilter === 'all' || doc.document_type === documentTypeFilter;
      const lifecycleOk = lifecycleFilter === 'all' || (lifecycleFilter === 'permanent' ? doc.is_permanent : !doc.is_permanent);

      return matchesSearch && productOk && supplierOk && specOk && typeOk && lifecycleOk;
    });
  }, [documents, searchQuery, productFilter, supplierFilter, specificationFilter, documentTypeFilter, lifecycleFilter]);

  // Dynamic Summary Metrics
  const summaryMetrics = useMemo(() => {
    const total = filteredDocuments.length;
    const byMake: Record<string, number> = {};
    const byType: Record<string, number> = {};
    const bySpec: Record<string, number> = {};

    filteredDocuments.forEach(doc => {
      const mk = doc.make || 'Unassigned';
      byMake[mk] = (byMake[mk] || 0) + 1;

      const dt = doc.document_type || 'OTHER';
      byType[dt] = (byType[dt] || 0) + 1;

      if (doc.specification) {
        bySpec[doc.specification] = (bySpec[doc.specification] || 0) + 1;
      }
    });

    return { total, byMake, byType, bySpec };
  }, [filteredDocuments]);

  const openDocument = async (doc: CrmProductDocument, download = false) => {
    const downloadName = download ? (doc.display_file_name || doc.original_file_name || undefined) : undefined;
    const url = await getSignedUrlCached('crm-documents', doc.storage_path, 600, {
      download: downloadName,
    });
    if (!url) { alert('Unable to open document.'); return; }
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  const handlePromoteToPermanent = async (doc: CrmProductDocument) => {
    try {
      const { error } = await supabase
        .from('crm_product_documents')
        .update({ is_permanent: true })
        .eq('id', doc.id);

      if (error) throw error;
      setDocuments(prev => prev.map(d => d.id === doc.id ? { ...d, is_permanent: true } : d));
      showToast({ type: 'success', title: 'Document Retained', message: 'Document is now permanent in CRM Document Bank.' });
    } catch (err: any) {
      showToast({ type: 'error', title: 'Action Failed', message: err.message || 'Could not update document status' });
    }
  };

  const deleteDocument = async (doc: CrmProductDocument) => {
    if (!canUpload) return;
    const isPermanent = doc.is_permanent;
    const confirmMsg = isPermanent
      ? 'Delete this PERMANENT document from CRM Document Bank? This will delete the physical file and cannot be undone.'
      : 'Delete this temporary AI document? The physical file and document record will be removed.';
    if (!confirm(confirmMsg)) return;

    invalidateSignedUrl('crm-documents', doc.storage_path);
    await supabase.storage.from('crm-documents').remove([doc.storage_path]);
    await supabase.from('crm_product_documents').delete().eq('id', doc.id);
    setDocuments(prev => prev.filter(d => d.id !== doc.id));
    showToast({ type: 'success', title: 'Deleted', message: 'Document and storage object removed.' });
  };

  const submitUpload = async () => {
    if (!uploadFile) { showToast({ type: 'error', title: 'No file', message: 'Select a file first.' }); return; }
    const selectedInq = inquiryOptions.find(i => i.id === selectedInquiryId);
    setUploading(true);
    const { data: { user } } = await supabase.auth.getUser();
    const ext = uploadFile.name.split('.').pop() || 'bin';
    const cleanName = uploadFile.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const path = `${selectedInquiryId || 'manual'}/${uploadDocType}_${Date.now()}_${cleanName}`;
    const { error: upErr } = await supabase.storage.from('crm-documents').upload(path, uploadFile);
    if (upErr) { showToast({ type: 'error', title: 'Upload failed', message: upErr.message }); setUploading(false); return; }

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
      uploaded_by: user?.id || null,
    });
    showToast({ type: 'success', title: 'Uploaded', message: `${uploadDocType} saved as permanent document in CRM Bank.` });
    setUploadFile(null); setUploadMake(''); setSelectedInquiryId(''); setShowUpload(false);
    setUploading(false);
    loadDocuments();
  };

  return (
    <div className="space-y-4">
      {/* Header + upload trigger */}
      <div className="bg-white border border-gray-200 rounded-xl p-4 shadow-2xs">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <div>
            <h3 className="text-base font-bold text-gray-900 flex items-center gap-2">
              <FileText className="w-5 h-5 text-blue-600" />
              <span>CRM Document Bank</span>
            </h3>
            <p className="text-xs text-gray-500 mt-0.5">
              Canonical repository for all customer inquiries, supplier technical documents, and verified COAs.
            </p>
          </div>
          {canUpload && (
            <button
              onClick={openUploadPanel}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-blue-600 text-white rounded-lg hover:bg-blue-700 shadow-2xs cursor-pointer transition-colors"
            >
              <Upload className="w-3.5 h-3.5" />
              <span>+ Upload Document</span>
            </button>
          )}
        </div>

        {/* Dynamic Summary Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2 mb-4 bg-slate-50 border border-slate-200 rounded-lg p-3">
          <div>
            <div className="text-[10px] uppercase font-bold text-gray-500">Total Documents</div>
            <div className="text-lg font-black text-gray-900">{summaryMetrics.total}</div>
          </div>
          <div>
            <div className="text-[10px] uppercase font-bold text-gray-500">Sources / Makes</div>
            <div className="text-xs font-semibold text-gray-700 truncate" title={Object.entries(summaryMetrics.byMake).map(([k, v]) => `${k} (${v})`).join(', ')}>
              {Object.entries(summaryMetrics.byMake).slice(0, 3).map(([k, v]) => `${k}: ${v}`).join(' · ') || 'None'}
            </div>
          </div>
          <div>
            <div className="text-[10px] uppercase font-bold text-gray-500">Document Types</div>
            <div className="text-xs font-semibold text-gray-700 truncate">
              {Object.entries(summaryMetrics.byType).slice(0, 3).map(([k, v]) => `${k}: ${v}`).join(' · ') || 'None'}
            </div>
          </div>
          <div>
            <div className="text-[10px] uppercase font-bold text-gray-500">Specifications</div>
            <div className="text-xs font-semibold text-gray-700 truncate">
              {Object.entries(summaryMetrics.bySpec).slice(0, 3).map(([k, v]) => `${k}: ${v}`).join(' · ') || 'Unspecified'}
            </div>
          </div>
        </div>

        {/* Upload form */}
        {showUpload && (
          <div className="mb-4 p-4 border border-blue-200 bg-blue-50/70 rounded-lg space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-xs font-bold text-blue-900">Upload New Permanent Document</p>
              <button onClick={() => setShowUpload(false)} className="text-gray-400 hover:text-gray-600 cursor-pointer">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-2.5">
              <div>
                <label className="block text-[10px] font-semibold text-gray-600 mb-0.5">Linked Inquiry (optional)</label>
                <select
                  value={selectedInquiryId}
                  onChange={e => setSelectedInquiryId(e.target.value)}
                  className="w-full border border-gray-300 rounded px-2 py-1 text-xs bg-white"
                >
                  <option value="">No specific inquiry</option>
                  {inquiryOptions.map(i => (
                    <option key={i.id} value={i.id}>{i.inquiry_number} — {i.product_name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-[10px] font-semibold text-gray-600 mb-0.5">Document Type</label>
                <select
                  value={uploadDocType}
                  onChange={e => setUploadDocType(e.target.value as typeof DOC_TYPES[number])}
                  className="w-full border border-gray-300 rounded px-2 py-1 text-xs bg-white font-medium"
                >
                  {DOC_TYPES.map(t => <option key={t}>{t}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-[10px] font-semibold text-gray-600 mb-0.5">Make / Supplier</label>
                <input
                  value={uploadMake}
                  onChange={e => setUploadMake(e.target.value)}
                  placeholder="e.g. JRC, IPCA, Curequest"
                  className="w-full border border-gray-300 rounded px-2 py-1 text-xs bg-white"
                />
              </div>
              <div>
                <label className="block text-[10px] font-semibold text-gray-600 mb-0.5">Specification / Standard</label>
                <input
                  value={uploadSpec}
                  onChange={e => setUploadSpec(e.target.value)}
                  placeholder="e.g. USP, BP, EP, IP"
                  className="w-full border border-gray-300 rounded px-2 py-1 text-xs bg-white"
                />
              </div>
            </div>
            <div>
              <label className="block text-[10px] font-semibold text-gray-600 mb-0.5">Select File (PDF / Images / Docs)</label>
              <input
                type="file"
                accept=".pdf,.doc,.docx,.xls,.xlsx,.png,.jpg,.jpeg"
                onChange={e => setUploadFile(e.target.files?.[0] || null)}
                className="w-full text-xs file:mr-2 file:py-1 file:px-2.5 file:rounded file:border-0 file:text-xs file:font-semibold file:bg-blue-100 file:text-blue-700 cursor-pointer"
              />
            </div>
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
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-5 gap-2">
          <div className="relative md:col-span-2">
            <Search className="w-3.5 h-3.5 text-gray-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
            <input
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder="Search product, make, file, inquiry, or spec..."
              className="w-full border border-gray-300 rounded-md pl-8 pr-2.5 py-1.5 text-xs bg-white"
            />
          </div>
          <select
            value={documentTypeFilter}
            onChange={e => setDocumentTypeFilter(e.target.value)}
            className="w-full border border-gray-300 rounded-md px-2 py-1.5 text-xs bg-white font-medium"
          >
            <option value="all">All Document Types</option>
            {DOC_TYPES.map(type => <option key={type} value={type}>{type}</option>)}
          </select>
          <select
            value={specificationFilter}
            onChange={e => setSpecificationFilter(e.target.value)}
            className="w-full border border-gray-300 rounded-md px-2 py-1.5 text-xs bg-white"
          >
            <option value="all">All Specifications</option>
            {COMMON_SPECS.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          <select
            value={lifecycleFilter}
            onChange={e => setLifecycleFilter(e.target.value as any)}
            className="w-full border border-gray-300 rounded-md px-2 py-1.5 text-xs bg-white"
          >
            <option value="all">All Lifecycle States</option>
            <option value="permanent">Permanent / Banked</option>
            <option value="temporary">AI Temporary</option>
          </select>
        </div>
      </div>

      {/* Documents Table */}
      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden shadow-2xs">
        <div className="overflow-x-auto">
          <table className="min-w-full text-xs">
            <thead className="bg-gray-50 border-b border-gray-200 text-gray-600 font-semibold uppercase text-[10px] tracking-wider">
              <tr>
                <th className="px-3 py-2 text-left">Product</th>
                <th className="px-3 py-2 text-left">Make / Source</th>
                <th className="px-3 py-2 text-left">Spec</th>
                <th className="px-3 py-2 text-left">Doc Type</th>
                <th className="px-3 py-2 text-left">File Name</th>
                <th className="px-3 py-2 text-left">Inquiry</th>
                <th className="px-3 py-2 text-left">Lifecycle</th>
                <th className="px-3 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading ? (
                <tr><td colSpan={8} className="px-4 py-8 text-center text-gray-500">Loading documents from bank…</td></tr>
              ) : filteredDocuments.length === 0 ? (
                <tr><td colSpan={8} className="px-4 py-8 text-center text-gray-500">No documents match the active search filters.</td></tr>
              ) : filteredDocuments.map(doc => (
                <tr key={doc.id} className="hover:bg-gray-50 transition-colors">
                  <td className="px-3 py-2 font-medium text-gray-900">{doc.product_name || 'Unassigned Item'}</td>
                  <td className="px-3 py-2 text-gray-700 font-medium">{doc.make || '-'}</td>
                  <td className="px-3 py-2">
                    {doc.specification ? (
                      <span className="font-semibold text-emerald-700 bg-emerald-50 px-1.5 py-0.5 rounded border border-emerald-200 text-[10px]">
                        {doc.specification}
                      </span>
                    ) : (
                      <span className="text-gray-400">-</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold border ${DOC_TYPE_COLOR[doc.document_type] || 'bg-gray-100 text-gray-600 border-gray-200'}`}>
                      {doc.document_type}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-gray-700 max-w-[220px] truncate" title={doc.original_file_name || doc.display_file_name || ''}>
                    {doc.display_file_name || doc.original_file_name || doc.storage_path.split('/').pop()}
                  </td>
                  <td className="px-3 py-2 text-gray-700 whitespace-nowrap">
                    {(doc.crm_inquiries as any)?.[0]?.inquiry_number || '-'}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    {doc.is_permanent ? (
                      <span className="inline-flex items-center gap-1 text-[10px] text-green-700 font-semibold bg-green-50 border border-green-200 px-1.5 py-0.5 rounded">
                        <CheckCircle className="w-3 h-3" />
                        Banked
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-[10px] text-amber-700 font-medium bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded">
                        <Clock className="w-3 h-3" />
                        AI Temp
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">
                    <div className="flex items-center justify-end gap-1.5">
                      {!doc.is_permanent && canUpload && (
                        <button
                          onClick={() => handlePromoteToPermanent(doc)}
                          className="px-2 py-0.5 text-[10px] font-semibold text-blue-700 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded cursor-pointer transition-colors"
                          title="Promote to permanent document in bank"
                        >
                          <ShieldCheck className="w-3 h-3 inline mr-0.5" />
                          Retain
                        </button>
                      )}
                      <button
                        onClick={() => openDocument(doc, false)}
                        className="p-1 text-gray-600 hover:text-blue-600 hover:bg-gray-100 rounded cursor-pointer"
                        title="View Document"
                      >
                        <ExternalLink className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => openDocument(doc, true)}
                        className="p-1 text-gray-600 hover:text-blue-600 hover:bg-gray-100 rounded cursor-pointer"
                        title="Download Document"
                      >
                        <Download className="w-3.5 h-3.5" />
                      </button>
                      {canUpload && (
                        <button
                          onClick={() => deleteDocument(doc)}
                          className="p-1 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded cursor-pointer"
                          title="Delete Document"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
