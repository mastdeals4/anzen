/**
 * Anzen ERP — Shared Client-Side Upload Optimization Pipeline
 * 
 * Enforces automatic, safe, lossless and near-lossless compression on all ERP uploads:
 * - JPEGs, PNGs, WebPs: High-efficiency canvas downsampling (max 2400px, 82% quality for photos).
 *   Strict safety rule: If optimized size >= original size, original is retained.
 * - PDFs: Strictly lossless preservation. Text, form fields, page structure, and digital signatures are never corrupted.
 * - Excel: Strictly lossless preservation. Formulas, cell formatting, VBA macros, and workbook structures are preserved intact.
 * - Unsupported/Safe formats: Passed through completely untouched.
 */

import { SupabaseClient } from '@supabase/supabase-js';

export interface OptimizationResult {
  file: File | Blob;
  originalSize: number;
  optimizedSize: number;
  savedBytes: number;
  compressionRatio: number; // 0.0 to 1.0 (e.g. 0.35 means 35% size reduction)
  mimeType: string;
  isOptimized: boolean;
}

export interface UploadOptimizationOptions {
  maxDimension?: number;
  jpegQuality?: number;
  minSavingsBytes?: number;
  minSavingsPercent?: number;
}

const DEFAULT_OPTIONS: UploadOptimizationOptions = {
  maxDimension: 2400,
  jpegQuality: 0.82,
  minSavingsBytes: 10 * 1024, // 10 KB
  minSavingsPercent: 5,        // At least 5% savings required to replace
};

/**
 * Optimizes an image using HTML Canvas in browser environments.
 * If canvas is unavailable or image is already compact, gracefully returns the original file.
 */
async function optimizeImage(
  file: File,
  options: UploadOptimizationOptions
): Promise<OptimizationResult> {
  const originalSize = file.size;
  const mimeType = file.type || 'image/jpeg';

  // Do not recompress tiny icons or already compact images (< 80 KB)
  if (originalSize < 80 * 1024) {
    return {
      file,
      originalSize,
      optimizedSize: originalSize,
      savedBytes: 0,
      compressionRatio: 0,
      mimeType,
      isOptimized: false,
    };
  }

  // Check if browser DOM environment supports Image & Canvas
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return {
      file,
      originalSize,
      optimizedSize: originalSize,
      savedBytes: 0,
      compressionRatio: 0,
      mimeType,
      isOptimized: false,
    };
  }

  return new Promise<OptimizationResult>((resolve) => {
    const img = new Image();
    const objectUrl = URL.createObjectURL(file);

    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      try {
        let width = img.naturalWidth || img.width;
        let height = img.naturalHeight || img.height;
        const maxDim = options.maxDimension || 2400;

        // Calculate aspect-ratio preserved dimensions
        if (width > maxDim || height > maxDim) {
          if (width > height) {
            height = Math.round((height * maxDim) / width);
            width = maxDim;
          } else {
            width = Math.round((width * maxDim) / height);
            height = maxDim;
          }
        }

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;

        const ctx = canvas.getContext('2d');
        if (!ctx) {
          resolve({
            file,
            originalSize,
            optimizedSize: originalSize,
            savedBytes: 0,
            compressionRatio: 0,
            mimeType,
            isOptimized: false,
          });
          return;
        }

        // Use high-quality smoothing for sharp document and receipt text
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, width, height);

        // Determine output target format
        const outputMime = mimeType === 'image/png' ? 'image/png' : 'image/jpeg';
        const quality = outputMime === 'image/jpeg' ? (options.jpegQuality || 0.82) : undefined;

        canvas.toBlob(
          (blob) => {
            if (!blob) {
              resolve({
                file,
                originalSize,
                optimizedSize: originalSize,
                savedBytes: 0,
                compressionRatio: 0,
                mimeType,
                isOptimized: false,
              });
              return;
            }

            const optimizedSize = blob.size;
            const savedBytes = originalSize - optimizedSize;
            const savedPercent = (savedBytes / originalSize) * 100;

            const minBytes = options.minSavingsBytes ?? 10240;
            const minPct = options.minSavingsPercent ?? 5;

            // Strict safety check: only use optimized blob if genuine savings were achieved
            if (savedBytes >= minBytes && savedPercent >= minPct) {
              const optimizedFile = new File([blob], file.name, {
                type: outputMime,
                lastModified: Date.now(),
              });
              resolve({
                file: optimizedFile,
                originalSize,
                optimizedSize,
                savedBytes,
                compressionRatio: savedBytes / originalSize,
                mimeType: outputMime,
                isOptimized: true,
              });
            } else {
              // Retain original untouched
              resolve({
                file,
                originalSize,
                optimizedSize: originalSize,
                savedBytes: 0,
                compressionRatio: 0,
                mimeType,
                isOptimized: false,
              });
            }
          },
          outputMime,
          quality
        );
      } catch (err) {
        console.warn('Canvas image compression failed, falling back to original:', err);
        resolve({
          file,
          originalSize,
          optimizedSize: originalSize,
          savedBytes: 0,
          compressionRatio: 0,
          mimeType,
          isOptimized: false,
        });
      }
    };

    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      resolve({
        file,
        originalSize,
        optimizedSize: originalSize,
        savedBytes: 0,
        compressionRatio: 0,
        mimeType,
        isOptimized: false,
      });
    };

    img.src = objectUrl;
  });
}

/**
 * Prepares and validates a file before uploading.
 * Dispatches to safe format-specific optimizers or preserves the original.
 */
export async function prepareOptimizedUpload(
  fileOrBlob: File | Blob,
  options?: UploadOptimizationOptions,
  fallbackName?: string
): Promise<OptimizationResult> {
  const mergedOptions = { ...DEFAULT_OPTIONS, ...options };
  const file = fileOrBlob instanceof File
    ? fileOrBlob
    : new File([fileOrBlob], fallbackName || 'document', { type: fileOrBlob.type });

  const rawType = (file.type || '').toLowerCase();
  const name = (file.name || '').toLowerCase();

  // 1. JPEG, PNG, WebP images
  if (
    rawType.startsWith('image/jpeg') ||
    rawType.startsWith('image/jpg') ||
    rawType.startsWith('image/png') ||
    rawType.startsWith('image/webp') ||
    name.endsWith('.jpg') ||
    name.endsWith('.jpeg') ||
    name.endsWith('.png') ||
    name.endsWith('.webp')
  ) {
    return optimizeImage(file, mergedOptions);
  }

  // 2. PDFs — Lossless preservation rule:
  // Preserves text layers, font encodings, and digital signatures byte-for-byte.
  if (rawType.includes('pdf') || name.endsWith('.pdf')) {
    return {
      file,
      originalSize: file.size,
      optimizedSize: file.size,
      savedBytes: 0,
      compressionRatio: 0,
      mimeType: 'application/pdf',
      isOptimized: false,
    };
  }

  // 3. Excel Spreadsheets (.xlsx, .xls, .csv) — Verified lossless preservation rule:
  // Preserves formulas, calculations, macros, and sheets byte-for-byte.
  if (
    rawType.includes('spreadsheet') ||
    rawType.includes('excel') ||
    name.endsWith('.xlsx') ||
    name.endsWith('.xls') ||
    name.endsWith('.csv')
  ) {
    return {
      file,
      originalSize: file.size,
      optimizedSize: file.size,
      savedBytes: 0,
      compressionRatio: 0,
      mimeType: file.type || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      isOptimized: false,
    };
  }

  // 4. Default: Return original file untouched
  return {
    file,
    originalSize: file.size,
    optimizedSize: file.size,
    savedBytes: 0,
    compressionRatio: 0,
    mimeType: file.type || 'application/octet-stream',
    isOptimized: false,
  };
}

export interface UploadOptimizedFileOptions extends UploadOptimizationOptions {
  upsert?: boolean;
  contentType?: string;
}

/**
 * Shared ERP Upload Pipeline.
 * Automatically runs optimization on the incoming file, sets accurate MIME type and
 * byte size in the metadata, and uploads to Supabase Storage.
 */
export async function uploadOptimizedFile(
  supabase: SupabaseClient,
  bucket: string,
  path: string,
  file: File | Blob,
  options?: UploadOptimizedFileOptions
): Promise<{
  data: { path: string } | null;
  error: any | null;
  optimization: OptimizationResult;
}> {
  const fallbackName = path.split('/').pop() || 'document';
  const optimization = await prepareOptimizedUpload(file, options, fallbackName);
  const targetContentType = options?.contentType || optimization.mimeType || 'application/octet-stream';

  const { data, error } = await supabase.storage.from(bucket).upload(path, optimization.file, {
    upsert: options?.upsert ?? false,
    contentType: targetContentType,
  });

  return {
    data,
    error,
    optimization,
  };
}
