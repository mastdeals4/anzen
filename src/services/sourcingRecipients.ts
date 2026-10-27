import { supabase } from '../lib/supabase';

/**
 * Sourcing recipients are managed in sourcing_email_recipients.
 */

export type SourcingRoute = 'india' | 'china' | 'local';

export interface RouteRecipients {
  route: SourcingRoute;
  to: string[];
  cc: string[];
  bcc: string[];
}

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(value: string): boolean {
  return EMAIL_RE.test(value.trim());
}

export function recipientConfigurationError(route: SourcingRoute): string {
  const routeLabel = route.charAt(0).toUpperCase() + route.slice(1);
  return `${routeLabel} sourcing recipients are not configured. Ask an admin or manager to configure them in Sourcing Outbox.`;
}

export const DEFAULT_INDIA_TO = [
  'sonal@shubham.co.in',
  'jayesh.shirke@shubham.co.in',
  'aanvi@anzen.co.in',
  'devansh@shubham.co.in',
];

function emptyRecipients(route: SourcingRoute): RouteRecipients {
  if (route === 'india') {
    return { route: 'india', to: [...DEFAULT_INDIA_TO], cc: [], bcc: [] };
  }
  return { route, to: [], cc: [], bcc: [] };
}

export async function loadAllRouteRecipients(): Promise<Record<SourcingRoute, RouteRecipients>> {
  const blank: Record<SourcingRoute, RouteRecipients> = {
    india: emptyRecipients('india'),
    china: emptyRecipients('china'),
    local: emptyRecipients('local'),
  };
  try {
    const { data, error } = await supabase
      .from('sourcing_email_recipients')
      .select('route,to_emails,cc_emails,bcc_emails');
    if (error || !data) return blank;
    for (const r of data as Array<{ route: SourcingRoute; to_emails: string[] | null; cc_emails: string[] | null; bcc_emails: string[] | null }>) {
      if (r.route === 'india' || r.route === 'china' || r.route === 'local') {
        const toList = (r.to_emails || []).filter(isValidEmail);
        if (r.route === 'india') {
          for (const email of DEFAULT_INDIA_TO) {
            if (!toList.some(e => e.toLowerCase() === email.toLowerCase())) {
              toList.push(email);
            }
          }
        }
        blank[r.route] = {
          route: r.route,
          to: toList,
          cc: (r.cc_emails || []).filter(isValidEmail),
          bcc: (r.bcc_emails || []).filter(isValidEmail),
        };
      }
    }
    return blank;
  } catch {
    return blank;
  }
}

export async function saveRouteRecipients(rec: RouteRecipients, actorId: string | null = null): Promise<{ ok: boolean; error?: string }> {
  try {
    const { error } = await supabase
      .from('sourcing_email_recipients')
      .upsert({
        route: rec.route,
        to_emails: rec.to.filter(isValidEmail),
        cc_emails: rec.cc.filter(isValidEmail),
        bcc_emails: rec.bcc.filter(isValidEmail),
        updated_by: actorId,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'route' });
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Save failed' };
  }
}
