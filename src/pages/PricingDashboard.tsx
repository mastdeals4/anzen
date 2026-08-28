import { useCallback, useEffect, useState } from 'react';
import { Layout } from '../components/Layout';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { useNavigation } from '../contexts/NavigationContext';
import {
  Clock, AlertCircle, FileText, CheckCircle2, Mail, RefreshCw, Inbox, Send, DollarSign,
} from 'lucide-react';

/**
 * Pricing Overview — now driven primarily by crm_inquiries (the master sheet)
 * with optional legacy counts from price_request_items / sourcing_parser_results.
 *
 * Cards are split into two role-aware sections so each user lands on what is
 * actually theirs to action.
 */

interface CrmCounts {
  newNotSent: number;
  reminderDue: number;
  waitingReply: number;
  partialReceived: number;
  docsPending: number;
  needKunal: number;
  priceReadyNotSent: number;
  indaOver7d: number;
  indaOver15d: number;
  followUpDue: number;
  wonCount: number;
  lostCount: number;
}

interface LegacyCounts {
  parserReviewPending: number;
}

const REMINDER_AGE_DAYS = 3;
const OVER_7_DAYS = 7;
const OVER_15_DAYS = 15;

function isoAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

interface CardProps {
  icon: React.ElementType;
  label: string;
  value: number;
  color: string;
  description?: string;
  onClick?: () => void;
}

function Card({ icon: Icon, label, value, color, description, onClick }: CardProps) {
  return (
    <button onClick={onClick}
      className="text-left bg-white border border-gray-200 rounded-md px-3 py-2 hover:border-blue-300 hover:shadow-sm transition disabled:cursor-default"
      disabled={!onClick}>
      <div className="flex items-center justify-between mb-1">
        <div className={`w-5 h-5 flex items-center justify-center rounded ${color}`}>
          <Icon className="w-3 h-3" />
        </div>
        <span className="text-lg font-semibold text-gray-900 leading-none">{value}</span>
      </div>
      <p className="text-[11px] font-medium text-gray-700 leading-tight">{label}</p>
      {description && <p className="text-[10px] text-gray-400 mt-0.5 leading-snug">{description}</p>}
    </button>
  );
}

export function PricingDashboard() {
  const { profile } = useAuth();
  const { setCurrentPage } = useNavigation();
  const role = profile?.role || 'sales';
  const showKunal = role === 'admin' || role === 'manager';
  const showAnvi = role === 'admin' || role === 'manager' || role === 'sales';
  // Sales sees the Sales/Anvi section as read-only summary cards. They must
  // not be routed into Anvi Sourcing or Kunal Pricing pages.
  const canRouteToInternal = role === 'admin' || role === 'manager';

  const [crm, setCrm] = useState<CrmCounts>({
    newNotSent: 0, reminderDue: 0, waitingReply: 0, partialReceived: 0,
    docsPending: 0, needKunal: 0, priceReadyNotSent: 0,
    indaOver7d: 0, indaOver15d: 0, followUpDue: 0, wonCount: 0, lostCount: 0,
  });
  const [legacy, setLegacy] = useState<LegacyCounts>({ parserReviewPending: 0 });
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const reminderThreshold = isoAgo(REMINDER_AGE_DAYS);
    const over7 = isoAgo(OVER_7_DAYS);
    const over15 = isoAgo(OVER_15_DAYS);

    const queries = await Promise.allSettled([
      // 0 New not sent
      supabase.from('crm_inquiries').select('id', { count: 'exact', head: true })
        .eq('source_status', 'not_sent'),
      // 1 Reminder due (sent/waiting_reply, stale >3d)
      supabase.from('crm_inquiries').select('id', { count: 'exact', head: true })
        .in('source_status', ['sent', 'waiting_reply', 'partial_received'])
        .or(`last_sourcing_sent_at.lt.${reminderThreshold},last_reminder_sent_at.lt.${reminderThreshold}`),
      // 2 Waiting reply
      supabase.from('crm_inquiries').select('id', { count: 'exact', head: true })
        .in('source_status', ['sent', 'waiting_reply']),
      // 3 Partial received
      supabase.from('crm_inquiries').select('id', { count: 'exact', head: true })
        .eq('source_status', 'partial_received'),
      // 4 Docs pending
      supabase.from('crm_inquiries').select('id', { count: 'exact', head: true })
        .eq('document_status', 'pending'),
      // 5 Need Kunal price
      supabase.from('crm_inquiries').select('id', { count: 'exact', head: true })
        .in('source_status', ['received', 'partial_received'])
        .eq('kunal_price_status', 'pending'),
      // 6 Price ready but quote not sent
      supabase.from('crm_inquiries').select('id', { count: 'exact', head: true })
        .eq('price_ready', true)
        .in('quote_status', ['not_sent']),
      // 7 India pending over 7d
      supabase.from('crm_inquiries').select('id', { count: 'exact', head: true })
        .eq('source_type', 'india')
        .in('source_status', ['sent', 'waiting_reply', 'partial_received'])
        .lt('last_sourcing_sent_at', over7),
      // 8 India pending over 15d
      supabase.from('crm_inquiries').select('id', { count: 'exact', head: true })
        .eq('source_type', 'india')
        .in('source_status', ['sent', 'waiting_reply', 'partial_received'])
        .lt('last_sourcing_sent_at', over15),
      // 9 Follow up due (quote sent, awaiting decision)
      supabase.from('crm_inquiries').select('id', { count: 'exact', head: true })
        .in('quote_status', ['sent', 'follow_up_due']),
      // 10 Won
      supabase.from('crm_inquiries').select('id', { count: 'exact', head: true })
        .eq('quote_status', 'won'),
      // 11 Lost
      supabase.from('crm_inquiries').select('id', { count: 'exact', head: true })
        .eq('quote_status', 'lost'),
      // 12 Parser review (legacy)
      supabase.from('sourcing_parser_results').select('id', { count: 'exact', head: true })
        .eq('review_status', 'pending_review'),
    ]);

    const c = (idx: number) => {
      const q = queries[idx];
      return q.status === 'fulfilled' && !q.value.error ? (q.value.count || 0) : 0;
    };

    setCrm({
      newNotSent: c(0),
      reminderDue: c(1),
      waitingReply: c(2),
      partialReceived: c(3),
      docsPending: c(4),
      needKunal: c(5),
      priceReadyNotSent: c(6),
      indaOver7d: c(7),
      indaOver15d: c(8),
      followUpDue: c(9),
      wonCount: c(10),
      lostCount: c(11),
    });
    setLegacy({ parserReviewPending: c(12) });
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <Layout>
      <div className="p-4 md:p-6">
        <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
          <div>
            <h1 className="text-lg font-semibold text-gray-900">Pricing Overview</h1>
            <p className="text-xs text-gray-500 mt-0.5">Pending work across CRM inquiries and the pricing workflow.</p>
          </div>
          <button onClick={load} disabled={loading}
            className="flex items-center gap-1.5 px-2.5 py-1 text-xs border border-gray-200 rounded hover:bg-gray-50 disabled:opacity-50">
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /> Refresh
          </button>
        </div>

        {/* Sourcing / sales-head section */}
        {showAnvi && (
          <div className="mb-4">
            <p className="text-[11px] uppercase tracking-wide text-gray-500 font-semibold mb-1.5">Sourcing</p>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
              <Card icon={Mail} label="New (not sent)" value={crm.newNotSent}
                color="bg-blue-100 text-blue-700"
                description="Inquiries not yet sent to India/China"
                onClick={canRouteToInternal ? () => setCurrentPage('sourcing-outbox') : undefined} />
              <Card icon={Clock} label="Reminder due" value={crm.reminderDue}
                color="bg-amber-100 text-amber-700"
                description={`Stale >${REMINDER_AGE_DAYS}d, no reply yet`}
                onClick={canRouteToInternal ? () => setCurrentPage('sourcing-outbox') : undefined} />
              <Card icon={Inbox} label="Waiting reply" value={crm.waitingReply}
                color="bg-purple-100 text-purple-700"
                description="Sent / waiting for source price" />
              <Card icon={FileText} label="Partial received" value={crm.partialReceived}
                color="bg-indigo-100 text-indigo-700"
                description="Some products replied, others pending" />
              <Card icon={FileText} label="Docs pending" value={crm.docsPending}
                color="bg-orange-100 text-orange-700"
                description="Waiting for COA / MSDS" />
              <Card icon={CheckCircle2} label="Kunal price pending" value={crm.needKunal}
                color="bg-pink-100 text-pink-700"
                description="Source received, waiting for Kunal"
                onClick={canRouteToInternal ? () => setCurrentPage('pricing-worksheet') : undefined} />
            </div>
          </div>
        )}

        {/* Kunal / admin section */}
        {showKunal && (
          <div className="mb-4">
            <p className="text-[11px] uppercase tracking-wide text-gray-500 font-semibold mb-1.5">Pricing / Kunal</p>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
              <Card icon={DollarSign} label="Need my price" value={crm.needKunal}
                color="bg-purple-100 text-purple-700"
                description="Inquiries waiting for purchase/selling"
                onClick={() => setCurrentPage('pricing-worksheet')} />
              <Card icon={Send} label="Ready, not sent" value={crm.priceReadyNotSent}
                color="bg-green-100 text-green-700"
                description="Price ready but quote not sent"
                onClick={() => setCurrentPage('crm')} />
              <Card icon={Clock} label="India >7d" value={crm.indaOver7d}
                color="bg-orange-100 text-orange-700"
                description="India sourcing pending over a week" />
              <Card icon={AlertCircle} label="India >15d" value={crm.indaOver15d}
                color="bg-red-100 text-red-700"
                description="Critical — over two weeks pending" />
              <Card icon={Inbox} label="Quote follow-up" value={crm.followUpDue}
                color="bg-indigo-100 text-indigo-700"
                description="Quote sent, awaiting customer reply" />
              <Card icon={CheckCircle2} label="Won / Lost" value={crm.wonCount + crm.lostCount}
                color="bg-gray-100 text-gray-700"
                description={`${crm.wonCount} won · ${crm.lostCount} lost`} />
            </div>
          </div>
        )}

        {/* Legacy / parser section */}
        {showKunal && (
          <div className="mb-2">
            <p className="text-[11px] uppercase tracking-wide text-gray-500 font-semibold mb-1.5">Parser</p>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
              <Card icon={Inbox} label="Parser review" value={legacy.parserReviewPending}
                color="bg-indigo-100 text-indigo-700"
                description="AI-parsed replies awaiting review"
                onClick={() => setCurrentPage('pricing-parser-review')} />
            </div>
          </div>
        )}

        {!loading && crm.newNotSent + crm.reminderDue + crm.needKunal + crm.priceReadyNotSent + crm.followUpDue + legacy.parserReviewPending === 0 && (
          <div className="bg-gray-50 border border-gray-200 rounded-md px-3 py-2 text-xs text-gray-600 flex items-start gap-2">
            <AlertCircle className="w-3.5 h-3.5 text-gray-400 mt-0.5 flex-shrink-0" />
            <span>Nothing pending right now. New work will appear here automatically.</span>
          </div>
        )}
      </div>
    </Layout>
  );
}
