import { useEffect, useId, useState } from 'react';
import { Download, ExternalLink, FileText, Upload, X } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { downloadStorageDocument, openStorageDocument } from '../../utils/signedUrlCache';

interface FinanceDocumentAttachmentsProps {
  documentUrls: string[];
  pendingFiles?: File[];
  onDocumentUrlsChange?: (urls: string[]) => void;
  onPendingFilesChange?: (files: File[]) => void;
  active?: boolean;
  readOnly?: boolean;
  compact?: boolean;
}

const ACCEPT = 'image/*,.pdf,.doc,.docx,.xls,.xlsx';

export async function uploadFinanceDocuments(files: File[], folder: string): Promise<string[]> {
  const urls: string[] = [];
  for (const file of files) {
    const safeName = file.name.replace(/[^a-zA-Z0-9.-]/g, '_');
    const path = `${folder}/${Date.now()}_${crypto.randomUUID()}_${safeName}`;
    const { error } = await supabase.storage.from('expense-documents').upload(path, file, {
      cacheControl: '3600',
      upsert: false,
    });
    if (error) throw new Error(`Failed to upload ${file.name}: ${error.message}`);
    const { data } = supabase.storage.from('expense-documents').getPublicUrl(path);
    urls.push(data.publicUrl);
  }
  return urls;
}

export function FinanceDocumentAttachments({
  documentUrls,
  pendingFiles = [],
  onDocumentUrlsChange,
  onPendingFilesChange,
  active = true,
  readOnly = false,
  compact = false,
}: FinanceDocumentAttachmentsProps) {
  const inputId = useId();
  const [expanded, setExpanded] = useState(readOnly || documentUrls.length > 0);

  const addFiles = (files: File[]) => {
    if (readOnly || files.length === 0) return;
    onPendingFilesChange?.([...pendingFiles, ...files]);
    setExpanded(true);
  };

  useEffect(() => {
    if (!active || readOnly) return;
    const paste = (event: ClipboardEvent) => {
      const files = Array.from(event.clipboardData?.items || [])
        .filter((item) => item.kind === 'file')
        .map((item) => item.getAsFile())
        .filter((file): file is File => Boolean(file));
      if (files.length) {
        event.preventDefault();
        addFiles(files);
      }
    };
    document.addEventListener('paste', paste);
    return () => document.removeEventListener('paste', paste);
  }, [active, readOnly, pendingFiles]);

  const fileName = (url: string, index: number) =>
    decodeURIComponent(url.split('/').pop()?.split('?')[0] || `Document ${index + 1}`);

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Attachments</p>
        {!readOnly && (
          <button type="button" onClick={() => setExpanded((value) => !value)} className="text-[10px] text-blue-600 hover:text-blue-800">
            {documentUrls.length + pendingFiles.length > 0
              ? `${documentUrls.length + pendingFiles.length} file(s) ${expanded ? '▲' : '▼'}`
              : expanded ? 'Hide ▲' : 'Add files ▼'}
          </button>
        )}
      </div>

      {(expanded || readOnly) && (
        <>
          {documentUrls.length === 0 && readOnly && <p className="text-xs text-gray-500">No documents attached.</p>}
          {documentUrls.map((url, index) => (
            <div key={url} className="flex items-center gap-1.5 p-1.5 bg-green-50 border border-green-200 rounded text-xs">
              <FileText className="w-3 h-3 text-green-600 shrink-0" />
              <button type="button" onClick={() => void openStorageDocument(url)} className="flex-1 text-green-700 truncate text-left" title={fileName(url,index)}>
                {fileName(url,index)}
              </button>
              <button type="button" onClick={() => void openStorageDocument(url)} className="p-0.5 text-green-600 hover:bg-green-100 rounded" title="View">
                <ExternalLink className="w-3 h-3" />
              </button>
              <button type="button" onClick={() => void downloadStorageDocument(url, fileName(url,index))} className="p-0.5 text-green-600 hover:bg-green-100 rounded" title="Download">
                <Download className="w-3 h-3" />
              </button>
              {!readOnly && (
                <button type="button" onClick={() => onDocumentUrlsChange?.(documentUrls.filter((item) => item !== url))} className="p-0.5 text-red-600 hover:bg-red-100 rounded" title="Remove">
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>
          ))}
          {!readOnly && pendingFiles.map((file, index) => (
            <div key={`${file.name}:${file.size}:${index}`} className="flex items-center gap-1.5 p-1.5 bg-blue-50 border border-blue-200 rounded text-xs">
              <Upload className="w-3 h-3 text-blue-600 shrink-0" />
              <span className="flex-1 text-blue-700 truncate">{file.name}</span>
              <span className="text-[9px] text-blue-500">{(file.size / 1024).toFixed(0)}KB</span>
              <button type="button" onClick={() => onPendingFilesChange?.(pendingFiles.filter((_, itemIndex) => itemIndex !== index))} className="p-0.5 text-red-600 hover:bg-red-100 rounded">
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}
          {!readOnly && (
            <div
              onDrop={(event) => { event.preventDefault(); addFiles(Array.from(event.dataTransfer.files)); }}
              onDragOver={(event) => event.preventDefault()}
              className={`border-2 border-dashed border-gray-300 rounded text-center hover:border-blue-400 hover:bg-blue-50 ${compact ? 'p-2' : 'p-3'}`}
            >
              <input id={inputId} type="file" multiple accept={ACCEPT} className="hidden"
                onChange={(event) => { addFiles(Array.from(event.target.files || [])); event.target.value=''; }} />
              <label htmlFor={inputId} className="cursor-pointer flex flex-col items-center gap-1">
                <Upload className="w-5 h-5 text-gray-400" />
                <span className="text-xs text-blue-600">Click, drag & drop, or Ctrl+V</span>
              </label>
            </div>
          )}
        </>
      )}
    </div>
  );
}
