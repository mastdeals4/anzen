import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { DataTable } from '../DataTable';
import { FinanceModal as Modal } from './FinanceModal';
import { MoneyInput } from '../MoneyInput';
import { FinancePage } from './FinancePage';
import { FinanceActionButton, FinanceBadge, FinanceButton } from './FinanceUI';
import { SapRow, SapField, SAP_INPUT } from './SapLayout';
import { formatCurrency } from '../../utils/currency';
import { Plus } from 'lucide-react';

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
  coa_code?: string;
  ledger_balance?: number;
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
      const today = new Date().toISOString().split('T')[0];
      const { data: accountsData, error: accountsError } = await supabase
        .from('bank_accounts')
        .select('*, chart_of_accounts!coa_id(code, id)')
        .order('created_at', { ascending: false });

      if (accountsError) throw accountsError;

      // Compute ledger balances only for the COA IDs linked to bank accounts,
      // using the same active-JE-lines logic as get_balance_sheet but scoped
      // to just those accounts (avoids invoking the full balance sheet RPC).
      const coaEntries = (accountsData || [])
        .map((acct: any) => acct.chart_of_accounts)
        .filter((coa: any) => coa?.id);
      const coaIds = Array.from(new Set(coaEntries.map((coa: any) => coa.id)));

      const bsMap: Record<string, number> = {};
      if (coaIds.length > 0) {
        const { data: lines, error: linesError } = await supabase
          .from('journal_entry_lines')
          .select('account_id, debit, credit, journal_entries!inner(entry_date, is_posted, is_reversed)')
          .in('account_id', coaIds)
          .eq('journal_entries.is_posted', true)
          .eq('journal_entries.is_reversed', false)
          .lte('journal_entries.entry_date', today);

        if (linesError) {
          console.warn('[BankMaster] Could not load ledger balances', linesError);
        } else if (lines) {
          const byAccount: Record<string, number> = {};
          for (const line of lines) {
            const aid = line.account_id as string;
            byAccount[aid] = (byAccount[aid] || 0) + (Number(line.debit) - Number(line.credit));
          }
          for (const coa of coaEntries) {
            bsMap[coa.code] = byAccount[coa.id] ?? 0;
          }
        }
      }

      const enriched = (accountsData || []).map((acct: any) => ({
        ...acct,
        coa_code: acct.chart_of_accounts?.code,
        ledger_balance: acct.chart_of_accounts?.code
          ? (bsMap[acct.chart_of_accounts.code] ?? null)
          : null,
      }));

      setAccounts(enriched);
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
    {
      key: 'balance',
      label: 'GL Balance',
      render: (_val: any, item: BankAccount) => {
        if (item.ledger_balance === null || item.ledger_balance === undefined) {
          return <span className="text-gray-400 text-xs">No COA linked</span>;
        }
        const isNegative = item.ledger_balance < 0;
        return (
          <span className={`font-semibold ${isNegative ? 'text-red-600' : 'text-gray-900'}`}>
            {formatCurrency(Math.abs(item.ledger_balance), item.currency)}
            {isNegative && ' (Dr)'}
          </span>
        );
      }
    },
    { key: 'status', label: 'Status', render: (_val: any, item: BankAccount) => (
      <FinanceBadge status={item.is_active ? 'approved' : 'draft'}>
        {item.is_active ? 'Active' : 'Inactive'}
      </FinanceBadge>
    )},
  ];

  return (
    <FinancePage
      title="Bank Accounts"
      subtitle="Bank master and ledger balances"
      actions={canManage ? (
          <FinanceButton variant="primary" onClick={() => { resetForm(); setModalOpen(true); }}>
            <Plus className="w-3.5 h-3.5" />
            Add Bank Account
          </FinanceButton>
      ) : undefined}
    >
      <DataTable
        columns={columns}
        data={accounts}
        loading={loading}
        actions={canManage ? (account) => (
          <FinanceActionButton action="edit" onClick={() => handleEdit(account)} />
        ) : undefined}
      />

      <Modal
        isOpen={modalOpen}
        onClose={() => { setModalOpen(false); resetForm(); }}
        title={editingAccount ? 'Edit Bank Account' : 'Add Bank Account'}
      >
        <form onSubmit={handleSubmit} className="flex flex-col gap-1.5">
          <SapRow>
            <SapField label="Bank Name" required span={4}>
              <input type="text" value={formData.bank_name}
                onChange={(e) => setFormData({ ...formData, bank_name: e.target.value })}
                className={SAP_INPUT} required />
            </SapField>
            <SapField label="Account Name" required span={4}>
              <input type="text" value={formData.account_name}
                onChange={(e) => setFormData({ ...formData, account_name: e.target.value })}
                className={SAP_INPUT} required />
            </SapField>
            <SapField label="Alias" span={4}>
              <input type="text" value={formData.alias}
                onChange={(e) => setFormData({ ...formData, alias: e.target.value })}
                className={SAP_INPUT} placeholder="BCA IDR, Mandiri USD" />
            </SapField>
          </SapRow>
          <SapRow>
            <SapField label="Account #" required span={4}>
              <input type="text" value={formData.account_number}
                onChange={(e) => setFormData({ ...formData, account_number: e.target.value })}
                className={SAP_INPUT + ' !font-mono'} required />
            </SapField>
            <SapField label="Type" required span={4}>
              <select value={formData.account_type}
                onChange={(e) => setFormData({ ...formData, account_type: e.target.value as any })}
                className={SAP_INPUT} required>
                <option value="savings">Savings</option>
                <option value="current">Current</option>
                <option value="credit_card">Credit Card</option>
                <option value="other">Other</option>
              </select>
            </SapField>
            <SapField label="Currency" required span={4}>
              <select value={formData.currency}
                onChange={(e) => setFormData({ ...formData, currency: e.target.value })}
                className={SAP_INPUT} required>
                <option value="IDR">IDR</option>
                <option value="USD">USD</option>
              </select>
            </SapField>
          </SapRow>
          <SapRow>
            <SapField label="Open Bal" span={6}>
              <MoneyInput decimal placeholder="0"
                value={formData.opening_balance}
                onChange={(n) => setFormData({ ...formData, opening_balance: n })}
                className={SAP_INPUT + ' !text-right !font-mono'} />
            </SapField>
            <SapField label="Open Date" required span={6}>
              <input type="date" value={formData.opening_balance_date}
                onChange={(e) => setFormData({ ...formData, opening_balance_date: e.target.value })}
                className={SAP_INPUT} required />
            </SapField>
          </SapRow>

          <div className="flex justify-end gap-2 pt-2 border-t border-gray-200 mt-1">
            <FinanceButton type="button" onClick={() => { setModalOpen(false); resetForm(); }}>Cancel</FinanceButton>
            <FinanceButton type="submit" variant="primary">
              {editingAccount ? 'Update' : 'Add'} Account
            </FinanceButton>
          </div>
        </form>
      </Modal>
    </FinancePage>
  );
}
