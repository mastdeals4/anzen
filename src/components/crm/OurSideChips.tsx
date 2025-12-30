import { CheckCircle2 } from 'lucide-react';

interface OurSideChipsProps {
  inquiry: {
    price_required?: boolean;
    coa_required?: boolean;
    sample_required?: boolean;
    agency_letter_required?: boolean;
    others_required?: boolean;
    price_sent_at?: string | null;
    coa_sent_at?: string | null;
    sample_sent_at?: string | null;
    agency_letter_sent_at?: string | null;
    others_sent_at?: string | null;
  };
  compact?: boolean;
  onMarkSent?: (type: 'price' | 'coa' | 'sample' | 'agency_letter' | 'others') => void;
}

export function OurSideChips({ inquiry, compact = false, onMarkSent }: OurSideChipsProps) {
  const requirements = [
    { type: 'price' as const, letter: 'P', required: inquiry.price_required ?? true, sent: inquiry.price_sent_at, label: 'Price' },
    { type: 'coa' as const, letter: 'C', required: inquiry.coa_required ?? true, sent: inquiry.coa_sent_at, label: 'COA' },
    { type: 'sample' as const, letter: 'S', required: inquiry.sample_required, sent: inquiry.sample_sent_at, label: 'Sample' },
    { type: 'agency_letter' as const, letter: 'A', required: inquiry.agency_letter_required, sent: inquiry.agency_letter_sent_at, label: 'Agency Letter' },
    { type: 'others' as const, letter: 'O', required: inquiry.others_required, sent: inquiry.others_sent_at, label: 'Others' },
  ];

  const anyRequired = requirements.some(r => r.required);

  // If nothing required at all, show neutral state
  if (!anyRequired) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs bg-gray-100 text-gray-500">
        <Minus className="w-3 h-3" />
        {!compact && 'Nothing required'}
      </span>
    );
  }

  // Always show letter buttons with color indicators (removed "All done" badge)
  return (
    <div className="flex flex-wrap gap-1.5">
      {requirements.filter(r => r.required).map(req => (
        <button
          key={req.type}
          onClick={() => onMarkSent?.(req.type)}
          disabled={!onMarkSent}
          className={`
            inline-flex items-center justify-center
            w-6 h-6 rounded text-xs font-bold
            transition-colors duration-150
            ${req.sent
              ? 'bg-green-100 text-green-700 hover:bg-green-200 cursor-pointer'
              : 'bg-red-100 text-red-700 hover:bg-red-200 cursor-pointer'
            }
            ${!onMarkSent ? 'cursor-default' : ''}
          `}
          title={`${req.label}${req.sent ? ' - Sent (Click to unmark)' : ' - Pending (Click to mark as sent)'}`}
        >
          {req.letter}
        </button>
      ))}
    </div>
  );
}

function Minus({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}
