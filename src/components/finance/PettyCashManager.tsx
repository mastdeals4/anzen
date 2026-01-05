import { useEffect, useState, useCallback } from 'react';
import { supabase } from '../../lib/supabase';
import { Plus, Wallet, ArrowDownCircle, ArrowUpCircle, RefreshCw, Upload, X, FileText, Image, ArrowRightLeft } from 'lucide-react';
import { Modal } from '../Modal';

interface PettyCashTransaction {
  id: string;
  transaction_number: string;
  transaction_date: string;
  transaction_type: 'withdraw' | 'expense';
  amount: number;
  description: string;
  expense_category: string | null;
  bank_account_id: string | null;
  paid_to: string | null;
  paid_by_staff_id: string | null;
  paid_by_staff_name: string | null;
  source: string | null;
  received_by_staff_id: string | null;
  received_by_staff_name: string | null;
  finance_expense_id: string | null;
  bank_accounts?: { account_name: string; bank_name: string } | null;
  finance_expenses?: { expense_category: string } | null;
  created_at: string;
}

interface BankAccount {
  id: string;
  account_name: string;
  bank_name: string;
  alias: string | null;
}

interface BankStatementLine {
  id: string;
  transaction_date: string;
  description: string | null;
  reference: string | null;
  debit_amount: number | null;
  credit_amount: number | null;
  running_balance: number | null;
  reconciliation_status: string | null;
}


interface PettyCashManagerProps {
  canManage: boolean;
}

const expenseCategories = [
  'Office Supplies',
  'Transportation',
  'Meals & Entertainment',
  'Postage & Courier',
  'Cleaning & Maintenance',
  'Utilities',
  'Miscellaneous',
];

// Map petty cash categories to finance_expenses valid categories
const mapPettyCashCategoryToFinance = (category: string): string => {
  const mapping: { [key: string]: string } = {
    'Office Supplies': 'office_admin',
    'Transportation': 'other',
    'Meals & Entertainment': 'other',
    'Postage & Courier': 'other',
    'Cleaning & Maintenance': 'other',
    'Utilities': 'utilities',
    'Miscellaneous': 'other',
  };
  return mapping[category] || 'other';
};

const fundSources = [
  'Cash from Office',
  'Bank Transfer',
  'Bank Withdrawal',
  'Cheque Encashment',
  'Other',
];

export function PettyCashManager({ canManage }: PettyCashManagerProps) {
  const [transactions, setTransactions] = useState<PettyCashTransaction[]>([]);
  const [bankAccounts, setBankAccounts] = useState<BankAccount[]>([]);
  const [bankStatementLines, setBankStatementLines] = useState<BankStatementLine[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [cashBalance, setCashBalance] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [uploadingFiles, setUploadingFiles] = useState<{file: File, type: string}[]>([]);
  const [sortConfig, setSortConfig] = useState<{ key: string; direction: 'asc' | 'desc' } | null>(null);

  const [formData, setFormData] = useState({
    transaction_type: 'expense' as 'withdraw' | 'expense',
    transaction_date: new Date().toISOString().split('T')[0],
    amount: 0,
    description: '',
    expense_category: '',
    bank_account_id: '',
    bank_statement_line_id: '',
    paid_to: '',
    paid_by_staff_name: '',
    paid_by: 'cash' as 'cash' | 'bank',
    source: '',
    received_by_staff_name: '',
  });

  const loadData = useCallback(async () => {
    try {
      const [txRes, bankRes, balanceRes] = await Promise.all([
        supabase
          .from('petty_cash_transactions')
          .select(`
            *,
            bank_accounts(account_name, bank_name),
            finance_expenses!finance_expense_id(expense_category)
          `)
          .order('transaction_date', { ascending: false })
          .order('created_at', { ascending: false })
          .limit(100),
        supabase
          .from('bank_accounts')
          .select('id, account_name, bank_name, alias')
          .eq('is_active', true)
          .order('account_name'),
        supabase
          .from('petty_cash_transactions')
          .select('transaction_type, amount'),
      ]);

      if (txRes.error) throw txRes.error;
      if (bankRes.error) throw bankRes.error;

      setTransactions(txRes.data || []);
      setBankAccounts(bankRes.data || []);

      if (balanceRes.error) {
        console.error('Error fetching balance data:', balanceRes.error);
      } else {
        const allTransactions = balanceRes.data || [];
        const balance = allTransactions.reduce((sum, tx) => {
          if (tx.transaction_type === 'withdraw') {
            return sum + Number(tx.amount);
          } else {
            return sum - Number(tx.amount);
          }
        }, 0);
        setCashBalance(balance);
      }
    } catch (error) {
      console.error('Error loading petty cash:', error);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 30000);
    return () => clearInterval(interval);
  }, [loadData]);

  const handleRefresh = () => {
    setRefreshing(true);
    loadData();
  };

  const loadBankStatementLines = async (bankAccountId: string) => {
    if (!bankAccountId) {
      setBankStatementLines([]);
      return;
    }

    try {
      const { data, error } = await supabase
        .from('bank_statement_lines')
        .select('id, transaction_date, description, reference, debit_amount, credit_amount, running_balance, reconciliation_status')
        .eq('bank_account_id', bankAccountId)
        .is('matched_entry_id', null)
        .is('matched_expense_id', null)
        .is('matched_receipt_id', null)
        .order('transaction_date', { ascending: false })
        .limit(50);

      if (error) throw error;
      setBankStatementLines(data || []);
    } catch (error) {
      console.error('Error loading bank statement lines:', error);
      setBankStatementLines([]);
    }
  };

  const generateTransactionNumber = async (type: 'withdraw' | 'expense') => {
    const prefix = type === 'withdraw' ? 'PCW' : 'PCE';
    const year = new Date().getFullYear().toString().slice(-2);
    const month = (new Date().getMonth() + 1).toString().padStart(2, '0');
    const { count } = await supabase
      .from('petty_cash_transactions')
      .select('*', { count: 'exact', head: true })
      .like('transaction_number', `${prefix}${year}${month}%`);
    
    return `${prefix}${year}${month}-${String((count || 0) + 1).padStart(4, '0')}`;
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>, fileType: string) => {
    if (e.target.files) {
      const newFiles = Array.from(e.target.files).map(file => ({ file, type: fileType }));
      setUploadingFiles(prev => [...prev, ...newFiles]);
    }
  };

  const removeFile = (index: number) => {
    setUploadingFiles(prev => prev.filter((_, i) => i !== index));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (formData.amount <= 0) {
      alert('Amount must be greater than 0');
      return;
    }

    if (formData.transaction_type === 'expense' && formData.paid_by === 'cash' && formData.amount > cashBalance) {
      alert('Insufficient cash balance. Please add funds first.');
      return;
    }

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      // If expense is paid by bank, create finance_expense instead
      if (formData.transaction_type === 'expense' && formData.paid_by === 'bank') {
        // Map petty cash category to valid finance_expenses category
        const mappedCategory = mapPettyCashCategoryToFinance(formData.expense_category || 'Miscellaneous');

        const expenseData = {
          expense_category: mappedCategory,
          expense_type: 'admin',
          amount: formData.amount,
          expense_date: formData.transaction_date,
          description: `${formData.description} (Paid to: ${formData.paid_to}, Category: ${formData.expense_category || 'Miscellaneous'})`,
          payment_method: 'bank_transfer',
          bank_account_id: formData.bank_account_id || null,
          paid_by: 'bank',
          created_by: user.id,
        };

        const { error: expenseError } = await supabase
          .from('finance_expenses')
          .insert([expenseData]);

        if (expenseError) throw expenseError;

        alert('Expense moved to Expense Tracker for Bank Reconciliation');
        setModalOpen(false);
        resetForm();
        loadData();
        return;
      }

      // Otherwise, create petty cash transaction as normal
      const transactionNumber = await generateTransactionNumber(formData.transaction_type);

      const payload: any = {
        transaction_number: transactionNumber,
        transaction_date: formData.transaction_date,
        transaction_type: formData.transaction_type,
        amount: formData.amount,
        description: formData.description,
        paid_by: formData.paid_by,
        created_by: user.id,
      };

      if (formData.transaction_type === 'expense') {
        payload.expense_category = formData.expense_category || null;
        payload.paid_to = formData.paid_to || null;
        payload.paid_by_staff_name = formData.paid_by_staff_name || null;
      } else {
        payload.bank_account_id = formData.bank_account_id || null;
        payload.source = formData.source || null;
        payload.received_by_staff_name = formData.received_by_staff_name || null;
      }

      const { data: transaction, error } = await supabase
        .from('petty_cash_transactions')
        .insert([payload])
        .select()
        .single();

      if (error) throw error;

      // Link to bank statement line if selected (for withdrawals)
      if (formData.transaction_type === 'withdraw' && formData.bank_statement_line_id && transaction) {
        const { error: linkError } = await supabase
          .from('bank_statement_lines')
          .update({
            matched_entry_id: transaction.id,
            reconciliation_status: 'matched',
            matched_at: new Date().toISOString(),
            matched_by: user.id,
            notes: `Linked to Petty Cash Withdrawal ${transaction.transaction_number}`
          })
          .eq('id', formData.bank_statement_line_id);

        if (linkError) {
          console.error('Error linking bank statement:', linkError);
        }
      }

      // Upload files if any
      if (uploadingFiles.length > 0 && transaction) {
        for (const { file, type } of uploadingFiles) {
          const fileExt = file.name.split('.').pop();
          const fileName = `${transaction.id}/${Date.now()}_${type}.${fileExt}`;
          
          const { error: uploadError } = await supabase.storage
            .from('petty-cash-receipts')
            .upload(fileName, file);

          if (!uploadError) {
            const { data: urlData } = supabase.storage
              .from('petty-cash-receipts')
              .getPublicUrl(fileName);

            if (urlData) {
              await supabase.from('petty_cash_documents').insert({
                petty_cash_transaction_id: transaction.id,
                file_type: type,
                file_name: file.name,
                file_url: urlData.publicUrl,
                file_size: file.size,
                uploaded_by: user.id,
              });
            }
          }
        }
      }

      setModalOpen(false);
      resetForm();
      loadData();
    } catch (error: any) {
      console.error('Error saving transaction:', error);
      alert('Failed to save: ' + error.message);
    }
  };

  const handleMoveToTracker = async (pettyCashId: string, bankAccountId: string | null) => {
    if (!bankAccountId) {
      alert('Please select a bank account to move this expense to the tracker');
      return;
    }

    if (!confirm('Move this expense to Expense Tracker? This will allow it to be reconciled with bank statements.')) return;

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const { data, error } = await supabase.rpc('move_expense_to_tracker', {
        p_petty_cash_id: pettyCashId,
        p_bank_account_id: bankAccountId,
        p_payment_method: 'bank_transfer',
        p_user_id: user.id
      });

      if (error) throw error;

      alert('Expense moved to Expense Tracker successfully!');
      loadData();
    } catch (error: any) {
      console.error('Error moving expense:', error.message);
      alert('Failed to move expense: ' + error.message);
    }
  };

  const resetForm = () => {
    setFormData({
      transaction_type: 'expense',
      transaction_date: new Date().toISOString().split('T')[0],
      amount: 0,
      description: '',
      expense_category: '',
      bank_account_id: '',
      bank_statement_line_id: '',
      paid_to: '',
      paid_by_staff_name: '',
      paid_by: 'cash',
      source: '',
      received_by_staff_name: '',
    });
    setUploadingFiles([]);
    setBankStatementLines([]);
  };

  if (loading) {
    return <div className="flex justify-center py-8"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div></div>;
  }

  return (
    <div className="space-y-6">
      {/* Cash Balance Card */}
      <div className="bg-gradient-to-r from-green-500 to-green-600 rounded-xl p-6 text-white shadow-lg">
        <div className="flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2 mb-2">
              <Wallet className="w-6 h-6" />
              <span className="text-green-100 font-medium">Petty Cash Balance</span>
            </div>
            <div className="text-4xl font-bold">
              Rp {cashBalance.toLocaleString('id-ID')}
            </div>
            <p className="text-green-100 text-sm mt-2">
              Available for cash expenses
            </p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={handleRefresh}
              disabled={refreshing}
              className="p-2 bg-white/20 rounded-lg hover:bg-white/30 transition"
              title="Refresh"
            >
              <RefreshCw className={`w-5 h-5 ${refreshing ? 'animate-spin' : ''}`} />
            </button>
            {canManage && (
              <button
                onClick={() => setModalOpen(true)}
                className="flex items-center gap-2 bg-white text-green-600 px-4 py-2 rounded-lg hover:bg-green-50 font-medium transition"
              >
                <Plus className="w-5 h-5" />
                New Entry
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Quick Stats */}
      <div className="grid grid-cols-2 gap-4">
        <div className="bg-white rounded-lg p-4 border border-gray-200">
          <div className="flex items-center gap-2 text-blue-600 mb-2">
            <ArrowDownCircle className="w-5 h-5" />
            <span className="font-medium">Funds Added</span>
          </div>
          <div className="text-2xl font-bold text-gray-900">
            Rp {transactions
              .filter(t => t.transaction_type === 'withdraw')
              .reduce((sum, t) => sum + t.amount, 0)
              .toLocaleString('id-ID')}
          </div>
          <p className="text-sm text-gray-500">Total withdrawn from bank</p>
        </div>
        <div className="bg-white rounded-lg p-4 border border-gray-200">
          <div className="flex items-center gap-2 text-red-600 mb-2">
            <ArrowUpCircle className="w-5 h-5" />
            <span className="font-medium">Expenses Paid</span>
          </div>
          <div className="text-2xl font-bold text-gray-900">
            Rp {transactions
              .filter(t => t.transaction_type === 'expense')
              .reduce((sum, t) => sum + t.amount, 0)
              .toLocaleString('id-ID')}
          </div>
          <p className="text-sm text-gray-500">Total spent from petty cash</p>
        </div>
      </div>

      {/* Transactions Table */}
      <div className="bg-white rounded-lg shadow overflow-hidden">
        <div className="p-4 border-b bg-gray-50">
          <h3 className="font-semibold text-gray-900">Recent Transactions</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-50">
              <tr>
                <th onClick={() => { let dir: 'asc' | 'desc' = 'asc'; if (sortConfig?.key === 'transaction_date' && sortConfig.direction === 'asc') dir = 'desc'; setSortConfig({ key: 'transaction_date', direction: dir }); }} className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase cursor-pointer hover:bg-gray-100 select-none"><div className="flex items-center gap-1">Date{sortConfig?.key === 'transaction_date' && <span className="text-blue-600">{sortConfig.direction === 'asc' ? '↑' : '↓'}</span>}</div></th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Txn No</th>
                <th onClick={() => { let dir: 'asc' | 'desc' = 'asc'; if (sortConfig?.key === 'transaction_type' && sortConfig.direction === 'asc') dir = 'desc'; setSortConfig({ key: 'transaction_type', direction: dir }); }} className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase cursor-pointer hover:bg-gray-100 select-none"><div className="flex items-center gap-1">Type{sortConfig?.key === 'transaction_type' && <span className="text-blue-600">{sortConfig.direction === 'asc' ? '↑' : '↓'}</span>}</div></th>
                <th onClick={() => { let dir: 'asc' | 'desc' = 'asc'; if (sortConfig?.key === 'description' && sortConfig.direction === 'asc') dir = 'desc'; setSortConfig({ key: 'description', direction: dir }); }} className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase cursor-pointer hover:bg-gray-100 select-none"><div className="flex items-center gap-1">Description{sortConfig?.key === 'description' && <span className="text-blue-600">{sortConfig.direction === 'asc' ? '↑' : '↓'}</span>}</div></th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Paid To / Source</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Staff</th>
                <th onClick={() => { let dir: 'asc' | 'desc' = 'asc'; if (sortConfig?.key === 'amount' && sortConfig.direction === 'asc') dir = 'desc'; setSortConfig({ key: 'amount', direction: dir }); }} className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase cursor-pointer hover:bg-gray-100 select-none"><div className="flex items-center justify-end gap-1">Debit (In){sortConfig?.key === 'amount' && <span className="text-blue-600">{sortConfig.direction === 'asc' ? '↑' : '↓'}</span>}</div></th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Credit (Out)</th>
                {canManage && <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase">Actions</th>}
              </tr>
            </thead>
            <tbody className="divide-y">
              {[...transactions].sort((a, b) => { if (!sortConfig) return 0; const { key, direction } = sortConfig; let aVal: any = a[key as keyof PettyCashTransaction]; let bVal: any = b[key as keyof PettyCashTransaction]; if (key === 'transaction_date') { aVal = new Date(aVal).getTime(); bVal = new Date(bVal).getTime(); } else if (key === 'amount') { aVal = Number(aVal) || 0; bVal = Number(bVal) || 0; } else if (typeof aVal === 'string') { aVal = aVal.toLowerCase(); bVal = bVal.toLowerCase(); } if (aVal < bVal) return direction === 'asc' ? -1 : 1; if (aVal > bVal) return direction === 'asc' ? 1 : -1; return 0; }).map(tx => (
                <tr key={tx.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 text-sm">
                    {new Date(tx.transaction_date).toLocaleDateString('id-ID')}
                  </td>
                  <td className="px-4 py-3 font-mono text-sm">{tx.transaction_number}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-medium ${
                      tx.transaction_type === 'withdraw' 
                        ? 'bg-blue-100 text-blue-700' 
                        : 'bg-red-100 text-red-700'
                    }`}>
                      {tx.transaction_type === 'withdraw' ? (
                        <>
                          <ArrowDownCircle className="w-3 h-3" />
                          Add Funds
                        </>
                      ) : (
                        <>
                          <ArrowUpCircle className="w-3 h-3" />
                          Expense
                        </>
                      )}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-sm">
                    <div>{tx.description}</div>
                    {tx.expense_category && (
                      <span className="text-xs text-gray-500">{tx.expense_category}</span>
                    )}
                    {tx.finance_expense_id && tx.finance_expenses && (
                      <div className="mt-1">
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-blue-50 border border-blue-200 rounded text-xs text-blue-700">
                          🔗 Linked to Expense Tracker
                        </span>
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-600">
                    {tx.transaction_type === 'expense' ? tx.paid_to : tx.source}
                    {tx.bank_accounts && (
                      <span className="text-xs block text-gray-400">
                        {tx.bank_accounts.account_name}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-600">
                    {tx.transaction_type === 'expense' 
                      ? tx.paid_by_staff_name 
                      : tx.received_by_staff_name}
                  </td>
                  <td className="px-4 py-3 text-right font-medium text-blue-600">
                    {tx.transaction_type === 'withdraw' ? `Rp ${tx.amount.toLocaleString('id-ID')}` : '-'}
                  </td>
                  <td className="px-4 py-3 text-right font-medium text-red-600">
                    {tx.transaction_type === 'expense' ? `Rp ${tx.amount.toLocaleString('id-ID')}` : '-'}
                  </td>
                  {canManage && (
                    <td className="px-4 py-3 text-center">
                      {tx.transaction_type === 'expense' && !tx.finance_expense_id && (
                        <button
                          onClick={() => {
                            const bankId = prompt('Enter Bank Account ID for reconciliation (select from dropdown in production):\n\nNote: In a real scenario, this would be a modal with a dropdown of bank accounts.');
                            if (bankId) {
                              handleMoveToTracker(tx.id, bankId);
                            }
                          }}
                          className="text-blue-600 hover:text-blue-800 inline-flex items-center gap-1 text-sm"
                          title="Move to Expense Tracker"
                        >
                          <ArrowRightLeft className="w-4 h-4" />
                          <span>Move</span>
                        </button>
                      )}
                      {tx.finance_expense_id && (
                        <span className="text-xs text-gray-400">Linked</span>
                      )}
                    </td>
                  )}
                </tr>
              ))}
              {transactions.length === 0 && (
                <tr>
                  <td colSpan={canManage ? 9 : 8} className="px-4 py-12 text-center text-gray-500">
                    <Wallet className="w-12 h-12 mx-auto mb-3 text-gray-300" />
                    <p className="font-medium">No transactions yet</p>
                    <p className="text-sm mt-1">Click "New Entry" to add funds or record an expense</p>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Add Transaction Modal */}
      <Modal isOpen={modalOpen} onClose={() => { setModalOpen(false); resetForm(); }} title="Petty Cash Entry" size="lg">
        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Transaction Type Tabs */}
          <div className="flex gap-2 p-1 bg-gray-100 rounded-lg">
            <button
              type="button"
              onClick={() => setFormData({ ...formData, transaction_type: 'withdraw' })}
              className={`flex-1 flex items-center justify-center gap-2 py-3 px-4 rounded-md transition ${
                formData.transaction_type === 'withdraw'
                  ? 'bg-green-600 text-white shadow'
                  : 'text-gray-600 hover:bg-gray-200'
              }`}
            >
              <ArrowDownCircle className="w-5 h-5" />
              Add Funds (Income)
            </button>
            <button
              type="button"
              onClick={() => setFormData({ ...formData, transaction_type: 'expense' })}
              className={`flex-1 flex items-center justify-center gap-2 py-3 px-4 rounded-md transition ${
                formData.transaction_type === 'expense'
                  ? 'bg-orange-600 text-white shadow'
                  : 'text-gray-600 hover:bg-gray-200'
              }`}
            >
              <ArrowUpCircle className="w-5 h-5" />
              Add Expense
            </button>
          </div>

          {formData.transaction_type === 'withdraw' ? (
            /* Add Funds Form */
            <div className="bg-green-50 border border-green-200 rounded-lg p-4">
              <p className="text-sm text-green-700 mb-4">Add money to petty cash fund</p>
              
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Amount (Rp) *</label>
                  <input
                    type="number"
                    required
                    min="1"
                    value={formData.amount || ''}
                    onChange={(e) => setFormData({ ...formData, amount: parseFloat(e.target.value) || 0 })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500"
                    placeholder="5000000"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Date *</label>
                  <input
                    type="date"
                    required
                    value={formData.transaction_date}
                    onChange={(e) => setFormData({ ...formData, transaction_date: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Source *</label>
                  <select
                    required
                    value={formData.source}
                    onChange={(e) => setFormData({ ...formData, source: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500"
                  >
                    <option value="">Select source</option>
                    {fundSources.map(src => (
                      <option key={src} value={src}>{src}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Received By (Staff) *</label>
                  <input
                    type="text"
                    required
                    value={formData.received_by_staff_name}
                    onChange={(e) => setFormData({ ...formData, received_by_staff_name: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500"
                    placeholder="Staff member name"
                  />
                </div>
                {formData.source === 'Bank Transfer' || formData.source === 'Bank Withdrawal' ? (
                  <>
                    <div className="col-span-2">
                      <label className="block text-sm font-medium text-gray-700 mb-1">Bank Account</label>
                      <select
                        value={formData.bank_account_id}
                        onChange={(e) => {
                          setFormData({ ...formData, bank_account_id: e.target.value, bank_statement_line_id: '' });
                          loadBankStatementLines(e.target.value);
                        }}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500"
                      >
                        <option value="">Select bank account</option>
                        {bankAccounts.map(bank => (
                          <option key={bank.id} value={bank.id}>
                            {bank.alias || bank.account_name} - {bank.bank_name}
                          </option>
                        ))}
                      </select>
                    </div>
                    {formData.bank_account_id && bankStatementLines.length > 0 && (
                      <div className="col-span-2">
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                          🔗 Link to Bank Reconciliation (Optional)
                        </label>
                        <select
                          value={formData.bank_statement_line_id}
                          onChange={(e) => setFormData({ ...formData, bank_statement_line_id: e.target.value })}
                          className="w-full px-3 py-2 border border-blue-300 bg-blue-50 rounded-lg focus:ring-2 focus:ring-blue-500"
                        >
                          <option value="">Don't link to bank statement</option>
                          {bankStatementLines.map(line => (
                            <option key={line.id} value={line.id}>
                              {new Date(line.transaction_date).toLocaleDateString('id-ID')} -
                              {line.description || 'No description'} -
                              Rp {((line.debit_amount || 0) + (line.credit_amount || 0)).toLocaleString('id-ID')}
                              {line.reference ? ` (${line.reference})` : ''}
                            </option>
                          ))}
                        </select>
                        <p className="text-xs text-blue-600 mt-1">
                          💡 Select a bank transaction to automatically mark it as reconciled
                        </p>
                      </div>
                    )}
                    {formData.bank_account_id && bankStatementLines.length === 0 && (
                      <div className="col-span-2">
                        <p className="text-sm text-gray-500 italic">
                          No unmatched bank transactions available for reconciliation
                        </p>
                      </div>
                    )}
                  </>
                ) : null}
                <div className="col-span-2">
                  <label className="block text-sm font-medium text-gray-700 mb-1">Purpose / Description *</label>
                  <textarea
                    required
                    value={formData.description}
                    onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500"
                    rows={2}
                    placeholder="Petty cash fund replenishment"
                  />
                </div>
              </div>
            </div>
          ) : (
            /* Add Expense Form */
            <div className="bg-orange-50 border border-orange-200 rounded-lg p-4">
              <p className="text-sm text-orange-700 mb-1">Record a new petty cash expense with receipt details</p>
              <p className="text-xs text-orange-600 mb-4">Available Balance: Rp {cashBalance.toLocaleString('id-ID')}</p>
              
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Amount (Rp) *</label>
                  <input
                    type="number"
                    required
                    min="1"
                    max={cashBalance}
                    value={formData.amount || ''}
                    onChange={(e) => setFormData({ ...formData, amount: parseFloat(e.target.value) || 0 })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-orange-500"
                    placeholder="Enter amount"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Date *</label>
                  <input
                    type="date"
                    required
                    value={formData.transaction_date}
                    onChange={(e) => setFormData({ ...formData, transaction_date: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-orange-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Paid To *</label>
                  <input
                    type="text"
                    required
                    value={formData.paid_to}
                    onChange={(e) => setFormData({ ...formData, paid_to: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-orange-500"
                    placeholder="Vendor/Person name"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Paid By (Staff) *</label>
                  <input
                    type="text"
                    required
                    value={formData.paid_by_staff_name}
                    onChange={(e) => setFormData({ ...formData, paid_by_staff_name: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-orange-500"
                    placeholder="Staff member name"
                  />
                </div>
                <div className="col-span-2">
                  <label className="block text-sm font-medium text-gray-700 mb-1">Payment Source *</label>
                  <select
                    value={formData.paid_by}
                    onChange={(e) => setFormData({ ...formData, paid_by: e.target.value as 'cash' | 'bank' })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-orange-500 font-medium"
                    required
                  >
                    <option value="cash">💵 Cash (→ Petty Cash)</option>
                    <option value="bank">🏦 Bank (→ Expense Tracker)</option>
                  </select>
                  <p className="text-xs text-gray-600 mt-1">
                    {formData.paid_by === 'cash'
                      ? '✓ Will be recorded in Petty Cash'
                      : '✓ Will move to Expense Tracker for Bank Reconciliation'}
                  </p>
                </div>
                <div className="col-span-2">
                  <label className="block text-sm font-medium text-gray-700 mb-1">Purpose / Description *</label>
                  <textarea
                    required
                    value={formData.description}
                    onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-orange-500"
                    rows={2}
                    placeholder="For what purpose?"
                  />
                </div>
                <div className="col-span-2">
                  <label className="block text-sm font-medium text-gray-700 mb-1">Category</label>
                  <select
                    value={formData.expense_category}
                    onChange={(e) => setFormData({ ...formData, expense_category: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-orange-500"
                  >
                    <option value="">Select category</option>
                    {expenseCategories.map(cat => (
                      <option key={cat} value={cat}>{cat}</option>
                    ))}
                  </select>
                </div>
              </div>
            </div>
          )}

          {/* File Attachments */}
          <div className="border rounded-lg p-4 space-y-3">
            <h4 className="font-medium text-gray-900 flex items-center gap-2">
              <Upload className="w-4 h-4" />
              Attachments (Optional)
            </h4>
            
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">
                  Proof Attachment
                </label>
                <label className="flex flex-col items-center justify-center h-24 border-2 border-dashed border-gray-300 rounded-lg cursor-pointer hover:border-blue-400 hover:bg-blue-50 transition">
                  <FileText className="w-6 h-6 text-gray-400" />
                  <span className="text-xs text-gray-500 mt-1">Upload</span>
                  <input
                    type="file"
                    className="hidden"
                    accept="image/*,.pdf"
                    onChange={(e) => handleFileSelect(e, 'proof')}
                  />
                </label>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">
                  Bill/Invoice
                </label>
                <label className="flex flex-col items-center justify-center h-24 border-2 border-dashed border-gray-300 rounded-lg cursor-pointer hover:border-blue-400 hover:bg-blue-50 transition">
                  <FileText className="w-6 h-6 text-gray-400" />
                  <span className="text-xs text-gray-500 mt-1">Upload</span>
                  <input
                    type="file"
                    className="hidden"
                    accept="image/*,.pdf"
                    onChange={(e) => handleFileSelect(e, 'invoice')}
                  />
                </label>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">
                  Material Photo
                </label>
                <label className="flex flex-col items-center justify-center h-24 border-2 border-dashed border-gray-300 rounded-lg cursor-pointer hover:border-blue-400 hover:bg-blue-50 transition">
                  <Image className="w-6 h-6 text-gray-400" />
                  <span className="text-xs text-gray-500 mt-1">Upload</span>
                  <input
                    type="file"
                    className="hidden"
                    accept="image/*"
                    onChange={(e) => handleFileSelect(e, 'photo')}
                  />
                </label>
              </div>
            </div>

            {uploadingFiles.length > 0 && (
              <div className="flex flex-wrap gap-2 pt-2">
                {uploadingFiles.map((item, idx) => (
                  <div key={idx} className="flex items-center gap-2 bg-gray-100 px-3 py-1.5 rounded-lg text-sm">
                    <span className="text-xs text-gray-500 uppercase">{item.type}</span>
                    <span className="truncate max-w-32">{item.file.name}</span>
                    <button type="button" onClick={() => removeFile(idx)} className="text-gray-400 hover:text-red-500">
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="flex justify-end gap-3 pt-4 border-t">
            <button
              type="button"
              onClick={() => { setModalOpen(false); resetForm(); }}
              className="px-4 py-2 text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition"
            >
              Cancel
            </button>
            <button
              type="submit"
              className={`px-6 py-2 text-white rounded-lg transition ${
                formData.transaction_type === 'withdraw'
                  ? 'bg-green-600 hover:bg-green-700'
                  : 'bg-orange-600 hover:bg-orange-700'
              }`}
            >
              {formData.transaction_type === 'withdraw' ? 'Add Funds' : 'Add Expense'}
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
