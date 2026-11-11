import React, { useState, useEffect } from 'react';
import {
  X,
  UploadCloud,
  FileText,
  AlertCircle,
  Loader2,
  CheckCircle,
  Package,
  Building,
  Layers,
  Calendar,
} from 'lucide-react';
import { supabase } from '../../lib/supabase.ts';
import {
  UniversalDocumentType,
  UniversalLifecycleStatus,
  ALL_DOCUMENT_TYPES,
  uploadUniversalDocument,
} from '../../services/documents/universalDocumentBankService.ts';

interface UniversalDocumentUploadModalProps {
  isOpen: boolean;
  onClose: () => void;
  onUploaded: () => void;
  defaultProductId?: string | null;
  defaultProductSourceId?: string | null;
  defaultBatchId?: string | null;
  defaultBatchNumber?: string | null;
  defaultDocType?: UniversalDocumentType;
  defaultSourceModule?: string;
  linkTo?: {
    entityType: string;
    entityId: string;
  };
}

interface ProductOption {
  id: string;
  product_name: string;
}

interface ProductSourceOption {
  id: string;
  supplier_name: string;
  grade?: string;
}

export const UniversalDocumentUploadModal: React.FC<UniversalDocumentUploadModalProps> = ({
  isOpen,
  onClose,
  onUploaded,
  defaultProductId = null,
  defaultProductSourceId = null,
  defaultBatchId = null,
  defaultBatchNumber = null,
  defaultDocType = 'COA',
  defaultSourceModule = 'crm',
  linkTo,
}) => {
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [docType, setDocType] = useState<UniversalDocumentType>(defaultDocType);
  const [specification, setSpecification] = useState('');
  const [documentDate, setDocumentDate] = useState('');
  const [validUntil, setValidUntil] = useState('');
  const [productId, setProductId] = useState<string>(defaultProductId || '');
  const [productSourceId, setProductSourceId] = useState<string>(defaultProductSourceId || '');
  const [batchId, setBatchId] = useState<string>(defaultBatchId || '');
  const [batchNumber, setBatchNumber] = useState(defaultBatchNumber || '');
  const [lifecycleStatus, setLifecycleStatus] = useState<UniversalLifecycleStatus>('TEMP');
  const [notes, setNotes] = useState('');

  const [products, setProducts] = useState<ProductOption[]>([]);
  const [productSources, setProductSources] = useState<ProductSourceOption[]>([]);

  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;

    supabase
      .from('products')
      .select('id, product_name')
      .order('product_name')
      .then(({ data }) => setProducts((data || []) as ProductOption[]));
  }, [isOpen]);

  useEffect(() => {
    if (!productId) {
      setProductSources([]);
      return;
    }

    supabase
      .from('product_sources')
      .select('id, supplier_name, grade')
      .eq('product_id', productId)
      .order('supplier_name')
      .then(({ data }) => setProductSources((data || []) as ProductSourceOption[]));
  }, [productId]);

  const handleFileChange = (selected: File | null) => {
    setFile(selected);
    if (selected) {
      const name = selected.name;
      if (!title) {
        setTitle(name.replace(/\.[^/.]+$/, ''));
      }

      // Auto-detect document type from file name
      const upper = name.toUpperCase();
      if (upper.includes('COA')) setDocType('COA');
      else if (upper.includes('MSDS') || upper.includes('SDS')) setDocType('MSDS');
      else if (upper.includes('GMP')) setDocType('GMP');
      else if (upper.includes('HALAL')) setDocType('HALAL');
      else if (upper.includes('SPEC')) setDocType('SPECIFICATION');
      else if (upper.includes('TDS')) setDocType('TDS');
      else if (upper.includes('DMF')) setDocType('DMF');
      else if (upper.includes('INVOICE')) setDocType('SALES INVOICE');
      else if (upper.includes('PO') || upper.includes('PURCHASE')) setDocType('PURCHASE ORDER');

      // Auto-suggest product if file name matches registered product
      if (!productId && products.length > 0) {
        const matched = products.find(p => upper.includes(p.product_name.toUpperCase()));
        if (matched) setProductId(matched.id);
      }
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file) return;

    try {
      setUploading(true);
      setError(null);

      await uploadUniversalDocument({
        file,
        title: title.trim() || file.name,
        documentType: docType,
        specification: specification.trim() || null,
        documentDate: documentDate || null,
        validUntil: validUntil || null,
        lifecycleStatus,
        sourceModule: defaultSourceModule,
        productId: productId || null,
        productSourceId: productSourceId || null,
        batchId: batchId || null,
        batchNumber: batchNumber.trim() || null,
        notes: notes.trim() || null,
        linkTo,
      });

      onUploaded();
      onClose();
    } catch (err: any) {
      setError(err.message || 'Failed to upload document');
    } finally {
      setUploading(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4 overflow-y-auto"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl max-w-xl w-full flex flex-col shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150 my-6"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-5 py-4 bg-slate-900 text-white flex items-center justify-between border-b border-slate-800">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-lg bg-blue-500/20 text-blue-400">
              <UploadCloud className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-sm font-bold">Upload to Universal Document Bank</h3>
              <p className="text-xs text-slate-400">
                Single physical file with SHA-256 duplicate detection & lossless optimization
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-white cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Form Body */}
        <form onSubmit={handleSubmit} className="p-5 space-y-4 max-h-[75vh] overflow-y-auto text-xs">
          {error && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-xl text-red-700 flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {/* File Picker / Drop Area */}
          <div className="border-2 border-dashed border-slate-300 hover:border-blue-500 rounded-xl p-4 text-center bg-slate-50/70 transition cursor-pointer">
            <input
              type="file"
              required
              onChange={e => handleFileChange(e.target.files?.[0] || null)}
              className="w-full text-xs text-slate-600 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:bg-blue-600 file:text-white file:font-semibold hover:file:bg-blue-500 cursor-pointer"
            />
            {file && (
              <div className="mt-2 text-[11px] text-slate-600 flex items-center justify-center gap-2">
                <FileText className="w-4 h-4 text-blue-600" />
                <span className="font-semibold">{file.name}</span>
                <span>({(file.size / 1024).toFixed(1)} KB)</span>
              </div>
            )}
          </div>

          {/* Title */}
          <div>
            <label className="block text-slate-700 font-semibold mb-1">Document Display Title *</label>
            <input
              type="text"
              required
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="e.g. Paracetamol USP Certificate of Analysis"
              className="w-full px-3 py-2 border border-slate-200 rounded-lg text-slate-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          {/* Document Type & Spec */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-slate-700 font-semibold mb-1">Document Type *</label>
              <select
                value={docType}
                onChange={e => setDocType(e.target.value as UniversalDocumentType)}
                className="w-full px-3 py-2 border border-slate-200 rounded-lg text-slate-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                {ALL_DOCUMENT_TYPES.map(t => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-slate-700 font-semibold mb-1">Specification / Grade</label>
              <input
                type="text"
                value={specification}
                onChange={e => setSpecification(e.target.value)}
                placeholder="e.g. USP / BP / EP"
                className="w-full px-3 py-2 border border-slate-200 rounded-lg text-slate-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>

          {/* Product & Make Linkage */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-slate-700 font-semibold mb-1 flex items-center gap-1.5">
                <Package className="w-3.5 h-3.5 text-blue-600" />
                Master Product
              </label>
              <select
                value={productId}
                onChange={e => {
                  setProductId(e.target.value);
                  setProductSourceId('');
                }}
                className="w-full px-3 py-2 border border-slate-200 rounded-lg text-slate-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="">-- General / No Product --</option>
                {products.map(p => (
                  <option key={p.id} value={p.id}>
                    {p.product_name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-slate-700 font-semibold mb-1 flex items-center gap-1.5">
                <Building className="w-3.5 h-3.5 text-indigo-600" />
                Make / Manufacturer
              </label>
              <select
                value={productSourceId}
                onChange={e => setProductSourceId(e.target.value)}
                disabled={!productId}
                className="w-full px-3 py-2 border border-slate-200 rounded-lg text-slate-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-slate-50"
              >
                <option value="">-- Choose Make --</option>
                {productSources.map(s => (
                  <option key={s.id} value={s.id}>
                    {s.supplier_name} {s.grade ? `(${s.grade})` : ''}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Batch Number */}
          {docType === 'COA' && (
            <div>
              <label className="block text-slate-700 font-semibold mb-1 flex items-center gap-1.5">
                <Layers className="w-3.5 h-3.5 text-amber-600" />
                Batch Number (COA Specific)
              </label>
              <input
                type="text"
                value={batchNumber}
                onChange={e => setBatchNumber(e.target.value)}
                placeholder="e.g. BDM/2508060"
                className="w-full px-3 py-2 border border-slate-200 rounded-lg text-slate-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          )}

          {/* Dates */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-slate-700 font-semibold mb-1 flex items-center gap-1.5">
                <Calendar className="w-3.5 h-3.5 text-slate-500" />
                Document Issue Date
              </label>
              <input
                type="date"
                value={documentDate}
                onChange={e => setDocumentDate(e.target.value)}
                className="w-full px-3 py-2 border border-slate-200 rounded-lg text-slate-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="block text-slate-700 font-semibold mb-1 flex items-center gap-1.5">
                <Calendar className="w-3.5 h-3.5 text-red-500" />
                Valid Until (Expiry)
              </label>
              <input
                type="date"
                value={validUntil}
                onChange={e => setValidUntil(e.target.value)}
                className="w-full px-3 py-2 border border-slate-200 rounded-lg text-slate-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>

          {/* Initial Lifecycle Selection */}
          <div>
            <label className="block text-slate-700 font-semibold mb-1">Initial Lifecycle Status</label>
            <div className="flex gap-2">
              <label className="flex items-center gap-2 px-3 py-1.5 border rounded-lg cursor-pointer text-slate-700">
                <input
                  type="radio"
                  name="lifecycleStatus"
                  value="TEMP"
                  checked={lifecycleStatus === 'TEMP'}
                  onChange={() => setLifecycleStatus('TEMP')}
                  className="text-blue-600"
                />
                <span>Temporary / Inbox (Default)</span>
              </label>
              <label className="flex items-center gap-2 px-3 py-1.5 border rounded-lg cursor-pointer text-emerald-800 bg-emerald-50/50 border-emerald-200">
                <input
                  type="radio"
                  name="lifecycleStatus"
                  value="BANKED"
                  checked={lifecycleStatus === 'BANKED'}
                  onChange={() => setLifecycleStatus('BANKED')}
                  className="text-emerald-600"
                />
                <span className="font-semibold">Directly Bank (Verified Asset)</span>
              </label>
            </div>
          </div>

          {/* Notes */}
          <div>
            <label className="block text-slate-700 font-semibold mb-1">Notes</label>
            <textarea
              rows={2}
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="e.g. Uploaded for inquiry reference"
              className="w-full px-3 py-2 border border-slate-200 rounded-lg text-slate-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          {/* Footer Submit */}
          <div className="pt-3 border-t border-slate-200 flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 bg-slate-200 hover:bg-slate-300 text-slate-700 rounded-lg font-medium"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={uploading || !file}
              className="px-5 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg font-bold flex items-center gap-2 shadow transition disabled:opacity-50"
            >
              {uploading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>Uploading & Deduplicating...</span>
                </>
              ) : (
                <>
                  <UploadCloud className="w-4 h-4" />
                  <span>Upload to Bank</span>
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

