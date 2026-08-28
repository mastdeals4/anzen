import { useEffect, ReactNode, useId } from 'react';
import { X } from 'lucide-react';

/**
 * FinanceModal — the ONE dialog used by every Finance Add / Edit / View.
 *
 * Purpose
 *   Enforce ERP-grade density (SAP Business One / Tally Prime / Dynamics NAV
 *   / Odoo Accounting) on every finance dialog with a single import. Do NOT
 *   use the app-wide `../Modal` inside finance — it targets CRM density and
 *   is intentionally roomier.
 *
 * Anatomy (locked)
 *   ┌────────────────────────────────────────────────┐
 *   │ Title                              [X]         │  56px minimum
 *   ├────────────────────────────────────────────────┤
 *   │                                                │
 *   │ p-5 body (20px inset on every side)            │
 *   │                                                │
 *   ├────────────────────────────────────────────────┤
 *   │ optional footer — 64px minimum, right-aligned  │
 *   └────────────────────────────────────────────────┘
 *
 * • Header: 56px minimum, readable semibold title.
 * • Body:   p-5 fixed. If body needs scroll, only body scrolls; header/footer stay pinned.
 * • Footer: optional slot for action buttons — kept out of the scroll region so Save/Cancel
 *   never slide off screen on tall forms.
 *
 * Sizes are Tailwind max-widths. `size="xl"` covers the biggest reference
 * dialogs (Expense with reimbursement lines, Purchase Invoice with items).
 */

interface FinanceModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  /** Optional subtitle rendered in the header — 10px muted. */
  subtitle?: string;
  /** Optional pinned footer (Save / Cancel / etc). */
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl' | '2xl';
  /** Pass a Tailwind max-w-* to override the size preset. */
  maxWidth?: string;
  /** Compatibility prop for legacy Finance dialogs; standard body padding is retained. */
  noPadding?: boolean;
  children: ReactNode;
}

const SIZE: Record<NonNullable<FinanceModalProps['size']>, string> = {
  sm:  'max-w-md',
  md:  'max-w-2xl',
  lg:  'max-w-4xl',
  xl:  'max-w-5xl',
  '2xl': 'max-w-6xl',
};

export function FinanceModal({
  isOpen, onClose, title, subtitle, footer, size = 'md', maxWidth, children,
}: FinanceModalProps) {
  const titleId = useId();
  useEffect(() => {
    if (!isOpen) return;
    const handleEscape = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen, onClose]);

  if (!isOpen) return null;
  const widthClass = maxWidth || SIZE[size];

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto">
      <div className="flex min-h-screen items-center justify-center p-4">
        <div className="fixed inset-0 bg-gray-900/50" onClick={onClose} />
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          className={`relative bg-white rounded-lg shadow-xl border border-gray-300 w-full ${widthClass} max-h-[92vh] flex flex-col`}
        >
          <div className="flex min-h-12 items-center justify-between gap-4 px-4 py-2.5 border-b border-gray-200 bg-gray-50 flex-shrink-0">
            <div className="flex items-baseline gap-2 min-w-0">
              <h3 id={titleId} className="text-[15px] font-semibold text-gray-900 truncate">{title}</h3>
              {subtitle && <span className="text-[11px] text-gray-500 truncate">{subtitle}</span>}
            </div>
            <button
              type="button"
              onClick={onClose}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md hover:bg-gray-200"
              title="Close"
              aria-label="Close"
            >
              <X className="w-4 h-4 text-gray-500" />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-3">
            {children}
          </div>

          {/* Footer — pinned so Save / Cancel never scrolls off */}
          {footer && (
            <div className="flex min-h-14 items-center justify-end gap-2 px-4 py-2.5 border-t border-gray-200 bg-gray-50 flex-shrink-0">
              {footer}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
