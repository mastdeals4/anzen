import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error('Missing Supabase environment variables');
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

export type UserRole = 'admin' | 'accounts' | 'sales' | 'warehouse';

export interface UserProfile {
  id: string;
  email: string;
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
