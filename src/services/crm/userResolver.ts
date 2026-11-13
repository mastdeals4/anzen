import { supabase } from '../../lib/supabase';

export interface UserProfileEntry {
  id: string;
  full_name: string | null;
  email: string | null;
  role: string | null;
  displayLabel: string;
}

// In-memory cache for fast lookups
let cachedProfiles: UserProfileEntry[] | null = null;
let profileMapCache: Map<string, UserProfileEntry> | null = null;
let pendingPromise: Promise<UserProfileEntry[]> | null = null;

function formatRole(role?: string | null): string {
  if (!role) return '';
  if (role.toLowerCase() === 'auditor_ca') return 'Auditor';
  return role.charAt(0).toUpperCase() + role.slice(1);
}

export function formatUserDisplay(profile: { full_name?: string | null; email?: string | null; role?: string | null }): string {
  const name = profile.full_name?.trim();
  const roleStr = formatRole(profile.role);
  if (name) {
    return roleStr ? `${name} (${roleStr})` : name;
  }
  if (profile.email) {
    return roleStr ? `${profile.email} (${roleStr})` : profile.email;
  }
  return 'Unknown User';
}

export async function fetchUserProfiles(forceRefresh = false): Promise<UserProfileEntry[]> {
  if (!forceRefresh && cachedProfiles) {
    return cachedProfiles;
  }

  if (!forceRefresh && pendingPromise) {
    return pendingPromise;
  }

  pendingPromise = (async () => {
    try {
      const { data, error } = await supabase
        .from('user_profiles')
        .select('id, full_name, email, role');

      if (error) {
        console.warn('Failed to load user_profiles for audit display:', error.message);
        return cachedProfiles || [];
      }

      const list: UserProfileEntry[] = (data || []).map(p => ({
        id: p.id,
        full_name: p.full_name,
        email: p.email,
        role: p.role,
        displayLabel: formatUserDisplay(p),
      }));

      cachedProfiles = list;
      profileMapCache = new Map(list.map(p => [p.id, p]));
      return list;
    } finally {
      pendingPromise = null;
    }
  })();

  return pendingPromise;
}

export async function getUserDisplayMap(): Promise<Map<string, string>> {
  const profiles = await fetchUserProfiles();
  const map = new Map<string, string>();
  profiles.forEach(p => {
    map.set(p.id, p.displayLabel);
  });
  return map;
}

export function resolveUserDisplayName(userId?: string | null, map?: Map<string, string>): string {
  if (!userId) return '—';
  if (map && map.has(userId)) {
    return map.get(userId)!;
  }
  if (profileMapCache && profileMapCache.has(userId)) {
    return profileMapCache.get(userId)!.displayLabel;
  }
  // Return shortened UUID fallback only while loading or if user was deleted
  return `User (${userId.slice(0, 8)})`;
}

