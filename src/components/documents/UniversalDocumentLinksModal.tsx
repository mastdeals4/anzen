import React, { useState, useEffect } from 'react';
import {
  X,
  Link as LinkIcon,
  Plus,
  Trash2,
  Package,
  Building,
  Layers,
  FileCheck,
  AlertCircle,
  Loader2,
  ExternalLink,
} from 'lucide-react';
import { supabase } from '../../lib/supabase.ts';
import {
  UniversalDocumentRecord,
  UniversalDocumentLink,
  getDocumentLinks,
  linkUniversalDocument,
  unlinkUniversalDocument,
} from '../../services/documents/universalDocumentBankService.ts';

interface UniversalDocumentLinksModalProps {
  document: UniversalDocumentRecord | null;
  onClose: () => void;
  onLinksChanged: () => void;
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

interface BatchOption {
  id: string;
  batch_number: string;
}

export const UniversalDocumentLinksModal: React.FC<UniversalDocumentLinksModalProps> = ({
  document,
  onClose,
  onLinksChanged,
}) => {
  const [links, setLinks] = useState<UniversalDocumentLink[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // New link form
  const [showAddForm, setShowAddForm] = useState(false);
  const [targetType, setTargetType] = useState<'product' | 'product_source' | 'batch'>('product');
  const [productId, setProductId] = useState('');
  const [productSourceId, setProductSourceId] = useState('');
  const [batchId, setBatchId] = useState('');
  const [batchNumber, setBatchNumber] = useState('');
  const [notes, setNotes] = useState('');
  const [linking, setLinking] = useState(false);

  const [products, setProducts] = useState<ProductOption[]>([]);
  const [productSources, setProductSources] = useState<ProductSourceOption[]>([]);
  const [batches, setBatches] = useState<BatchOption[]>([]);

  const loadLinks = async () => {
    if (!document) return;
    try {
      setLoading(true);
      setError(null);
      const l = await getDocumentLinks(document.id);
      setLinks(l);
    } catch (err: any) {
      setError(err.message || 'Failed to load document associations');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadLinks();

    // Load master products for linking
    supabase
      .from('products')
      .select('id, product_name')
      .order('product_name')
      .then(({ data }) => setProducts((data || []) as ProductOption[]));
  }, [document]);

  useEffect(() => {
    if (!productId) {
      setProductSources([]);
      setBatches([]);
      return;
    }

    supabase
      .from('product_sources')
      .select('id, supplier_name, grade')
      .eq('product_id', productId)
      .order('supplier_name')
      .then(({ data }) => setProductSources((data || []) as ProductSourceOption[]));

    supabase
      .from('batches')
      .select('id, batch_number')
      .eq('product_id', productId)
      .order('created_at', { ascending: false })
      .limit(30)
      .then(({ data }) => setBatches((data || []) as BatchOption[]));
  }, [productId]);

  if (!document) return null;

  const handleAddLink = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setLinking(true);
      setError(null);

      let entityId = '';
      if (targetType === 'product') {
        if (!productId) throw new Error('Please select a Product');
        entityId = productId;
      } else if (targetType === 'product_source') {
        if (!productSourceId) throw new Error('Please select a Make / Manufacturer');
        entityId = productSourceId;
      } else if (targetType === 'batch') {
        if (!batchId) throw new Error('Please select a Batch');
        entityId = batchId;
      }

      await linkUniversalDocument({
        documentId: document.id,
        entityType: targetType,
        entityId,
        productId: productId || null,
        productSourceId: productSourceId || null,
        batchId: batchId || null,
        batchNumber: batchNumber || null,
        notes: notes.trim() || null,
        isPrimary: false,
      });

      setShowAddForm(false);
      setNotes('');
      await loadLinks();
      onLinksChanged();
    } catch (err: any) {
      setError(err.message || 'Failed to link document');
    } finally {
      setLinking(false);
    }
  };

  const handleUnlink = async (linkId: string) => {
    try {
      setLoading(true);
      setError(null);
      await unlinkUniversalDocument(linkId);
      await loadLinks();
      onLinksChanged();
    } catch (err: any) {
      setError(err.message || 'Failed to unlink document');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl max-w-2xl w-full flex flex-col shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150 max-h-[85vh]"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-5 py-4 bg-slate-900 text-white flex items-center justify-between border-b border-slate-800">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-lg bg-emerald-500/20 text-emerald-400">
              <LinkIcon className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-sm font-bold">Associated Business Records</h3>
              <p className="text-xs text-slate-400 truncate max-w-md">{document.title}</p>
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
        <div className="p-5 space-y-4 overflow-y-auto flex-1 text-xs">
          {error && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-xl text-red-700 flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {/* Trigger Add Link Form */}
          {!showAddForm && (
            <div className="flex justify-between items-center bg-slate-50 border border-slate-200 rounded-xl p-3">
              <div>
                <h4 className="font-bold text-slate-900">Associate With Another Entity</h4>
                <p className="text-slate-500 text-[11px]">
                  Link this document to another Product, Make, or Batch without duplicating the file.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowAddForm(true)}
                className="px-3.5 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg font-semibold flex items-center gap-1.5 shadow transition"
              >
                <Plus className="w-4 h-4" /> Link Entity
              </button>
            </div>
          )}

          {/* Add Link Form */}
          {showAddForm && (
            <form
              onSubmit={handleAddLink}
              className="p-4 bg-emerald-50/60 border border-emerald-200 rounded-xl space-y-3"
            >
              <div className="flex items-center justify-between">
                <span className="font-bold text-emerald-950">Link to Business Record</span>
                <button
                  type="button"
                  onClick={() => setShowAddForm(false)}
                  className="text-slate-400 hover:text-slate-600"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="grid grid-cols-3 gap-2">
                <button
                  type="button"
                  onClick={() => setTargetType('product')}
                  className={`py-1.5 px-2 rounded-lg font-semibold border text-center transition ${
                    targetType === 'product'
                      ? 'bg-blue-600 text-white border-blue-600'
                      : 'bg-white text-slate-700 border-slate-200'
                  }`}
                >
                  Product
                </button>
                <button
                  type="button"
                  onClick={() => setTargetType('product_source')}
                  className={`py-1.5 px-2 rounded-lg font-semibold border text-center transition ${
                    targetType === 'product_source'
                      ? 'bg-indigo-600 text-white border-indigo-600'
                      : 'bg-white text-slate-700 border-slate-200'
                  }`}
                >
                  Make
                </button>
                <button
                  type="button"
                  onClick={() => setTargetType('batch')}
                  className={`py-1.5 px-2 rounded-lg font-semibold border text-center transition ${
                    targetType === 'batch'
                      ? 'bg-amber-600 text-white border-amber-600'
                      : 'bg-white text-slate-700 border-slate-200'
                  }`}
                >
                  Batch
                </button>
              </div>

              {/* Master Product Selection */}
              <div>
                <label className="block text-slate-700 font-semibold mb-1">Select Master Product *</label>
                <select
                  required
                  value={productId}
                  onChange={e => {
                    setProductId(e.target.value);
                    setProductSourceId('');
                    setBatchId('');
                  }}
                  className="w-full px-3 py-2 border border-slate-200 rounded-lg text-slate-900 bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500"
                >
                  <option value="">-- Choose Product --</option>
                  {products.map(p => (
                    <option key={p.id} value={p.id}>
                      {p.product_name}
                    </option>
                  ))}
                </select>
              </div>

              {/* Make Selection */}
              {targetType === 'product_source' && (
                <div>
                  <label className="block text-slate-700 font-semibold mb-1">Select Make / Manufacturer *</label>
                  <select
                    required
                    value={productSourceId}
                    onChange={e => setProductSourceId(e.target.value)}
                    disabled={!productId}
                    className="w-full px-3 py-2 border border-slate-200 rounded-lg text-slate-900 bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500 disabled:bg-slate-50"
                  >
                    <option value="">-- Choose Make --</option>
                    {productSources.map(s => (
                      <option key={s.id} value={s.id}>
                        {s.supplier_name} {s.grade ? `(${s.grade})` : ''}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {/* Batch Selection */}
              {targetType === 'batch' && (
                <div>
                  <label className="block text-slate-700 font-semibold mb-1">Select Batch *</label>
                  <select
                    required
                    value={batchId}
                    onChange={e => {
                      const bId = e.target.value;
                      setBatchId(bId);
                      const m = batches.find(b => b.id === bId);
                      if (m) setBatchNumber(m.batch_number);
                    }}
                    disabled={!productId}
                    className="w-full px-3 py-2 border border-slate-200 rounded-lg text-slate-900 bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500 disabled:bg-slate-50"
                  >
                    <option value="">-- Choose Batch --</option>
                    {batches.map(b => (
                      <option key={b.id} value={b.id}>
                        {b.batch_number}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div>
                <label className="block text-slate-700 font-semibold mb-1">Link Notes</label>
                <input
                  type="text"
                  value={notes}
                  onChange={e => setNotes(e.target.value)}
                  placeholder="e.g. Associated for customer quotation requirement"
                  className="w-full px-3 py-2 border border-slate-200 rounded-lg text-slate-900 bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </div>

              <div className="flex justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setShowAddForm(false)}
                  className="px-3 py-1.5 bg-slate-200 hover:bg-slate-300 text-slate-700 rounded-lg font-medium"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={linking}
                  className="px-4 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg font-bold flex items-center gap-1.5 shadow transition disabled:opacity-50"
                >
                  {linking ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                  Confirm Association
                </button>
              </div>
            </form>
          )}

          {/* Links List */}
          <div className="space-y-2">
            <h4 className="font-bold text-slate-700">All Authorized Links ({links.length})</h4>

            {loading && (
              <div className="p-6 text-center text-slate-400 flex items-center justify-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin text-emerald-600" />
                <span>Loading links...</span>
              </div>
            )}

            {!loading && links.length === 0 && (
              <p className="text-slate-400 p-4 text-center">No active associations found.</p>
            )}

            {!loading &&
              links.map(link => {
                const isProduct = link.entity_type === 'product';
                const isSource = link.entity_type === 'product_source';
                const isBatch = link.entity_type === 'batch';
                const isCrm = link.entity_type.startsWith('crm');

                return (
                  <div
                    key={link.id}
                    className="p-3.5 bg-slate-50 border border-slate-200/80 rounded-xl flex items-center justify-between gap-3"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="p-2 rounded-lg bg-white border border-slate-200 text-slate-700 shrink-0">
                        {isProduct ? (
                          <Package className="w-4 h-4 text-blue-600" />
                        ) : isSource ? (
                          <Building className="w-4 h-4 text-indigo-600" />
                        ) : isBatch ? (
                          <Layers className="w-4 h-4 text-amber-600" />
                        ) : (
                          <FileCheck className="w-4 h-4 text-emerald-600" />
                        )}
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] uppercase font-bold px-2 py-0.5 rounded-full bg-slate-200 text-slate-800">
                            {link.entity_type.replace(/_/g, ' ')}
                          </span>
                          {link.is_primary && (
                            <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-blue-100 text-blue-800">
                              Primary Master Link
                            </span>
                          )}
                        </div>
                        <div className="text-xs font-semibold text-slate-900 mt-1">
                          {link.products?.product_name && (
                            <span>Product: {link.products.product_name}</span>
                          )}
                          {link.product_sources?.supplier_name && (
                            <span className="ml-2">• Make: {link.product_sources.supplier_name}</span>
                          )}
                          {(link.batches?.batch_number || link.batch_number) && (
                            <span className="ml-2 font-mono text-amber-700">
                              • Batch: {link.batches?.batch_number || link.batch_number}
                            </span>
                          )}
                          {link.notes && (
                            <p className="text-[11px] text-slate-500 font-normal mt-0.5">{link.notes}</p>
                          )}
                        </div>
                      </div>
                    </div>

                    {!link.is_primary && (
                      <button
                        type="button"
                        onClick={() => handleUnlink(link.id)}
                        className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition"
                        title="Remove this association"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                );
              })}
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-3 bg-slate-50 border-t border-slate-200 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-white rounded-lg font-semibold"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
};

