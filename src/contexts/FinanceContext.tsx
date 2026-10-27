import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';

interface FinanceDateRange {
  startDate: string;
  endDate: string;
}

interface FinanceContextType {
  dateRange: FinanceDateRange;
  setDateRange: (range: FinanceDateRange) => void;
  refreshTrigger: number;
  triggerRefresh: () => void;
}

const FinanceContext = createContext<FinanceContextType | undefined>(undefined);

function localDateString(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function FinanceProvider({ children }: { children: ReactNode }) {
  const [dateRange, setDateRange] = useState<FinanceDateRange>({
    startDate: localDateString(new Date(new Date().getFullYear(), 0, 1)),
    endDate: localDateString(new Date()),
  });
  const [refreshTrigger, setRefreshTrigger] = useState(0);

  const triggerRefresh = () => {
    setRefreshTrigger(prev => prev + 1);
  };

  return (
    <FinanceContext.Provider value={{ dateRange, setDateRange, refreshTrigger, triggerRefresh }}>
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
