/**
 * Kunal Pending Price Tracker
 *
 * Header strip rendered above the AI India Price Review tab body. Two groups:
 *
 *   "AI Email Queue" — clickable cards that filter the email list below.
 *     Counts are computed from the SAME in-memory rows the list renders, via
 *     getAiBucketRows(). Card count and filter result are therefore identical
 *     by construction.
 *
 *       new_ai_reviews     — analyzed and not yet reviewed (excluding No Action)
 *       documents_received — aiType = Document / Certificate Received
 *       needs_manual_link  — needsManualLink && not No Action
 *       india_received     — aiType = India Price Received && !reviewed
 *                            (label: "India Price Emails")
 *
 *   "Kunal Workflow" — read-only summary, NOT email-list filters. Counts come
 *     from crm_inquiries / crm_inquiry_pricing_options / crm_inquiry_timeline
 *     and represent Kunal's downstream pricing worksheet state. Clicking
 *     these cards jumps to the matching Pricing Worksheet tab (if a handler
 *     was supplied), otherwise they are non-interactive.
 *
 *       ready_for_calc — source price set, no USD yet
 *       reply_pending  — purchase + offered set, no internal reply
 *       reply_sent     — Kunal internal price reply timeline row exists
 */

import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { AlertCircle, Calculator, Mail, CheckCircle2, Inbox, FileText, Link as LinkIcon } from 'lucide-react';
import type { KunalIndiaReviewRow, IndiaAiType } from '../../services/kunalIndiaPrice';

export type TrackerBucket =
  | 'new_ai_reviews'
  | 'documents_received'
  | 'needs_manual_link'
  | 'india_received'
  | 'ready_for_calc'
  | 'reply_pending'
  | 'reply_sent';

/** Cards that filter the AI email list. activeBucket may only be one of these. */
export const AI_QUEUE_BUCKETS: ReadonlySet<TrackerBucket> = new Set<TrackerBucket>([
  'new_ai_reviews', 'documents_received', 'needs_manual_link', 'india_received',
]);

/** Cards that summarise Kunal's downstream worksheet state. Never filter the AI email list. */
export const WORKFLOW_BUCKETS: ReadonlySet<TrackerBucket> = new Set<TrackerBucket>([
  'ready_for_calc', 'reply_pending', 'reply_sent',
]);

/**
 * Single source of truth for "what counts as bucket X in the AI tab".
 * Used by BOTH the tracker card count and the KunalIndiaPriceReview filter,
 * so card count === filtered list length. If you add a new AI bucket, only
 * touch this function.
 */
export function getAiBucketRows(
  rows: KunalIndiaReviewRow[],
  bucket: TrackerBucket,
): KunalIndiaReviewRow[] {
  if (!AI_QUEUE_BUCKETS.has(bucket)) return [];
  const isNoAction = (t: IndiaAiType) => t === 'No Action';
  switch (bucket) {
    case 'new_ai_reviews':
      return rows.filter(r => r.analyzed && !r.reviewed && !isNoAction(r.aiType));
    case 'documents_received':
      return rows.filter(r => r.aiType === 'Document / Certificate Received');
    case 'needs_manual_link':
      return rows.filter(r => r.needsManualLink && !isNoAction(r.aiType));
    case 'india_received':
      return rows.filter(r => r.aiType === 'India Price Received' && !r.reviewed);
    default:
      return [];
  }
}

interface Props {
  /** Currently active AI-queue card filter (workflow cards are not selectable). */
  activeBucket: TrackerBucket | null;
  /** Called when an AI-queue card is clicked. Workflow cards never call this. */
  onSelectBucket: (bucket: TrackerBucket | null) => void;
  /** External trigger to re-fetch workflow counts after a save / reply / etc. */
  refreshKey?: number;
  /**
   * The exact rows the email list is rendering. AI-queue card counts are
   * derived from this array via getAiBucketRows() so the count and the
   * filter result are guaranteed equal.
   */
  aiRows: KunalIndiaReviewRow[];
  /**
   * Optional — if provided, clicking a workflow card calls this so the parent
   * can switch the Pricing Worksheet tab (e.g. to "Need My Price" /
   * "Source Price Received"). If absent, workflow cards are non-interactive.
   */
  onJumpToWorksheetTab?: (target: 'need' | 'source' | 'completed') => void;
}

interface WorkflowCounts {
  ready_for_calc: number;
  reply_pending: number;
  reply_sent: number;
  loading: boolean;
}

export function KunalPendingPriceTracker({
  activeBucket,
  onSelectBucket,
  refreshKey,
  aiRows,
  onJumpToWorksheetTab,
}: Props) {
  const [workflow, setWorkflow] = useState<WorkflowCounts>({
    ready_for_calc: 0,
    reply_pending: 0,
    reply_sent: 0,
    loading: true,
  });

  // AI-queue counts derived directly from the rows the list is rendering.
  // This is the lockstep guarantee: same array + same predicate as the filter.
  const aiCounts = useMemo(() => ({
    new_ai_reviews: getAiBucketRows(aiRows, 'new_ai_reviews').length,
    documents_received: getAiBucketRows(aiRows, 'documents_received').length,
    needs_manual_link: getAiBucketRows(aiRows, 'needs_manual_link').length,
    india_received: getAiBucketRows(aiRows, 'india_received').length,
  }), [aiRows]);

  // Workflow counts — DB-driven, independent of the AI email queue.
  useEffect(() => {
    let cancelled = false;
    const compute = async () => {
      setWorkflow(prev => ({ ...prev, loading: true }));

      const { data: indiaOptions } = await supabase
        .from('crm_inquiry_pricing_options')
        .select('inquiry_id, source_price, source_type')
        .eq('source_type', 'india')
        .not('source_price', 'is', null);

      const inquiryIds = Array.from(new Set<string>((indiaOptions || []).map((r: any) => r.inquiry_id)));

      let readyForCalc = 0;
      let replyPending = 0;
      let replySent = 0;

      if (inquiryIds.length > 0) {
        const { data: inquiries } = await supabase
          .from('crm_inquiries')
          .select('id, kunal_price_status, purchase_price, offered_price')
          .in('id', inquiryIds);

        const { data: replyEvents } = await supabase
          .from('crm_inquiry_timeline')
          .select('inquiry_id')
          .eq('event_type', 'email_sent')
          .ilike('event_title', 'Kunal internal price reply%')
          .in('inquiry_id', inquiryIds);

        const replyByInquiry = new Set<string>((replyEvents || []).map((r: any) => r.inquiry_id));

        for (const inq of inquiries || []) {
          const hasPurchase = inq.purchase_price != null;
          const hasOffered = inq.offered_price != null;
          if (replyByInquiry.has(inq.id)) { replySent += 1; continue; }
          if (hasPurchase && hasOffered) { replyPending += 1; continue; }
          if (inq.kunal_price_status === 'pending') readyForCalc += 1;
        }
      }

      if (!cancelled) setWorkflow({
        ready_for_calc: readyForCalc,
        reply_pending: replyPending,
        reply_sent: replySent,
        loading: false,
      });
    };
    compute().catch(() => {
      if (!cancelled) setWorkflow(prev => ({ ...prev, loading: false }));
    });
    return () => { cancelled = true; };
  }, [refreshKey]);

  type CardDef = {
    key: TrackerBucket;
    label: string;
    sub: string;
    count: number;
    loading: boolean;
    Icon: typeof Inbox;
    color: string;
    clickable: boolean;
    onClick?: () => void;
    tooltip?: string;
  };

  const aiCards: CardDef[] = useMemo(() => ([
    {
      key: 'new_ai_reviews',
      label: 'New AI Reviews',
      sub: 'Pending Kunal action',
      count: aiCounts.new_ai_reviews,
      loading: false,
      Icon: Inbox,
      color: 'sky',
      clickable: true,
    },
    {
      key: 'documents_received',
      label: 'Documents Received',
      sub: 'COA / MSDS / etc.',
      count: aiCounts.documents_received,
      loading: false,
      Icon: FileText,
      color: 'teal',
      clickable: true,
    },
    {
      key: 'needs_manual_link',
      label: 'Needs Manual Link',
      sub: 'No matched inquiry',
      count: aiCounts.needs_manual_link,
      loading: false,
      Icon: LinkIcon,
      color: 'rose',
      clickable: true,
    },
    {
      key: 'india_received',
      label: 'India Price Emails',
      sub: 'AI-tagged India source replies',
      count: aiCounts.india_received,
      loading: false,
      Icon: AlertCircle,
      color: 'amber',
      clickable: true,
    },
  ]), [aiCounts]);

  const workflowTooltip = 'Workflow count from Kunal Pricing, not email queue.';
  const workflowCards: CardDef[] = useMemo(() => ([
    {
      key: 'ready_for_calc',
      label: 'Ready for Calculation',
      sub: 'Source price set, no USD yet',
      count: workflow.ready_for_calc,
      loading: workflow.loading,
      Icon: Calculator,
      color: 'blue',
      clickable: !!onJumpToWorksheetTab,
      onClick: onJumpToWorksheetTab ? () => onJumpToWorksheetTab('need') : undefined,
      tooltip: workflowTooltip,
    },
    {
      key: 'reply_pending',
      label: 'Price Entered',
      sub: 'Reply Pending',
      count: workflow.reply_pending,
      loading: workflow.loading,
      Icon: Mail,
      color: 'purple',
      clickable: !!onJumpToWorksheetTab,
      onClick: onJumpToWorksheetTab ? () => onJumpToWorksheetTab('source') : undefined,
      tooltip: workflowTooltip,
    },
    {
      key: 'reply_sent',
      label: 'Internal Reply Sent',
      sub: 'Closed for Kunal',
      count: workflow.reply_sent,
      loading: workflow.loading,
      Icon: CheckCircle2,
      color: 'green',
      clickable: !!onJumpToWorksheetTab,
      onClick: onJumpToWorksheetTab ? () => onJumpToWorksheetTab('completed') : undefined,
      tooltip: workflowTooltip,
    },
  ]), [workflow, onJumpToWorksheetTab]);

  const colorMap: Record<string, { bg: string; text: string; border: string; activeBg: string }> = {
    sky: { bg: 'bg-sky-50', text: 'text-sky-700', border: 'border-sky-200', activeBg: 'bg-sky-100' },
    teal: { bg: 'bg-teal-50', text: 'text-teal-700', border: 'border-teal-200', activeBg: 'bg-teal-100' },
    rose: { bg: 'bg-rose-50', text: 'text-rose-700', border: 'border-rose-200', activeBg: 'bg-rose-100' },
    amber: { bg: 'bg-amber-50', text: 'text-amber-700', border: 'border-amber-200', activeBg: 'bg-amber-100' },
    blue: { bg: 'bg-blue-50', text: 'text-blue-700', border: 'border-blue-200', activeBg: 'bg-blue-100' },
    purple: { bg: 'bg-purple-50', text: 'text-purple-700', border: 'border-purple-200', activeBg: 'bg-purple-100' },
    green: { bg: 'bg-green-50', text: 'text-green-700', border: 'border-green-200', activeBg: 'bg-green-100' },
  };

  const renderCard = (card: CardDef) => {
    const isActive = card.clickable && activeBucket === card.key && AI_QUEUE_BUCKETS.has(card.key);
    const c = colorMap[card.color];
    const baseClasses = `text-left p-3 rounded-lg border transition ${c.border} ${isActive ? c.activeBg : c.bg}`;
    const interactivity = card.clickable
      ? `cursor-pointer hover:${c.activeBg}`
      : 'cursor-default opacity-90';
    const handleClick = () => {
      if (!card.clickable) return;
      if (AI_QUEUE_BUCKETS.has(card.key)) {
        onSelectBucket(activeBucket === card.key ? null : card.key);
      } else if (card.onClick) {
        card.onClick();
      }
    };
    return (
      <button
        key={card.key}
        onClick={handleClick}
        disabled={!card.clickable}
        title={card.tooltip}
        className={`${baseClasses} ${interactivity} disabled:cursor-default`}
      >
        <div className="flex items-start justify-between">
          <div className="flex-1 min-w-0">
            <div className={`text-xs font-semibold ${c.text}`}>{card.label}</div>
            <div className="text-[10px] text-gray-500 truncate">{card.sub}</div>
          </div>
          <card.Icon className={`w-4 h-4 ${c.text} flex-shrink-0`} />
        </div>
        <div className={`text-2xl font-bold ${c.text} mt-1`}>
          {card.loading ? '–' : card.count}
        </div>
      </button>
    );
  };

  return (
    <div className="bg-white border border-gray-200 rounded-xl p-3 mb-3">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-semibold text-gray-800">Pending Price Tracker</h3>
        {activeBucket && AI_QUEUE_BUCKETS.has(activeBucket) && (
          <button onClick={() => onSelectBucket(null)} className="text-xs text-blue-600 hover:underline">
            Clear filter
          </button>
        )}
      </div>

      {/* AI Email Queue — clickable cards that filter the email list. */}
      <div className="mb-2">
        <div className="text-[10px] uppercase tracking-wide font-semibold text-gray-500 mb-1">AI Email Queue</div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          {aiCards.map(renderCard)}
        </div>
      </div>

      {/* Kunal Workflow — read-only summary from the pricing worksheet. */}
      <div>
        <div className="text-[10px] uppercase tracking-wide font-semibold text-gray-500 mb-1">
          Kunal Workflow
          <span className="ml-2 text-[10px] font-normal text-gray-400 normal-case">
            {workflowTooltip}
          </span>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
          {workflowCards.map(renderCard)}
        </div>
      </div>
    </div>
  );
}
