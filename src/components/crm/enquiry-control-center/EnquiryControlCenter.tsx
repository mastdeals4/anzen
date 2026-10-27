import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { supabase } from '../../../lib/supabase';
import { EnquiryControlCenterService } from '../../../services/enquiry/EnquiryControlCenterService';
import {
  EnquiryControlCenterQueryParams,
  EnquiryControlCenterQueryResult,
  EnquiryControlCenterRow,
} from '../../../types/enquiry/controlCenter.types';
import { EnquiryControlCenterToolbar } from './EnquiryControlCenterToolbar';
import {
  EnquiryControlCenterFilters,
  FilterPillKey,
} from './EnquiryControlCenterFilters';
import { EnquiryControlCenterTable } from './EnquiryControlCenterTable';
import { EnquiryDetailDrawer } from './EnquiryDetailDrawer';
import { DropdownOption } from './InlineEditDropdown';
import { IndiaDailyWorkQueueModal } from './IndiaDailyWorkQueueModal';
import { showToast } from '../../ToastNotification';

interface EnquiryControlCenterProps {
  canManage?: boolean;
}

const PRIORITY_OPTIONS: DropdownOption[] = [
  { value: 'urgent', label: 'Urgent', colorClass: 'text-rose-700 font-bold' },
  { value: 'high', label: 'High', colorClass: 'text-orange-700 font-semibold' },
  { value: 'medium', label: 'Medium', colorClass: 'text-blue-700' },
  { value: 'low', label: 'Low', colorClass: 'text-gray-600' },
];

export const EnquiryControlCenter: React.FC<EnquiryControlCenterProps> = ({
  canManage = true,
}) => {
  // Query State
  const [data, setData] = useState<EnquiryControlCenterQueryResult>({
    rows: [],
    totalCount: 0,
    page: 1,
    pageSize: 25,
    totalPages: 1,
    countsByPipeline: {},
    countsByWaitingFor: {},
    countsOverdue: 0,
    countsBlocked: 0,
    countsPriceReady: 0,
  });

  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [search, setSearch] = useState('');
  const [activeFilter, setActiveFilter] = useState<FilterPillKey>('active');
  const [sortBy, setSortBy] = useState<'inquiry_date' | 'created_at' | 'inquiry_number' | 'priority'>('created_at');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');

  // Selection state for Phase 7.3 detail drawer
  const [selectedRow, setSelectedRow] = useState<EnquiryControlCenterRow | null>(null);

  // India Daily Queue Modal state (Phase 7.5)
  const [showIndiaQueue, setShowIndiaQueue] = useState(false);

  const handleSelectIndiaEnquiry = useCallback(async (inquiryId: string) => {
    try {
      const row = await EnquiryControlCenterService.getControlCenterEnquiryById(inquiryId);
      if (row) {
        setSelectedRow(row);
      }
    } catch (err) {
      console.error('Failed to open enquiry from India queue:', err);
    }
  }, []);

  // User list for inline owner assignment
  const [userOptions, setUserOptions] = useState<DropdownOption[]>([]);

  // Load active staff users
  useEffect(() => {
    supabase
      .from('user_profiles')
      .select('id, full_name, role')
      .eq('is_active', true)
      .order('full_name')
      .then(({ data: users, error }) => {
        if (!error && users) {
          const opts: DropdownOption[] = [
            { value: 'unassigned', label: '— Unassigned —', colorClass: 'text-gray-400 italic' },
            ...users.map(u => ({
              value: u.id,
              label: u.full_name || 'Staff User',
            })),
          ];
          setUserOptions(opts);
        }
      });
  }, []);

  // Fetch enquiries with active params
  const loadEnquiries = useCallback(async () => {
    setLoading(true);
    try {
      const params: EnquiryControlCenterQueryParams = {
        page,
        pageSize,
        search: search.trim() || undefined,
        sortBy,
        sortDirection,
      };

      // Map filter pills to query params
      switch (activeFilter) {
        case 'active':
          params.pipelineStatus = 'active';
          break;
        case 'all':
          params.pipelineStatus = 'all';
          break;
        case 'overdue':
          params.pipelineStatus = 'active';
          params.overdueOnly = true;
          break;
        case 'waiting_customer':
          params.pipelineStatus = 'active';
          params.waitingFor = 'CUSTOMER';
          break;
        case 'waiting_india':
          params.pipelineStatus = 'active';
          params.waitingFor = 'INDIA';
          break;
        case 'waiting_manufacturer':
          params.pipelineStatus = 'active';
          params.waitingFor = 'MANUFACTURER';
          break;
        case 'blocked':
          params.pipelineStatus = 'active';
          params.blockedOnly = true;
          break;
        case 'price_ready':
          params.pipelineStatus = 'active';
          params.priceReadyOnly = true;
          break;
        case 'unassigned':
          params.pipelineStatus = 'active';
          break;
        case 'stalled':
          params.pipelineStatus = 'active';
          break;
      }

      const result = await EnquiryControlCenterService.getControlCenterEnquiries(params);

      // Apply client-side filters for unassigned or stalled if needed
      let finalRows = result.rows;
      if (activeFilter === 'unassigned') {
        finalRows = finalRows.filter(r => !r.assignedTo);
      } else if (activeFilter === 'stalled') {
        finalRows = finalRows.filter(r => r.age.days > 7);
      }

      setData({
        ...result,
        rows: finalRows,
      });

      // Keep selected row up-to-date if it is loaded
      if (selectedRow) {
        const refreshedSelected = finalRows.find(r => r.id === selectedRow.id);
        if (refreshedSelected) setSelectedRow(refreshedSelected);
      }
    } catch (err: any) {
      console.error('Error loading Control Center enquiries:', err);
      showToast({
        type: 'error',
        title: 'Query failed',
        message: err.message || 'Failed to load enquiries.',
      });
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, search, activeFilter, sortBy, sortDirection, selectedRow]);

  useEffect(() => {
    loadEnquiries();
  }, [page, pageSize, search, activeFilter, sortBy, sortDirection]);

  // Handle sort column toggle
  const handleSortChange = (column: 'inquiry_date' | 'created_at' | 'inquiry_number' | 'priority') => {
    if (sortBy === column) {
      setSortDirection(prev => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortBy(column);
      setSortDirection('desc');
    }
    setPage(1);
  };

  const handleFilterChange = (key: FilterPillKey) => {
    setActiveFilter(key);
    setPage(1);
  };

  const handleSearchChange = (val: string) => {
    setSearch(val);
    setPage(1);
  };

  const handlePageSizeChange = (size: number) => {
    setPageSize(size);
    setPage(1);
  };

  // Compute filter pill badge counts across data
  const filterCounts = useMemo(() => {
    const total = data.totalCount;
    const active = data.countsByPipeline
      ? Object.entries(data.countsByPipeline)
          .filter(([k]) => k !== 'lost')
          .reduce((sum, [, c]) => sum + c, 0)
      : 0;

    const waitingCustomer = data.countsByWaitingFor?.CUSTOMER || 0;
    const waitingIndia = data.countsByWaitingFor?.INDIA || 0;
    const waitingManufacturer = data.countsByWaitingFor?.MANUFACTURER || 0;
    const overdue = data.countsOverdue || 0;
    const blocked = data.countsBlocked || 0;
    const priceReady = data.countsPriceReady || 0;
    const unassigned = data.rows.filter(r => !r.assignedTo).length;
    const stalled = data.rows.filter(r => r.age.days > 7).length;

    return {
      total,
      active,
      overdue,
      waitingCustomer,
      waitingIndia,
      waitingManufacturer,
      blocked,
      priceReady,
      unassigned,
      stalled,
    };
  }, [data]);

  const activeFilterLabel = useMemo(() => {
    switch (activeFilter) {
      case 'active':
        return 'Active';
      case 'overdue':
        return 'Overdue';
      case 'waiting_customer':
        return 'Waiting Customer';
      case 'waiting_india':
        return 'Waiting India';
      case 'waiting_manufacturer':
        return 'Waiting Manufacturer';
      case 'blocked':
        return 'Blocked';
      case 'price_ready':
        return 'Price Ready';
      case 'unassigned':
        return 'Unassigned';
      case 'stalled':
        return 'Stalled >7d';
      case 'all':
        return 'All';
    }
  }, [activeFilter]);

  return (
    <div className="space-y-2.5">
      {/* Header bar */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-base font-bold text-gray-900 tracking-tight flex items-center gap-2">
            <span>Enquiry Control Center</span>
            <span className="text-[11px] bg-blue-100 text-blue-800 px-2 py-0.5 rounded-full font-semibold">
              Phase 7.2
            </span>
          </h2>
          <p className="text-xs text-gray-500">
            Work-control table tracking customer requirements, active blockers, waiting parties, and next actions.
          </p>
        </div>
      </div>

      {/* Toolbar (Search & Controls) */}
      <EnquiryControlCenterToolbar
        search={search}
        onSearchChange={handleSearchChange}
        pageSize={pageSize}
        onPageSizeChange={handlePageSizeChange}
        onRefresh={loadEnquiries}
        onOpenIndiaQueue={() => setShowIndiaQueue(true)}
        loading={loading}
        totalCount={data.totalCount}
        filteredCount={data.rows.length}
        activeFilterLabel={activeFilterLabel}
      />

      {/* Quick Filter Pills */}
      <EnquiryControlCenterFilters
        activeFilter={activeFilter}
        onFilterChange={handleFilterChange}
        counts={filterCounts}
      />

      {/* Master Grid */}
      <EnquiryControlCenterTable
        rows={data.rows}
        loading={loading}
        selectedRowId={selectedRow?.id || null}
        onSelectRow={row => setSelectedRow(prev => (prev?.id === row.id ? null : row))}
        onRefresh={loadEnquiries}
        page={page}
        pageSize={pageSize}
        totalPages={data.totalPages}
        totalCount={data.totalCount}
        onPageChange={setPage}
        sortBy={sortBy}
        sortDirection={sortDirection}
        onSortChange={handleSortChange}
        userOptions={userOptions}
        priorityOptions={PRIORITY_OPTIONS}
        canManage={canManage}
      />

      {/* Selection Detail Drawer */}
      {selectedRow && (
        <EnquiryDetailDrawer
          enquiry={selectedRow}
          onClose={() => setSelectedRow(null)}
          onRefresh={loadEnquiries}
          canManage={canManage}
        />
      )}

      {/* India Daily Work Queue Modal (Phase 7.5) */}
      {showIndiaQueue && (
        <IndiaDailyWorkQueueModal
          isOpen={showIndiaQueue}
          onClose={() => setShowIndiaQueue(false)}
          onSelectEnquiry={handleSelectIndiaEnquiry}
        />
      )}
    </div>
  );
};
