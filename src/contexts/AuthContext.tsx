import React, { createContext, useContext, useEffect, useState } from 'react';
import { User } from '@supabase/supabase-js';
import { supabase, UserProfile } from '../lib/supabase';
import { resolveAccessibleModules } from '../utils/permissions';

interface AuthContextType {
  user: User | null;
  profile: UserProfile | null;
  accessibleModules: Set<string>;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string, fullName: string, role: string) => Promise<void>;
  signOut: () => Promise<void>;
  refreshPermissions: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

function isSupabaseAuthStorageKey(key: string) {
  return (key.startsWith('sb-') && key.endsWith('-auth-token')) || key.includes('supabase.auth.token');
}

function getStorageKeys(storage: Storage | undefined) {
  if (!storage) return [];

  const keys: string[] = [];
  for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i);
    if (key && isSupabaseAuthStorageKey(key)) keys.push(key);
  }
  return keys;
}

function removeSupabaseAuthStorage() {
  if (typeof window === 'undefined') return { localStorageKeys: [], sessionStorageKeys: [] };

  const localStorageKeys = getStorageKeys(window.localStorage);
  const sessionStorageKeys = getStorageKeys(window.sessionStorage);

  localStorageKeys.forEach(key => window.localStorage.removeItem(key));
  sessionStorageKeys.forEach(key => window.sessionStorage.removeItem(key));

  return { localStorageKeys, sessionStorageKeys };
}

function expireSupabaseAuthCookies() {
  if (typeof document === 'undefined') return [];

  const cookieNames = document.cookie
    .split(';')
    .map(cookie => cookie.split('=')[0]?.trim())
    .filter(Boolean)
    .filter(name => name.startsWith('sb-') || name.includes('supabase'));

  const domainParts = window.location.hostname.split('.');
  const domains = domainParts.length > 1
    ? [window.location.hostname, `.${window.location.hostname}`, `.${domainParts.slice(-2).join('.')}`]
    : [window.location.hostname];

  cookieNames.forEach(name => {
    document.cookie = `${name}=; Max-Age=0; path=/; SameSite=Lax`;
    domains.forEach(domain => {
      document.cookie = `${name}=; Max-Age=0; path=/; domain=${domain}; SameSite=Lax`;
    });
  });

  return cookieNames;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [accessibleModules, setAccessibleModules] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setUser(session?.user ?? null);
      if (session?.user) {
        loadProfileAndPermissions(session.user.id);
      } else {
        setLoading(false);
      }
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
      if (session?.user) {
        loadProfileAndPermissions(session.user.id);
      } else {
        setProfile(null);
        setAccessibleModules(new Set());
        setLoading(false);
      }
    });

    // Re-check/refresh a session when a suspended tab becomes active again.
    // Supabase's own auto-refresh remains authoritative; this only nudges it
    // after a long browser suspension so the first user action is not made
    // against an expired access token.
    const recoverSession = async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return;
      const expiresAt = session.expires_at ?? 0;
      if (expiresAt && expiresAt * 1000 - Date.now() < 60_000) {
        await supabase.auth.refreshSession();
      }
    };
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') void recoverSession();
    };
    window.addEventListener('online', recoverSession);
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      subscription.unsubscribe();
      window.removeEventListener('online', recoverSession);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, []);

  const loadProfileAndPermissions = async (userId: string) => {
    try {
      const [profileResult, permissionsResult] = await Promise.all([
        supabase.from('user_profiles').select('*').eq('id', userId).maybeSingle(),
        supabase.from('user_permissions').select('module, can_access').eq('user_id', userId),
      ]);

      if (profileResult.error) throw profileResult.error;

      const profileData = profileResult.data as UserProfile | null;
      setProfile(profileData);

      if (profileData) {
        const modules = resolveAccessibleModules(
          profileData.role,
          permissionsResult.data ?? null
        );
        setAccessibleModules(modules);
      }
    } catch (error) {
      console.error('Error loading profile:', error);
    } finally {
      setLoading(false);
    }
  };

  const refreshPermissions = async () => {
    if (!user) return;
    await loadProfileAndPermissions(user.id);
  };

  const signIn = async (usernameOrEmail: string, password: string) => {
    let email = usernameOrEmail;

    if (!usernameOrEmail.includes('@')) {
      const { data, error } = await supabase
        .rpc('lookup_login_email', { p_username: usernameOrEmail.toLowerCase() })
        .maybeSingle<{ email: string; is_active: boolean }>();

      if (error || !data) throw new Error('Invalid username or password');
      if (!data.is_active) throw new Error('Account is inactive. Please contact administrator.');
      email = data.email;
    }

    const { data: signInData, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;

    if (signInData.user) {
      const { data: profileRow } = await supabase
        .from('user_profiles')
        .select('is_active')
        .eq('id', signInData.user.id)
        .maybeSingle<{ is_active: boolean }>();
      if (!profileRow || profileRow.is_active === false) {
        await supabase.auth.signOut();
        throw new Error('Account is inactive. Please contact administrator.');
      }
    }
  };

  const signUp = async (email: string, password: string, fullName: string, role: string) => {
    const { data, error } = await supabase.auth.signUp({ email, password });
    if (error) throw error;

    if (data.user) {
      const { error: profileError } = await supabase
        .from('user_profiles')
        .insert({
          id: data.user.id,
          email,
          full_name: fullName,
          role,
          language: 'en',
          is_active: true,
        });

      if (profileError) throw profileError;
    }
  };

  const clearAuthState = () => {
    setUser(null);
    setProfile(null);
    setAccessibleModules(new Set());
    setLoading(false);
  };

  const signOut = async () => {
    setLoading(true);

    try {
      const signOutResponse = await supabase.auth.signOut({ scope: 'global' });

      if (signOutResponse.error) {
        await supabase.auth.signOut({ scope: 'local' });
      }

      removeSupabaseAuthStorage();
      expireSupabaseAuthCookies();

      const afterSession = await supabase.auth.getSession();

      if (afterSession.data.session) {
        throw new Error('Logout failed: Supabase session still exists after signOut.');
      }

      clearAuthState();
    } catch {
      clearAuthState();
    }
  };

  return (
    <AuthContext.Provider value={{ user, profile, accessibleModules, loading, signIn, signUp, signOut, refreshPermissions }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
