import { useState } from 'react';
import { Search, ChevronUp, ChevronDown } from 'lucide-react';
import { useLanguage } from '../contexts/LanguageContext';

interface Column<T> {
  key: string;
  label: string;
  render?: ((value: any, item: T) => React.ReactNode) | ((item: T) => React.ReactNode);
  sortable?: boolean;
  thClassName?: string;
  tdClassName?: string;
}

interface DataTableProps<T> {
  data: T[];
  columns: Column<T>[];
  onRowClick?: (item: T) => void;
  actions?: (item: T) => React.ReactNode;
  loading?: boolean;
  tableClassName?: string;
  compact?: boolean;
}

export function DataTable<T extends object>({
  data,
  columns,
  onRowClick,
  actions,
  loading,
  tableClassName,
  compact = false,
}: DataTableProps<T>) {
  const [searchTerm, setSearchTerm] = useState('');
  const [sortConfig, setSortConfig] = useState<{ key: string; direction: 'asc' | 'desc' } | null>(
    null
  );
  const [expandedRows, setExpandedRows] = useState<Set<number>>(new Set());
  const { t } = useLanguage();

  const toggleExpand = (index: number) => {
    setExpandedRows(prev => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const handleSort = (key: string) => {
    let direction: 'asc' | 'desc' = 'asc';
    if (sortConfig?.key === key && sortConfig.direction === 'asc') {
      direction = 'desc';
    }
    setSortConfig({ key, direction });
  };

  const getValue = (item: T, key: string): unknown =>
    (item as Record<string, unknown>)[key];

  const getSearchableValues = (obj: T): string[] => {
    const values: string[] = [];

    const extractValues = (value: unknown) => {
      if (value === null || value === undefined) {
        return;
      }

      if (typeof value === 'object' && !Array.isArray(value)) {
        Object.values(value).forEach(extractValues);
      } else if (Array.isArray(value)) {
        value.forEach(extractValues);
      } else {
        values.push(String(value));
      }
    };

    Object.values(obj as Record<string, unknown>).forEach(extractValues);
    return values;
  };

  const filteredAndSortedData = (() => {
    let result = [...data];

    if (searchTerm) {
      result = result.filter((item) =>
        getSearchableValues(item).some((value) =>
          value.toLowerCase().includes(searchTerm.toLowerCase())
        )
      );
    }

    if (sortConfig) {
      result.sort((a, b) => {
        const aValue = getValue(a, sortConfig.key);
        const bValue = getValue(b, sortConfig.key);
        const aComparable = typeof aValue === 'number' || typeof aValue === 'string'
          ? aValue
          : String(aValue ?? '');
        const bComparable = typeof bValue === 'number' || typeof bValue === 'string'
          ? bValue
          : String(bValue ?? '');

        if (aComparable < bComparable) return sortConfig.direction === 'asc' ? -1 : 1;
        if (aComparable > bComparable) return sortConfig.direction === 'asc' ? 1 : -1;
        return 0;
      });
    }

    return result;
  })();

  if (loading) {
    return (
      <div className="bg-white rounded-lg shadow">
        <div className="p-8 text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto" />
          <p className="mt-4 text-gray-600">{t('common.loading')}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-lg shadow">
      <div className={`${compact ? 'p-2' : 'p-4'} border-b border-gray-200`}>
        <div className="relative">
          <Search className={`absolute left-3 top-1/2 -translate-y-1/2 ${compact ? 'w-4 h-4' : 'w-4 h-4'} text-gray-400 pointer-events-none`} />
          <input
            type="text"
            id="datatable-search-input"
            name="search"
            aria-label={t('common.search') || 'Search table'}
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder={t('common.search')}
            autoComplete="off"
            style={{ paddingLeft: '2.5rem' }}
            className={`w-full pr-3 ${compact ? 'py-1.5 text-xs' : 'py-2 text-sm'} border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none`}
          />
        </div>
      </div>

      {/* Desktop Table View (>= 768px) */}
      <div className="hidden md:block overflow-x-auto">
        <table className={tableClassName || 'w-full'}>
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              {columns.map((column) => (
                <th
                  key={column.key}
                  className={`${compact ? 'px-2.5 py-1.5' : 'px-3.5 py-2'} text-left text-[11px] font-semibold text-gray-500 uppercase tracking-wider ${column.thClassName || ''}`}
                >
                  {column.sortable ? (
                    <button
                      onClick={() => handleSort(column.key)}
                      className="flex items-center gap-1 hover:text-gray-700"
                    >
                      {column.label}
                      {sortConfig?.key === column.key ? (
                        sortConfig.direction === 'asc' ? (
                          <ChevronUp className="w-3.5 h-3.5" />
                        ) : (
                          <ChevronDown className="w-3.5 h-3.5" />
                        )
                      ) : (
                        <ChevronDown className="w-3.5 h-3.5 opacity-30" />
                      )}
                    </button>
                  ) : (
                    column.label
                  )}
                </th>
              ))}
              {actions && (
                <th className={`${compact ? 'px-2.5 py-1.5' : 'px-3.5 py-2'} text-left text-[11px] font-semibold text-gray-500 uppercase tracking-wider`}>
                  {t('common.actions')}
                </th>
              )}
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-100">
            {filteredAndSortedData.length === 0 ? (
              <tr>
                <td
                  colSpan={columns.length + (actions ? 1 : 0)}
                  className="px-4 py-8 text-center text-xs text-gray-500"
                >
                  {t('common.noData')}
                </td>
              </tr>
            ) : (
              filteredAndSortedData.map((item, index) => (
                <tr
                  key={index}
                  onClick={() => onRowClick?.(item)}
                  className={`transition-colors ${onRowClick ? 'cursor-pointer hover:bg-slate-50' : 'hover:bg-slate-50/60'}`}
                >
                  {columns.map((column) => {
                    const value = getValue(item, column.key);
                    const rendered = column.render
                      ? column.render.length >= 2
                        ? (column.render as (cellValue: unknown, row: T) => React.ReactNode)(value, item)
                        : (column.render as (row: T) => React.ReactNode)(item)
                      : value == null || typeof value === 'boolean'
                        ? String(value ?? '')
                        : typeof value === 'string' || typeof value === 'number'
                          ? value
                          : JSON.stringify(value);
                    return (
                      <td key={column.key} className={`${compact ? 'px-2.5 py-1.5 text-xs' : 'px-3.5 py-2 text-xs sm:text-sm'} whitespace-nowrap text-gray-900 ${column.tdClassName || ''}`}>
                        {rendered}
                      </td>
                    );
                  })}
                  {actions && (
                    <td className={`${compact ? 'px-2 py-1.5' : 'px-3 py-2'} whitespace-nowrap text-xs`}>
                      {actions(item)}
                    </td>
                  )}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Mobile App-Style Card View (< 768px) - High Density 3-Line Format */}
      <div className="block md:hidden p-2 space-y-1.5">
        {filteredAndSortedData.length === 0 ? (
          <div className="p-8 text-center text-xs text-gray-500">
            {t('common.noData')}
          </div>
        ) : (
          filteredAndSortedData.map((item, index) => {
            // Intelligent semantic slot detection
            const idCol = columns.find(c => /(?:invoice|so|challan|voucher|order|doc|ref|ticket)[-_]?number|^(?:invoice|so|challan|voucher|order|doc)[-_]?no$/i.test(c.key)) || columns[0];
            const rawId = getValue(item, idCol.key);
            const primaryVal = (typeof rawId === 'string' || typeof rawId === 'number') && rawId 
              ? String(rawId) 
              : (idCol ? (idCol.render ? (idCol.render.length >= 2 ? (idCol.render as any)(rawId, item) : (idCol.render as any)(item)) : String(rawId ?? '')) : '');
            
            const statusCol = columns.find(c => c !== idCol && /status|approval|active|state/i.test(c.key));
            const partyCol = columns.find(c => c !== idCol && c !== statusCol && /customer|supplier|party|contact|vendor|driver|company|name|title|product|category/i.test(c.key));
            const dateCol = columns.find(c => c !== idCol && c !== statusCol && c !== partyCol && /date|time/i.test(c.key));
            const amountCol = columns.find(c => c !== idCol && c !== statusCol && /amount|total|price|balance|revenue/i.test(c.key));
            const metricCol = columns.find(c => c !== idCol && c !== statusCol && c !== amountCol && /balance|paid|stock|quantity|qty|items/i.test(c.key));

            // Secondary columns for expandable drawer
            const usedKeys = new Set([idCol?.key, statusCol?.key, partyCol?.key, dateCol?.key, amountCol?.key, metricCol?.key].filter(Boolean));
            const secondaryCols = columns.filter(c => !usedKeys.has(c.key));
            const isExpanded = expandedRows.has(index);

            const renderCol = (col?: Column<T>) => {
              if (!col) return null;
              const value = getValue(item, col.key);
              return col.render
                ? col.render.length >= 2
                  ? (col.render as any)(value, item)
                  : (col.render as any)(item)
                : value == null || typeof value === 'boolean'
                  ? String(value ?? '')
                  : typeof value === 'string' || typeof value === 'number'
                    ? value
                    : JSON.stringify(value);
            };

            return (
              <div
                key={index}
                onClick={() => {
                  if (onRowClick) onRowClick(item);
                  else if (secondaryCols.length > 0) toggleExpand(index);
                }}
                className={`bg-white rounded-xl border border-slate-200/90 p-2.5 space-y-1 shadow-2xs hover:border-slate-300 transition active:scale-[0.99] ${
                  onRowClick ? 'cursor-pointer active:bg-slate-50' : ''
                }`}
              >
                {/* Line 1: Primary identifier + Status badge */}
                <div className="flex items-center justify-between gap-1.5">
                  <span className="font-mono font-bold text-xs text-gray-900 shrink-0">
                    {primaryVal}
                  </span>
                  {statusCol && (
                    <div className="shrink-0 scale-95 origin-right">
                      {renderCol(statusCol)}
                    </div>
                  )}
                </div>

                {/* Line 2: Customer/Supplier/Party + Date */}
                {(partyCol || dateCol) && (
                  <div className="flex items-center justify-between text-xs text-gray-600 gap-2">
                    <div className="font-medium text-gray-800 truncate min-w-0 flex-1">
                      {partyCol ? renderCol(partyCol) : '—'}
                    </div>
                    {dateCol && (
                      <div className="text-[11px] text-gray-400 font-normal shrink-0">
                        {renderCol(dateCol)}
                      </div>
                    )}
                  </div>
                )}

                {/* Line 3: Financial Total / Metric / Summary (Left) + Actions & Expand (Right) */}
                <div className="flex items-center justify-between pt-1 border-t border-slate-100 text-xs gap-2">
                  <div className="flex items-center gap-2 min-w-0 flex-1">
                    {amountCol && (
                      <span className="font-mono font-bold text-xs text-gray-900 truncate">
                        {renderCol(amountCol)}
                      </span>
                    )}
                    {metricCol && (
                      <span className="shrink-0 text-xs font-semibold text-gray-600">
                        {renderCol(metricCol)}
                      </span>
                    )}
                    {!amountCol && !metricCol && secondaryCols.length > 0 && (
                      <span className="text-[11px] text-gray-500 truncate">
                        {renderCol(secondaryCols[0])}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-0.5 shrink-0" onClick={(e) => e.stopPropagation()}>
                    {actions && actions(item)}
                    {secondaryCols.length > 0 && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleExpand(index);
                        }}
                        className="p-1 text-slate-400 hover:text-slate-600 rounded active:bg-slate-100"
                        title={isExpanded ? 'Collapse' : 'Expand'}
                      >
                        <ChevronDown className={`w-3.5 h-3.5 transition-transform duration-200 ${isExpanded ? 'rotate-180' : ''}`} />
                      </button>
                    )}
                  </div>
                </div>

                {/* Expandable Secondary Details Drawer */}
                {isExpanded && secondaryCols.length > 0 && (
                  <div
                    className="grid grid-cols-2 gap-x-2.5 gap-y-1.5 pt-2 mt-1 border-t border-dashed border-slate-200 bg-slate-50/70 p-2 rounded-lg text-xs"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {secondaryCols.map((col) => (
                      <div key={col.key} className="min-w-0">
                        <span className="text-[10px] font-semibold text-gray-400 block truncate uppercase tracking-wider">
                          {col.label}
                        </span>
                        <div className="text-gray-800 text-[11px] font-medium truncate mt-0.5">
                          {renderCol(col)}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
