import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { useLanguage } from '../../contexts/LanguageContext';
import { Search } from 'lucide-react';
import { FinanceModal as Modal } from './FinanceModal';
import { showToast } from '../ToastNotification';
import { showConfirm } from '../ConfirmDialog';
import { formatCurrency } from '../../utils/currency';
import { FinanceActionButton } from './FinanceUI';
import { useFinance } from '../../contexts/FinanceContext';

interface JournalEntry {
  id: string;
  entry_number: string;
  entry_date: string;
  source_module: string | null;
  reference_id?: string | null;
  reference_number: string | null;
  description: string | null;
  total_debit: number;
  total_credit: number;
  is_posted: boolean;
  is_reversed?: boolean;
  posted_at: string;
  transaction_currency?: string | null;
  functional_currency?: string | null;
  exchange_rate?: number | null;
  amounts_are_functional?: boolean | null;
}

interface JournalEntryLine {
  id: string;
  line_number: number;
  account_id: string;
  description: string | null;
  debit: number;
  credit: number;
  transaction_currency?: string | null;
  transaction_debit?: number | null;
  transaction_credit?: number | null;
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
  reference_id?: string | null;
  is_posted: boolean;
  is_reversed: boolean;
  line_count: number;
  is_multi_line: boolean;
  transaction_currency?: string | null;
  transaction_amount?: number | null;
}

interface JournalEntryViewerEnhancedProps {
  canManage: boolean;
  onEditEntry?: (entryId: string) => void;
  initialViewEntryId?: string | null;
  onInitialViewHandled?: () => void;
  onOpenSource?: (sourceModule: string, referenceId: string) => void;
}

const sourceModuleKey: Record<string, string> = {
  sales_invoice: 'journalSales',
  sales_invoice_cogs: 'journalSales',
  purchase_invoice: 'purchase',
  receipt: 'receipt',
  payment: 'payment',
  petty_cash: 'journalPettyCash',
  fund_transfer: 'journalFundTransfer',
  fund_transfers: 'journalFundTransfer',
  bank_reconciliation: 'journalBankReconciliation',
  tax_payment: 'journalTax',
  expense: 'journalExpense',
  expenses: 'journalExpense',
  manual: 'journalManual',
};

const sourceFilters = [
  { value: 'all', label: 'All Sources' },
  { value: 'sales_invoice', label: 'Sales Invoices' },
  { value: 'sales_invoice_cogs', label: 'COGS' },
  { value: 'purchase_invoice', label: 'Purchase Invoices' },
  { value: 'receipt', label: 'Receipts' },
  { value: 'payment', label: 'Payments' },
  { value: 'expenses', label: 'Expenses' },
  { value: 'petty_cash', label: 'Petty Cash' },
  { value: 'fund_transfers', label: 'Fund Transfers' },
  { value: 'bank_reconciliation', label: 'Bank Reconciliation' },
  { value: 'tax_payment', label: 'Tax Payments' },
  { value: 'loans', label: 'Loans' },
  { value: 'loan_transactions', label: 'Loan Repayments' },
  { value: 'capital_contribution', label: 'Capital Contributions' },
  { value: 'manual', label: 'Manual' },
];
export function JournalEntryViewerEnhanced({
  canManage,
  onEditEntry,
  initialViewEntryId,
  onInitialViewHandled,
  onOpenSource,
}: JournalEntryViewerEnhancedProps) {
  const { t, language } = useLanguage();
  const { dateRange } = useFinance();
  const [voucherEntries, setVoucherEntries] = useState<VoucherJournalEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedEntry, setSelectedEntry] = useState<JournalEntry | null>(null);
  const [entryLines, setEntryLines] = useState<JournalEntryLine[]>([]);
  const [viewModalOpen, setViewModalOpen] = useState(false);
  const [sourceSummary, setSourceSummary] = useState<string | null>(null);
  const [filterModule, setFilterModule] = useState('all');
  const [statusFilter, setStatusFilter] = useState<'posted' | 'all' | 'draft' | 'reversed'>('posted');
  const sourceLabel = (sourceModule: string | null | undefined) => {
    if (!sourceModule) return t.finance.journalManual;
    const key = sourceModuleKey[sourceModule];
    return key ? t(`finance.${key}`) : sourceModule.replace(/_/g, ' ').replace(/\b\w/g, (letter: string) => letter.toUpperCase());
  };

  useEffect(() => {
    loadVoucherJournal();
  }, [filterModule, statusFilter, language, dateRange.startDate, dateRange.endDate]);

  const loadVoucherJournal = async () => {
    try {
      setLoading(true);
      setLoadError(null);
      // The unified register reads the journal table directly so every source
      // module (including bank reconciliation and tax) shares one visibility
      // contract. Draft/reversed rows are opt-in through the status filter.
      const entryPageSize = 500;
      const entries: JournalEntry[] = [];
      for (let from = 0; ; from += entryPageSize) {
        let query = supabase
          .from('journal_entries')
          .select('id, entry_number, entry_date, source_module, reference_id, reference_number, description, total_debit, total_credit, is_posted, is_reversed, posted_at, transaction_currency, functional_currency, exchange_rate, amounts_are_functional')
          .gte('entry_date', dateRange.startDate)
          .lte('entry_date', dateRange.endDate)
          .order('entry_date', { ascending: false })
          .order('entry_number', { ascending: false })
          .order('id', { ascending: false })
          .range(from, from + entryPageSize - 1);
        if (statusFilter === 'posted') query = query.eq('is_posted', true).or('is_reversed.eq.false,is_reversed.is.null');
        if (statusFilter === 'draft') query = query.eq('is_posted', false).or('is_reversed.eq.false,is_reversed.is.null');
        if (statusFilter === 'reversed') query = query.eq('is_reversed', true);
        const { data: entryPage, error } = await query;
        if (error) throw error;
        entries.push(...(entryPage || []));
        if (!entryPage || entryPage.length < entryPageSize) break;
      }

      const entryIds = entries.map(e => e.id);
      // PostgREST encodes `.in(...)` values in the request URL. Loading every
      // journal ID in one request eventually exceeds the URL limit and makes
      // the master register fail with HTTP 400. Batching also keeps each line
      // result below the API's per-request row cap.
      const lineBatchSize = 100;
      const lineBatches: string[][] = [];
      for (let index = 0; index < entryIds.length; index += lineBatchSize) {
        lineBatches.push(entryIds.slice(index, index + lineBatchSize));
      }
      const lineResults = await Promise.all(lineBatches.map(batch =>
        supabase
          .from('journal_entry_lines')
          .select('journal_entry_id, debit, credit, transaction_debit, transaction_credit, chart_of_accounts(code, name)')
          .in('journal_entry_id', batch)
          .order('line_number')
      ));
      const failedLineBatch = lineResults.find(result => result.error);
      if (failedLineBatch?.error) throw failedLineBatch.error;
      const lines = lineResults.flatMap(result => result.data || []);
      const linesByEntry = new Map<string, Array<{ debit: number; credit: number; transaction_debit: number; transaction_credit: number; chart_of_accounts?: { code: string; name: string } | null }>>();
      (lines || []).forEach((line: any) => {
        const list = linesByEntry.get(line.journal_entry_id) || [];
        list.push({ debit: Number(line.debit || 0), credit: Number(line.credit || 0),
          transaction_debit: Number(line.transaction_debit || 0), transaction_credit: Number(line.transaction_credit || 0),
          chart_of_accounts: line.chart_of_accounts });
        linesByEntry.set(line.journal_entry_id, list);
      });
      setVoucherEntries(entries.map(entry => {
        const entryLines = linesByEntry.get(entry.id) || [];
        const debitLine = entryLines.find(line => line.debit > 0);
        const creditLine = entryLines.find(line => line.credit > 0);
        return {
          journal_entry_id: entry.id,
          date: entry.entry_date,
          voucher_no: entry.entry_number,
          voucher_type: sourceLabel(entry.source_module),
          debit_account: debitLine?.chart_of_accounts ? `${debitLine.chart_of_accounts.code} - ${debitLine.chart_of_accounts.name}` : '',
          credit_account: creditLine?.chart_of_accounts ? `${creditLine.chart_of_accounts.code} - ${creditLine.chart_of_accounts.name}` : '',
          amount: Number(entry.total_debit || 0),
          transaction_currency: entry.transaction_currency,
          transaction_amount: entry.transaction_currency && entry.transaction_currency !== 'IDR'
            ? entryLines.reduce((sum, line) => sum + line.transaction_debit, 0) : null,
          narration: entry.description || '',
          reference_number: entry.reference_number,
          source_module: entry.source_module,
          reference_id: entry.reference_id,
          is_posted: Boolean(entry.is_posted),
          is_reversed: Boolean(entry.is_reversed),
          line_count: entryLines.length,
          is_multi_line: entryLines.length > 2,
        };
      }));
    } catch (error) {
      console.error('Error loading voucher journal:', error);
      setLoadError(error instanceof Error ? error.message : String(error));
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
      const { data: entry, error: entryError } = await supabase
        .from('journal_entries')
        .select('*')
        .eq('id', voucherEntry.journal_entry_id)
        .single();

      if (entryError) throw entryError;

      setSelectedEntry(entry);
      setSourceSummary(null);
      if (entry.reference_id && entry.source_module === 'loans') {
        const { data } = await supabase.from('loans')
          .select('loan_number, counterparty_name, principal_amount, currency, status')
          .eq('id', entry.reference_id).maybeSingle();
        if (data) setSourceSummary(`${data.loan_number} — ${data.counterparty_name} — ${formatCurrency(data.principal_amount, data.currency)} — ${data.status}`);
      } else if (entry.reference_id && entry.source_module === 'loan_transactions') {
        const { data } = await supabase.from('loan_transactions')
          .select('transaction_number, amount, transaction_currency, status, loans(loan_number, counterparty_name)')
          .eq('id', entry.reference_id).maybeSingle();
        if (data) {
          const loan = Array.isArray(data.loans) ? data.loans[0] : data.loans;
          setSourceSummary(`${data.transaction_number} — ${loan?.loan_number || ''} ${loan?.counterparty_name || ''} — ${formatCurrency(data.amount, data.transaction_currency || 'IDR')} — ${data.status}`);
        }
      } else if (entry.reference_id && entry.source_module === 'capital_contribution') {
        const { data } = await supabase.from('capital_contributions')
          .select('voucher_number, amount, transaction_currency, exchange_rate')
          .eq('id', entry.reference_id).maybeSingle();
        if (data) setSourceSummary(`${data.voucher_number} — ${formatCurrency(data.amount, data.transaction_currency || 'IDR')} — rate ${data.exchange_rate || 'manual review required'}`);
      }
      await loadEntryLines(voucherEntry.journal_entry_id);
      setViewModalOpen(true);
    } catch (error) {
      console.error('Error loading voucher details:', error);
    }
  };

  useEffect(() => {
    if (!initialViewEntryId || loading) return;
    const entry = voucherEntries.find(voucher => voucher.journal_entry_id === initialViewEntryId);
    if (entry) void handleViewVoucher(entry);
    onInitialViewHandled?.();
  }, [initialViewEntryId, loading, voucherEntries, onInitialViewHandled]);

  const handleDeleteJournal = async (journalId: string) => {
    const confirmed = await showConfirm({
      title: 'Delete Journal Entry',
      message: 'Are you sure you want to delete this manual journal entry? This action cannot be undone.',
      confirmLabel: 'Delete',
      variant: 'danger',
    });

    if (!confirmed) return;

    try {
      const [{ data: bankLinks, error: checkError }, { data: canonicalAllocations, error: allocationError }] = await Promise.all([
        supabase
        .from('bank_statement_lines')
        .select('id')
        .eq('matched_entry_id', journalId)
        .limit(1),
        supabase
          .from('bank_statement_allocations')
          .select('id')
          .eq('journal_entry_id', journalId)
          .limit(1),
      ]);

      if (checkError) throw checkError;
      if (allocationError) throw allocationError;

      if ((bankLinks && bankLinks.length > 0) || (canonicalAllocations && canonicalAllocations.length > 0)) {
        showToast({ type: 'error', title: 'Cannot Delete', message: t.finance.journalLinkedBankError });
        return;
      }

      const { error: linesError } = await supabase
        .from('journal_entry_lines')
        .delete()
        .eq('journal_entry_id', journalId);

      if (linesError) throw linesError;

      const { error: entryError } = await supabase
        .from('journal_entries')
        .delete()
        .eq('id', journalId)
        .eq('source_module', 'manual');

      if (entryError) throw entryError;

      showToast({ type: 'success', title: 'Success', message: 'Journal entry deleted successfully' });
      loadVoucherJournal();
    } catch (error: unknown) {
      console.error('Error deleting journal:', error);
      showToast({ type: 'error', title: 'Error', message: 'Error deleting journal entry: ' + (error instanceof Error ? error.message : 'Unknown error') });
    }
  };

  const normalizedSearch = searchTerm.trim().toLowerCase();
  const filteredVouchers = voucherEntries.filter(v => {
    const source = v.source_module || '';
    const moduleMatch = filterModule === 'all'
      || (filterModule === 'expenses' && (source === 'expense' || source === 'expenses'))
      || (filterModule === 'fund_transfers' && (source === 'fund_transfer' || source === 'fund_transfers'))
      || source === filterModule;
    if (!moduleMatch) return false;
    if (!normalizedSearch) return true;
    return [v.voucher_no, v.reference_number, v.reference_id, v.source_module, v.voucher_type,
      v.date, v.narration, v.debit_account, v.credit_account]
      .some(value => String(value || '').toLowerCase().includes(normalizedSearch));
  });

  const totals = {
    debit: filteredVouchers.reduce((sum, v) => sum + v.amount, 0),
    credit: filteredVouchers.reduce((sum, v) => sum + v.amount, 0),
  };

  if (loading) {
    return <div className="flex justify-center py-8"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div></div>;
  }

  return (
    <div className="space-y-2">
      {loadError && (
        <div className="rounded border border-red-200 bg-red-50 px-2 py-1.5 text-xs text-red-700">
          {t.finance.journalLoadError.replace('{error}', loadError)}
        </div>
      )}
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
          className="px-1.5 py-1 border border-gray-300 rounded-lg"
        >
          {sourceFilters.map(filter => <option key={filter.value} value={filter.value}>{filter.label}</option>)}
        </select>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
          className="px-1.5 py-1 border border-gray-300 rounded-lg"
          aria-label={t.finance.journalStatusFilter}
        >
          <option value="posted">{t.finance.journalPostedActive}</option>
          <option value="all">{t.finance.journalAllStatuses}</option>
          <option value="draft">{t.finance.journalDraft}</option>
          <option value="reversed">{t.finance.journalReversed}</option>
        </select>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-gray-500 bg-slate-50 border border-slate-200 rounded px-2 py-1.5">
        <span>{statusFilter === 'posted' ? t.finance.journalRegisterPosted : t.finance.journalRegisterStatus.replace('{status}', statusFilter)}</span>
        <span>All accounting dates</span>
      </div>

      {/* Journal Voucher View (Tally Style) - One row per voucher */}
      <div className="bg-white rounded border border-gray-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 sticky top-0">
              <tr>
                <th className="px-1.5 py-1 text-left text-xs font-medium text-gray-500 uppercase tracking-wider border-r">Date</th>
                <th className="px-1.5 py-1 text-left text-xs font-medium text-gray-500 uppercase tracking-wider border-r">Type</th>
                <th className="px-1.5 py-1 text-left text-xs font-medium text-gray-500 uppercase tracking-wider border-r">{t.finance.journalNumber}</th>
                <th className="px-1.5 py-1 text-left text-xs font-medium text-gray-500 uppercase tracking-wider border-r">{t.finance.journalSourceDocument}</th>
                <th className="px-1.5 py-1 text-left text-xs font-medium text-gray-500 uppercase tracking-wider border-r">Debit Account</th>
                <th className="px-1.5 py-1 text-left text-xs font-medium text-gray-500 uppercase tracking-wider border-r">Credit Account</th>
                <th className="px-1.5 py-1 text-right text-xs font-medium text-gray-500 uppercase tracking-wider border-r">Amount</th>
                <th className="px-1.5 py-1 text-left text-xs font-medium text-gray-500 uppercase tracking-wider border-r">Narration</th>
                <th className="px-1.5 py-1 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 bg-white">
              {filteredVouchers.map((voucher) => (
                <tr key={voucher.journal_entry_id} className="hover:bg-gray-50 transition-colors">
                  <td className="px-1.5 py-1 whitespace-nowrap text-gray-900 border-r">
                    <div className="text-xs">
                      {new Date(voucher.date).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: '2-digit' })}
                    </div>
                  </td>
                  <td className="px-1.5 py-1 whitespace-nowrap border-r">
                    <span className="px-2 py-1 text-xs bg-gray-100 text-gray-700 rounded">
                      {voucher.voucher_type}
                    </span>
                  </td>
                  <td className="px-1.5 py-1 whitespace-nowrap border-r font-mono text-xs">
                    <button type="button" onClick={() => handleViewVoucher(voucher)} className="text-blue-700 hover:underline">
                      {voucher.voucher_no}
                    </button>
                  </td>
                  <td className="px-1.5 py-1 border-r text-xs text-gray-600">
                    {voucher.reference_number || voucher.reference_id || '-'}
                  </td>
                  <td className="px-1.5 py-1 border-r">
                    <div className="text-xs text-gray-900 max-w-xs truncate">
                      {voucher.debit_account || '-'}
                    </div>
                  </td>
                  <td className="px-1.5 py-1 border-r">
                    <div className="text-xs text-gray-900 max-w-xs truncate">
                      {voucher.credit_account || '-'}
                    </div>
                  </td>
                  <td className="px-1.5 py-1 text-right whitespace-nowrap border-r">
                    <span className="text-gray-900 font-medium text-xs">
                      {formatCurrency(voucher.amount, 'IDR')}
                    </span>
                    {voucher.transaction_currency && voucher.transaction_currency !== 'IDR' && voucher.transaction_amount != null && (
                      <div className="text-[10px] text-blue-600">
                        {formatCurrency(voucher.transaction_amount, voucher.transaction_currency)}
                      </div>
                    )}
                  </td>
                  <td className="px-1.5 py-1 text-gray-600 text-xs border-r">
                    <div className="max-w-md truncate">
                      {voucher.narration || '-'}
                    </div>
                  </td>
                  <td className="px-1.5 py-1 text-center">
                    <div className="flex items-center justify-center gap-2">
                      <FinanceActionButton action="view" label="View detailed breakdown" onClick={() => handleViewVoucher(voucher)} />
                      {canManage && voucher.source_module === 'manual' && (
                        <>
                          <FinanceActionButton action="edit" label="Edit manual entry" onClick={() => onEditEntry?.(voucher.journal_entry_id)} />
                          <FinanceActionButton action="delete" label="Delete manual entry" onClick={() => handleDeleteJournal(voucher.journal_entry_id)} />
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {filteredVouchers.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-4 py-8 text-center text-gray-500">
                    No journal entries found
                  </td>
                </tr>
              )}
            </tbody>
            <tfoot className="bg-gray-50 font-bold">
              <tr>
                <td colSpan={6} className="px-1.5 py-1 text-right">Total:</td>
                <td className="px-1.5 py-1 text-right text-gray-900 border-r">
                  {formatCurrency(totals.debit, 'IDR')}
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
          <div className="space-y-2">
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <span className="text-gray-500">Date:</span>
                <span className="ml-2 font-medium">{new Date(selectedEntry.entry_date).toLocaleDateString('id-ID')}</span>
              </div>
              <div>
                <span className="text-gray-500">Source:</span>
                <span className="ml-2">{sourceLabel(selectedEntry.source_module)}</span>
              </div>
              <div>
                <span className="text-gray-500">Reference:</span>
                <span className="ml-2 font-mono">{selectedEntry.reference_number || '-'}</span>
              </div>
              <div>
                <span className="text-gray-500">Posted:</span>
                <span className="ml-2">{selectedEntry.posted_at ? new Date(selectedEntry.posted_at).toLocaleString('id-ID') : '-'}</span>
              </div>
              <div>
                <span className="text-gray-500">Currency:</span>
                <span className="ml-2 font-medium">{selectedEntry.transaction_currency || 'IDR'} → {selectedEntry.functional_currency || 'IDR'}</span>
              </div>
              <div>
                <span className="text-gray-500">Exchange Rate:</span>
                <span className="ml-2 font-mono">{selectedEntry.exchange_rate || (selectedEntry.transaction_currency === 'IDR' ? 1 : 'Manual review required')}</span>
              </div>
            </div>

            {selectedEntry.description && (
              <div className="p-3 bg-gray-50 rounded-lg text-sm">
                {selectedEntry.description}
              </div>
            )}

            {sourceSummary && (
              <div className="p-3 bg-blue-50 border border-blue-100 rounded-lg text-sm">
                <span className="text-blue-700 font-medium">Source document:</span>{' '}{sourceSummary}
              </div>
            )}

            {selectedEntry.source_module && selectedEntry.reference_id && onOpenSource
              && ['expense','expenses','receipt','payment','petty_cash','fund_transfer','fund_transfers','bank_reconciliation','purchase','purchase_invoice','purchase_invoices','sales','sales_invoice','sales_invoices','sales_invoice_cogs'].includes(selectedEntry.source_module) && (
              <button
                type="button"
                onClick={() => onOpenSource(selectedEntry.source_module || '', selectedEntry.reference_id || '')}
                className="text-sm text-blue-700 hover:underline"
              >
                Open source document
              </button>
            )}

            <div className="border rounded-lg overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-1.5 py-1 text-left">Account</th>
                    <th className="px-1.5 py-1 text-left">Description</th>
                    <th className="px-1.5 py-1 text-right">Debit</th>
                    <th className="px-1.5 py-1 text-right">Credit</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {entryLines.map(line => (
                    <tr key={line.id}>
                      <td className="px-1.5 py-1">
                        <div className="font-mono text-xs text-gray-500">{line.chart_of_accounts?.code}</div>
                        <div>{line.chart_of_accounts?.name}</div>
                        {line.customers && <div className="text-xs text-blue-600">{line.customers.company_name}</div>}
                        {line.suppliers && <div className="text-xs text-orange-600">{line.suppliers.company_name}</div>}
                      </td>
                      <td className="px-1.5 py-1 text-gray-600">{line.description || '-'}</td>
                      <td className="px-1.5 py-1 text-right text-blue-600">
                        {line.debit > 0 ? formatCurrency(line.debit, 'IDR') : ''}
                        {line.transaction_currency && line.transaction_currency !== 'IDR' && Number(line.transaction_debit || 0) > 0 && (
                          <div className="text-[10px]">{formatCurrency(Number(line.transaction_debit), line.transaction_currency)}</div>
                        )}
                      </td>
                      <td className="px-1.5 py-1 text-right text-green-600">
                        {line.credit > 0 ? formatCurrency(line.credit, 'IDR') : ''}
                        {line.transaction_currency && line.transaction_currency !== 'IDR' && Number(line.transaction_credit || 0) > 0 && (
                          <div className="text-[10px]">{formatCurrency(Number(line.transaction_credit), line.transaction_currency)}</div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="bg-gray-50 font-medium">
                  <tr>
                    <td colSpan={2} className="px-1.5 py-1 text-right">Total:</td>
                    <td className="px-1.5 py-1 text-right text-blue-700">
                      {formatCurrency(selectedEntry.total_debit, 'IDR')}
                    </td>
                    <td className="px-1.5 py-1 text-right text-green-700">
                      {formatCurrency(selectedEntry.total_credit, 'IDR')}
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
