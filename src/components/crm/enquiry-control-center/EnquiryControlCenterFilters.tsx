import React from 'react';

export type FilterPillKey =
  | 'all'
  | 'active'
  | 'overdue'
  | 'waiting_customer'
  | 'waiting_india'
  | 'waiting_manufacturer'
  | 'blocked'
  | 'price_ready'
  | 'unassigned'
  | 'stalled';

interface FilterPillConfig {
  key: FilterPillKey;
  label: string;
  count?: number;
  badgeColor?: string;
  activeColor: string;
}

interface EnquiryControlCenterFiltersProps {
  activeFilter: FilterPillKey;
  onFilterChange: (key: FilterPillKey) => void;
  counts: {
    total: number;
    active: number;
    overdue: number;
    waitingCustomer: number;
    waitingIndia: number;
    waitingManufacturer: number;
    blocked: number;
    priceReady: number;
    unassigned: number;
    stalled: number;
  };
}

export const EnquiryControlCenterFilters: React.FC<EnquiryControlCenterFiltersProps> = ({
  activeFilter,
  onFilterChange,
  counts,
}) => {
  const pills: FilterPillConfig[] = [
    {
      key: 'active',
      label: 'Active',
      count: counts.active,
      activeColor: 'bg-blue-600 text-white border-blue-600',
    },
    {
      key: 'overdue',
      label: '🔥 Overdue',
      count: counts.overdue,
      badgeColor: counts.overdue > 0 ? 'bg-rose-100 text-rose-700' : 'bg-gray-100 text-gray-600',
      activeColor: 'bg-rose-600 text-white border-rose-600',
    },
    {
      key: 'waiting_customer',
      label: '⏳ Waiting Customer',
      count: counts.waitingCustomer,
      badgeColor: 'bg-purple-100 text-purple-700',
      activeColor: 'bg-purple-600 text-white border-purple-600',
    },
    {
      key: 'waiting_india',
      label: '🇮🇳 Waiting India',
      count: counts.waitingIndia,
      badgeColor: 'bg-amber-100 text-amber-700',
      activeColor: 'bg-amber-600 text-white border-amber-600',
    },
    {
      key: 'waiting_manufacturer',
      label: '🏭 Waiting Manufacturer',
      count: counts.waitingManufacturer,
      badgeColor: 'bg-cyan-100 text-cyan-700',
      activeColor: 'bg-cyan-600 text-white border-cyan-600',
    },
    {
      key: 'blocked',
      label: '🛑 Blocked',
      count: counts.blocked,
      badgeColor: counts.blocked > 0 ? 'bg-rose-100 text-rose-800' : 'bg-gray-100 text-gray-600',
      activeColor: 'bg-rose-700 text-white border-rose-700',
    },
    {
      key: 'price_ready',
      label: '📦 Price Ready',
      count: counts.priceReady,
      badgeColor: 'bg-emerald-100 text-emerald-700',
      activeColor: 'bg-emerald-600 text-white border-emerald-600',
    },
    {
      key: 'unassigned',
      label: '👤 Unassigned',
      count: counts.unassigned,
      badgeColor: 'bg-gray-100 text-gray-700',
      activeColor: 'bg-gray-800 text-white border-gray-800',
    },
    {
      key: 'stalled',
      label: '⏱️ Stalled >7d',
      count: counts.stalled,
      badgeColor: 'bg-orange-100 text-orange-700',
      activeColor: 'bg-orange-600 text-white border-orange-600',
    },
    {
      key: 'all',
      label: 'All Enquiries',
      count: counts.total,
      activeColor: 'bg-slate-700 text-white border-slate-700',
    },
  ];

  return (
    <div className="flex items-center gap-1.5 overflow-x-auto py-1 px-0.5 no-scrollbar">
      {pills.map(pill => {
        const isActive = activeFilter === pill.key;
        return (
          <button
            key={pill.key}
            type="button"
            onClick={() => onFilterChange(pill.key)}
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium transition border whitespace-nowrap cursor-pointer ${
              isActive
                ? pill.activeColor
                : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50 hover:text-gray-900'
            }`}
          >
            <span>{pill.label}</span>
            {typeof pill.count === 'number' && (
              <span
                className={`text-[10px] font-semibold px-1.5 py-0.2 rounded-full ${
                  isActive ? 'bg-white/20 text-white' : pill.badgeColor || 'bg-gray-100 text-gray-600'
                }`}
              >
                {pill.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
};
