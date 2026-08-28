import { useEffect, useState, useCallback } from 'react';
import { Layout } from '../../components/Layout';
import { useFinance } from '../../contexts/FinanceContext';
import { supabase } from '../../lib/supabase';
import { formatCurrency, formatNumber } from '../../utils/currency';
import {
  TrendingUp, TrendingDown, ChevronDown, ChevronRight,
  RefreshCw, X, BarChart2, Package, DollarSign, Percent,
} from 'lucide-react';

// ─── Types ────────────────────────────────────────────────────────────────────

interface ProductRow {
  product_id: string;
  product_name: string;
  product_code: string;
  total_qty_sold: number;
  total_sales_value: number;
  total_cost_value: number;
  total_profit: number;
  profit_pct: number;
  avg_selling_price: number;
  avg_cost_per_unit: number;
}

interface DrilldownRow {
  invoice_id: string;
  invoice_number: string;
  invoice_date: string;
  customer_name: string;
  batch_number: string;
  qty: number;
  selling_price: number;
  cost_per_unit: number;
  line_sales: number;
  line_cost: number;
  line_profit: number;
  profit_pct: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ProfitBadge({ pct }: { pct: number }) {
  const good = pct >= 20;
  const ok   = pct >= 0;
  const cls  = good
    ? 'bg-green-100 text-green-700'
    : ok
    ? 'bg-amber-100 text-amber-700'
    : 'bg-red-100 text-red-700';
  const Icon = good ? TrendingUp : ok ? TrendingUp : TrendingDown;
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold ${cls}`}>
      <Icon className="w-3 h-3" />
      {formatNumber(pct, 1)}%
    </span>
  );
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-white border border-gray-200 rounded-xl px-5 py-4 shadow-sm">
      <p className="text-xs text-gray-500 font-medium">{label}</p>
      <p className="text-xl font-bold text-gray-900 mt-1">{value}</p>
      {sub && <p className="text-xs text-gray-400 mt-0.5">{sub}</p>}
    </div>
  );
}

// ─── Drilldown panel ─────────────────────────────────────────────────────────

function DrilldownPanel({
  product,
  rows,
  loading,
  onClose,
}: {
  product: ProductRow;
  rows: DrilldownRow[];
  loading: boolean;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex">
      {/* Backdrop */}
      <div className="flex-1 bg-gray-900/40" onClick={onClose} />

      {/* Panel */}
      <div className="w-full max-w-4xl bg-white shadow-2xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 bg-gray-50">
          <div>
            <p className="text-xs text-gray-400 uppercase tracking-wide font-medium">Drill-down</p>
            <h2 className="text-base font-bold text-gray-900 mt-0.5">{product.product_name}</h2>
            {product.product_code && (
              <p className="text-xs text-gray-400">{product.product_code}</p>
            )}
          </div>
          <div className="flex items-center gap-4">
            <div className="text-right">
              <p className="text-xs text-gray-400">Total Profit</p>
              <p className={`text-lg font-bold ${product.total_profit >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                {formatCurrency(product.total_profit)}
              </p>
            </div>
            <ProfitBadge pct={product.profit_pct} />
            <button onClick={onClose} className="p-2 rounded-lg hover:bg-gray-200 transition">
              <X className="w-5 h-5 text-gray-500" />
            </button>
          </div>
        </div>

        {/* Summary bar */}
        <div className="grid grid-cols-4 divide-x divide-gray-100 border-b border-gray-200 bg-white">
          {[
            { label: 'Total Qty', value: formatNumber(product.total_qty_sold, 3) },
            { label: 'Sales Value', value: formatCurrency(product.total_sales_value) },
            { label: 'Cost Value',  value: formatCurrency(product.total_cost_value) },
            { label: 'Avg Selling', value: formatCurrency(product.avg_selling_price) },
          ].map(s => (
            <div key={s.label} className="px-5 py-3 text-center">
              <p className="text-xs text-gray-400">{s.label}</p>
              <p className="text-sm font-semibold text-gray-800 mt-0.5">{s.value}</p>
            </div>
          ))}
        </div>

        {/* Table */}
        <div className="flex-1 overflow-auto">
          {loading ? (
            <div className="flex items-center justify-center py-16 text-gray-400">
              <div className="w-5 h-5 border-2 border-blue-400 border-t-transparent rounded-full animate-spin mr-2" />
              Loading…
            </div>
          ) : rows.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-gray-400">
              <Package className="w-8 h-8 mb-2 opacity-30" />
              <p className="text-sm">No invoice lines found in this period</p>
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-gray-50 border-b border-gray-200">
                <tr>
                  {['Invoice No', 'Date', 'Customer', 'Batch', 'Qty', 'Sell Price', 'Cost/Unit', 'Sales', 'Cost', 'Profit', 'Margin'].map(h => (
                    <th key={h} className="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 whitespace-nowrap">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {rows.map((r, i) => (
                  <tr key={`${r.invoice_id}-${i}`} className="hover:bg-blue-50/40 transition-colors">
                    <td className="px-4 py-2 font-mono text-xs font-medium text-blue-700 whitespace-nowrap">{r.invoice_number}</td>
                    <td className="px-4 py-2 text-xs text-gray-600 whitespace-nowrap">{r.invoice_date}</td>
                    <td className="px-4 py-2 text-xs text-gray-800 max-w-[140px] truncate">{r.customer_name}</td>
                    <td className="px-4 py-2 text-xs text-gray-500 font-mono whitespace-nowrap">{r.batch_number || '—'}</td>
                    <td className="px-4 py-2 text-right text-xs font-medium text-gray-800">{formatNumber(r.qty, 3)}</td>
                    <td className="px-4 py-2 text-right text-xs text-gray-700">{formatCurrency(r.selling_price)}</td>
                    <td className="px-4 py-2 text-right text-xs text-gray-500">{formatCurrency(r.cost_per_unit)}</td>
                    <td className="px-4 py-2 text-right text-xs font-medium text-gray-800">{formatCurrency(r.line_sales)}</td>
                    <td className="px-4 py-2 text-right text-xs text-gray-500">{formatCurrency(r.line_cost)}</td>
                    <td className={`px-4 py-2 text-right text-xs font-semibold ${r.line_profit >= 0 ? 'text-green-700' : 'text-red-600'}`}>
                      {formatCurrency(r.line_profit)}
                    </td>
                    <td className="px-4 py-2 text-right">
                      <ProfitBadge pct={r.profit_pct} />
                    </td>
                  </tr>
                ))}
              </tbody>
              {/* Totals footer */}
              <tfoot className="border-t-2 border-gray-200 bg-gray-50 sticky bottom-0">
                <tr>
                  <td colSpan={4} className="px-4 py-2.5 text-xs font-bold text-gray-600">TOTAL</td>
                  <td className="px-4 py-2.5 text-right text-xs font-bold text-gray-800">
                    {formatNumber(rows.reduce((s, r) => s + r.qty, 0), 3)}
                  </td>
                  <td />
                  <td />
                  <td className="px-4 py-2.5 text-right text-xs font-bold text-gray-800">
                    {formatCurrency(rows.reduce((s, r) => s + r.line_sales, 0))}
                  </td>
                  <td className="px-4 py-2.5 text-right text-xs font-semibold text-gray-500">
                    {formatCurrency(rows.reduce((s, r) => s + r.line_cost, 0))}
                  </td>
                  <td className="px-4 py-2.5 text-right text-xs font-bold text-green-700">
                    {formatCurrency(rows.reduce((s, r) => s + r.line_profit, 0))}
                  </td>
                  <td />
                </tr>
              </tfoot>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export function SalesProfitReport() {
  const { dateRange } = useFinance();
  const [rows, setRows] = useState<ProductRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<keyof ProductRow>('total_profit');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  const [drillProduct, setDrillProduct] = useState<ProductRow | null>(null);
  const [drillRows, setDrillRows] = useState<DrilldownRow[]>([]);
  const [drillLoading, setDrillLoading] = useState(false);

  const loadReport = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase.rpc('get_sales_profit_summary', {
      p_start_date: dateRange.startDate,
      p_end_date: dateRange.endDate,
    });
    if (!error) setRows((data as ProductRow[]) || []);
    setLoading(false);
  }, [dateRange.startDate, dateRange.endDate]);

  useEffect(() => { loadReport(); }, [loadReport]);

  const openDrilldown = async (product: ProductRow) => {
    setDrillProduct(product);
    setDrillRows([]);
    setDrillLoading(true);
    const { data } = await supabase.rpc('get_sales_profit_drilldown', {
      p_product_id: product.product_id,
      p_start_date: dateRange.startDate,
      p_end_date:   dateRange.endDate,
    });
    setDrillRows((data as DrilldownRow[]) || []);
    setDrillLoading(false);
  };

  const handleSort = (key: keyof ProductRow) => {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir('desc'); }
  };

  const filtered = rows
    .filter(r => r.product_name.toLowerCase().includes(search.toLowerCase()) ||
                 r.product_code.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => {
      const av = a[sortKey] as number;
      const bv = b[sortKey] as number;
      return sortDir === 'asc' ? av - bv : bv - av;
    });

  // Summary stats
  const totalSales  = rows.reduce((s, r) => s + r.total_sales_value, 0);
  const totalCost   = rows.reduce((s, r) => s + r.total_cost_value,  0);
  const totalProfit = rows.reduce((s, r) => s + r.total_profit,      0);
  const overallPct  = totalSales > 0 ? (totalProfit / totalSales) * 100 : 0;
  const totalQty    = rows.reduce((s, r) => s + r.total_qty_sold, 0);

  const SortIcon = ({ col }: { col: keyof ProductRow }) =>
    sortKey === col
      ? <span className="ml-1 text-blue-500">{sortDir === 'asc' ? '↑' : '↓'}</span>
      : <span className="ml-1 text-gray-300">↕</span>;

  const thCls = (col: keyof ProductRow) =>
    `px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide cursor-pointer select-none whitespace-nowrap hover:text-gray-800 transition-colors ${sortKey === col ? 'text-blue-600' : ''}`;

  return (
    <Layout>
      <div className="space-y-5">
        {/* Page title */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-blue-50 rounded-lg">
              <BarChart2 className="w-5 h-5 text-blue-600" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-gray-900">Sales Profit Report</h1>
              <p className="text-sm text-gray-400 mt-0.5">
                {dateRange.startDate} — {dateRange.endDate} · Adjust range via header date filter
              </p>
            </div>
          </div>
          <button
            onClick={loadReport}
            disabled={loading}
            className="flex items-center gap-2 px-3 py-2 text-sm text-gray-600 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>

        {/* Summary cards */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <StatCard label="Total Sales" value={formatCurrency(totalSales)} sub={`${rows.length} products`} />
          <StatCard label="Total COGS"  value={formatCurrency(totalCost)}  sub="Cost of goods sold" />
          <StatCard
            label="Gross Profit"
            value={formatCurrency(totalProfit)}
            sub={`${formatNumber(overallPct, 1)}% margin`}
          />
          <StatCard label="Total Qty Sold" value={formatNumber(totalQty, 0)} sub="across all products" />
        </div>

        {/* Profit bar visualisation */}
        {totalSales > 0 && (
          <div className="bg-white border border-gray-200 rounded-xl px-5 py-4 shadow-sm">
            <div className="flex justify-between text-xs text-gray-500 mb-2">
              <span className="font-medium">Revenue breakdown</span>
              <span>{formatNumber(overallPct, 1)}% profit margin</span>
            </div>
            <div className="h-3 bg-gray-100 rounded-full overflow-hidden flex">
              <div
                className="h-full bg-red-400 transition-all"
                style={{ width: `${Math.min((totalCost / totalSales) * 100, 100)}%` }}
                title="COGS"
              />
              <div
                className="h-full bg-green-500 transition-all"
                style={{ width: `${Math.max(0, Math.min((totalProfit / totalSales) * 100, 100))}%` }}
                title="Profit"
              />
            </div>
            <div className="flex gap-4 mt-2 text-xs text-gray-400">
              <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-red-400 inline-block" />COGS</span>
              <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-green-500 inline-block" />Profit</span>
            </div>
          </div>
        )}

        {/* Search */}
        <div className="flex items-center gap-3">
          <div className="relative flex-1 max-w-xs">
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search product…"
              className="w-full pl-3 pr-8 py-2 text-sm border border-gray-200 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
            />
            {search && (
              <button onClick={() => setSearch('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
          <span className="text-xs text-gray-400">{filtered.length} products</span>
        </div>

        {/* Main table */}
        <div className="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden">
          {loading ? (
            <div className="flex items-center justify-center py-16 text-gray-400">
              <div className="w-5 h-5 border-2 border-blue-400 border-t-transparent rounded-full animate-spin mr-2" />
              Loading report…
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-gray-400">
              <DollarSign className="w-10 h-10 mb-3 opacity-20" />
              <p className="text-sm font-medium">No sales data found</p>
              <p className="text-xs mt-1">Adjust the date range in the header</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide w-6" />
                    <th className={thCls('product_name')} onClick={() => handleSort('product_name')}>
                      Product <SortIcon col="product_name" />
                    </th>
                    <th className={`${thCls('total_qty_sold')} text-right`} onClick={() => handleSort('total_qty_sold')}>
                      Qty Sold <SortIcon col="total_qty_sold" />
                    </th>
                    <th className={`${thCls('avg_selling_price')} text-right`} onClick={() => handleSort('avg_selling_price')}>
                      Avg Sell Price <SortIcon col="avg_selling_price" />
                    </th>
                    <th className={`${thCls('avg_cost_per_unit')} text-right`} onClick={() => handleSort('avg_cost_per_unit')}>
                      Avg Cost/Unit <SortIcon col="avg_cost_per_unit" />
                    </th>
                    <th className={`${thCls('total_sales_value')} text-right`} onClick={() => handleSort('total_sales_value')}>
                      Total Sales <SortIcon col="total_sales_value" />
                    </th>
                    <th className={`${thCls('total_cost_value')} text-right`} onClick={() => handleSort('total_cost_value')}>
                      Total Cost <SortIcon col="total_cost_value" />
                    </th>
                    <th className={`${thCls('total_profit')} text-right`} onClick={() => handleSort('total_profit')}>
                      Total Profit <SortIcon col="total_profit" />
                    </th>
                    <th className={`${thCls('profit_pct')} text-right`} onClick={() => handleSort('profit_pct')}>
                      Margin <SortIcon col="profit_pct" />
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {filtered.map((r, i) => (
                    <tr
                      key={r.product_id}
                      onClick={() => openDrilldown(r)}
                      className="hover:bg-blue-50/50 cursor-pointer transition-colors group"
                    >
                      <td className="px-4 py-3 text-gray-300 group-hover:text-blue-400 transition-colors">
                        <ChevronRight className="w-4 h-4" />
                      </td>
                      <td className="px-4 py-3">
                        <p className="font-medium text-gray-900">{r.product_name}</p>
                        {r.product_code && <p className="text-xs text-gray-400 font-mono">{r.product_code}</p>}
                      </td>
                      <td className="px-4 py-3 text-right font-medium text-gray-800">
                        {formatNumber(r.total_qty_sold, 3)}
                      </td>
                      <td className="px-4 py-3 text-right text-gray-700">
                        {formatCurrency(r.avg_selling_price)}
                      </td>
                      <td className="px-4 py-3 text-right text-gray-500">
                        {formatCurrency(r.avg_cost_per_unit)}
                      </td>
                      <td className="px-4 py-3 text-right font-medium text-gray-800">
                        {formatCurrency(r.total_sales_value)}
                      </td>
                      <td className="px-4 py-3 text-right text-gray-500">
                        {formatCurrency(r.total_cost_value)}
                      </td>
                      <td className={`px-4 py-3 text-right font-bold ${r.total_profit >= 0 ? 'text-green-700' : 'text-red-600'}`}>
                        {formatCurrency(r.total_profit)}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <ProfitBadge pct={r.profit_pct} />
                      </td>
                    </tr>
                  ))}
                </tbody>

                {/* Grand total footer */}
                <tfoot className="border-t-2 border-gray-200 bg-gray-50">
                  <tr>
                    <td colSpan={2} className="px-4 py-3 text-xs font-bold text-gray-600 uppercase">
                      Grand Total ({filtered.length} products)
                    </td>
                    <td className="px-4 py-3 text-right text-xs font-bold text-gray-800">
                      {formatNumber(filtered.reduce((s, r) => s + r.total_qty_sold, 0), 3)}
                    </td>
                    <td colSpan={2} />
                    <td className="px-4 py-3 text-right text-xs font-bold text-gray-800">
                      {formatCurrency(filtered.reduce((s, r) => s + r.total_sales_value, 0))}
                    </td>
                    <td className="px-4 py-3 text-right text-xs font-semibold text-gray-500">
                      {formatCurrency(filtered.reduce((s, r) => s + r.total_cost_value, 0))}
                    </td>
                    <td className="px-4 py-3 text-right text-xs font-bold text-green-700">
                      {formatCurrency(filtered.reduce((s, r) => s + r.total_profit, 0))}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <ProfitBadge pct={
                        filtered.reduce((s, r) => s + r.total_sales_value, 0) > 0
                          ? (filtered.reduce((s, r) => s + r.total_profit, 0) /
                             filtered.reduce((s, r) => s + r.total_sales_value, 0)) * 100
                          : 0
                      } />
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* Drill-down side panel */}
      {drillProduct && (
        <DrilldownPanel
          product={drillProduct}
          rows={drillRows}
          loading={drillLoading}
          onClose={() => setDrillProduct(null)}
        />
      )}
    </Layout>
  );
}
