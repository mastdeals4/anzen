import { useEffect, useState } from 'react';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts';
import { supabase } from '../../lib/supabase';
import { Wallet } from 'lucide-react';

interface PaymentData {
  status: string;
  label: string;
  count: number;
  amount: number;
  color: string;
}

const STATUS_CONFIG: Record<string, { label: string; color: string }> = {
  paid: { label: 'Paid', color: '#10b981' },
  partial: { label: 'Partial', color: '#f59e0b' },
  pending: { label: 'Unpaid', color: '#ef4444' },
};

export function PaymentOverview() {
  const [data, setData] = useState<PaymentData[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      const threeMonthsAgo = new Date();
      threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);

      const { data: invoices } = await supabase
        .from('sales_invoices')
        .select('payment_status, total_amount')
        .gte('invoice_date', threeMonthsAgo.toISOString().split('T')[0]);

      const statusMap = new Map<string, { count: number; amount: number }>();
      (invoices || []).forEach(inv => {
        const status = inv.payment_status || 'pending';
        const existing = statusMap.get(status) || { count: 0, amount: 0 };
        existing.count += 1;
        existing.amount += Number(inv.total_amount) || 0;
        statusMap.set(status, existing);
      });

      const chartData: PaymentData[] = [];
      Object.entries(STATUS_CONFIG).forEach(([status, config]) => {
        const entry = statusMap.get(status);
        if (entry && entry.count > 0) {
          chartData.push({
            status,
            label: config.label,
            count: entry.count,
            amount: Math.round(entry.amount),
            color: config.color,
          });
        }
      });

      setData(chartData);
    } catch {
      setData([]);
    } finally {
      setLoading(false);
    }
  };

  const formatCurrency = (value: number) => {
    if (value >= 1_000_000_000) return `Rp ${(value / 1_000_000_000).toFixed(1)}B`;
    if (value >= 1_000_000) return `Rp ${(value / 1_000_000).toFixed(1)}M`;
    if (value >= 1_000) return `Rp ${(value / 1_000).toFixed(0)}K`;
    return `Rp ${value}`;
  };

  const totalAmount = data.reduce((s, d) => s + d.amount, 0);
  const totalCount = data.reduce((s, d) => s + d.count, 0);

  if (loading) {
    return (
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
        <div className="h-64 animate-pulse bg-gray-100 rounded-lg" />
      </div>
    );
  }

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-base font-semibold text-gray-900">Payment Status</h3>
          <p className="text-sm text-gray-500 mt-0.5">Last 3 months invoices</p>
        </div>
        <div className="bg-emerald-50 p-2 rounded-lg">
          <Wallet className="w-5 h-5 text-emerald-600" />
        </div>
      </div>
      {data.length > 0 ? (
        <div className="flex items-center gap-4">
          <div className="w-40 h-40 flex-shrink-0">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={data}
                  cx="50%"
                  cy="50%"
                  innerRadius={38}
                  outerRadius={65}
                  paddingAngle={3}
                  dataKey="amount"
                  strokeWidth={0}
                >
                  {data.map((entry, index) => (
                    <Cell key={index} fill={entry.color} />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={{ borderRadius: '8px', border: '1px solid #e5e7eb', fontSize: '12px' }}
                  formatter={(value: number) => [formatCurrency(value), 'Amount']}
                />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <div className="flex-1 space-y-3">
            {data.map((item, index) => (
              <div key={index} className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="w-3 h-3 rounded-full" style={{ backgroundColor: item.color }} />
                  <span className="text-sm text-gray-600">{item.label}</span>
                </div>
                <div className="text-right">
                  <span className="text-sm font-semibold text-gray-900">{item.count}</span>
                  <span className="text-xs text-gray-400 ml-1">inv</span>
                </div>
              </div>
            ))}
            <div className="pt-2 border-t border-gray-100">
              <div className="flex items-center justify-between">
                <span className="text-xs text-gray-500">Total ({totalCount} invoices)</span>
                <span className="text-sm font-bold text-gray-900">{formatCurrency(totalAmount)}</span>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="h-40 flex items-center justify-center text-gray-400 text-sm">No invoice data</div>
      )}
    </div>
  );
}
