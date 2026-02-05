import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { DataTable } from '../DataTable';
import { Modal } from '../Modal';
import { Plus, Edit } from 'lucide-react';

interface BankAccount {
  id: string;
  account_name: string;
  bank_name: string;
  account_number: string;
  account_type: string;
  currency: string;
  opening_balance: number;
  opening_balance_date: string;
  current_balance: number;
  is_active: boolean;
  alias?: string;
}

interface Props {
  canManage: boolean;
}

export function BankAccountsManager({ canManage }: Props) {
  const [accounts, setAccounts] = useState<BankAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingAccount, setEditingAccount] = useState<BankAccount | null>(null);
  const [formData, setFormData] = useState({
    account_name: '',
    bank_name: '',
    account_number: '',
    account_type: 'current' as 'savings' | 'current' | 'credit_card' | 'other',
    currency: 'IDR',
    opening_balance: 0,
    opening_balance_date: '2025-01-01',
    alias: '',
  });

  useEffect(() => {
    loadAccounts();
  }, []);

  const loadAccounts = async () => {
    try {
      const { data, error } = await supabase
        .from('bank_accounts')
        .select('*')
        .order('created_at', { ascending: false});

      if (error) throw error;
      setAccounts(data || []);
    } catch (error) {
      console.error('Error loading bank accounts:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      if (editingAccount) {
        const { error } = await supabase
          .from('bank_accounts')
          .update(formData)
          .eq('id', editingAccount.id);

        if (error) throw error;
      } else {
        const { error } = await supabase
          .from('bank_accounts')
          .insert([{
            ...formData,
            current_balance: formData.opening_balance,
            created_by: user.id,
          }]);

        if (error) throw error;
      }

      setModalOpen(false);
      resetForm();
      loadAccounts();
    } catch (error: any) {
      console.error('Error saving bank account:', error);
      alert(`Failed to save bank account: ${error.message}`);
    }
  };

  const handleEdit = (account: BankAccount) => {
    setEditingAccount(account);
    setFormData({
      account_name: account.account_name,
      bank_name: account.bank_name,
      account_number: account.account_number,
      account_type: account.account_type as any,
      currency: account.currency,
      opening_balance: account.opening_balance,
      opening_balance_date: account.opening_balance_date || '2025-01-01',
      alias: account.alias || '',
    });
    setModalOpen(true);
  };

  const resetForm = () => {
    setEditingAccount(null);
    setFormData({
      account_name: '',
      bank_name: '',
      account_number: '',
      account_type: 'current',
      currency: 'IDR',
      opening_balance: 0,
      opening_balance_date: '2025-01-01',
      alias: '',
    });
  };

  const columns = [
    { key: 'account_name', label: 'Account Name' },
    { key: 'bank_name', label: 'Bank' },
    { key: 'account_number', label: 'Account #' },
    { key: 'type', label: 'Type', render: (_val: any, item: BankAccount) => <span className="capitalize">{item.account_type || 'current'}</span> },
    { key: 'balance', label: 'Balance', render: (_val: any, item: BankAccount) => <span className="font-semibold">Rp {(item.current_balance || 0).toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span> },
    { key: 'status', label: 'Status', render: (_val: any, item: BankAccount) => (
      <span className={`px-2 py-1 rounded-full text-xs font-medium ${
        item.is_active ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-800'
      }`}>
        {item.is_active ? 'Active' : 'Inactive'}
      </span>
    )},
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">Bank Accounts</h2>
        {canManage && (
          <button
            onClick={() => { resetForm(); setModalOpen(true); }}
            className="flex items-center gap-2 bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700"
          >
            <Plus className="w-5 h-5" />
            Add Bank Account
          </button>
        )}
      </div>

      <DataTable
        columns={columns}
        data={accounts}
        loading={loading}
        actions={canManage ? (account) => (
          <button
            onClick={() => handleEdit(account)}
            className="p-1 text-blue-600 hover:bg-blue-50 rounded"
          >
            <Edit className="w-4 h-4" />
          </button>
        ) : undefined}
      />

      <Modal
        isOpen={modalOpen}
        onClose={() => { setModalOpen(false); resetForm(); }}
        title={editingAccount ? 'Edit Bank Account' : 'Add Bank Account'}
      >
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Account Name *</label>
              <input
                type="text"
                value={formData.account_name}
                onChange={(e) => setFormData({ ...formData, account_name: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                required
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Bank Name *</label>
              <input
                type="text"
                value={formData.bank_name}
                onChange={(e) => setFormData({ ...formData, bank_name: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                required
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Display Alias</label>
              <input
                type="text"
                value={formData.alias}
                onChange={(e) => setFormData({ ...formData, alias: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                placeholder="e.g., BCA IDR, Mandiri USD"
              />
              <p className="text-xs text-gray-500 mt-1">Short name for easier identification in lists</p>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Account Number *</label>
              <input
                type="text"
                value={formData.account_number}
                onChange={(e) => setFormData({ ...formData, account_number: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                required
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Account Type *</label>
              <select
                value={formData.account_type}
                onChange={(e) => setFormData({ ...formData, account_type: e.target.value as any })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                required
              >
                <option value="savings">Savings</option>
                <option value="current">Current</option>
                <option value="credit_card">Credit Card</option>
                <option value="other">Other</option>
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Currency *</label>
              <select
                value={formData.currency}
                onChange={(e) => setFormData({ ...formData, currency: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                required
              >
                <option value="IDR">IDR (Indonesian Rupiah)</option>
                <option value="USD">USD (US Dollar)</option>
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Opening Balance</label>
              <input
                type="number"
                value={formData.opening_balance === 0 ? '' : formData.opening_balance}
                onChange={(e) => setFormData({ ...formData, opening_balance: e.target.value === '' ? 0 : Number(e.target.value) })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                step="0.01"
                placeholder="0"
              />
              <p className="text-xs text-gray-500 mt-1">Leave blank if opening balance is zero</p>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Opening Balance Date *</label>
              <input
                type="date"
                value={formData.opening_balance_date}
                onChange={(e) => setFormData({ ...formData, opening_balance_date: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                required
              />
              <p className="text-xs text-gray-500 mt-1">Date when the opening balance is effective</p>
            </div>
          </div>

          <div className="flex justify-end gap-3 pt-4">
            <button
              type="button"
              onClick={() => { setModalOpen(false); resetForm(); }}
              className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
            >
              {editingAccount ? 'Update' : 'Add'} Account
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
