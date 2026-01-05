import React, { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';
import { BookOpen, Download, RefreshCw } from 'lucide-react';

interface BankAccount {
  id: string;
  bank_name: string;
  account_number: string;
  currency: string;
  opening_balance: number;
}

interface LedgerEntry {
  id: string;
  entry_date: string;
  particulars: string;
  reference: string;
  debit: number;
  credit: number;
  running_balance: number;
}

interface BankLedgerProps {
  selectedBank?: string;
}

export default function BankLedger({ selectedBank: propSelectedBank }: BankLedgerProps) {
  const [banks, setBanks] = useState<BankAccount[]>([]);
  const [selectedBank, setSelectedBank] = useState<string>('');
  const [ledgerEntries, setLedgerEntries] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedEntry, setSelectedEntry] = useState<any | null>(null);
  const [showDetailModal, setShowDetailModal] = useState(false);
  const [expenseDocuments, setExpenseDocuments] = useState<string[]>([]);
  const [loadingDocs, setLoadingDocs] = useState(false);
  const [dateRange, setDateRange] = useState({
    start: new Date(new Date().getFullYear(), 3, 1).toISOString().split('T')[0],
    end: new Date().toISOString().split('T')[0],
  });
  const [openingBalance, setOpeningBalance] = useState(0);

  useEffect(() => {
    loadBanks();
  }, []);

  useEffect(() => {
    if (propSelectedBank) {
      setSelectedBank(propSelectedBank);
    }
  }, [propSelectedBank]);

  useEffect(() => {
    if (selectedBank) {
      loadLedgerEntries();
    }
  }, [selectedBank, dateRange]);

  useEffect(() => {
    if (showDetailModal && selectedEntry && selectedEntry.type === 'expense') {
      loadExpenseDocuments();
    }
  }, [showDetailModal, selectedEntry]);

  const loadExpenseDocuments = async () => {
    if (!selectedEntry || selectedEntry.type !== 'expense') return;

    setLoadingDocs(true);
    try {
      const { data: files } = await supabase.storage
        .from('expense-documents')
        .list(`${selectedEntry.id}/`);

      if (files && files.length > 0) {
        const publicUrls = files.map(file => {
          const { data } = supabase.storage
            .from('expense-documents')
            .getPublicUrl(`${selectedEntry.id}/${file.name}`);
          return data.publicUrl;
        });
        setExpenseDocuments(publicUrls);
      } else {
        setExpenseDocuments([]);
      }
    } catch (err) {
      console.error('Error loading expense documents:', err);
      setExpenseDocuments([]);
    } finally {
      setLoadingDocs(false);
    }
  };

  const loadBanks = async () => {
    const { data } = await supabase
      .from('bank_accounts')
      .select('*')
      .order('bank_name');
    if (data) setBanks(data);
  };

  const loadLedgerEntries = async () => {
    if (!selectedBank) return;

    setLoading(true);
    try {
      const selectedBankData = banks.find(b => b.id === selectedBank);
      const opening = selectedBankData?.opening_balance || 0;
      setOpeningBalance(opening);

      const entries: any[] = [];

      // Get bank statement lines FIRST (actual bank transactions)
      const { data: bankLines } = await supabase
        .from('bank_statement_lines')
        .select('id, transaction_date, description, reference, debit_amount, credit_amount, matched_expense_id, matched_receipt_id, matched_entry_id, notes')
        .eq('bank_account_id', selectedBank)
        .gte('transaction_date', dateRange.start)
        .lte('transaction_date', dateRange.end)
        .order('transaction_date');

      if (bankLines) {
        bankLines.forEach(line => {
          entries.push({
            id: line.id,
            entry_date: line.transaction_date,
            particulars: line.description || 'Bank Transaction',
            reference: line.reference || '-',
            debit: Number(line.debit_amount || 0),
            credit: Number(line.credit_amount || 0),
            type: 'bank',
            linkedId: line.matched_expense_id || line.matched_receipt_id || line.matched_entry_id,
            notes: line.notes
          });
        });
      }

      // Get receipt vouchers (customer payments - increases bank balance)
      const { data: receipts } = await supabase
        .from('receipt_vouchers')
        .select('id, voucher_date, voucher_number, amount, description, customers(company_name)')
        .gte('voucher_date', dateRange.start)
        .lte('voucher_date', dateRange.end)
        .order('voucher_date');

      if (receipts) {
        receipts.forEach(r => {
          entries.push({
            id: r.id,
            entry_date: r.voucher_date,
            particulars: `Receipt from ${(r.customers as any)?.company_name || 'Customer'}`,
            reference: r.voucher_number,
            debit: 0,
            credit: r.amount,
            type: 'receipt',
            description: r.description,
            customerName: (r.customers as any)?.company_name
          });
        });
      }

      // Get payment vouchers (supplier payments - decreases bank balance)
      const { data: payments } = await supabase
        .from('payment_vouchers')
        .select('id, voucher_date, voucher_number, amount, description, suppliers(company_name)')
        .gte('voucher_date', dateRange.start)
        .lte('voucher_date', dateRange.end)
        .order('voucher_date');

      if (payments) {
        payments.forEach(p => {
          entries.push({
            id: p.id,
            entry_date: p.voucher_date,
            particulars: `Payment to ${(p.suppliers as any)?.company_name || 'Supplier'}`,
            reference: p.voucher_number,
            debit: p.amount,
            credit: 0,
            type: 'payment',
            description: p.description,
            supplierName: (p.suppliers as any)?.company_name
          });
        });
      }

      // Get expenses paid via bank
      const { data: expenses } = await supabase
        .from('finance_expenses')
        .select('id, expense_date, voucher_number, amount, description, expense_category, context_type, context_id')
        .gte('expense_date', dateRange.start)
        .lte('expense_date', dateRange.end)
        .order('expense_date');

      if (expenses) {
        expenses.forEach(e => {
          entries.push({
            id: e.id,
            entry_date: e.expense_date,
            particulars: `Expense - ${e.expense_category || e.description || 'General'}`,
            reference: e.voucher_number || '-',
            debit: e.amount,
            credit: 0,
            type: 'expense',
            description: e.description,
            expenseCategory: e.expense_category,
            contextType: e.context_type,
            contextId: e.context_id
          });
        });
      }

      // Sort by date
      entries.sort((a, b) => new Date(a.entry_date).getTime() - new Date(b.entry_date).getTime());

      let runningBalance = opening;
      const ledger: LedgerEntry[] = entries.map((entry: any) => {
        const debit = entry.debit || 0;
        const credit = entry.credit || 0;

        runningBalance += credit - debit;

        return {
          id: entry.id,
          entry_date: entry.entry_date,
          particulars: entry.particulars,
          reference: entry.reference,
          debit,
          credit,
          running_balance: runningBalance,
        };
      });

      setLedgerEntries(ledger);
    } catch (err) {
      console.error('Error loading ledger:', err);
    } finally {
      setLoading(false);
    }
  };

  const updateOpeningBalance = async (newBalance: number) => {
    if (!selectedBank) return;

    try {
      const { error } = await supabase
        .from('bank_accounts')
        .update({ opening_balance: newBalance })
        .eq('id', selectedBank);

      if (error) throw error;

      await loadBanks();
      await loadLedgerEntries();
    } catch (err: any) {
      alert('Failed to update opening balance: ' + err.message);
    }
  };

  const getCurrencySymbol = (currency: string) => {
    const symbols: Record<string, string> = {
      IDR: 'Rp',
      USD: '$',
      EUR: '€',
    };
    return symbols[currency] || currency;
  };

  const formatAmount = (amount: number, currency: string) => {
    if (amount === 0) return '-';
    return `${getCurrencySymbol(currency)} ${amount.toLocaleString('id-ID', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  };

  const exportToExcel = () => {
    const selectedBankData = banks.find(b => b.id === selectedBank);
    if (!selectedBankData) return;

    const headers = ['Date', 'Particulars', 'Reference', 'Debit (Dr)', 'Credit (Cr)', 'Balance'];
    const rows = ledgerEntries.map(entry => [
      new Date(entry.entry_date).toLocaleDateString('id-ID'),
      entry.particulars,
      entry.reference,
      entry.debit > 0 ? formatAmount(entry.debit, selectedBankData.currency) : '',
      entry.credit > 0 ? formatAmount(entry.credit, selectedBankData.currency) : '',
      formatAmount(entry.running_balance, selectedBankData.currency),
    ]);

    const csv = [
      `Bank Ledger - ${selectedBankData.bank_name} (${selectedBankData.account_number})`,
      `Period: ${new Date(dateRange.start).toLocaleDateString('id-ID')} to ${new Date(dateRange.end).toLocaleDateString('id-ID')}`,
      `Opening Balance: ${formatAmount(openingBalance, selectedBankData.currency)}`,
      '',
      headers.join(','),
      ...rows.map(row => row.join(',')),
    ].join('\n');

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `bank_ledger_${selectedBankData.bank_name}_${new Date().toISOString().split('T')[0]}.csv`;
    link.click();
  };

  const selectedBankData = banks.find(b => b.id === selectedBank);

  const totalDebit = ledgerEntries.reduce((sum, e) => sum + e.debit, 0);
  const totalCredit = ledgerEntries.reduce((sum, e) => sum + e.credit, 0);
  const closingBalance = openingBalance + totalCredit - totalDebit;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <BookOpen className="w-5 h-5 text-blue-600" />
          <h2 className="text-xl font-semibold text-gray-800">Bank Ledger (Bank Book)</h2>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={loadLedgerEntries}
            disabled={!selectedBank || loading}
            className="flex items-center gap-2 px-3 py-1.5 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
          <button
            onClick={exportToExcel}
            disabled={!selectedBank || ledgerEntries.length === 0}
            className="flex items-center gap-2 px-3 py-1.5 bg-green-600 text-white rounded hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Download className="w-4 h-4" />
            Export
          </button>
        </div>
      </div>

      <div className="bg-white rounded-lg shadow-sm p-4">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Bank Account</label>
            <select
              value={selectedBank}
              onChange={(e) => setSelectedBank(e.target.value)}
              className="w-full px-3 py-2 border rounded-lg"
            >
              <option value="">Select Bank Account</option>
              {banks.map(bank => (
                <option key={bank.id} value={bank.id}>
                  {bank.bank_name} - {bank.account_number}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">From Date</label>
            <input
              type="date"
              value={dateRange.start}
              onChange={(e) => setDateRange({ ...dateRange, start: e.target.value })}
              className="w-full px-3 py-2 border rounded-lg"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">To Date</label>
            <input
              type="date"
              value={dateRange.end}
              onChange={(e) => setDateRange({ ...dateRange, end: e.target.value })}
              className="w-full px-3 py-2 border rounded-lg"
            />
          </div>
        </div>

        {selectedBankData && (
          <div className="mb-4 p-3 bg-blue-50 rounded-lg">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-gray-700">Opening Balance</p>
                <p className="text-lg font-bold text-blue-600">
                  {formatAmount(openingBalance, selectedBankData.currency)}
                </p>
              </div>
              <button
                onClick={() => {
                  const newBalance = prompt('Enter new opening balance:', openingBalance.toString());
                  if (newBalance !== null) {
                    const parsed = parseFloat(newBalance);
                    if (!isNaN(parsed)) {
                      updateOpeningBalance(parsed);
                    }
                  }
                }}
                className="px-3 py-1 text-sm bg-blue-600 text-white rounded hover:bg-blue-700"
              >
                Update
              </button>
            </div>
          </div>
        )}
      </div>

      {selectedBank && (
        <div className="bg-white rounded-lg shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-3 py-3 text-left text-xs font-medium text-gray-700 uppercase tracking-wider">
                    Date
                  </th>
                  <th className="px-3 py-3 text-left text-xs font-medium text-gray-700 uppercase tracking-wider">
                    Particulars
                  </th>
                  <th className="px-3 py-3 text-left text-xs font-medium text-gray-700 uppercase tracking-wider">
                    Ref No
                  </th>
                  <th className="px-3 py-3 text-right text-xs font-medium text-gray-700 uppercase tracking-wider">
                    Debit (Dr)
                  </th>
                  <th className="px-3 py-3 text-right text-xs font-medium text-gray-700 uppercase tracking-wider">
                    Credit (Cr)
                  </th>
                  <th className="px-3 py-3 text-right text-xs font-medium text-gray-700 uppercase tracking-wider">
                    Balance
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                <tr className="bg-blue-50 font-semibold">
                  <td className="px-3 py-2 whitespace-nowrap text-sm text-gray-900" colSpan={3}>
                    Opening Balance
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-sm text-gray-900 text-right">-</td>
                  <td className="px-3 py-2 whitespace-nowrap text-sm text-gray-900 text-right">-</td>
                  <td className="px-3 py-2 whitespace-nowrap text-sm text-gray-900 text-right font-bold">
                    {selectedBankData && formatAmount(openingBalance, selectedBankData.currency)}
                  </td>
                </tr>

                {loading ? (
                  <tr>
                    <td colSpan={6} className="px-3 py-8 text-center text-gray-500">
                      Loading entries...
                    </td>
                  </tr>
                ) : ledgerEntries.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-3 py-8 text-center text-gray-500">
                      No recorded transactions found for this period
                    </td>
                  </tr>
                ) : (
                  ledgerEntries.map(entry => (
                    <tr
                      key={entry.id}
                      className="hover:bg-blue-50 cursor-pointer transition-colors"
                      onClick={() => {
                        setSelectedEntry(entry);
                        setShowDetailModal(true);
                      }}
                    >
                      <td className="px-3 py-2 whitespace-nowrap text-sm text-gray-900">
                        {new Date(entry.entry_date).toLocaleDateString('id-ID')}
                      </td>
                      <td className="px-3 py-2 text-sm text-gray-900">
                        {entry.particulars}
                      </td>
                      <td className="px-3 py-2 text-sm text-gray-600 font-mono">
                        {entry.reference}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap text-sm text-red-600 text-right font-medium">
                        {selectedBankData && (entry.debit > 0 ? formatAmount(entry.debit, selectedBankData.currency) : '-')}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap text-sm text-green-600 text-right font-medium">
                        {selectedBankData && (entry.credit > 0 ? formatAmount(entry.credit, selectedBankData.currency) : '-')}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap text-sm text-gray-900 text-right font-semibold">
                        {selectedBankData && formatAmount(entry.running_balance, selectedBankData.currency)}
                      </td>
                    </tr>
                  ))
                )}

                {ledgerEntries.length > 0 && (
                  <tr className="bg-gray-100 font-semibold border-t-2 border-gray-300">
                    <td className="px-3 py-2 whitespace-nowrap text-sm text-gray-900" colSpan={3}>
                      Closing Balance
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap text-sm text-red-600 text-right font-bold">
                      {selectedBankData && formatAmount(totalDebit, selectedBankData.currency)}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap text-sm text-green-600 text-right font-bold">
                      {selectedBankData && formatAmount(totalCredit, selectedBankData.currency)}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap text-sm text-gray-900 text-right font-bold">
                      {selectedBankData && formatAmount(closingBalance, selectedBankData.currency)}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {showDetailModal && selectedEntry && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50" onClick={() => setShowDetailModal(false)}>
          <div className="bg-white rounded-lg p-6 max-w-2xl w-full mx-4 max-h-[80vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-gray-900">Transaction Details</h3>
              <button
                onClick={() => setShowDetailModal(false)}
                className="text-gray-400 hover:text-gray-600"
              >
                <span className="text-2xl">&times;</span>
              </button>
            </div>

            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-sm text-gray-600">Date</p>
                  <p className="font-medium">{new Date(selectedEntry.entry_date).toLocaleDateString('id-ID')}</p>
                </div>
                <div>
                  <p className="text-sm text-gray-600">Reference</p>
                  <p className="font-medium font-mono">{selectedEntry.reference}</p>
                </div>
              </div>

              <div>
                <p className="text-sm text-gray-600">Particulars</p>
                <p className="font-medium">{selectedEntry.particulars}</p>
              </div>

              {selectedEntry.description && (
                <div>
                  <p className="text-sm text-gray-600">Description</p>
                  <p className="font-medium">{selectedEntry.description}</p>
                </div>
              )}

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-sm text-gray-600">Debit</p>
                  <p className="font-medium text-red-600">
                    {selectedBankData && (selectedEntry.debit > 0 ? formatAmount(selectedEntry.debit, selectedBankData.currency) : '-')}
                  </p>
                </div>
                <div>
                  <p className="text-sm text-gray-600">Credit</p>
                  <p className="font-medium text-green-600">
                    {selectedBankData && (selectedEntry.credit > 0 ? formatAmount(selectedEntry.credit, selectedBankData.currency) : '-')}
                  </p>
                </div>
              </div>

              {selectedEntry.type === 'expense' && (
                <>
                  <div>
                    <p className="text-sm text-gray-600">Expense Category</p>
                    <p className="font-medium capitalize">{selectedEntry.expenseCategory?.replace('_', ' ')}</p>
                  </div>

                  {loadingDocs ? (
                    <div className="text-center py-4">
                      <p className="text-sm text-gray-500">Loading documents...</p>
                    </div>
                  ) : expenseDocuments.length > 0 ? (
                    <div>
                      <p className="text-sm text-gray-600 mb-2">Attached Documents ({expenseDocuments.length})</p>
                      <div className="grid grid-cols-2 gap-2">
                        {expenseDocuments.map((url, idx) => (
                          <a
                            key={idx}
                            href={url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="block p-2 border rounded hover:bg-gray-50 text-sm text-blue-600 hover:text-blue-800 truncate"
                          >
                            Document {idx + 1}
                          </a>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <div className="text-center py-2">
                      <p className="text-sm text-gray-400">No documents attached</p>
                    </div>
                  )}
                </>
              )}

              {selectedEntry.type === 'receipt' && selectedEntry.customerName && (
                <div>
                  <p className="text-sm text-gray-600">Customer</p>
                  <p className="font-medium">{selectedEntry.customerName}</p>
                </div>
              )}

              {selectedEntry.type === 'payment' && selectedEntry.supplierName && (
                <div>
                  <p className="text-sm text-gray-600">Supplier</p>
                  <p className="font-medium">{selectedEntry.supplierName}</p>
                </div>
              )}

              {selectedEntry.type === 'bank' && selectedEntry.notes && (
                <div>
                  <p className="text-sm text-gray-600">Notes</p>
                  <p className="font-medium">{selectedEntry.notes}</p>
                </div>
              )}

              {selectedEntry.type === 'bank' && selectedEntry.linkedId && (
                <div className="bg-blue-50 p-3 rounded-lg">
                  <p className="text-sm text-blue-900 font-medium">
                    This transaction is matched to a system entry
                  </p>
                </div>
              )}
            </div>

            <div className="mt-6 flex justify-end">
              <button
                onClick={() => setShowDetailModal(false)}
                className="px-4 py-2 bg-gray-600 text-white rounded hover:bg-gray-700"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
