import React, { useState, useEffect, useRef } from 'react';
import {
  X,
  Search,
  FileText,
  Image as ImageIcon,
  UploadCloud,
  Check,
  Building,
  Package,
  AlertCircle,
  FolderArchive,
  Loader2,
  Trash2,
} from 'lucide-react';
import { supabase } from '../../../lib/supabase';
import { UniversalDocumentRecord } from '../../../services/documents/universalDocumentBankService';

export interface WhatsAppCampaignAttachment {
  id?: string;
  source: 'bank' | 'upload';
  name: string;
  documentType: string;
  mediaCategory: 'document' | 'image';
  mimeType?: string;
  fileSize?: number;
  formattedSize?: string;
  storageBucket?: string;
  storagePath?: string;
  url?: string;
  previewUrl?: string;
  productName?: string;
  makeName?: string;
  batchNumber?: string;
  specification?: string;
  file?: File;
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  currentAttachment: WhatsAppCampaignAttachment | null;
  onSelectAttachment: (attachment: WhatsAppCampaignAttachment) => void;
}

export function formatAttachmentSize(bytes?: number | null): string {
  if (!bytes || bytes <= 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const AVAILABLE_FILTER_TYPES = [
  'ALL',
  'COA',
  'MSDS',
  'SPEC',
  'TDS',
  'CATALOGUE',
  'PRICE LIST',
  'OTHER',
];

export const WhatsAppAttachmentModal: React.FC<Props> = ({
  isOpen,
  onClose,
  currentAttachment,
  onSelectAttachment,
}) => {
  const [activeTab, setActiveTab] = useState<'bank' | 'upload'>('bank');

  // Tab A: Document Bank State
  const [bankDocs, setBankDocs] = useState<UniversalDocumentRecord[]>([]);
  const [loadingBank, setLoadingBank] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedTypeFilter, setSelectedTypeFilter] = useState('ALL');
  const [selectedBankDocId, setSelectedBankDocId] = useState<string | null>(null);

  // Tab B: Upload State
  const [uploadedFile, setUploadedFile] = useState<File | null>(null);
  const [uploadPreviewUrl, setUploadPreviewUrl] = useState<string | null>(null);
  const [uploadDocType, setUploadDocType] = useState<string>('COA');
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Initialize modal state
  useEffect(() => {
    if (!isOpen) return;

    if (currentAttachment) {
      if (currentAttachment.source === 'bank' && currentAttachment.id) {
        setActiveTab('bank');
        setSelectedBankDocId(currentAttachment.id);
      } else if (currentAttachment.source === 'upload') {
        setActiveTab('upload');
        setUploadDocType(currentAttachment.documentType || 'COA');
      }
    } else {
      setSelectedBankDocId(null);
      setUploadedFile(null);
      setUploadPreviewUrl(null);
      setUploadError(null);
    }

    loadBankDocuments();
  }, [isOpen]);

  const loadBankDocuments = async () => {
    setLoadingBank(true);
    try {
      const { data, error } = await supabase
        .from('vw_universal_document_bank')
        .select('*')
        .eq('lifecycle_status', 'BANKED')
        .order('created_at', { ascending: false })
        .limit(100);

      if (error) throw error;
      setBankDocs(data || []);
    } catch (err: any) {
      console.error('Failed to load Document Bank items for WhatsApp:', err);
    } finally {
      setLoadingBank(false);
    }
  };

  // Filter bank documents
  const filteredBankDocs = bankDocs.filter((doc) => {
    if (selectedTypeFilter !== 'ALL') {
      const docType = (doc.document_type || '').toUpperCase();
      if (selectedTypeFilter === 'OTHER') {
        if (['COA', 'MSDS', 'SPEC', 'TDS', 'CATALOGUE', 'PRICE LIST'].includes(docType)) {
          return false;
        }
      } else if (docType !== selectedTypeFilter) {
        return false;
      }
    }

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      const matchTitle = (doc.title || '').toLowerCase().includes(q);
      const matchFilename = (doc.original_file_name || '').toLowerCase().includes(q);
      const matchProduct = (doc.product_name || '').toLowerCase().includes(q);
      const matchMake = (doc.make_name || '').toLowerCase().includes(q);
      const matchBatch = (doc.batch_number || '').toLowerCase().includes(q);
      return matchTitle || matchFilename || matchProduct || matchMake || matchBatch;
    }

    return true;
  });

  // Handle local file selection
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setUploadError(null);
    const file = e.target.files?.[0];
    if (!file) return;

    // Validate size (16MB for images, 100MB for docs)
    const isImage = file.type.startsWith('image/');
    const isPdf = file.type === 'application/pdf';

    if (!isImage && !isPdf) {
      setUploadError('Unsupported file type. Please upload a PDF or an Image (JPEG, PNG, WebP).');
      return;
    }

    if (isImage && file.size > 16 * 1024 * 1024) {
      setUploadError('Image size exceeds 16MB limit for WhatsApp media.');
      return;
    }

    if (isPdf && file.size > 100 * 1024 * 1024) {
      setUploadError('Document size exceeds 100MB WhatsApp limit.');
      return;
    }

    setUploadedFile(file);
    if (isImage) {
      const preview = URL.createObjectURL(file);
      setUploadPreviewUrl(preview);
      setUploadDocType('PHOTO');
    } else {
      setUploadPreviewUrl(null);
      // Auto-detect doc type from filename
      const nameUpper = file.name.toUpperCase();
      if (nameUpper.includes('COA')) setUploadDocType('COA');
      else if (nameUpper.includes('MSDS')) setUploadDocType('MSDS');
      else if (nameUpper.includes('SPEC')) setUploadDocType('SPEC');
      else if (nameUpper.includes('TDS')) setUploadDocType('TDS');
      else if (nameUpper.includes('CATALOG')) setUploadDocType('CATALOGUE');
      else if (nameUpper.includes('PRICE')) setUploadDocType('PRICE LIST');
      else setUploadDocType('COA');
    }
  };

  // Confirm selection and attach
  const handleConfirm = () => {
    if (activeTab === 'bank') {
      const doc = bankDocs.find((d) => d.id === selectedBankDocId);
      if (!doc) return;

      const isImage = (doc.mime_type || '').startsWith('image/') ||
        ['.jpg', '.jpeg', '.png', '.webp'].some((ext) => (doc.original_file_name || doc.title || '').toLowerCase().endsWith(ext));

      onSelectAttachment({
        id: doc.id,
        source: 'bank',
        name: doc.original_file_name || doc.title,
        documentType: doc.document_type || 'COA',
        mediaCategory: isImage ? 'image' : 'document',
        mimeType: doc.mime_type || (isImage ? 'image/jpeg' : 'application/pdf'),
        fileSize: doc.file_size ? Number(doc.file_size) : undefined,
        formattedSize: formatAttachmentSize(doc.file_size ? Number(doc.file_size) : null),
        storageBucket: doc.storage_bucket || 'crm-documents',
        storagePath: doc.storage_path || undefined,
        productName: doc.product_name || undefined,
        makeName: doc.make_name || undefined,
        batchNumber: doc.batch_number || undefined,
        specification: doc.specification || undefined,
      });
      onClose();
    } else {
      if (!uploadedFile) return;

      const isImage = uploadedFile.type.startsWith('image/');
      onSelectAttachment({
        source: 'upload',
        name: uploadedFile.name,
        documentType: uploadDocType,
        mediaCategory: isImage ? 'image' : 'document',
        mimeType: uploadedFile.type,
        fileSize: uploadedFile.size,
        formattedSize: formatAttachmentSize(uploadedFile.size),
        previewUrl: uploadPreviewUrl || undefined,
        file: uploadedFile,
      });
      onClose();
    }
  };

  if (!isOpen) return null;

  const canConfirm =
    (activeTab === 'bank' && selectedBankDocId !== null) ||
    (activeTab === 'upload' && uploadedFile !== null);

  const selectedBankDoc = bankDocs.find((d) => d.id === selectedBankDocId);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs animate-in fade-in duration-200">
      <div className="bg-white rounded-2xl shadow-2xl border border-gray-200 w-full max-w-3xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between bg-slate-50/70">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-emerald-100 text-emerald-800 flex items-center justify-center">
              <FolderArchive className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-gray-900">Attach Photo / Document</h2>
              <p className="text-xs text-gray-500">
                Choose exactly ONE document or photograph to accompany this WhatsApp message.
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-100 transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Tab Navigation */}
        <div className="flex border-b border-gray-200 bg-gray-50/50 px-6 pt-2">
          <button
            type="button"
            onClick={() => setActiveTab('bank')}
            className={`flex items-center gap-2 pb-3 px-4 text-xs font-bold transition border-b-2 ${
              activeTab === 'bank'
                ? 'border-emerald-600 text-emerald-700 bg-white rounded-t-lg'
                : 'border-transparent text-gray-500 hover:text-gray-800'
            }`}
          >
            <FolderArchive className="w-4 h-4" />
            A. Select from Document Bank
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('upload')}
            className={`flex items-center gap-2 pb-3 px-4 text-xs font-bold transition border-b-2 ${
              activeTab === 'upload'
                ? 'border-emerald-600 text-emerald-700 bg-white rounded-t-lg'
                : 'border-transparent text-gray-500 hover:text-gray-800'
            }`}
          >
            <UploadCloud className="w-4 h-4" />
            B. Upload New File
          </button>
        </div>

        {/* Modal Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          {activeTab === 'bank' && (
            <div className="space-y-3">
              {/* Search & Filter Controls */}
              <div className="space-y-2">
                <div className="relative">
                  <Search className="w-4 h-4 text-gray-400 absolute left-3 top-2.5" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search by file name, product name, make, specification, or batch..."
                    className="w-full pl-9 pr-4 py-2 border border-gray-300 rounded-lg text-xs focus:ring-2 focus:ring-emerald-500 focus:outline-hidden"
                  />
                  {searchQuery && (
                    <button
                      onClick={() => setSearchQuery('')}
                      className="absolute right-3 top-2.5 text-xs text-gray-400 hover:text-gray-600"
                    >
                      Clear
                    </button>
                  )}
                </div>

                {/* Filter Pills */}
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-[10px] uppercase font-bold text-gray-400 mr-1">Filter:</span>
                  {AVAILABLE_FILTER_TYPES.map((type) => (
                    <button
                      key={type}
                      type="button"
                      onClick={() => setSelectedTypeFilter(type)}
                      className={`px-2.5 py-1 text-[11px] font-semibold rounded-full transition ${
                        selectedTypeFilter === type
                          ? 'bg-emerald-600 text-white shadow-2xs'
                          : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                      }`}
                    >
                      {type}
                    </button>
                  ))}
                </div>
              </div>

              {/* Documents List */}
              {loadingBank ? (
                <div className="py-12 flex flex-col items-center justify-center text-gray-400 space-y-2">
                  <Loader2 className="w-6 h-6 animate-spin text-emerald-600" />
                  <span className="text-xs">Loading Central Document Bank...</span>
                </div>
              ) : filteredBankDocs.length === 0 ? (
                <div className="py-12 text-center text-gray-500 border-2 border-dashed border-gray-200 rounded-xl">
                  <FileText className="w-8 h-8 text-gray-300 mx-auto mb-2" />
                  <div className="text-xs font-semibold">No banked documents found</div>
                  <div className="text-[11px] text-gray-400 mt-0.5">
                    Try adjusting your search query or upload a new file in Tab B.
                  </div>
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-2 max-h-[380px] overflow-y-auto pr-1">
                  {filteredBankDocs.map((doc) => {
                    const isSelected = selectedBankDocId === doc.id;
                    const isImg =
                      (doc.mime_type || '').startsWith('image/') ||
                      ['.jpg', '.jpeg', '.png', '.webp'].some((ext) =>
                        (doc.original_file_name || doc.title || '').toLowerCase().endsWith(ext)
                      );

                    return (
                      <div
                        key={doc.id}
                        onClick={() => setSelectedBankDocId(doc.id)}
                        className={`p-3 rounded-xl border text-xs cursor-pointer transition flex items-start justify-between gap-3 ${
                          isSelected
                            ? 'border-emerald-500 bg-emerald-50/50 shadow-2xs ring-2 ring-emerald-500/20'
                            : 'border-gray-200 hover:border-gray-300 hover:bg-slate-50'
                        }`}
                      >
                        <div className="flex items-start gap-3 min-w-0 flex-1">
                          <div
                            className={`w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 ${
                              isImg
                                ? 'bg-blue-100 text-blue-700'
                                : 'bg-red-100 text-red-700'
                            }`}
                          >
                            {isImg ? (
                              <ImageIcon className="w-5 h-5" />
                            ) : (
                              <FileText className="w-5 h-5" />
                            )}
                          </div>
                          <div className="min-w-0 flex-1 space-y-1">
                            <div className="flex items-center gap-2">
                              <span className="font-bold text-gray-900 truncate">
                                {doc.original_file_name || doc.title}
                              </span>
                              <span
                                className={`text-[10px] font-bold px-1.5 py-0.5 rounded uppercase tracking-wider ${
                                  doc.document_type === 'COA'
                                    ? 'bg-emerald-100 text-emerald-800'
                                    : doc.document_type === 'MSDS'
                                    ? 'bg-blue-100 text-blue-800'
                                    : (doc.document_type as string) === 'SPEC' || doc.document_type === 'SPECIFICATION' || doc.document_type === 'TDS'
                                    ? 'bg-purple-100 text-purple-800'
                                    : 'bg-amber-100 text-amber-800'
                                }`}
                              >
                                {doc.document_type || 'DOC'}
                              </span>
                            </div>

                            {/* Product & Make metadata */}
                            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-gray-500">
                              {doc.product_name && (
                                <span className="flex items-center gap-1">
                                  <Package className="w-3 h-3 text-gray-400" />
                                  <strong className="text-gray-700">{doc.product_name}</strong>
                                </span>
                              )}
                              {doc.make_name && (
                                <span className="flex items-center gap-1">
                                  <Building className="w-3 h-3 text-gray-400" />
                                  <span>{doc.make_name}</span>
                                </span>
                              )}
                              {doc.batch_number && (
                                <span className="font-mono text-gray-600 bg-gray-100 px-1 rounded text-[10px]">
                                  Batch #{doc.batch_number}
                                </span>
                              )}
                              <span>&bull;</span>
                              <span>{formatAttachmentSize(doc.file_size ? Number(doc.file_size) : null)}</span>
                            </div>
                          </div>
                        </div>

                        {/* Selection Radio Circle */}
                        <div className="pt-1 flex-shrink-0">
                          <div
                            className={`w-5 h-5 rounded-full border-2 flex items-center justify-center transition ${
                              isSelected
                                ? 'border-emerald-600 bg-emerald-600 text-white'
                                : 'border-gray-300 bg-white'
                            }`}
                          >
                            {isSelected && <Check className="w-3.5 h-3.5 stroke-[3]" />}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {activeTab === 'upload' && (
            <div className="space-y-4">
              {/* File Dropzone */}
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf,image/jpeg,image/png,image/webp"
                onChange={handleFileChange}
                className="hidden"
              />

              {!uploadedFile ? (
                <div
                  onClick={() => fileInputRef.current?.click()}
                  className="border-2 border-dashed border-gray-300 hover:border-emerald-500 bg-slate-50/50 hover:bg-emerald-50/30 rounded-2xl p-8 text-center cursor-pointer transition space-y-3"
                >
                  <div className="w-12 h-12 rounded-full bg-emerald-100 text-emerald-700 flex items-center justify-center mx-auto">
                    <UploadCloud className="w-6 h-6" />
                  </div>
                  <div>
                    <div className="text-xs font-bold text-gray-800">
                      Click to upload Photo or PDF Document
                    </div>
                    <div className="text-[11px] text-gray-500 mt-1">
                      Supports JPEG, PNG, WebP photographs and PDF technical documents (COA, Specification, Catalog).
                    </div>
                  </div>
                  <div className="inline-block px-3 py-1 bg-white border border-gray-200 rounded-full text-[10px] font-semibold text-gray-600 shadow-2xs">
                    Single Attachment Rule: Exactly 1 file allowed
                  </div>
                </div>
              ) : (
                <div className="bg-slate-50 border border-gray-200 rounded-2xl p-4 space-y-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex items-start gap-3 min-w-0 flex-1">
                      {uploadPreviewUrl ? (
                        <div className="w-16 h-16 rounded-lg overflow-hidden border border-gray-200 bg-white flex-shrink-0">
                          <img
                            src={uploadPreviewUrl}
                            alt="Upload preview"
                            className="w-full h-full object-cover"
                          />
                        </div>
                      ) : (
                        <div className="w-16 h-16 rounded-lg bg-red-100 text-red-700 flex items-center justify-center flex-shrink-0 border border-red-200">
                          <FileText className="w-8 h-8" />
                        </div>
                      )}
                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="font-bold text-gray-900 truncate text-xs">
                          {uploadedFile.name}
                        </div>
                        <div className="text-[11px] text-gray-500">
                          {formatAttachmentSize(uploadedFile.size)} &bull;{' '}
                          {uploadedFile.type.startsWith('image/') ? 'Photograph' : 'PDF Document'}
                        </div>
                        <div className="text-[10px] text-emerald-700 font-semibold flex items-center gap-1">
                          <Check className="w-3 h-3" /> Ready to attach to message
                        </div>
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={() => {
                        setUploadedFile(null);
                        setUploadPreviewUrl(null);
                      }}
                      className="text-gray-400 hover:text-rose-600 p-1.5 rounded-lg hover:bg-gray-100 transition"
                      title="Remove file"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>

                  {/* Document Type Designation */}
                  <div className="pt-2 border-t border-gray-200 flex items-center justify-between gap-3">
                    <label className="text-xs font-bold text-gray-700">Document Type Tag:</label>
                    <select
                      value={uploadDocType}
                      onChange={(e) => setUploadDocType(e.target.value)}
                      className="text-xs border border-gray-300 rounded-lg px-3 py-1.5 bg-white font-medium focus:ring-2 focus:ring-emerald-500 focus:outline-hidden"
                    >
                      <option value="COA">COA (Certificate of Analysis)</option>
                      <option value="MSDS">MSDS (Material Safety Data Sheet)</option>
                      <option value="SPEC">SPEC (Product Specification)</option>
                      <option value="TDS">TDS (Technical Data Sheet)</option>
                      <option value="CATALOGUE">Catalogue / Brochure</option>
                      <option value="PRICE LIST">Price List</option>
                      <option value="PHOTO">Photograph / Stock Photo</option>
                      <option value="OTHER">Other Technical Attachment</option>
                    </select>
                  </div>
                </div>
              )}

              {uploadError && (
                <div className="p-3 bg-rose-50 border border-rose-200 rounded-xl text-xs text-rose-800 flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 text-rose-600 flex-shrink-0" />
                  <span>{uploadError}</span>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div className="px-6 py-3.5 border-t border-gray-200 bg-slate-50 flex items-center justify-between">
          <div className="text-xs text-gray-600 truncate max-w-[50%]">
            {activeTab === 'bank' && selectedBankDoc ? (
              <span className="flex items-center gap-1.5 truncate">
                <span className="font-semibold text-gray-700">Selected:</span>
                <span className="font-bold text-emerald-800 truncate">
                  {selectedBankDoc.original_file_name || selectedBankDoc.title}
                </span>
                <span className="text-[10px] bg-emerald-100 text-emerald-800 px-1.5 py-0.2 rounded font-bold">
                  {selectedBankDoc.document_type}
                </span>
              </span>
            ) : activeTab === 'upload' && uploadedFile ? (
              <span className="flex items-center gap-1.5 truncate">
                <span className="font-semibold text-gray-700">Ready to Upload:</span>
                <span className="font-bold text-emerald-800 truncate">{uploadedFile.name}</span>
              </span>
            ) : (
              <span className="text-gray-400 italic">No document selected</span>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 border border-gray-300 rounded-xl text-xs font-semibold text-gray-700 hover:bg-gray-100 transition"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={!canConfirm}
              onClick={handleConfirm}
              className="px-5 py-2 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white rounded-xl text-xs font-bold shadow-xs transition flex items-center gap-1.5"
            >
              <Check className="w-4 h-4" />
              Attach to Message
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
