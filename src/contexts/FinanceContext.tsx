import React, { createContext, useContext, useState, useMemo, ReactNode } from 'react';
import { FinanceDateRange, DateRangePreset, getRollingMonthsRange } from '../utils/dateRange';

export type { FinanceDateRange, DateRangePreset };

interface FinanceContextType {
  dateRange: FinanceDateRange;
  setDateRange: (range: FinanceDateRange) => void;
  activePreset: DateRangePreset;
  applyPreset: (preset: '1M' | '2M') => void;
  refreshTrigger: number;
  triggerRefresh: () => void;
}

const FinanceContext = createContext<FinanceContextType | undefined>(undefined);

const STORAGE_KEY = 'anzen_finance_date_range';

export function FinanceProvider({ children }: { children: ReactNode }) {
  // Application-wide default: Rolling 1 calendar month back from today (Asia/Jakarta)
  // Preserved across navigation and page refreshes via sessionStorage
  const [dateRange, setDateRangeState] = useState<FinanceDateRange>(() => {
    try {
      if (typeof window !== 'undefined' && window.sessionStorage) {
        const saved = window.sessionStorage.getItem(STORAGE_KEY);
        if (saved) {
          const parsed = JSON.parse(saved);
          if (parsed?.startDate && parsed?.endDate) {
            return parsed;
          }
        }
      }
    } catch {
      // Fallback to default rolling 1 month
    }
    return getRollingMonthsRange(1);
  });
  const [refreshTrigger, setRefreshTrigger] = useState(0);

  const activePreset: DateRangePreset = useMemo(() => {
    const range1M = getRollingMonthsRange(1);
    if (dateRange.startDate === range1M.startDate && dateRange.endDate === range1M.endDate) {
      return '1M';
    }
    const range2M = getRollingMonthsRange(2);
    if (dateRange.startDate === range2M.startDate && dateRange.endDate === range2M.endDate) {
      return '2M';
    }
    return 'custom';
  }, [dateRange.startDate, dateRange.endDate]);

  const setDateRange = (range: FinanceDateRange) => {
    setDateRangeState(range);
    try {
      if (typeof window !== 'undefined' && window.sessionStorage) {
        window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(range));
      }
    } catch {
      // Ignore storage errors
    }
  };

  const applyPreset = (preset: '1M' | '2M') => {
    const newRange = getRollingMonthsRange(preset === '1M' ? 1 : 2);
    setDateRangeState(newRange);
    try {
      if (typeof window !== 'undefined' && window.sessionStorage) {
        window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(newRange));
      }
    } catch {
      // Ignore storage errors
    }
  };

  const triggerRefresh = () => {
    setRefreshTrigger(prev => prev + 1);
  };

  return (
    <FinanceContext.Provider
      value={{
        dateRange,
        setDateRange,
        activePreset,
        applyPreset,
        refreshTrigger,
        triggerRefresh,
      }}
    >
      {children}
    </FinanceContext.Provider>
  );
}

export function useFinance() {
  const context = useContext(FinanceContext);
  if (context === undefined) {
    throw new Error('useFinance must be used within a FinanceProvider');
  }
  return context;
}
