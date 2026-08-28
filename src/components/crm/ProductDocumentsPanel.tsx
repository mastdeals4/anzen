import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { Download, ExternalLink, FileText, Search, Trash2, Upload, X } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { showToast } from '../ToastNotification';
import { getSignedUrlCached, invalidateSignedUrl } from '../../utils/signedUrlCache';

type CrmProductDocument = {
  id: string;
  inquiry_id: string | null;
  product_name: string | null;
  make: string | null;
  document_type: string;
  original_file_name: string | null;
  display_file_name: string | null;
  storage_path: string;
  uploaded_by: string | null;
  created_at: string;
  crm_inquiries?: { inquiry_number: string }[] | null;
};

type InquiryOption = { id: string; inquiry_number: string; product_name: string };

const DOC_TYPES = ['COA', 'MSDS', 'MHD', 'TDS', 'SPEC', 'COC', 'GMP', 'ISO', 'DMF', 'OTHER'] as const;
const DOC_TYPE_COLOR: Record<string, string> = {
  COA: 'bg-green-100 text-green-700',
  MSDS: 'bg-red-100 text-red-700',
  TDS: 'bg-blue-100 text-blue-700',
  SPEC: 'bg-amber-100 text-amber-700',
  MHD: 'bg-teal-100 text-teal-700',
};

export function ProductDocumentsPanel() {
  const { profile } = useAuth();
  const canUpload = profile?.role === 'admin' || profile?.role === 'manager';

  const [documents, setDocuments] = useState<CrmProductDocument[]>([]);
  const [loading, setLoading] = useState(false);
  const [productFilter, setProductFilter] = useState('');
  const [supplierFilter, setSupplierFilter] = useState('');
  const [documentTypeFilter, setDocumentTypeFilter] = useState('all');

  // Upload state
  const [showUpload, setShowUpload] = useState(false);
  const [inquiryOptions, setInquiryOptions] = useState<InquiryOption[]>([]);
  const [selectedInquiryId, setSelectedInquiryId] = useState('');
  const [uploadDocType, setUploadDocType] = useState<typeof DOC_TYPES[number]>('COA');
  const [uploadMake, setUploadMake] = useState('');
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);

  useEffect(() => { loadDocuments(); }, []);

  const loadDocuments = async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('crm_product_documents')
      .select('id,inquiry_id,product_name,make,document_type,original_file_name,display_file_name,storage_path,uploaded_by,created_at,crm_inquiries(inquiry_number)')
      .order('created_at', { ascending: false })
      .limit(300);
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
    const product = productFilter.trim().toLowerCase();
    const supplier = supplierFilter.trim().toLowerCase();
    return documents.filter(doc => {
      const productOk = !product || (doc.product_name || '').toLowerCase().includes(product);
      const supplierOk = !supplier || (doc.make || '').toLowerCase().includes(supplier);
      const typeOk = documentTypeFilter === 'all' || doc.document_type === documentTypeFilter;
      return productOk && supplierOk && typeOk;
    });
  }, [documents, productFilter, supplierFilter, documentTypeFilter]);

  const openDocument = async (doc: CrmProductDocument, download = false) => {
    const downloadName = download ? (doc.display_file_name || undefined) : undefined;
    const url = await getSignedUrlCached('crm-documents', doc.storage_path, 600, {
      download: downloadName,
    });
    if (!url) { alert('Unable to open document.'); return; }
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  const deleteDocument = async (doc: CrmProductDocument) => {
    if (!canUpload) return;
    if (!confirm('Delete this document?')) return;
    invalidateSignedUrl('crm-documents', doc.storage_path);
    await supabase.storage.from('crm-documents').remove([doc.storage_path]);
    await supabase.from('crm_product_documents').delete().eq('id', doc.id);
    setDocuments(prev => prev.filter(d => d.id !== doc.id));
    showToast({ type: 'success', title: 'Deleted', message: 'Document removed.' });
  };

  const submitUpload = async () => {
    if (!uploadFile) { showToast({ type: 'error', title: 'No file', message: 'Select a file first.' }); return; }
    const selectedInq = inquiryOptions.find(i => i.id === selectedInquiryId);
    setUploading(true);
    const { data: { user } } = await supabase.auth.getUser();
    const ext = uploadFile.name.split('.').pop() || 'bin';
    const path = `${selectedInquiryId || 'manual'}/${uploadDocType}_${Date.now()}.${ext}`;
    const { error: upErr } = await supabase.storage.from('crm-documents').upload(path, uploadFile);
    if (upErr) { showToast({ type: 'error', title: 'Upload failed', message: upErr.message }); setUploading(false); return; }
    await supabase.from('crm_product_documents').insert({
      inquiry_id: selectedInquiryId || null,
      product_name: selectedInq?.product_name || null,
      make: uploadMake || null,
      document_type: uploadDocType,
      original_file_name: uploadFile.name,
      display_file_name: `${selectedInq?.product_name || 'doc'}_${uploadDocType}.${ext}`,
      storage_bucket: 'crm-documents',
      storage_path: path,
      uploaded_by: user?.id || null,
    });
    showToast({ type: 'success', title: 'Uploaded', message: `${uploadDocType} saved to CRM documents.` });
    setUploadFile(null); setUploadMake(''); setSelectedInquiryId(''); setShowUpload(false);
    setUploading(false);
    loadDocuments();
  };

  return (
    <div className="space-y-4">
      {/* Header + upload trigger */}
      <div className="bg-white border border-gray-200 rounded-xl p-4">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-gray-900">CRM Product Documents</h3>
          {canUpload && (
            <button onClick={openUploadPanel}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700">
              <Upload className="w-4 h-4" /> Upload Document
            </button>
          )}
        </div>

        {/* Upload form */}
        {showUpload && (
          <div className="mb-4 p-4 border border-blue-200 bg-blue-50 rounded-lg space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium text-blue-900">Upload new document</p>
              <button onClick={() => setShowUpload(false)}><X className="w-4 h-4 text-gray-500" /></button>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-gray-600 mb-1">Linked Inquiry (optional)</label>
                <select value={selectedInquiryId} onChange={e => setSelectedInquiryId(e.target.value)}
                  className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm">
                  <option value="">No specific inquiry</option>
                  {inquiryOptions.map(i => (
                    <option key={i.id} value={i.id}>{i.inquiry_number} — {i.product_name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs text-gray-600 mb-1">Document Type</label>
                <select value={uploadDocType} onChange={e => setUploadDocType(e.target.value as typeof DOC_TYPES[number])}
                  className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm">
                  {DOC_TYPES.map(t => <option key={t}>{t}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs text-gray-600 mb-1">Make / Supplier (optional)</label>
                <input value={uploadMake} onChange={e => setUploadMake(e.target.value)}
                  placeholder="e.g. Curequest, BASF"
                  className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm" />
              </div>
              <div>
                <label className="block text-xs text-gray-600 mb-1">File</label>
                <input type="file" accept=".pdf,.doc,.docx,.xls,.xlsx,.png,.jpg,.jpeg"
                  onChange={e => setUploadFile(e.target.files?.[0] || null)}
                  className="w-full text-sm" />
              </div>
            </div>
            {uploadFile && (
              <div className="flex items-center gap-2 text-sm text-gray-700">
                <FileText className="w-4 h-4 text-blue-500" />
                <span>{uploadFile.name}</span>
                <span className="text-gray-400">({(uploadFile.size / 1024).toFixed(1)} KB)</span>
              </div>
            )}
            <button onClick={submitUpload} disabled={!uploadFile || uploading}
              className="flex items-center gap-1.5 px-4 py-2 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50">
              <Upload className="w-4 h-4" /> {uploading ? 'Uploading…' : 'Upload to CRM'}
            </button>
          </div>
        )}

        {/* Filters */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="relative">
            <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input value={productFilter} onChange={e => setProductFilter(e.target.value)}
              placeholder="Filter by product"
              className="w-full border border-gray-300 rounded-lg pl-9 pr-3 py-2 text-sm" />
          </div>
          <div className="relative">
            <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input value={supplierFilter} onChange={e => setSupplierFilter(e.target.value)}
              placeholder="Filter by supplier / make"
              className="w-full border border-gray-300 rounded-lg pl-9 pr-3 py-2 text-sm" />
          </div>
          <select value={documentTypeFilter} onChange={e => setDocumentTypeFilter(e.target.value)}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm">
            <option value="all">All document types</option>
            {DOC_TYPES.map(type => <option key={type} value={type}>{type}</option>)}
          </select>
        </div>
      </div>

      {/* Table */}
      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="px-4 py-3 text-left font-semibold text-gray-700">Product</th>
                <th className="px-4 py-3 text-left font-semibold text-gray-700">Supplier / Make</th>
                <th className="px-4 py-3 text-left font-semibold text-gray-700">Doc Type</th>
                <th className="px-4 py-3 text-left font-semibold text-gray-700">File</th>
                <th className="px-4 py-3 text-left font-semibold text-gray-700">Inquiry</th>
                <th className="px-4 py-3 text-left font-semibold text-gray-700">Uploaded</th>
                <th className="px-4 py-3 text-right font-semibold text-gray-700">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={7} className="px-4 py-8 text-center text-gray-500">Loading documents…</td></tr>
              ) : filteredDocuments.length === 0 ? (
                <tr><td colSpan={7} className="px-4 py-8 text-center text-gray-500">No documents match current filters.</td></tr>
              ) : filteredDocuments.map(doc => (
                <tr key={doc.id} className="border-b border-gray-100 hover:bg-gray-50">
                  <td className="px-4 py-3 text-gray-900">{doc.product_name || '-'}</td>
                  <td className="px-4 py-3 text-gray-700">{doc.make || '-'}</td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-0.5 rounded text-xs font-medium ${DOC_TYPE_COLOR[doc.document_type] || 'bg-gray-100 text-gray-600'}`}>
                      {doc.document_type}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-700 max-w-[200px] truncate" title={doc.original_file_name || ''}>
                    {doc.display_file_name || doc.original_file_name || doc.storage_path.split('/').pop()}
                  </td>
                  <td className="px-4 py-3 text-gray-700">
                    {(doc.crm_inquiries as unknown as { inquiry_number: string }[])?.[0]?.inquiry_number || '-'}
                  </td>
                  <td className="px-4 py-3 text-gray-500 whitespace-nowrap">{new Date(doc.created_at).toLocaleDateString('en-GB')}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-2">
                      <button onClick={() => openDocument(doc, false)}
                        className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs rounded-md border border-gray-300 hover:bg-gray-100">
                        <ExternalLink className="w-3.5 h-3.5" /> Open
                      </button>
                      <button onClick={() => openDocument(doc, true)}
                        className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs rounded-md border border-gray-300 hover:bg-gray-100">
                        <Download className="w-3.5 h-3.5" /> Download
                      </button>
                      {canUpload && (
                        <button onClick={() => deleteDocument(doc)}
                          className="p-1.5 text-red-400 hover:text-red-600 rounded hover:bg-red-50">
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
