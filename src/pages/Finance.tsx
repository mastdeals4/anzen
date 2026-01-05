import { useEffect, useState } from 'react';
import { Layout } from '../components/Layout';
import { Modal } from '../components/Modal';
import { useLanguage } from '../contexts/LanguageContext';
import { useAuth } from '../contexts/AuthContext';
import { supabase } from '../lib/supabase';
import {
  Plus, DollarSign, TrendingUp, TrendingDown,
  CreditCard, Receipt, BookOpen, Building2,
  ArrowDownCircle, ArrowUpCircle, Wallet, FileText, BarChart3,
  ChevronRight, Landmark, Users, AlertCircle, ArrowRightLeft
} from 'lucide-react';
import { BankAccountsManager } from '../components/finance/BankAccountsManager';
import { ReceivablesManager } from '../components/finance/ReceivablesManager';
import { PayablesManager } from '../components/finance/PayablesManager';
import { AgeingReport } from './reports/AgeingReport';
import { FileUpload } from '../components/FileUpload';
import { ChartOfAccountsManager } from '../components/finance/ChartOfAccountsManager';
import { SuppliersManager } from '../components/finance/SuppliersManager';
import { PurchaseInvoiceManager } from '../components/finance/PurchaseInvoiceManager';
import { ReceiptVoucherManager } from '../components/finance/ReceiptVoucherManager';
import { PaymentVoucherManager } from '../components/finance/PaymentVoucherManager';
import { PettyCashManager } from '../components/finance/PettyCashManager';
import { JournalEntryViewer } from '../components/finance/JournalEntryViewer';
import { FinancialReports } from '../components/finance/FinancialReports';
import { BankReconciliationEnhanced as BankReconciliation } from '../components/finance/BankReconciliationEnhanced';
import { ExpenseManager } from '../components/finance/ExpenseManager';
import { TaxReports } from '../components/finance/TaxReports';
import BankLedger from '../components/finance/BankLedger';
import PartyLedger from '../components/finance/PartyLedger';
import OutstandingSummary from '../components/finance/OutstandingSummary';
import { FundTransferManager } from '../components/finance/FundTransferManager';

interface FinanceExpense {
  id: string;
  expense_category: 'duty' | 'freight' | 'warehouse_rent' | 'utilities' | 'salary' | 'other';
  amount: number;
  expense_date: string;
  description: string | null;
  batch_id: string | null;
  document_urls: string[] | null;
  created_at: string;
  batches?: { batch_number: string } | null;
}

interface Batch {
  id: string;
  batch_number: string;
}

type FinanceSection = 'record' | 'track' | 'reports' | 'masters';
type FinanceTab =
  | 'purchase_invoices' | 'receipts' | 'payments' | 'expenses' | 'petty_cash' | 'fund_transfers' | 'journal'
  | 'party_ledger' | 'outstanding' | 'receivables' | 'payables' | 'bank_ledger' | 'reconciliation' | 'ageing'
  | 'trial_balance' | 'pnl' | 'balance_sheet' | 'tax_reports'
  | 'coa' | 'suppliers' | 'banks' | 'tax_codes';

const sectionConfig = {
  record: {
    label: 'Record Transaction',
    icon: Plus,
    color: 'blue',
    description: 'Daily accounting entries',
    tabs: [
      { id: 'purchase_invoices', label: 'Purchase Invoice', icon: Receipt, desc: 'Record supplier invoices' },
      { id: 'receipts', label: 'Receipt Voucher', icon: ArrowDownCircle, desc: 'Record customer payments' },
      { id: 'payments', label: 'Payment Voucher', icon: ArrowUpCircle, desc: 'Record supplier payments' },
      { id: 'expenses', label: 'Expenses', icon: DollarSign, desc: 'Import costs, delivery, admin expenses' },
      { id: 'petty_cash', label: 'Petty Cash', icon: Wallet, desc: 'Small daily expenses' },
      { id: 'fund_transfers', label: 'Fund Transfers', icon: ArrowRightLeft, desc: 'Transfer between accounts' },
      { id: 'journal', label: 'Journal Entry', icon: FileText, desc: 'Manual journal entries' },
    ]
  },
  track: {
    label: 'Track',
    icon: TrendingUp,
    color: 'green',
    description: 'Monitor balances & status',
    tabs: [
      { id: 'party_ledger', label: 'Party Ledger', icon: Users, desc: 'Customer/Supplier account book' },
      { id: 'outstanding', label: 'Outstanding Summary', icon: AlertCircle, desc: 'Aging & follow-up report' },
      { id: 'receivables', label: 'Receivables', icon: TrendingUp, desc: 'Customer outstanding' },
      { id: 'payables', label: 'Payables', icon: TrendingDown, desc: 'Supplier outstanding' },
      { id: 'bank_ledger', label: 'Bank Ledger', icon: BookOpen, desc: 'Bank book / passbook view' },
      { id: 'reconciliation', label: 'Bank Reconciliation', icon: Landmark, desc: 'Match bank statements' },
      { id: 'ageing', label: 'Ageing Report', icon: BarChart3, desc: 'Overdue analysis' },
    ]
  },
  reports: {
    label: 'Reports',
    icon: BarChart3,
    color: 'purple',
    description: 'Financial statements',
    tabs: [
      { id: 'trial_balance', label: 'Trial Balance', icon: FileText, desc: 'Account balances' },
      { id: 'pnl', label: 'Profit & Loss', icon: TrendingUp, desc: 'Income statement' },
      { id: 'balance_sheet', label: 'Balance Sheet', icon: FileText, desc: 'Financial position' },
      { id: 'tax_reports', label: 'Tax Reports (PPN)', icon: Receipt, desc: 'Input/Output PPN for filing' },
    ]
  },
  masters: {
    label: 'Masters',
    icon: BookOpen,
    color: 'gray',
    description: 'Setup & configuration',
    tabs: [
      { id: 'coa', label: 'Chart of Accounts', icon: BookOpen, desc: 'Account structure' },
      { id: 'suppliers', label: 'Suppliers', icon: Building2, desc: 'Vendor master' },
      { id: 'banks', label: 'Bank Accounts', icon: CreditCard, desc: 'Company bank accounts' },
    ]
  }
};

export function Finance() {
  const { t } = useLanguage();
  const { profile } = useAuth();

  // Parse URL hash to get section and tab
  const getFromHash = () => {
    const hash = window.location.hash.slice(1); // Remove #
    const parts = hash.split('/');
    if (parts.length === 2 && parts[0] === 'finance') {
      // Find which section contains this tab
      for (const [section, config] of Object.entries(sectionConfig)) {
        if (config.tabs.some(tab => tab.id === parts[1])) {
          return { section: section as FinanceSection, tab: parts[1] as FinanceTab };
        }
      }
    }
    return { section: 'record' as FinanceSection, tab: 'purchase_invoices' as FinanceTab };
  };

  const initial = getFromHash();
  const [activeSection, setActiveSection] = useState<FinanceSection>(initial.section);
  const [activeTab, setActiveTab] = useState<FinanceTab>(initial.tab);
  const [expenses, setExpenses] = useState<FinanceExpense[]>([]);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingExpense, setEditingExpense] = useState<FinanceExpense | null>(null);
  const [formData, setFormData] = useState({
    expense_category: 'other' as FinanceExpense['expense_category'],
    amount: 0,
    expense_date: new Date().toISOString().split('T')[0],
    description: '',
    batch_id: '',
    document_urls: [] as string[],
  });

  const canManage = profile?.role === 'admin' || profile?.role === 'accounts';

  // Update hash when tab changes
  useEffect(() => {
    window.location.hash = `finance/${activeTab}`;
  }, [activeTab]);

  useEffect(() => {
    if (activeTab === 'petty_cash') {
      loadExpenses();
      loadBatches();
    }
  }, [activeTab]);

  const handleSectionChange = (section: FinanceSection) => {
    setActiveSection(section);
    const firstTab = sectionConfig[section].tabs[0];
    setActiveTab(firstTab.id as FinanceTab);
  };

  const loadExpenses = async () => {
    try {
      setError(null);
      const { data, error: fetchError } = await supabase
        .from('finance_expenses')
        .select('*, batches(batch_number)')
        .order('expense_date', { ascending: false })
        .order('created_at', { ascending: false });
      if (fetchError) throw fetchError;
      setExpenses(data || []);
    } catch (err: any) {
      console.error('Error loading expenses:', err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const loadBatches = async () => {
    try {
      const { data } = await supabase
        .from('batches')
        .select('id, batch_number')
        .order('batch_number');
      setBatches(data || []);
    } catch (err) {
      console.error('Error loading batches:', err);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');
      const expenseData = {
        expense_category: formData.expense_category,
        amount: formData.amount,
        expense_date: formData.expense_date,
        description: formData.description || null,
        batch_id: formData.batch_id || null,
        document_urls: formData.document_urls.length > 0 ? formData.document_urls : null,
      };
      if (editingExpense) {
        const { error } = await supabase
          .from('finance_expenses')
          .update(expenseData)
          .eq('id', editingExpense.id);
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from('finance_expenses')
          .insert([{ ...expenseData, created_by: user.id }]);
        if (error) throw error;
      }
      setModalOpen(false);
      resetForm();
      loadExpenses();
    } catch (err: any) {
      console.error('Error saving expense:', err);
      alert('Failed to save expense: ' + err.message);
    }
  };

  const handleEdit = (expense: FinanceExpense) => {
    setEditingExpense(expense);
    setFormData({
      expense_category: expense.expense_category,
      amount: expense.amount,
      expense_date: expense.expense_date,
      description: expense.description || '',
      batch_id: expense.batch_id || '',
      document_urls: expense.document_urls || [],
    });
    setModalOpen(true);
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Are you sure you want to delete this expense?')) return;
    try {
      const { error } = await supabase.from('finance_expenses').delete().eq('id', id);
      if (error) throw error;
      loadExpenses();
    } catch (err: any) {
      console.error('Error deleting expense:', err);
      alert('Failed to delete expense: ' + err.message);
    }
  };

  const resetForm = () => {
    setEditingExpense(null);
    setFormData({
      expense_category: 'other',
      amount: 0,
      expense_date: new Date().toISOString().split('T')[0],
      description: '',
      batch_id: '',
      document_urls: [],
    });
  };

  const categoryLabels: Record<string, string> = {
    duty: 'Duty & Customs',
    freight: 'Freight',
    warehouse_rent: 'Warehouse Rent',
    utilities: 'Utilities',
    salary: 'Salary',
    other: 'Other',
  };

  const sectionColors = {
    blue: 'bg-blue-600 hover:bg-blue-700 text-white',
    green: 'bg-green-600 hover:bg-green-700 text-white',
    purple: 'bg-purple-600 hover:bg-purple-700 text-white',
    gray: 'bg-gray-600 hover:bg-gray-700 text-white',
  };

  const sectionColorsInactive = {
    blue: 'bg-blue-50 text-blue-700 hover:bg-blue-100 border border-blue-200',
    green: 'bg-green-50 text-green-700 hover:bg-green-100 border border-green-200',
    purple: 'bg-purple-50 text-purple-700 hover:bg-purple-100 border border-purple-200',
    gray: 'bg-gray-50 text-gray-700 hover:bg-gray-100 border border-gray-200',
  };

  const renderContent = () => {
    switch (activeTab) {
      case 'purchase_invoices':
        return <PurchaseInvoiceManager canManage={canManage} />;
      case 'receipts':
        return <ReceiptVoucherManager canManage={canManage} />;
      case 'payments':
        return <PaymentVoucherManager canManage={canManage} />;
      case 'expenses':
        return <ExpenseManager canManage={canManage} />;
      case 'petty_cash':
        return <PettyCashManager canManage={canManage} />;
      case 'fund_transfers':
        return <FundTransferManager canManage={canManage} />;
      case 'journal':
        return <JournalEntryViewer canManage={canManage} />;
      case 'party_ledger':
        return <PartyLedger />;
      case 'outstanding':
        return <OutstandingSummary />;
      case 'receivables':
        return <ReceivablesManager canManage={canManage} />;
      case 'payables':
        return <PayablesManager canManage={canManage} />;
      case 'bank_ledger':
        return <BankLedger />;
      case 'reconciliation':
        return <BankReconciliation canManage={canManage} />;
      case 'ageing':
        return <AgeingReport />;
      case 'trial_balance':
      case 'pnl':
      case 'balance_sheet':
        return <FinancialReports initialReport={activeTab} />;
      case 'tax_reports':
        return <TaxReports />;
      case 'coa':
        return <ChartOfAccountsManager canManage={canManage} />;
      case 'suppliers':
        return <SuppliersManager canManage={canManage} />;
      case 'banks':
        return <BankAccountsManager canManage={canManage} />;
      default:
        return <div className="text-center py-12 text-gray-500">Select a module</div>;
    }
  };

  return (
    <Layout>
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-bold text-gray-900 flex items-center gap-2">
            <DollarSign className="w-6 h-6" />
            Finance & Accounting
          </h1>
        </div>

        <div className="grid grid-cols-4 gap-3">
          {(Object.entries(sectionConfig) as [FinanceSection, typeof sectionConfig.record][]).map(([key, section]) => {
            const Icon = section.icon;
            const isActive = activeSection === key;
            const colorClass = isActive 
              ? sectionColors[section.color as keyof typeof sectionColors]
              : sectionColorsInactive[section.color as keyof typeof sectionColorsInactive];
            
            return (
              <button
                key={key}
                onClick={() => handleSectionChange(key)}
                className={`p-3 rounded-lg transition-all ${colorClass} ${isActive ? 'shadow-md ring-2 ring-offset-2 ring-' + section.color + '-500' : ''}`}
              >
                <div className="flex items-center gap-2">
                  <Icon className="w-5 h-5" />
                  <span className="font-semibold text-sm">{section.label}</span>
                </div>
                <p className={`text-xs mt-1 ${isActive ? 'opacity-90' : 'opacity-70'}`}>
                  {section.description}
                </p>
              </button>
            );
          })}
        </div>

        <div className="flex gap-4">
          <div className="w-48 shrink-0">
            <div className="bg-white rounded-lg shadow-sm border overflow-hidden">
              {sectionConfig[activeSection].tabs.map((tab, idx) => {
                const Icon = tab.icon;
                const isActive = activeTab === tab.id;
                return (
                  <a
                    key={tab.id}
                    href={`#finance/${tab.id}`}
                    onClick={(e) => {
                      e.preventDefault();
                      setActiveTab(tab.id as FinanceTab);
                    }}
                    className={`w-full text-left px-3 py-2.5 flex items-center gap-2 transition-all border-l-3 ${
                      isActive
                        ? 'bg-blue-50 border-l-blue-600 text-blue-700'
                        : 'border-l-transparent hover:bg-gray-50 text-gray-700'
                    } ${idx !== 0 ? 'border-t border-gray-100' : ''}`}
                  >
                    <Icon className={`w-4 h-4 ${isActive ? 'text-blue-600' : 'text-gray-400'}`} />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium truncate">{tab.label}</div>
                    </div>
                    {isActive && <ChevronRight className="w-4 h-4 text-blue-400" />}
                  </a>
                );
              })}
            </div>
          </div>

          <div className="flex-1 min-w-0">
            <div className="bg-white rounded-lg shadow-sm border p-4">
              {renderContent()}
            </div>
          </div>
        </div>
      </div>

      <Modal isOpen={modalOpen} onClose={() => setModalOpen(false)} title={editingExpense ? 'Edit Expense' : 'Add Expense'}>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Category *</label>
              <select
                required
                value={formData.expense_category}
                onChange={(e) => setFormData({ ...formData, expense_category: e.target.value as FinanceExpense['expense_category'] })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 text-sm"
              >
                {Object.entries(categoryLabels).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Amount (Rp) *</label>
              <input
                type="number"
                required
                min={0}
                value={formData.amount}
                onChange={(e) => setFormData({ ...formData, amount: parseFloat(e.target.value) || 0 })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 text-sm"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Date *</label>
              <input
                type="date"
                required
                value={formData.expense_date}
                onChange={(e) => setFormData({ ...formData, expense_date: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Related Batch</label>
              <select
                value={formData.batch_id}
                onChange={(e) => setFormData({ ...formData, batch_id: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 text-sm"
              >
                <option value="">None</option>
                {batches.map(batch => (
                  <option key={batch.id} value={batch.id}>{batch.batch_number}</option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
            <textarea
              value={formData.description}
              onChange={(e) => setFormData({ ...formData, description: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 text-sm"
              rows={2}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Attach Documents</label>
            <FileUpload
              currentUrls={formData.document_urls}
              onUploadComplete={(urls) => setFormData({ ...formData, document_urls: urls })}
              folder="expenses"
            />
          </div>
          <div className="flex justify-end gap-3 pt-4">
            <button type="button" onClick={() => setModalOpen(false)} className="px-4 py-2 text-gray-700 border rounded-lg hover:bg-gray-50 text-sm">
              Cancel
            </button>
            <button type="submit" className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm">
              {editingExpense ? 'Update' : 'Create'} Expense
            </button>
          </div>
        </form>
      </Modal>
    </Layout>
  );
}
