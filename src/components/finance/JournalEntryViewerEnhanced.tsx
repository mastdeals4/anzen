import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { useFinance } from '../../contexts/FinanceContext';
import { Search, FileText, LayoutList, Table2 } from 'lucide-react';
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

interface VoucherJournalEntry {
  journal_entry_id: string;
  date: string;
  voucher_no: string;
  voucher_type: string;
  debit_account: string;
  credit_account: string;
  amount: number;
  narration: string;
  reference_number: string | null;
  source_module: string | null;
  line_count: number;
  is_multi_line: boolean;
}

interface JournalEntryViewerEnhancedProps {
  canManage: boolean;
}

const sourceModuleLabels: Record<string, string> = {
  sales_invoice: 'Sales Invoice',
  sales_invoice_cogs: 'COGS Entry',
  purchase_invoice: 'Purchase Invoice',
  receipt: 'Receipt Voucher',
  payment: 'Payment Voucher',
  petty_cash: 'Petty Cash',
  fund_transfer: 'Fund Transfer',
  manual: 'Manual Entry',
};

export function JournalEntryViewerEnhanced({ canManage }: JournalEntryViewerEnhancedProps) {
  const { dateRange } = useFinance();
  const [voucherEntries, setVoucherEntries] = useState<VoucherJournalEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedEntry, setSelectedEntry] = useState<JournalEntry | null>(null);
  const [entryLines, setEntryLines] = useState<JournalEntryLine[]>([]);
  const [viewModalOpen, setViewModalOpen] = useState(false);
  const [filterModule, setFilterModule] = useState('all');

  useEffect(() => {
    loadVoucherJournal();
  }, [dateRange, filterModule]);

  const loadVoucherJournal = async () => {
    try {
      setLoading(true);
      let query = supabase
        .from('journal_voucher_view')
        .select('*')
        .gte('date', dateRange.startDate)
        .lte('date', dateRange.endDate);

      if (filterModule !== 'all') {
        query = query.eq('source_module', filterModule);
      }

      const { data, error } = await query;

      if (error) throw error;
      setVoucherEntries(data || []);
    } catch (error) {
      console.error('Error loading voucher journal:', error);
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

  const handleViewVoucher = async (voucherEntry: VoucherJournalEntry) => {
    try {
      // Load full journal entry details
      const { data: entry, error: entryError } = await supabase
        .from('journal_entries')
        .select('*')
        .eq('id', voucherEntry.journal_entry_id)
        .single();

      if (entryError) throw entryError;

      setSelectedEntry(entry);
      await loadEntryLines(voucherEntry.journal_entry_id);
      setViewModalOpen(true);
    } catch (error) {
      console.error('Error loading voucher details:', error);
    }
  };

  const filteredVouchers = voucherEntries.filter(v =>
    v.voucher_no.toLowerCase().includes(searchTerm.toLowerCase()) ||
    (v.debit_account && v.debit_account.toLowerCase().includes(searchTerm.toLowerCase())) ||
    (v.credit_account && v.credit_account.toLowerCase().includes(searchTerm.toLowerCase())) ||
    (v.narration && v.narration.toLowerCase().includes(searchTerm.toLowerCase())) ||
    (v.reference_number && v.reference_number.toLowerCase().includes(searchTerm.toLowerCase()))
  );

  const totals = {
    debit: filteredVouchers.reduce((sum, v) => sum + v.amount, 0),
    credit: filteredVouchers.reduce((sum, v) => sum + v.amount, 0),
  };

  if (loading) {
    return <div className="flex justify-center py-8"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div></div>;
  }

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex flex-wrap items-center gap-4">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-5 h-5" />
          <input
            type="text"
            placeholder="Search voucher, accounts, narration..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg"
          />
        </div>

        <select
          value={filterModule}
          onChange={(e) => setFilterModule(e.target.value)}
          className="px-3 py-2 border border-gray-300 rounded-lg"
        >
          <option value="all">All Sources</option>
          <option value="sales_invoice">Sales Invoices</option>
          <option value="sales_invoice_cogs">COGS</option>
          <option value="purchase_invoice">Purchase Invoices</option>
          <option value="receipt">Receipts</option>
          <option value="payment">Payments</option>
          <option value="petty_cash">Petty Cash</option>
          <option value="fund_transfer">Fund Transfers</option>
          <option value="manual">Manual</option>
        </select>
      </div>


      {/* Journal Voucher View (Tally Style) - One row per voucher */}
      <div className="bg-white rounded-lg shadow overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 sticky top-0">
              <tr>
                <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider border-r">Date</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider border-r">Journal No</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider border-r">Type</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider border-r">Debit Account</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider border-r">Credit Account</th>
                <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 uppercase tracking-wider border-r">Amount</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider border-r">Narration</th>
                <th className="px-3 py-2 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">Details</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 bg-white">
              {filteredVouchers.map((voucher) => (
                <tr key={voucher.journal_entry_id} className="hover:bg-gray-50 transition-colors">
                  <td className="px-3 py-2 whitespace-nowrap text-gray-900 border-r">
                    {new Date(voucher.date).toLocaleDateString('id-ID', { day: '2-digit', month: '2-digit', year: 'numeric' })}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap font-mono text-blue-600 border-r">
                    {voucher.voucher_no}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap border-r">
                    <span className="px-2 py-1 text-xs bg-gray-100 text-gray-700 rounded">
                      {voucher.voucher_type}
                    </span>
                  </td>
                  <td className="px-3 py-2 border-r">
                    <div className="text-xs text-gray-900 max-w-xs truncate">
                      {voucher.debit_account || '-'}
                    </div>
                  </td>
                  <td className="px-3 py-2 border-r">
                    <div className="text-xs text-gray-900 max-w-xs truncate">
                      {voucher.credit_account || '-'}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right whitespace-nowrap border-r">
                    <span className="text-gray-900 font-medium">
                      Rp {voucher.amount.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-gray-600 text-xs border-r">
                    <div className="max-w-md truncate">
                      {voucher.narration || '-'}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-center">
                    {voucher.is_multi_line && (
                      <button
                        onClick={() => handleViewVoucher(voucher)}
                        className="text-blue-600 hover:text-blue-800"
                        title="View detailed breakdown"
                      >
                        <FileText className="w-4 h-4" />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {filteredVouchers.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-gray-500">
                    No journal entries found
                  </td>
                </tr>
              )}
            </tbody>
            <tfoot className="bg-gray-50 font-bold">
              <tr>
                <td colSpan={5} className="px-3 py-2 text-right">Total:</td>
                <td className="px-3 py-2 text-right text-gray-900 border-r">
                  Rp {totals.debit.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </td>
                <td colSpan={2}></td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      {/* Voucher Detail Modal */}
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
                        {line.debit > 0 ? `Rp ${line.debit.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : ''}
                      </td>
                      <td className="px-3 py-2 text-right text-green-600">
                        {line.credit > 0 ? `Rp ${line.credit.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="bg-gray-50 font-medium">
                  <tr>
                    <td colSpan={2} className="px-3 py-2 text-right">Total:</td>
                    <td className="px-3 py-2 text-right text-blue-700">
                      Rp {selectedEntry.total_debit.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </td>
                    <td className="px-3 py-2 text-right text-green-700">
                      Rp {selectedEntry.total_credit.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
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
