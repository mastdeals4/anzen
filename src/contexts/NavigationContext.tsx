import React, { createContext, useContext, useState, useEffect } from 'react';

interface NavigationContextType {
  currentPage: string;
  setCurrentPage: (page: string) => void;
  navigationData: any;
  setNavigationData: (data: any) => void;
  clearNavigationData: () => void;
  sidebarCollapsed: boolean;
  setSidebarCollapsed: (collapsed: boolean) => void;
}

const NavigationContext = createContext<NavigationContextType | undefined>(undefined);

export function NavigationProvider({ children }: { children: React.ReactNode }) {
  // Read initial page from URL hash
  const getPageFromHash = () => {
    const hash = window.location.hash.slice(1) || 'dashboard';
    // For nested routes like "finance/reconciliation", return just "finance"
    const page = hash.split('/')[0];
    return page;
  };

  const [currentPage, setCurrentPageState] = useState(getPageFromHash());
  const [navigationData, setNavigationData] = useState<any>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  // Sync with URL hash
  const setCurrentPage = (page: string) => {
    setCurrentPageState(page);
    window.location.hash = page;
  };

  // Listen to hash changes (back/forward buttons, or links)
  useEffect(() => {
    const handleHashChange = () => {
      const newPage = getPageFromHash();
      setCurrentPageState(newPage);
    };

    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  const clearNavigationData = () => setNavigationData(null);

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
