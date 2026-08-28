/**
 * SalesDashboard — CRM Action Center for sales role.
 *
 * Sections (in priority order):
 * Daily priority: overdue, today, customer replies, quote ready, then delivery.
 *  5. Delivery Alerts (compact, lower priority)
 *  6. Quick Links
 *
 * SAFETY: purchase_price (Kunal's landed cost) is never selected or displayed.
 * Only offered_price (the quote price sent to customers) is shown.
 *
 * Tables used: crm_inquiries, crm_reminders, sales_orders
 */
import { useEffect, useRef, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../contexts/AuthContext';
import { useNavigation } from '../../contexts/NavigationContext';
import {
  fetchSalesOrderDeliveryAlerts,
  summarizeDeliveryAlerts,
  type SalesOrderDeliveryAlert,
} from '../../utils/salesOrderDeliveryAlerts';
import {
  AlertCircle,
  AlertTriangle,
  ArrowRight,
  CalendarClock,
  CheckCircle2,
  ChevronRight,
  Clock,
  FileText,
  Inbox,
  Mail,
  MessageSquare,
  Phone,
  RefreshCw,
  Send,
  Users,
  Zap,
} from 'lucide-react';
import { getRandomFallbackQuote, type Quote } from '../Layout';
import { Sparkles } from 'lucide-react';

// ─── Types ────────────────────────────────────────────────────────────────────

interface PriceReadyRow {
  id: string;
  inquiry_number: string;
  company_name: string;
  product_name: string;
  specification: string | null;
  offered_price: number | null;
  offered_price_currency: string | null;
  kunal_price_status: string | null;
  source_status: string | null;
  quote_status: string | null;
  quote_sent_at: string | null;
  pipeline_status: string | null;
  price_ready: boolean | null;
  created_at: string;
}

interface FollowUpRow {
  id: string;
  title: string;
  due_date: string;
  reminder_type: string;
  inquiry_id: string | null;
  crm_inquiries: { inquiry_number: string; company_name: string } | null;
}

interface PendingReplyRow {
  id: string;
  inquiry_number: string;
  company_name: string;
  product_name: string;
  quote_sent_at: string;
  pipeline_status: string | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const EXCLUDED_STATUSES = new Set(['won', 'lost', 'closed']);
const activeOnly = <T extends { pipeline_status: string | null }>(rows: T[]): T[] =>
  rows.filter(r => !r.pipeline_status || !EXCLUDED_STATUSES.has(r.pipeline_status));

const daysSince = (dateStr: string) =>
  Math.floor((Date.now() - new Date(dateStr).getTime()) / 86_400_000);

const ageLabel = (days: number): { label: string; cls: string } => {
  if (days >= 15) return { label: `${days}d — urgent`, cls: 'text-red-600 bg-red-50' };
  if (days >= 7) return { label: `${days}d — follow up`, cls: 'text-orange-600 bg-orange-50' };
  return { label: `${days}d`, cls: 'text-yellow-700 bg-yellow-50' };
};

const fmtPrice = (price: number | null, currency: string | null) => {
  if (!price) return null;
  return `${currency || 'USD'} ${price.toLocaleString()}`;
};

const fmtTime = (d: Date) =>
  d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

const reminderIcon = (type: string) => {
  if (type === 'send_price') return Send;
  if (type === 'follow_up') return Phone;
  if (type === 'send_coa' || type === 'send_sample') return FileText;
  return CalendarClock;
};

const priceSourceLabel = (row: PriceReadyRow): string => {
  if (row.offered_price != null) return 'Quote price set';
  if (row.kunal_price_status === 'entered') return 'Kunal price entered';
  if (row.price_ready) return 'Price marked ready';
  if (row.source_status === 'received') return 'Source price received';
  return 'Price ready';
};

// ─── Component ────────────────────────────────────────────────────────────────

export function SalesDashboard() {
  const { profile } = useAuth();
  const { setCurrentPage, setNavigationData } = useNavigation();

  const [priceReady, setPriceReady] = useState<PriceReadyRow[]>([]);
  const [overdueFollowUps, setOverdueFollowUps] = useState<FollowUpRow[]>([]);
  const [todayReminders, setTodayReminders] = useState<FollowUpRow[]>([]);
  const [pendingReplies, setPendingReplies] = useState<PendingReplyRow[]>([]);
  const [deliveryAlerts, setDeliveryAlerts] = useState<SalesOrderDeliveryAlert[]>([]);
  const [initialLoading, setInitialLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);
  const [quote] = useState<Quote>(() => getRandomFallbackQuote());

  // section refs for scroll-to
  const priceRef = useRef<HTMLDivElement>(null);
  const followRef = useRef<HTMLDivElement>(null);
  const replyRef = useRef<HTMLDivElement>(null);
  const todayRef = useRef<HTMLDivElement>(null);
  const alertRef = useRef<HTMLDivElement>(null);

  useEffect(() => { load(true); }, []);

  const load = async (initial = false) => {
    if (initial) setInitialLoading(true); else setRefreshing(true);
    try {
      const now = new Date();
      const todayStart = new Date(now); todayStart.setHours(0, 0, 0, 0);
      const tomorrowStart = new Date(todayStart); tomorrowStart.setDate(tomorrowStart.getDate() + 1);
      const threeDaysAgo = new Date(now.getTime() - 3 * 86_400_000).toISOString();

      const [priceRes, overdueRes, todayRes, replyRes, alerts] = await Promise.all([
        // Price ready — offered_price set OR kunal price entered OR price_ready flag.
        // SAFETY: purchase_price is deliberately excluded from select.
        supabase.from('crm_inquiries')
          .select('id,inquiry_number,company_name,product_name,specification,offered_price,offered_price_currency,kunal_price_status,source_status,quote_status,quote_sent_at,pipeline_status,price_ready,created_at')
          .or('offered_price.not.is.null,kunal_price_status.eq.entered,price_ready.eq.true')
          .is('quote_sent_at', null)
          .neq('quote_status', 'sent')
          .order('created_at', { ascending: false })
          .limit(50),

        // Overdue reminders (due before today)
        supabase.from('crm_reminders')
          .select('id,title,due_date,reminder_type,inquiry_id,crm_inquiries(inquiry_number,company_name)')
          .eq('is_completed', false)
          .lt('due_date', todayStart.toISOString())
          .order('due_date', { ascending: true })
          .limit(20),

        // Today's reminders
        supabase.from('crm_reminders')
          .select('id,title,due_date,reminder_type,inquiry_id,crm_inquiries(inquiry_number,company_name)')
          .eq('is_completed', false)
          .gte('due_date', todayStart.toISOString())
          .lt('due_date', tomorrowStart.toISOString())
          .order('due_date', { ascending: true })
          .limit(10),

        // Pending customer replies — quote sent 3+ days ago, deal still open
        supabase.from('crm_inquiries')
          .select('id,inquiry_number,company_name,product_name,quote_sent_at,pipeline_status')
          .eq('quote_status', 'sent')
          .lt('quote_sent_at', threeDaysAgo)
          .not('quote_sent_at', 'is', null)
          .order('quote_sent_at', { ascending: true })
          .limit(30),

        fetchSalesOrderDeliveryAlerts(),
      ]);

      setPriceReady(activeOnly((priceRes.data || []) as PriceReadyRow[]));
      setOverdueFollowUps((overdueRes.data || []) as unknown as FollowUpRow[]);
      setTodayReminders((todayRes.data || []) as unknown as FollowUpRow[]);
      setPendingReplies(activeOnly((replyRes.data || []) as PendingReplyRow[]));
      setDeliveryAlerts(alerts);
      setLastRefreshed(new Date());
    } catch (err) {
      console.error('[SalesDashboard] load error', err);
    } finally {
      setInitialLoading(false);
      setRefreshing(false);
    }
  };

  const goToInquiry = (id: string) => {
    setNavigationData({ crmInquiryId: id });
    setCurrentPage('crm');
  };

  const completeReminder = async (id: string) => {
    await supabase.from('crm_reminders')
      .update({ is_completed: true, completed_at: new Date().toISOString() })
      .eq('id', id);
    setOverdueFollowUps(prev => prev.filter(r => r.id !== id));
    setTodayReminders(prev => prev.filter(r => r.id !== id));
  };

  // ── Derived counts for summary bar ──────────────────────────────────────────
  const alertSummary = summarizeDeliveryAlerts(deliveryAlerts);
  const replies3d = pendingReplies.length;
  const replies7d = pendingReplies.filter(r => daysSince(r.quote_sent_at) >= 7).length;
  const replies15d = pendingReplies.filter(r => daysSince(r.quote_sent_at) >= 15).length;

  if (initialLoading) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="bg-white rounded-xl border border-gray-100 p-4 animate-pulse h-20" />
          ))}
        </div>
        {[...Array(3)].map((_, i) => (
          <div key={i} className="bg-white rounded-xl border border-gray-100 p-4 animate-pulse h-32" />
        ))}
      </div>
    );
  }

  // ── Summary bar cards ────────────────────────────────────────────────────────
  const summaryCds = [
    {
      label: '1. Urgent / Overdue',
      value: overdueFollowUps.length,
      sub: overdueFollowUps.length > 0 ? 'Action needed' : 'All clear',
      color: overdueFollowUps.length > 0 ? 'orange' : 'green',
      ref: followRef,
      icon: Clock,
    },
    {
      label: '2. Today',
      value: todayReminders.length,
      sub: todayReminders.length ? 'Scheduled actions' : 'No reminders due',
      color: todayReminders.length ? 'blue' : 'green',
      ref: todayRef,
      icon: CalendarClock,
    },
    {
      label: '3. Customer replies',
      value: replies3d,
      sub: replies7d ? `${replies7d} over 7d` : '3d+ no response',
      color: replies15d > 0 ? 'red' : replies7d > 0 ? 'orange' : replies3d > 0 ? 'yellow' : 'green',
      ref: replyRef,
      icon: MessageSquare,
    },
    {
      label: '4. Price / quote ready',
      value: priceReady.length,
      sub: priceReady.length === 1 ? '1 inquiry' : `${priceReady.length} inquiries`,
      color: priceReady.length > 0 ? 'red' : 'green',
      ref: priceRef,
      icon: Send,
    },
    {
      label: '5. Delivery follow-up',
      value: deliveryAlerts.length,
      sub: alertSummary.overdue.length ? `${alertSummary.overdue.length} overdue` : deliveryAlerts.length > 0 ? 'Due soon' : 'All on track',
      color: alertSummary.overdue.length > 0 ? 'red' : deliveryAlerts.length > 0 ? 'yellow' : 'green',
      ref: alertRef,
      icon: AlertTriangle,
    },
  ] as const;

  const summaryColors: Record<string, { bg: string; text: string; iconBg: string }> = {
    red: { bg: 'bg-red-50 border-red-200', text: 'text-red-700', iconBg: 'bg-red-100' },
    orange: { bg: 'bg-orange-50 border-orange-200', text: 'text-orange-700', iconBg: 'bg-orange-100' },
    blue: { bg: 'bg-blue-50 border-blue-200', text: 'text-blue-700', iconBg: 'bg-blue-100' },
    yellow: { bg: 'bg-yellow-50 border-yellow-200', text: 'text-yellow-700', iconBg: 'bg-yellow-100' },
    green: { bg: 'bg-green-50 border-green-200', text: 'text-green-700', iconBg: 'bg-green-100' },
  };

  return (
    <div className="space-y-4">
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="bg-gradient-to-r from-blue-50 to-indigo-50 rounded-xl p-4 border border-blue-100">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-2xl font-bold text-gray-900">
              Welcome, {profile?.full_name || profile?.username || 'Sales'}!
            </h1>
            <div className="flex items-start gap-2 mt-1">
              <Sparkles className="w-4 h-4 text-yellow-500 flex-shrink-0 mt-0.5" />
              <p className="text-sm text-gray-600 italic">
                "{quote.content}"
                {quote.author && <span className="text-gray-500"> — {quote.author}</span>}
              </p>
            </div>
          </div>
          <button
            onClick={() => load(false)}
            disabled={refreshing}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-white border border-gray-200 rounded-lg text-xs text-gray-600 hover:bg-gray-50 transition flex-shrink-0"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
            <span>Refresh</span>
            {lastRefreshed && (
              <span className="text-gray-400">{fmtTime(lastRefreshed)}</span>
            )}
          </button>
        </div>
      </div>

      {/* ── Summary bar ────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {summaryCds.map(card => {
          const c = summaryColors[card.color];
          const Icon = card.icon;
          return (
            <button
              key={card.label}
              onClick={() => card.ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
              className={`${c.bg} border rounded-xl p-3 text-left transition hover:shadow-md`}
            >
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-medium text-gray-600">{card.label}</span>
                <div className={`${c.iconBg} p-1 rounded-lg`}>
                  <Icon className={`w-3.5 h-3.5 ${c.text}`} />
                </div>
              </div>
              <div className={`text-2xl font-bold ${c.text}`}>{card.value}</div>
              <div className="text-xs text-gray-500 mt-0.5">{card.sub}</div>
            </button>
          );
        })}
      </div>

      {/* ── Section 1: Kunal Price Ready — Send Quote ──────────────────────── */}
      <div ref={priceRef} className="bg-white rounded-xl shadow-sm border border-gray-100">
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
          <div className="flex items-center gap-2">
            <div className={`w-2 h-2 rounded-full ${priceReady.length > 0 ? 'bg-red-500 animate-pulse' : 'bg-gray-300'}`} />
            <h2 className="text-sm font-semibold text-gray-900">
              Kunal Price Ready — Send Quote
            </h2>
            <span className={`px-2 py-0.5 text-xs font-bold rounded-full ${priceReady.length > 0 ? 'bg-red-100 text-red-700' : 'bg-gray-100 text-gray-500'}`}>
              {priceReady.length}
            </span>
          </div>
          <button
            onClick={() => setCurrentPage('crm')}
            className="text-xs text-blue-600 hover:underline flex items-center gap-1"
          >
            View All Inquiries <ChevronRight className="w-3 h-3" />
          </button>
        </div>

        {priceReady.length === 0 ? (
          <div className="flex items-center gap-3 p-6 text-gray-400">
            <CheckCircle2 className="w-8 h-8 text-green-400" />
            <div>
              <p className="text-sm font-medium text-gray-600">All clear</p>
              <p className="text-xs">No quotes waiting to be sent</p>
            </div>
          </div>
        ) : (
          <div className="divide-y divide-gray-50">
            {priceReady.slice(0, 15).map(row => {
              const price = fmtPrice(row.offered_price, row.offered_price_currency);
              return (
                <div key={row.id} className="flex items-center gap-3 px-4 py-2.5 hover:bg-gray-50 transition">
                  {/* Inquiry number */}
                  <div className="w-20 flex-shrink-0">
                    <span className="text-xs font-mono font-medium text-blue-600">
                      #{row.inquiry_number}
                    </span>
                  </div>

                  {/* Company + product */}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">{row.company_name}</p>
                    <p className="text-xs text-gray-500 truncate">{row.product_name}{row.specification ? ` — ${row.specification}` : ''}</p>
                  </div>

                  {/* Price (offered_price only — safe for sales) */}
                  {price && (
                    <div className="w-28 flex-shrink-0 text-right hidden sm:block">
                      <span className="text-xs font-semibold text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded">
                        {price}
                      </span>
                    </div>
                  )}

                  {/* Source label */}
                  <div className="w-32 flex-shrink-0 hidden md:block">
                    <span className="text-xs text-gray-400">{priceSourceLabel(row)}</span>
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    <button
                      onClick={() => goToInquiry(row.id)}
                      className="flex items-center gap-1 px-2.5 py-1.5 bg-blue-600 text-white rounded-lg text-xs font-medium hover:bg-blue-700 transition"
                    >
                      <Send className="w-3 h-3" />
                      Send Quote
                    </button>
                    <button
                      onClick={() => goToInquiry(row.id)}
                      className="px-2.5 py-1.5 border border-gray-200 text-gray-600 rounded-lg text-xs hover:bg-gray-50 transition"
                    >
                      View
                    </button>
                  </div>
                </div>
              );
            })}
            {priceReady.length > 15 && (
              <div className="px-4 py-2 text-xs text-gray-400 flex items-center justify-between">
                <span>Showing 15 of {priceReady.length}</span>
                <button onClick={() => setCurrentPage('crm')} className="text-blue-600 hover:underline flex items-center gap-1">
                  View all in CRM <ChevronRight className="w-3 h-3" />
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Sections 2+3: Follow-ups + Pending Replies ─────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">

        {/* Section 2: Overdue Follow-ups */}
        <div ref={followRef} className="bg-white rounded-xl shadow-sm border border-gray-100">
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
            <div className="flex items-center gap-2">
              <Clock className={`w-4 h-4 ${overdueFollowUps.length > 0 ? 'text-orange-500' : 'text-gray-400'}`} />
              <h2 className="text-sm font-semibold text-gray-900">Follow-ups Overdue</h2>
              {overdueFollowUps.length > 0 && (
                <span className="px-2 py-0.5 text-xs font-bold bg-orange-100 text-orange-700 rounded-full">
                  {overdueFollowUps.length}
                </span>
              )}
            </div>
            <button onClick={() => setCurrentPage('crm')} className="text-xs text-blue-600 hover:underline flex items-center gap-1">
              CRM <ChevronRight className="w-3 h-3" />
            </button>
          </div>

          {overdueFollowUps.length === 0 ? (
            <div className="flex items-center gap-2 p-4 text-gray-400">
              <CheckCircle2 className="w-5 h-5 text-green-400" />
              <span className="text-sm">No overdue follow-ups</span>
            </div>
          ) : (
            <div className="divide-y divide-gray-50 max-h-64 overflow-y-auto">
              {overdueFollowUps.map(f => {
                const Icon = reminderIcon(f.reminder_type);
                const days = daysSince(f.due_date);
                return (
                  <div key={f.id} className="flex items-start gap-2 px-4 py-2.5 hover:bg-orange-50/40 transition">
                    <Icon className="w-4 h-4 text-orange-500 mt-0.5 flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-900 truncate">{f.title}</p>
                      {f.crm_inquiries && (
                        <p className="text-xs text-gray-500 truncate">
                          #{f.crm_inquiries.inquiry_number} · {f.crm_inquiries.company_name}
                        </p>
                      )}
                      <p className="text-xs text-orange-600 font-medium mt-0.5">
                        {days}d overdue
                      </p>
                    </div>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      {f.inquiry_id && (
                        <button
                          onClick={() => goToInquiry(f.inquiry_id!)}
                          className="p-1 text-blue-400 hover:text-blue-600"
                          title="View inquiry"
                        >
                          <ArrowRight className="w-3.5 h-3.5" />
                        </button>
                      )}
                      <button
                        onClick={() => completeReminder(f.id)}
                        className="p-1 text-gray-400 hover:text-green-600"
                        title="Mark complete"
                      >
                        <CheckCircle2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Section 3: Pending Customer Replies */}
        <div ref={replyRef} className="bg-white rounded-xl shadow-sm border border-gray-100">
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
            <div className="flex items-center gap-2">
              <MessageSquare className={`w-4 h-4 ${replies3d > 0 ? 'text-yellow-600' : 'text-gray-400'}`} />
              <h2 className="text-sm font-semibold text-gray-900">Pending Customer Replies</h2>
            </div>
            <div className="flex items-center gap-2 text-xs">
              <span className="px-1.5 py-0.5 bg-yellow-100 text-yellow-700 rounded font-medium">3d+ {replies3d}</span>
              <span className="px-1.5 py-0.5 bg-orange-100 text-orange-700 rounded font-medium">7d+ {replies7d}</span>
              <span className="px-1.5 py-0.5 bg-red-100 text-red-700 rounded font-medium">15d+ {replies15d}</span>
            </div>
          </div>

          {pendingReplies.length === 0 ? (
            <div className="flex items-center gap-2 p-4 text-gray-400">
              <CheckCircle2 className="w-5 h-5 text-green-400" />
              <span className="text-sm">No quotes awaiting reply</span>
            </div>
          ) : (
            <div className="divide-y divide-gray-50 max-h-64 overflow-y-auto">
              {pendingReplies.map(r => {
                const days = daysSince(r.quote_sent_at);
                const age = ageLabel(days);
                return (
                  <div key={r.id} className="flex items-center gap-3 px-4 py-2.5 hover:bg-gray-50 transition">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-mono text-blue-600">#{r.inquiry_number}</span>
                        <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${age.cls}`}>{age.label}</span>
                      </div>
                      <p className="text-sm font-medium text-gray-900 truncate">{r.company_name}</p>
                      <p className="text-xs text-gray-400 truncate">{r.product_name}</p>
                    </div>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      <button
                        onClick={() => goToInquiry(r.id)}
                        className="flex items-center gap-1 px-2.5 py-1.5 border border-gray-200 text-gray-600 rounded-lg text-xs hover:bg-gray-50 transition"
                      >
                        <Mail className="w-3 h-3" />
                        Follow Up
                      </button>
                      <button
                        onClick={() => goToInquiry(r.id)}
                        className="p-1.5 text-gray-400 hover:text-blue-600 border border-gray-200 rounded-lg"
                        title="View email trail"
                      >
                        <ArrowRight className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* ── Sections 4+5: Today's Reminders + Quick Links ──────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">

        {/* Section 4: Today's Actions */}
        <div ref={todayRef} className="bg-white rounded-xl shadow-sm border border-gray-100">
          <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-100">
            <CalendarClock className="w-4 h-4 text-blue-500" />
            <h2 className="text-sm font-semibold text-gray-900">Today's Actions</h2>
            {todayReminders.length > 0 && (
              <span className="px-2 py-0.5 text-xs font-bold bg-blue-100 text-blue-700 rounded-full">
                {todayReminders.length}
              </span>
            )}
          </div>

          <div className="p-3 space-y-1.5">
            {todayReminders.length === 0 && overdueFollowUps.length === 0 ? (
              <div className="flex items-center gap-2 py-3 text-gray-400">
                <CheckCircle2 className="w-5 h-5 text-green-400" />
                <span className="text-sm">No reminders for today</span>
              </div>
            ) : null}

            {todayReminders.map(f => {
              const Icon = reminderIcon(f.reminder_type);
              return (
                <div key={f.id} className="flex items-start gap-2 p-2 bg-blue-50 border border-blue-100 rounded-lg">
                  <Icon className="w-4 h-4 text-blue-600 mt-0.5 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">{f.title}</p>
                    {f.crm_inquiries && (
                      <p className="text-xs text-gray-500 truncate">
                        #{f.crm_inquiries.inquiry_number} · {f.crm_inquiries.company_name}
                      </p>
                    )}
                    <p className="text-xs text-blue-600 mt-0.5">
                      {new Date(f.due_date).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
                    </p>
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    {f.inquiry_id && (
                      <button onClick={() => goToInquiry(f.inquiry_id!)} className="p-1 text-blue-400 hover:text-blue-600" title="Open inquiry">
                        <ArrowRight className="w-3.5 h-3.5" />
                      </button>
                    )}
                    <button onClick={() => completeReminder(f.id)} className="p-1 text-gray-400 hover:text-green-600" title="Mark done">
                      <CheckCircle2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              );
            })}

            {/* Quick action shortcuts */}
            <div className="pt-2 border-t border-gray-100 space-y-1">
              {[
                { label: 'Send price quote', icon: Send, page: 'crm' },
                { label: 'Follow up on quote', icon: Mail, page: 'crm' },
                { label: 'New inquiry', icon: FileText, page: 'crm' },
                { label: 'Sales Orders', icon: FileText, page: 'sales-orders' },
                { label: 'Delivery Log', icon: Inbox, page: 'crm' },
              ].map(action => {
                const Icon = action.icon;
                return (
                  <button
                    key={action.label}
                    onClick={() => setCurrentPage(action.page)}
                    className="w-full flex items-center justify-between p-2 text-gray-600 hover:bg-gray-50 rounded-lg transition text-xs"
                  >
                    <div className="flex items-center gap-2">
                      <Icon className="w-3.5 h-3.5 text-gray-400" />
                      <span>{action.label}</span>
                    </div>
                    <ChevronRight className="w-3 h-3 text-gray-300" />
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* Section 5: Quick Links */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-100">
          <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-100">
            <Zap className="w-4 h-4 text-yellow-500" />
            <h2 className="text-sm font-semibold text-gray-900">Quick Links</h2>
          </div>
          <div className="p-3 space-y-1.5">
            {([
              { label: 'Command Center', sub: 'Email, inquiries, actions', icon: Zap, page: 'command-center', color: 'bg-blue-50 hover:bg-blue-100 text-blue-700' },
              { label: 'Kunal Price Queue', sub: 'Pricing worksheet', icon: FileText, page: 'pricing-worksheet', color: 'bg-purple-50 hover:bg-purple-100 text-purple-700' },
              { label: 'Email Inbox', sub: 'Gmail-linked inbox', icon: Mail, page: 'crm', color: 'bg-gray-50 hover:bg-gray-100 text-gray-700' },
              { label: 'Delivery Log', sub: 'Track sent emails', icon: Inbox, page: 'crm', color: 'bg-gray-50 hover:bg-gray-100 text-gray-700' },
              { label: 'New Inquiry', sub: 'Add customer inquiry', icon: FileText, page: 'crm', color: 'bg-gray-50 hover:bg-gray-100 text-gray-700' },
              { label: 'Customers', sub: 'Customer database', icon: Users, page: 'customers', color: 'bg-gray-50 hover:bg-gray-100 text-gray-700' },
              { label: 'Sales Orders', sub: 'View & manage SOs', icon: FileText, page: 'sales-orders', color: 'bg-gray-50 hover:bg-gray-100 text-gray-700' },
            ] as const).map(link => {
              const Icon = link.icon;
              return (
                <button
                  key={link.label}
                  onClick={() => setCurrentPage(link.page)}
                  className={`w-full flex items-center justify-between p-2.5 ${link.color} rounded-lg transition group`}
                >
                  <div className="flex items-center gap-2.5">
                    <Icon className="w-4 h-4 flex-shrink-0" />
                    <div className="text-left">
                      <div className="text-sm font-medium">{link.label}</div>
                      <div className="text-xs opacity-70">{link.sub}</div>
                    </div>
                  </div>
                  <ArrowRight className="w-3.5 h-3.5 opacity-0 group-hover:opacity-100 transition-opacity" />
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* ── Section 6: Delivery Alerts (compact, lower priority) ───────────── */}
      {deliveryAlerts.length > 0 && (
        <div ref={alertRef} className="bg-white rounded-xl shadow-sm border border-gray-100">
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
            <div className="flex items-center gap-2">
              <AlertTriangle className={`w-4 h-4 ${alertSummary.overdue.length ? 'text-red-500' : 'text-yellow-500'}`} />
              <h2 className="text-sm font-semibold text-gray-900">Delivery Alerts</h2>
              <span className={`px-2 py-0.5 text-xs font-bold rounded-full ${alertSummary.overdue.length ? 'bg-red-100 text-red-700' : 'bg-yellow-100 text-yellow-700'}`}>
                {deliveryAlerts.length}
              </span>
            </div>
            <button onClick={() => setCurrentPage('sales-orders')} className="text-xs text-blue-600 hover:underline flex items-center gap-1">
              View SO <ChevronRight className="w-3 h-3" />
            </button>
          </div>
          <div className="divide-y divide-gray-50">
            {deliveryAlerts.slice(0, 8).map(alert => (
              <div
                key={alert.soId}
                onClick={() => setCurrentPage('sales-orders')}
                className={`flex items-center gap-3 px-4 py-2.5 cursor-pointer hover:shadow-sm transition ${alert.level === 'overdue' ? 'bg-red-50/40' : 'bg-yellow-50/40'}`}
              >
                <FileText className={`w-4 h-4 flex-shrink-0 ${alert.level === 'overdue' ? 'text-red-500' : 'text-yellow-500'}`} />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-900 truncate">
                    {alert.soNumber} — {alert.customerName}
                  </p>
                  <p className={`text-xs ${alert.level === 'overdue' ? 'text-red-600' : 'text-yellow-700'}`}>
                    {alert.level === 'overdue'
                      ? `${Math.abs(alert.daysUntilDue)}d overdue`
                      : `Due in ${alert.daysUntilDue}d`}
                  </p>
                </div>
                <ChevronRight className="w-4 h-4 text-gray-300 flex-shrink-0" />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
