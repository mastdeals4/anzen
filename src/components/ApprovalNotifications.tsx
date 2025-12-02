import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { useNavigation } from '../contexts/NavigationContext';
import { X, FileText, Truck, CheckCircle, XCircle } from 'lucide-react';

interface PendingApproval {
  id: string;
  type: 'sales_order' | 'delivery_challan';
  number: string;
  customer_name: string;
  amount?: number;
  date: string;
}

export function ApprovalNotifications() {
  const { profile } = useAuth();
  const { setCurrentPage } = useNavigation();
  const [pendingApprovals, setPendingApprovals] = useState<PendingApproval[]>([]);
  const [showNotification, setShowNotification] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (profile?.role === 'admin') {
      loadPendingApprovals();
    }
  }, [profile]);

  const loadPendingApprovals = async () => {
    try {
      const approvals: PendingApproval[] = [];

      // Load pending sales orders
      const { data: salesOrders } = await supabase
        .from('sales_orders')
        .select(`
          id,
          so_number,
          so_date,
          total_amount,
          customers (company_name)
        `)
        .eq('status', 'pending_approval')
        .order('created_at', { ascending: false })
        .limit(5);

      if (salesOrders) {
        salesOrders.forEach(so => {
          approvals.push({
            id: so.id,
            type: 'sales_order',
            number: so.so_number,
            customer_name: (so.customers as any)?.company_name || 'Unknown',
            amount: so.total_amount,
            date: so.so_date
          });
        });
      }

      // Load pending delivery challans
      const { data: challans } = await supabase
        .from('delivery_challans')
        .select(`
          id,
          challan_number,
          challan_date,
          customers (company_name)
        `)
        .eq('approval_status', 'pending_approval')
        .order('created_at', { ascending: false })
        .limit(5);

      if (challans) {
        challans.forEach(ch => {
          approvals.push({
            id: ch.id,
            type: 'delivery_challan',
            number: ch.challan_number,
            customer_name: (ch.customers as any)?.company_name || 'Unknown',
            date: ch.challan_date
          });
        });
      }

      setPendingApprovals(approvals);
      if (approvals.length > 0 && !dismissed) {
        setShowNotification(true);
      }
    } catch (error) {
      console.error('Error loading pending approvals:', error);
    }
  };

  const handleViewItem = (item: PendingApproval) => {
    setShowNotification(false);
    setDismissed(true);
    if (item.type === 'sales_order') {
      setCurrentPage('sales-orders');
    } else {
      setCurrentPage('delivery-challan');
    }
  };

  const handleDismiss = () => {
    setShowNotification(false);
    setDismissed(true);
  };

  if (!showNotification || pendingApprovals.length === 0) {
    return null;
  }

  return (
    <div className="fixed bottom-4 right-4 z-50 w-96 max-h-[600px] overflow-hidden rounded-lg shadow-2xl bg-white border border-gray-200 animate-slide-up">
      {/* Header */}
      <div className="bg-gradient-to-r from-blue-600 to-blue-700 text-white px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 bg-green-400 rounded-full animate-pulse"></div>
          <h3 className="font-semibold">Pending Approvals</h3>
          <span className="bg-white/20 text-xs px-2 py-0.5 rounded-full">
            {pendingApprovals.length}
          </span>
        </div>
        <button
          onClick={handleDismiss}
          className="text-white/80 hover:text-white transition"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      {/* Content */}
      <div className="max-h-[500px] overflow-y-auto">
        {pendingApprovals.map((item, index) => (
          <div
            key={`${item.type}-${item.id}`}
            className={`p-4 border-b border-gray-100 hover:bg-gray-50 cursor-pointer transition ${
              index === 0 ? 'bg-blue-50' : ''
            }`}
            onClick={() => handleViewItem(item)}
          >
            <div className="flex items-start gap-3">
              {/* Icon */}
              <div className={`p-2 rounded-lg ${
                item.type === 'sales_order'
                  ? 'bg-blue-100 text-blue-600'
                  : 'bg-green-100 text-green-600'
              }`}>
                {item.type === 'sales_order' ? (
                  <FileText className="w-5 h-5" />
                ) : (
                  <Truck className="w-5 h-5" />
                )}
              </div>

              {/* Content */}
              <div className="flex-1 min-w-0">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold text-gray-900">
                      {item.type === 'sales_order' ? 'Sales Order' : 'Delivery Challan'}
                    </p>
                    <p className="text-xs text-gray-600 mt-0.5">
                      {item.number}
                    </p>
                  </div>
                  <span className="text-xs text-gray-500 whitespace-nowrap">
                    {new Date(item.date).toLocaleDateString('en-GB', {
                      day: '2-digit',
                      month: 'short'
                    })}
                  </span>
                </div>

                <p className="text-sm text-gray-700 mt-1 truncate">
                  {item.customer_name}
                </p>

                {item.amount && (
                  <p className="text-xs font-medium text-blue-600 mt-1">
                    Rp {item.amount.toLocaleString('id-ID', {
                      minimumFractionDigits: 0,
                      maximumFractionDigits: 0
                    })}
                  </p>
                )}

                {index === 0 && (
                  <div className="flex items-center gap-2 mt-2">
                    <span className="text-xs text-blue-600 font-medium">
                      Click to review →
                    </span>
                  </div>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Footer */}
      <div className="bg-gray-50 px-4 py-3 text-center">
        <button
          onClick={() => {
            handleDismiss();
            setCurrentPage('sales-orders');
          }}
          className="text-sm text-blue-600 hover:text-blue-700 font-medium"
        >
          View All Pending Approvals
        </button>
      </div>

      <style>{`
        @keyframes slide-up {
          from {
            transform: translateY(100%);
            opacity: 0;
          }
          to {
            transform: translateY(0);
            opacity: 1;
          }
        }
        .animate-slide-up {
          animation: slide-up 0.3s ease-out;
        }
      `}</style>
    </div>
  );
}
