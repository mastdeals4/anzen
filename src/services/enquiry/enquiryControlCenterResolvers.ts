import type {
  EnquiryAgeInfo,
  EnquiryDueInfo,
  EnquiryOperationalSummary,
  EnquiryRequestGridItem,
  EnquiryRequestStats,
} from '../../types/enquiry/controlCenter.types.ts';
import type { EnquiryRequestCategory } from '../../types/enquiry/request.types.ts';

// Category urgency weight: technical > commercial > document > sample > logistics > custom
const CATEGORY_PRIORITY: Record<EnquiryRequestCategory, number> = {
  technical: 1,
  commercial: 2,
  document: 3,
  sample: 4,
  logistics: 5,
  custom: 6,
};

const WAITING_FOR_PRIORITY: Record<string, number> = {
  CUSTOMER: 1,
  INDIA: 2,
  MANUFACTURER: 3,
  INTERNAL: 4,
  NONE: 5,
};

/**
 * Derives the age of an enquiry in days, human-readable label, and urgency bucket.
 * Uses inquiryDate as authoritative reference date (falling back to createdAt).
 */
export function deriveEnquiryAge(
  inquiryDate: string | null | undefined,
  createdAt: string,
  nowMs: number = Date.now()
): EnquiryAgeInfo {
  let refDateStr = inquiryDate && inquiryDate.trim() ? inquiryDate.trim() : createdAt;
  let parsed = new Date(refDateStr);
  if (isNaN(parsed.getTime())) {
    refDateStr = createdAt;
    parsed = new Date(createdAt);
  }

  // Calculate day difference
  const diffMs = nowMs - parsed.getTime();
  const days = Math.max(0, Math.floor(diffMs / 86400000));

  let label: string;
  if (days === 0) {
    label = 'Today';
  } else {
    label = `${days}d`;
  }

  let urgency: EnquiryAgeInfo['urgency'];
  if (days === 0) {
    urgency = 'today';
  } else if (days <= 3) {
    urgency = 'recent';
  } else if (days <= 7) {
    urgency = 'attention';
  } else {
    urgency = 'ageing';
  }

  return {
    days,
    label,
    urgency,
    referenceDate: refDateStr,
  };
}

/**
 * Derives due deadline status across active requests for an enquiry.
 * Returns null due info if no active request specifies a deadline.
 */
export function deriveEnquiryDueInfo(
  requests: EnquiryRequestGridItem[],
  nowMs: number = Date.now()
): EnquiryDueInfo {
  const activeWithDue = requests.filter(
    r => ['OPEN', 'IN_PROGRESS', 'BLOCKED'].includes(r.status) && r.due_at
  );

  if (activeWithDue.length === 0) {
    return {
      dueAt: null,
      isOverdue: false,
      daysUntilDue: null,
      dueLabel: null,
    };
  }

  // Find the earliest active due_at
  activeWithDue.sort((a, b) => new Date(a.due_at!).getTime() - new Date(b.due_at!).getTime());
  const earliestDue = activeWithDue[0].due_at!;
  const dueTime = new Date(earliestDue).getTime();

  const isOverdue = dueTime < nowMs;
  const daysUntilDue = Math.round((dueTime - nowMs) / 86400000);

  let dueLabel: string;
  if (isOverdue) {
    const overdueDays = Math.max(1, Math.abs(daysUntilDue));
    dueLabel = `Overdue (-${overdueDays}d)`;
  } else if (daysUntilDue === 0) {
    dueLabel = 'Due Today';
  } else {
    dueLabel = `+${daysUntilDue}d`;
  }

  return {
    dueAt: earliestDue,
    isOverdue,
    daysUntilDue,
    dueLabel,
  };
}

/**
 * Deterministically derives the current blocker for an enquiry.
 * Rules:
 *   1. Only requests with status === 'BLOCKED' can be blockers.
 *   2. If multiple BLOCKED requests exist, prioritizes by:
 *      - category urgency (technical > commercial > document > sample > logistics > custom)
 *      - earliest created_at timestamp
 *   3. Extracts the non-empty current_issue from the highest priority blocked request.
 *   4. If no BLOCKED request has a current_issue, or no request is BLOCKED, returns null.
 *   5. NEVER fabricates a blocker.
 */
export function deriveCurrentBlocker(requests: EnquiryRequestGridItem[]): string | null {
  const blocked = requests.filter(r => r.status === 'BLOCKED' && r.current_issue && r.current_issue.trim());

  if (blocked.length === 0) {
    return null;
  }

  blocked.sort((a, b) => {
    const catA = CATEGORY_PRIORITY[a.category] ?? 99;
    const catB = CATEGORY_PRIORITY[b.category] ?? 99;
    if (catA !== catB) return catA - catB;
    return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
  });

  return blocked[0].current_issue?.trim() || null;
}

/**
 * Deterministically derives the waiting_for summary and breakdown.
 * Rules:
 *   1. Filters for active requests (status in 'OPEN', 'IN_PROGRESS', 'BLOCKED').
 *   2. If no active requests exist, returns primary: 'NONE', summary: 'None'.
 *   3. If any request is BLOCKED, the waiting_for of that blocked request takes top priority.
 *   4. Otherwise, primary party order: CUSTOMER > INDIA > MANUFACTURER > INTERNAL > NONE.
 *   5. Constructs a readable breakdown summary (e.g. "Customer (2), India (1)" or "Customer").
 */
export function deriveWaitingFor(requests: EnquiryRequestGridItem[]): {
  primary: string;
  summary: string;
  breakdown: Record<string, number>;
} {
  const active = requests.filter(r => ['OPEN', 'IN_PROGRESS', 'BLOCKED'].includes(r.status));

  if (active.length === 0) {
    return {
      primary: 'NONE',
      summary: 'None',
      breakdown: {},
    };
  }

  // Count breakdown
  const breakdown: Record<string, number> = {};
  for (const r of active) {
    const key = r.waiting_for || 'NONE';
    breakdown[key] = (breakdown[key] || 0) + 1;
  }

  // Determine primary party
  let primary: string;

  // If there are blocked requests, the primary blocked request's waiting_for takes priority
  const blocked = active.filter(r => r.status === 'BLOCKED');
  if (blocked.length > 0) {
    blocked.sort((a, b) => {
      const catA = CATEGORY_PRIORITY[a.category] ?? 99;
      const catB = CATEGORY_PRIORITY[b.category] ?? 99;
      if (catA !== catB) return catA - catB;
      return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
    });
    primary = blocked[0].waiting_for || 'NONE';
  } else {
    // Priority order: CUSTOMER > INDIA > MANUFACTURER > INTERNAL > NONE
    const uniqueParties = Object.keys(breakdown);
    uniqueParties.sort((a, b) => {
      const pA = WAITING_FOR_PRIORITY[a] ?? 99;
      const pB = WAITING_FOR_PRIORITY[b] ?? 99;
      if (pA !== pB) return pA - pB;
      return (breakdown[b] || 0) - (breakdown[a] || 0); // tie breaker by count
    });
    primary = uniqueParties[0] || 'NONE';
  }

  // Format summary string
  const partyKeys = Object.keys(breakdown);
  let summary: string;

  const formatParty = (p: string) => {
    switch (p.toUpperCase()) {
      case 'CUSTOMER':
        return 'Customer';
      case 'INDIA':
        return 'India';
      case 'MANUFACTURER':
        return 'Manufacturer';
      case 'INTERNAL':
        return 'Internal';
      case 'NONE':
        return 'None';
      default:
        return p;
    }
  };

  if (partyKeys.length === 1) {
    summary = formatParty(partyKeys[0]);
  } else {
    // Sorted by priority
    partyKeys.sort((a, b) => {
      const pA = WAITING_FOR_PRIORITY[a] ?? 99;
      const pB = WAITING_FOR_PRIORITY[b] ?? 99;
      return pA - pB;
    });
    summary = partyKeys.map(k => `${formatParty(k)} (${breakdown[k]})`).join(', ');
  }

  return {
    primary,
    summary,
    breakdown,
  };
}

/**
 * Deterministically derives the next action for an enquiry.
 * Rules:
 *   1. If any BLOCKED request has a next_action, takes the highest-priority blocked request's action.
 *   2. Otherwise, examines active requests (IN_PROGRESS > OPEN) with non-empty next_action.
 *   3. Prioritizes by category urgency (technical > commercial > document > sample > logistics > custom)
 *      and earliest created_at timestamp.
 *   4. If no active request has next_action, returns null.
 *   5. NEVER fabricates text like "Follow up with customer".
 */
export function deriveNextAction(requests: EnquiryRequestGridItem[]): string | null {
  // 1. Check BLOCKED requests first
  const blockedWithAction = requests.filter(
    r => r.status === 'BLOCKED' && r.next_action && r.next_action.trim()
  );

  if (blockedWithAction.length > 0) {
    blockedWithAction.sort((a, b) => {
      const catA = CATEGORY_PRIORITY[a.category] ?? 99;
      const catB = CATEGORY_PRIORITY[b.category] ?? 99;
      if (catA !== catB) return catA - catB;
      return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
    });
    return blockedWithAction[0].next_action?.trim() || null;
  }

  // 2. Check active IN_PROGRESS or OPEN requests
  const activeWithAction = requests.filter(
    r => ['IN_PROGRESS', 'OPEN'].includes(r.status) && r.next_action && r.next_action.trim()
  );

  if (activeWithAction.length === 0) {
    return null;
  }

  activeWithAction.sort((a, b) => {
    // IN_PROGRESS takes priority over OPEN
    if (a.status !== b.status) {
      return a.status === 'IN_PROGRESS' ? -1 : 1;
    }
    const catA = CATEGORY_PRIORITY[a.category] ?? 99;
    const catB = CATEGORY_PRIORITY[b.category] ?? 99;
    if (catA !== catB) return catA - catB;
    return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
  });

  return activeWithAction[0].next_action?.trim() || null;
}

/**
 * Computes summary statistics across all requests for an enquiry.
 */
export function deriveRequestStats(
  requests: EnquiryRequestGridItem[],
  nowMs: number = Date.now()
): EnquiryRequestStats {
  let open = 0;
  let inProgress = 0;
  let blocked = 0;
  let resolved = 0;
  let cancelled = 0;
  let overdue = 0;

  for (const r of requests) {
    switch (r.status) {
      case 'OPEN':
        open++;
        break;
      case 'IN_PROGRESS':
        inProgress++;
        break;
      case 'BLOCKED':
        blocked++;
        break;
      case 'RESOLVED':
        resolved++;
        break;
      case 'CANCELLED':
      case 'NOT_POSSIBLE':
      case 'NOT_REQUIRED':
        cancelled++;
        break;
    }

    if (
      ['OPEN', 'IN_PROGRESS', 'BLOCKED'].includes(r.status) &&
      r.due_at &&
      new Date(r.due_at).getTime() < nowMs
    ) {
      overdue++;
    }
  }

  return {
    total: requests.length,
    open,
    inProgress,
    blocked,
    resolved,
    cancelled,
    overdue,
  };
}

/**
 * Builds the complete deterministic operational summary object for an enquiry.
 */
export function deriveOperationalSummary(
  inquiryAssignedTo: string | null,
  inquiryAssignedName: string | null,
  requests: EnquiryRequestGridItem[],
  nowMs: number = Date.now()
): EnquiryOperationalSummary {
  const currentBlocker = deriveCurrentBlocker(requests);
  const waitingInfo = deriveWaitingFor(requests);
  const nextAction = deriveNextAction(requests);
  const stats = deriveRequestStats(requests, nowMs);

  // Primary owner: enquiry owner takes precedence; if unassigned, check active requests
  let primaryOwner = {
    id: inquiryAssignedTo,
    name: inquiryAssignedName,
    team: null as string | null,
  };

  if (!primaryOwner.id && requests.length > 0) {
    const activeAssigned = requests.find(
      r => ['OPEN', 'IN_PROGRESS', 'BLOCKED'].includes(r.status) && (r.assigned_to || r.assigned_team)
    );
    if (activeAssigned) {
      primaryOwner = {
        id: activeAssigned.assigned_to,
        name: null,
        team: activeAssigned.assigned_team || null,
      };
    }
  }

  return {
    currentBlocker,
    waitingFor: waitingInfo.primary,
    waitingForSummary: waitingInfo.summary,
    waitingForBreakdown: waitingInfo.breakdown,
    nextAction,
    stats,
    primaryOwner,
  };
}
