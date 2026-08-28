import { useState, useRef, useEffect, useCallback } from 'react';
import { Upload, X, File as FileIcon, FileText, Image as ImageIcon, AlertCircle, Clipboard } from 'lucide-react';
import { supabase } from '../lib/supabase';

interface UploadedFile {
  id?: string;
  file?: File;
  file_name: string;
  file_type: string;
  file_size: number;
  file_url?: string;
  uploading?: boolean;
  error?: string;
}

interface FileUploadProps {
  batchId?: string;
  existingFiles?: UploadedFile[];
  onFilesChange?: (files: UploadedFile[]) => void;
  onUpload?: (files: File[]) => void | Promise<void>;
  disabled?: boolean;
  accept?: string;
  multiple?: boolean;
  compact?: boolean;
}

const ALLOWED_FILE_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/jpg',
  'image/png',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword'
];

const MAX_FILE_SIZE = 10 * 1024 * 1024;

const DOCUMENT_TYPES = [
  { value: 'invoice', label: 'Invoice' },
  { value: 'bill_of_lading', label: 'Bill of Lading' },
  { value: 'coa', label: 'Certificate of Analysis' },
  { value: 'packing_list', label: 'Packing List' },
  { value: 'other', label: 'Other' },
];

export function FileUpload({
  batchId,
  existingFiles = [],
  onFilesChange,
  onUpload,
  disabled = false,
  accept = '.pdf,.jpg,.jpeg,.png,.xlsx,.xls,.docx,.doc',
  multiple = true,
  compact = false,
}: FileUploadProps) {
  const [files, setFiles] = useState<UploadedFile[]>(existingFiles);
  const [isDragging, setIsDragging] = useState(false);
  const [showPasteHint, setShowPasteHint] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dropZoneRef = useRef<HTMLDivElement>(null);

  const updateFiles = (newFiles: UploadedFile[]) => {
    setFiles(newFiles);
    onFilesChange?.(newFiles);
  };

  const handleMouseEnter = () => {
    if (!disabled) {
      setShowPasteHint(true);
    }
  };

  const handleMouseLeave = () => {
    setShowPasteHint(false);
  };

  const handleFileSelect = useCallback((selectedFiles: FileList | null) => {
    if (!selectedFiles || selectedFiles.length === 0) return;

    const newFiles: UploadedFile[] = [];

    Array.from(selectedFiles).forEach((file) => {
      if (!ALLOWED_FILE_TYPES.includes(file.type)) {
        alert(`File ${file.name} is not a supported format. Please upload PDF, JPG, PNG, XLSX, or DOCX files.`);
        return;
      }

      if (file.size > MAX_FILE_SIZE) {
        alert(`File ${file.name} exceeds the 10MB size limit.`);
        return;
      }

      newFiles.push({
        file,
        file_name: file.name,
        file_type: 'other',
        file_size: file.size,
        uploading: false,
      });
    });

    if (onUpload) {
      void onUpload(newFiles.flatMap((item) => item.file ? [item.file] : []));
      return;
    }

    const nextFiles = [...files, ...newFiles];
    setFiles(nextFiles);
    onFilesChange?.(nextFiles);
  }, [files, onFilesChange, onUpload]);

  useEffect(() => {
    const handlePaste = (e: ClipboardEvent) => {
      if (disabled) return;

      const items = e.clipboardData?.items;
      if (!items) return;

      const pastedFiles: File[] = [];

      for (let i = 0; i < items.length; i++) {
        const item = items[i];

        if (item.type.indexOf('image') !== -1) {
          e.preventDefault();
          const blob = item.getAsFile();
          if (blob) {
            const fileName = `pasted-image-${Date.now()}.png`;
            const file = new window.File([blob], fileName, { type: blob.type });
            pastedFiles.push(file);
          }
        }
      }

      if (pastedFiles.length > 0) {
        const fileList = new DataTransfer();
        pastedFiles.forEach(file => fileList.items.add(file));
        handleFileSelect(fileList.files);

        setShowPasteHint(true);
        setTimeout(() => setShowPasteHint(false), 2000);
      }
    };

    document.addEventListener('paste', handlePaste);
    return () => document.removeEventListener('paste', handlePaste);
  }, [disabled, handleFileSelect]);

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    handleFileSelect(e.dataTransfer.files);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => {
    setIsDragging(false);
  };

  const handleRemoveFile = async (index: number) => {
    const fileToRemove = files[index];

    if (fileToRemove.id && batchId) {
      if (!confirm('Are you sure you want to delete this document?')) return;

      try {
        const { error: dbError } = await supabase
          .from('batch_documents')
          .delete()
          .eq('id', fileToRemove.id);

        if (dbError) throw dbError;

        if (fileToRemove.file_url) {
          const urlParts = fileToRemove.file_url.split('/');
          const fileName = urlParts[urlParts.length - 1];
          const filePath = `${batchId}/${fileName}`;

          await supabase.storage
            .from('batch-documents')
            .remove([filePath]);
        }
      } catch (error) {
        console.error('Error deleting file:', error);
        alert('Failed to delete file. Please try again.');
        return;
      }
    }

    const newFiles = files.filter((_, i) => i !== index);
    updateFiles(newFiles);
  };

  const handleDocumentTypeChange = (index: number, type: string) => {
    const newFiles = [...files];
    newFiles[index].file_type = type;
    updateFiles(newFiles);
  };

  const getFileIcon = (fileName: string) => {
    const ext = fileName.split('.').pop()?.toLowerCase();
    if (['jpg', 'jpeg', 'png'].includes(ext || '')) {
      return <ImageIcon className="w-5 h-5 text-blue-600" />;
    }
    if (ext === 'pdf') {
      return <FileText className="w-5 h-5 text-red-600" />;
    }
    return <FileIcon className="w-5 h-5 text-gray-600" />;
  };

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  };
  const compactFormatHint = /doc|xls/i.test(accept)
    ? 'PDF, images, Office files · max 10MB'
    : 'PDF, JPG, PNG · max 10MB';

  if (compact) {
    return (
      <div
        ref={dropZoneRef}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        onClick={() => !disabled && fileInputRef.current?.click()}
        className={`min-h-12 border border-dashed rounded px-3 py-2 flex items-center gap-2 transition-colors ${
          isDragging ? 'border-blue-500 bg-blue-50' : 'border-gray-300 bg-gray-50 hover:border-gray-400 hover:bg-white'
        } ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
      >
        <Upload className={`w-4 h-4 shrink-0 ${isDragging ? 'text-blue-600' : 'text-gray-400'}`} />
        <div className="min-w-0 flex-1">
          <div className="text-xs text-gray-700">
            <span className="font-medium text-blue-600">{disabled ? 'Uploading...' : 'Upload files'}</span>
            <span className="text-gray-400"> or drag and drop</span>
          </div>
          <div className="text-[10px] text-gray-400">{compactFormatHint}</div>
        </div>
        <div className={`shrink-0 flex items-center gap-1 text-[10px] ${showPasteHint ? 'text-green-600' : 'text-gray-400'}`}>
          <Clipboard className="w-3 h-3" />
          Ctrl+V
        </div>
        <input
          ref={fileInputRef}
          type="file"
          multiple={multiple}
          accept={accept}
          onChange={(event) => {
            handleFileSelect(event.target.files);
            event.target.value = '';
          }}
          className="hidden"
          disabled={disabled}
        />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div
        ref={dropZoneRef}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        className={`border-2 border-dashed rounded-lg p-6 text-center transition-colors relative ${
          isDragging
            ? 'border-blue-500 bg-blue-50'
            : 'border-gray-300 hover:border-gray-400'
        } ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
        onClick={() => !disabled && fileInputRef.current?.click()}
      >
        <Upload className={`w-12 h-12 mx-auto mb-3 ${isDragging ? 'text-blue-500' : 'text-gray-400'}`} />
        <p className="text-sm text-gray-600 mb-1">
          <span className="font-medium text-blue-600">Click to upload</span> or drag and drop
        </p>
        <p className="text-xs text-gray-500 mb-2">
          PDF, JPG, PNG, XLSX, DOCX (max 10MB)
        </p>

        {showPasteHint && (
          <div className="flex items-center justify-center gap-2 text-xs text-green-600 font-medium animate-pulse">
            <Clipboard className="w-4 h-4" />
            <span>Press Ctrl+V to paste images from clipboard</span>
          </div>
        )}

        <input
          ref={fileInputRef}
          type="file"
          multiple={multiple}
          accept={accept}
          onChange={(e) => handleFileSelect(e.target.files)}
          className="hidden"
          disabled={disabled}
        />
      </div>

      {files.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-sm font-medium text-gray-700">
            Documents ({files.length})
          </h4>
          {files.map((file, index) => (
            <div
              key={index}
              className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg border border-gray-200"
            >
              <div className="flex-shrink-0">
                {getFileIcon(file.file_name)}
              </div>

              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  {file.file_url ? (
                    <a
                      href={file.file_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm font-medium text-blue-600 hover:text-blue-700 truncate"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {file.file_name}
                    </a>
                  ) : (
                    <p className="text-sm font-medium text-gray-900 truncate">
                      {file.file_name}
                    </p>
                  )}
                </div>
                <p className="text-xs text-gray-500">
                  {formatFileSize(file.file_size)}
                </p>
              </div>

              <select
                value={file.file_type}
                onChange={(e) => handleDocumentTypeChange(index, e.target.value)}
                className="text-xs px-2 py-1 border border-gray-300 rounded focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                disabled={disabled}
                onClick={(e) => e.stopPropagation()}
              >
                {DOCUMENT_TYPES.map((type) => (
                  <option key={type.value} value={type.value}>
                    {type.label}
                  </option>
                ))}
              </select>

              {file.uploading && (
                <div className="flex-shrink-0">
                  <div className="w-5 h-5 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
                </div>
              )}

              {file.error && (
                <div className="flex-shrink-0" title={file.error}>
                  <AlertCircle className="w-5 h-5 text-red-600" />
                </div>
              )}

              {!disabled && !file.uploading && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleRemoveFile(index);
                  }}
                  className="flex-shrink-0 p-1 text-red-600 hover:bg-red-50 rounded transition"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
