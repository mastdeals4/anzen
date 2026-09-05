import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  BarChart2,
  Calendar,
  ChevronRight,
  HelpCircle,
  Info,
  Package,
  RefreshCw,
  Search,
  TrendingDown,
  TrendingUp,
  Truck,
  X,
} from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { formatCurrency, formatNumber } from '../../utils/currency';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CompanyProfitabilitySummary {
  gross_sales: number;
  product_cost: number;
  sales_expenses: number;
  unallocated_sales_expenses: number;
  gross_profit: number;
  profit_after_sales_expenses: number;
  profit_margin_pct: number;
  total_qty_sold: number;
  order_count: number;
  product_count: number;
}

export interface ProductProfitabilityRow {
  product_id: string;
  product_name: string;
  product_code: string;
  product_unit: string;
  current_stock: number;
  sold_qty: number;
  gross_sales: number;
  product_cost: number | null;
  sales_expense: number;
  gross_profit: number | null;
  profit_after_sales_expense: number | null;
  avg_landed_cost: number | null;
  avg_selling_price: number;
  sales_expense_per_unit: number;
  net_selling_price_per_unit: number;
  profit_per_unit: number | null;
  profit_margin_pct: number | null;
  costed_lines: number;
  total_lines: number;
  has_unreported_cost: boolean;
}

export interface MonthlyProfitabilityRow {
  month_label: string;
  month_start: string;
  gross_sales: number;
  product_cost: number;
  sales_expenses: number;
  gross_profit: number;
  profit_after_sales_expenses: number;
  profit_margin_pct: number;
  total_qty_sold: number;
  order_count: number;
}

export interface ProfitabilitySummaryResponse {
  company: CompanyProfitabilitySummary;
  products: ProductProfitabilityRow[];
  monthly: MonthlyProfitabilityRow[];
}

export interface BatchProfitabilityRow {
  batch_id: string;
  batch_number: string;
  current_stock: number;
  sold_qty: number;
  cost_per_unit: number | null;
  gross_sales: number;
  product_cost: number | null;
  sales_expense: number;
  gross_profit: number | null;
  profit_after_sales_expense: number | null;
  avg_selling_price: number;
  sales_expense_per_unit: number;
  net_selling_price_per_unit: number;
  profit_per_unit: number | null;
  profit_margin_pct: number | null;
  is_imported: boolean;
  cost_breakdown: {
    is_imported: boolean;
    import_price: number | null;
    import_price_usd: number | null;
    exchange_rate: number | null;
    duty_charges: number | null;
    freight_charges: number | null;
    other_charges: number | null;
    landed_cost_per_unit: number | null;
    local_cost_per_unit: number | null;
  };
}

export interface OrderSaleRow {
  line_id: string;
  invoice_id: string;
  invoice_number: string;
  invoice_date: string;
  customer_id: string;
  customer_name: string;
  sales_order_id: string | null;
  so_number: string | null;
  dc_id: string | null;
  dc_number: string | null;
  quantity: number;
  selling_price: number;
  gross_sales: number;
  unit_cost: number | null;
  line_cost: number | null;
  line_sales_expense: number;
  net_selling_realization: number;
  gross_profit: number | null;
  profit: number | null;
  profit_margin_pct: number | null;
  expenses: Array<{
    id: string;
    voucher_number: string;
    category: string;
    total_amount: number;
    description: string;
    expense_date: string;
  }>;
}

// ─── Helpers & Tooltips ──────────────────────────────────────────────────────

function TooltipHeader({ title, tooltip }: { title: string; tooltip: string }) {
  return (
    <div className="inline-flex items-center gap-1 group relative cursor-help">
      <span>{title}</span>
      <HelpCircle className="w-3.5 h-3.5 text-gray-400 group-hover:text-blue-600 transition-colors" />
      <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 hidden group-hover:block z-50 w-52 p-2 bg-gray-900 text-white text-[11px] rounded shadow-lg font-normal leading-tight text-center pointer-events-none">
        {tooltip}
        <div className="absolute top-full left-1/2 -translate-x-1/2 -mt-1 border-4 border-transparent border-t-gray-900" />
      </div>
    </div>
  );
}

function MarginBadge({ pct }: { pct: number | null }) {
  if (pct == null) {
    return <span className="text-xs text-amber-700 font-medium">Cost unavailable</span>;
  }
  const isGood = pct >= 15;
  const isPositive = pct >= 0;
  const badgeCls = isGood
    ? 'bg-green-100 text-green-800'
    : isPositive
    ? 'bg-emerald-50 text-emerald-700'
    : 'bg-red-100 text-red-700';

  const Icon = isPositive ? TrendingUp : TrendingDown;
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-semibold ${badgeCls}`}>
      <Icon className="w-3 h-3" />
      {formatNumber(pct, 1)}%
    </span>
  );
}

// ─── Date Presets ────────────────────────────────────────────────────────────

function getDatePreset(preset: string): { start: string; end: string } {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();

  const toYMD = (d: Date) => d.toISOString().split('T')[0];

  switch (preset) {
    case 'today':
      return { start: toYMD(now), end: toYMD(now) };
    case 'this_month': {
      const start = new Date(year, month, 1);
      const end = new Date(year, month + 1, 0);
      return { start: toYMD(start), end: toYMD(end) };
    }
    case 'last_month': {
      const start = new Date(year, month - 1, 1);
      const end = new Date(year, month, 0);
      return { start: toYMD(start), end: toYMD(end) };
    }
    case 'this_quarter': {
      const qStartMonth = Math.floor(month / 3) * 3;
      const start = new Date(year, qStartMonth, 1);
      const end = new Date(year, qStartMonth + 3, 0);
      return { start: toYMD(start), end: toYMD(end) };
    }
    case 'this_year': {
      const start = new Date(year, 0, 1);
      const end = new Date(year, 11, 31);
      return { start: toYMD(start), end: toYMD(end) };
    }
    case 'last_year': {
      const start = new Date(year - 1, 0, 1);
      const end = new Date(year - 1, 11, 31);
      return { start: toYMD(start), end: toYMD(end) };
    }
    case 'all_time':
    default:
      return { start: '2025-01-01', end: '2026-12-31' };
  }
}

// ─── Main Component ──────────────────────────────────────────────────────────

export function CanonicalSalesProfitReport() {
  const [datePreset, setDatePreset] = useState<string>('this_year');
  const [startDate, setStartDate] = useState<string>('2026-01-01');
  const [endDate, setEndDate] = useState<string>('2026-12-31');

  const [data, setData] = useState<ProfitabilitySummaryResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  // Drilldown states
  const [selectedProduct, setSelectedProduct] = useState<ProductProfitabilityRow | null>(null);
  const [productBatches, setProductBatches] = useState<BatchProfitabilityRow[]>([]);
  const [loadingBatches, setLoadingBatches] = useState(false);

  const [selectedBatch, setSelectedBatch] = useState<BatchProfitabilityRow | null>(null);
  const [batchOrders, setBatchOrders] = useState<OrderSaleRow[]>([]);
  const [loadingOrders, setLoadingOrders] = useState(false);

  // Load summary data
  const loadSummary = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data: res, error: rpcErr } = await supabase.rpc('get_sales_profitability_summary', {
        p_start_date: startDate,
        p_end_date: endDate,
      });

      if (rpcErr) throw rpcErr;
      setData(res as ProfitabilitySummaryResponse);
    } catch (err: any) {
      console.error('Error loading sales profitability summary:', err);
      setError(err.message || 'Failed to load profitability summary');
    } finally {
      setLoading(false);
    }
  }, [startDate, endDate]);

  useEffect(() => {
    void loadSummary();
  }, [loadSummary]);

  // Handle preset change
  const handlePresetChange = (preset: string) => {
    setDatePreset(preset);
    if (preset !== 'custom') {
      const { start, end } = getDatePreset(preset);
      setStartDate(start);
      setEndDate(end);
    }
  };

  // Open Product Drilldown
  const handleOpenProduct = async (prod: ProductProfitabilityRow) => {
    setSelectedProduct(prod);
    setSelectedBatch(null);
    setProductBatches([]);
    setLoadingBatches(true);
    try {
      const { data: res, error: rpcErr } = await supabase.rpc('get_sales_profitability_product_batches', {
        p_product_id: prod.product_id,
        p_start_date: startDate,
        p_end_date: endDate,
      });
      if (rpcErr) throw rpcErr;
      setProductBatches(res?.batches || []);
    } catch (err: any) {
      console.error('Error loading product batches:', err);
    } finally {
      setLoadingBatches(false);
    }
  };

  // Open Batch Drilldown
  const handleOpenBatch = async (batch: BatchProfitabilityRow) => {
    setSelectedBatch(batch);
    setBatchOrders([]);
    setLoadingOrders(true);
    try {
      const { data: res, error: rpcErr } = await supabase.rpc('get_sales_profitability_batch_orders', {
        p_batch_id: batch.batch_id,
        p_start_date: startDate,
        p_end_date: endDate,
      });
      if (rpcErr) throw rpcErr;
      setBatchOrders(res?.orders || []);
    } catch (err: any) {
      console.error('Error loading batch orders:', err);
    } finally {
      setLoadingOrders(false);
    }
  };

  const filteredProducts = useMemo(() => {
    if (!data?.products) return [];
    if (!search.trim()) return data.products;
    const q = search.toLowerCase();
    return data.products.filter(
      p => p.product_name.toLowerCase().includes(q) || p.product_code.toLowerCase().includes(q)
    );
  }, [data?.products, search]);

  const company = data?.company;

  return (
    <div className="space-y-6">
      {/* ─── Top Header & Date Filter ─── */}
      <div className="bg-white border border-gray-200 rounded-xl p-4 shadow-sm space-y-4">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold text-gray-900 tracking-tight">Sales Profitability Report</h1>
            <p className="text-xs text-gray-500 mt-0.5">
              Comprehensive management profitability tracking actual gross sales, batch landed costs, and delivery expenses.
            </p>
          </div>
          <button
            onClick={loadSummary}
            disabled={loading}
            className="self-start md:self-auto inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 shadow-sm transition disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>

        {/* Date Filter Bar */}
        <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-gray-100">
          <div className="inline-flex rounded-lg bg-gray-100 p-0.5 text-xs font-medium text-gray-600">
            {[
              { id: 'this_month', label: 'This Month' },
              { id: 'last_month', label: 'Last Month' },
              { id: 'this_quarter', label: 'This Quarter' },
              { id: 'this_year', label: 'This Year (2026)' },
              { id: 'last_year', label: 'Last Year (2025)' },
              { id: 'all_time', label: 'All Time' },
              { id: 'custom', label: 'Custom' },
            ].map(p => (
              <button
                key={p.id}
                onClick={() => handlePresetChange(p.id)}
                className={`px-3 py-1.5 rounded-md transition ${
                  datePreset === p.id ? 'bg-white text-gray-900 shadow-sm font-semibold' : 'hover:text-gray-900'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2 ml-auto text-xs">
            <Calendar className="w-3.5 h-3.5 text-gray-400" />
            <input
              type="date"
              value={startDate}
              onChange={e => {
                setStartDate(e.target.value);
                setDatePreset('custom');
              }}
              className="px-2 py-1 border border-gray-300 rounded focus:ring-1 focus:ring-blue-500 text-xs"
            />
            <span className="text-gray-400">to</span>
            <input
              type="date"
              value={endDate}
              onChange={e => {
                setEndDate(e.target.value);
                setDatePreset('custom');
              }}
              className="px-2 py-1 border border-gray-300 rounded focus:ring-1 focus:ring-blue-500 text-xs"
            />
          </div>
        </div>
      </div>

      {error && (
        <div className="p-4 bg-red-50 border border-red-200 rounded-xl text-red-800 text-sm">
          <p className="font-semibold">Failed to load profitability data</p>
          <p className="text-xs mt-1">{error}</p>
        </div>
      )}

      {/* ─── Company Summary KPIs ─── */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        {/* Gross Sales */}
        <div className="bg-white border border-gray-200 rounded-xl p-4 shadow-sm">
          <p className="text-xs text-gray-500 font-medium flex items-center gap-1">
            <TooltipHeader title="Gross Sales" tooltip="Total realized sales revenue from finalized sales invoices (ex-PPN)." />
          </p>
          <p className="text-lg font-bold text-gray-900 mt-1">
            {formatCurrency(company?.gross_sales || 0)}
          </p>
          <p className="text-[11px] text-gray-400 mt-0.5">{company?.order_count || 0} invoices</p>
        </div>

        {/* Product Cost */}
        <div className="bg-white border border-gray-200 rounded-xl p-4 shadow-sm">
          <p className="text-xs text-gray-500 font-medium flex items-center gap-1">
            <TooltipHeader title="Product Cost" tooltip="Posted COGS recorded in the sales invoice's GL 5100 journal." />
          </p>
          <p className="text-lg font-bold text-gray-800 mt-1">
            {formatCurrency(company?.product_cost || 0)}
          </p>
          <p className="text-[11px] text-gray-400 mt-0.5">Posted COGS (GL 5100)</p>
        </div>

        {/* Sales Expenses */}
        <div className="bg-white border border-gray-200 rounded-xl p-4 shadow-sm">
          <p className="text-xs text-gray-500 font-medium flex items-center gap-1">
            <TooltipHeader title="Sales Expenses" tooltip="Attributable delivery and loading charges from finance expenses allocated to Delivery Challans." />
          </p>
          <p className="text-lg font-bold text-amber-700 mt-1">
            {formatCurrency(company?.sales_expenses || 0)}
          </p>
          <p className="text-[11px] text-gray-400 mt-0.5">Delivery &amp; loading</p>
        </div>

        {/* Gross Profit */}
        <div className="bg-white border border-gray-200 rounded-xl p-4 shadow-sm">
          <p className="text-xs text-gray-500 font-medium flex items-center gap-1">
            <TooltipHeader title="Gross Profit" tooltip="Gross Sales minus Product Cost." />
          </p>
          <p className={`text-lg font-bold mt-1 ${(company?.gross_profit || 0) >= 0 ? 'text-emerald-700' : 'text-red-600'}`}>
            {formatCurrency(company?.gross_profit || 0)}
          </p>
          <p className="text-[11px] text-gray-400 mt-0.5">Before sales expenses</p>
        </div>

        {/* Profit After Sales Expenses — Highlight KPI */}
        <div className="bg-blue-50/60 border-2 border-blue-500 rounded-xl p-4 shadow-sm">
          <p className="text-xs font-semibold text-blue-900 flex items-center gap-1">
            <TooltipHeader title="Profit After Sales Expenses" tooltip="Primary bottom line: Gross Sales minus Product Cost minus Attributable Sales Expenses." />
          </p>
          <p className={`text-xl font-extrabold mt-1 ${(company?.profit_after_sales_expenses || 0) >= 0 ? 'text-green-700' : 'text-red-600'}`}>
            {formatCurrency(company?.profit_after_sales_expenses || 0)}
          </p>
          <p className="text-[11px] text-blue-700 font-medium mt-0.5">Realized net profit</p>
        </div>

        {/* Profit Margin % */}
        <div className="bg-white border border-gray-200 rounded-xl p-4 shadow-sm">
          <p className="text-xs text-gray-500 font-medium flex items-center gap-1">
            <TooltipHeader title="Profit Margin" tooltip="Profit After Sales Expenses divided by Gross Sales × 100." />
          </p>
          <div className="mt-2">
            <MarginBadge pct={company?.profit_margin_pct ?? null} />
          </div>
          <p className="text-[11px] text-gray-400 mt-1">{formatNumber(company?.total_qty_sold || 0, 0)} units sold</p>
        </div>
      </div>

      {/* ─── Main Product Profitability Table ─── */}
      <div className="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden">
        <div className="p-4 border-b border-gray-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-gray-50/50">
          <div>
            <h2 className="text-base font-bold text-gray-900">Product Profitability</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              Click any product row to drill down into its individual batches, landed costs, and customer orders.
            </p>
          </div>
          <div className="relative w-full sm:w-64">
            <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              placeholder="Search product..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-full pl-9 pr-3 py-1.5 border border-gray-300 rounded-lg text-xs focus:ring-1 focus:ring-blue-500"
            />
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-xs text-left">
            <thead className="bg-gray-50 text-gray-600 font-semibold border-b border-gray-200 select-none">
              <tr>
                <th className="px-4 py-3 min-w-[200px]">Product</th>
                <th className="px-3 py-3 text-right">
                  <TooltipHeader title="Current Stock" tooltip="Total physical stock currently available across active warehouse batches." />
                </th>
                <th className="px-3 py-3 text-right">
                  <TooltipHeader title="Sold Qty" tooltip="Total quantity sold on finalized invoices in the selected date range." />
                </th>
                <th className="px-3 py-3 text-right">
                  <TooltipHeader title="Avg Landed Cost" tooltip="Weighted average product landed cost: SUM(qty × batch cost) / SUM(qty)." />
                </th>
                <th className="px-3 py-3 text-right">
                  <TooltipHeader title="Avg Selling Price" tooltip="Weighted average realized selling price: SUM(qty × price) / SUM(qty)." />
                </th>
                <th className="px-3 py-3 text-right">
                  <TooltipHeader title="Sales Exp / Unit" tooltip="Allocated delivery and loading expense per sold unit." />
                </th>
                <th className="px-3 py-3 text-right">
                  <TooltipHeader title="Net Realization" tooltip="Avg Selling Price minus Sales Expense per unit." />
                </th>
                <th className="px-3 py-3 text-right">
                  <TooltipHeader title="Profit / Unit" tooltip="Profit after sales expenses per unit: Net Selling Price minus Landed Cost." />
                </th>
                <th className="px-3 py-3 text-right">Margin</th>
                <th className="px-4 py-3 text-right font-bold text-gray-900">Total Profit</th>
                <th className="px-3 py-3 text-center">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading && !data ? (
                <tr>
                  <td colSpan={11} className="py-12 text-center text-gray-400">
                    <RefreshCw className="w-5 h-5 animate-spin mx-auto mb-2 text-blue-500" />
                    Loading profitability data...
                  </td>
                </tr>
              ) : filteredProducts.length === 0 ? (
                <tr>
                  <td colSpan={11} className="py-12 text-center text-gray-400">
                    <Package className="w-8 h-8 mx-auto mb-2 opacity-30" />
                    No product sales found for the selected date range.
                  </td>
                </tr>
              ) : (
                filteredProducts.map(p => {
                  const hasFullCostCoverage = p.costed_lines === p.total_lines;
                  const hasPartialCostCoverage = p.costed_lines > 0 && !hasFullCostCoverage;
                  const isPositive = (p.profit_after_sales_expense ?? 0) >= 0;
                  return (
                    <tr
                      key={p.product_id}
                      onClick={() => handleOpenProduct(p)}
                      className="hover:bg-blue-50/40 cursor-pointer transition-colors group"
                    >
                      <td className="px-4 py-3 font-medium text-gray-900">
                        <div className="font-semibold text-blue-900 group-hover:text-blue-600 transition-colors">
                          {p.product_name}
                        </div>
                        <div className="text-[11px] text-gray-400">{p.product_code || '—'}</div>
                      </td>
                      <td className="px-3 py-3 text-right font-medium text-gray-700">
                        {formatNumber(p.current_stock, 0)} {p.product_unit}
                      </td>
                      <td className="px-3 py-3 text-right font-semibold text-gray-900">
                        {formatNumber(p.sold_qty, 0)} {p.product_unit}
                      </td>
                      <td className="px-3 py-3 text-right text-gray-700">
                        {p.costed_lines === 0 ? <span className="text-amber-700">Cost unavailable</span> : hasPartialCostCoverage ? <span className="text-amber-700">Known COGS {formatCurrency(p.product_cost ?? 0)}<br /><span className="text-[10px]">Partial coverage</span></span> : formatCurrency(p.avg_landed_cost)}
                      </td>
                      <td className="px-3 py-3 text-right text-gray-900 font-medium">
                        {formatCurrency(p.avg_selling_price)}
                      </td>
                      <td className="px-3 py-3 text-right text-amber-700">
                        {p.sales_expense > 0 ? formatCurrency(p.sales_expense_per_unit) : '—'}
                      </td>
                      <td className="px-3 py-3 text-right text-gray-800">
                        {formatCurrency(p.net_selling_price_per_unit)}
                      </td>
                      <td className={`px-3 py-3 text-right font-medium ${isPositive ? 'text-green-700' : 'text-red-600'}`}>
                        {hasFullCostCoverage ? formatCurrency(p.profit_per_unit) : '—'}
                      </td>
                      <td className="px-3 py-3 text-right">
                        {hasPartialCostCoverage ? (
                          <span className="text-xs text-amber-700 font-medium">Partial coverage</span>
                        ) : <MarginBadge pct={p.costed_lines === p.total_lines ? p.profit_margin_pct : null} />}
                      </td>
                      <td className={`px-4 py-3 text-right font-bold text-sm ${isPositive ? 'text-green-700' : 'text-red-600'}`}>
                        {hasFullCostCoverage ? formatCurrency(p.profit_after_sales_expense) : '—'}
                      </td>
                      <td className="px-3 py-3 text-center">
                        <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-blue-600 group-hover:underline">
                          Batches <ChevronRight className="w-3.5 h-3.5" />
                        </span>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
            {data && data.products.length > 0 && (
              <tfoot className="bg-gray-100/80 font-bold text-gray-900 border-t-2 border-gray-300">
                <tr>
                  <td className="px-4 py-3">TOTAL ({filteredProducts.length} products)</td>
                  <td className="px-3 py-3 text-right">
                    {formatNumber(filteredProducts.reduce((s, p) => s + p.current_stock, 0), 0)}
                  </td>
                  <td className="px-3 py-3 text-right">
                    {formatNumber(filteredProducts.reduce((s, p) => s + p.sold_qty, 0), 0)}
                  </td>
                  <td className="px-3 py-3 text-right">—</td>
                  <td className="px-3 py-3 text-right">—</td>
                  <td className="px-3 py-3 text-right text-amber-800">
                    {formatCurrency(filteredProducts.reduce((s, p) => s + p.sales_expense, 0))}
                  </td>
                  <td className="px-3 py-3 text-right">—</td>
                  <td className="px-3 py-3 text-right">—</td>
                  <td className="px-3 py-3 text-right">
                    <MarginBadge pct={company?.profit_margin_pct ?? null} />
                  </td>
                  <td className={`px-4 py-3 text-right text-sm ${(company?.profit_after_sales_expenses || 0) >= 0 ? 'text-green-700' : 'text-red-600'}`}>
                    {formatCurrency(filteredProducts.reduce((s, p) => s + (p.profit_after_sales_expense ?? 0), 0))}
                  </td>
                  <td />
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>

      {/* ─── Monthly Trend Summary ─── */}
      {data?.monthly && data.monthly.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-xl shadow-sm p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-bold text-gray-900 flex items-center gap-1.5">
              <BarChart2 className="w-4 h-4 text-blue-600" />
              Monthly Profitability Rollup
            </h3>
            <span className="text-xs text-gray-400">Click any month to inspect that period</span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            {data.monthly.map(m => (
              <div
                key={m.month_start}
                onClick={() => {
                  const ym = m.month_start.slice(0, 7);
                  const [y, mon] = ym.split('-').map(Number);
                  const start = new Date(y, mon - 1, 1).toISOString().split('T')[0];
                  const end = new Date(y, mon, 0).toISOString().split('T')[0];
                  setStartDate(start);
                  setEndDate(end);
                  setDatePreset('custom');
                }}
                className="border border-gray-200 hover:border-blue-400 rounded-lg p-3 bg-gray-50/50 hover:bg-blue-50/30 cursor-pointer transition shadow-xs"
              >
                <div className="flex items-center justify-between">
                  <span className="font-bold text-xs text-gray-900">{m.month_label}</span>
                  <MarginBadge pct={m.profit_margin_pct} />
                </div>
                <div className="mt-2 space-y-1 text-xs">
                  <div className="flex justify-between text-gray-500">
                    <span>Revenue:</span>
                    <span className="font-medium text-gray-800">{formatCurrency(m.gross_sales)}</span>
                  </div>
                  <div className="flex justify-between text-gray-500">
                    <span>Product Cost:</span>
                    <span className="text-gray-700">{formatCurrency(m.product_cost)}</span>
                  </div>
                  <div className="flex justify-between text-gray-500">
                    <span>Sales Expenses:</span>
                    <span className="text-amber-700">{formatCurrency(m.sales_expenses)}</span>
                  </div>
                  <div className="flex justify-between font-bold border-t pt-1">
                    <span>Profit:</span>
                    <span className={m.profit_after_sales_expenses >= 0 ? 'text-green-700' : 'text-red-600'}>
                      {formatCurrency(m.profit_after_sales_expenses)}
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ─── Product Drilldown Drawer ─── */}
      {selectedProduct && (
        <div className="fixed inset-0 z-50 flex justify-end bg-gray-900/40 backdrop-blur-xs">
          <div className="w-full max-w-4xl bg-white shadow-2xl flex flex-col h-full overflow-hidden animate-in slide-in-from-right duration-200">
            {/* Header */}
            <div className="p-4 border-b border-gray-200 bg-gray-50 flex items-center justify-between">
              <div>
                <p className="text-xs font-semibold text-blue-600 uppercase tracking-wider">Product Drilldown</p>
                <h2 className="text-lg font-bold text-gray-900 mt-0.5">{selectedProduct.product_name}</h2>
                <p className="text-xs text-gray-500">{selectedProduct.product_code || 'No Product Code'}</p>
              </div>
              <button
                onClick={() => setSelectedProduct(null)}
                className="p-1.5 rounded-lg hover:bg-gray-200 text-gray-500 transition"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Product Summary Ribbon */}
            <div className="grid grid-cols-3 sm:grid-cols-6 divide-x divide-gray-200 border-b border-gray-200 bg-white text-xs">
              <div className="p-3 text-center">
                <span className="text-gray-500 block">Current Stock</span>
                <span className="font-bold text-gray-900 text-sm mt-0.5">
                  {formatNumber(selectedProduct.current_stock, 0)} {selectedProduct.product_unit}
                </span>
              </div>
              <div className="p-3 text-center">
                <span className="text-gray-500 block">Sold Qty</span>
                <span className="font-bold text-gray-900 text-sm mt-0.5">
                  {formatNumber(selectedProduct.sold_qty, 0)} {selectedProduct.product_unit}
                </span>
              </div>
              <div className="p-3 text-center">
                <span className="text-gray-500 block">Avg Landed Cost</span>
                <span className="font-bold text-gray-800 text-sm mt-0.5">
                  {selectedProduct.costed_lines === selectedProduct.total_lines ? formatCurrency(selectedProduct.avg_landed_cost) : selectedProduct.costed_lines > 0 ? `Known COGS ${formatCurrency(selectedProduct.product_cost ?? 0)} · Partial coverage` : 'Cost unavailable'}
                </span>
              </div>
              <div className="p-3 text-center">
                <span className="text-gray-500 block">Avg Selling Price</span>
                <span className="font-bold text-gray-800 text-sm mt-0.5">
                  {formatCurrency(selectedProduct.avg_selling_price)}
                </span>
              </div>
              <div className="p-3 text-center">
                <span className="text-gray-500 block">Sales Expense</span>
                <span className="font-bold text-amber-700 text-sm mt-0.5">
                  {formatCurrency(selectedProduct.sales_expense)}
                </span>
              </div>
              <div className="p-3 text-center bg-blue-50/50">
                <span className="text-blue-900 font-semibold block">Total Profit</span>
                <span className={`font-bold text-sm mt-0.5 ${(selectedProduct.profit_after_sales_expense ?? 0) >= 0 ? 'text-green-700' : 'text-red-600'}`}>
                  {selectedProduct.costed_lines === selectedProduct.total_lines ? formatCurrency(selectedProduct.profit_after_sales_expense) : '—'}
                </span>
              </div>
            </div>

            {/* Batch Breakdown Section */}
            <div className="flex-1 overflow-auto p-4 space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-bold text-gray-900">Batch Breakdown</h3>
                  <p className="text-xs text-gray-500">
                    Each batch preserves its actual landed cost and selling economics. Click a batch to inspect order lines.
                  </p>
                </div>
                <span className="text-xs font-semibold text-gray-500">
                  {productBatches.length} {productBatches.length === 1 ? 'batch' : 'batches'}
                </span>
              </div>

              {loadingBatches ? (
                <div className="py-16 text-center text-gray-400">
                  <RefreshCw className="w-5 h-5 animate-spin mx-auto mb-2 text-blue-500" />
                  Loading batches...
                </div>
              ) : productBatches.length === 0 ? (
                <div className="py-12 text-center text-gray-400 text-xs">
                  No batch sales records found for this product in the selected period.
                </div>
              ) : (
                <div className="border border-gray-200 rounded-lg overflow-hidden shadow-xs">
                  <table className="w-full text-xs text-left">
                    <thead className="bg-gray-50 text-gray-600 font-semibold border-b border-gray-200">
                      <tr>
                        <th className="px-3 py-2.5">Batch Number</th>
                        <th className="px-3 py-2.5 text-right">Stock</th>
                        <th className="px-3 py-2.5 text-right">Sold Qty</th>
                        <th className="px-3 py-2.5 text-right">Landed Cost/Unit</th>
                        <th className="px-3 py-2.5 text-right">Avg Sell Price</th>
                        <th className="px-3 py-2.5 text-right">Expense/Unit</th>
                        <th className="px-3 py-2.5 text-right">Profit/Unit</th>
                        <th className="px-3 py-2.5 text-right">Margin</th>
                        <th className="px-3 py-2.5 text-right font-bold">Total Profit</th>
                        <th className="px-2 py-2.5 text-center">Orders</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {productBatches.map(b => (
                        <tr
                          key={b.batch_id}
                          onClick={() => handleOpenBatch(b)}
                          className="hover:bg-blue-50/50 cursor-pointer transition group"
                        >
                          <td className="px-3 py-2.5 font-mono font-bold text-blue-900 group-hover:text-blue-600">
                            {b.batch_number}
                            <span className="ml-1.5 text-[10px] font-sans px-1.5 py-0.2 rounded bg-gray-100 text-gray-600">
                              {b.is_imported ? 'Import' : 'Local'}
                            </span>
                          </td>
                          <td className="px-3 py-2.5 text-right font-medium text-gray-700">
                            {formatNumber(b.current_stock, 0)}
                          </td>
                          <td className="px-3 py-2.5 text-right font-semibold text-gray-900">
                            {formatNumber(b.sold_qty, 0)}
                          </td>
                          <td className="px-3 py-2.5 text-right text-gray-700 font-medium">
                            {b.cost_per_unit == null ? <span className="text-amber-700">Cost unavailable</span> : formatCurrency(b.cost_per_unit)}
                          </td>
                          <td className="px-3 py-2.5 text-right text-gray-900">
                            {formatCurrency(b.avg_selling_price)}
                          </td>
                          <td className="px-3 py-2.5 text-right text-amber-700">
                            {b.sales_expense > 0 ? formatCurrency(b.sales_expense_per_unit) : '—'}
                          </td>
                          <td className={`px-3 py-2.5 text-right font-medium ${(b.profit_after_sales_expense ?? 0) >= 0 ? 'text-green-700' : 'text-red-600'}`}>
                            {b.profit_per_unit == null ? '—' : formatCurrency(b.profit_per_unit)}
                          </td>
                          <td className="px-3 py-2.5 text-right">
                            <MarginBadge pct={b.profit_margin_pct} />
                          </td>
                          <td className={`px-3 py-2.5 text-right font-bold ${(b.profit_after_sales_expense ?? 0) >= 0 ? 'text-green-700' : 'text-red-600'}`}>
                            {b.profit_after_sales_expense == null ? '—' : formatCurrency(b.profit_after_sales_expense)}
                          </td>
                          <td className="px-2 py-2.5 text-center">
                            <span className="text-blue-600 font-medium text-xs group-hover:underline inline-flex items-center">
                              View <ChevronRight className="w-3.5 h-3.5" />
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ─── Batch Orders & Cost Breakdown Modal/Drawer ─── */}
      {selectedBatch && (
        <div className="fixed inset-0 z-60 flex justify-end bg-gray-900/50 backdrop-blur-xs">
          <div className="w-full max-w-3xl bg-white shadow-2xl flex flex-col h-full overflow-hidden animate-in slide-in-from-right duration-200">
            {/* Header */}
            <div className="p-4 border-b border-gray-200 bg-gray-50 flex items-center justify-between">
              <div>
                <p className="text-xs font-semibold text-blue-600 uppercase tracking-wider">Batch Sales &amp; Cost Traceability</p>
                <h2 className="text-lg font-bold font-mono text-gray-900 mt-0.5">
                  Batch: {selectedBatch.batch_number}
                </h2>
                <p className="text-xs text-gray-500">
                  {selectedBatch.is_imported ? 'Imported Batch' : 'Local Purchase Batch'} · Stock: {formatNumber(selectedBatch.current_stock, 0)} kg
                </p>
              </div>
              <button
                onClick={() => setSelectedBatch(null)}
                className="p-1.5 rounded-lg hover:bg-gray-200 text-gray-500 transition"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Cost Breakdown Card */}
            <div className="p-4 bg-gray-50/80 border-b border-gray-200 space-y-2">
              <h4 className="text-xs font-bold text-gray-700 flex items-center gap-1.5">
                <Info className="w-3.5 h-3.5 text-blue-600" />
                Landed / Product Cost Breakdown
              </h4>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                {selectedBatch.is_imported ? (
                  <>
                    <div className="bg-white p-2 rounded border border-gray-200">
                      <span className="text-gray-400 block text-[10px]">Import FOB Price</span>
                      <span className="font-semibold text-gray-900">
                        {selectedBatch.cost_breakdown.import_price_usd ? `$${selectedBatch.cost_breakdown.import_price_usd} (Rp ${formatNumber(selectedBatch.cost_breakdown.import_price || 0, 0)})` : '—'}
                      </span>
                    </div>
                    <div className="bg-white p-2 rounded border border-gray-200">
                      <span className="text-gray-400 block text-[10px]">Duty Charges</span>
                      <span className="font-semibold text-gray-900">
                        {selectedBatch.cost_breakdown.duty_charges ? formatCurrency(selectedBatch.cost_breakdown.duty_charges) : 'Rp 0'}
                      </span>
                    </div>
                    <div className="bg-white p-2 rounded border border-gray-200">
                      <span className="text-gray-400 block text-[10px]">Freight &amp; Port</span>
                      <span className="font-semibold text-gray-900">
                        {(selectedBatch.cost_breakdown.freight_charges || 0) + (selectedBatch.cost_breakdown.other_charges || 0) > 0
                          ? formatCurrency((selectedBatch.cost_breakdown.freight_charges || 0) + (selectedBatch.cost_breakdown.other_charges || 0))
                          : 'Rp 0'}
                      </span>
                    </div>
                    <div className="bg-blue-50 p-2 rounded border border-blue-200 font-bold">
                      <span className="text-blue-700 block text-[10px]">Final Landed Cost/Unit</span>
                      <span className="text-blue-950 text-sm">
                        {selectedBatch.cost_per_unit == null ? 'Cost unavailable' : formatCurrency(selectedBatch.cost_per_unit)}
                      </span>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="bg-white p-2 rounded border border-gray-200">
                      <span className="text-gray-400 block text-[10px]">Purchase Type</span>
                      <span className="font-semibold text-gray-900">Local Purchase</span>
                    </div>
                    <div className="bg-blue-50 p-2 rounded border border-blue-200 font-bold col-span-2">
                      <span className="text-blue-700 block text-[10px]">Actual Local Purchase Cost/Unit</span>
                      <span className="text-blue-950 text-sm">
                        {selectedBatch.cost_per_unit == null ? 'Cost unavailable' : formatCurrency(selectedBatch.cost_per_unit)}
                      </span>
                    </div>
                  </>
                )}
              </div>
            </div>

            {/* Orders / Invoices Breakdown Table */}
            <div className="flex-1 overflow-auto p-4 space-y-3">
              <div>
                <h4 className="text-sm font-bold text-gray-900">Realized Customer Orders</h4>
                <p className="text-xs text-gray-500">
                  Every sales invoice line that sold quantity from this batch, including allocated delivery expenses.
                </p>
              </div>

              {loadingOrders ? (
                <div className="py-16 text-center text-gray-400">
                  <RefreshCw className="w-5 h-5 animate-spin mx-auto mb-2 text-blue-500" />
                  Loading order lines...
                </div>
              ) : batchOrders.length === 0 ? (
                <div className="py-12 text-center text-gray-400 text-xs">
                  No sales invoice lines found for this batch in the selected period.
                </div>
              ) : (
                <div className="border border-gray-200 rounded-lg overflow-hidden shadow-xs">
                  <table className="w-full text-xs text-left">
                    <thead className="bg-gray-50 text-gray-600 font-semibold border-b border-gray-200">
                      <tr>
                        <th className="px-3 py-2.5">Invoice &amp; Date</th>
                        <th className="px-3 py-2.5">Customer</th>
                        <th className="px-2 py-2.5">SO / DC</th>
                        <th className="px-2 py-2.5 text-right">Qty</th>
                        <th className="px-2 py-2.5 text-right">Sell Price</th>
                        <th className="px-2 py-2.5 text-right">Gross Sales</th>
                        <th className="px-2 py-2.5 text-right">Product Cost</th>
                        <th className="px-2 py-2.5 text-right">Sales Exp</th>
                        <th className="px-2 py-2.5 text-right">Net Realization</th>
                        <th className="px-3 py-2.5 text-right font-bold">Profit</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {batchOrders.map(o => (
                        <tr key={o.line_id} className="hover:bg-gray-50/70 transition">
                          <td className="px-3 py-2.5 whitespace-nowrap">
                            <span className="font-mono font-bold text-blue-700 block">{o.invoice_number}</span>
                            <span className="text-[10px] text-gray-400">{o.invoice_date}</span>
                          </td>
                          <td className="px-3 py-2.5 font-medium text-gray-800 max-w-[130px] truncate" title={o.customer_name}>
                            {o.customer_name}
                          </td>
                          <td className="px-2 py-2.5 text-[11px] text-gray-500 font-mono whitespace-nowrap">
                            <div>{o.so_number || '—'}</div>
                            <div className="text-[10px] text-gray-400">{o.dc_number || '—'}</div>
                          </td>
                          <td className="px-2 py-2.5 text-right font-semibold text-gray-900">
                            {formatNumber(o.quantity, 0)}
                          </td>
                          <td className="px-2 py-2.5 text-right text-gray-800">
                            {formatCurrency(o.selling_price)}
                          </td>
                          <td className="px-2 py-2.5 text-right font-medium text-gray-900">
                            {formatCurrency(o.gross_sales)}
                          </td>
                          <td className="px-2 py-2.5 text-right text-gray-600">
                            {o.line_cost == null ? <span className="text-amber-700">Cost unavailable</span> : formatCurrency(o.line_cost)}
                          </td>
                          <td className="px-2 py-2.5 text-right text-amber-700">
                            {o.line_sales_expense > 0 ? (
                              <span
                                className="underline decoration-dotted cursor-help"
                                title={o.expenses.map(e => `${e.voucher_number} (${e.category}): ${formatCurrency(e.total_amount)}`).join('\n')}
                              >
                                {formatCurrency(o.line_sales_expense)}
                              </span>
                            ) : (
                              '—'
                            )}
                          </td>
                          <td className="px-2 py-2.5 text-right text-gray-800">
                            {formatCurrency(o.net_selling_realization)}
                          </td>
                          <td className={`px-3 py-2.5 text-right font-bold ${(o.profit ?? 0) >= 0 ? 'text-green-700' : 'text-red-600'}`}>
                            {o.profit == null ? '—' : formatCurrency(o.profit)}
                            {o.profit_margin_pct != null && <div className="text-[10px] font-normal text-gray-400">
                              {formatNumber(o.profit_margin_pct, 1)}%
                            </div>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
