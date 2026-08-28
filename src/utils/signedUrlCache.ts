import { supabase } from '../lib/supabase';

type Entry = { url: string; expiresAt: number };

const cache = new Map<string, Entry>();

const keyFor = (bucket: string, path: string, download?: string) =>
  `${bucket}::${path}::${download || ''}`;

export async function getSignedUrlCached(
  bucket: string,
  path: string,
  ttlSeconds: number,
  options?: { download?: string | true },
): Promise<string | null> {
  const downloadKey =
    typeof options?.download === 'string' ? options.download : options?.download ? '1' : '';
  const key = keyFor(bucket, path, downloadKey);
  const now = Date.now();
  const hit = cache.get(key);
  // Reuse a cached URL while it has at least SAFETY_MARGIN_MS remaining to avoid expiry-at-click.
  const SAFETY_MARGIN_MS = 30_000;
  if (hit && hit.expiresAt > now + SAFETY_MARGIN_MS) {
    return hit.url;
  }
  const { data, error } = await supabase.storage
    .from(bucket)
    .createSignedUrl(path, ttlSeconds, options?.download ? { download: options.download } : undefined);
  if (error || !data?.signedUrl) return null;
  cache.set(key, { url: data.signedUrl, expiresAt: now + ttlSeconds * 1000 });
  return data.signedUrl;
}

export function invalidateSignedUrl(bucket: string, path: string) {
  for (const key of cache.keys()) {
    if (key.startsWith(`${bucket}::${path}::`)) cache.delete(key);
  }
}

// Resolves a stored Supabase Storage URL (public or signed) into a fresh
// signed URL, caching the result. Returns the original URL on parse failure
// so callers preserve existing behavior.
export async function resolveStorageUrlCached(
  fileUrl: string,
  ttlSeconds: number,
  options?: { download?: string | true },
): Promise<string> {
  try {
    const parsedUrl = new URL(fileUrl);
    const storagePath = parsedUrl.pathname;
    const match = storagePath.match(/\/storage\/v1\/object\/(?:public|sign)\/([^/]+)\/(.+)/);
    const authMatch = match ? null : storagePath.match(/\/storage\/v1\/object\/([^/]+)\/(.+)/);
    const parts = match || authMatch;
    if (!parts) return fileUrl;
    const [, bucket, rawPath] = parts;
    const path = decodeURIComponent(rawPath);
    const signed = await getSignedUrlCached(bucket, path, ttlSeconds, options);
    return signed || fileUrl;
  } catch {
    return fileUrl;
  }
}

export async function openStorageDocument(fileUrl: string): Promise<void> {
  const resolved = await resolveStorageUrlCached(fileUrl, 3600);
  if (resolved === fileUrl && isSupabaseStorageObjectUrl(fileUrl)) {
    throw new Error('Unable to create a signed URL for this attachment.');
  }
  window.open(resolved, '_blank', 'noopener,noreferrer');
}

export async function downloadStorageDocument(fileUrl: string, filename: string): Promise<void> {
  const resolved = await resolveStorageUrlCached(fileUrl, 3600, { download: filename });
  if (resolved === fileUrl && isSupabaseStorageObjectUrl(fileUrl)) {
    throw new Error('Unable to create a signed URL for this attachment.');
  }
  const link = document.createElement('a');
  link.href = resolved;
  link.download = filename;
  link.rel = 'noopener noreferrer';
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function isSupabaseStorageObjectUrl(fileUrl: string): boolean {
  try {
    return /\/storage\/v1\/object\/(?:public|sign)\/[^/]+\/.+/.test(new URL(fileUrl).pathname);
  } catch {
    return false;
  }
}
