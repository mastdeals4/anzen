import React, { useEffect, useState } from 'react';
import {
  X,
  Download,
  ExternalLink,
  ZoomIn,
  ZoomOut,
  RotateCw,
  FileText,
  FileSpreadsheet,
  AlertCircle,
  Loader2,
  Calendar,
  Layers,
  Link as LinkIcon,
  CheckCircle,
  Clock,
  ShieldAlert,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import {
  UniversalDocumentRecord,
  resolveDocumentViewUrl,
} from '../../services/documents/universalDocumentBankService.ts';

interface UniversalDocumentModalPreviewProps {
  document: UniversalDocumentRecord | null;
  allDocuments?: UniversalDocumentRecord[];
  onClose: () => void;
  onNavigate?: (doc: UniversalDocumentRecord) => void;
}

export const UniversalDocumentModalPreview: React.FC<UniversalDocumentModalPreviewProps> = ({
  document,
  allDocuments = [],
  onClose,
  onNavigate,
}) => {
  const [viewUrl, setViewUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [zoomLevel, setZoomLevel] = useState(100);
  const [rotation, setRotation] = useState(0);

  const currentIndex = document && allDocuments.length > 0
    ? allDocuments.findIndex(d => d.id === document.id)
    : -1;

  useEffect(() => {
    if (!document) {
      setViewUrl(null);
      return;
    }

    let isMounted = true;
    setLoading(true);
    setError(null);
    setZoomLevel(100);
    setRotation(0);

    const bucket = document.storage_bucket || 'documents';
    const path = document.storage_path || '';

    resolveDocumentViewUrl(bucket, path, document.file_url)
      .then(url => {
        if (!isMounted) return;
        if (!url) {
          setError('Could not generate document preview URL.');
        } else {
          setViewUrl(url);
        }
      })
      .catch(err => {
        if (isMounted) setError(err.message || 'Error resolving preview URL');
      })
      .finally(() => {
        if (isMounted) setLoading(false);
      });

    return () => {
      isMounted = false;
    };
  }, [document]);

  // Handle ESC and Arrow key navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      } else if (e.key === 'ArrowLeft' && onNavigate && currentIndex > 0) {
        onNavigate(allDocuments[currentIndex - 1]);
      } else if (
        e.key === 'ArrowRight' &&
        onNavigate &&
        currentIndex !== -1 &&
        currentIndex < allDocuments.length - 1
      ) {
        onNavigate(allDocuments[currentIndex + 1]);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [currentIndex, allDocuments, onClose, onNavigate]);

  if (!document) return null;

  const fileName = document.original_file_name || document.title || 'document';
  const ext = fileName.split('.').pop()?.toLowerCase() || '';
  const isPdf = ext === 'pdf';
  const isImage = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'svg'].includes(ext);
  const isExcel = ['xls', 'xlsx', 'csv'].includes(ext);

  const formatFileSize = (bytes?: number | null) => {
    if (!bytes || bytes === 0) return 'Unknown size';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-2 sm:p-4 md:p-6"
      onClick={onClose}
    >
      <div
        className="bg-slate-900 border border-slate-700/80 rounded-2xl w-full h-full max-w-[92vw] max-h-[92vh] flex flex-col shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150"
        onClick={e => e.stopPropagation()}
      >
        {/* Header Bar */}
        <div className="px-4 py-3 bg-slate-950 border-b border-slate-800 flex items-center justify-between gap-3 text-white shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <div className="p-2 rounded-lg bg-blue-500/20 text-blue-400 shrink-0">
              {isPdf ? (
                <FileText className="w-5 h-5" />
              ) : isImage ? (
                <ExternalLink className="w-5 h-5" />
              ) : isExcel ? (
                <FileSpreadsheet className="w-5 h-5" />
              ) : (
                <FileText className="w-5 h-5" />
              )}
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="text-sm font-semibold truncate text-slate-100 max-w-[320px] sm:max-w-md">
                  {document.title}
                </h3>
                <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-blue-900/60 text-blue-300 border border-blue-700/50 uppercase">
                  {document.document_type}
                </span>
                {document.lifecycle_status === 'BANKED' && (
                  <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-950 text-emerald-400 border border-emerald-700/50 flex items-center gap-1">
                    <CheckCircle className="w-3 h-3" /> Banked
                  </span>
                )}
                {document.lifecycle_status === 'REVIEWED' && (
                  <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-purple-950 text-purple-400 border border-purple-700/50 flex items-center gap-1">
                    <CheckCircle className="w-3 h-3" /> Reviewed
                  </span>
                )}
                {document.lifecycle_status === 'TEMP' && (
                  <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-950 text-amber-400 border border-amber-700/50 flex items-center gap-1">
                    <Clock className="w-3 h-3" /> Temporary
                  </span>
                )}
                {document.lifecycle_status === 'ARCHIVED' && (
                  <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-slate-800 text-slate-400 border border-slate-700 flex items-center gap-1">
                    Archived
                  </span>
                )}
                {document.is_expired && (
                  <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-red-950 text-red-400 border border-red-700/50 flex items-center gap-1">
                    <ShieldAlert className="w-3 h-3" /> Expired
                  </span>
                )}
              </div>
              <div className="flex items-center gap-3 text-xs text-slate-400 mt-0.5 flex-wrap">
                {document.product_name && (
                  <span>
                    Product: <strong className="text-slate-300">{document.product_name}</strong>
                  </span>
                )}
                {document.make_name && (
                  <span>
                    Make: <strong className="text-slate-300">{document.make_name}</strong>
                  </span>
                )}
                {document.specification && (
                  <span>
                    Spec: <strong className="text-slate-300">{document.specification}</strong>
                  </span>
                )}
                {document.batch_number && (
                  <span className="text-amber-400 font-mono font-medium">
                    Batch: {document.batch_number}
                  </span>
                )}
                <span className="text-slate-500 font-mono text-[11px]">
                  {formatFileSize(document.file_size)}
                </span>
              </div>
            </div>
          </div>

          {/* Action buttons */}
          <div className="flex items-center gap-1.5 shrink-0">
            {isImage && (
              <>
                <button
                  type="button"
                  onClick={() => setZoomLevel(prev => Math.max(30, prev - 20))}
                  className="p-1.5 rounded-lg text-slate-300 hover:text-white hover:bg-slate-800 transition"
                  title="Zoom Out"
                >
                  <ZoomOut className="w-4 h-4" />
                </button>
                <span className="text-[11px] font-mono text-slate-400 min-w-[36px] text-center">
                  {zoomLevel}%
                </span>
                <button
                  type="button"
                  onClick={() => setZoomLevel(prev => Math.min(300, prev + 20))}
                  className="p-1.5 rounded-lg text-slate-300 hover:text-white hover:bg-slate-800 transition"
                  title="Zoom In"
                >
                  <ZoomIn className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  onClick={() => setRotation(prev => (prev + 90) % 360)}
                  className="p-1.5 rounded-lg text-slate-300 hover:text-white hover:bg-slate-800 transition"
                  title="Rotate"
                >
                  <RotateCw className="w-4 h-4" />
                </button>
              </>
            )}

            {viewUrl && (
              <a
                href={viewUrl}
                download={fileName}
                target="_blank"
                rel="noreferrer"
                className="p-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white transition flex items-center gap-1 text-xs px-2.5 font-medium ml-1"
                title="Download original file"
              >
                <Download className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Download</span>
              </a>
            )}

            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition ml-1"
              title="Close (Esc)"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Content Body */}
        <div className="flex-1 bg-slate-950 overflow-hidden relative flex items-center justify-center">
          {loading && (
            <div className="flex flex-col items-center justify-center gap-3 text-slate-400">
              <Loader2 className="w-8 h-8 animate-spin text-blue-500" />
              <p className="text-xs font-medium">Resolving document preview...</p>
            </div>
          )}

          {!loading && error && (
            <div className="flex flex-col items-center justify-center p-6 text-center max-w-md text-slate-300">
              <AlertCircle className="w-12 h-12 text-amber-500 mb-3" />
              <h4 className="text-sm font-bold text-slate-100 mb-1">Preview Unavailable</h4>
              <p className="text-xs text-slate-400 mb-4">{error}</p>
              {viewUrl && (
                <a
                  href={viewUrl}
                  download={fileName}
                  className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-xs font-semibold flex items-center gap-1.5"
                >
                  <Download className="w-4 h-4" /> Download File Instead
                </a>
              )}
            </div>
          )}

          {!loading && !error && viewUrl && isPdf && (
            <iframe
              src={`${viewUrl}#toolbar=1&navpanes=0`}
              title={fileName}
              className="w-full h-full border-0 bg-slate-900"
            />
          )}

          {!loading && !error && viewUrl && isImage && (
            <div className="w-full h-full overflow-auto flex items-center justify-center p-4">
              <img
                src={viewUrl}
                alt={fileName}
                style={{
                  transform: `scale(${zoomLevel / 100}) rotate(${rotation}deg)`,
                  transition: 'transform 0.15s ease-out',
                  maxWidth: '100%',
                  maxHeight: '100%',
                  objectFit: 'contain',
                }}
                className="rounded-lg shadow-xl"
              />
            </div>
          )}

          {!loading && !error && viewUrl && !isPdf && !isImage && (
            <div className="flex flex-col items-center justify-center p-8 text-center max-w-lg bg-slate-900 border border-slate-800 rounded-2xl shadow-xl m-4">
              <div className="p-4 rounded-2xl bg-slate-800 text-blue-400 mb-4">
                {isExcel ? <FileSpreadsheet className="w-12 h-12" /> : <FileText className="w-12 h-12" />}
              </div>
              <h4 className="text-sm font-bold text-white mb-1 truncate max-w-sm">{fileName}</h4>
              <p className="text-xs text-slate-400 mb-4">
                This {ext.toUpperCase()} file cannot be previewed inline. Download it to view in Excel or Office.
              </p>
              <div className="flex items-center gap-3">
                <a
                  href={viewUrl}
                  download={fileName}
                  className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-xs font-semibold flex items-center gap-1.5 shadow"
                >
                  <Download className="w-4 h-4" /> Download {fileName}
                </a>
                <a
                  href={viewUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="px-3 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-xs font-medium flex items-center gap-1.5"
                >
                  <ExternalLink className="w-3.5 h-3.5" /> Open Direct
                </a>
              </div>
            </div>
          )}
        </div>

        {/* Footer info bar with Arrow navigation */}
        <div className="px-4 py-2.5 bg-slate-950 border-t border-slate-800 flex items-center justify-between text-xs text-slate-400 shrink-0">
          <div className="flex items-center gap-4 flex-wrap">
            <span className="flex items-center gap-1.5 text-[11px]">
              <Layers className="w-3.5 h-3.5 text-blue-400" />
              Version: <strong className="text-slate-300">v{document.version_number || 1}</strong>
              {document.version_count > 1 && (
                <span className="text-slate-500">({document.version_count} total)</span>
              )}
            </span>
            <span className="flex items-center gap-1.5 text-[11px]">
              <LinkIcon className="w-3.5 h-3.5 text-emerald-400" />
              Associations: <strong className="text-slate-300">{document.link_count || 1}</strong>
            </span>
            {document.valid_until && (
              <span className="flex items-center gap-1.5 text-[11px]">
                <Calendar className="w-3.5 h-3.5 text-amber-400" />
                Valid Until: <strong className={document.is_expired ? 'text-red-400' : 'text-slate-300'}>
                  {document.valid_until}
                </strong>
              </span>
            )}
            {document.sha256 && (
              <span className="hidden md:inline font-mono text-[10px] text-slate-500" title={document.sha256}>
                SHA: {document.sha256.substring(0, 12)}...
              </span>
            )}
          </div>

          {allDocuments.length > 1 && onNavigate && currentIndex !== -1 && (
            <div className="flex items-center gap-2">
              <span className="font-mono text-[11px] text-slate-400">
                {currentIndex + 1} / {allDocuments.length}
              </span>
              <button
                type="button"
                disabled={currentIndex <= 0}
                onClick={() => onNavigate(allDocuments[currentIndex - 1])}
                className="p-1 rounded bg-slate-800 hover:bg-slate-700 disabled:opacity-30 text-white cursor-pointer"
                title="Previous document (Left Arrow)"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <button
                type="button"
                disabled={currentIndex >= allDocuments.length - 1}
                onClick={() => onNavigate(allDocuments[currentIndex + 1])}
                className="p-1 rounded bg-slate-800 hover:bg-slate-700 disabled:opacity-30 text-white cursor-pointer"
                title="Next document (Right Arrow)"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

