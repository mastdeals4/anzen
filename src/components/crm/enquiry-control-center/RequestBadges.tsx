import React from 'react';
import { EnquiryRequestGridItem } from '../../../types/enquiry/controlCenter.types.ts';
import { EnquiryRequestCategory, EnquiryRequestStatus } from '../../../types/enquiry/request.types.ts';

interface RequestBadgesProps {
  requests: EnquiryRequestGridItem[];
}

const CATEGORY_ABBREV: Record<EnquiryRequestCategory, string> = {
  technical: 'Tech',
  commercial: 'Price',
  document: 'Doc',
  sample: 'Samp',
  logistics: 'Log',
  custom: 'Other',
};

const CATEGORY_COLORS: Record<EnquiryRequestCategory, string> = {
  technical: 'bg-purple-50 text-purple-700 border-purple-200',
  commercial: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  document: 'bg-blue-50 text-blue-700 border-blue-200',
  sample: 'bg-amber-50 text-amber-700 border-amber-200',
  logistics: 'bg-indigo-50 text-indigo-700 border-indigo-200',
  custom: 'bg-gray-50 text-gray-700 border-gray-200',
};

const STATUS_DOTS: Record<EnquiryRequestStatus, string> = {
  BLOCKED: 'bg-rose-500 ring-rose-200',
  IN_PROGRESS: 'bg-amber-500 ring-amber-200',
  OPEN: 'bg-blue-500 ring-blue-200',
  RESOLVED: 'bg-emerald-500 ring-emerald-200',
  NOT_POSSIBLE: 'bg-gray-400 ring-gray-200',
  NOT_REQUIRED: 'bg-gray-400 ring-gray-200',
  CANCELLED: 'bg-gray-400 ring-gray-200',
};

export const RequestBadges: React.FC<RequestBadgesProps> = ({ requests }) => {
  if (!requests || requests.length === 0) {
    return <span className="text-gray-400 text-xs">—</span>;
  }

  // Group requests by category
  const groups: Record<string, EnquiryRequestGridItem[]> = {};
  for (const r of requests) {
    const cat = r.category || 'custom';
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push(r);
  }

  const categoryKeys = Object.keys(groups) as EnquiryRequestCategory[];

  return (
    <div className="flex flex-wrap items-center gap-1">
      {categoryKeys.map(cat => {
        const items = groups[cat];
        const abbrev = CATEGORY_ABBREV[cat] || cat;
        const colorClass = CATEGORY_COLORS[cat] || 'bg-gray-50 text-gray-700 border-gray-200';

        // Check if any request in this category is blocked
        const hasBlocked = items.some(i => i.status === 'BLOCKED');
        const hasInProgress = items.some(i => i.status === 'IN_PROGRESS');
        const allResolved = items.every(i => i.status === 'RESOLVED');

        let dotClass = 'bg-blue-400';
        if (hasBlocked) dotClass = STATUS_DOTS.BLOCKED;
        else if (hasInProgress) dotClass = STATUS_DOTS.IN_PROGRESS;
        else if (allResolved) dotClass = STATUS_DOTS.RESOLVED;

        const tooltipText = items
          .map(i => `${i.request_code}: ${i.title} (${i.status})`)
          .join('\n');

        return (
          <span
            key={cat}
            title={tooltipText}
            className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium border ${colorClass} whitespace-nowrap`}
          >
            <span className={`w-1.5 h-1.5 rounded-full ${dotClass}`} />
            <span>{abbrev}</span>
            {items.length > 1 && (
              <span className="text-[9px] opacity-75 font-semibold">({items.length})</span>
            )}
          </span>
        );
      })}
    </div>
  );
};
