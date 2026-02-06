import { useEffect, useState } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import { supabase } from '../../lib/supabase';
import { Target } from 'lucide-react';

interface PipelineData {
  status: string;
  label: string;
  count: number;
  amount: number;
  color: string;
}

const STATUS_CONFIG: Record<string, { label: string; color: string }> = {
  pending_approval: { label: 'Pending', color: '#f59e0b' },
  approved: { label: 'Approved', color: '#3b82f6' },
  processing: { label: 'Processing', color: '#8b5cf6' },
  completed: { label: 'Completed', color: '#10b981' },
  rejected: { label: 'Rejected', color: '#ef4444' },
  cancelled: { label: 'Cancelled', color: '#6b7280' },
};

export function SalesPipelineChart() {
  const [data, setData] = useState<PipelineData[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      const { data: orders } = await supabase
        .from('sales_orders')
        .select('status, total_amount')
        .eq('is_archived', false);

      const statusMap = new Map<string, { count: number; amount: number }>();
      (orders || []).forEach(order => {
        const existing = statusMap.get(order.status) || { count: 0, amount: 0 };
        existing.count += 1;
        existing.amount += Number(order.total_amount) || 0;
        statusMap.set(order.status, existing);
      });

      const chartData: PipelineData[] = [];
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

  const totalOrders = data.reduce((s, d) => s + d.count, 0);

  if (loading) {
    return (
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
        <div className="h-64 animate-pulse bg-gray-100 rounded-lg" />
      </div>
    );
  }

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h3 className="text-base font-semibold text-gray-900">Sales Pipeline</h3>
          <p className="text-sm text-gray-500 mt-0.5">Active orders by status</p>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-right">
            <p className="text-xs text-gray-500">Total Orders</p>
            <p className="text-sm font-bold text-gray-900">{totalOrders}</p>
          </div>
          <div className="bg-blue-50 p-2 rounded-lg">
            <Target className="w-5 h-5 text-blue-600" />
          </div>
        </div>
      </div>
      {data.length > 0 ? (
        <ResponsiveContainer width="100%" height={240}>
          <BarChart data={data} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" vertical={false} />
            <XAxis dataKey="label" tick={{ fontSize: 12, fill: '#6b7280' }} tickLine={false} axisLine={false} />
            <YAxis tick={{ fontSize: 12, fill: '#6b7280' }} tickLine={false} axisLine={false} allowDecimals={false} />
            <Tooltip
              contentStyle={{ borderRadius: '8px', border: '1px solid #e5e7eb', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.05)' }}
              formatter={(value: number, name: string) => {
                if (name === 'count') return [value, 'Orders'];
                return [value, name];
              }}
              labelStyle={{ fontWeight: 600, color: '#111827' }}
            />
            <Bar dataKey="count" radius={[6, 6, 0, 0]} maxBarSize={48}>
              {data.map((entry, index) => (
                <Cell key={index} fill={entry.color} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      ) : (
        <div className="h-60 flex items-center justify-center text-gray-400 text-sm">No sales order data</div>
      )}
    </div>
  );
}
