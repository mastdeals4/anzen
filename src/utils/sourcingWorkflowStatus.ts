/**
 * Operational Status and Aging utilities for CRM Inquiries and Sourcing Workflow.
 * 
 * Cutover date: 20 September 2026
 * - Inquiries before 20 September 2026 are Historical Archive.
 * - Inquiries from 20 September 2026 onward follow the stage-based workflow.
 */

export const WORKFLOW_CUTOVER_DATE = '2026-09-20';

export type OperationalStatusKey =
  | 'new_not_sent'
  | 'reminder_due'
  | 'price_pending'
  | 'price_received'
  | 'price_received_coa_pending'
  | 'price_coa_complete'
  | 'price_submitted'
  | 'closed_won'
  | 'closed_lost';

export interface OperationalStatusInfo {
  key: OperationalStatusKey;
  label: string;
  priceReceived: boolean;
  coaPending: boolean;
  coaComplete: boolean;
  isSubmitted: boolean;
  isClosed: boolean;
  badgeClass: string;
  priceBadge?: { label: string; className: string };
  coaBadge?: { label: string; className: string };
}

export interface InquiryStatusInput {
  id: string;
  created_at: string;
  inquiry_date?: string | null;
  pipeline_status?: string | null;
  status?: string | null;
  source_status?: string | null;
  document_status?: string | null;
  kunal_price_status?: string | null;
  price_ready?: boolean | null;
  purchase_price?: number | null;
  offered_price?: number | null;
  quote_sent_at?: string | null;
  price_quoted?: boolean | null;
  last_sourcing_sent_at?: string | null;
  last_reminder_sent_at?: string | null;
  reminder_count?: number | null;
  coa_required?: boolean | null;
  sample_required?: boolean | null;
  is_archived?: boolean | null;
}

/** Check if an inquiry was created before the 20 September 2026 cutover date */
export function isHistoricalInquiry(inq: InquiryStatusInput): boolean {
  if (inq.is_archived) return true;
  const dateStr = inq.inquiry_date || inq.created_at?.split('T')[0] || '';
  return Boolean(dateStr && dateStr < WORKFLOW_CUTOVER_DATE);
}

/** Calculate aging in days from appropriate sourcing/request timestamp without resetting on reminders */
export function calculateSourcingAging(inq: InquiryStatusInput): {
  days: number;
  label: string;
  hasStarted: boolean;
  isOverdue: boolean;
  formattedAging: string;
} {
  const now = Date.now();
  // Anchor date: use original sourcing sent date or inquiry creation date.
  // Never reset aging when a reminder is sent.
  const anchorDateStr = inq.last_sourcing_sent_at || inq.inquiry_date || inq.created_at;
  if (!anchorDateStr) {
    return { days: 0, label: '0d', hasStarted: false, isOverdue: false, formattedAging: '0d' };
  }

  const anchorMs = new Date(anchorDateStr).getTime();
  if (isNaN(anchorMs)) {
    return { days: 0, label: '0d', hasStarted: false, isOverdue: false, formattedAging: '0d' };
  }

  const days = Math.max(0, Math.floor((now - anchorMs) / (1000 * 60 * 60 * 24)));
  const hasStarted = Boolean(inq.last_sourcing_sent_at || inq.created_at);
  const isOverdue = days >= 7;
  return {
    days,
    label: `${days}d`,
    hasStarted,
    isOverdue,
    formattedAging: `${days}d`,
  };
}

/** Determine the operational stage of an inquiry */
export function getOperationalStatus(inq: InquiryStatusInput): OperationalStatusInfo {
  const stage = (inq.pipeline_status || inq.status || 'new').toLowerCase();

  // 1. Closed Won / Lost
  if (stage === 'won' || stage === 'deal_won') {
    return {
      key: 'closed_won',
      label: 'Closed / Won',
      priceReceived: true,
      coaPending: false,
      coaComplete: true,
      isSubmitted: true,
      isClosed: true,
      badgeClass: 'bg-emerald-100 text-emerald-800 border-emerald-300',
    };
  }

  if (stage === 'lost' || stage === 'deal_lost') {
    return {
      key: 'closed_lost',
      label: 'Closed / Lost',
      priceReceived: false,
      coaPending: false,
      coaComplete: false,
      isSubmitted: false,
      isClosed: true,
      badgeClass: 'bg-rose-100 text-rose-800 border-rose-300',
    };
  }

  // 2. Price Submitted to customer
  const hasQuoted = Boolean(inq.quote_sent_at) || inq.price_quoted === true || stage === 'quoted' || stage === 'price_submitted';
  if (hasQuoted) {
    return {
      key: 'price_submitted',
      label: 'Price Submitted',
      priceReceived: true,
      coaPending: false,
      coaComplete: true,
      isSubmitted: true,
      isClosed: false,
      badgeClass: 'bg-indigo-100 text-indigo-800 border-indigo-300',
    };
  }

  // 3. Price received evaluation
  const hasPrice = inq.price_ready === true ||
    inq.kunal_price_status === 'price_received' ||
    (typeof inq.purchase_price === 'number' && inq.purchase_price > 0);

  const coaRequired = inq.coa_required === true;
  const coaReceived = inq.document_status === 'received';
  const coaPending = coaRequired && !coaReceived;

  if (hasPrice) {
    if (coaPending) {
      return {
        key: 'price_received_coa_pending',
        label: 'Price Received — COA Pending',
        priceReceived: true,
        coaPending: true,
        coaComplete: false,
        isSubmitted: false,
        isClosed: false,
        badgeClass: 'bg-amber-100 text-amber-800 border-amber-300',
        priceBadge: { label: 'Price Received', className: 'bg-emerald-100 text-emerald-800 border-emerald-200' },
        coaBadge: { label: 'COA Pending', className: 'bg-amber-100 text-amber-800 border-amber-200' },
      };
    }

    return {
      key: 'price_coa_complete',
      label: 'Price + COA Complete',
      priceReceived: true,
      coaPending: false,
      coaComplete: true,
      isSubmitted: false,
      isClosed: false,
      badgeClass: 'bg-emerald-100 text-emerald-800 border-emerald-300',
      priceBadge: { label: 'Price Received', className: 'bg-emerald-100 text-emerald-800 border-emerald-200' },
      coaBadge: coaRequired ? { label: 'COA Received', className: 'bg-blue-100 text-blue-800 border-blue-200' } : undefined,
    };
  }

  // 4. Price Pending / Sourcing Sent
  const hasSourcingSent = Boolean(inq.last_sourcing_sent_at) ||
    inq.source_status === 'sent' ||
    inq.source_status === 'waiting_reply' ||
    inq.source_status === 'waiting_supplier' ||
    stage === 'sourcing';

  if (hasSourcingSent) {
    const { days } = calculateSourcingAging(inq);
    const reminderCount = inq.reminder_count ?? 0;
    const isReminderDue = reminderCount > 0 || days >= 3;

    if (isReminderDue) {
      return {
        key: 'reminder_due',
        label: 'Reminder Due',
        priceReceived: false,
        coaPending: coaRequired,
        coaComplete: false,
        isSubmitted: false,
        isClosed: false,
        badgeClass: 'bg-orange-100 text-orange-800 border-orange-300',
      };
    }

    return {
      key: 'price_pending',
      label: 'Price Pending',
      priceReceived: false,
      coaPending: coaRequired,
      coaComplete: false,
      isSubmitted: false,
      isClosed: false,
      badgeClass: 'bg-blue-100 text-blue-800 border-blue-300',
    };
  }

// 5. New / Not Sent
  return {
    key: 'new_not_sent',
    label: 'New / Not Sent',
    priceReceived: false,
    coaPending: coaRequired,
    coaComplete: false,
    isSubmitted: false,
    isClosed: false,
    badgeClass: 'bg-slate-100 text-slate-700 border-slate-300',
  };
}

/**
 * Cleanly derive route ('india' | 'china' | 'local') from inquiry fields.
 */
export function deriveSourcingRoute(inq: {
  source_type?: string | null;
  supplier_name?: string | null;
  supplier_country?: string | null;
}): 'india' | 'china' | 'local' {
  const source = (inq.source_type || '').trim().toLowerCase();
  if (source === 'china') return 'china';
  if (source === 'local') return 'local';
  if (source === 'india') return 'india';

  const country = (inq.supplier_country || '').trim().toLowerCase();
  if (country === 'china') return 'china';
  if (country === 'indonesia' || country === 'local') return 'local';

  const supplier = (inq.supplier_name || '').toLowerCase();
  if (supplier.includes('china')) return 'china';
  if (supplier.includes('local') || supplier.includes('indonesia')) return 'local';

  return 'india';
}

