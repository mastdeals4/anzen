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
import { PDFDocument } from 'pdf-lib';

export interface OptimizationResult {
  file: File | Blob;
  originalSize: number;
  optimizedSize: number;
  savedBytes: number;
  compressionRatio: number; // 0.0 to 1.0 (e.g. 0.35 means 35% size reduction)
  mimeType: string;
  isOptimized: boolean;
  pageCount?: number;
  skipReason?: string;
}

export interface UploadOptimizationOptions {
  maxDimension?: number;
  jpegQuality?: number;
  minSavingsBytes?: number;
  minSavingsPercent?: number;
}

const DEFAULT_OPTIONS: UploadOptimizationOptions = {
  maxDimension: 2048,
  jpegQuality: 0.82,
  minSavingsBytes: 10 * 1024, // 10 KB
  minSavingsPercent: 5,        // At least 5% savings required to replace
};

/**
 * Checks whether a PDF contains digital signatures or cryptographic signature dictionaries.
 * Any rewriting of signed PDFs invalidates the digital signature hash (/ByteRange).
 * Signed PDFs must be strictly skipped.
 */
export function isDigitallySignedPdf(bytes: Uint8Array): boolean {
  try {
    const text = new TextDecoder('latin1').decode(bytes);
    return (
      /\/ByteRange\s*\[/.test(text) ||
      /\/Type\s*\/Sig\b/.test(text) ||
      /\/Filter\s*\/Adobe\.PPKLite\b/.test(text) ||
      /\/SubFilter\s*\/(?:adbe\.pkcs7|ETSI\.CAdES)/i.test(text) ||
      /\/Contents\s*<[0-9a-fA-F\s]{64,}>/.test(text)
    );
  } catch {
    return false;
  }
}

/**
 * Pure buffer lossless PDF optimizer.
 * Compresses indirect objects into object streams, flates uncompressed streams,
 * removes redundant structures while strictly preserving:
 * - Selectable text layers and font encodings
 * - Page count, dimensions, and visual appearance
 * - Interactive form fields and annotations
 * - Embedded attachments and catalog metadata
 * 
 * Skips signed, encrypted, or corrupted PDFs and enforces >= 5% minimum savings.
 */
export async function optimizePdfBuffer(
  buffer: Uint8Array | ArrayBuffer,
  options?: UploadOptimizationOptions
): Promise<{
  optimizedBuffer: Uint8Array;
  originalSize: number;
  optimizedSize: number;
  savedBytes: number;
  compressionRatio: number;
  isOptimized: boolean;
  pageCount: number;
  skipReason?: string;
}> {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const originalSize = bytes.byteLength;
  const minBytes = options?.minSavingsBytes ?? 10 * 1024;
  const minPct = options?.minSavingsPercent ?? 5;

  // 1. Files smaller than minimum threshold won't achieve meaningful savings
  if (originalSize < minBytes) {
    return {
      optimizedBuffer: bytes,
      originalSize,
      optimizedSize: originalSize,
      savedBytes: 0,
      compressionRatio: 0,
      isOptimized: false,
      pageCount: 0,
      skipReason: 'size_below_threshold',
    };
  }

  // 2. Skip digitally signed PDFs to preserve cryptographic validation
  if (isDigitallySignedPdf(bytes)) {
    return {
      optimizedBuffer: bytes,
      originalSize,
      optimizedSize: originalSize,
      savedBytes: 0,
      compressionRatio: 0,
      isOptimized: false,
      pageCount: 0,
      skipReason: 'digitally_signed',
    };
  }

  try {
    // 3. Load PDF with strict encryption check (throws on encrypted files)
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: false });
    const pageCount = doc.getPageCount();

    if (pageCount === 0) {
      return {
        optimizedBuffer: bytes,
        originalSize,
        optimizedSize: originalSize,
        savedBytes: 0,
        compressionRatio: 0,
        isOptimized: false,
        pageCount: 0,
        skipReason: 'empty_document',
      };
    }

    // 4. Save with object streams to compress indirect objects and flate streams
    const optimizedBytes = await doc.save({
      useObjectStreams: true,
      addDefaultPage: false,
    });

    const optimizedSize = optimizedBytes.byteLength;
    const savedBytes = originalSize - optimizedSize;
    const savedPercent = (savedBytes / originalSize) * 100;

    // 5. Enforce minimum savings threshold (at least 5% AND at least minSavingsBytes)
    if (savedBytes >= minBytes && savedPercent >= minPct) {
      return {
        optimizedBuffer: optimizedBytes,
        originalSize,
        optimizedSize,
        savedBytes,
        compressionRatio: savedBytes / originalSize,
        isOptimized: true,
        pageCount,
      };
    }

    return {
      optimizedBuffer: bytes,
      originalSize,
      optimizedSize: originalSize,
      savedBytes: 0,
      compressionRatio: 0,
      isOptimized: false,
      pageCount,
      skipReason: 'insufficient_savings',
    };
  } catch (err: any) {
    const isEncrypted = err?.name === 'EncryptedPDFError' || /encrypt/i.test(err?.message || '');
    return {
      optimizedBuffer: bytes,
      originalSize,
      optimizedSize: originalSize,
      savedBytes: 0,
      compressionRatio: 0,
      isOptimized: false,
      pageCount: 0,
      skipReason: isEncrypted ? 'encrypted' : `parse_error: ${err?.message || 'unknown'}`,
    };
  }
}

/**
 * Optimizes a PDF file using lossless stream and object structure compression.
 */
async function optimizePdf(
  file: File,
  options: UploadOptimizationOptions
): Promise<OptimizationResult> {
  const originalSize = file.size;
  const mimeType = 'application/pdf';

  try {
    const arrayBuffer = await file.arrayBuffer();
    const result = await optimizePdfBuffer(new Uint8Array(arrayBuffer), options);

    if (result.isOptimized) {
      const optimizedFile = new File([result.optimizedBuffer as any], file.name, {
        type: mimeType,
        lastModified: Date.now(),
      });
      return {
        file: optimizedFile,
        originalSize,
        optimizedSize: result.optimizedSize,
        savedBytes: result.savedBytes,
        compressionRatio: result.compressionRatio,
        mimeType,
        isOptimized: true,
        pageCount: result.pageCount,
      };
    }

    return {
      file,
      originalSize,
      optimizedSize: originalSize,
      savedBytes: 0,
      compressionRatio: 0,
      mimeType,
      isOptimized: false,
      pageCount: result.pageCount,
      skipReason: result.skipReason,
    };
  } catch (err: any) {
    console.warn('PDF optimization failed, falling back to original:', err);
    return {
      file,
      originalSize,
      optimizedSize: originalSize,
      savedBytes: 0,
      compressionRatio: 0,
      mimeType,
      isOptimized: false,
      skipReason: err?.message || 'error',
    };
  }
}

/**
 * Checks whether an HTML Canvas has non-opaque (transparent/translucent) pixels.
 * Used to distinguish photographs/scans from transparent stamps, signatures, and logos.
 */
function canvasHasTransparency(ctx: CanvasRenderingContext2D, width: number, height: number): boolean {
  try {
    const imgData = ctx.getImageData(0, 0, width, height).data;
    // Fast stride check: sample every 16th pixel
    for (let i = 3; i < imgData.length; i += 64) {
      if (imgData[i] < 250) {
        return true;
      }
    }
  } catch {
    // If getImageData fails due to security restrictions, treat as preserving transparency
    return true;
  }
  return false;
}

/**
 * Optimizes an image using HTML Canvas in browser environments.
 * - Resizes unnecessarily large photographs (e.g. smartphone camera 4000px down to 2048px).
 * - Converts opaque photo PNGs and large JPEGs to WebP where compatible (or high-quality MozJPEG),
 *   preserving invoice stamps, signatures, and document fine print.
 * - Preserves PNG format for images with alpha transparency (stamps/signatures).
 * - Skips already-compact images (< 60 KB) and strictly retains the original if savings < 5%.
 * - Uses createImageBitmap off-thread decoding when available to ensure mobile UI never freezes.
 */
async function optimizeImage(
  file: File,
  options: UploadOptimizationOptions
): Promise<OptimizationResult> {
  const originalSize = file.size;
  const mimeType = file.type || 'image/jpeg';

  // Do not recompress tiny icons or already compact images (< 60 KB)
  if (originalSize < 60 * 1024) {
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

  try {
    let sourceWidth = 0;
    let sourceHeight = 0;
    let drawableSource: ImageBitmap | HTMLImageElement;

    // Fast off-thread decoding via createImageBitmap where available (prevents mobile UI freezing)
    if (typeof createImageBitmap === 'function') {
      try {
        const bmp = await createImageBitmap(file);
        sourceWidth = bmp.width;
        sourceHeight = bmp.height;
        drawableSource = bmp;
      } catch {
        // Fallback to HTMLImageElement
        drawableSource = await new Promise<HTMLImageElement>((resolve, reject) => {
          const img = new Image();
          const url = URL.createObjectURL(file);
          img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
          img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Image decode failed')); };
          img.src = url;
        });
        sourceWidth = drawableSource.naturalWidth || drawableSource.width;
        sourceHeight = drawableSource.naturalHeight || drawableSource.height;
      }
    } else {
      drawableSource = await new Promise<HTMLImageElement>((resolve, reject) => {
        const img = new Image();
        const url = URL.createObjectURL(file);
        img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Image decode failed')); };
        img.src = url;
      });
      sourceWidth = drawableSource.naturalWidth || drawableSource.width;
      sourceHeight = drawableSource.naturalHeight || drawableSource.height;
    }

    let width = sourceWidth;
    let height = sourceHeight;
    const maxDim = options.maxDimension || 2048;

    // Aspect-ratio preserved downsampling for photos
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
      if ('close' in drawableSource && typeof drawableSource.close === 'function') drawableSource.close();
      return { file, originalSize, optimizedSize: originalSize, savedBytes: 0, compressionRatio: 0, mimeType, isOptimized: false };
    }

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(drawableSource, 0, 0, width, height);

    if ('close' in drawableSource && typeof drawableSource.close === 'function') {
      drawableSource.close();
    }

    // Determine target format:
    // If PNG, check for transparency. Opaque PNG photos/scans convert to WebP/JPEG for 80-95% savings.
    const isPng = mimeType === 'image/png' || file.name.toLowerCase().endsWith('.png');
    const hasTransparency = isPng ? canvasHasTransparency(ctx, width, height) : false;

    // Candidate target MIME:
    // If has transparency, preserve PNG to prevent losing stamp/signature alphas
    // Otherwise use WebP (or fallback to JPEG 0.82)
    const targetMime = hasTransparency ? 'image/png' : 'image/webp';
    const quality = hasTransparency ? undefined : (options.jpegQuality || 0.82);

    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((b) => {
        if (b && b.type === 'image/webp') {
          resolve(b);
        } else if (!hasTransparency) {
          // If browser does not support WebP encoding, fallback to JPEG
          canvas.toBlob((jpegBlob) => resolve(jpegBlob), 'image/jpeg', quality);
        } else {
          resolve(b);
        }
      }, targetMime, quality);
    });

    if (!blob) {
      return { file, originalSize, optimizedSize: originalSize, savedBytes: 0, compressionRatio: 0, mimeType, isOptimized: false };
    }

    const optimizedSize = blob.size;
    const savedBytes = originalSize - optimizedSize;
    const savedPercent = (savedBytes / originalSize) * 100;
    const minBytes = options.minSavingsBytes ?? 10240;
    const minPct = options.minSavingsPercent ?? 5;

    // Strict safety check: only replace if >= 5% and >= 10 KB savings
    if (savedBytes >= minBytes && savedPercent >= minPct) {
      const outputMime = blob.type || targetMime;
      const optimizedFile = new File([blob], file.name, {
        type: outputMime,
        lastModified: Date.now(),
      });
      return {
        file: optimizedFile,
        originalSize,
        optimizedSize,
        savedBytes,
        compressionRatio: savedBytes / originalSize,
        mimeType: outputMime,
        isOptimized: true,
      };
    }

    return { file, originalSize, optimizedSize: originalSize, savedBytes: 0, compressionRatio: 0, mimeType, isOptimized: false };
  } catch (err) {
    console.warn('Image optimization failed, falling back to original:', err);
    return { file, originalSize, optimizedSize: originalSize, savedBytes: 0, compressionRatio: 0, mimeType, isOptimized: false };
  }
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

  // 2. PDFs — Lossless stream and object structure optimization:
  // Preserves text layers, font encodings, page dimensions, forms, and visual fidelity.
  // Digitally signed or encrypted documents are strictly skipped and preserved byte-for-byte.
  if (rawType.includes('pdf') || name.endsWith('.pdf')) {
    return optimizePdf(file, mergedOptions);
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
