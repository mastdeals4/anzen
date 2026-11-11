import React, { useState, useEffect } from 'react';
import {
  X,
  Search,
  CheckCircle,
  FileText,
  Building,
  Package,
  Layers,
  Calendar,
  Loader2,
  Eye,
  Link as LinkIcon,
} from 'lucide-react';
import {
  UniversalDocumentRecord,
  UniversalDocumentType,
  findBankedDocumentsForProductMakeBatch,
  getUniversalDocuments,
} from '../../services/documents/universalDocumentBankService.ts';
import { UniversalDocumentModalPreview } from './UniversalDocumentModalPreview.tsx';

interface AttachFromDocumentBankModalProps {
  isOpen: boolean;
  onClose: () => void;
  onDocumentSelected: (doc: UniversalDocumentRecord) => void;
  initialProductId?: string | null;
  initialProductSourceId?: string | null;
  initialBatchNumber?: string | null;
  allowedDocTypes?: UniversalDocumentType[];
  title?: string;
}

export const AttachFromDocumentBankModal: React.FC<AttachFromDocumentBankModalProps> = ({
  isOpen,
  onClose,
  onDocumentSelected,
  initialProductId,
  initialProductSourceId,
  initialBatchNumber,
  allowedDocTypes,
  title = 'Attach Document from Central Bank',
}) => {
  const [documents, setDocuments] = useState<UniversalDocumentRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedDocId, setSelectedDocId] = useState<string | null>(null);
  const [previewDoc, setPreviewDoc] = useState<UniversalDocumentRecord | null>(null);

  useEffect(() => {
    if (!isOpen) return;

    setLoading(true);
    setSelectedDocId(null);

    // If initialProductId or make is passed, first try to surface matching BANKED docs
    if (initialProductId || initialProductSourceId || initialBatchNumber) {
      findBankedDocumentsForProductMakeBatch({
        productId: initialProductId,
        productSourceId: initialProductSourceId,
        batchNumber: initialBatchNumber,
        documentTypes: allowedDocTypes,
      })
        .then(matched => {
          if (matched.length > 0) {
            setDocuments(matched);
            setLoading(false);
          } else {
            // Fallback to general search if no exact match found
            loadGeneralBank();
          }
        })
        .catch(() => loadGeneralBank());
    } else {
      loadGeneralBank();
    }
  }, [isOpen, initialProductId, initialProductSourceId, initialBatchNumber]);

  const loadGeneralBank = () => {
    setLoading(true);
    getUniversalDocuments({
      lifecycleStatus: 'BANKED',
      searchQuery,
    })
      .then(docs => setDocuments(docs))
      .finally(() => setLoading(false));
  };

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    loadGeneralBank();
  };

  if (!isOpen) return null;

  const selectedDoc = documents.find(d => d.id === selectedDocId) || null;

  return (
    <>
      <div
        className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4 overflow-y-auto"
        onClick={onClose}
      >
        <div
          className="bg-white rounded-2xl max-w-3xl w-full flex flex-col shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150 my-6 max-h-[85vh]"
          onClick={e => e.stopPropagation()}
        >
          {/* Header */}
          <div className="px-5 py-4 bg-slate-900 text-white flex items-center justify-between border-b border-slate-800">
            <div className="flex items-center gap-2.5">
              <div className="p-2 rounded-lg bg-blue-500/20 text-blue-400">
                <LinkIcon className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-sm font-bold">{title}</h3>
                <p className="text-xs text-slate-400">
                  Select an approved canonical document to attach without creating duplicate files
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

          {/* Search Bar */}
          <div className="p-4 bg-slate-50 border-b border-slate-200">
            <form onSubmit={handleSearchSubmit} className="flex gap-2">
              <div className="relative flex-1">
                <Search className="w-4 h-4 absolute left-3 top-2.5 text-slate-400" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  placeholder="Search by Product, Make, Specification, Batch number, or File name..."
                  className="w-full pl-9 pr-3 py-2 bg-white border border-slate-200 rounded-lg text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <button
                type="submit"
                className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold rounded-lg shadow-xs"
              >
                Search
              </button>
            </form>
          </div>

          {/* Documents List */}
          <div className="p-4 overflow-y-auto flex-1 space-y-2 text-xs">
            {loading && (
              <div className="p-8 text-center text-slate-400 flex items-center justify-center gap-2">
                <Loader2 className="w-5 h-5 animate-spin text-blue-600" />
                <span>Searching Universal Document Bank...</span>
              </div>
            )}

            {!loading && documents.length === 0 && (
              <div className="p-8 text-center text-slate-500 space-y-1">
                <FileText className="w-8 h-8 text-slate-400 mx-auto mb-2" />
                <p className="font-semibold text-slate-700">No matching documents found</p>
                <p className="text-[11px] text-slate-400">
                  Try searching for another product name, or verify the document is marked as BANKED.
                </p>
              </div>
            )}

            {!loading &&
              documents.map(doc => {
                const isSelected = selectedDocId === doc.id;

                return (
                  <div
                    key={doc.id}
                    onClick={() => setSelectedDocId(doc.id)}
                    className={`p-3.5 rounded-xl border transition cursor-pointer flex items-center justify-between gap-3 ${
                      isSelected
                        ? 'bg-blue-50/70 border-blue-500 ring-2 ring-blue-500/20'
                        : 'bg-white border-slate-200 hover:border-slate-300'
                    }`}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div
                        className={`w-4 h-4 rounded-full border flex items-center justify-center shrink-0 ${
                          isSelected
                            ? 'border-blue-600 bg-blue-600 text-white'
                            : 'border-slate-300 bg-white'
                        }`}
                      >
                        {isSelected && <CheckCircle className="w-3 h-3" />}
                      </div>

                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-bold text-slate-900 truncate max-w-sm">
                            {doc.title}
                          </span>
                          <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-blue-100 text-blue-800">
                            {doc.document_type}
                          </span>
                          {doc.specification && (
                            <span className="text-[10px] px-2 py-0.5 rounded bg-slate-100 text-slate-700 font-medium">
                              {doc.specification}
                            </span>
                          )}
                          {doc.batch_number && (
                            <span className="text-[10px] font-mono font-bold px-2 py-0.5 rounded bg-amber-100 text-amber-800">
                              Batch: {doc.batch_number}
                            </span>
                          )}
                        </div>

                        <div className="text-[11px] text-slate-500 mt-1 flex items-center gap-3 flex-wrap">
                          {doc.product_name && (
                            <span className="flex items-center gap-1">
                              <Package className="w-3 h-3 text-slate-400" />
                              {doc.product_name}
                            </span>
                          )}
                          {doc.make_name && (
                            <span className="flex items-center gap-1">
                              <Building className="w-3 h-3 text-slate-400" />
                              Make: {doc.make_name}
                            </span>
                          )}
                          {doc.valid_until && (
                            <span className="flex items-center gap-1">
                              <Calendar className="w-3 h-3 text-slate-400" />
                              Valid Until: {doc.valid_until}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={e => {
                          e.stopPropagation();
                          setPreviewDoc(doc);
                        }}
                        className="p-1.5 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition"
                        title="Preview Document"
                      >
                        <Eye className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                );
              })}
          </div>

          {/* Footer */}
          <div className="px-5 py-3.5 bg-slate-50 border-t border-slate-200 flex items-center justify-between">
            <span className="text-xs text-slate-500">
              {selectedDoc ? (
                <span>
                  Selected: <strong className="text-slate-800">{selectedDoc.title}</strong>
                </span>
              ) : (
                'Select a document from above'
              )}
            </span>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 bg-slate-200 hover:bg-slate-300 text-slate-700 text-xs font-semibold rounded-lg"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={!selectedDoc}
                onClick={() => {
                  if (selectedDoc) {
                    onDocumentSelected(selectedDoc);
                    onClose();
                  }
                }}
                className="px-5 py-2 bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold rounded-lg shadow transition disabled:opacity-40"
              >
                Attach Selected Document
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Preview Modal */}
      {previewDoc && (
        <UniversalDocumentModalPreview
          document={previewDoc}
          allDocuments={documents}
          onClose={() => setPreviewDoc(null)}
          onNavigate={doc => setPreviewDoc(doc)}
        />
      )}
    </>
  );
};

