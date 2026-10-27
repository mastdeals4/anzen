import React from 'react';
import { Search, RefreshCw, X, SlidersHorizontal } from 'lucide-react';

interface EnquiryControlCenterToolbarProps {
  search: string;
  onSearchChange: (value: string) => void;
  pageSize: number;
  onPageSizeChange: (size: number) => void;
  onRefresh: () => void;
  onOpenIndiaQueue?: () => void;
  loading: boolean;
  totalCount: number;
  filteredCount: number;
  activeFilterLabel: string;
}

export const EnquiryControlCenterToolbar: React.FC<EnquiryControlCenterToolbarProps> = ({
  search,
  onSearchChange,
  pageSize,
  onPageSizeChange,
  onRefresh,
  onOpenIndiaQueue,
  loading,
  totalCount,
  filteredCount,
  activeFilterLabel,
}) => {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 bg-white p-2.5 rounded-lg border border-gray-200 shadow-sm">
      {/* Search Input */}
      <div className="flex-1 min-w-[240px] max-w-md relative">
        <div className="absolute inset-y-0 left-0 pl-2.5 flex items-center pointer-events-none text-gray-400">
          <Search className="w-4 h-4" />
        </div>
        <input name="search" aria-label="Search enquiry #, company, or product..."
          type="text"
          value={search}
          onChange={e => onSearchChange(e.target.value)}
          placeholder="Search enquiry #, company, or product..."
          className="w-full pl-9 pr-8 py-1.5 bg-gray-50 border border-gray-300 rounded-md text-xs text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:bg-white transition"
        />
        {search && (
          <button
            type="button"
            onClick={() => onSearchChange('')}
            className="absolute inset-y-0 right-0 pr-2.5 flex items-center text-gray-400 hover:text-gray-600"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {/* Right Controls */}
      <div className="flex items-center gap-3 text-xs text-gray-600">
        {/* Status Count Indicator */}
        <div className="hidden sm:flex items-center gap-1.5 text-gray-500">
          <span className="font-semibold text-gray-800">{filteredCount}</span>
          <span>enquiries in</span>
          <span className="font-medium text-blue-600">[{activeFilterLabel}]</span>
          {totalCount !== filteredCount && (
            <span className="text-gray-400 text-[11px]">({totalCount} total)</span>
          )}
        </div>

        {/* Page Size Selector */}
        <div className="flex items-center gap-1.5">
          <span className="text-gray-400">Show:</span>
          <select name="page_size" aria-label="Page Size"
            value={pageSize}
            onChange={e => onPageSizeChange(Number(e.target.value))}
            className="bg-gray-50 border border-gray-300 rounded px-2 py-1 text-xs text-gray-700 focus:outline-none focus:ring-1 focus:ring-blue-500"
          >
            <option value={25}>25 / page</option>
            <option value={50}>50 / page</option>
            <option value={100}>100 / page</option>
          </select>
        </div>

        {/* India Daily Queue Button */}
        {onOpenIndiaQueue && (
          <button
            type="button"
            onClick={onOpenIndiaQueue}
            title="Open India Daily Work Queue"
            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded bg-amber-50 hover:bg-amber-100 text-amber-900 font-semibold transition cursor-pointer border border-amber-200 shadow-2xs"
          >
            <span>🇮🇳 India Daily Queue</span>
          </button>
        )}

        {/* Refresh Button */}
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          title="Refresh enquiries"
          className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded bg-gray-100 hover:bg-gray-200 text-gray-700 font-medium transition cursor-pointer border border-gray-200"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin text-blue-600' : ''}`} />
          <span className="hidden sm:inline">Refresh</span>
        </button>
      </div>
    </div>
  );
};
