// Shared card/dashboard UI primitives for the Tax Compliance Centre.
// Every tax panel composes these so the numbers, status chips, and empty
// states look and behave identically across screens.
import type { ReactNode } from 'react';

function toIDR(n: number): string {
  return 'Rp ' + Number(n ?? 0).toLocaleString('id-ID');
}

type Tone = 'blue' | 'green' | 'red' | 'orange' | 'gray' | 'purple';

const toneRing: Record<Tone, string> = {
  blue:   'border-blue-200 bg-blue-50',
  green:  'border-green-200 bg-green-50',
  red:    'border-red-200 bg-red-50',
  orange: 'border-orange-200 bg-orange-50',
  gray:   'border-gray-200 bg-gray-50',
  purple: 'border-purple-200 bg-purple-50',
};

const toneText: Record<Tone, string> = {
  blue:   'text-blue-700',
  green:  'text-green-700',
  red:    'text-red-700',
  orange: 'text-orange-700',
  gray:   'text-gray-700',
  purple: 'text-purple-700',
};

/** A single headline number tile. */
export function StatCard({
  label, value, tone = 'gray', hint, icon, money = true,
}: {
  label: string;
  value: number | string;
  tone?: Tone;
  hint?: string;
  icon?: ReactNode;
  money?: boolean;
}) {
  const display = typeof value === 'number' && money ? toIDR(value) : String(value);
  return (
    <div className={`rounded-lg border ${toneRing[tone]} px-3 py-2 flex flex-col gap-0.5`}>
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-medium uppercase tracking-wide text-gray-500">{label}</span>
        {icon && <span className={toneText[tone]}>{icon}</span>}
      </div>
      <span className={`text-base font-semibold tabular-nums leading-tight ${toneText[tone]}`}>{display}</span>
      {hint && <span className="text-[10px] text-gray-400 leading-tight">{hint}</span>}
    </div>
  );
}

/** Responsive grid wrapper for StatCards. */
export function StatCardGrid({ children, cols = 4 }: { children: ReactNode; cols?: 2 | 3 | 4 }) {
  const colClass = cols === 2 ? 'sm:grid-cols-2'
    : cols === 3 ? 'sm:grid-cols-2 lg:grid-cols-3'
    : 'sm:grid-cols-2 lg:grid-cols-4';
  return <div className={`grid grid-cols-1 ${colClass} gap-2`}>{children}</div>;
}

/** A titled white card that wraps tables / content blocks. */
export function SectionCard({
  title, subtitle, actions, children, className = '',
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`rounded-lg border border-gray-200 bg-white shadow-sm ${className}`}>
      {(title || actions) && (
        <div className="flex items-center justify-between gap-3 px-3 py-2 border-b border-gray-100">
          <div>
            {title && <h3 className="text-xs font-semibold text-gray-900">{title}</h3>}
            {subtitle && <p className="text-[11px] text-gray-500 mt-0.5">{subtitle}</p>}
          </div>
          {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
        </div>
      )}
      {children}
    </div>
  );
}

const chipTone: Record<string, string> = {
  open:            'bg-blue-100 text-blue-700',
  closed:          'bg-gray-200 text-gray-700',
  paid:            'bg-green-50 text-green-700',
  partial:         'bg-amber-100 text-amber-800',
  overpaid:        'bg-purple-100 text-purple-800',
  payment_pending: 'bg-yellow-100 text-yellow-800',
  filed:           'bg-green-100 text-green-700',
  overdue:         'bg-red-100 text-red-700',
  reported:        'bg-green-100 text-green-700',
  recorded:        'bg-blue-100 text-blue-700',
  waiting:         'bg-orange-100 text-orange-700',
  uploaded:        'bg-blue-100 text-blue-700',
  generated:       'bg-indigo-100 text-indigo-700',
  missing:         'bg-orange-100 text-orange-700',
  reconciled:      'bg-green-100 text-green-700',
  posted:          'bg-blue-100 text-blue-700',
  draft:           'bg-gray-100 text-gray-600',
};

/**
 * Accountant-facing label for the engine-derived payment_status
 * (vw_tax_period_status). Register, Calendar and the Record Tax Payment
 * dialog must all use this same mapping — never raw internal values.
 */
export function paymentStatusLabel(status: string | null | undefined): string {
  switch ((status ?? '').toLowerCase()) {
    case 'closed':          return 'Closed';
    case 'filed':           return 'Filed';
    case 'paid':            return 'Paid';
    case 'partial':         return 'Partial';
    case 'overpaid':        return 'Overpaid';
    case 'overdue':         return 'Overdue';
    case 'payment_pending': return 'Payment Pending';
    case 'open':            return 'Open';
    default:                return status ? status.replace(/_/g, ' ') : '—';
  }
}

/** One accountant-facing payment status shared by Register and payment UI. */
export function taxPaymentBusinessStatus(args: {
  paymentStatus?: string | null;
  totalAmount?: number | null;
  paidAmount?: number | null;
  outstandingAmount?: number | null;
}): string {
  const outstanding = Number(args.outstandingAmount ?? 0);
  const paid = Number(args.paidAmount ?? 0);
  const total = Number(args.totalAmount ?? (paid + outstanding));
  if (args.paymentStatus === 'closed' || args.paymentStatus === 'filed') return args.paymentStatus;
  if (paid > total + 0.01) return 'overpaid';
  // A zero/empty aggregate is not evidence of settlement. "Paid" requires
  // both a real liability and no remaining balance.
  if (total > 0.01 && outstanding <= 0.01) return 'paid';
  if (paid > 0.01) return 'partial';
  return args.paymentStatus === 'overdue' ? 'overdue' : 'open';
}

/** Colored status pill; falls back to neutral gray for unknown statuses. */
export function StatusChip({ status }: { status: string | null | undefined }) {
  const key = (status ?? '').toLowerCase();
  const cls = chipTone[key] ?? 'bg-gray-100 text-gray-600';
  const label = key === 'generated' || key === 'missing' ? 'Waiting for Faktur'
    : key === 'uploaded' ? 'Recorded'
    : status ? status.replace(/_/g, ' ') : '—';
  return (
    <span className={`inline-block text-[11px] px-2 py-0.5 rounded-full font-medium capitalize ${cls}`}>
      {label}
    </span>
  );
}

/** Friendly empty-state block with optional guidance text. */
export function EmptyState({ icon, title, hint }: { icon?: ReactNode; title: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center justify-center text-center gap-1.5 py-8 px-4">
      {icon && <div className="text-gray-300">{icon}</div>}
      <p className="text-sm font-medium text-gray-600">{title}</p>
      {hint && <p className="text-xs text-gray-400 max-w-md">{hint}</p>}
    </div>
  );
}

export { toIDR };
