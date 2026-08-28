import { useEffect, useState, type ElementType } from 'react';
import { Layout } from '../components/Layout';
import { useLanguage } from '../contexts/LanguageContext';
import { useAuth } from '../contexts/AuthContext';
import { useNavigation } from '../contexts/NavigationContext';
import { supabase } from '../lib/supabase';
import { TodaysActionsDashboard } from '../components/commandCenter/TodaysActionsDashboard';
import { RevenueChart } from '../components/dashboard/RevenueChart';
import { SalesPipelineChart } from '../components/dashboard/SalesPipelineChart';
import { PaymentOverview } from '../components/dashboard/PaymentOverview';
import { SalesDashboard } from '../components/dashboard/SalesDashboard';
import { WarehouseDeliveryDashboard } from '../components/dashboard/WarehouseDeliveryDashboard';
import { AlertTriangle, Clock, TrendingUp, FileText, ClipboardCheck, ClipboardList, Zap, CircleUser as UserCircle, ArrowRight } from 'lucide-react';
import { fetchSalesOrderDeliveryAlerts, summarizeDeliveryAlerts } from '../utils/salesOrderDeliveryAlerts';
import { TaxComplianceDashboardCards } from '../components/finance/tax/TaxComplianceDashboardCards';
import { formatCurrency } from '../utils/currency';

interface DashboardStats {
  totalProducts: number;
  lowStockItems: number;
  nearExpiryBatches: number;
  totalCustomers: number;
  salesThisMonth: number;
  revenueThisMonth: number;
  profitThisMonth: number;
  pendingFollowUps: number;
  pendingSalesOrders: number;
  pendingDeliveryChallans: number;
  pendingExpenses: number;
  pendingPettyCash: number;
  pendingInvoices: number;
  overdueInvoicesCount: number;
  overdueInvoicesAmount: number;
  deliveryDueSoon: number;
  deliveryOverdue: number;
}

export function Dashboard() {
  const { t } = useLanguage();
  const { profile } = useAuth();
  const { setCurrentPage } = useNavigation();
  const [stats, setStats] = useState<DashboardStats>({
    totalProducts: 0,
    lowStockItems: 0,
    nearExpiryBatches: 0,
    totalCustomers: 0,
    salesThisMonth: 0,
    revenueThisMonth: 0,
    profitThisMonth: 0,
    pendingFollowUps: 0,
    pendingSalesOrders: 0,
    pendingDeliveryChallans: 0,
    pendingExpenses: 0,
    pendingPettyCash: 0,
    pendingInvoices: 0,
    overdueInvoicesCount: 0,
    overdueInvoicesAmount: 0,
    deliveryDueSoon: 0,
    deliveryOverdue: 0,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadDashboardData();
  }, []);

  const loadDashboardData = async () => {
    // Sales role has its own dedicated dashboard; skip all generic queries.
    if (profile?.role === 'sales' || profile?.role === 'warehouse') { setLoading(false); return; }
    try {
      setError(null);
      const now = new Date();
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);

      const [
        productsResult,
        productsWithStockResult,
        customersResult,
        invoicesResult,
        activitiesResult,
        pendingSalesOrdersResult,
        pendingDCResult,
        pendingExpensesResult,
        pendingPettyCashResult,
        pendingInvoicesResult,
        overdueInvoicesResult,
        deliveryAlerts,
      ] = await Promise.all([
        supabase.from('products').select('id', { count: 'exact', head: true }).eq('is_active', true),
        supabase.from('products').select('id, min_stock_level, current_stock').eq('is_active', true),
        supabase.from('customers').select('id', { count: 'exact', head: true }).eq('is_active', true),
        supabase
          .from('sales_invoices')
          .select('total_amount, subtotal, created_at, invoice_date')
          .gte('invoice_date', startOfMonth.toISOString())
          .lte('invoice_date', endOfMonth.toISOString()),
        supabase
          .from('crm_activities')
          .select('id', { count: 'exact' })
          .eq('is_completed', false)
          .not('follow_up_date', 'is', null),
        supabase
          .from('sales_orders')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'pending_approval'),
        supabase
          .from('delivery_challans')
          .select('id', { count: 'exact', head: true })
          .eq('approval_status', 'pending_approval'),
        supabase
          .from('finance_expenses')
          .select('id', { count: 'exact', head: true })
          .eq('approval_status', 'pending_approval'),
        supabase
          .from('petty_cash_transactions')
          .select('id', { count: 'exact', head: true })
          .is('fund_transfer_id', null)
          .eq('approval_status', 'pending_approval'),
        supabase
          .from('sales_invoices')
          .select('id', { count: 'exact', head: true })
          .in('payment_status', ['pending', 'partial']),
        supabase
          .from('sales_invoices')
          .select('id, total_amount, due_date')
          .in('payment_status', ['pending', 'partial'])
          .lt('due_date', new Date().toISOString().split('T')[0]),
        fetchSalesOrderDeliveryAlerts(),
      ]);

      const lowStockCount = productsWithStockResult.data?.filter(p =>
        p.min_stock_level > 0 && p.current_stock < p.min_stock_level
      ).length || 0;

      const batchesResult = await supabase.from('batches').select('current_stock, expiry_date').eq('is_active', true);

      const thirtyDaysFromNow = new Date();
      thirtyDaysFromNow.setDate(thirtyDaysFromNow.getDate() + 30);
      const nearExpiryCount = batchesResult.data?.filter(
        b => b.expiry_date && new Date(b.expiry_date) <= thirtyDaysFromNow && new Date(b.expiry_date) >= new Date()
      ).length || 0;

      const totalRevenue = invoicesResult.data?.reduce((sum, inv) => sum + (Number(inv.total_amount) || 0), 0) || 0;

      // Fetch all overdue balances in one query instead of N+1 individual calls
      const { data: overdueBalances } = await supabase.rpc('get_overdue_balances');
      const overdueAmount = (overdueBalances || []).reduce(
        (sum: number, row: { balance_due: number }) => sum + (Number(row.balance_due) || 0), 0
      );
      const deliveryAlertSummary = summarizeDeliveryAlerts(deliveryAlerts);

      // Fetch real COGS from batch landed costs for accurate gross profit
      const { data: cogsData } = await supabase.rpc('get_cogs_for_period', {
        p_start: startOfMonth.toISOString().split('T')[0],
        p_end: endOfMonth.toISOString().split('T')[0],
      });
      const totalCOGS = Number(cogsData) || 0;

      setStats({
        totalProducts: productsResult.count || 0,
        lowStockItems: lowStockCount,
        nearExpiryBatches: nearExpiryCount,
        totalCustomers: customersResult.count || 0,
        salesThisMonth: invoicesResult.data?.length || 0,
        revenueThisMonth: totalRevenue,
        profitThisMonth: Math.max(0, totalRevenue - totalCOGS),
        pendingFollowUps: activitiesResult.count || 0,
        pendingSalesOrders: pendingSalesOrdersResult.count || 0,
        pendingDeliveryChallans: pendingDCResult.count || 0,
        pendingExpenses: pendingExpensesResult.count || 0,
        pendingPettyCash: pendingPettyCashResult.count || 0,
        pendingInvoices: pendingInvoicesResult.count || 0,
        overdueInvoicesCount: overdueInvoicesResult.data?.length || 0,
        overdueInvoicesAmount: overdueAmount,
        deliveryDueSoon: deliveryAlertSummary.dueSoon.length,
        deliveryOverdue: deliveryAlertSummary.overdue.length,
      });
    } catch (err) {
      setError('Failed to load dashboard data. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const role = profile?.role;
  const isAdmin = role === 'admin';
  const isAccounts = role === 'accounts';
  const isSales = role === 'sales';
  const isWarehouse = role === 'warehouse';
  const isManager = role === 'manager';
  const isAuditor = role === 'auditor_ca';

  interface StatCard {
    title: string;
    value: number;
    subtitle?: string;
    icon: ElementType;
    color: string;
    link?: string;
  }
  const statCards: StatCard[] = [];

  if (isAdmin || isAccounts || isAuditor) {
    statCards.push({
      title: 'Overdue Invoices',
      value: stats.overdueInvoicesCount,
      subtitle: formatCurrency(stats.overdueInvoicesAmount, 'IDR'),
      icon: AlertTriangle,
      color: 'red-gradient',
      link: 'sales'
    });
    statCards.push({
      title: 'Pending Invoices',
      value: stats.pendingInvoices,
      subtitle: 'Awaiting collection',
      icon: FileText,
      color: 'yellow',
      link: 'sales',
    });
  }
  if (isAdmin || isSales || isWarehouse || isManager) {
    const totalDeliveryAlerts = stats.deliveryDueSoon + stats.deliveryOverdue;
    if (totalDeliveryAlerts > 0) {
      statCards.push({
        title: 'Delivery Alerts',
        value: totalDeliveryAlerts,
        subtitle: [
          stats.deliveryOverdue ? `${stats.deliveryOverdue} overdue` : '',
          stats.deliveryDueSoon ? `${stats.deliveryDueSoon} due soon` : '',
        ].filter(Boolean).join(', '),
        icon: AlertTriangle,
        color: stats.deliveryOverdue ? 'red' : 'yellow',
        link: 'sales-orders'
      });
    }
    const totalApprovals = stats.pendingSalesOrders + stats.pendingDeliveryChallans + stats.pendingExpenses + stats.pendingPettyCash;
    const parts = [
      stats.pendingSalesOrders ? `${stats.pendingSalesOrders} SO` : '',
      stats.pendingDeliveryChallans ? `${stats.pendingDeliveryChallans} DC` : '',
      stats.pendingExpenses ? `${stats.pendingExpenses} Exp` : '',
      stats.pendingPettyCash ? `${stats.pendingPettyCash} PC` : '',
    ].filter(Boolean);
    statCards.push({
      title: 'Approvals Pending',
      value: totalApprovals,
      subtitle: parts.length ? parts.join(', ') : 'All clear',
      icon: ClipboardCheck,
      color: 'yellow',
      link: 'sales-orders'
    });
  }
  if (isAdmin || isAccounts || isAuditor) {
    statCards.push({
      title: t('dashboard.salesThisMonth'),
      value: stats.salesThisMonth,
      icon: TrendingUp,
      color: 'blue',
      link: 'sales',
    });
  }
  if (isAdmin || isWarehouse) {
    statCards.push({
      title: t('dashboard.lowStock'),
      value: stats.lowStockItems,
      icon: AlertTriangle,
      color: 'orange',
      link: 'stock',
    });
    statCards.push({
      title: t('dashboard.nearExpiry'),
      value: stats.nearExpiryBatches,
      icon: Clock,
      color: 'red',
      link: 'batches',
    });
  }
  if (isSales) {
    statCards.push({
      title: 'Pending Follow-ups',
      value: stats.pendingFollowUps,
      icon: Clock,
      color: 'orange',
      link: 'crm',
    });
    statCards.push({
      title: 'Total Customers',
      value: stats.totalCustomers,
      icon: UserCircle,
      color: 'blue',
      link: 'customers',
    });
  }

  if (isWarehouse) {
    return (
      <Layout>
        <WarehouseDeliveryDashboard />
      </Layout>
    );
  }

  const colorClasses: Record<string, { bg: string; text: string; icon: string }> = {
    blue: { bg: 'bg-blue-50', text: 'text-blue-600', icon: 'bg-blue-100' },
    orange: { bg: 'bg-orange-50', text: 'text-orange-600', icon: 'bg-orange-100' },
    red: { bg: 'bg-red-50', text: 'text-red-600', icon: 'bg-red-100' },
    'red-gradient': { bg: 'bg-gradient-to-br from-red-500 to-orange-500', text: 'text-white', icon: 'bg-white/20' },
    green: { bg: 'bg-green-50', text: 'text-green-600', icon: 'bg-green-100' },
    emerald: { bg: 'bg-emerald-50', text: 'text-emerald-600', icon: 'bg-emerald-100' },
    yellow: { bg: 'bg-yellow-50', text: 'text-yellow-600', icon: 'bg-yellow-100' },
  };

  const quickLinks: { label: string; page: string; icon: ElementType; color: string }[] = [];
  if (isAdmin || isSales) {
    quickLinks.push({ label: 'Go to Command Center', page: 'command-center', icon: Zap, color: 'bg-blue-50 hover:bg-blue-100 text-blue-700' });
    quickLinks.push({ label: 'View All Inquiries', page: 'crm', icon: UserCircle, color: 'bg-gray-50 hover:bg-gray-100 text-gray-700' });
    quickLinks.push({ label: 'Sales Orders', page: 'sales-orders', icon: FileText, color: 'bg-gray-50 hover:bg-gray-100 text-gray-700' });
  }
  if (isAccounts) {
    quickLinks.push({ label: 'Finance Module', page: 'finance', icon: FileText, color: 'bg-blue-50 hover:bg-blue-100 text-blue-700' });
    quickLinks.push({ label: 'Receivables', page: 'finance', icon: TrendingUp, color: 'bg-gray-50 hover:bg-gray-100 text-gray-700' });
    quickLinks.push({ label: 'Sales Invoices', page: 'sales', icon: FileText, color: 'bg-gray-50 hover:bg-gray-100 text-gray-700' });
  }
  if (isWarehouse) {
    quickLinks.push({ label: 'Stock Management', page: 'stock', icon: ClipboardCheck, color: 'bg-blue-50 hover:bg-blue-100 text-blue-700' });
    quickLinks.push({ label: 'Delivery Challans', page: 'delivery-challan', icon: FileText, color: 'bg-gray-50 hover:bg-gray-100 text-gray-700' });
    quickLinks.push({ label: 'Inventory', page: 'inventory', icon: AlertTriangle, color: 'bg-gray-50 hover:bg-gray-100 text-gray-700' });
  }
  if (isAuditor) {
    quickLinks.push({ label: 'Sales Invoices', page: 'sales', icon: FileText, color: 'bg-blue-50 hover:bg-blue-100 text-blue-700' });
    quickLinks.push({ label: 'Finance Module', page: 'finance', icon: FileText, color: 'bg-gray-50 hover:bg-gray-100 text-gray-700' });
    quickLinks.push({ label: 'Purchase Orders', page: 'purchase-orders', icon: ClipboardList, color: 'bg-gray-50 hover:bg-gray-100 text-gray-700' });
  }

  // Sales role gets a dedicated CRM action dashboard instead of the generic layout.
  if (isSales) {
    return (
      <Layout>
        <SalesDashboard />
      </Layout>
    );
  }

  return (
    <Layout>
      <div className="space-y-4">
        <div className="bg-gradient-to-r from-blue-50 to-indigo-50 rounded-xl p-4 border border-blue-100">
          <h1 className="text-2xl font-bold text-gray-900">
            Welcome, {profile?.full_name || profile?.username || 'User'}!
          </h1>
          <p className="text-sm text-gray-600 mt-1">Here’s what needs attention today.</p>
        </div>

        {error ? (
          <div className="bg-red-50 border border-red-200 rounded-lg p-6 text-center">
            <AlertTriangle className="w-12 h-12 text-red-500 mx-auto mb-3" />
            <p className="text-red-700 font-medium">{error}</p>
            <button
              onClick={loadDashboardData}
              className="mt-4 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition"
            >
              Try Again
            </button>
          </div>
        ) : loading ? (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3 md:gap-4">
            {[...Array(8)].map((_, i) => (
              <div key={i} className="bg-white rounded-lg shadow p-4 animate-pulse">
                <div className="h-10 bg-gray-200 rounded mb-3" />
                <div className="h-5 bg-gray-200 rounded w-1/2" />
              </div>
            ))}
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-2 md:gap-3">
              {statCards.map((card: StatCard, index) => {
                const Icon = card.icon;
                const colors = colorClasses[card.color];
                const isClickable = !!card.link;
                return (
                  <div
                    key={index}
                    className={`${colors.bg} rounded-lg shadow-sm border border-gray-100/50 p-2.5 transition-all hover:shadow-md hover:-translate-y-0.5 ${isClickable ? 'cursor-pointer' : ''}`}
                    onClick={() => card.link && setCurrentPage(card.link)}
                  >
                    <div className="flex items-center justify-between">
                      <div className="min-w-0 flex-1">
                        <p className={`text-[10px] font-medium ${card.color === 'red-gradient' ? 'text-white/80' : 'text-gray-600'} truncate`}>{card.title}</p>
                        <p className={`text-lg md:text-xl font-bold ${colors.text} mt-0.5`}>
                          {card.value}
                        </p>
                        {card.subtitle && (
                          <p className={`text-[10px] mt-0.5 ${card.color === 'red-gradient' ? 'text-white/90' : 'text-gray-500'} truncate`}>
                            {card.subtitle}
                          </p>
                        )}
                      </div>
                      <div className={`${colors.icon} p-1.5 rounded-full flex-shrink-0 ml-1.5`}>
                        <Icon className={`w-3.5 h-3.5 ${colors.text}`} />
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {(isAdmin || isAccounts) && (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <RevenueChart />
                <SalesPipelineChart />
              </div>
            )}

            {(isAdmin || isAccounts) && (
              <TaxComplianceDashboardCards />
            )}
          </>
        )}

        <div className={`grid grid-cols-1 ${(isAdmin || isAccounts) ? 'md:grid-cols-2 lg:grid-cols-3' : 'md:grid-cols-2'} gap-4`}>
          {(isAdmin || isAccounts) && (
            <div className="md:col-span-1 lg:col-span-1">
              <PaymentOverview />
            </div>
          )}
          {(isAdmin || isWarehouse || isManager) && (
            <div className="md:col-span-1 lg:col-span-1">
              <TodaysActionsDashboard />
            </div>
          )}
          {quickLinks.length > 0 && (
            <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
              <h3 className="text-base font-semibold text-gray-900 mb-4">Quick Links</h3>
              <div className="space-y-2">
                {quickLinks.map((link, index) => {
                  const LinkIcon = link.icon;
                  return (
                    <button
                      key={index}
                      onClick={() => setCurrentPage(link.page)}
                      className={`w-full flex items-center justify-between p-3 ${link.color} rounded-lg transition font-medium text-sm group`}
                    >
                      <div className="flex items-center gap-2">
                        <LinkIcon className="w-4 h-4" />
                        <span>{link.label}</span>
                      </div>
                      <ArrowRight className="w-4 h-4 opacity-0 group-hover:opacity-100 transition-opacity" />
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </Layout>
  );
}
