import { useState, useRef } from 'react';
import { Upload, X, File, FileText, Image as ImageIcon, AlertCircle } from 'lucide-react';
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
  disabled?: boolean;
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

export function FileUpload({ batchId, existingFiles = [], onFilesChange, disabled = false }: FileUploadProps) {
  const [files, setFiles] = useState<UploadedFile[]>(existingFiles);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const updateFiles = (newFiles: UploadedFile[]) => {
    setFiles(newFiles);
    onFilesChange?.(newFiles);
  };

  const handleFileSelect = (selectedFiles: FileList | null) => {
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

    updateFiles([...files, ...newFiles]);
  };

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
    return <File className="w-5 h-5 text-gray-600" />;
  };

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  };

  return (
    <div className="space-y-4">
      <div
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        className={`border-2 border-dashed rounded-lg p-6 text-center transition-colors ${
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
        <p className="text-xs text-gray-500">
          PDF, JPG, PNG, XLSX, DOCX (max 10MB)
        </p>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept=".pdf,.jpg,.jpeg,.png,.xlsx,.xls,.docx,.doc"
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
