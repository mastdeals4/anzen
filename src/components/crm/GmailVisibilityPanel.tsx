import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import {
  Mail, RefreshCw, AlertCircle, CheckCircle2, Send, Clock, FileText, Inbox,
} from 'lucide-react';

/**
 * Gmail Visibility / Sync Monitor
 *
 * A read-only status panel for Settings → Gmail. Shows:
 *   - Connected Gmail address + connected user
 *   - Last sync / last send / last reminder / last quote times
 *   - Sender mode in effect (own Gmail vs. company fallback)
 *   - Last error if recorded
 *   - Recent 10 email actions across pricing + CRM tables
 *
 * Pulls only from existing tables — no new schema needed:
 *   gmail_connections, email_thread_map, communication_timeline,
 *   crm_email_activities (if present)
 *
 * The AI parser is NOT built yet; this panel shows that fact clearly.
 */

interface ConnectionRow {
  id: string;
  user_id: string;
  email_address: string;
  is_connected: boolean;
  last_sync: string | null;
  sync_enabled: boolean;
  access_token_expires_at: string | null;
}

interface ActivityRow {
  ts: string;
  source: 'pricing' | 'crm' | 'thread';
  event: string;
  description: string;
  metaSender?: string | null;
}

const EVENT_LABEL: Record<string, { label: string; icon: React.ElementType; color: string }> = {
  sourcing_request_sent: { label: 'Sent sourcing', icon: Mail,    color: 'text-blue-600' },
  reminder_sent:         { label: 'Sent reminder', icon: Clock,   color: 'text-amber-600' },
  reminder_prepared:     { label: 'Reminder draft', icon: Clock,  color: 'text-amber-600' },
  customer_quote_sent:   { label: 'Sent quote',    icon: Send,    color: 'text-green-600' },
  customer_quote_prepared:{ label: 'Quote draft',  icon: FileText, color: 'text-green-600' },
  source_reply_updated:  { label: 'Source reply updated', icon: Inbox, color: 'text-purple-600' },
  email_sent:            { label: 'Email sent',    icon: Mail,    color: 'text-blue-600' },
  email_received:        { label: 'Email received', icon: Inbox,  color: 'text-gray-600' },
};

function fmtAgo(iso: string | null | undefined): string {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return 'just now';
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} h ago`;
  const days = Math.floor(hr / 24);
  return `${days} d ago`;
}

export function GmailVisibilityPanel() {
  const [connection, setConnection] = useState<ConnectionRow | null>(null);
  const [connectedUserName, setConnectedUserName] = useState<string>('');
  const [lastSend, setLastSend] = useState<{ event: string; ts: string; meta: any } | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [recent, setRecent] = useState<ActivityRow[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setLastError(null);

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      setLoading(false);
      return;
    }

    // 1. Current user's connection (limited columns — never select tokens)
    const { data: conn } = await supabase
      .from('gmail_connections')
      .select('id,user_id,email_address,is_connected,last_sync,sync_enabled,access_token_expires_at')
      .eq('user_id', user.id)
      .eq('is_connected', true)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    setConnection(conn as ConnectionRow | null);

    if (conn) {
      const { data: prof } = await supabase
        .from('user_profiles')
        .select('full_name,username')
        .eq('id', conn.user_id)
        .maybeSingle();
      setConnectedUserName(prof?.full_name || prof?.username || '');
    }

    // 2. Recent activity — pricing + CRM in parallel, normalised
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const [pricing, crm, threads] = await Promise.allSettled([
      supabase.from('communication_timeline')
        .select('created_at,event_type,description,metadata')
        .gte('created_at', since)
        .in('event_type', ['sourcing_request_sent','reminder_sent','reminder_prepared','customer_quote_sent','customer_quote_prepared','source_reply_updated'])
        .order('created_at', { ascending: false })
        .limit(20),
      supabase.from('crm_inquiry_timeline')
        .select('created_at,event_type,event_title,event_description')
        .gte('created_at', since)
        .in('event_type', ['sourcing_request_sent','reminder_sent','customer_quote_sent','email_sent','email_received'])
        .order('created_at', { ascending: false })
        .limit(20),
      supabase.from('email_thread_map')
        .select('created_at,direction,subject,gmail_message_id')
        .gte('created_at', since)
        .order('created_at', { ascending: false })
        .limit(10),
    ]);

    const rows: ActivityRow[] = [];
    if (pricing.status === 'fulfilled' && !pricing.value.error && pricing.value.data) {
      for (const r of pricing.value.data as Array<{ created_at: string; event_type: string; description: string; metadata: any }>) {
        rows.push({
          ts: r.created_at,
          source: 'pricing',
          event: r.event_type,
          description: r.description,
          metaSender: r.metadata?.sender_mode || null,
        });
      }
    }
    if (crm.status === 'fulfilled' && !crm.value.error && crm.value.data) {
      for (const r of crm.value.data as Array<{ created_at: string; event_type: string; event_title: string | null; event_description: string | null }>) {
        rows.push({
          ts: r.created_at,
          source: 'crm',
          event: r.event_type,
          description: r.event_description || r.event_title || r.event_type,
        });
      }
    }
    if (threads.status === 'fulfilled' && !threads.value.error && threads.value.data) {
      for (const r of threads.value.data as Array<{ created_at: string; direction: string; subject: string; gmail_message_id: string | null }>) {
        rows.push({
          ts: r.created_at,
          source: 'thread',
          event: r.direction === 'outbound_customer' ? 'customer_quote_sent'
               : r.direction === 'outbound_reminder' ? 'reminder_sent'
               : r.direction === 'outbound'          ? 'sourcing_request_sent'
               : 'email_sent',
          description: r.subject || '(no subject)',
        });
      }
    }
    rows.sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());
    const dedup = rows.slice(0, 10);
    setRecent(dedup);

    if (dedup.length > 0) {
      setLastSend({ event: dedup[0].event, ts: dedup[0].ts, meta: dedup[0].metaSender });
    } else {
      setLastSend(null);
    }

    // 3. Detect a recent error (best-effort — looks for failure markers in description)
    const err = rows.find(r => /fail|error/i.test(r.description));
    if (err) setLastError(err.description);

    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Mail className="w-4 h-4 text-blue-600" />
          <h3 className="text-sm font-semibold text-gray-800">Gmail Status & Sync Monitor</h3>
        </div>
        <button onClick={load} disabled={loading}
          className="flex items-center gap-1.5 px-2 py-1 text-[11px] border border-gray-200 rounded hover:bg-gray-50 disabled:opacity-50">
          <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} /> Refresh
        </button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <div className="border border-gray-200 rounded px-2.5 py-1.5">
          <p className="text-[10px] uppercase text-gray-500">Connected Gmail</p>
          <p className="text-xs font-medium text-gray-800 truncate" title={connection?.email_address || ''}>
            {connection?.email_address || <span className="text-gray-400">Not connected</span>}
          </p>
        </div>
        <div className="border border-gray-200 rounded px-2.5 py-1.5">
          <p className="text-[10px] uppercase text-gray-500">Connected User</p>
          <p className="text-xs font-medium text-gray-800 truncate">
            {connectedUserName || <span className="text-gray-400">—</span>}
          </p>
        </div>
        <div className="border border-gray-200 rounded px-2.5 py-1.5">
          <p className="text-[10px] uppercase text-gray-500">Last Sync</p>
          <p className="text-xs font-medium text-gray-800">{fmtAgo(connection?.last_sync)}</p>
        </div>
        <div className="border border-gray-200 rounded px-2.5 py-1.5">
          <p className="text-[10px] uppercase text-gray-500">Last Send</p>
          <p className="text-xs font-medium text-gray-800">{fmtAgo(lastSend?.ts)}</p>
        </div>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium ${connection ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-700'}`}>
          {connection ? <CheckCircle2 className="w-3 h-3" /> : <AlertCircle className="w-3 h-3" />}
          Sender mode: {connection ? 'Connected Gmail (your account)' : 'Company fallback sender'}
        </span>
        {connection?.access_token_expires_at && (
          <span className="text-[10px] text-gray-500">
            Token refreshes automatically · current expiry {fmtAgo(connection.access_token_expires_at).replace(' ago', '')}
          </span>
        )}
      </div>

      {lastError && (
        <div className="text-[11px] text-red-700 bg-red-50 border border-red-200 rounded px-2.5 py-1.5">
          Last error: {lastError}
        </div>
      )}

      <div>
        <p className="text-[11px] uppercase tracking-wide text-gray-500 font-semibold mb-1">Recent email actions</p>
        {loading ? (
          <p className="text-xs text-gray-400 py-2">Loading…</p>
        ) : recent.length === 0 ? (
          <p className="text-xs text-gray-500 py-2">No recent email activity in the last 30 days.</p>
        ) : (
          <ul className="divide-y divide-gray-100 border border-gray-100 rounded">
            {recent.map((r, i) => {
              const meta = EVENT_LABEL[r.event] || { label: r.event, icon: Mail, color: 'text-gray-500' };
              const Icon = meta.icon;
              return (
                <li key={i} className="flex items-start gap-2 px-2.5 py-1.5">
                  <Icon className={`w-3.5 h-3.5 mt-0.5 ${meta.color}`} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 text-[11px]">
                      <span className="font-medium text-gray-800">{meta.label}</span>
                      <span className="text-gray-400">·</span>
                      <span className="text-gray-500">{fmtAgo(r.ts)}</span>
                      {r.metaSender && (
                        <span className={`px-1.5 py-0.5 rounded text-[10px] ${r.metaSender === 'fallback' ? 'bg-amber-100 text-amber-700' : 'bg-green-100 text-green-700'}`}>
                          {r.metaSender === 'fallback' ? 'fallback' : 'own gmail'}
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] text-gray-600 truncate" title={r.description}>{r.description}</p>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="text-[11px] text-gray-500 bg-gray-50 border border-gray-200 rounded px-2.5 py-1.5 flex items-start gap-2">
        <AlertCircle className="w-3 h-3 mt-0.5 text-gray-400" />
        <span>India reply parser not connected yet. Source replies must be entered manually via Pricing Worksheet for now. Once the parser is wired, parsed replies will show as "extraction attempts" in this panel.</span>
      </div>
    </div>
  );
}
