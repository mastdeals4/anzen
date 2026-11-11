import React, { useState, useEffect } from 'react';
import {
  X,
  Layers,
  UploadCloud,
  CheckCircle,
  Clock,
  Download,
  AlertCircle,
  Loader2,
  FileText,
} from 'lucide-react';
import {
  UniversalDocumentRecord,
  UniversalDocumentVersion,
  getDocumentVersions,
  uploadRevisedDocumentVersion,
  resolveDocumentViewUrl,
} from '../../services/documents/universalDocumentBankService.ts';

interface UniversalDocumentVersionHistoryModalProps {
  document: UniversalDocumentRecord | null;
  onClose: () => void;
  onVersionAdded: () => void;
}

export const UniversalDocumentVersionHistoryModal: React.FC<UniversalDocumentVersionHistoryModalProps> = ({
  document,
  onClose,
  onVersionAdded,
}) => {
  const [versions, setVersions] = useState<UniversalDocumentVersion[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Revision upload state
  const [showUploadForm, setShowUploadForm] = useState(false);
  const [revisionFile, setRevisionFile] = useState<File | null>(null);
  const [changeSummary, setChangeSummary] = useState('');
  const [uploading, setUploading] = useState(false);
  const [uploadSuccess, setUploadSuccess] = useState<string | null>(null);

  const loadVersions = async () => {
    if (!document) return;
    try {
      setLoading(true);
      setError(null);
      const v = await getDocumentVersions(document.id);
      setVersions(v);
    } catch (err: any) {
      setError(err.message || 'Failed to load document version history');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadVersions();
  }, [document]);

  if (!document) return null;

  const handleUploadRevision = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!revisionFile) return;

    try {
      setUploading(true);
      setError(null);

      const res = await uploadRevisedDocumentVersion({
        documentId: document.id,
        file: revisionFile,
        changeSummary: changeSummary.trim() || `Revision v${versions.length + 1}`,
      });

      setUploadSuccess(
        `Version v${res.versionNumber} uploaded successfully! ${
          res.reusedStorage ? '(Reused verified storage content via SHA-256)' : ''
        }`
      );
      setRevisionFile(null);
      setChangeSummary('');
      setShowUploadForm(false);

      await loadVersions();
      onVersionAdded();
    } catch (err: any) {
      setError(err.message || 'Failed to upload revised document version');
    } finally {
      setUploading(false);
    }
  };

  const handleDownloadVersion = async (v: UniversalDocumentVersion) => {
    try {
      const url = await resolveDocumentViewUrl(v.storage_bucket, v.storage_path, v.file_url);
      if (url) {
        window.open(url, '_blank');
      }
    } catch (err) {
      console.error('Download error:', err);
    }
  };

  const formatBytes = (bytes?: number | null) => {
    if (!bytes || bytes === 0) return '0 B';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
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
            <div className="p-2 rounded-lg bg-blue-500/20 text-blue-400">
              <Layers className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-sm font-bold">Document Version History</h3>
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

          {uploadSuccess && (
            <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-xl text-emerald-800 flex items-center gap-2">
              <CheckCircle className="w-4 h-4 text-emerald-600 shrink-0" />
              <span>{uploadSuccess}</span>
            </div>
          )}

          {/* Action to trigger revision upload form */}
          {!showUploadForm && (
            <div className="flex justify-between items-center bg-slate-50 border border-slate-200 rounded-xl p-3">
              <div>
                <h4 className="font-bold text-slate-900">Upload Revised Version</h4>
                <p className="text-slate-500 text-[11px]">
                  Add an updated MSDS, GMP, or Specification without deleting previous versions.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowUploadForm(true)}
                className="px-3.5 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded-lg font-semibold flex items-center gap-1.5 shadow transition"
              >
                <UploadCloud className="w-4 h-4" /> Add Revision
              </button>
            </div>
          )}

          {/* Revision Upload Form */}
          {showUploadForm && (
            <form
              onSubmit={handleUploadRevision}
              className="p-4 bg-blue-50/60 border border-blue-200 rounded-xl space-y-3"
            >
              <div className="flex items-center justify-between">
                <span className="font-bold text-blue-900">Upload New Revision</span>
                <button
                  type="button"
                  onClick={() => setShowUploadForm(false)}
                  className="text-slate-400 hover:text-slate-600"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div>
                <label className="block text-slate-700 font-semibold mb-1">Select Replacement / Revision File *</label>
                <input
                  type="file"
                  required
                  onChange={e => setRevisionFile(e.target.files?.[0] || null)}
                  className="w-full text-xs text-slate-600 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:bg-blue-600 file:text-white file:font-semibold hover:file:bg-blue-500 cursor-pointer"
                />
              </div>

              <div>
                <label className="block text-slate-700 font-semibold mb-1">Revision Change Summary *</label>
                <input
                  type="text"
                  required
                  value={changeSummary}
                  onChange={e => setChangeSummary(e.target.value)}
                  placeholder="e.g. Revised 2026 MSDS with updated regulatory REACH data"
                  className="w-full px-3 py-2 border border-slate-200 rounded-lg text-slate-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              <div className="flex justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setShowUploadForm(false)}
                  className="px-3 py-1.5 bg-slate-200 hover:bg-slate-300 text-slate-700 rounded-lg font-medium"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={uploading || !revisionFile}
                  className="px-4 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded-lg font-bold flex items-center gap-1.5 shadow transition disabled:opacity-50"
                >
                  {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <UploadCloud className="w-4 h-4" />}
                  Submit Revision
                </button>
              </div>
            </form>
          )}

          {/* Versions List */}
          <div className="space-y-2">
            <h4 className="font-bold text-slate-700">All Preserved Versions ({versions.length})</h4>

            {loading && (
              <div className="p-6 text-center text-slate-400 flex items-center justify-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin text-blue-600" />
                <span>Loading versions...</span>
              </div>
            )}

            {!loading && versions.length === 0 && (
              <p className="text-slate-400 p-4 text-center">No version records found.</p>
            )}

            {!loading &&
              versions.map(v => (
                <div
                  key={v.id}
                  className={`p-3.5 rounded-xl border transition flex items-center justify-between gap-3 ${
                    v.is_current
                      ? 'bg-blue-50/50 border-blue-200'
                      : 'bg-slate-50 border-slate-200/80 text-slate-600'
                  }`}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div
                      className={`p-2 rounded-lg font-bold text-xs ${
                        v.is_current
                          ? 'bg-blue-600 text-white'
                          : 'bg-slate-200 text-slate-700'
                      }`}
                    >
                      v{v.version_number}
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-slate-900 truncate max-w-sm">
                          {v.original_file_name}
                        </span>
                        {v.is_current && (
                          <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 border border-emerald-200 flex items-center gap-1">
                            <CheckCircle className="w-3 h-3 text-emerald-600" /> Current Active
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] text-slate-500 mt-0.5 flex items-center gap-3 flex-wrap">
                        <span>{v.change_summary || 'Initial version'}</span>
                        <span>•</span>
                        <span>{formatBytes(v.file_size)}</span>
                        <span>•</span>
                        <span>{new Date(v.created_at).toLocaleDateString()}</span>
                        {v.sha256 && (
                          <span className="font-mono text-[10px] text-slate-400" title={v.sha256}>
                            SHA: {v.sha256.substring(0, 10)}...
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => handleDownloadVersion(v)}
                    className="px-2.5 py-1.5 rounded-lg bg-white border border-slate-200 hover:bg-slate-100 text-slate-700 font-medium flex items-center gap-1 shadow-xs shrink-0"
                    title="Download this exact version"
                  >
                    <Download className="w-3.5 h-3.5 text-blue-600" /> Download
                  </button>
                </div>
              ))}
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

