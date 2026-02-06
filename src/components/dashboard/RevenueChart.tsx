import { useEffect, useState } from 'react';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { supabase } from '../../lib/supabase';
import { TrendingUp } from 'lucide-react';

interface MonthlyData {
  month: string;
  revenue: number;
  invoices: number;
}

export function RevenueChart() {
  const [data, setData] = useState<MonthlyData[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      const sixMonthsAgo = new Date();
      sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 5);
      sixMonthsAgo.setDate(1);

      const { data: invoices } = await supabase
        .from('sales_invoices')
        .select('invoice_date, total_amount')
        .gte('invoice_date', sixMonthsAgo.toISOString().split('T')[0])
        .order('invoice_date', { ascending: true });

      const monthMap = new Map<string, { revenue: number; invoices: number }>();

      for (let i = 0; i < 6; i++) {
        const d = new Date();
        d.setMonth(d.getMonth() - (5 - i));
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        monthMap.set(key, { revenue: 0, invoices: 0 });
      }

      (invoices || []).forEach(inv => {
        const date = new Date(inv.invoice_date);
        const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
        const existing = monthMap.get(key);
        if (existing) {
          existing.revenue += Number(inv.total_amount) || 0;
          existing.invoices += 1;
        }
      });

      const chartData: MonthlyData[] = [];
      monthMap.forEach((value, key) => {
        const [year, month] = key.split('-');
        const date = new Date(Number(year), Number(month) - 1);
        chartData.push({
          month: date.toLocaleDateString('en-US', { month: 'short', year: '2-digit' }),
          revenue: Math.round(value.revenue),
          invoices: value.invoices,
        });
      });

      setData(chartData);
    } catch {
      setData([]);
    } finally {
      setLoading(false);
    }
  };

  const formatValue = (value: number) => {
    if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
    if (value >= 1_000) return `${(value / 1_000).toFixed(0)}K`;
    return value.toString();
  };

  const totalRevenue = data.reduce((s, d) => s + d.revenue, 0);
  const totalInvoices = data.reduce((s, d) => s + d.invoices, 0);

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
          <h3 className="text-base font-semibold text-gray-900">Revenue Trend</h3>
          <p className="text-sm text-gray-500 mt-0.5">Last 6 months</p>
        </div>
        <div className="flex items-center gap-4">
          <div className="text-right">
            <p className="text-xs text-gray-500">Total Revenue</p>
            <p className="text-sm font-bold text-gray-900">Rp {formatValue(totalRevenue)}</p>
          </div>
          <div className="text-right">
            <p className="text-xs text-gray-500">Invoices</p>
            <p className="text-sm font-bold text-gray-900">{totalInvoices}</p>
          </div>
          <div className="bg-emerald-50 p-2 rounded-lg">
            <TrendingUp className="w-5 h-5 text-emerald-600" />
          </div>
        </div>
      </div>
      {data.length > 0 ? (
        <ResponsiveContainer width="100%" height={240}>
          <AreaChart data={data} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="revenueGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#059669" stopOpacity={0.15} />
                <stop offset="95%" stopColor="#059669" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
            <XAxis dataKey="month" tick={{ fontSize: 12, fill: '#6b7280' }} tickLine={false} axisLine={false} />
            <YAxis tick={{ fontSize: 12, fill: '#6b7280' }} tickLine={false} axisLine={false} tickFormatter={formatValue} width={50} />
            <Tooltip
              contentStyle={{ borderRadius: '8px', border: '1px solid #e5e7eb', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.05)' }}
              formatter={(value: number) => [`Rp ${value.toLocaleString('id-ID')}`, 'Revenue']}
              labelStyle={{ fontWeight: 600, color: '#111827' }}
            />
            <Area type="monotone" dataKey="revenue" stroke="#059669" strokeWidth={2.5} fill="url(#revenueGradient)" />
          </AreaChart>
        </ResponsiveContainer>
      ) : (
        <div className="h-60 flex items-center justify-center text-gray-400 text-sm">No revenue data available</div>
      )}
    </div>
  );
}
