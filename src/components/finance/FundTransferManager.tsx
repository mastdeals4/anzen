import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { Plus, ArrowRightLeft, CheckCircle, Clock, Edit, Trash2 } from 'lucide-react';
import { Modal } from '../Modal';
import { showToast } from '../ToastNotification';
import { showConfirm } from '../ConfirmDialog';

interface FundTransfer {
  id: string;
  transfer_number: string;
  transfer_date: string;
  amount: number;
  from_amount: number;
  to_amount: number;
  exchange_rate: number | null;
  from_account_type: string;
  to_account_type: string;
  from_account_name: string;
  to_account_name: string;
  from_currency: string | null;
  to_currency: string | null;
  from_bank_account_id: string | null;
  to_bank_account_id: string | null;
  from_bank_statement_line_id: string | null;
  to_bank_statement_line_id: string | null;
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
  currency: string;
}

interface BankStatementLine {
  id: string;
  transaction_date: string;
  description: string | null;
  debit_amount: number | null;
  credit_amount: number | null;
  reconciliation_status: string | null;
}

interface FundTransferManagerProps {
  canManage: boolean;
}

// Helper function to format date as dd/mm/yy
const formatDateDDMMYY = (dateStr: string): string => {
  const date = new Date(dateStr);
  const day = date.getDate().toString().padStart(2, '0');
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  const year = date.getFullYear().toString().slice(-2);
  return `${day}/${month}/${year}`;
};

export function FundTransferManager({ canManage }: FundTransferManagerProps) {
  const [transfers, setTransfers] = useState<FundTransfer[]>([]);
  const [bankAccounts, setBankAccounts] = useState<BankAccount[]>([]);
  const [fromBankStatements, setFromBankStatements] = useState<BankStatementLine[]>([]);
  const [toBankStatements, setToBankStatements] = useState<BankStatementLine[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingTransfer, setEditingTransfer] = useState<FundTransfer | null>(null);
  const [formData, setFormData] = useState({
    transfer_date: new Date().toISOString().split('T')[0],
    from_amount: 0,
    to_amount: 0,
    from_account_type: 'bank' as 'petty_cash' | 'cash_on_hand' | 'bank',
    to_account_type: 'bank' as 'petty_cash' | 'cash_on_hand' | 'bank',
    from_bank_account_id: '',
    to_bank_account_id: '',
    from_bank_statement_line_id: '',
    to_bank_statement_line_id: '',
    description: '',
  });

  useEffect(() => {
    loadData();

    // Set up realtime subscription for bank statement changes
    const bankStatementSubscription = supabase
      .channel('bank-statement-fund-transfer-changes')
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'bank_statement_lines' },
        () => {
          // Reload bank statements when changes occur
          if (formData.from_bank_account_id) {
            loadBankStatements(formData.from_bank_account_id, 'from', editingTransfer?.from_bank_statement_line_id || undefined);
          }
          if (formData.to_bank_account_id) {
            loadBankStatements(formData.to_bank_account_id, 'to', editingTransfer?.to_bank_statement_line_id || undefined);
          }
        }
      )
      .subscribe();

    return () => {
      bankStatementSubscription.unsubscribe();
    };
  }, [formData.from_bank_account_id, formData.to_bank_account_id]);

  const loadData = async () => {
    try {
      console.log('loadData: Starting to load fund transfers...');
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
          .select('id, bank_name, account_number, alias, currency')
          .eq('is_active', true)
          .order('bank_name'),
      ]);

      console.log('loadData: Transfers result:', transfersRes.data?.length, 'records');
      if (transfersRes.error) throw transfersRes.error;
      if (banksRes.error) throw banksRes.error;

      setTransfers(transfersRes.data || []);
      setBankAccounts(banksRes.data || []);
    } catch (error: any) {
      console.error('Error loading fund transfers:', error.message);
      showToast({ type: 'error', title: 'Error', message: 'Failed to load fund transfers' });
    } finally {
      setLoading(false);
    }
  };

  const loadBankStatements = async (bankAccountId: string, type: 'from' | 'to', includeLinkedId?: string) => {
    if (!bankAccountId) {
      if (type === 'from') setFromBankStatements([]);
      else setToBankStatements([]);
      return;
    }

    try {
      // Load ALL unlinked statements (no date or limit restrictions)
      // Must not be linked to any other transaction types
      let query = supabase
        .from('bank_statement_lines')
        .select('id, transaction_date, description, debit_amount, credit_amount, reconciliation_status')
        .eq('bank_account_id', bankAccountId)
        .is('matched_fund_transfer_id', null)
        .is('matched_expense_id', null)
        .is('matched_receipt_id', null)
        .is('matched_petty_cash_id', null)
        .is('matched_entry_id', null)
        .order('transaction_date', { ascending: false });

      const { data, error } = await query;
      if (error) throw error;

      let statements = data || [];

      // If editing, also include the currently linked statement
      if (includeLinkedId) {
        const { data: linkedData } = await supabase
          .from('bank_statement_lines')
          .select('id, transaction_date, description, debit_amount, credit_amount, reconciliation_status')
          .eq('id', includeLinkedId)
          .single();

        if (linkedData && !statements.find(s => s.id === linkedData.id)) {
          // Add at the top of the list
          statements = [linkedData, ...statements];
        }
      }

      if (type === 'from') setFromBankStatements(statements);
      else setToBankStatements(statements);
    } catch (error) {
      console.error('Error loading bank statements:', error);
    }
  };

  const getFromCurrency = (): string => {
    if (formData.from_account_type === 'bank' && formData.from_bank_account_id) {
      const account = bankAccounts.find(b => b.id === formData.from_bank_account_id);
      return account?.currency || 'IDR';
    }
    return 'IDR';
  };

  const getToCurrency = (): string => {
    if (formData.to_account_type === 'bank' && formData.to_bank_account_id) {
      const account = bankAccounts.find(b => b.id === formData.to_bank_account_id);
      return account?.currency || 'IDR';
    }
    return 'IDR';
  };

  const calculateExchangeRate = (): number | null => {
    const fromCurrency = getFromCurrency();
    const toCurrency = getToCurrency();

    if (formData.from_amount > 0 && formData.to_amount > 0 && fromCurrency !== toCurrency) {
      return formData.to_amount / formData.from_amount;
    }
    return null;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (formData.from_amount <= 0) {
      showToast({ type: 'error', title: 'Error', message: 'From Amount must be greater than 0' });
      return;
    }

    if (formData.to_amount <= 0) {
      showToast({ type: 'error', title: 'Error', message: 'To Amount must be greater than 0' });
      return;
    }

    if (formData.from_account_type === formData.to_account_type) {
      if (formData.from_account_type === 'bank') {
        if (formData.from_bank_account_id === formData.to_bank_account_id) {
          showToast({ type: 'error', title: 'Error', message: 'Cannot transfer to the same bank account' });
          return;
        }
      } else {
        showToast({ type: 'error', title: 'Error', message: 'Cannot transfer to the same account type' });
        return;
      }
    }

    if (formData.from_account_type === 'bank' && !formData.from_bank_account_id) {
      showToast({ type: 'error', title: 'Error', message: 'Please select source bank account' });
      return;
    }

    if (formData.to_account_type === 'bank' && !formData.to_bank_account_id) {
      showToast({ type: 'error', title: 'Error', message: 'Please select destination bank account' });
      return;
    }

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const exchangeRate = calculateExchangeRate();

      if (editingTransfer) {
        // UPDATE existing transfer
        const transferData: any = {
          transfer_date: formData.transfer_date,
          amount: formData.from_amount,  // For backwards compatibility
          from_amount: formData.from_amount,
          to_amount: formData.to_amount,
          exchange_rate: exchangeRate,
          from_account_type: formData.from_account_type,
          to_account_type: formData.to_account_type,
          description: formData.description || null,
          from_bank_account_id: formData.from_account_type === 'bank' ? formData.from_bank_account_id : null,
          to_bank_account_id: formData.to_account_type === 'bank' ? formData.to_bank_account_id : null,
          from_bank_statement_line_id: formData.from_bank_statement_line_id || null,
          to_bank_statement_line_id: formData.to_bank_statement_line_id || null,
        };

        console.log('Updating fund transfer:', editingTransfer.id, transferData);
        const { data: updatedData, error } = await supabase
          .from('fund_transfers')
          .update(transferData)
          .eq('id', editingTransfer.id)
          .select();

        console.log('Update result:', { updatedData, error });
        
        if (error) throw error;

        showToast({ type: 'success', title: 'Success', message: 'Fund transfer updated successfully!' });
      } else {
        // CREATE new transfer
        // Generate transfer number
        const { data: transferNumber, error: numberError } = await supabase
          .rpc('generate_fund_transfer_number');

        if (numberError) throw numberError;

        const transferData: any = {
          transfer_number: transferNumber,
          transfer_date: formData.transfer_date,
          amount: formData.from_amount,  // For backwards compatibility
          from_amount: formData.from_amount,
          to_amount: formData.to_amount,
          exchange_rate: exchangeRate,
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

        if (formData.from_bank_statement_line_id) {
          transferData.from_bank_statement_line_id = formData.from_bank_statement_line_id;
        }

        if (formData.to_bank_statement_line_id) {
          transferData.to_bank_statement_line_id = formData.to_bank_statement_line_id;
        }

        const { data: newTransfer, error } = await supabase
          .from('fund_transfers')
          .insert([transferData])
          .select()
          .single();

        if (error) throw error;

        // If destination is petty_cash, create corresponding petty_cash_transaction
        if (formData.to_account_type === 'petty_cash' && newTransfer) {
          // Generate petty cash transaction number
          const prefix = 'PCW';
          const year = new Date().getFullYear().toString().slice(-2);
          const month = (new Date().getMonth() + 1).toString().padStart(2, '0');
          const { count } = await supabase
            .from('petty_cash_transactions')
            .select('*', { count: 'exact', head: true })
            .like('transaction_number', `${prefix}${year}${month}%`);
          
          const pettyCashTxNumber = `${prefix}${year}${month}-${String((count || 0) + 1).padStart(4, '0')}`;

          // Get source bank account name for description
          let sourceAccountName = 'Bank';
          if (formData.from_account_type === 'bank' && formData.from_bank_account_id) {
            const sourceBank = bankAccounts.find(b => b.id === formData.from_bank_account_id);
            sourceAccountName = sourceBank?.alias || sourceBank?.bank_name || 'Bank';
          }

          const { error: pettyCashError } = await supabase
            .from('petty_cash_transactions')
            .insert([{
              transaction_number: pettyCashTxNumber,
              transaction_date: formData.transfer_date,
              transaction_type: 'withdraw',
              amount: formData.to_amount,
              description: formData.description || `Fund transfer from ${sourceAccountName}`,
              bank_account_id: formData.from_account_type === 'bank' ? formData.from_bank_account_id : null,
              source: `Fund Transfer ${transferNumber}`,
              fund_transfer_id: newTransfer.id,
              created_by: user.id,
            }]);

          if (pettyCashError) {
            console.error('Error creating petty cash transaction:', pettyCashError);
            showToast({ type: 'warning', title: 'Warning', message: 'Fund transfer created but petty cash entry failed: ' + pettyCashError.message });
          } else {
            console.log('Petty cash transaction created successfully:', pettyCashTxNumber);
          }
        }

        // Update bank statement lines to mark them as matched
        if (formData.from_bank_statement_line_id && newTransfer) {
          await supabase
            .from('bank_statement_lines')
            .update({
              matched_fund_transfer_id: newTransfer.id,
              reconciliation_status: 'matched',
              matched_at: new Date().toISOString(),
              matched_by: user.id,
              notes: `Linked to Fund Transfer ${transferNumber}`
            })
            .eq('id', formData.from_bank_statement_line_id);
        }

        if (formData.to_bank_statement_line_id && newTransfer) {
          await supabase
            .from('bank_statement_lines')
            .update({
              matched_fund_transfer_id: newTransfer.id,
              reconciliation_status: 'matched',
              matched_at: new Date().toISOString(),
              matched_by: user.id,
              notes: `Linked to Fund Transfer ${transferNumber}`
            })
            .eq('id', formData.to_bank_statement_line_id);
        }

        showToast({ type: 'success', title: 'Success', message: 'Fund transfer created and posted successfully!' });
      }

      setModalOpen(false);
      resetForm();
      loadData();
    } catch (error: any) {
      console.error('Error with fund transfer:', error.message);
      showToast({ type: 'error', title: 'Error', message: 'Failed to save fund transfer: ' + error.message });
    }
  };

  const resetForm = () => {
    setFormData({
      transfer_date: new Date().toISOString().split('T')[0],
      from_amount: 0,
      to_amount: 0,
      from_account_type: 'bank',
      to_account_type: 'bank',
      from_bank_account_id: '',
      to_bank_account_id: '',
      from_bank_statement_line_id: '',
      to_bank_statement_line_id: '',
      description: '',
    });
    setFromBankStatements([]);
    setToBankStatements([]);
    setEditingTransfer(null);
  };

  const handleEdit = async (transfer: FundTransfer) => {
    setEditingTransfer(transfer);

    // Populate form with existing data
    setFormData({
      transfer_date: transfer.transfer_date,
      from_amount: transfer.from_amount,
      to_amount: transfer.to_amount,
      from_account_type: transfer.from_account_type as any,
      to_account_type: transfer.to_account_type as any,
      from_bank_account_id: transfer.from_bank_account_id || '',
      to_bank_account_id: transfer.to_bank_account_id || '',
      from_bank_statement_line_id: transfer.from_bank_statement_line_id || '',
      to_bank_statement_line_id: transfer.to_bank_statement_line_id || '',
      description: transfer.description || '',
    });

    // Load bank statements if bank accounts are selected, including the already linked ones
    if (transfer.from_bank_account_id) {
      loadBankStatements(transfer.from_bank_account_id, 'from', transfer.from_bank_statement_line_id || undefined);
    }
    if (transfer.to_bank_account_id) {
      loadBankStatements(transfer.to_bank_account_id, 'to', transfer.to_bank_statement_line_id || undefined);
    }

    setModalOpen(true);
  };

  const handleDelete = async (transferId: string) => {
    if (!await showConfirm({ title: 'Confirm', message: 'Are you sure you want to delete this fund transfer? This will also delete the associated petty cash transaction and journal entry.', variant: 'danger', confirmLabel: 'Delete' })) {
      return;
    }

    try {
      // First, delete any associated petty cash transaction
      const { error: pettyCashDeleteError } = await supabase
        .from('petty_cash_transactions')
        .delete()
        .eq('fund_transfer_id', transferId);

      if (pettyCashDeleteError) {
        console.error('Error deleting petty cash transaction:', pettyCashDeleteError);
        // Continue anyway - the petty cash transaction might not exist
      }

      // Unlink any matched bank statement lines
      await supabase
        .from('bank_statement_lines')
        .update({
          matched_fund_transfer_id: null,
          reconciliation_status: 'unmatched',
          matched_at: null,
          matched_by: null,
          notes: null
        })
        .eq('matched_fund_transfer_id', transferId);

      // Then delete the fund transfer
      const { error } = await supabase
        .from('fund_transfers')
        .delete()
        .eq('id', transferId);

      if (error) throw error;

      showToast({ type: 'success', title: 'Success', message: 'Fund transfer deleted successfully!' });
      loadData();
    } catch (error: any) {
      console.error('Error deleting fund transfer:', error.message);
      showToast({ type: 'error', title: 'Error', message: 'Failed to delete fund transfer: ' + error.message });
    }
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
              {canManage && <th className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase">Actions</th>}
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {loading ? (
              <tr>
                <td colSpan={canManage ? 9 : 8} className="px-6 py-8 text-center text-gray-500">
                  Loading...
                </td>
              </tr>
            ) : transfers.length === 0 ? (
              <tr>
                <td colSpan={canManage ? 9 : 8} className="px-6 py-8 text-center text-gray-500">
                  No fund transfers found
                </td>
              </tr>
            ) : (
              transfers.map((transfer) => (
                <tr key={transfer.id} className="hover:bg-gray-50">
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                    {formatDateDDMMYY(transfer.transfer_date)}
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
                    {transfer.from_currency === transfer.to_currency ? (
                      <div>
                        {transfer.from_currency === 'USD' ? '$' : 'Rp'} {transfer.from_amount.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </div>
                    ) : (
                      <div className="space-y-1">
                        <div className="text-red-600">
                          {transfer.from_currency === 'USD' ? '$' : 'Rp'} {transfer.from_amount.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </div>
                        <div className="text-xs text-gray-500">→</div>
                        <div className="text-green-600">
                          {transfer.to_currency === 'USD' ? '$' : 'Rp'} {transfer.to_amount.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </div>
                        {transfer.exchange_rate && (
                          <div className="text-xs text-gray-500">
                            Rate: {transfer.exchange_rate.toFixed(6)}
                          </div>
                        )}
                      </div>
                    )}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-center">
                    {getStatusBadge(transfer.status)}
                  </td>
                  {canManage && (
                    <td className="px-6 py-4 whitespace-nowrap text-center">
                      <div className="flex items-center justify-center gap-2">
                        <button
                          onClick={() => handleEdit(transfer)}
                          className="text-blue-600 hover:text-blue-800"
                          title="Edit Transfer"
                        >
                          <Edit className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => handleDelete(transfer.id)}
                          className="text-red-600 hover:text-red-800"
                          title="Delete Transfer"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </td>
                  )}
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
          title={editingTransfer ? "Edit Fund Transfer" : "New Fund Transfer"}
          maxWidth="max-w-2xl"
        >
          <form onSubmit={handleSubmit} className="space-y-4">
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
                      onChange={(e) => {
                        setFormData({ ...formData, from_bank_account_id: e.target.value, from_bank_statement_line_id: '' });
                        loadBankStatements(e.target.value, 'from');
                      }}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                      required
                    >
                      <option value="">Select Bank Account</option>
                      {bankAccounts.map((bank) => (
                        <option key={bank.id} value={bank.id}>
                          {bank.alias || bank.bank_name} - {bank.account_number} ({bank.currency})
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Amount ({getFromCurrency()}) <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    value={formData.from_amount || ''}
                    onChange={(e) => {
                      const newAmount = parseFloat(e.target.value) || 0;
                      const fromCurrency = getFromCurrency();
                      const toCurrency = getToCurrency();

                      // Auto-set to_amount if same currency
                      if (fromCurrency === toCurrency) {
                        setFormData({ ...formData, from_amount: newAmount, to_amount: newAmount });
                      } else {
                        setFormData({ ...formData, from_amount: newAmount });
                      }
                    }}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                    required
                    min="0.01"
                  />
                </div>
                {formData.from_bank_account_id && (
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      🔗 Link to Bank Statement (Optional)
                    </label>
                    {fromBankStatements.length > 0 ? (
                      <>
                        <select
                          value={formData.from_bank_statement_line_id}
                          onChange={(e) => setFormData({ ...formData, from_bank_statement_line_id: e.target.value })}
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
                        >
                          <option value="">No link</option>
                          {fromBankStatements.map((stmt) => (
                            <option key={stmt.id} value={stmt.id}>
                              {formatDateDDMMYY(stmt.transaction_date)} - {stmt.description?.substring(0, 40)} -
                              {getFromCurrency() === 'USD' ? '$' : 'Rp'} {(stmt.debit_amount || stmt.credit_amount || 0).toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                            </option>
                          ))}
                        </select>
                        <p className="text-xs text-gray-600 mt-1">
                          {fromBankStatements.length} unlinked transaction{fromBankStatements.length !== 1 ? 's' : ''} available
                        </p>
                      </>
                    ) : (
                      <div className="text-sm text-gray-500 italic py-2 px-3 bg-gray-50 rounded-lg border border-gray-200">
                        No unlinked transactions available
                      </div>
                    )}
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
                      onChange={(e) => {
                        setFormData({ ...formData, to_bank_account_id: e.target.value, to_bank_statement_line_id: '' });
                        loadBankStatements(e.target.value, 'to');
                      }}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                      required
                    >
                      <option value="">Select Bank Account</option>
                      {bankAccounts.map((bank) => (
                        <option key={bank.id} value={bank.id}>
                          {bank.alias || bank.bank_name} - {bank.account_number} ({bank.currency})
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Amount ({getToCurrency()}) <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    value={formData.to_amount || ''}
                    onChange={(e) => setFormData({ ...formData, to_amount: parseFloat(e.target.value) || 0 })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                    required
                    min="0.01"
                  />
                  {getFromCurrency() !== getToCurrency() && formData.from_amount > 0 && formData.to_amount > 0 && (
                    <p className="text-xs text-gray-600 mt-1">
                      Exchange Rate: 1 USD = {(getFromCurrency() === 'USD' ? formData.to_amount / formData.from_amount : formData.from_amount / formData.to_amount).toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} IDR
                    </p>
                  )}
                </div>
                {formData.to_bank_account_id && (
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      🔗 Link to Bank Statement (Optional)
                    </label>
                    {toBankStatements.length > 0 ? (
                      <>
                        <select
                          value={formData.to_bank_statement_line_id}
                          onChange={(e) => setFormData({ ...formData, to_bank_statement_line_id: e.target.value })}
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
                        >
                          <option value="">No link</option>
                          {toBankStatements.map((stmt) => (
                            <option key={stmt.id} value={stmt.id}>
                              {formatDateDDMMYY(stmt.transaction_date)} - {stmt.description?.substring(0, 40)} -
                              {getToCurrency() === 'USD' ? '$' : 'Rp'} {(stmt.debit_amount || stmt.credit_amount || 0).toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                            </option>
                          ))}
                        </select>
                        <p className="text-xs text-gray-600 mt-1">
                          {toBankStatements.length} unlinked transaction{toBankStatements.length !== 1 ? 's' : ''} available
                        </p>
                      </>
                    ) : (
                      <div className="text-sm text-gray-500 italic py-2 px-3 bg-gray-50 rounded-lg border border-gray-200">
                        No unlinked transactions available
                      </div>
                    )}
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
