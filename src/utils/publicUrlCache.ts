import { supabase } from '../lib/supabase';

// Public bucket URLs are permanent — Supabase Cached Egress meters CDN pulls.
// Memoize the resolved URL per (bucket,path) so we don't ask the SDK repeatedly.
const cache = new Map<string, string>();

export function getPublicUrlCached(bucket: string, path: string): string {
  if (!path) return '';
  const key = `${bucket}::${path}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const { data } = supabase.storage.from(bucket).getPublicUrl(path);
  cache.set(key, data.publicUrl);
  return data.publicUrl;
}
