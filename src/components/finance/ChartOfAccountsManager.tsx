import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { Plus, Edit, Trash2, ChevronRight, ChevronDown, Search } from 'lucide-react';
import { Modal } from '../Modal';

interface Account {
  id: string;
  code: string;
  name: string;
  name_id: string | null;
  account_type: string;
  account_group: string | null;
  parent_id: string | null;
  is_header: boolean;
  is_active: boolean;
  normal_balance: string;
  description: string | null;
}

interface ChartOfAccountsManagerProps {
  canManage: boolean;
}

const accountTypes = [
  { value: 'asset', label: 'Asset', color: 'bg-blue-100 text-blue-800' },
  { value: 'liability', label: 'Liability', color: 'bg-red-100 text-red-800' },
  { value: 'equity', label: 'Equity', color: 'bg-purple-100 text-purple-800' },
  { value: 'revenue', label: 'Revenue', color: 'bg-green-100 text-green-800' },
  { value: 'expense', label: 'Expense', color: 'bg-orange-100 text-orange-800' },
  { value: 'contra', label: 'Contra', color: 'bg-gray-100 text-gray-800' },
];

export function ChartOfAccountsManager({ canManage }: ChartOfAccountsManagerProps) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingAccount, setEditingAccount] = useState<Account | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set(['asset', 'liability', 'equity', 'revenue', 'expense']));
  const [searchTerm, setSearchTerm] = useState('');
  const [formData, setFormData] = useState({
    code: '',
    name: '',
    name_id: '',
    account_type: 'expense',
    account_group: '',
    parent_id: '',
    is_header: false,
    normal_balance: 'debit',
    description: '',
  });

  useEffect(() => {
    loadAccounts();
  }, []);

  const loadAccounts = async () => {
    try {
      const { data, error } = await supabase
        .from('chart_of_accounts')
        .select('*')
        .order('code');

      if (error) throw error;
      setAccounts(data || []);
    } catch (error) {
      console.error('Error loading accounts:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    try {
      const payload = {
        ...formData,
        parent_id: formData.parent_id || null,
        name_id: formData.name_id || null,
        description: formData.description || null,
      };

      if (editingAccount) {
        const { error } = await supabase
          .from('chart_of_accounts')
          .update(payload)
          .eq('id', editingAccount.id);
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from('chart_of_accounts')
          .insert([payload]);
        if (error) throw error;
      }

      setModalOpen(false);
      resetForm();
      loadAccounts();
    } catch (error: any) {
      console.error('Error saving account:', error);
      alert('Failed to save account: ' + error.message);
    }
  };

  const handleEdit = (account: Account) => {
    setEditingAccount(account);
    setFormData({
      code: account.code,
      name: account.name,
      name_id: account.name_id || '',
      account_type: account.account_type,
      account_group: account.account_group || '',
      parent_id: account.parent_id || '',
      is_header: account.is_header,
      normal_balance: account.normal_balance,
      description: account.description || '',
    });
    setModalOpen(true);
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Are you sure you want to delete this account?')) return;

    try {
      const { error } = await supabase
        .from('chart_of_accounts')
        .delete()
        .eq('id', id);
      if (error) throw error;
      loadAccounts();
    } catch (error: any) {
      console.error('Error deleting account:', error);
      alert('Failed to delete account: ' + error.message);
    }
  };

  const resetForm = () => {
    setEditingAccount(null);
    setFormData({
      code: '',
      name: '',
      name_id: '',
      account_type: 'expense',
      account_group: '',
      parent_id: '',
      is_header: false,
      normal_balance: 'debit',
      description: '',
    });
  };

  const toggleGroup = (type: string) => {
    const newExpanded = new Set(expandedGroups);
    if (newExpanded.has(type)) {
      newExpanded.delete(type);
    } else {
      newExpanded.add(type);
    }
    setExpandedGroups(newExpanded);
  };

  const getTypeColor = (type: string) => {
    return accountTypes.find(t => t.value === type)?.color || 'bg-gray-100 text-gray-800';
  };

  const filteredAccounts = accounts.filter(account =>
    account.code.toLowerCase().includes(searchTerm.toLowerCase()) ||
    account.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    (account.name_id && account.name_id.toLowerCase().includes(searchTerm.toLowerCase()))
  );

  const groupedAccounts = accountTypes.reduce((acc, type) => {
    acc[type.value] = filteredAccounts.filter(a => a.account_type === type.value);
    return acc;
  }, {} as Record<string, Account[]>);

  if (loading) {
    return <div className="flex justify-center py-8"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div></div>;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-5 h-5" />
          <input
            type="text"
            placeholder="Search accounts..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
          />
        </div>
        {canManage && (
          <button
            onClick={() => { resetForm(); setModalOpen(true); }}
            className="flex items-center gap-2 bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700"
          >
            <Plus className="w-5 h-5" />
            Add Account
          </button>
        )}
      </div>

      <div className="bg-white rounded-lg shadow overflow-hidden">
        {accountTypes.map(type => (
          <div key={type.value} className="border-b last:border-b-0">
            <button
              onClick={() => toggleGroup(type.value)}
              className="w-full flex items-center justify-between px-4 py-3 bg-gray-50 hover:bg-gray-100"
            >
              <div className="flex items-center gap-2">
                {expandedGroups.has(type.value) ? <ChevronDown className="w-5 h-5" /> : <ChevronRight className="w-5 h-5" />}
                <span className={`px-2 py-1 rounded text-sm font-medium ${type.color}`}>{type.label}</span>
                <span className="text-gray-500 text-sm">({groupedAccounts[type.value]?.length || 0} accounts)</span>
              </div>
            </button>
            
            {expandedGroups.has(type.value) && groupedAccounts[type.value]?.length > 0 && (
              <table className="w-full">
                <thead className="bg-gray-50 text-xs text-gray-500 uppercase">
                  <tr>
                    <th className="px-4 py-2 text-left">Code</th>
                    <th className="px-4 py-2 text-left">Account Name</th>
                    <th className="px-4 py-2 text-left">Indonesian Name</th>
                    <th className="px-4 py-2 text-left">Group</th>
                    <th className="px-4 py-2 text-center">Normal</th>
                    {canManage && <th className="px-4 py-2 text-right">Actions</th>}
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {groupedAccounts[type.value].map(account => (
                    <tr key={account.id} className={`hover:bg-gray-50 ${account.is_header ? 'font-semibold bg-gray-50' : ''}`}>
                      <td className="px-4 py-2 font-mono text-sm">{account.code}</td>
                      <td className="px-4 py-2">{account.name}</td>
                      <td className="px-4 py-2 text-gray-500">{account.name_id || '-'}</td>
                      <td className="px-4 py-2 text-sm text-gray-500">{account.account_group || '-'}</td>
                      <td className="px-4 py-2 text-center">
                        <span className={`text-xs px-2 py-1 rounded ${account.normal_balance === 'debit' ? 'bg-blue-100 text-blue-700' : 'bg-green-100 text-green-700'}`}>
                          {account.normal_balance}
                        </span>
                      </td>
                      {canManage && (
                        <td className="px-4 py-2 text-right">
                          <button onClick={() => handleEdit(account)} className="text-blue-600 hover:text-blue-800 mr-2">
                            <Edit className="w-4 h-4" />
                          </button>
                          <button onClick={() => handleDelete(account.id)} className="text-red-600 hover:text-red-800">
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        ))}
      </div>

      <Modal isOpen={modalOpen} onClose={() => setModalOpen(false)} title={editingAccount ? 'Edit Account' : 'Add Account'}>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Account Code *</label>
              <input
                type="text"
                required
                value={formData.code}
                onChange={(e) => setFormData({ ...formData, code: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                placeholder="e.g., 1101"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Account Type *</label>
              <select
                required
                value={formData.account_type}
                onChange={(e) => setFormData({ ...formData, account_type: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg"
              >
                {accountTypes.map(type => (
                  <option key={type.value} value={type.value}>{type.label}</option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Account Name (English) *</label>
            <input
              type="text"
              required
              value={formData.name}
              onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Account Name (Indonesian)</label>
            <input
              type="text"
              value={formData.name_id}
              onChange={(e) => setFormData({ ...formData, name_id: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Account Group</label>
              <input
                type="text"
                value={formData.account_group}
                onChange={(e) => setFormData({ ...formData, account_group: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Normal Balance *</label>
              <select
                required
                value={formData.normal_balance}
                onChange={(e) => setFormData({ ...formData, normal_balance: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg"
              >
                <option value="debit">Debit</option>
                <option value="credit">Credit</option>
              </select>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Parent Account</label>
            <select
              value={formData.parent_id}
              onChange={(e) => setFormData({ ...formData, parent_id: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg"
            >
              <option value="">None (Top Level)</option>
              {accounts.filter(a => a.is_header).map(a => (
                <option key={a.id} value={a.id}>{a.code} - {a.name}</option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="is_header"
              checked={formData.is_header}
              onChange={(e) => setFormData({ ...formData, is_header: e.target.checked })}
              className="rounded"
            />
            <label htmlFor="is_header" className="text-sm text-gray-700">This is a header/group account (not for posting)</label>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
            <textarea
              value={formData.description}
              onChange={(e) => setFormData({ ...formData, description: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg"
              rows={2}
            />
          </div>

          <div className="flex justify-end gap-3 pt-4">
            <button type="button" onClick={() => setModalOpen(false)} className="px-4 py-2 text-gray-700 border rounded-lg hover:bg-gray-50">
              Cancel
            </button>
            <button type="submit" className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700">
              {editingAccount ? 'Update' : 'Create'} Account
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
