import React, { useState } from 'react';
import {
  FileText,
  Download,
  ExternalLink,
  Tag,
  Calendar,
  Layers,
  Filter,
  Eye,
  CheckCircle2,
} from 'lucide-react';
import { getSignedUrlCached } from '../../../utils/signedUrlCache';
import { DocumentAiExtraction } from '../../../types/enquiry';
import { DocumentExtractionCard } from './DocumentExtractionCard';

export interface EnquiryDocumentItem {
  id: string;
  inquiry_id?: string | null;
  enquiry_request_id?: string | null;
  product_name?: string | null;
  make?: string | null;
  document_type: string;
  original_file_name?: string | null;
  display_file_name?: string | null;
  storage_path: string;
  uploaded_by?: string | null;
  created_at: string;
  // Optional resolved request context
  request_code?: string;
  request_title?: string;
  // Phase 7.6E: AI Extraction
  ai_extraction?: DocumentAiExtraction | null;
}

interface DocumentsListProps {
  documents: EnquiryDocumentItem[];
  currentInquiryNumber: string;
  loading?: boolean;
  onRefresh?: () => void;
}

const DOC_TYPE_STYLES: Record<string, { bg: string; text: string }> = {
  COA: { bg: 'bg-emerald-100', text: 'text-emerald-800' },
  MSDS: { bg: 'bg-rose-100', text: 'text-rose-800' },
  TDS: { bg: 'bg-blue-100', text: 'text-blue-800' },
  SPEC: { bg: 'bg-purple-100', text: 'text-purple-800' },
  HALAL: { bg: 'bg-teal-100', text: 'text-teal-800' },
  COC: { bg: 'bg-cyan-100', text: 'text-cyan-800' },
  GMP: { bg: 'bg-indigo-100', text: 'text-indigo-800' },
  ISO: { bg: 'bg-sky-100', text: 'text-sky-800' },
  DMF: { bg: 'bg-amber-100', text: 'text-amber-800' },
  OTHER: { bg: 'bg-gray-100', text: 'text-gray-800' },
};

export const DocumentsList: React.FC<DocumentsListProps> = ({
  documents,
  currentInquiryNumber,
  loading = false,
  onRefresh = () => {},
}) => {
  const [filterType, setFilterType] = useState<string>('ALL');
  const [onlyRequestLinked, setOnlyRequestLinked] = useState<boolean>(false);

  const handleOpenDocument = async (doc: EnquiryDocumentItem, download = false) => {
    const filename = doc.display_file_name || doc.original_file_name || 'document';
    try {
      const url = await getSignedUrlCached('crm-documents', doc.storage_path, 3600, {
        download: download ? filename : undefined,
      });
      if (!url) {
        alert('Unable to generate secure signed URL for this document.');
        return;
      }
      if (download) {
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        link.rel = 'noopener noreferrer';
        document.body.appendChild(link);
        link.click();
        link.remove();
      } else {
        window.open(url, '_blank', 'noopener,noreferrer');
      }
    } catch (err) {
      console.error('[DocumentsList] Error opening document:', err);
      alert('Failed to access document.');
    }
  };

  const filteredDocs = documents.filter(doc => {
    if (filterType !== 'ALL' && doc.document_type !== filterType) return false;
    if (onlyRequestLinked && !doc.enquiry_request_id) return false;
    return true;
  });

  const availableDocTypes = Array.from(new Set(documents.map(d => d.document_type)));

  if (loading) {
    return (
      <div className="p-8 text-center text-gray-500 space-y-2">
        <div className="inline-block w-5 h-5 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
        <p className="text-xs">Loading documents...</p>
      </div>
    );
  }

  if (documents.length === 0) {
    return (
      <div className="p-8 text-center rounded-lg border border-dashed border-gray-300 bg-gray-50/50 space-y-2">
        <FileText className="w-8 h-8 text-gray-400 mx-auto" />
        <p className="text-gray-600 text-xs font-medium">
          No documents associated with this enquiry yet.
        </p>
        <p className="text-gray-400 text-[11px] max-w-sm mx-auto">
          Documents linked directly to enquiry {currentInquiryNumber} or its customer requirements (e.g. COA, MSDS, TDS) will be shown here.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Filter and stats toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-2 p-2.5 rounded-lg bg-gray-50 border border-gray-200 text-xs">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-gray-500 font-medium text-[11px]">Type:</span>
          <button
            type="button"
            onClick={() => setFilterType('ALL')}
            className={`px-2 py-0.5 rounded text-[11px] font-medium transition cursor-pointer ${
              filterType === 'ALL'
                ? 'bg-blue-600 text-white shadow-2xs'
                : 'bg-white border border-gray-200 text-gray-700 hover:bg-gray-100'
            }`}
          >
            All ({documents.length})
          </button>
          {availableDocTypes.map(type => (
            <button
              key={type}
              type="button"
              onClick={() => setFilterType(type)}
              className={`px-2 py-0.5 rounded text-[11px] font-medium transition cursor-pointer ${
                filterType === type
                  ? 'bg-blue-600 text-white shadow-2xs'
                  : 'bg-white border border-gray-200 text-gray-700 hover:bg-gray-100'
              }`}
            >
              {type} ({documents.filter(d => d.document_type === type).length})
            </button>
          ))}
        </div>

        <label className="flex items-center gap-1.5 text-[11px] text-gray-600 cursor-pointer select-none">
          <input name="checkbox" aria-label="Checkbox"
            type="checkbox"
            checked={onlyRequestLinked}
            onChange={e => setOnlyRequestLinked(e.target.checked)}
            className="rounded border-gray-300 text-blue-600 focus:ring-blue-500 w-3.5 h-3.5"
          />
          <span>Request-linked only</span>
        </label>
      </div>

      {/* Documents Grid / Table */}
      {filteredDocs.length === 0 ? (
        <div className="p-6 text-center text-gray-400 text-xs italic bg-gray-50/50 rounded-lg border border-dashed border-gray-200">
          No documents match the selected filters.
        </div>
      ) : (
        <div className="space-y-2">
          {filteredDocs.map(doc => {
            const typeStyle = DOC_TYPE_STYLES[doc.document_type] || DOC_TYPE_STYLES.OTHER;
            const filename = doc.display_file_name || doc.original_file_name || 'document';
            const dateStr = new Date(doc.created_at).toLocaleDateString(undefined, {
              month: 'short',
              day: 'numeric',
              year: 'numeric',
            });

            return (
              <div
                key={doc.id}
                className="p-3 rounded-lg border border-gray-200 bg-white hover:border-blue-300 transition shadow-2xs space-y-2 group"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="space-y-1 min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span
                        className={`px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider ${typeStyle.bg} ${typeStyle.text}`}
                      >
                        {doc.document_type}
                      </span>
                      <span className="font-semibold text-gray-900 text-xs truncate max-w-[280px]">
                        {filename}
                      </span>
                    </div>

                    <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-gray-500">
                      {doc.product_name && (
                        <span>
                          Product: <strong className="text-gray-700">{doc.product_name}</strong>
                        </span>
                      )}
                      {doc.make && (
                        <span>
                          Make: <strong className="text-gray-700">{doc.make}</strong>
                        </span>
                      )}
                      <span>Uploaded: {dateStr}</span>
                    </div>

                    {/* Request Level Association Indicator */}
                    {doc.enquiry_request_id && (
                      <div className="pt-1">
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-purple-50 text-purple-700 border border-purple-200">
                          <Tag className="w-2.5 h-2.5" />
                          <span>Associated Requirement:</span>
                          <strong className="font-semibold">
                            {doc.request_code || doc.request_title || 'Enquiry Request'}
                          </strong>
                        </span>
                      </div>
                    )}
                  </div>

                  {/* Actions: View & Download */}
                  <div className="flex items-center gap-1 pt-0.5 flex-shrink-0">
                    <button
                      type="button"
                      onClick={() => handleOpenDocument(doc, false)}
                      className="p-1.5 rounded border border-gray-200 hover:bg-blue-50 hover:border-blue-300 text-gray-600 hover:text-blue-700 transition cursor-pointer shadow-2xs"
                      title="Open / Preview in new tab"
                    >
                      <Eye className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => handleOpenDocument(doc, true)}
                      className="p-1.5 rounded border border-gray-200 hover:bg-emerald-50 hover:border-emerald-300 text-gray-600 hover:text-emerald-700 transition cursor-pointer shadow-2xs"
                      title="Download document"
                    >
                      <Download className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                {/* Phase 7.6E: Document Intelligence Extraction */}
                <DocumentExtractionCard
                  documentId={doc.id}
                  documentName={filename}
                  documentType={doc.document_type}
                  initialExtraction={doc.ai_extraction}
                  enquiryRequestId={doc.enquiry_request_id}
                  onRefresh={onRefresh}
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
