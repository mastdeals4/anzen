import { useState, useEffect, useCallback } from 'react';
import { Layout } from '../components/Layout';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { Search } from 'lucide-react';
import { formatDate } from '../utils/dateFormat';
import { TableColumn, useColumnPreferences } from '../hooks/useColumnPreferences';

interface LedgerEntry {
  id: string;
  customer_name: string | null;
  product_name: string;
  inquiry_number: string | null;
  source_price: number | null;
  source_currency: string | null;
  final_quoted_price: number | null;
  final_quote_currency: string | null;
  target_price: number | null;
  competitor_price: number | null;
  won_lost: string | null;
  lost_reason: string | null;
  remarks: string | null;
  quote_date: string;
  created_at: string;
  price_request?: { pr_number: string } | null;
}

const WON_LOST_META: Record<string, { label: string; color: string }> = {
  won:     { label: 'Won',     color: 'bg-green-100 text-green-700' },
  lost:    { label: 'Lost',    color: 'bg-red-100 text-red-600' },
  pending: { label: 'Pending', color: 'bg-gray-100 text-gray-500' },
};

const LEDGER_COLUMNS: TableColumn[] = [
  { key: 'date', label: 'Date', width: 105, minWidth: 90, required: true },
  { key: 'customer', label: 'Customer', width: 150, minWidth: 120 },
  { key: 'product', label: 'Product', width: 190, minWidth: 130, required: true },
  { key: 'inquiry', label: 'Inquiry', width: 120, minWidth: 100 },
  { key: 'pr', label: 'PR #', width: 100, minWidth: 80 },
  { key: 'source', label: 'Source Price', width: 130, minWidth: 110 },
  { key: 'quote', label: 'Final Quote', width: 130, minWidth: 110, required: true },
  { key: 'target', label: 'Target', width: 100, minWidth: 80 },
  { key: 'competitor', label: 'Competitor', width: 110, minWidth: 90 },
  { key: 'status', label: 'Status', width: 110, minWidth: 90 },
  { key: 'remarks', label: 'Remarks', width: 170, minWidth: 120 },
];

export function PricingLedger() {
  const { profile } = useAuth();
  const [entries, setEntries] = useState<LedgerEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [wlFilter, setWlFilter] = useState('all');
  const [columnsOpen, setColumnsOpen] = useState(false);
  const table = useColumnPreferences('price_history_table', LEDGER_COLUMNS);

  const load = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase.from('pricing_ledger').select('*, price_request:price_requests(pr_number:price_request_number)').order('created_at', { ascending: false });
    setEntries((data as LedgerEntry[]) || []);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const updateWonLost = async (id: string, val: string) => {
    if (profile?.role !== 'admin' && profile?.role !== 'manager') return;
    await supabase.from('pricing_ledger').update({ won_lost: val }).eq('id', id);
    setEntries(e => e.map(x => x.id === id ? { ...x, won_lost: val } : x));
  };

  const canEditLedgerOutcome = profile?.role === 'admin' || profile?.role === 'manager';

  const filtered = entries.filter(e => {
    const q = search.toLowerCase();
    const matchSearch = !q
      || (e.customer_name || '').toLowerCase().includes(q)
      || (e.product_name || '').toLowerCase().includes(q)
      || (e.inquiry_number || '').toLowerCase().includes(q)
      || (e.price_request?.pr_number || '').toLowerCase().includes(q);
    const matchWl = wlFilter === 'all' || e.won_lost === wlFilter;
    return matchSearch && matchWl;
  });

  const stats = {
    total: entries.length,
    won: entries.filter(e => e.won_lost === 'won').length,
    lost: entries.filter(e => e.won_lost === 'lost').length,
    pending: entries.filter(e => !e.won_lost || e.won_lost === 'pending').length,
  };

  return (
    <Layout>
      <div className="p-4 md:p-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-lg font-semibold text-gray-900">Product Pricing Ledger</h1>
            <p className="text-xs text-gray-500 mt-0.5">Historical record of every final quoted price</p>
          </div>
        </div>

        <div className="grid grid-cols-4 gap-3 mb-4">
          {[
            { label: 'Total Quotes', value: stats.total, color: 'text-gray-700' },
            { label: 'Won', value: stats.won, color: 'text-green-600' },
            { label: 'Lost', value: stats.lost, color: 'text-red-500' },
            { label: 'Pending', value: stats.pending, color: 'text-gray-500' },
          ].map(s => (
            <div key={s.label} className="bg-white border border-gray-200 rounded-lg px-4 py-3">
              <p className={`text-xl font-semibold ${s.color}`}>{s.value}</p>
              <p className="text-xs text-gray-500 mt-0.5">{s.label}</p>
            </div>
          ))}
        </div>

        <div className="flex items-center gap-2 mb-4 flex-wrap">
          <div className="relative flex-1 min-w-[180px] max-w-xs">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search customer, product, inquiry..."
              className="w-full pl-8 pr-3 py-1.5 text-sm border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-blue-500" />
          </div>
          {['all', 'won', 'lost', 'pending'].map(s => (
            <button key={s} onClick={() => setWlFilter(s)}
              className={`px-2.5 py-1 text-xs rounded font-medium transition-colors ${wlFilter === s ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
              {s.charAt(0).toUpperCase() + s.slice(1)}
            </button>
          ))}
          <div className="relative">
            <button onClick={() => setColumnsOpen(open => !open)}
              className="px-3 py-1.5 text-xs border border-gray-200 rounded bg-white hover:bg-gray-50">
              Columns
            </button>
            {columnsOpen && (
              <div className="absolute right-0 top-full mt-1 w-52 bg-white border border-gray-200 rounded shadow-lg z-30 p-2">
                <button onClick={table.reset} className="text-[11px] text-blue-600 hover:underline mb-1">Reset widths</button>
                {table.columns.map(column => (
                  <label key={column.key} className="flex items-center gap-2 px-1.5 py-1 text-xs text-gray-700">
                    <input type="checkbox" checked={table.isVisible(column.key)} disabled={column.required} onChange={() => table.toggleColumn(column.key)} />
                    <span>{column.label}</span>
                  </label>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
          {loading ? (
            <div className="py-16 text-center text-sm text-gray-400">Loading...</div>
          ) : filtered.length === 0 ? (
            <div className="py-16 text-center text-sm text-gray-400">No entries found.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full table-fixed text-xs">
                <thead className="bg-gray-100 border-b border-gray-300 sticky top-0 z-10">
                  <tr>
                    {table.visibleColumns.map(column => (
                      <th key={column.key} style={table.getCellStyle(column.key)} className="relative px-2 py-1.5 text-left text-[10px] font-bold text-gray-700 uppercase tracking-wider whitespace-nowrap border-r border-gray-300">
                        {column.label}
                        <div className="absolute top-0 right-0 w-1 h-full cursor-col-resize hover:bg-blue-400" onMouseDown={event => table.startResize(column.key, event)} />
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {filtered.map(e => {
                    const wlm = WON_LOST_META[e.won_lost || 'pending'] || WON_LOST_META.pending;
                    return (
                      <tr key={e.id} className="hover:bg-gray-50 text-xs">
                        {table.isVisible('date') && <td style={table.getCellStyle('date')} className="px-2 py-1 text-gray-500 whitespace-nowrap border-r border-gray-200">{formatDate(e.quote_date)}</td>}
                        {table.isVisible('customer') && <td style={table.getCellStyle('customer')} className="px-2 py-1 text-gray-800 truncate border-r border-gray-200">{e.customer_name || '-'}</td>}
                        {table.isVisible('product') && <td style={table.getCellStyle('product')} className="px-2 py-1 font-medium text-gray-900 truncate border-r border-gray-200">{e.product_name}</td>}
                        {table.isVisible('inquiry') && <td style={table.getCellStyle('inquiry')} className="px-2 py-1 text-gray-500 whitespace-nowrap border-r border-gray-200">{e.inquiry_number || '-'}</td>}
                        {table.isVisible('pr') && <td style={table.getCellStyle('pr')} className="px-2 py-1 text-blue-700 whitespace-nowrap border-r border-gray-200">{e.price_request?.pr_number || '-'}</td>}
                        {table.isVisible('source') && <td style={table.getCellStyle('source')} className="px-2 py-1 text-gray-700 whitespace-nowrap border-r border-gray-200">{e.source_price ? `${e.source_currency} ${e.source_price.toLocaleString()}` : '-'}</td>}
                        {table.isVisible('quote') && <td style={table.getCellStyle('quote')} className="px-2 py-1 font-medium text-blue-700 whitespace-nowrap border-r border-gray-200">{e.final_quoted_price ? `${e.final_quote_currency} ${e.final_quoted_price.toLocaleString()}` : '-'}</td>}
                        {table.isVisible('target') && <td style={table.getCellStyle('target')} className="px-2 py-1 text-gray-500 border-r border-gray-200">{e.target_price ? `$${e.target_price}` : '-'}</td>}
                        {table.isVisible('competitor') && <td style={table.getCellStyle('competitor')} className="px-2 py-1 text-gray-500 border-r border-gray-200">{e.competitor_price ? `$${e.competitor_price}` : '-'}</td>}
                        {table.isVisible('status') && <td style={table.getCellStyle('status')} className="px-2 py-1 border-r border-gray-200">
                          <select value={e.won_lost || 'pending'} onChange={ev => updateWonLost(e.id, ev.target.value)}
                            disabled={!canEditLedgerOutcome}
                            className={`border-0 rounded px-1.5 py-0.5 text-[10px] font-medium focus:outline-none ${canEditLedgerOutcome ? 'cursor-pointer' : 'cursor-default'} ${wlm.color}`}>
                            <option value="pending">Pending</option>
                            <option value="won">Won</option>
                            <option value="lost">Lost</option>
                          </select>
                        </td>}
                        {table.isVisible('remarks') && <td style={table.getCellStyle('remarks')} className="px-2 py-1 text-gray-400 truncate">{e.remarks || '-'}</td>}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </Layout>
  );
}
