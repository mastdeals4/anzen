import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { useNavigation } from '../contexts/NavigationContext';
import { X, FileText, Truck, DollarSign, Wallet } from 'lucide-react';
import { formatCurrency, resolveTransactionCurrency } from '../utils/currency';
import { useSupabaseRealtimeChannel } from '../hooks/useSupabaseRealtimeChannel';

interface PendingApproval {
  id: string;
  type: 'sales_order' | 'delivery_challan' | 'expense' | 'petty_cash';
  number: string;
  description: string;
  amount?: number;
  currency?: string;
  date: string;
}

interface CompanyRef {
  company_name?: string;
}

export function ApprovalNotifications() {
  const { profile } = useAuth();
  const { setCurrentPage, setNavigationData } = useNavigation();
  const [pendingApprovals, setPendingApprovals] = useState<PendingApproval[]>([]);
  const [showNotification, setShowNotification] = useState(false);
  const [dismissedSignature, setDismissedSignature] = useState<string | null>(null);

  const getDismissKey = useCallback(() => `approval_popup_dismissed_${profile?.id ?? 'unknown'}`, [profile?.id]);
  const getSignature = useCallback((approvals: PendingApproval[]) =>
    approvals
      .map(item => `${item.type}:${item.id}`)
      .sort()
      .join('|'), []);

  const getCompanyName = (rawCustomer: unknown) => {
    if (Array.isArray(rawCustomer)) {
      return (rawCustomer[0] as CompanyRef | undefined)?.company_name || 'Unknown';
    }
    return (rawCustomer as CompanyRef | null)?.company_name || 'Unknown';
  };

  const loadPendingApprovals = useCallback(async () => {
    try {
      const approvals: PendingApproval[] = [];

      const [soRes, dcRes, expRes, pcRes] = await Promise.all([
        supabase
          .from('sales_orders')
          .select('id, so_number, so_date, total_amount, currency, customers(company_name)')
          .eq('status', 'pending_approval')
          .order('created_at', { ascending: false })
          .limit(5),

        supabase
          .from('delivery_challans')
          .select('id, challan_number, challan_date, customers(company_name)')
          .eq('approval_status', 'pending_approval')
          .order('created_at', { ascending: false })
          .limit(5),

        supabase
          .from('finance_expenses')
          .select(`
            id, voucher_number, expense_date, amount, description,
            transaction_currency, currency_code, payment_currency,
            bank_account_currency, bank_accounts(currency)
          `)
          .eq('approval_status', 'pending_approval')
          .order('created_at', { ascending: false })
          .limit(5),

        supabase
          .from('petty_cash_transactions')
          .select('id, transaction_number, transaction_date, amount, description')
          .is('fund_transfer_id', null)
          .eq('approval_status', 'pending_approval')
          .order('created_at', { ascending: false })
          .limit(5),
      ]);

      soRes.data?.forEach(so => approvals.push({
        id: so.id, type: 'sales_order', number: so.so_number,
        description: getCompanyName(so.customers),
        amount: so.total_amount, currency: so.currency || 'IDR', date: so.so_date,
      }));

      dcRes.data?.forEach(ch => approvals.push({
        id: ch.id, type: 'delivery_challan', number: ch.challan_number,
        description: getCompanyName(ch.customers),
        date: ch.challan_date,
      }));

      expRes.data?.forEach(e => approvals.push({
        id: e.id, type: 'expense', number: e.voucher_number || '—',
        description: e.description || 'Expense',
        amount: e.amount, currency: resolveTransactionCurrency(e), date: e.expense_date,
      }));

      pcRes.data?.forEach(pc => approvals.push({
        id: pc.id, type: 'petty_cash', number: pc.transaction_number,
        description: pc.description || 'Petty Cash',
        amount: pc.amount, currency: resolveTransactionCurrency(undefined), date: pc.transaction_date,
      }));

      setPendingApprovals(approvals);
      const currentSignature = getSignature(approvals);
      if (approvals.length > 0 && currentSignature !== dismissedSignature) {
        setShowNotification(true);
      } else {
        setShowNotification(false);
      }
    } catch (error) {
      console.error('Error loading pending approvals:', error);
    }
  }, [dismissedSignature, getSignature]);

  useEffect(() => {
    if (profile?.role !== 'admin') return;

    try {
      const stored = localStorage.getItem(getDismissKey());
      setDismissedSignature(stored || null);
    } catch {
      setDismissedSignature(null);
    }

    loadPendingApprovals();

    // Realtime + on-focus refresh replaces the 60s polling.
    const onFocus = () => loadPendingApprovals();
    window.addEventListener('focus', onFocus);

    return () => {
      window.removeEventListener('focus', onFocus);
    };
  }, [getDismissKey, loadPendingApprovals, profile?.role]);

  const approvalEnabled = profile?.role === 'admin';
  const onApprovalEvent = () => { loadPendingApprovals(); };
  useSupabaseRealtimeChannel({
    channelName: 'approval_popup_sales_orders',
    table: 'sales_orders',
    enabled: approvalEnabled,
    onEvent: onApprovalEvent,
  });
  useSupabaseRealtimeChannel({
    channelName: 'approval_popup_delivery_challans',
    table: 'delivery_challans',
    enabled: approvalEnabled,
    onEvent: onApprovalEvent,
  });
  useSupabaseRealtimeChannel({
    channelName: 'approval_popup_finance_expenses',
    table: 'finance_expenses',
    enabled: approvalEnabled,
    onEvent: onApprovalEvent,
  });
  useSupabaseRealtimeChannel({
    channelName: 'approval_popup_petty_cash',
    table: 'petty_cash_transactions',
    enabled: approvalEnabled,
    onEvent: onApprovalEvent,
  });

  const handleViewItem = (item: PendingApproval) => {
    setShowNotification(false);
    const signature = getSignature(pendingApprovals);
    try {
      localStorage.setItem(getDismissKey(), signature);
      setDismissedSignature(signature);
    } catch {
      // Ignore storage failures
    }
    if (item.type === 'sales_order') setCurrentPage('sales-orders');
    else if (item.type === 'delivery_challan') setCurrentPage('delivery-challan');
    else {
      setNavigationData({
        sourceType: item.type,
        sourceId: item.id,
      });
      setCurrentPage('finance');
    }
  };

  const handleDismiss = () => {
    setShowNotification(false);
    const signature = getSignature(pendingApprovals);
    try {
      localStorage.setItem(getDismissKey(), signature);
      setDismissedSignature(signature);
    } catch {
      // Ignore storage failures
    }
  };

  if (!showNotification || pendingApprovals.length === 0) return null;

  const typeConfig = {
    sales_order:     { label: 'Sales Order',     bg: 'bg-blue-100',   text: 'text-blue-600',   Icon: FileText },
    delivery_challan:{ label: 'Delivery Challan', bg: 'bg-green-100',  text: 'text-green-600',  Icon: Truck },
    expense:         { label: 'Expense',          bg: 'bg-orange-100', text: 'text-orange-600', Icon: DollarSign },
    petty_cash:      { label: 'Petty Cash',       bg: 'bg-yellow-100', text: 'text-yellow-600', Icon: Wallet },
  };

  return (
    <div className="fixed bottom-4 right-4 z-50 w-96 max-h-[600px] overflow-hidden rounded-lg shadow-2xl bg-white border border-gray-200 animate-slide-up">
      <div className="bg-gradient-to-r from-blue-600 to-blue-700 text-white px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 bg-green-400 rounded-full animate-pulse" />
          <h3 className="font-semibold">Pending Approvals</h3>
          <span className="bg-white/20 text-xs px-2 py-0.5 rounded-full">{pendingApprovals.length}</span>
        </div>
        <button onClick={handleDismiss} className="text-white/80 hover:text-white transition">
          <X className="w-5 h-5" />
        </button>
      </div>

      <div className="max-h-[500px] overflow-y-auto">
        {pendingApprovals.map((item, index) => {
          const cfg = typeConfig[item.type];
          const Icon = cfg.Icon;
          return (
            <div
              key={`${item.type}-${item.id}`}
              className={`p-4 border-b border-gray-100 hover:bg-gray-50 cursor-pointer transition ${index === 0 ? 'bg-blue-50' : ''}`}
              onClick={() => handleViewItem(item)}
            >
              <div className="flex items-start gap-3">
                <div className={`p-2 rounded-lg ${cfg.bg} ${cfg.text}`}>
                  <Icon className="w-5 h-5" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="text-sm font-semibold text-gray-900">{cfg.label}</p>
                      <p className="text-xs text-gray-600 mt-0.5">{item.number}</p>
                    </div>
                    <span className="text-xs text-gray-500 whitespace-nowrap">
                      {new Date(item.date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}
                    </span>
                  </div>
                  <p className="text-sm text-gray-700 mt-1 truncate">{item.description}</p>
                  {item.amount !== undefined && (
                    <p className="text-xs font-medium text-blue-600 mt-1">
                      {formatCurrency(item.amount, item.currency)}
                    </p>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="bg-gray-50 px-4 py-3 text-center">
        <p className="text-xs text-gray-500">Click on an item to review and approve</p>
      </div>

      <style>{`
        @keyframes slide-up {
          from { transform: translateY(100%); opacity: 0; }
          to   { transform: translateY(0);    opacity: 1; }
        }
        .animate-slide-up { animation: slide-up 0.3s ease-out; }
      `}</style>
    </div>
  );
}
