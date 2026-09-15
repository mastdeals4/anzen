import React, { useState } from 'react';
import {
  FileText,
  Sparkles,
  Check,
  Edit3,
  X,
  RefreshCw,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Quote,
  CheckCircle2,
} from 'lucide-react';
import { DocumentAiExtraction, ExtractedParameter } from '../../../types/enquiry';
import { EnquiryBrainDocumentService } from '../../../services/enquiry/EnquiryBrainDocumentService';

interface DocumentExtractionCardProps {
  documentId: string;
  documentName: string;
  documentType: string;
  initialExtraction?: DocumentAiExtraction | null;
  enquiryRequestId?: string | null;
  onRefresh?: () => void;
}

const CONFIDENCE_BADGES = {
  HIGH: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  MEDIUM: 'bg-blue-50 text-blue-700 border-blue-200',
  LOW: 'bg-amber-50 text-amber-700 border-amber-200',
};

export const DocumentExtractionCard: React.FC<DocumentExtractionCardProps> = ({
  documentId,
  documentName,
  documentType,
  initialExtraction,
  enquiryRequestId,
  onRefresh,
}) => {
  const [extraction, setExtraction] = useState<DocumentAiExtraction | null>(initialExtraction || null);
  const [isExpanded, setIsExpanded] = useState<boolean>(true);
  const [isEditing, setIsEditing] = useState<boolean>(false);
  const [editedParams, setEditedParams] = useState<ExtractedParameter[]>(initialExtraction?.parameters || []);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const handleAnalyze = async (force = false) => {
    setLoading(true);
    setError(null);
    const res = await EnquiryBrainDocumentService.processDocument(documentId, { force });
    if (!res.success || !res.ai_extraction) {
      setError(res.error || 'Failed to analyze document');
      setLoading(false);
      return;
    }
    setExtraction(res.ai_extraction);
    setEditedParams(res.ai_extraction.parameters || []);
    setLoading(false);
    onRefresh?.();
  };

  const handleAccept = async () => {
    setLoading(true);
    setError(null);
    const res = await EnquiryBrainDocumentService.acceptExtraction(documentId, enquiryRequestId || undefined);
    if (!res.success) {
      setError(res.error || 'Failed to accept extraction');
      setLoading(false);
      return;
    }
    if (extraction) {
      setExtraction({ ...extraction, status: 'accepted' });
    }
    setLoading(false);
    onRefresh?.();
  };

  const handleEditSave = async () => {
    setLoading(true);
    setError(null);
    const res = await EnquiryBrainDocumentService.editExtraction(documentId, {
      parameters: editedParams,
    });
    if (!res.success) {
      setError(res.error || 'Failed to save edits');
      setLoading(false);
      return;
    }
    if (extraction) {
      setExtraction({
        ...extraction,
        status: 'edited',
        parameters: editedParams,
        edited_values: { parameters: editedParams },
      });
    }
    setIsEditing(false);
    setLoading(false);
    onRefresh?.();
  };

  const handleDismiss = async () => {
    if (!confirm('Dismiss this AI document extraction?')) return;
    setLoading(true);
    const res = await EnquiryBrainDocumentService.dismissExtraction(documentId);
    if (!res.success) {
      setError(res.error || 'Failed to dismiss extraction');
      setLoading(false);
      return;
    }
    if (extraction) {
      setExtraction({ ...extraction, status: 'dismissed' });
    }
    setLoading(false);
    onRefresh?.();
  };

  if (!extraction) {
    return (
      <div className="flex items-center justify-between p-2 rounded bg-gray-50 border border-gray-200 text-xs mt-1.5">
        <div className="flex items-center gap-1.5 text-gray-600">
          <FileText className="w-3.5 h-3.5 text-gray-400" />
          <span className="font-medium">{documentName}</span>
        </div>
        <button
          onClick={() => handleAnalyze(false)}
          disabled={loading}
          className="px-2 py-0.5 bg-blue-50 hover:bg-blue-100 text-blue-700 border border-blue-200 rounded font-medium flex items-center gap-1 text-[11px] transition-colors"
        >
          {loading ? (
            <RefreshCw className="w-3 h-3 animate-spin" />
          ) : (
            <Sparkles className="w-3 h-3 text-blue-600" />
          )}
          <span>Analyze Document</span>
        </button>
      </div>
    );
  }

  const isTerminal = extraction.status === 'accepted' || extraction.status === 'dismissed';

  return (
    <div className="border border-blue-200 rounded-lg bg-gradient-to-br from-blue-50/40 to-white p-3 text-xs space-y-2.5 shadow-2xs mt-2">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="p-1 rounded bg-blue-100 text-blue-700">
            <Sparkles className="w-3.5 h-3.5" />
          </div>
          <span className="font-semibold text-blue-950">DOCUMENT UNDERSTANDING</span>
          <span className="px-2 py-0.5 rounded bg-blue-100 text-blue-800 text-[10px] font-medium uppercase">
            {extraction.document_type || documentType}
          </span>
          <span
            className={`px-2 py-0.5 rounded border text-[10px] font-medium uppercase ${
              CONFIDENCE_BADGES[extraction.confidence_tier] || CONFIDENCE_BADGES.MEDIUM
            }`}
          >
            {extraction.confidence_tier} Confidence
          </span>
          {extraction.needs_verification && (
            <span className="px-2 py-0.5 rounded bg-amber-100 text-amber-800 text-[10px] font-medium flex items-center gap-1">
              <AlertTriangle className="w-3 h-3" />
              <span>Needs Verification</span>
            </span>
          )}
          {extraction.status === 'accepted' && (
            <span className="px-2 py-0.5 rounded bg-emerald-100 text-emerald-800 text-[10px] font-medium flex items-center gap-1">
              <CheckCircle2 className="w-3 h-3" />
              <span>Accepted</span>
            </span>
          )}
          {extraction.status === 'dismissed' && (
            <span className="px-2 py-0.5 rounded bg-gray-100 text-gray-600 text-[10px] font-medium">
              Dismissed
            </span>
          )}
        </div>

        <div className="flex items-center gap-1">
          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className="p-1 text-gray-500 hover:text-gray-700 rounded hover:bg-gray-100"
          >
            {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </button>
        </div>
      </div>

      {error && (
        <div className="p-2 rounded bg-rose-50 border border-rose-200 text-rose-700 text-[11px] flex items-center gap-1.5">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {isExpanded && (
        <div className="space-y-2.5">
          {/* Metadata Grid */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 p-2 rounded bg-white border border-gray-200 text-[11px]">
            <div>
              <span className="text-gray-400 block uppercase text-[9px] font-medium">Product</span>
              <span className="font-semibold text-gray-800 truncate block">
                {extraction.product_name || '—'}
              </span>
            </div>
            <div>
              <span className="text-gray-400 block uppercase text-[9px] font-medium">Batch / Lot</span>
              <span className="font-semibold text-gray-800 truncate block">
                {extraction.batch_number || '—'}
              </span>
            </div>
            <div>
              <span className="text-gray-400 block uppercase text-[9px] font-medium">Manufacturer</span>
              <span className="font-semibold text-gray-800 truncate block">
                {extraction.manufacturer || '—'}
              </span>
            </div>
            <div>
              <span className="text-gray-400 block uppercase text-[9px] font-medium">Mfg / Exp Date</span>
              <span className="font-semibold text-gray-800 truncate block">
                {extraction.manufacturing_date || '—'} / {extraction.expiry_date || '—'}
              </span>
            </div>
          </div>

          {/* Parameters Table */}
          {extraction.parameters && extraction.parameters.length > 0 && (
            <div className="overflow-x-auto border border-gray-200 rounded bg-white">
              <table className="w-full text-left text-[11px]">
                <thead className="bg-gray-50 text-gray-500 border-b border-gray-200">
                  <tr>
                    <th className="py-1.5 px-2 font-medium">Parameter</th>
                    <th className="py-1.5 px-2 font-medium">AI Value</th>
                    <th className="py-1.5 px-2 font-medium">Unit</th>
                    <th className="py-1.5 px-2 font-medium">Specification Limit</th>
                    <th className="py-1.5 px-2 font-medium">Evidence Quote</th>
                    <th className="py-1.5 px-2 font-medium text-center">Confidence</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {extraction.parameters.map((param, idx) => (
                    <tr key={idx} className="hover:bg-blue-50/20">
                      <td className="py-1.5 px-2 font-medium text-gray-900">{param.parameter}</td>
                      <td className="py-1.5 px-2 font-semibold text-blue-900">
                        {isEditing ? (
                          <input
                            type="text"
                            value={editedParams[idx]?.extracted_value || ''}
                            onChange={(e) => {
                              const updated = [...editedParams];
                              updated[idx] = { ...updated[idx], extracted_value: e.target.value };
                              setEditedParams(updated);
                            }}
                            className="px-1.5 py-0.5 border border-blue-400 rounded text-xs w-24 bg-white"
                          />
                        ) : (
                          param.extracted_value
                        )}
                      </td>
                      <td className="py-1.5 px-2 text-gray-600">{param.unit || '—'}</td>
                      <td className="py-1.5 px-2 text-gray-600">{param.specification_limit || '—'}</td>
                      <td className="py-1.5 px-2 text-gray-500 italic max-w-xs truncate" title={param.evidence}>
                        <div className="flex items-center gap-1">
                          <Quote className="w-2.5 h-2.5 text-gray-400 shrink-0" />
                          <span>"{param.evidence}"</span>
                          {param.page && <span className="text-[9px] text-gray-400">(p.{param.page})</span>}
                        </div>
                      </td>
                      <td className="py-1.5 px-2 text-center">
                        <span
                          className={`px-1.5 py-0.5 rounded text-[9px] font-medium ${
                            param.confidence === 'HIGH'
                              ? 'bg-emerald-100 text-emerald-800'
                              : param.confidence === 'LOW'
                              ? 'bg-amber-100 text-amber-800'
                              : 'bg-blue-100 text-blue-800'
                          }`}
                        >
                          {param.confidence}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Action Gate (Human review) */}
          {!isTerminal && (
            <div className="flex items-center justify-between pt-1 border-t border-blue-100">
              <div className="flex items-center gap-2">
                {isEditing ? (
                  <>
                    <button
                      onClick={handleEditSave}
                      disabled={loading}
                      className="px-2.5 py-1 bg-blue-600 hover:bg-blue-700 text-white rounded font-medium flex items-center gap-1 text-[11px]"
                    >
                      <Check className="w-3 h-3" />
                      <span>Save Edits</span>
                    </button>
                    <button
                      onClick={() => {
                        setIsEditing(false);
                        setEditedParams(extraction.parameters || []);
                      }}
                      className="px-2 py-1 text-gray-600 hover:bg-gray-100 rounded text-[11px]"
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <button
                    onClick={() => setIsEditing(true)}
                    disabled={loading}
                    className="px-2.5 py-1 bg-white border border-gray-300 hover:bg-gray-50 text-gray-700 rounded font-medium flex items-center gap-1 text-[11px]"
                  >
                    <Edit3 className="w-3 h-3 text-gray-500" />
                    <span>Edit Values</span>
                  </button>
                )}
                <button
                  onClick={handleDismiss}
                  disabled={loading}
                  className="px-2 py-1 text-gray-500 hover:text-rose-600 hover:bg-rose-50 rounded text-[11px]"
                >
                  Dismiss
                </button>
              </div>

              {!isEditing && (
                <button
                  onClick={handleAccept}
                  disabled={loading}
                  className="px-3 py-1 bg-emerald-600 hover:bg-emerald-700 text-white rounded font-medium flex items-center gap-1 text-[11px] shadow-xs cursor-pointer transition-colors"
                >
                  <Check className="w-3.5 h-3.5" />
                  <span>Accept Extraction</span>
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
