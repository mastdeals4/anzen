import { useMemo, useState } from 'react';
import { Landmark, Link2, Search } from 'lucide-react';
import { FinanceModal as Modal } from './FinanceModal';
import {
  type BankTransactionLine,
  loadUnmatchedDebitBankTransactions,
} from './bankTransactionLinking';
import { formatCurrency } from '../../utils/currency';

interface BankTransactionLinkFieldProps {
  bankAccountId: string;
  selectedTransactionId?: string;
  linkedTransaction?: BankTransactionLine | null;
  currentExpenseId?: string | null;
  currentJournalEntryId?: string | null;
  currentPettyCashId?: string | null;
  disabled?: boolean;
  disabledMessage?: string;
  canUnlink?: boolean;
  onSelect: (transaction: BankTransactionLine) => void | Promise<void>;
  onUnlink?: () => void | Promise<void>;
  direction?: 'debit' | 'credit' | 'both';
  candidateFilter?: (line: BankTransactionLine) => boolean;
  autoSelectSingle?: boolean;
  /** Used only to rank available candidates; it never excludes history. */
  documentDate?: string;
  documentOutstanding?: number;
  documentLabel?: string;
}

function formatAmount(line: BankTransactionLine) {
  const currency = line.bank_accounts?.currency || 'IDR';
  const amount = Number(line.debit_amount || line.credit_amount || 0);
  return formatCurrency(amount, currency);
}

function bankLabel(line: BankTransactionLine) {
  const bank = line.bank_accounts;
  return bank?.alias || bank?.bank_name || bank?.account_name || 'Bank';
}

export function BankTransactionLinkField({
  bankAccountId,
  selectedTransactionId = '',
  linkedTransaction,
  currentExpenseId,
  currentJournalEntryId,
  currentPettyCashId,
  disabled = false,
  disabledMessage,
  onSelect,
  direction = 'debit',
  candidateFilter,
  autoSelectSingle = false,
  documentDate,
  documentOutstanding,
  documentLabel = 'this document',
}: BankTransactionLinkFieldProps) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [transactions, setTransactions] = useState<BankTransactionLine[]>([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [loading, setLoading] = useState(false);
  const [submittingId, setSubmittingId] = useState<string | null>(null);
  const [pendingTransaction, setPendingTransaction] = useState<BankTransactionLine | null>(null);

  const rankedTransactions = useMemo(() => {
    const documentDay = documentDate ? new Date(`${documentDate.slice(0, 10)}T00:00:00`).getTime() : NaN;
    const documentAmount = Math.max(0, Number(documentOutstanding || 0));
    const documentText = documentLabel.trim().toLowerCase();

    return [...transactions].sort((left, right) => {
      const dateDistance = (line: BankTransactionLine) => Number.isFinite(documentDay)
        ? Math.abs(new Date(`${line.transaction_date.slice(0, 10)}T00:00:00`).getTime() - documentDay)
        : 0;
      const amountDistance = (line: BankTransactionLine) => Math.abs(
        Number(line.remainingAmount ?? line.debit_amount ?? line.credit_amount ?? 0) - documentAmount,
      );
      const textDistance = (line: BankTransactionLine) => {
        if (!documentText) return 0;
        const lineText = [line.description, line.reference, bankLabel(line)].filter(Boolean).join(' ').toLowerCase();
        return lineText.includes(documentText) ? 0 : 1;
      };

      return dateDistance(left) - dateDistance(right)
        || amountDistance(left) - amountDistance(right)
        || textDistance(left) - textDistance(right)
        || right.transaction_date.localeCompare(left.transaction_date);
    });
  }, [transactions, documentDate, documentOutstanding, documentLabel]);

  const filteredTransactions = useMemo(() => {
    const query = searchTerm.trim().toLowerCase();
    const candidates = candidateFilter ? rankedTransactions.filter(candidateFilter) : rankedTransactions;
    // Keep the initial picker focused. A search deliberately operates over
    // every available bank line, so older available history stays reachable.
    if (!query) return candidates.slice(0, 12);

    return candidates.filter((line) => [
      line.transaction_date,
      line.description,
      line.reference,
      bankLabel(line),
      String(line.debit_amount),
    ].some((value) => value?.toLowerCase().includes(query)));
  }, [searchTerm, rankedTransactions, candidateFilter]);

  const loadTransactions = async (open = false) => {
    if (!bankAccountId || disabled) return;
    if (open) setDialogOpen(true);
    setLoading(true);
    try {
        const rows = await loadUnmatchedDebitBankTransactions({
          bankAccountId,
          direction,
        currentExpenseId,
        currentJournalEntryId,
        currentPettyCashId,
        includeLinked: false,
      });
      const candidates = candidateFilter ? rows.filter(candidateFilter) : rows;
      setTransactions(rows);
      if (autoSelectSingle && candidates.length === 1) await handleSelect(candidates[0]);
    } catch (error) {
      console.error('Error loading unmatched bank transactions:', error);
      alert('Failed to load unmatched bank transactions.');
      setDialogOpen(false);
    } finally {
      setLoading(false);
    }
  };

  const openDialog = async () => loadTransactions(true);

  const handleSelect = async (transaction: BankTransactionLine) => {
    if (documentOutstanding !== undefined) {
      setPendingTransaction(transaction);
      return;
    }
    await commitSelect(transaction);
  };

  const commitSelect = async (transaction: BankTransactionLine) => {
    setSubmittingId(transaction.id);
    try {
      await onSelect(transaction);
      setDialogOpen(false);
      setSearchTerm('');
    } finally {
      setSubmittingId(null);
    }
  };

  const pendingBankTotal = Number(pendingTransaction?.debit_amount || pendingTransaction?.credit_amount || 0);
  const pendingAlreadyAllocated = Number(pendingTransaction?.allocatedAmount || 0);
  const pendingBankRemaining = Number(pendingTransaction?.remainingAmount ?? pendingBankTotal);
  const pendingDocumentOutstanding = Math.max(0, Number(documentOutstanding || 0));
  const pendingAllocation = Math.min(pendingBankRemaining, pendingDocumentOutstanding);
  const pendingBankAfter = Math.max(0, pendingBankRemaining - pendingAllocation);
  const pendingDocumentAfter = Math.max(0, pendingDocumentOutstanding - pendingAllocation);
  const hasReferenceColumn = filteredTransactions.some((line) => Boolean(line.reference?.trim()));

  if (linkedTransaction) {
    return (
      <div>
        <label className="block text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-0.5">
          Link Bank Transaction
        </label>
        <div className="p-2 bg-green-50 border border-green-300 rounded">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="flex items-center gap-1 text-xs font-semibold text-green-900">
                <Landmark className="w-3 h-3" />
                Linked Bank Transaction
              </div>
              <div className="text-[10px] text-gray-600 truncate mt-0.5">
                {new Date(linkedTransaction.transaction_date).toLocaleDateString('id-ID')}
                {' · '}{formatAmount(linkedTransaction)}
                {' · '}{linkedTransaction.description || 'No narration'}
                {linkedTransaction.reference ? ` · ${linkedTransaction.reference}` : ''}
                {' · '}{bankLabel(linkedTransaction)}
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <label className="block text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-0.5">
        Link Bank Transaction
      </label>
      <button
        type="button"
        onClick={() => void openDialog()}
        disabled={!bankAccountId || disabled}
        className="w-full px-2.5 py-1.5 border border-gray-300 rounded text-xs text-left bg-white hover:bg-gray-50 disabled:bg-gray-50 disabled:text-gray-400 disabled:cursor-not-allowed flex items-center justify-between gap-2"
      >
        <span className="flex items-center gap-1.5 truncate">
          <Link2 className="w-3 h-3 shrink-0" />
          {selectedTransactionId ? 'Bank transaction selected' : 'Choose unmatched bank transaction'}
        </span>
        <Search className="w-3 h-3 shrink-0" />
      </button>
      {disabled && disabledMessage && (
        <p className="mt-0.5 text-[10px] text-amber-700">{disabledMessage}</p>
      )}

      <Modal
        isOpen={dialogOpen}
        onClose={() => { setDialogOpen(false); setSearchTerm(''); }}
        title="Link Bank Transaction"
        size="xl"
      >
        <div className="space-y-3">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
            <input
              autoFocus
              type="search"
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
              placeholder="Search date, amount, narration, reference, or bank..."
              className="w-full h-8 pl-8 pr-3 text-xs border border-gray-300 rounded focus:outline-none focus:border-blue-400"
            />
          </div>
          <div className="border border-gray-200 rounded overflow-hidden">
            <div className="max-h-[50vh] overflow-auto">
              <table className="w-full text-xs">
                <thead className="bg-gray-50 sticky top-0 z-10">
                  <tr>
                    <th className="px-3 py-2 text-left font-semibold text-gray-600">Date</th>
                    <th className="px-3 py-2 text-right font-semibold text-gray-600">Amount</th>
                    <th className="px-3 py-2 text-left font-semibold text-gray-600">Currency</th>
                    <th className="px-3 py-2 text-left font-semibold text-gray-600">Direction</th>
                    <th className="px-3 py-2 text-left font-semibold text-gray-600">Narration</th>
                    {hasReferenceColumn && <th className="px-3 py-2 text-left font-semibold text-gray-600">Reference</th>}
                    <th className="px-3 py-2 text-left font-semibold text-gray-600">Bank</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {loading ? (
                    <tr><td colSpan={hasReferenceColumn ? 7 : 6} className="px-3 py-8 text-center text-gray-400">Loading transactions...</td></tr>
                  ) : filteredTransactions.length === 0 ? (
                    <tr><td colSpan={hasReferenceColumn ? 7 : 6} className="px-3 py-8 text-center text-gray-400">No matching bank transactions found</td></tr>
                  ) : filteredTransactions.map((line) => (
                    <tr
                      key={line.id}
                      onClick={() => { if (!line.isLinked) void handleSelect(line); }}
                      className={`${line.isLinked ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer hover:bg-blue-50'} ${selectedTransactionId === line.id ? 'bg-blue-50' : ''}`}
                    >
                      <td className="px-3 py-2 whitespace-nowrap">{new Date(line.transaction_date).toLocaleDateString('id-ID')}</td>
                      <td className="px-3 py-2 text-right font-mono font-semibold text-red-700 whitespace-nowrap">
                        <div>{formatAmount(line)}</div>
                        {Number(line.allocatedAmount || 0) > 0 && (
                          <div className="mt-0.5 text-[10px] font-medium text-amber-700">
                            Remaining: {formatCurrency(Number(line.remainingAmount || 0), line.bank_accounts?.currency || 'IDR')}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2">{line.bank_accounts?.currency || '—'}</td>
                      <td className="px-3 py-2">{line.debit_amount > 0 ? 'Money out' : 'Money in'}</td>
                      <td className="px-3 py-2 text-gray-700 min-w-[220px]">{line.description || '—'}</td>
                      {hasReferenceColumn && <td className="px-3 py-2 text-gray-600 font-mono">{line.reference?.trim() || ''}</td>}
                      <td className="px-3 py-2 text-gray-700 whitespace-nowrap">
                        {bankLabel(line)}
                        {submittingId === line.id && <span className="ml-1 text-blue-600">Linking...</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </Modal>

      <Modal
        isOpen={!!pendingTransaction}
        onClose={() => setPendingTransaction(null)}
        title={pendingBankAfter > 0.01 || pendingDocumentAfter > 0.01 ? 'Confirm Partial Reconciliation' : 'Confirm Reconciliation'}
        size="sm"
        footer={<>
          <button type="button" onClick={() => setPendingTransaction(null)} className="px-3 py-2 text-xs border border-gray-300 rounded hover:bg-gray-50">Cancel</button>
          <button type="button" onClick={() => {
            if (!pendingTransaction) return;
            const selected = pendingTransaction;
            setPendingTransaction(null);
            void commitSelect(selected);
          }} disabled={pendingAllocation <= 0.01} className="px-3 py-2 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50">
            {pendingBankAfter > 0.01 || pendingDocumentAfter > 0.01
              ? `Yes, Link ${formatCurrency(pendingAllocation, pendingTransaction?.bank_accounts?.currency || 'IDR')}`
              : 'Yes, Link'}
          </button>
        </>}
      >
        <div className="space-y-3 text-sm">
          <div className="grid grid-cols-2 gap-x-4 gap-y-2 p-3 bg-gray-50 border rounded">
            <span className="text-gray-500">Bank transaction</span><span className="text-right font-semibold">{formatCurrency(pendingBankTotal, pendingTransaction?.bank_accounts?.currency || 'IDR')}</span>
            <span className="text-gray-500">Already allocated</span><span className="text-right">{formatCurrency(pendingAlreadyAllocated, pendingTransaction?.bank_accounts?.currency || 'IDR')}</span>
            <span className="text-gray-500">{documentLabel} outstanding</span><span className="text-right">{formatCurrency(pendingDocumentOutstanding, pendingTransaction?.bank_accounts?.currency || 'IDR')}</span>
            <span className="font-medium">Amount to link</span><span className="text-right font-bold text-blue-700">{formatCurrency(pendingAllocation, pendingTransaction?.bank_accounts?.currency || 'IDR')}</span>
            <span className="text-gray-500">Remaining bank balance</span><span className="text-right">{formatCurrency(pendingBankAfter, pendingTransaction?.bank_accounts?.currency || 'IDR')}</span>
            <span className="text-gray-500">Document remaining</span><span className="text-right">{formatCurrency(pendingDocumentAfter, pendingTransaction?.bank_accounts?.currency || 'IDR')}</span>
          </div>
          {(pendingBankAfter > 0.01 || pendingDocumentAfter > 0.01) && (
            <p className="text-amber-800 bg-amber-50 border border-amber-200 rounded p-3">
              You are linking {formatCurrency(pendingAllocation, pendingTransaction?.bank_accounts?.currency || 'IDR')} to this document.
              {pendingBankAfter > 0.01 && ` ${formatCurrency(pendingBankAfter, pendingTransaction?.bank_accounts?.currency || 'IDR')} will remain unreconciled and available for another document.`}
              {pendingDocumentAfter > 0.01 && ` ${formatCurrency(pendingDocumentAfter, pendingTransaction?.bank_accounts?.currency || 'IDR')} will remain outstanding on the document.`}
            </p>
          )}
        </div>
      </Modal>
    </div>
  );
}
