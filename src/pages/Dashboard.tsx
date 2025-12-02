import { useEffect, useState } from 'react';
import { Layout } from '../components/Layout';
import { useLanguage } from '../contexts/LanguageContext';
import { useAuth } from '../contexts/AuthContext';
import { useNavigation } from '../contexts/NavigationContext';
import { supabase } from '../lib/supabase';
import { TodaysActionsDashboard } from '../components/commandCenter/TodaysActionsDashboard';
import {
  Package,
  AlertTriangle,
  Clock,
  Users,
  DollarSign,
  TrendingUp,
  Bell,
  FileText,
  ClipboardCheck,
} from 'lucide-react';

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
  overdueInvoicesCount: number;
  overdueInvoicesAmount: number;
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
    overdueInvoicesCount: 0,
    overdueInvoicesAmount: 0,
  });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadDashboardData();
  }, []);

  const loadDashboardData = async () => {
    try {
      const now = new Date();
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);

      const [
        productsResult,
        batchesResult,
        customersResult,
        invoicesResult,
        activitiesResult,
        settings,
        pendingSalesOrdersResult,
        pendingDCResult,
        overdueInvoicesResult,
      ] = await Promise.all([
        supabase.from('products').select('id', { count: 'exact', head: true }).eq('is_active', true),
        supabase.from('batches').select('*').eq('is_active', true),
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
          .from('app_settings')
          .select('low_stock_threshold')
          .maybeSingle(),
        supabase
          .from('sales_orders')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'pending_approval'),
        supabase
          .from('delivery_challans')
          .select('id', { count: 'exact', head: true })
          .eq('approval_status', 'pending_approval'),
        supabase
          .from('sales_invoices')
          .select('id, total_amount, due_date')
          .in('payment_status', ['pending', 'partial'])
          .lt('due_date', new Date().toISOString().split('T')[0]),
      ]);

      const lowStockThreshold = settings?.data?.low_stock_threshold || 100;
      const lowStockCount = batchesResult.data?.filter(b => b.current_stock < lowStockThreshold).length || 0;

      const thirtyDaysFromNow = new Date();
      thirtyDaysFromNow.setDate(thirtyDaysFromNow.getDate() + 30);
      const nearExpiryCount = batchesResult.data?.filter(
        b => b.expiry_date && new Date(b.expiry_date) <= thirtyDaysFromNow && new Date(b.expiry_date) >= new Date()
      ).length || 0;

      const totalRevenue = invoicesResult.data?.reduce((sum, inv) => sum + (Number(inv.total_amount) || 0), 0) || 0;
      const totalSubtotal = invoicesResult.data?.reduce((sum, inv) => sum + (Number(inv.subtotal) || 0), 0) || 0;

      const estimatedProfit = totalRevenue - (totalSubtotal * 0.7);

      // Calculate overdue amounts
      const overdueInvoicesWithBalances = await Promise.all(
        (overdueInvoicesResult.data || []).map(async (inv) => {
          const { data: paidData } = await supabase
            .rpc('get_invoice_paid_amount', { p_invoice_id: inv.id });
          const paidAmount = paidData || 0;
          return inv.total_amount - paidAmount;
        })
      );

      const overdueAmount = overdueInvoicesWithBalances.reduce((sum, balance) => sum + balance, 0);

      setStats({
        totalProducts: productsResult.count || 0,
        lowStockItems: lowStockCount,
        nearExpiryBatches: nearExpiryCount,
        totalCustomers: customersResult.count || 0,
        salesThisMonth: invoicesResult.data?.length || 0,
        revenueThisMonth: totalRevenue,
        profitThisMonth: Math.max(0, estimatedProfit),
        pendingFollowUps: activitiesResult.count || 0,
        pendingSalesOrders: pendingSalesOrdersResult.count || 0,
        pendingDeliveryChallans: pendingDCResult.count || 0,
        overdueInvoicesCount: overdueInvoicesResult.data?.length || 0,
        overdueInvoicesAmount: overdueAmount,
      });
    } catch (error) {
      console.error('Error loading dashboard:', error);
    } finally {
      setLoading(false);
    }
  };

  const baseStatCards = [
    {
      title: t('dashboard.lowStock'),
      value: stats.lowStockItems,
      icon: AlertTriangle,
      color: 'orange',
    },
    {
      title: t('dashboard.nearExpiry'),
      value: stats.nearExpiryBatches,
      icon: Clock,
      color: 'red',
    },
    {
      title: t('dashboard.salesThisMonth'),
      value: stats.salesThisMonth,
      icon: TrendingUp,
      color: 'blue',
    },
  ];

  const approvalCards = [];
  if (profile?.role === 'admin' || profile?.role === 'accounts') {
    approvalCards.push({
      title: 'Overdue Invoices',
      value: stats.overdueInvoicesCount,
      subtitle: `Rp ${stats.overdueInvoicesAmount.toLocaleString('id-ID', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`,
      icon: AlertTriangle,
      color: 'red-gradient',
      link: 'sales'
    });
  }
  if (profile?.role === 'admin' || profile?.role === 'sales') {
    approvalCards.push({
      title: 'Pending PO Approvals',
      value: stats.pendingSalesOrders,
      icon: FileText,
      color: 'yellow',
      link: 'sales-orders'
    });
  }
  if (profile?.role === 'admin') {
    approvalCards.push({
      title: 'Pending DC Approvals',
      value: stats.pendingDeliveryChallans,
      icon: ClipboardCheck,
      color: 'yellow',
      link: 'delivery-challan'
    });
  }

  const statCards = [...approvalCards, ...baseStatCards];

  const colorClasses: Record<string, { bg: string; text: string; icon: string }> = {
    blue: { bg: 'bg-blue-50', text: 'text-blue-600', icon: 'bg-blue-100' },
    orange: { bg: 'bg-orange-50', text: 'text-orange-600', icon: 'bg-orange-100' },
    red: { bg: 'bg-red-50', text: 'text-red-600', icon: 'bg-red-100' },
    'red-gradient': { bg: 'bg-gradient-to-br from-red-500 to-orange-500', text: 'text-white', icon: 'bg-white/20' },
    green: { bg: 'bg-green-50', text: 'text-green-600', icon: 'bg-green-100' },
    emerald: { bg: 'bg-emerald-50', text: 'text-emerald-600', icon: 'bg-emerald-100' },
    purple: { bg: 'bg-purple-50', text: 'text-purple-600', icon: 'bg-purple-100' },
    yellow: { bg: 'bg-yellow-50', text: 'text-yellow-600', icon: 'bg-yellow-100' },
  };

  return (
    <Layout>
      <div className="space-y-6">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">{t('dashboard.title')}</h1>
          <p className="text-gray-600 mt-1">Welcome to your pharma trading management system</p>
        </div>

        {loading ? (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3 md:gap-4">
            {[...Array(8)].map((_, i) => (
              <div key={i} className="bg-white rounded-lg shadow p-4 animate-pulse">
                <div className="h-10 bg-gray-200 rounded mb-3" />
                <div className="h-5 bg-gray-200 rounded w-1/2" />
              </div>
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3 md:gap-4">
            {statCards.map((card:any, index) => {
              const Icon = card.icon;
              const colors = colorClasses[card.color];
              const isClickable = !!card.link;
              return (
                <div
                  key={index}
                  className={`${colors.bg} rounded-lg shadow p-3 md:p-4 transition hover:shadow-lg ${isClickable ? 'cursor-pointer' : ''}`}
                  onClick={() => isClickable && setCurrentPage(card.link)}
                >
                  <div className="flex items-center justify-between">
                    <div className="min-w-0 flex-1">
                      <p className={`text-xs md:text-sm font-medium ${card.color === 'red-gradient' ? 'text-white/80' : 'text-gray-600'} truncate`}>{card.title}</p>
                      <p className={`text-xl md:text-2xl font-bold ${colors.text} mt-1`}>
                        {card.value}
                      </p>
                      {card.subtitle && (
                        <p className={`text-xs mt-0.5 ${card.color === 'red-gradient' ? 'text-white/90' : 'text-gray-500'} truncate`}>
                          {card.subtitle}
                        </p>
                      )}
                    </div>
                    <div className={`${colors.icon} p-2 md:p-3 rounded-full flex-shrink-0 ml-2`}>
                      <Icon className={`w-4 h-4 md:w-5 md:h-5 ${colors.text}`} />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mt-6">
          <div className="lg:col-span-2">
            <TodaysActionsDashboard />
          </div>
          <div className="bg-white rounded-lg shadow p-6">
            <h3 className="text-lg font-semibold text-gray-900 mb-4">Quick Links</h3>
            <div className="space-y-2">
              <a href="#" className="block p-3 bg-blue-50 hover:bg-blue-100 rounded-lg transition text-blue-700 font-medium">
                Go to Command Center
              </a>
              <a href="#" className="block p-3 bg-gray-50 hover:bg-gray-100 rounded-lg transition text-gray-700 font-medium">
                View All Inquiries
              </a>
              <a href="#" className="block p-3 bg-gray-50 hover:bg-gray-100 rounded-lg transition text-gray-700 font-medium">
                Create Manual Inquiry
              </a>
            </div>
          </div>
        </div>
      </div>
    </Layout>
  );
}
