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
  const { t } = useLanguage();

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
          <Search className={`absolute left-3 top-1/2 -translate-y-1/2 ${compact ? 'w-4 h-4' : 'w-5 h-5'} text-gray-400`} />
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder={t('common.search')}
            className={`w-full pl-9 pr-3 ${compact ? 'py-1.5 text-sm' : 'py-2'} border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none`}
          />
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className={tableClassName || 'w-full'}>
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              {columns.map((column) => (
                <th
                  key={column.key}
                  className={`${compact ? 'px-3 py-2' : 'px-6 py-3'} text-left text-xs font-medium text-gray-500 uppercase tracking-wider ${column.thClassName || ''}`}
                >
                  {column.sortable ? (
                    <button
                      onClick={() => handleSort(column.key)}
                      className="flex items-center gap-1 hover:text-gray-700"
                    >
                      {column.label}
                      {sortConfig?.key === column.key ? (
                        sortConfig.direction === 'asc' ? (
                          <ChevronUp className="w-4 h-4" />
                        ) : (
                          <ChevronDown className="w-4 h-4" />
                        )
                      ) : (
                        <ChevronDown className="w-4 h-4 opacity-30" />
                      )}
                    </button>
                  ) : (
                    column.label
                  )}
                </th>
              ))}
              {actions && (
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  {t('common.actions')}
                </th>
              )}
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {filteredAndSortedData.length === 0 ? (
              <tr>
                <td
                  colSpan={columns.length + (actions ? 1 : 0)}
                  className={`${compact ? 'px-3 py-5' : 'px-6 py-8'} text-center text-gray-500`}
                >
                  {t('common.noData')}
                </td>
              </tr>
            ) : (
              filteredAndSortedData.map((item, index) => (
                <tr
                  key={index}
                  onClick={() => onRowClick?.(item)}
                  className={onRowClick ? 'cursor-pointer hover:bg-gray-50' : ''}
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
                      <td key={column.key} className={`${compact ? 'px-3 py-2' : 'px-6 py-4'} whitespace-nowrap text-sm text-gray-900 ${column.tdClassName || ''}`}>
                        {rendered}
                      </td>
                    );
                  })}
                  {actions && (
                    <td className={`${compact ? 'px-2 py-2' : 'px-6 py-4'} whitespace-nowrap text-sm`}>
                      {actions(item)}
                    </td>
                  )}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
