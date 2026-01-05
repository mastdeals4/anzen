import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { Plus, ArrowRightLeft, CheckCircle, Clock } from 'lucide-react';
import { Modal } from '../Modal';

interface FundTransfer {
  id: string;
  transfer_number: string;
  transfer_date: string;
  amount: number;
  from_account_type: string;
  to_account_type: string;
  from_account_name: string;
  to_account_name: string;
  description: string | null;
  status: string;
  posted_at: string | null;
  created_at: string;
  created_by_name: string | null;
}

interface BankAccount {
  id: string;
  bank_name: string;
  account_number: string;
  alias: string | null;
}

interface FundTransferManagerProps {
  canManage: boolean;
}

export function FundTransferManager({ canManage }: FundTransferManagerProps) {
  const [transfers, setTransfers] = useState<FundTransfer[]>([]);
  const [bankAccounts, setBankAccounts] = useState<BankAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [formData, setFormData] = useState({
    transfer_date: new Date().toISOString().split('T')[0],
    amount: 0,
    from_account_type: 'bank' as 'petty_cash' | 'cash_on_hand' | 'bank',
    to_account_type: 'petty_cash' as 'petty_cash' | 'cash_on_hand' | 'bank',
    from_bank_account_id: '',
    to_bank_account_id: '',
    description: '',
  });

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      setLoading(true);
      const [transfersRes, banksRes] = await Promise.all([
        supabase
          .from('vw_fund_transfers_detailed')
          .select('*')
          .order('transfer_date', { ascending: false })
          .order('created_at', { ascending: false })
          .limit(100),
        supabase
          .from('bank_accounts')
          .select('id, bank_name, account_number, alias')
          .eq('is_active', true)
          .order('bank_name'),
      ]);

      if (transfersRes.error) throw transfersRes.error;
      if (banksRes.error) throw banksRes.error;

      setTransfers(transfersRes.data || []);
      setBankAccounts(banksRes.data || []);
    } catch (error: any) {
      console.error('Error loading fund transfers:', error.message);
      alert('Failed to load fund transfers');
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (formData.amount <= 0) {
      alert('Amount must be greater than 0');
      return;
    }

    if (formData.from_account_type === formData.to_account_type) {
      if (formData.from_account_type === 'bank') {
        if (formData.from_bank_account_id === formData.to_bank_account_id) {
          alert('Cannot transfer to the same bank account');
          return;
        }
      } else {
        alert('Cannot transfer to the same account type');
        return;
      }
    }

    if (formData.from_account_type === 'bank' && !formData.from_bank_account_id) {
      alert('Please select source bank account');
      return;
    }

    if (formData.to_account_type === 'bank' && !formData.to_bank_account_id) {
      alert('Please select destination bank account');
      return;
    }

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      // Generate transfer number
      const { data: transferNumber, error: numberError } = await supabase
        .rpc('generate_fund_transfer_number');

      if (numberError) throw numberError;

      const transferData: any = {
        transfer_number: transferNumber,
        transfer_date: formData.transfer_date,
        amount: formData.amount,
        from_account_type: formData.from_account_type,
        to_account_type: formData.to_account_type,
        description: formData.description || null,
        created_by: user.id,
      };

      if (formData.from_account_type === 'bank') {
        transferData.from_bank_account_id = formData.from_bank_account_id;
      }

      if (formData.to_account_type === 'bank') {
        transferData.to_bank_account_id = formData.to_bank_account_id;
      }

      const { error } = await supabase
        .from('fund_transfers')
        .insert([transferData]);

      if (error) throw error;

      alert('Fund transfer created and posted successfully!');
      setModalOpen(false);
      resetForm();
      loadData();
    } catch (error: any) {
      console.error('Error creating fund transfer:', error.message);
      alert('Failed to create fund transfer: ' + error.message);
    }
  };

  const resetForm = () => {
    setFormData({
      transfer_date: new Date().toISOString().split('T')[0],
      amount: 0,
      from_account_type: 'bank',
      to_account_type: 'petty_cash',
      from_bank_account_id: '',
      to_bank_account_id: '',
      description: '',
    });
  };

  const getAccountTypeLabel = (type: string) => {
    switch (type) {
      case 'petty_cash': return 'Petty Cash';
      case 'cash_on_hand': return 'Cash on Hand';
      case 'bank': return 'Bank Account';
      default: return type;
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'posted':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-green-700 bg-green-50 border border-green-200 rounded">
            <CheckCircle className="w-3 h-3" />
            Posted
          </span>
        );
      case 'pending':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-yellow-700 bg-yellow-50 border border-yellow-200 rounded">
            <Clock className="w-3 h-3" />
            Pending
          </span>
        );
      default:
        return <span className="text-xs text-gray-500">{status}</span>;
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold text-gray-900">Fund Transfers</h2>
          <p className="text-sm text-gray-600">Transfer funds between accounts</p>
        </div>
        {canManage && (
          <button
            onClick={() => {
              resetForm();
              setModalOpen(true);
            }}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
          >
            <Plus className="w-4 h-4" />
            New Transfer
          </button>
        )}
      </div>

      <div className="bg-white rounded-lg shadow overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Date</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Transfer #</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">From</th>
              <th className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase">→</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">To</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Description</th>
              <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">Amount</th>
              <th className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase">Status</th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {loading ? (
              <tr>
                <td colSpan={8} className="px-6 py-8 text-center text-gray-500">
                  Loading...
                </td>
              </tr>
            ) : transfers.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-6 py-8 text-center text-gray-500">
                  No fund transfers found
                </td>
              </tr>
            ) : (
              transfers.map((transfer) => (
                <tr key={transfer.id} className="hover:bg-gray-50">
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                    {new Date(transfer.transfer_date).toLocaleDateString()}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap font-mono text-sm text-gray-900">
                    {transfer.transfer_number}
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-900">
                    <div className="font-medium">{transfer.from_account_name}</div>
                    <div className="text-xs text-gray-500">{getAccountTypeLabel(transfer.from_account_type)}</div>
                  </td>
                  <td className="px-6 py-4 text-center">
                    <ArrowRightLeft className="w-4 h-4 text-blue-600 inline" />
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-900">
                    <div className="font-medium">{transfer.to_account_name}</div>
                    <div className="text-xs text-gray-500">{getAccountTypeLabel(transfer.to_account_type)}</div>
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-700">
                    {transfer.description || '-'}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium text-gray-900">
                    Rp {transfer.amount.toLocaleString('id-ID')}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-center">
                    {getStatusBadge(transfer.status)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {modalOpen && (
        <Modal
          isOpen={modalOpen}
          onClose={() => {
            setModalOpen(false);
            resetForm();
          }}
          title="New Fund Transfer"
          maxWidth="max-w-2xl"
        >
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Transfer Date <span className="text-red-500">*</span>
                </label>
                <input
                  type="date"
                  value={formData.transfer_date}
                  onChange={(e) => setFormData({ ...formData, transfer_date: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                  required
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Amount (Rp) <span className="text-red-500">*</span>
                </label>
                <input
                  type="number"
                  step="0.01"
                  value={formData.amount || ''}
                  onChange={(e) => setFormData({ ...formData, amount: parseFloat(e.target.value) || 0 })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                  required
                  min="0.01"
                />
              </div>
            </div>

            <div className="border-2 border-blue-200 rounded-lg p-4 bg-blue-50">
              <h3 className="text-sm font-semibold text-blue-900 mb-3">From (Source Account)</h3>
              <div className="space-y-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Account Type <span className="text-red-500">*</span>
                  </label>
                  <select
                    value={formData.from_account_type}
                    onChange={(e) => setFormData({
                      ...formData,
                      from_account_type: e.target.value as any,
                      from_bank_account_id: e.target.value === 'bank' ? formData.from_bank_account_id : ''
                    })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                    required
                  >
                    <option value="bank">Bank Account</option>
                    <option value="cash_on_hand">Cash on Hand</option>
                    <option value="petty_cash">Petty Cash</option>
                  </select>
                </div>
                {formData.from_account_type === 'bank' && (
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Bank Account <span className="text-red-500">*</span>
                    </label>
                    <select
                      value={formData.from_bank_account_id}
                      onChange={(e) => setFormData({ ...formData, from_bank_account_id: e.target.value })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                      required
                    >
                      <option value="">Select Bank Account</option>
                      {bankAccounts.map((bank) => (
                        <option key={bank.id} value={bank.id}>
                          {bank.alias || bank.bank_name} - {bank.account_number}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </div>
            </div>

            <div className="flex justify-center">
              <ArrowRightLeft className="w-6 h-6 text-gray-400" />
            </div>

            <div className="border-2 border-green-200 rounded-lg p-4 bg-green-50">
              <h3 className="text-sm font-semibold text-green-900 mb-3">To (Destination Account)</h3>
              <div className="space-y-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Account Type <span className="text-red-500">*</span>
                  </label>
                  <select
                    value={formData.to_account_type}
                    onChange={(e) => setFormData({
                      ...formData,
                      to_account_type: e.target.value as any,
                      to_bank_account_id: e.target.value === 'bank' ? formData.to_bank_account_id : ''
                    })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                    required
                  >
                    <option value="petty_cash">Petty Cash</option>
                    <option value="cash_on_hand">Cash on Hand</option>
                    <option value="bank">Bank Account</option>
                  </select>
                </div>
                {formData.to_account_type === 'bank' && (
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Bank Account <span className="text-red-500">*</span>
                    </label>
                    <select
                      value={formData.to_bank_account_id}
                      onChange={(e) => setFormData({ ...formData, to_bank_account_id: e.target.value })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                      required
                    >
                      <option value="">Select Bank Account</option>
                      {bankAccounts.map((bank) => (
                        <option key={bank.id} value={bank.id}>
                          {bank.alias || bank.bank_name} - {bank.account_number}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
              <textarea
                value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                rows={2}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                placeholder="Purpose of transfer (optional)"
              />
            </div>

            <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
              <p className="text-sm text-blue-800">
                <strong>Note:</strong> The journal entry will be posted automatically when you create this transfer.
                Both accounts will be updated immediately.
              </p>
            </div>

            <div className="flex justify-end gap-3 pt-4">
              <button
                type="button"
                onClick={() => {
                  setModalOpen(false);
                  resetForm();
                }}
                className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
              >
                Create Transfer
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
