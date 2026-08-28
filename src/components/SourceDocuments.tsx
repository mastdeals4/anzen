import { useEffect, useState, useRef } from 'react';
import { supabase } from '../lib/supabase';
import { FileText, Upload, X, ExternalLink, Trash2, Download } from 'lucide-react';
import { Modal } from './Modal';
import { buildNormalizedBaseKey, buildUniqueDocumentNames } from '../utils/documentNaming';
import { resolveStorageUrlCached } from '../utils/signedUrlCache';

interface SourceDocument {
  id: string;
  source_id: string;
  doc_type: string;
  file_url: string;
  original_filename: string;
  display_name?: string | null;
  storage_path?: string | null;
  file_size: number | null;
  notes: string | null;
  uploaded_at: string;
}

interface SourceDocumentsProps {
  isOpen: boolean;
  onClose: () => void;
  sourceId: string;
  sourceName: string;
  productName: string;
}

export function SourceDocuments({
  isOpen,
  onClose,
  sourceId,
  sourceName,
  productName,
}: SourceDocumentsProps) {
  const [documents, setDocuments] = useState<SourceDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [uploadQueue, setUploadQueue] = useState<Array<{ file: File; doc_type: string }>>([]);
  const [signedUrlCache, setSignedUrlCache] = useState<Record<string, string>>({});
  const uploadAreaRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen && sourceId) {
      loadDocuments();
    }
  }, [isOpen, sourceId]);

  useEffect(() => {
    const handlePaste = async (e: ClipboardEvent) => {
      if (!isOpen) return;

      const items = e.clipboardData?.items;
      if (!items) return;

      const files: File[] = [];

      for (let i = 0; i < items.length; i++) {
        const item = items[i];

        if (item.kind === 'file') {
          const file = item.getAsFile();
          if (file) {
            files.push(file);
          }
        }
      }

      if (files.length > 0) {
        e.preventDefault();
        const newUploads = files.map((file) => ({
          file,
          doc_type: 'Other',
        }));
        setUploadQueue((prev) => [...prev, ...newUploads]);
      }
    };

    document.addEventListener('paste', handlePaste);
    return () => document.removeEventListener('paste', handlePaste);
  }, [isOpen]);

  const loadDocuments = async () => {
    try {
      setLoading(true);
      const { data, error } = await supabase
        .from('product_source_documents')
        .select('*')
        .eq('source_id', sourceId)
        .order('uploaded_at', { ascending: false });

      if (error) throw error;
      setDocuments(data || []);
      if (data && data.length > 0) {
        Promise.all(
          data.map(async (doc: any) => [doc.file_url, await resolveStorageUrlCached(doc.file_url, 3600)] as [string, string])
        ).then((entries) => setSignedUrlCache((prev) => ({ ...prev, ...Object.fromEntries(entries) })));
      }
    } catch (error) {
      console.error('Error loading documents:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;

    const newUploads = Array.from(files).map((file) => ({
      file,
      doc_type: 'Other',
    }));
    setUploadQueue((prev) => [...prev, ...newUploads]);
    e.target.value = '';
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();

    const files = e.dataTransfer.files;
    if (!files) return;

    const newUploads = Array.from(files).map((file) => ({
      file,
      doc_type: 'Other',
    }));
    setUploadQueue((prev) => [...prev, ...newUploads]);
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const removeFromQueue = (index: number) => {
    setUploadQueue((prev) => prev.filter((_, i) => i !== index));
  };

  const updateQueueItemType = (index: number, doc_type: string) => {
    setUploadQueue((prev) => {
      const newQueue = [...prev];
      newQueue[index].doc_type = doc_type;
      return newQueue;
    });
  };

  const uploadAll = async () => {
    if (uploadQueue.length === 0) return;

    try {
      setUploading(true);
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const knownStoragePaths = documents
        .map((doc) => doc.storage_path)
        .filter((path): path is string => Boolean(path));

      for (const item of uploadQueue) {
        const normalizedBaseKey = buildNormalizedBaseKey(productName || 'product', sourceName || 'supplier', item.doc_type || 'other');
        const existingStoragePaths = knownStoragePaths.filter((path) => path.split('/').pop()?.startsWith(normalizedBaseKey));

        const fileNaming = buildUniqueDocumentNames({
          product: productName || 'product',
          supplier: sourceName || 'supplier',
          docType: item.doc_type || 'other',
          originalFilename: item.file.name,
          existingStoragePaths,
        });

        const filePath = `${sourceId}/${fileNaming.fileName}`;

        const { error: uploadError } = await supabase.storage
          .from('product-source-documents')
          .upload(filePath, item.file);

        if (uploadError) throw uploadError;

        const { data: { publicUrl } } = supabase.storage
          .from('product-source-documents')
          .getPublicUrl(filePath);

        const { error: dbError } = await supabase
          .from('product_source_documents')
          .insert([{
            source_id: sourceId,
            doc_type: item.doc_type,
            file_url: publicUrl,
            original_filename: item.file.name,
            display_name: fileNaming.displayName,
            storage_path: filePath,
            file_size: item.file.size,
            uploaded_by: user.id,
          }]);

        if (dbError) throw dbError;

        knownStoragePaths.push(filePath);
      }

      setUploadQueue([]);
      loadDocuments();
      alert(`Successfully uploaded ${uploadQueue.length} document(s)`);
    } catch (error: any) {
      console.error('Error uploading documents:', error);
      alert('Failed to upload documents: ' + error.message);
    } finally {
      setUploading(false);
    }
  };

  const handleDelete = async (doc: SourceDocument) => {
    if (!confirm('Are you sure you want to delete this document?')) return;

    try {
      const { error } = await supabase
        .from('product_source_documents')
        .delete()
        .eq('id', doc.id);

      if (error) throw error;
      alert('Document deleted successfully');
      loadDocuments();
    } catch (error: any) {
      console.error('Error deleting document:', error);
      alert('Failed to delete document: ' + error.message);
    }
  };

  const getDocTypeColor = (type: string) => {
    const colors: Record<string, string> = {
      COA: 'bg-green-100 text-green-800',
      MSDS: 'bg-red-100 text-red-800',
      TDS: 'bg-blue-100 text-blue-800',
      SPEC: 'bg-purple-100 text-purple-800',
      Regulatory: 'bg-yellow-100 text-yellow-800',
      'Test Report': 'bg-orange-100 text-orange-800',
      Other: 'bg-gray-100 text-gray-800',
    };
    return colors[type] || colors.Other;
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={`Documents - ${sourceName}`} maxWidth="max-w-4xl">
      <div className="space-y-4">
        {/* Upload Area with Ctrl+V Support */}
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
          <div className="flex items-start gap-3">
            <Upload className="w-5 h-5 text-blue-600 flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="text-sm font-medium text-blue-900 mb-1">
                Fast Upload - Multiple Methods Supported
              </p>
              <ul className="text-xs text-blue-700 space-y-0.5 list-disc ml-4">
                <li><strong>Ctrl+V:</strong> Paste screenshots or files from clipboard</li>
                <li><strong>Drag & Drop:</strong> Drag files directly here</li>
                <li><strong>Click to Browse:</strong> Traditional file selection</li>
              </ul>
            </div>
          </div>
        </div>

        {/* Upload Queue */}
        {uploadQueue.length > 0 && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium text-gray-700">
                Files Ready to Upload ({uploadQueue.length})
              </p>
              <button
                onClick={uploadAll}
                disabled={uploading}
                className="px-3 py-1.5 bg-green-600 text-white rounded text-sm hover:bg-green-700 disabled:opacity-50"
              >
                {uploading ? 'Uploading...' : `Upload ${uploadQueue.length} File${uploadQueue.length > 1 ? 's' : ''}`}
              </button>
            </div>
            {uploadQueue.map((item, index) => (
              <div key={index} className="flex items-center gap-3 p-3 bg-gray-50 border border-gray-200 rounded-lg">
                <FileText className="w-5 h-5 text-gray-600 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-900 truncate">{item.file.name}</p>
                  <p className="text-xs text-gray-500">{(item.file.size / 1024).toFixed(1)} KB</p>
                </div>
                <select
                  value={item.doc_type}
                  onChange={(e) => updateQueueItemType(index, e.target.value)}
                  className="px-2 py-1 text-sm border border-gray-300 rounded"
                >
                  <option value="COA">COA</option>
                  <option value="MSDS">MSDS</option>
                  <option value="TDS">TDS</option>
                  <option value="SPEC">Specification</option>
                  <option value="Regulatory">Regulatory</option>
                  <option value="Test Report">Test Report</option>
                  <option value="Other">Other</option>
                </select>
                <button
                  onClick={() => removeFromQueue(index)}
                  className="p-1 text-red-600 hover:bg-red-50 rounded"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Drag & Drop / Click to Upload Area */}
        <div
          ref={uploadAreaRef}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onClick={() => fileInputRef.current?.click()}
          className="border-2 border-dashed border-gray-300 rounded-lg p-8 text-center cursor-pointer hover:border-blue-400 hover:bg-blue-50 transition"
        >
          <Upload className="w-12 h-12 mx-auto mb-3 text-gray-400" />
          <p className="text-sm text-gray-600 mb-1">
            <span className="font-medium text-blue-600">Click to browse</span> or drag files here
          </p>
          <p className="text-xs text-gray-500">
            Or press <kbd className="px-2 py-0.5 bg-gray-200 rounded text-xs font-mono">Ctrl+V</kbd> to paste from clipboard
          </p>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".pdf,.doc,.docx,.xls,.xlsx,.png,.jpg,.jpeg"
            onChange={handleFileSelect}
            className="hidden"
          />
        </div>

        {/* Existing Documents */}
        <div className="border-t pt-4">
          <h3 className="text-sm font-semibold text-gray-900 mb-3">Uploaded Documents</h3>
          {loading ? (
            <div className="text-center py-8 text-gray-500">Loading documents...</div>
          ) : documents.length === 0 ? (
            <div className="text-center py-8 text-gray-500">
              <FileText className="w-12 h-12 mx-auto mb-3 text-gray-300" />
              <p>No documents uploaded yet</p>
              <p className="text-xs mt-1">Use Ctrl+V, drag & drop, or click above to add documents</p>
            </div>
          ) : (
            <div className="space-y-2">
              {documents.map((doc) => (
                <div
                  key={doc.id}
                  className="flex items-center gap-3 p-3 bg-white border border-gray-200 rounded-lg hover:shadow-sm transition"
                >
                  <FileText className="w-5 h-5 text-blue-600 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">{doc.display_name || doc.original_filename}</p>
                    <div className="flex items-center gap-2 text-xs text-gray-500 mt-1">
                      <span className={`px-2 py-0.5 rounded font-medium ${getDocTypeColor(doc.doc_type)}`}>
                        {doc.doc_type}
                      </span>
                      {doc.file_size && (
                        <>
                          <span>•</span>
                          <span>{(doc.file_size / 1024).toFixed(1)} KB</span>
                        </>
                      )}
                      <span>•</span>
                      <span>{new Date(doc.uploaded_at).toLocaleDateString()}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <a
                      href={signedUrlCache[doc.file_url] || doc.file_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="p-1.5 text-blue-600 hover:bg-blue-50 rounded"
                      title="View"
                    >
                      <ExternalLink className="w-4 h-4" />
                    </a>
                    <a
                      href={signedUrlCache[doc.file_url] || doc.file_url}
                      download={doc.original_filename}
                      className="p-1.5 text-green-600 hover:bg-green-50 rounded"
                      title="Download"
                    >
                      <Download className="w-4 h-4" />
                    </a>
                    <button
                      onClick={() => handleDelete(doc)}
                      className="p-1.5 text-red-600 hover:bg-red-50 rounded"
                      title="Delete"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
