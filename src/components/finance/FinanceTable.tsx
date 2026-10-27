import { ReactNode, useState, Fragment } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { TYPE_LABEL, TYPE_NUM, TYPE_MUTED, TYPE_VALUE } from './uiTokens';

/**
 * FinanceTable — the ONE table used by every Finance list page.
 *
 * All row heights, header height, cell padding, hover, selected style,
 * amount alignment, action-column layout live here. Pages define
 * columns + rows and pass the data; they never touch <table> markup.
 *
 * Column contract
 *   • header  — string shown in <th>
 *   • cell    — function taking the row, returning the cell contents
 *   • align   — 'left' (default) | 'right' (numbers) | 'center' (actions)
 *   • width   — optional Tailwind width class (e.g. 'w-24', 'w-40')
 *
 * For rows that expand inline (Payments → paid invoices) pass
 * `expandable={row => ({ label, content })}`. When `label` is truthy
 * a disclosure chip appears in that row's expand cell; clicking the
 * chip renders `content` directly under the row spanning all columns.
 *
 * The table height / row height / padding never change per-caller.
 */

export interface Column<T> {
  header: string;
  cell: (row: T, i: number) => ReactNode;
  align?: 'left' | 'right' | 'center';
  width?: string;
  className?: string;
}

interface FinanceTableProps<T> {
  columns: Column<T>[];
  rows: T[];
  /** Called with (row, i) — pass a stable key. */
  rowKey: (row: T, i: number) => string;
  /** Rendered when rows is empty. */
  empty?: ReactNode;
  /** Selected-row highlight. */
  isSelected?: (row: T, i: number) => boolean;
  onRowClick?: (row: T, i: number) => void;
  /** Optional inline-expansion. Return `{ label, content }` or null. */
  expandable?: (row: T, i: number) => { label: ReactNode; content: ReactNode } | null;
  /** Optional totals row rendered at the bottom. */
  footer?: ReactNode;
  /** Extra class(es) on the <table> — usually omitted. */
  className?: string;
  loading?: boolean;
}

export function FinanceTable<T>({
  columns, rows, rowKey, empty, isSelected, onRowClick, expandable, footer, className = '', loading,
}: FinanceTableProps<T>) {
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const totalCols = columns.length + (expandable ? 1 : 0);

  const alignCls = (a?: 'left' | 'right' | 'center') =>
    a === 'right' ? 'text-right' : a === 'center' ? 'text-center' : 'text-left';

  return (
    <div className="overflow-x-auto">
      <table className={`w-full text-sm border-collapse ${className}`}>
        <thead className="bg-gray-50 border-b border-gray-200 sticky top-0 z-10">
          <tr className="h-11">
            {expandable && <th className="w-6" />}
            {columns.map((c, i) => (
              <th
                key={i}
                className={`px-3 py-2 ${alignCls(c.align)} text-xs font-semibold text-gray-600 uppercase tracking-wide whitespace-nowrap ${c.width ?? ''}`}
              >
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <tr><td colSpan={totalCols} className="py-8 text-center text-xs text-gray-400">Loading…</td></tr>
          ) : rows.length === 0 ? (
            <tr><td colSpan={totalCols} className="py-8 text-center text-xs text-gray-400">{empty ?? 'No data'}</td></tr>
          ) : (
            rows.map((r, i) => {
              const key = rowKey(r, i);
              const sel = isSelected?.(r, i);
              const expansion = expandable?.(r, i);
              const isExpanded = expansion && expandedKey === key;
              return (
                <Fragment key={key}>
                  <tr
                    onClick={() => onRowClick?.(r, i)}
                    className={`min-h-11 border-b border-gray-100 transition-colors ${
                      sel ? 'bg-blue-50 hover:bg-blue-100' : 'hover:bg-blue-50/40'
                    } ${onRowClick ? 'cursor-pointer' : ''}`}
                  >
                    {expandable && (
                      <td className="px-1 text-center">
                        {expansion?.label ? (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setExpandedKey(isExpanded ? null : key);
                            }}
                            className="inline-flex items-center gap-0.5 h-5 px-1 rounded text-[10px] font-semibold text-blue-700 hover:bg-blue-100"
                            title={isExpanded ? 'Collapse' : 'Expand'}
                          >
                            {isExpanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                            {expansion.label}
                          </button>
                        ) : null}
                      </td>
                    )}
                    {columns.map((c, ci) => (
                      <td
                        key={ci}
                        className={`px-3 py-2 ${alignCls(c.align)} ${c.align === 'right' ? TYPE_NUM.replace('text-right ', '') : TYPE_VALUE} ${c.className ?? ''}`}
                      >
                        {c.cell(r, i)}
                      </td>
                    ))}
                  </tr>
                  {isExpanded && expansion && (
                    <tr className="bg-blue-50/30 border-b border-blue-100">
                      <td colSpan={totalCols} className="px-6 py-2">
                        {expansion.content}
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })
          )}
        </tbody>
        {footer && (
          <tfoot className="bg-gray-50 border-t-2 border-gray-200">
            {footer}
          </tfoot>
        )}
      </table>
    </div>
  );
}

// Small pre-styled cells so callers don't reinvent number/date/badge cells.
export const NumCell = ({ children }: { children: ReactNode }) => (
  <span className="font-mono tabular-nums">{children}</span>
);

export const MutedCell = ({ children }: { children: ReactNode }) => (
  <span className={TYPE_MUTED}>{children}</span>
);

export const LabelCell = ({ children }: { children: ReactNode }) => (
  <span className={TYPE_LABEL}>{children}</span>
);
