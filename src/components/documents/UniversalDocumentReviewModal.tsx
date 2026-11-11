import React, { useState, useEffect } from 'react';
import {
  X,
  CheckCircle,
  Clock,
  Archive,
  Save,
  Building,
  Package,
  Layers,
  Calendar,
  FileText,
  AlertCircle,
  Loader2,
} from 'lucide-react';
import { supabase } from '../../lib/supabase.ts';
import {
  UniversalDocumentRecord,
  UniversalDocumentType,
  UniversalLifecycleStatus,
  ALL_DOCUMENT_TYPES,
  updateUniversalDocumentMetadata,
  updateUniversalDocumentLifecycle,
} from '../../services/documents/universalDocumentBankService.ts';

interface UniversalDocumentReviewModalProps {
  document: UniversalDocumentRecord | null;
  onClose: () => void;
  onSaved: () => void;
}

interface ProductOption {
  id: string;
  product_name: string;
}

interface ProductSourceOption {
  id: string;
  supplier_name: string;
  grade?: string;
  country?: string;
}

interface BatchOption {
  id: string;
  batch_number: string;
}

export const UniversalDocumentReviewModal: React.FC<UniversalDocumentReviewModalProps> = ({
  document,
  onClose,
  onSaved,
}) => {
  const [title, setTitle] = useState('');
  const [docType, setDocType] = useState<UniversalDocumentType>('COA');
  const [specification, setSpecification] = useState('');
  const [documentDate, setDocumentDate] = useState('');
  const [validUntil, setValidUntil] = useState('');
  const [productId, setProductId] = useState<string>('');
  const [productSourceId, setProductSourceId] = useState<string>('');
  const [batchId, setBatchId] = useState<string>('');
  const [batchNumber, setBatchNumber] = useState('');
  const [notes, setNotes] = useState('');

  const [products, setProducts] = useState<ProductOption[]>([]);
  const [productSources, setProductSources] = useState<ProductSourceOption[]>([]);
  const [batches, setBatches] = useState<BatchOption[]>([]);

  const [loadingOptions, setLoadingOptions] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!document) return;

    setTitle(document.title || '');
    setDocType(document.document_type || 'COA');
    setSpecification(document.specification || '');
    setDocumentDate(document.document_date || '');
    setValidUntil(document.valid_until || '');
    setProductId(document.primary_product_id || '');
    setProductSourceId(document.primary_product_source_id || '');
    setBatchId(document.primary_batch_id || '');
    setBatchNumber(document.batch_number || document.linked_batch_number || '');
    setNotes(document.notes || '');

    // Load master products
    setLoadingOptions(true);
    supabase
      .from('products')
      .select('id, product_name')
      .order('product_name')
      .then(({ data }) => {
        setProducts((data || []) as ProductOption[]);
        setLoadingOptions(false);
      });
  }, [document]);

  // When product changes, load its product_sources (Makes) and batches
  useEffect(() => {
    if (!productId) {
      setProductSources([]);
      setBatches([]);
      return;
    }

    // Load sources/makes for selected product
    supabase
      .from('product_sources')
      .select('id, supplier_name, grade, country')
      .eq('product_id', productId)
      .order('supplier_name')
      .then(({ data }) => {
        setProductSources((data || []) as ProductSourceOption[]);
      });

    // Load batches for selected product
    supabase
      .from('batches')
      .select('id, batch_number')
      .eq('product_id', productId)
      .order('created_at', { ascending: false })
      .limit(30)
      .then(({ data }) => {
        setBatches((data || []) as BatchOption[]);
      });
  }, [productId]);

  if (!document) return null;

  const handleSaveMetadata = async () => {
    try {
      setSaving(true);
      setError(null);

      await updateUniversalDocumentMetadata(document.id, {
        title,
        documentType: docType,
        specification: specification.trim() || null,
        documentDate: documentDate || null,
        validUntil: validUntil || null,
        primaryProductId: productId || null,
        primaryProductSourceId: productSourceId || null,
        primaryBatchId: batchId || null,
        batchNumber: batchNumber.trim() || null,
        notes: notes.trim() || null,
      });

      onSaved();
      onClose();
    } catch (err: any) {
      setError(err.message || 'Failed to update document metadata');
    } finally {
      setSaving(false);
    }
  };

  const handleLifecycleTransition = async (status: UniversalLifecycleStatus) => {
    try {
      setSaving(true);
      setError(null);

      // Save metadata first
      await updateUniversalDocumentMetadata(document.id, {
        title,
        documentType: docType,
        specification: specification.trim() || null,
        documentDate: documentDate || null,
        validUntil: validUntil || null,
        primaryProductId: productId || null,
        primaryProductSourceId: productSourceId || null,
        primaryBatchId: batchId || null,
        batchNumber: batchNumber.trim() || null,
        notes: notes.trim() || null,
      });

      // Update lifecycle status
      await updateUniversalDocumentLifecycle(document.id, status, notes.trim());

      onSaved();
      onClose();
    } catch (err: any) {
      setError(err.message || 'Failed to update document lifecycle');
    } finally {
      setSaving(false);
    }
  };

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
              <FileText className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-sm font-bold">Review & Edit Document Details</h3>
              <p className="text-xs text-slate-400">
                Link to Master Product, Make (Manufacturer), Specification, and Batch
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

        {/* Body */}
        <div className="p-5 space-y-4 max-h-[75vh] overflow-y-auto text-xs">
          {error && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-xl text-red-700 flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {/* Document Title */}
          <div>
            <label className="block text-slate-700 font-semibold mb-1">Document Display Title *</label>
            <input
              type="text"
              value={title}
              onChange={e => setTitle(e.target.value)}
              className="w-full px-3 py-2 border border-slate-200 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="e.g. Paracetamol USP Certificate of Analysis"
            />
          </div>

          {/* Document Type & Specification */}
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
                className="w-full px-3 py-2 border border-slate-200 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="e.g. USP / BP / EP / Food Grade"
              />
            </div>
          </div>

          {/* Master Product Selection */}
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
                setBatchId('');
              }}
              className="w-full px-3 py-2 border border-slate-200 rounded-lg text-slate-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">-- No Product Linked / General Document --</option>
              {products.map(p => (
                <option key={p.id} value={p.id}>
                  {p.product_name}
                </option>
              ))}
            </select>
          </div>

          {/* Master Make / Manufacturer Selection */}
          <div>
            <label className="block text-slate-700 font-semibold mb-1 flex items-center gap-1.5">
              <Building className="w-3.5 h-3.5 text-indigo-600" />
              Make / Manufacturer (Product Source Master)
            </label>
            <select
              value={productSourceId}
              onChange={e => setProductSourceId(e.target.value)}
              disabled={!productId}
              className="w-full px-3 py-2 border border-slate-200 rounded-lg text-slate-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-slate-50 disabled:text-slate-400"
            >
              <option value="">-- Select Make / Manufacturer --</option>
              {productSources.map(s => (
                <option key={s.id} value={s.id}>
                  {s.supplier_name} {s.grade ? `(${s.grade})` : ''} {s.country ? `[${s.country}]` : ''}
                </option>
              ))}
            </select>
            {!productId && (
              <p className="text-[11px] text-slate-400 mt-0.5">
                Select a Master Product above to choose from registered Makes.
              </p>
            )}
          </div>

          {/* Batch Specific Linkage (for COAs) */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-slate-700 font-semibold mb-1 flex items-center gap-1.5">
                <Layers className="w-3.5 h-3.5 text-amber-600" />
                Select Existing Batch
              </label>
              <select
                value={batchId}
                onChange={e => {
                  const bId = e.target.value;
                  setBatchId(bId);
                  const matched = batches.find(b => b.id === bId);
                  if (matched) setBatchNumber(matched.batch_number);
                }}
                disabled={!productId}
                className="w-full px-3 py-2 border border-slate-200 rounded-lg text-slate-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-slate-50 disabled:text-slate-400"
              >
                <option value="">-- Optional Batch Selection --</option>
                {batches.map(b => (
                  <option key={b.id} value={b.id}>
                    {b.batch_number}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-slate-700 font-semibold mb-1">Batch Number (Manual / COA)</label>
              <input
                type="text"
                value={batchNumber}
                onChange={e => setBatchNumber(e.target.value)}
                className="w-full px-3 py-2 border border-slate-200 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="e.g. BDM/2508060"
              />
            </div>
          </div>

          {/* Document Date & Valid Until (Expiry) */}
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
                className="w-full px-3 py-2 border border-slate-200 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="block text-slate-700 font-semibold mb-1 flex items-center gap-1.5">
                <Calendar className="w-3.5 h-3.5 text-red-500" />
                Valid Until (Expiry Date)
              </label>
              <input
                type="date"
                value={validUntil}
                onChange={e => setValidUntil(e.target.value)}
                className="w-full px-3 py-2 border border-slate-200 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>

          {/* Notes */}
          <div>
            <label className="block text-slate-700 font-semibold mb-1">Review Notes / Remarks</label>
            <textarea
              rows={2}
              value={notes}
              onChange={e => setNotes(e.target.value)}
              className="w-full px-3 py-2 border border-slate-200 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="e.g. Verified against physical manufacturer COA"
            />
          </div>
        </div>

        {/* Footer & Lifecycle Transition Actions */}
        <div className="px-5 py-4 bg-slate-50 border-t border-slate-200 flex flex-wrap items-center justify-between gap-2.5">
          <button
            type="button"
            disabled={saving}
            onClick={handleSaveMetadata}
            className="px-3.5 py-2 bg-slate-200 hover:bg-slate-300 text-slate-800 rounded-lg font-semibold flex items-center gap-1.5 transition disabled:opacity-50"
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            Save Details
          </button>

          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              disabled={saving}
              onClick={() => handleLifecycleTransition('ARCHIVED')}
              className="px-3 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg font-medium flex items-center gap-1.5 transition disabled:opacity-50"
              title="Archive document (superseded / obsolete)"
            >
              <Archive className="w-4 h-4 text-slate-500" />
              Archive
            </button>

            <button
              type="button"
              disabled={saving}
              onClick={() => handleLifecycleTransition('REVIEWED')}
              className="px-3 py-2 bg-purple-50 hover:bg-purple-100 text-purple-700 border border-purple-200 rounded-lg font-medium flex items-center gap-1.5 transition disabled:opacity-50"
              title="Mark as reviewed (validation complete)"
            >
              <Clock className="w-4 h-4 text-purple-600" />
              Mark Reviewed
            </button>

            <button
              type="button"
              disabled={saving}
              onClick={() => handleLifecycleTransition('BANKED')}
              className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg font-bold flex items-center gap-1.5 shadow transition disabled:opacity-50"
              title="Approve as Banked technical library asset"
            >
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />}
              Approve as Banked
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
