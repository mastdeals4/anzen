import React, { createContext, useContext, useState, useMemo, useCallback } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';

interface NavigationContextType {
  currentPage: string;
  setCurrentPage: (page: string) => void;
  navigationData: Record<string, unknown> | null;
  setNavigationData: (data: Record<string, unknown> | null) => void;
  clearNavigationData: () => void;
  sidebarCollapsed: boolean;
  setSidebarCollapsed: (collapsed: boolean) => void;
}

const NavigationContext = createContext<NavigationContextType | undefined>(undefined);

export function NavigationProvider({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate();
  const location = useLocation();

  const currentPage = useMemo(() => {
    const path = location.pathname.slice(1) || 'dashboard';
    return path.split('/')[0];
  }, [location.pathname]);

  const setCurrentPage = useCallback((page: string) => {
    navigate(`/${page}`);
  }, [navigate]);

  const [navigationData, setNavigationData] = useState<Record<string, unknown> | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  const clearNavigationData = useCallback(() => setNavigationData(null), []);

  return (
    <NavigationContext.Provider value={{ currentPage, setCurrentPage, navigationData, setNavigationData, clearNavigationData, sidebarCollapsed, setSidebarCollapsed }}>
      {children}
    </NavigationContext.Provider>
  );
}

export function useNavigation() {
  const context = useContext(NavigationContext);
  if (context === undefined) {
    throw new Error('useNavigation must be used within a NavigationProvider');
  }
  return context;
}
