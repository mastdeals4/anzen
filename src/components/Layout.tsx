import { useState, useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useLanguage } from '../contexts/LanguageContext';
import { useNavigation } from '../contexts/NavigationContext';
import { NotificationDropdown } from './NotificationDropdown';
import {
  LayoutDashboard,
  Package,
  Boxes,
  Warehouse,
  Users,
  UserCircle,
  ShoppingCart,
  DollarSign,
  Settings,
  LogOut,
  Menu,
  X,
  Globe,
  Truck,
  Zap,
  CheckSquare,
  FileText,
  ClipboardCheck,
  TrendingUp,
  RotateCcw,
  AlertTriangle,
  ClipboardList,
  Sparkles,
} from 'lucide-react';
import logo from '../assets/Untitled-1.svg';

interface Quote {
  content: string;
  author: string;
}

const fallbackQuotes: Quote[] = [
  { content: "Success is not final, failure is not fatal: it is the courage to continue that counts.", author: "Winston Churchill" },
  { content: "The only way to do great work is to love what you do.", author: "Steve Jobs" },
  { content: "Believe you can and you're halfway there.", author: "Theodore Roosevelt" },
  { content: "Excellence is not a skill, it's an attitude.", author: "Ralph Marston" },
  { content: "Quality is not an act, it is a habit.", author: "Aristotle" },
  { content: "The best time to plant a tree was 20 years ago. The second best time is now.", author: "Chinese Proverb" },
  { content: "Success is the sum of small efforts repeated day in and day out.", author: "Robert Collier" },
  { content: "Don't watch the clock; do what it does. Keep going.", author: "Sam Levenson" },
  { content: "The future depends on what you do today.", author: "Mahatma Gandhi" },
  { content: "Strive not to be a success, but rather to be of value.", author: "Albert Einstein" },
  { content: "The harder you work for something, the greater you'll feel when you achieve it.", author: "Unknown" },
  { content: "Dream bigger. Do bigger.", author: "Unknown" },
  { content: "Don't stop when you're tired. Stop when you're done.", author: "Unknown" },
  { content: "Wake up with determination. Go to bed with satisfaction.", author: "Unknown" },
  { content: "Do something today that your future self will thank you for.", author: "Sean Patrick Flanery" },
  { content: "Little things make big days.", author: "Unknown" },
  { content: "It's going to be hard, but hard does not mean impossible.", author: "Unknown" },
  { content: "Don't wait for opportunity. Create it.", author: "Unknown" },
  { content: "Sometimes we're tested not to show our weaknesses, but to discover our strengths.", author: "Unknown" },
  { content: "The key to success is to focus on goals, not obstacles.", author: "Unknown" },
  { content: "Dream it. Believe it. Build it.", author: "Unknown" },
  { content: "Success doesn't just find you. You have to go out and get it.", author: "Unknown" },
  { content: "Great things never come from comfort zones.", author: "Unknown" },
  { content: "Opportunities don't happen. You create them.", author: "Chris Grosser" },
  { content: "The secret of getting ahead is getting started.", author: "Mark Twain" },
  { content: "Focus on being productive instead of busy.", author: "Tim Ferriss" },
  { content: "Action is the foundational key to all success.", author: "Pablo Picasso" },
  { content: "Your limitation—it's only your imagination.", author: "Unknown" },
  { content: "Push yourself, because no one else is going to do it for you.", author: "Unknown" },
  { content: "Sometimes later becomes never. Do it now.", author: "Unknown" }
];

const getRandomFallbackQuote = (): Quote => {
  const randomIndex = Math.floor(Math.random() * fallbackQuotes.length);
  return fallbackQuotes[randomIndex];
};

interface LayoutProps {
  children: React.ReactNode;
}

export function Layout({ children }: LayoutProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const { profile, signOut } = useAuth();
  const { language, setLanguage, t } = useLanguage();
  const { currentPage, setCurrentPage, sidebarCollapsed, setSidebarCollapsed } = useNavigation();
  const [quote, setQuote] = useState<Quote>({ content: 'Welcome back!', author: '' });

  // Auto-collapse sidebar for specific pages
  const autoCollapsiblePages = ['crm', 'command-center', 'finance'];
  const shouldAutoCollapse = autoCollapsiblePages.includes(currentPage);

  // Use fallback quotes only (removed external API to clean console)
  const fetchQuote = () => {
    setQuote(getRandomFallbackQuote());
  };

  // Fetch quote on mount and rotate every 5 minutes
  useEffect(() => {
    fetchQuote();
    const interval = setInterval(fetchQuote, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  // Automatically collapse sidebar when entering CRM or Command Center
  useEffect(() => {
    if (shouldAutoCollapse && !sidebarCollapsed) {
      setSidebarCollapsed(true);
    }
  }, [currentPage, shouldAutoCollapse, sidebarCollapsed, setSidebarCollapsed]);

  const menuItems = [
    { id: 'dashboard', label: t('nav.dashboard'), icon: LayoutDashboard, roles: ['admin', 'accounts', 'sales', 'warehouse'] },
    { id: 'products', label: t('nav.products'), icon: Package, roles: ['admin', 'sales', 'warehouse'] },
    { id: 'batches', label: t('nav.batches'), icon: Boxes, roles: ['admin', 'warehouse', 'accounts'] },
    { id: 'stock', label: t('nav.stock'), icon: Warehouse, roles: ['admin', 'sales', 'warehouse', 'accounts'] },
    { id: 'customers', label: t('nav.customers'), icon: Users, roles: ['admin', 'accounts', 'sales'] },
    { id: 'sales-orders', label: t('nav.salesOrders'), icon: FileText, roles: ['admin', 'accounts', 'sales'] },
    { id: 'delivery-challan', label: t('nav.deliveryChallan'), icon: Truck, roles: ['admin', 'accounts', 'sales', 'warehouse'] },
    { id: 'sales', label: t('nav.sales'), icon: ShoppingCart, roles: ['admin', 'accounts', 'sales'] },
    { id: 'purchase-orders', label: t('nav.purchaseOrders'), icon: ClipboardList, roles: ['admin', 'warehouse', 'accounts'] },
    { id: 'import-requirements', label: t('nav.importRequirements'), icon: TrendingUp, roles: ['admin', 'warehouse', 'sales'] },
    { id: 'import-containers', label: t('nav.importContainers'), icon: Package, roles: ['admin', 'warehouse', 'accounts'] },
    { id: 'finance', label: t('nav.finance'), icon: DollarSign, roles: ['admin', 'accounts'] },
    { id: 'crm', label: t('nav.crm'), icon: UserCircle, roles: ['admin', 'sales'] },
    { id: 'command-center', label: t('nav.commandCenter'), icon: Zap, roles: ['admin', 'sales'] },
    { id: 'tasks', label: t('nav.tasks'), icon: CheckSquare, roles: ['admin', 'accounts', 'sales', 'warehouse'] },
    { id: 'inventory', label: t('nav.inventory'), icon: Warehouse, roles: ['admin', 'warehouse'] },
    { id: 'settings', label: t('nav.settings'), icon: Settings, roles: ['admin', 'accounts', 'sales'] },
  ];

  const visibleMenuItems = menuItems.filter(item =>
    profile && item.roles.includes(profile.role)
  );

  const toggleLanguage = () => {
    setLanguage(language === 'en' ? 'id' : 'en');
  };

  return (
    <div className="min-h-screen bg-gray-50">
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-gray-900 bg-opacity-50 z-20 lg:hidden transition-opacity"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <aside
        className={`fixed top-0 left-0 z-30 h-full bg-white border-r border-gray-200 transform transition-all lg:translate-x-0 ${
          sidebarOpen ? 'translate-x-0' : '-translate-x-full'
        } ${sidebarCollapsed && shouldAutoCollapse ? 'w-16' : 'w-64'} flex flex-col`}
      >
        <div className="flex items-center justify-between p-3 border-b border-gray-200 flex-shrink-0">
          <div className="flex items-center gap-2">
            <img src={logo} alt="Logo" className="h-8 w-8 flex-shrink-0" />
            {!(sidebarCollapsed && shouldAutoCollapse) && (
              <div className="flex flex-col leading-tight">
                <span className="text-xs font-bold text-gray-900">PT. SHUBHAM ANZEN</span>
                <span className="text-xs font-bold text-gray-900">PHARMA JAYA</span>
              </div>
            )}
          </div>
          <button
            onClick={() => setSidebarOpen(false)}
            className="lg:hidden p-1 rounded hover:bg-gray-100"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto p-3 space-y-1">
          {visibleMenuItems.map((item) => {
            const Icon = item.icon;
            const isActive = currentPage === item.id;
            return (
              <a
                key={item.id}
                href={`/${item.id}`}
                onClick={(e) => {
                  e.preventDefault();
                  setCurrentPage(item.id);
                  setSidebarOpen(false);
                }}
                className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg transition relative group ${
                  isActive
                    ? 'bg-blue-50 text-blue-600'
                    : 'text-gray-700 hover:bg-gray-50'
                } ${sidebarCollapsed && shouldAutoCollapse ? 'justify-center' : ''}`}
                title={sidebarCollapsed && shouldAutoCollapse ? item.label : ''}
              >
                <Icon className="w-5 h-5 flex-shrink-0" />
                {!(sidebarCollapsed && shouldAutoCollapse) && (
                  <span className="font-medium text-sm">{item.label}</span>
                )}
                {/* Enhanced tooltip for collapsed state */}
                {sidebarCollapsed && shouldAutoCollapse && (
                  <span className="absolute left-full ml-2 px-2 py-1 bg-gray-900 text-white text-xs rounded whitespace-nowrap opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity z-50">
                    {item.label}
                  </span>
                )}
              </a>
            );
          })}
        </nav>
      </aside>

      <div className={`transition-all ${sidebarCollapsed && shouldAutoCollapse ? 'lg:pl-16' : 'lg:pl-64'}`}>
        <header className="bg-white border-b border-gray-200 sticky top-0 z-10">
          <div className="flex items-center justify-between px-4 py-3">
            <div className="flex items-center gap-2">
              <button
                onClick={() => setSidebarOpen(true)}
                className="lg:hidden p-2 rounded hover:bg-gray-100"
              >
                <Menu className="w-6 h-6" />
              </button>
              {shouldAutoCollapse && (
                <button
                  onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
                  className="hidden lg:block p-2 rounded hover:bg-gray-100"
                  title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
                >
                  <Menu className="w-6 h-6" />
                </button>
              )}
            </div>

            <div className="flex-1 hidden md:flex items-center justify-center px-4">
              <div className="flex items-center justify-center gap-2 text-sm">
                <span className="font-medium text-gray-700">
                  {t('auth.welcome')}, <span className="text-blue-600">{profile?.full_name || profile?.username || 'User'}</span>
                </span>
                <span className="text-gray-400">•</span>
                <div className="flex items-center gap-2 text-gray-500 italic">
                  <Sparkles className="w-3 h-3 text-yellow-500 flex-shrink-0" />
                  <p className="line-clamp-1">
                    {`"${quote.content}"`}
                  </p>
                </div>
              </div>
            </div>

            <div className="flex-1 md:hidden" />

            <div className="flex items-center gap-3">
              <NotificationDropdown />

              <button
                onClick={toggleLanguage}
                className="flex items-center gap-2 px-3 py-2 rounded hover:bg-gray-100"
              >
                <Globe className="w-5 h-5 text-gray-600" />
                <span className="text-sm font-medium text-gray-700 uppercase">
                  {language}
                </span>
              </button>

              <button
                onClick={() => signOut()}
                className="flex items-center gap-2 px-3 py-2 rounded hover:bg-gray-100 text-gray-700"
              >
                <LogOut className="w-5 h-5" />
                <span className="text-sm font-medium">{t('auth.logout')}</span>
              </button>
            </div>
          </div>
        </header>

        <main className="p-4 lg:p-6">
          {children}
        </main>
      </div>
    </div>
  );
}
