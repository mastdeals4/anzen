import React from 'react';
import { ArrowUpDown, ChevronLeft, ChevronRight, Loader2, Inbox } from 'lucide-react';
import { EnquiryControlCenterRow as RowModel } from '../../../types/enquiry/controlCenter.types.ts';
import { EnquiryControlCenterRow } from './EnquiryControlCenterRow';
import { DropdownOption } from './InlineEditDropdown';

interface EnquiryControlCenterTableProps {
  rows: RowModel[];
  loading: boolean;
  selectedRowId: string | null;
  onSelectRow: (row: RowModel) => void;
  onRefresh: () => void;
  page: number;
  pageSize: number;
  totalPages: number;
  totalCount: number;
  onPageChange: (newPage: number) => void;
  sortBy: string;
  sortDirection: 'asc' | 'desc';
  onSortChange: (column: any) => void;
  userOptions: DropdownOption[];
  priorityOptions: DropdownOption[];
  canManage?: boolean;
}

export const EnquiryControlCenterTable: React.FC<EnquiryControlCenterTableProps> = ({
  rows,
  loading,
  selectedRowId,
  onSelectRow,
  onRefresh,
  page,
  pageSize,
  totalPages,
  totalCount,
  onPageChange,
  sortBy,
  sortDirection,
  onSortChange,
  userOptions,
  priorityOptions,
  canManage = true,
}) => {
  const renderSortIcon = (column: string) => {
    if (sortBy !== column) {
      return <ArrowUpDown className="w-3 h-3 text-gray-400 opacity-0 group-hover:opacity-100 transition" />;
    }
    return (
      <span className="text-blue-600 font-bold text-xs">
        {sortDirection === 'asc' ? '↑' : '↓'}
      </span>
    );
  };

  return (
    <div className="bg-white rounded-lg border border-gray-200 shadow-sm overflow-hidden flex flex-col">
      {/* Table Scroll Container */}
      <div className="overflow-x-auto overflow-y-auto max-h-[calc(100vh-280px)]">
        <table className="w-full text-left border-collapse">
          <thead className="bg-gray-100 sticky top-0 z-20 text-[11px] text-gray-600 uppercase tracking-wider font-semibold border-b border-gray-300">
            <tr>
              {/* 1. ENQ */}
              <th
                onClick={() => onSortChange('inquiry_number')}
                className="px-3 py-2.5 border-r border-gray-300 whitespace-nowrap cursor-pointer hover:bg-gray-200 transition group select-none"
              >
                <div className="flex items-center gap-1">
                  <span>ENQ #</span>
                  {renderSortIcon('inquiry_number')}
                </div>
              </th>

              {/* 2. AGE */}
              <th
                onClick={() => onSortChange('inquiry_date')}
                className="px-2.5 py-2.5 border-r border-gray-300 whitespace-nowrap cursor-pointer hover:bg-gray-200 transition group select-none"
              >
                <div className="flex items-center gap-1">
                  <span>Age</span>
                  {renderSortIcon('inquiry_date')}
                </div>
              </th>

              {/* 3. CUSTOMER */}
              <th className="px-3 py-2.5 border-r border-gray-300 whitespace-nowrap">
                Customer / Prospect
              </th>

              {/* 4. PRODUCT */}
              <th className="px-3 py-2.5 border-r border-gray-300 whitespace-nowrap">
                Product
              </th>

              {/* 5. CUSTOMER NEED */}
              <th className="px-3 py-2.5 border-r border-gray-300 whitespace-nowrap">
                Customer Need
              </th>

              {/* 6. CURRENT BLOCKER */}
              <th className="px-3 py-2.5 border-r border-gray-300 whitespace-nowrap">
                Current Blocker
              </th>

              {/* 7. WAITING FOR */}
              <th className="px-2.5 py-2.5 border-r border-gray-300 whitespace-nowrap">
                Waiting For
              </th>

              {/* 8. NEXT ACTION */}
              <th className="px-3 py-2.5 border-r border-gray-300 whitespace-nowrap">
                Next Action
              </th>

              {/* 9. OWNER */}
              <th className="px-2.5 py-2.5 border-r border-gray-300 whitespace-nowrap">
                Owner
              </th>

              {/* 10. REQUESTS */}
              <th className="px-2.5 py-2.5 border-r border-gray-300 whitespace-nowrap">
                Requests
              </th>

              {/* 11. STATUS */}
              <th className="px-2.5 py-2.5 whitespace-nowrap">
                Pipeline Stage
              </th>
            </tr>
          </thead>

          <tbody className="divide-y divide-gray-200">
            {loading && rows.length === 0 ? (
              <tr>
                <td colSpan={11} className="py-12 text-center text-gray-500 text-xs">
                  <div className="flex flex-col items-center justify-center gap-2">
                    <Loader2 className="w-6 h-6 animate-spin text-blue-600" />
                    <span>Loading enquiries...</span>
                  </div>
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={11} className="py-12 text-center text-gray-400 text-xs">
                  <div className="flex flex-col items-center justify-center gap-2">
                    <Inbox className="w-8 h-8 text-gray-300" />
                    <span className="font-medium text-gray-600">No enquiries match the active criteria.</span>
                    <span className="text-[11px] text-gray-400">Try adjusting your search query or filter pill.</span>
                  </div>
                </td>
              </tr>
            ) : (
              rows.map(row => (
                <EnquiryControlCenterRow
                  key={row.id}
                  row={row}
                  isSelected={selectedRowId === row.id}
                  onSelect={onSelectRow}
                  onRefresh={onRefresh}
                  userOptions={userOptions}
                  priorityOptions={priorityOptions}
                  canManage={canManage}
                />
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination Footer */}
      <div className="px-4 py-2.5 bg-gray-50 border-t border-gray-200 flex flex-wrap items-center justify-between gap-3 text-xs text-gray-600">
        <div>
          Showing <span className="font-semibold text-gray-800">{rows.length > 0 ? (page - 1) * pageSize + 1 : 0}</span> to{' '}
          <span className="font-semibold text-gray-800">{Math.min(page * pageSize, totalCount)}</span> of{' '}
          <span className="font-semibold text-gray-800">{totalCount}</span> total enquiries
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={page <= 1 || loading}
            onClick={() => onPageChange(page - 1)}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-white border border-gray-300 hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed transition font-medium text-gray-700 cursor-pointer shadow-xs"
          >
            <ChevronLeft className="w-3.5 h-3.5" />
            <span>Prev</span>
          </button>

          <span className="px-2 font-medium text-gray-700">
            Page {page} of {Math.max(1, totalPages)}
          </span>

          <button
            type="button"
            disabled={page >= totalPages || loading}
            onClick={() => onPageChange(page + 1)}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-white border border-gray-300 hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed transition font-medium text-gray-700 cursor-pointer shadow-xs"
          >
            <span>Next</span>
            <ChevronRight className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
};
