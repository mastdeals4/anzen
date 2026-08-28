import { ReactNode } from 'react';
import {
  TYPE_TITLE, TYPE_HEAD, TYPE_LABEL, TYPE_VALUE, TYPE_NUM, TYPE_MUTED,
} from './uiTokens';

/**
 * FinancePage — the ONE shared layout for every Finance screen.
 *
 * Every page in the Finance module (Purchase, Payment, Receipt, Contra,
 * Expenses, Petty Cash, Journal, Ledger, Bank Ledger, Party Ledger, Bank
 * Reconciliation, Reports, Payables, Receivables) must render its content
 * through this component. That way there is genuinely ONE header, ONE
 * toolbar slot, ONE filter row and ONE table wrapper across the whole
 * module — not many pages tuned to look alike.
 *
 * Rules
 *   • No page may render its own outer wrapper, gradient KPI card, or
 *     top-level headings. Everything is a slot on this component.
 *   • Slots are optional. Pass only what your page needs; the others
 *     collapse to zero height. That's how Ledger (no KPIs) and Payment
 *     (KPIs + toolbar + filters + table) share a single skeleton.
 *   • All heights are fixed — never bigger, never smaller. If your page
 *     needs a taller header, that's a token change in uiTokens.ts, not
 *     an override here.
 *
 * Anatomy (top to bottom)
 *
 *   ┌─────────────────────────────────────────────────┐
 *   │ Title strip                    Primary actions  │  h-8
 *   ├─────────────────────────────────────────────────┤
 *   │ KPI 1     KPI 2     KPI 3     KPI 4             │  h-11 (only if provided)
 *   ├─────────────────────────────────────────────────┤
 *   │ Toolbar row (search · filters · buttons)        │  h-8 (only if provided)
 *   ├─────────────────────────────────────────────────┤
 *   │ Chip filter strip                               │  h-6 (only if provided)
 *   ├─────────────────────────────────────────────────┤
 *   │                                                 │
 *   │ Table / content                                 │  fills remainder
 *   │                                                 │
 *   └─────────────────────────────────────────────────┘
 *
 * Titles / actions are TYPE_TITLE; KPI captions are TYPE_LABEL; KPI values
 * are TYPE_NUM; content chrome (headers of sections) uses TYPE_HEAD.
 */

export interface KPI {
  label: string;
  value: ReactNode;
  /** Optional color hint for the value. Use sparingly — most KPIs are neutral. */
  tint?: 'default' | 'danger' | 'success' | 'warning' | 'info';
}

interface FinancePageProps {
  title: string;
  /** Optional subtitle rendered next to the title in TYPE_MUTED. */
  subtitle?: string;
  /** Primary action buttons rendered in the header (right side). */
  actions?: ReactNode;
  /** KPI strip. When empty the strip collapses. */
  kpis?: KPI[];
  /** Toolbar contents — search, dropdown filters, export, etc. */
  toolbar?: ReactNode;
  /** Optional chip / quick-filter strip below the toolbar. */
  chips?: ReactNode;
  /** Main content — usually a table. */
  children: ReactNode;
}

const TINT_TEXT: Record<NonNullable<KPI['tint']>, string> = {
  default: 'text-gray-900',
  danger:  'text-red-700',
  success: 'text-green-700',
  warning: 'text-orange-700',
  info:    'text-blue-700',
};

export function FinancePage({ title, subtitle, actions, kpis, toolbar, chips, children }: FinancePageProps) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex min-h-14 items-center justify-between gap-4 px-4 py-2 bg-white border border-gray-200 rounded-lg">
        <div className="flex items-baseline gap-2 min-w-0">
          <h1 className={`${TYPE_TITLE} truncate`}>{title}</h1>
          {subtitle && <span className={`${TYPE_MUTED} truncate`}>{subtitle}</span>}
        </div>
        {actions && (
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">{actions}</div>
        )}
      </div>

      {/* KPI strip — only when kpis provided */}
      {kpis && kpis.length > 0 && (
        <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${kpis.length}, minmax(0, 1fr))` }}>
          {kpis.map((k, i) => (
            <div key={i} className="border border-gray-200 rounded-lg bg-white px-4 py-3">
              <div className={`${TYPE_LABEL} mb-1`}>{k.label}</div>
              <div className={`${TYPE_NUM} text-left text-xl font-semibold ${TINT_TEXT[k.tint ?? 'default']}`}>{k.value}</div>
            </div>
          ))}
        </div>
      )}

      {/* Toolbar — only when provided */}
      {toolbar && (
        <div className="flex min-h-14 flex-wrap items-center gap-2 px-4 py-2 bg-white border border-gray-200 rounded-lg">
          {toolbar}
        </div>
      )}

      {/* Chip strip — only when provided */}
      {chips && (
        <div className="flex flex-wrap items-center gap-2 px-1">
          {chips}
        </div>
      )}

      {/* Content — usually a table. Owning page provides its own <Table>. */}
      <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
        {children}
      </div>
    </div>
  );
}

// ─── Re-exports for callers — one import gives them everything ────────────
export { TYPE_TITLE, TYPE_HEAD, TYPE_LABEL, TYPE_VALUE, TYPE_NUM, TYPE_MUTED };
