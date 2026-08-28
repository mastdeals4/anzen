import { useCallback, useEffect, useState } from 'react';
import { BarChart2, Calendar, DollarSign, Package, RefreshCw, TrendingUp, Users } from 'lucide-react';
import { Layout } from '../../components/Layout';
import { useFinance } from '../../contexts/FinanceContext';
import { supabase } from '../../lib/supabase';
import { formatCurrency, formatNumber } from '../../utils/currency';

type DateRange = { startDate: string; endDate: string };
type Tab = 'sales-profit' | 'monthly' | 'product-perf' | 'customer' | 'expense-profit';

type ProductRow = {
  product_id: string; product_name: string; product_code: string; product_unit: string;
  total_qty_sold: number; total_revenue: number; costed_revenue: number; total_cogs: number;
  total_profit: number; profit_pct: number | null; costed_lines: number; total_lines: number; no_cost: boolean;
};
type MonthRow = {
  month_label: string; month_start: string; total_sales: number; total_orders: number; total_qty_sold: number;
  avg_order_value: number; total_cogs: number; gross_profit: number; profit_pct: number | null;
  outbound_delivery: number; operational_profit: number; costed_lines: number; total_lines: number;
};
type ProductPerfRow = {
  product_id: string; product_name: string; product_code: string; qty_sold: number; total_sales: number;
  total_cost: number; total_profit: number; profit_pct: number | null; costed_lines: number;
  total_lines: number; cost_coverage: number | null;
};
type CustomerRow = {
  customer_id: string; customer_name: string; total_orders: number; total_sales: number; avg_order_value: number;
  last_order_date: string | null; total_qty: number; total_cogs: number; total_profit: number;
  profit_pct: number | null; costed_lines: number; total_lines: number; cost_coverage: number | null;
};
type ExpenseRow = {
  total_sales: number; total_cogs: number; gross_profit: number; outbound_delivery: number;
  contribution_profit: number; operating_expenses: number; operational_profit: number;
  profit_pct: number | null; costed_lines: number; total_lines: number;
};

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return <div className="bg-white border border-gray-200 rounded-xl px-5 py-4 shadow-sm"><p className="text-xs text-gray-500 font-medium">{label}</p><p className="text-xl font-bold text-gray-900 mt-1">{value}</p>{sub && <p className="text-xs text-gray-400 mt-0.5">{sub}</p>}</div>;
}

function Spinner() { return <div className="flex items-center justify-center py-16 text-gray-400"><div className="w-5 h-5 border-2 border-blue-400 border-t-transparent rounded-full animate-spin mr-2" />Loading…</div>; }
function Empty({ text }: { text: string }) { return <div className="py-16 text-center text-sm text-gray-400">{text}</div>; }
function ReportError({ message, retry }: { message: string; retry: () => void }) {
  return <div className="border border-red-200 bg-red-50 rounded-xl p-5 text-sm text-red-800"><p className="font-semibold">Report could not be loaded</p><p className="mt-1">{message}</p><button onClick={retry} className="mt-3 px-3 py-1.5 rounded border border-red-300 bg-white text-xs font-medium">Retry</button></div>;
}
function Coverage({ costed, total }: { costed: number; total: number }) {
  return <span className={`text-xs font-medium ${costed === total ? 'text-green-700' : 'text-amber-700'}`}>Cost coverage: {costed} / {total} lines</span>;
}
function Margin({ value }: { value: number | null }) { return value == null ? <span className="text-xs text-amber-700 font-medium">Cost unavailable</span> : <span className={value >= 0 ? 'text-green-700 font-semibold' : 'text-red-700 font-semibold'}>{formatNumber(value, 1)}%</span>; }

function useReport<T>(name: string, dateRange: DateRange) {
  const [rows, setRows] = useState<T[]>([]); const [loading, setLoading] = useState(false); const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setLoading(true); setError(null);
    const { data, error: rpcError } = await supabase.rpc(name, { p_start_date: dateRange.startDate, p_end_date: dateRange.endDate });
    if (rpcError) { setRows([]); setError(rpcError.message); } else setRows((data as T[] | null) ?? []);
    setLoading(false);
  }, [dateRange.endDate, dateRange.startDate, name]);
  useEffect(() => { void load(); }, [load]);
  return { rows, loading, error, load };
}

function Toolbar({ onRefresh }: { onRefresh: () => void }) { return <div className="flex justify-end"><button onClick={onRefresh} className="inline-flex items-center gap-1.5 px-3 py-2 text-xs text-gray-600 bg-white border border-gray-200 rounded-lg hover:bg-gray-50"><RefreshCw className="w-3.5 h-3.5" />Refresh</button></div>; }

function SalesProfitTab({ dateRange }: { dateRange: DateRange }) {
  const { rows, loading, error, load } = useReport<ProductRow>('get_sales_profit_summary', dateRange);
  const revenue = rows.reduce((sum, row) => sum + row.total_revenue, 0); const cogs = rows.reduce((sum, row) => sum + row.total_cogs, 0);
  const profit = rows.reduce((sum, row) => sum + row.total_profit, 0); const costed = rows.reduce((sum, row) => sum + row.costed_lines, 0); const lines = rows.reduce((sum, row) => sum + row.total_lines, 0);
  return <section className="space-y-4">
    <div className="grid grid-cols-2 lg:grid-cols-5 gap-4"><StatCard label="Revenue ex-PPN" value={formatCurrency(revenue)} /><StatCard label="COGS (costed lines)" value={formatCurrency(cogs)} /><StatCard label="Reliable Gross Profit" value={formatCurrency(profit)} /><StatCard label="Gross Margin" value={lines === costed && revenue > 0 ? `${formatNumber(profit / revenue * 100, 1)}%` : 'Partial coverage'} /><StatCard label="Cost Coverage" value={`${costed} / ${lines}`} sub="invoice lines" /></div>
    <p className="text-xs text-gray-500">COGS uses stored <code>batches.landed_cost_per_unit</code> only. Uncosted lines are excluded from reliable gross-margin aggregation.</p><Toolbar onRefresh={load} />
    {loading ? <Spinner /> : error ? <ReportError message={error} retry={load} /> : rows.length === 0 ? <Empty text="No posted invoice lines found for this period" /> : <div className="bg-white border border-gray-200 rounded-xl overflow-x-auto"><table className="w-full text-sm"><thead className="bg-gray-50 text-xs text-gray-500"><tr><th className="p-3 text-left">Product</th><th className="p-3 text-right">Quantity</th><th className="p-3 text-right">Revenue</th><th className="p-3 text-right">COGS</th><th className="p-3 text-right">Gross Profit</th><th className="p-3 text-right">Gross Margin</th><th className="p-3 text-right">Coverage</th></tr></thead><tbody>{rows.map(row => <tr key={row.product_id} className="border-t"><td className="p-3 font-medium">{row.product_name}<div className="text-xs text-gray-400">{row.product_code}</div></td><td className="p-3 text-right">{formatNumber(row.total_qty_sold, 3)} {row.product_unit}</td><td className="p-3 text-right">{formatCurrency(row.total_revenue)}</td><td className="p-3 text-right">{row.no_cost ? '—' : formatCurrency(row.total_cogs)}</td><td className="p-3 text-right font-semibold">{row.no_cost ? 'Cost unavailable' : formatCurrency(row.total_profit)}</td><td className="p-3 text-right"><Margin value={row.profit_pct} /></td><td className="p-3 text-right"><Coverage costed={row.costed_lines} total={row.total_lines} /></td></tr>)}</tbody></table></div>}
  </section>;
}

function MonthlySalesTab({ dateRange }: { dateRange: DateRange }) {
  const { rows, loading, error, load } = useReport<MonthRow>('get_monthly_sales_report', dateRange);
  const coverage = rows.reduce((sum, row) => sum + row.costed_lines, 0); const totalLines = rows.reduce((sum, row) => sum + row.total_lines, 0);
  return <section className="space-y-4"><div className="grid grid-cols-2 lg:grid-cols-5 gap-4"><StatCard label="Revenue ex-PPN" value={formatCurrency(rows.reduce((s, r) => s + r.total_sales, 0))} /><StatCard label="COGS" value={formatCurrency(rows.reduce((s, r) => s + r.total_cogs, 0))} /><StatCard label="Gross Profit" value={formatCurrency(rows.reduce((s, r) => s + r.gross_profit, 0))} /><StatCard label="Outbound Delivery" value={formatCurrency(rows.reduce((s, r) => s + r.outbound_delivery, 0))} /><StatCard label="Cost Coverage" value={`${coverage} / ${totalLines}`} /></div><Toolbar onRefresh={load} />{loading ? <Spinner /> : error ? <ReportError message={error} retry={load} /> : rows.length === 0 ? <Empty text="No posted invoices found for this period" /> : <div className="bg-white border border-gray-200 rounded-xl overflow-x-auto"><table className="w-full text-sm"><thead className="bg-gray-50 text-xs text-gray-500"><tr><th className="p-3 text-left">Month</th><th className="p-3 text-right">Revenue ex-PPN</th><th className="p-3 text-right">COGS</th><th className="p-3 text-right">Gross Profit</th><th className="p-3 text-right">Margin</th><th className="p-3 text-right">Outbound Delivery</th><th className="p-3 text-right">Operational Gross Profit</th></tr></thead><tbody>{rows.map(row => <tr key={row.month_start} className="border-t"><td className="p-3 font-medium">{row.month_label}<div><Coverage costed={row.costed_lines} total={row.total_lines} /></div></td><td className="p-3 text-right">{formatCurrency(row.total_sales)}</td><td className="p-3 text-right">{formatCurrency(row.total_cogs)}</td><td className="p-3 text-right font-semibold">{formatCurrency(row.gross_profit)}</td><td className="p-3 text-right"><Margin value={row.profit_pct} /></td><td className="p-3 text-right">{formatCurrency(row.outbound_delivery)}</td><td className="p-3 text-right font-semibold">{formatCurrency(row.operational_profit)}</td></tr>)}</tbody></table></div>}</section>;
}

function ProductPerformanceTab({ dateRange }: { dateRange: DateRange }) {
  const { rows, loading, error, load } = useReport<ProductPerfRow>('get_product_performance_report', dateRange);
  return <section className="space-y-4"><div className="grid grid-cols-2 lg:grid-cols-4 gap-4"><StatCard label="Revenue ex-PPN" value={formatCurrency(rows.reduce((s, r) => s + r.total_sales, 0))} /><StatCard label="COGS" value={formatCurrency(rows.reduce((s, r) => s + r.total_cost, 0))} /><StatCard label="Reliable Gross Profit" value={formatCurrency(rows.reduce((s, r) => s + r.total_profit, 0))} /><StatCard label="Products" value={String(rows.length)} /></div><Toolbar onRefresh={load} />{loading ? <Spinner /> : error ? <ReportError message={error} retry={load} /> : rows.length === 0 ? <Empty text="No product sales found for this period" /> : <div className="bg-white border border-gray-200 rounded-xl overflow-x-auto"><table className="w-full text-sm"><thead className="bg-gray-50 text-xs text-gray-500"><tr><th className="p-3 text-left">Product</th><th className="p-3 text-right">Quantity</th><th className="p-3 text-right">Revenue</th><th className="p-3 text-right">COGS</th><th className="p-3 text-right">Gross Profit</th><th className="p-3 text-right">Gross Margin</th><th className="p-3 text-right">Cost Coverage</th></tr></thead><tbody>{rows.map(row => <tr key={row.product_id} className="border-t"><td className="p-3 font-medium">{row.product_name}<div className="text-xs text-gray-400">{row.product_code}</div></td><td className="p-3 text-right">{formatNumber(row.qty_sold, 3)}</td><td className="p-3 text-right">{formatCurrency(row.total_sales)}</td><td className="p-3 text-right">{row.costed_lines ? formatCurrency(row.total_cost) : '—'}</td><td className="p-3 text-right font-semibold">{row.costed_lines ? formatCurrency(row.total_profit) : 'Cost unavailable'}</td><td className="p-3 text-right"><Margin value={row.profit_pct} /></td><td className="p-3 text-right"><Coverage costed={row.costed_lines} total={row.total_lines} /></td></tr>)}</tbody></table></div>}</section>;
}

function CustomerSalesTab({ dateRange }: { dateRange: DateRange }) {
  const { rows, loading, error, load } = useReport<CustomerRow>('get_customer_sales_report', dateRange);
  return <section className="space-y-4"><div className="grid grid-cols-2 lg:grid-cols-4 gap-4"><StatCard label="Revenue ex-PPN" value={formatCurrency(rows.reduce((s, r) => s + r.total_sales, 0))} /><StatCard label="Invoices" value={String(rows.reduce((s, r) => s + r.total_orders, 0))} /><StatCard label="Reliable Gross Profit" value={formatCurrency(rows.reduce((s, r) => s + r.total_profit, 0))} /><StatCard label="Customers" value={String(rows.length)} /></div><Toolbar onRefresh={load} />{loading ? <Spinner /> : error ? <ReportError message={error} retry={load} /> : rows.length === 0 ? <Empty text="No customer sales found for this period" /> : <div className="bg-white border border-gray-200 rounded-xl overflow-x-auto"><table className="w-full text-sm"><thead className="bg-gray-50 text-xs text-gray-500"><tr><th className="p-3 text-left">Customer</th><th className="p-3 text-right">Invoices</th><th className="p-3 text-right">Quantity</th><th className="p-3 text-right">Revenue</th><th className="p-3 text-right">COGS</th><th className="p-3 text-right">Gross Profit</th><th className="p-3 text-right">Margin</th><th className="p-3 text-right">Coverage</th></tr></thead><tbody>{rows.map(row => <tr key={row.customer_id} className="border-t"><td className="p-3 font-medium">{row.customer_name}</td><td className="p-3 text-right">{row.total_orders}</td><td className="p-3 text-right">{formatNumber(row.total_qty, 3)}</td><td className="p-3 text-right">{formatCurrency(row.total_sales)}</td><td className="p-3 text-right">{row.costed_lines ? formatCurrency(row.total_cogs) : '—'}</td><td className="p-3 text-right font-semibold">{row.costed_lines ? formatCurrency(row.total_profit) : 'Cost unavailable'}</td><td className="p-3 text-right"><Margin value={row.profit_pct} /></td><td className="p-3 text-right"><Coverage costed={row.costed_lines} total={row.total_lines} /></td></tr>)}</tbody></table></div>}</section>;
}

function ExpenseVsProfitTab({ dateRange }: { dateRange: DateRange }) {
  const { rows, loading, error, load } = useReport<ExpenseRow>('get_expense_vs_profit_report', dateRange); const data = rows[0];
  if (loading) return <Spinner />; if (error) return <ReportError message={error} retry={load} />; if (!data) return <Empty text="No operational report data found for this period" />;
  const values = [['Revenue ex-PPN', data.total_sales], ['COGS (costed lines)', data.total_cogs], ['Gross Profit', data.gross_profit], ['Outbound Delivery / Distribution', data.outbound_delivery], ['Contribution / Operational Gross Profit', data.contribution_profit], ['Operating Expenses', data.operating_expenses], ['Operational Operating Profit', data.operational_profit]] as const;
  return <section className="space-y-4"><p className="text-sm text-blue-800 bg-blue-50 border border-blue-100 rounded-lg p-3">Operational management view — Finance P&amp;L is available in Finance Reports. This is not Finance Net Profit.</p><div className="grid grid-cols-2 lg:grid-cols-4 gap-4"><StatCard label="Revenue ex-PPN" value={formatCurrency(data.total_sales)} /><StatCard label="Gross Profit" value={formatCurrency(data.gross_profit)} sub={`${data.costed_lines} / ${data.total_lines} lines costed`} /><StatCard label="Outbound Delivery" value={formatCurrency(data.outbound_delivery)} /><StatCard label="Operational Operating Profit" value={formatCurrency(data.operational_profit)} /></div><Toolbar onRefresh={load} /><div className="bg-white border border-gray-200 rounded-xl overflow-hidden"><table className="w-full text-sm"><tbody>{values.map(([label, value]) => <tr key={label} className={`border-t ${label.includes('Profit') ? 'bg-gray-50 font-semibold' : ''}`}><td className="p-4 text-gray-700">{label}</td><td className="p-4 text-right">{label.includes('COGS') || label.includes('Expenses') || label.includes('Outbound') ? `(${formatCurrency(value)})` : formatCurrency(value)}</td></tr>)}</tbody></table></div></section>;
}

const tabs: { id: Tab; label: string; icon: typeof TrendingUp }[] = [
  { id: 'sales-profit', label: 'Sales Profit', icon: TrendingUp }, { id: 'monthly', label: 'Monthly Sales', icon: Calendar }, { id: 'product-perf', label: 'Product Performance', icon: Package }, { id: 'customer', label: 'Customer Sales', icon: Users }, { id: 'expense-profit', label: 'Expense vs Profit', icon: DollarSign },
];

export function Reports() {
  const { dateRange } = useFinance(); const [activeTab, setActiveTab] = useState<Tab>('sales-profit');
  return <Layout><div className="space-y-5"><div className="flex items-center gap-3"><div className="p-2 bg-blue-50 rounded-lg"><BarChart2 className="w-5 h-5 text-blue-600" /></div><div><h1 className="text-xl font-bold text-gray-900">Reports</h1><p className="text-sm text-gray-400 mt-0.5">{dateRange.startDate} — {dateRange.endDate} · Operational management reporting</p></div></div><div className="flex gap-1 bg-gray-100 p-1 rounded-xl w-fit overflow-x-auto max-w-full">{tabs.map(tab => { const Icon = tab.icon; return <button key={tab.id} onClick={() => setActiveTab(tab.id)} className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium whitespace-nowrap ${activeTab === tab.id ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}><Icon className="w-4 h-4" />{tab.label}</button>; })}</div>{activeTab === 'sales-profit' && <SalesProfitTab dateRange={dateRange} />}{activeTab === 'monthly' && <MonthlySalesTab dateRange={dateRange} />}{activeTab === 'product-perf' && <ProductPerformanceTab dateRange={dateRange} />}{activeTab === 'customer' && <CustomerSalesTab dateRange={dateRange} />}{activeTab === 'expense-profit' && <ExpenseVsProfitTab dateRange={dateRange} />}</div></Layout>;
}
