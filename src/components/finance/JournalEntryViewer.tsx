import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { Search, FileText, Filter } from 'lucide-react';
import { Modal } from '../Modal';

interface JournalEntry {
  id: string;
  entry_number: string;
  entry_date: string;
  source_module: string | null;
  reference_number: string | null;
  description: string | null;
  total_debit: number;
  total_credit: number;
  is_posted: boolean;
  posted_at: string;
}

interface JournalEntryLine {
  id: string;
  line_number: number;
  account_id: string;
  description: string | null;
  debit: number;
  credit: number;
  chart_of_accounts?: {
    code: string;
    name: string;
  };
  customers?: { company_name: string } | null;
  suppliers?: { company_name: string } | null;
}

interface JournalEntryViewerProps {
  canManage: boolean;
}

const sourceModuleLabels: Record<string, string> = {
  sales_invoice: 'Sales Invoice',
  purchase_invoice: 'Purchase Invoice',
  receipt: 'Receipt Voucher',
  payment: 'Payment Voucher',
  petty_cash: 'Petty Cash',
  manual: 'Manual Entry',
};

export function JournalEntryViewer({ canManage }: JournalEntryViewerProps) {
  const [entries, setEntries] = useState<JournalEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedEntry, setSelectedEntry] = useState<JournalEntry | null>(null);
  const [entryLines, setEntryLines] = useState<JournalEntryLine[]>([]);
  const [viewModalOpen, setViewModalOpen] = useState(false);
  const [dateRange, setDateRange] = useState({
    start: new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split('T')[0],
    end: new Date().toISOString().split('T')[0],
  });
  const [filterModule, setFilterModule] = useState('all');

  useEffect(() => {
    loadEntries();
  }, [dateRange, filterModule]);

  const loadEntries = async () => {
    try {
      let query = supabase
        .from('journal_entries')
        .select('*')
        .gte('entry_date', dateRange.start)
        .lte('entry_date', dateRange.end)
        .order('entry_date', { ascending: false })
        .order('entry_number', { ascending: false });

      if (filterModule !== 'all') {
        query = query.eq('source_module', filterModule);
      }

      const { data, error } = await query;

      if (error) throw error;
      setEntries(data || []);
    } catch (error) {
      console.error('Error loading entries:', error);
    } finally {
      setLoading(false);
    }
  };

  const loadEntryLines = async (entryId: string) => {
    try {
      const { data, error } = await supabase
        .from('journal_entry_lines')
        .select('*, chart_of_accounts(code, name), customers(company_name), suppliers(company_name)')
        .eq('journal_entry_id', entryId)
        .order('line_number');

      if (error) throw error;
      setEntryLines(data || []);
    } catch (error) {
      console.error('Error loading lines:', error);
    }
  };

  const handleViewEntry = async (entry: JournalEntry) => {
    setSelectedEntry(entry);
    await loadEntryLines(entry.id);
    setViewModalOpen(true);
  };

  const filteredEntries = entries.filter(e =>
    e.entry_number.toLowerCase().includes(searchTerm.toLowerCase()) ||
    (e.reference_number && e.reference_number.toLowerCase().includes(searchTerm.toLowerCase())) ||
    (e.description && e.description.toLowerCase().includes(searchTerm.toLowerCase()))
  );

  const totals = {
    debit: filteredEntries.reduce((sum, e) => sum + e.total_debit, 0),
    credit: filteredEntries.reduce((sum, e) => sum + e.total_credit, 0),
  };

  if (loading) {
    return <div className="flex justify-center py-8"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div></div>;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-4">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-5 h-5" />
          <input
            type="text"
            placeholder="Search entries..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg"
          />
        </div>
        
        <div className="flex items-center gap-2">
          <input
            type="date"
            value={dateRange.start}
            onChange={(e) => setDateRange({ ...dateRange, start: e.target.value })}
            className="px-3 py-2 border border-gray-300 rounded-lg"
          />
          <span className="text-gray-500">to</span>
          <input
            type="date"
            value={dateRange.end}
            onChange={(e) => setDateRange({ ...dateRange, end: e.target.value })}
            className="px-3 py-2 border border-gray-300 rounded-lg"
          />
        </div>

        <select
          value={filterModule}
          onChange={(e) => setFilterModule(e.target.value)}
          className="px-3 py-2 border border-gray-300 rounded-lg"
        >
          <option value="all">All Sources</option>
          <option value="sales_invoice">Sales Invoices</option>
          <option value="purchase_invoice">Purchase Invoices</option>
          <option value="receipt">Receipts</option>
          <option value="payment">Payments</option>
          <option value="petty_cash">Petty Cash</option>
          <option value="manual">Manual</option>
        </select>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="bg-blue-50 rounded-lg p-4">
          <p className="text-sm text-blue-600">Total Debit</p>
          <p className="text-2xl font-bold text-blue-700">Rp {totals.debit.toLocaleString('id-ID')}</p>
        </div>
        <div className="bg-green-50 rounded-lg p-4">
          <p className="text-sm text-green-600">Total Credit</p>
          <p className="text-2xl font-bold text-green-700">Rp {totals.credit.toLocaleString('id-ID')}</p>
        </div>
      </div>

      <div className="bg-white rounded-lg shadow overflow-hidden">
        <table className="w-full">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Entry No</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Date</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Source</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Reference</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Description</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Debit</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Credit</th>
              <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase">View</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {filteredEntries.map(entry => (
              <tr key={entry.id} className="hover:bg-gray-50">
                <td className="px-4 py-3 font-mono text-sm">{entry.entry_number}</td>
                <td className="px-4 py-3">{new Date(entry.entry_date).toLocaleDateString('id-ID')}</td>
                <td className="px-4 py-3">
                  <span className="px-2 py-1 bg-gray-100 text-gray-700 rounded text-xs">
                    {entry.source_module ? sourceModuleLabels[entry.source_module] || entry.source_module : 'Manual'}
                  </span>
                </td>
                <td className="px-4 py-3 font-mono text-sm">{entry.reference_number || '-'}</td>
                <td className="px-4 py-3 text-sm text-gray-600 max-w-xs truncate">{entry.description || '-'}</td>
                <td className="px-4 py-3 text-right text-blue-600">Rp {entry.total_debit.toLocaleString('id-ID')}</td>
                <td className="px-4 py-3 text-right text-green-600">Rp {entry.total_credit.toLocaleString('id-ID')}</td>
                <td className="px-4 py-3 text-center">
                  <button
                    onClick={() => handleViewEntry(entry)}
                    className="text-blue-600 hover:text-blue-800"
                  >
                    <FileText className="w-4 h-4" />
                  </button>
                </td>
              </tr>
            ))}
            {filteredEntries.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-gray-500">
                  No journal entries found
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <Modal isOpen={viewModalOpen} onClose={() => setViewModalOpen(false)} title={`Journal Entry: ${selectedEntry?.entry_number}`}>
        {selectedEntry && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <span className="text-gray-500">Date:</span>
                <span className="ml-2 font-medium">{new Date(selectedEntry.entry_date).toLocaleDateString('id-ID')}</span>
              </div>
              <div>
                <span className="text-gray-500">Source:</span>
                <span className="ml-2">{selectedEntry.source_module ? sourceModuleLabels[selectedEntry.source_module] : 'Manual'}</span>
              </div>
              <div>
                <span className="text-gray-500">Reference:</span>
                <span className="ml-2 font-mono">{selectedEntry.reference_number || '-'}</span>
              </div>
              <div>
                <span className="text-gray-500">Posted:</span>
                <span className="ml-2">{new Date(selectedEntry.posted_at).toLocaleString('id-ID')}</span>
              </div>
            </div>

            {selectedEntry.description && (
              <div className="p-3 bg-gray-50 rounded-lg text-sm">
                {selectedEntry.description}
              </div>
            )}

            <div className="border rounded-lg overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-3 py-2 text-left">Account</th>
                    <th className="px-3 py-2 text-left">Description</th>
                    <th className="px-3 py-2 text-right">Debit</th>
                    <th className="px-3 py-2 text-right">Credit</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {entryLines.map(line => (
                    <tr key={line.id}>
                      <td className="px-3 py-2">
                        <div className="font-mono text-xs text-gray-500">{line.chart_of_accounts?.code}</div>
                        <div>{line.chart_of_accounts?.name}</div>
                        {line.customers && <div className="text-xs text-blue-600">{line.customers.company_name}</div>}
                        {line.suppliers && <div className="text-xs text-purple-600">{line.suppliers.company_name}</div>}
                      </td>
                      <td className="px-3 py-2 text-gray-600">{line.description || '-'}</td>
                      <td className="px-3 py-2 text-right text-blue-600">
                        {line.debit > 0 ? `Rp ${line.debit.toLocaleString('id-ID')}` : ''}
                      </td>
                      <td className="px-3 py-2 text-right text-green-600">
                        {line.credit > 0 ? `Rp ${line.credit.toLocaleString('id-ID')}` : ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="bg-gray-50 font-medium">
                  <tr>
                    <td colSpan={2} className="px-3 py-2 text-right">Total:</td>
                    <td className="px-3 py-2 text-right text-blue-700">
                      Rp {selectedEntry.total_debit.toLocaleString('id-ID')}
                    </td>
                    <td className="px-3 py-2 text-right text-green-700">
                      Rp {selectedEntry.total_credit.toLocaleString('id-ID')}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>

            {selectedEntry.total_debit !== selectedEntry.total_credit && (
              <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
                Warning: Debit and Credit totals do not match!
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
