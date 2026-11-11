import { useCallback, useEffect, useState } from 'react';
import { Layout } from '../components/Layout';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { useNavigation } from '../contexts/NavigationContext';
import { useLanguage } from '../contexts/LanguageContext';
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
  const { t } = useLanguage();
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

    // Optimized single query to avoid 12 concurrent connection-saturating COUNT queries
    const [inqRes, parserRes] = await Promise.all([
      supabase
        .from('crm_inquiries')
        .select('id, source_status, last_sourcing_sent_at, last_reminder_sent_at, document_status, kunal_price_status, price_ready, quote_status, source_type'),
      supabase
        .from('sourcing_parser_results')
        .select('id', { count: 'exact', head: true })
        .eq('review_status', 'pending_review'),
    ]);

    const inqs = inqRes.data || [];
    let newNotSent = 0;
    let reminderDue = 0;
    let waitingReply = 0;
    let partialReceived = 0;
    let docsPending = 0;
    let needKunal = 0;
    let priceReadyNotSent = 0;
    let indaOver7d = 0;
    let indaOver15d = 0;
    let followUpDue = 0;
    let wonCount = 0;
    let lostCount = 0;

    for (const row of inqs) {
      const srcStatus = row.source_status || '';
      const qStatus = row.quote_status || '';
      const srcType = row.source_type || '';

      if (srcStatus === 'not_sent') newNotSent++;

      if (['sent', 'waiting_reply', 'partial_received'].includes(srcStatus)) {
        if (
          (row.last_sourcing_sent_at && row.last_sourcing_sent_at < reminderThreshold) ||
          (row.last_reminder_sent_at && row.last_reminder_sent_at < reminderThreshold)
        ) {
          reminderDue++;
        }
      }

      if (['sent', 'waiting_reply'].includes(srcStatus)) waitingReply++;
      if (srcStatus === 'partial_received') partialReceived++;
      if (row.document_status === 'pending') docsPending++;

      if (['received', 'partial_received'].includes(srcStatus) && row.kunal_price_status === 'pending') {
        needKunal++;
      }

      if (row.price_ready === true && qStatus === 'not_sent') priceReadyNotSent++;

      if (srcType === 'india' && ['sent', 'waiting_reply', 'partial_received'].includes(srcStatus)) {
        if (row.last_sourcing_sent_at && row.last_sourcing_sent_at < over7) indaOver7d++;
        if (row.last_sourcing_sent_at && row.last_sourcing_sent_at < over15) indaOver15d++;
      }

      if (['sent', 'follow_up_due'].includes(qStatus)) followUpDue++;
      if (qStatus === 'won') wonCount++;
      if (qStatus === 'lost') lostCount++;
    }

    setCrm({
      newNotSent,
      reminderDue,
      waitingReply,
      partialReceived,
      docsPending,
      needKunal,
      priceReadyNotSent,
      indaOver7d,
      indaOver15d,
      followUpDue,
      wonCount,
      lostCount,
    });
    setLegacy({ parserReviewPending: (!parserRes.error && parserRes.count) || 0 });
    setLoading(false);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <Layout>
      <div className="p-4 md:p-6">
        <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
          <div>
            <h1 className="text-lg font-semibold text-gray-900">{t('pricing.overviewTitle')}</h1>
            <p className="text-xs text-gray-500 mt-0.5">{t('pricing.overviewSubtitle')}</p>
          </div>
          <button onClick={load} disabled={loading}
            className="flex items-center gap-1.5 px-2.5 py-1 text-xs border border-gray-200 rounded hover:bg-gray-50 disabled:opacity-50">
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /> {t('common.refresh')}
          </button>
        </div>

        {/* Sourcing / sales-head section */}
        {showAnvi && (
          <div className="mb-4">
            <p className="text-[11px] uppercase tracking-wide text-gray-500 font-semibold mb-1.5">{t('pricing.sourcing')}</p>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
              <Card icon={Mail} label={t('pricing.newNotSent')} value={crm.newNotSent}
                color="bg-blue-100 text-blue-700"
                description="Inquiries not yet sent to India/China"
                onClick={canRouteToInternal ? () => setCurrentPage('sourcing-outbox') : undefined} />
              <Card icon={Clock} label={t('pricing.reminderDue')} value={crm.reminderDue}
                color="bg-amber-100 text-amber-700"
                description={`Stale >${REMINDER_AGE_DAYS}d, no reply yet`}
                onClick={canRouteToInternal ? () => setCurrentPage('sourcing-outbox') : undefined} />
              <Card icon={Inbox} label={t('pricing.waitingReply')} value={crm.waitingReply}
                color="bg-purple-100 text-purple-700"
                description="Sent / waiting for source price" />
              <Card icon={FileText} label={t('pricing.partialReceived')} value={crm.partialReceived}
                color="bg-indigo-100 text-indigo-700"
                description="Some products replied, others pending" />
              <Card icon={FileText} label={t('pricing.docsPending')} value={crm.docsPending}
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
