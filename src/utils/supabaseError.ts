// Supabase PostgrestError is a plain object, not an Error instance,
// so `String(err)` returns "[object Object]" and
// `err instanceof Error ? err.message : String(err)` also falls through
// to "[object Object]". Use this helper to always surface the real
// message + code + details + hint from the server.
export function supabaseErrorMessage(err: unknown): string {
  if (!err) return 'Unknown error';
  if (typeof err === 'string') return err;
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === 'object') {
    const e = err as {
      message?: string;
      details?: string;
      hint?: string;
      code?: string;
    };
    const parts = [e.message, e.details, e.hint].filter(
      (p): p is string => typeof p === 'string' && p.length > 0,
    );
    if (parts.length) return e.code ? `${parts.join(' — ')} (${e.code})` : parts.join(' — ');
    try {
      const s = JSON.stringify(err);
      if (s && s !== '{}') return s;
    } catch {
      // fall through
    }
  }
  return String(err);
}
