import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error('Missing Supabase environment variables');
}

/**
 * Browsers can keep a tab alive while its network connection goes stale.
 * Supabase normally retries auth refreshes, but an individual data request
 * can still fail on the first click after the tab becomes active again. A
 * single bounded retry lets that request recover without reloading the app
 * or creating duplicate writes.
 */
const resilientFetch: typeof fetch = async (input, init) => {
  const method = (init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
  // Never retry writes: a second POST could duplicate a voucher or RPC call.
  if (method !== 'GET' && method !== 'HEAD') return fetch(input, init);
  try {
    const response = await fetch(input, init);
    if (response.ok || ![408, 425, 429, 500, 502, 503, 504].includes(response.status)) {
      return response;
    }
    await new Promise(resolve => window.setTimeout(resolve, 350));
    return fetch(input, init);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    await new Promise(resolve => window.setTimeout(resolve, 350));
    return fetch(input, init);
  }
};

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  global: { fetch: resilientFetch },
});

export type UserRole = 'admin' | 'manager' | 'accounts' | 'sales' | 'warehouse' | 'auditor_ca';

export interface UserProfile {
  id: string;
  email: string;
  username: string;
  full_name: string;
  role: UserRole;
  language: 'en' | 'id';
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface Database {
  user_profiles: UserProfile;
}
