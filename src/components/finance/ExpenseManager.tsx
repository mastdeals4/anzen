import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { Plus, DollarSign, Package, Truck, Building2, Edit, Trash2, FileText, Upload, X, ExternalLink, Download, ArrowRightLeft } from 'lucide-react';
import { Modal } from '../Modal';
import { FileUpload } from '../FileUpload';

interface FinanceExpense {
  id: string;
  expense_category: string;
  amount: number;
  expense_date: string;
  description: string | null;
  batch_id: string | null;
  import_container_id: string | null;
  delivery_challan_id: string | null;
  expense_type: string | null;
  document_urls: string[] | null;
  payment_method: string;
  bank_account_id: string | null;
  payment_reference: string | null;
  petty_cash_transaction_id: string | null;
  created_at: string;
  batches?: { batch_number: string } | null;
  import_containers?: { container_ref: string } | null;
  delivery_challans?: { challan_number: string } | null;
  bank_accounts?: { bank_name: string; account_number: string } | null;
  petty_cash_transactions?: { transaction_number: string } | null;
  bank_statement_lines?: Array<{
    bank_account_id: string;
    bank_accounts?: { bank_name: string; account_number: string } | null;
  }> | null;
}

interface Batch {
  id: string;
  batch_number: string;
}

interface ImportContainer {
  id: string;
  container_ref: string;
}

interface DeliveryChallan {
  id: string;
  challan_number: string;
  challan_date: string;
  customers?: {
    company_name: string;
  } | null;
}

interface BankAccount {
  id: string;
  bank_name: string;
  account_number: string;
}

interface ExpenseManagerProps {
  canManage: boolean;
}

const expenseCategories = [
  {
    value: 'duty_customs',
    label: 'Duty & Customs (BM)',
    type: 'import',
    icon: Building2,
    description: 'Import duties and customs charges - CAPITALIZED to inventory',
    requiresContainer: true,
    group: 'Import Costs'
  },
  {
    value: 'ppn_import',
    label: 'PPN Import',
    type: 'import',
    icon: Building2,
    description: 'Import VAT - CAPITALIZED to inventory',
    requiresContainer: true,
    group: 'Import Costs'
  },
  {
    value: 'pph_import',
    label: 'PPh Import',
    type: 'import',
    icon: Building2,
    description: 'Import withholding tax - CAPITALIZED to inventory',
    requiresContainer: true,
    group: 'Import Costs'
  },
  {
    value: 'freight_import',
    label: 'Freight (Import)',
    type: 'import',
    icon: Package,
    description: 'International freight charges - CAPITALIZED to inventory',
    requiresContainer: true,
    group: 'Import Costs'
  },
  {
    value: 'clearing_forwarding',
    label: 'Clearing & Forwarding',
    type: 'import',
    icon: Building2,
    description: 'Customs clearance - CAPITALIZED to inventory',
    requiresContainer: true,
    group: 'Import Costs'
  },
  {
    value: 'port_charges',
    label: 'Port Charges',
    type: 'import',
    icon: Building2,
    description: 'Port handling charges - CAPITALIZED to inventory',
    requiresContainer: true,
    group: 'Import Costs'
  },
  {
    value: 'container_handling',
    label: 'Container Handling',
    type: 'import',
    icon: Package,
    description: 'Container unloading - CAPITALIZED to inventory',
    requiresContainer: true,
    group: 'Import Costs'
  },
  {
    value: 'transport_import',
    label: 'Transportation (Import)',
    type: 'import',
    icon: Truck,
    description: 'Port to godown transport - CAPITALIZED to inventory',
    requiresContainer: true,
    group: 'Import Costs'
  },
  {
    value: 'loading_import',
    label: 'Loading / Unloading (Import)',
    type: 'import',
    icon: Truck,
    description: 'Import container loading/unloading - CAPITALIZED to inventory',
    requiresContainer: true,
    group: 'Import Costs'
  },
  {
    value: 'delivery_sales',
    label: 'Delivery / Dispatch (Sales)',
    type: 'sales',
    icon: Truck,
    description: 'Customer delivery - EXPENSED to P&L',
    requiresContainer: false,
    group: 'Sales & Distribution'
  },
  {
    value: 'loading_sales',
    label: 'Loading / Unloading (Sales)',
    type: 'sales',
    icon: Truck,
    description: 'Sales loading charges - EXPENSED to P&L',
    requiresContainer: false,
    group: 'Sales & Distribution'
  },
  {
    value: 'salary',
    label: 'Salary',
    type: 'staff',
    icon: DollarSign,
    description: 'Staff salaries - EXPENSED to P&L',
    requiresContainer: false,
    group: 'Staff Costs'
  },
  {
    value: 'staff_overtime',
    label: 'Staff Overtime',
    type: 'staff',
    icon: DollarSign,
    description: 'Overtime payments - EXPENSED to P&L',
    requiresContainer: false,
    group: 'Staff Costs'
  },
  {
    value: 'staff_welfare',
    label: 'Staff Welfare / Allowances',
    type: 'staff',
    icon: DollarSign,
    description: 'Driver food, snacks, overtime meals, welfare - EXPENSED to P&L',
    requiresContainer: false,
    group: 'Staff Costs'
  },
  {
    value: 'travel_conveyance',
    label: 'Travel & Conveyance',
    type: 'staff',
    icon: Truck,
    description: 'Local travel, taxi, fuel reimbursements, tolls - EXPENSED to P&L',
    requiresContainer: false,
    group: 'Staff Costs'
  },
  {
    value: 'warehouse_rent',
    label: 'Warehouse Rent',
    type: 'operations',
    icon: Building2,
    description: 'Rent expense - EXPENSED to P&L',
    requiresContainer: false,
    group: 'Operations'
  },
  {
    value: 'utilities',
    label: 'Utilities',
    type: 'operations',
    icon: Building2,
    description: 'Electricity, water, etc - EXPENSED to P&L',
    requiresContainer: false,
    group: 'Operations'
  },
  {
    value: 'bank_charges',
    label: 'Bank Charges',
    type: 'operations',
    icon: DollarSign,
    description: 'Bank fees, charges, and transaction costs - EXPENSED to P&L',
    requiresContainer: false,
    group: 'Operations'
  },
  {
    value: 'office_admin',
    label: 'Office & Admin',
    type: 'admin',
    icon: Building2,
    description: 'General admin expenses - EXPENSED to P&L',
    requiresContainer: false,
    group: 'Administrative'
  },
  {
    value: 'office_shifting_renovation',
    label: 'Office Shifting & Renovation',
    type: 'admin',
    icon: Building2,
    description: 'Office shifting, partition work, electrical, cabling, interior renovation - EXPENSED to P&L',
    requiresContainer: false,
    group: 'Administrative'
  },
  {
    value: 'other',
    label: 'Other',
    type: 'admin',
    icon: DollarSign,
    description: 'Miscellaneous expenses - EXPENSED to P&L',
    requiresContainer: false,
    group: 'Administrative'
  },
];

export function ExpenseManager({ canManage }: ExpenseManagerProps) {
  const [expenses, setExpenses] = useState<FinanceExpense[]>([]);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [containers, setContainers] = useState<ImportContainer[]>([]);
  const [challans, setChallans] = useState<DeliveryChallan[]>([]);
  const [bankAccounts, setBankAccounts] = useState<BankAccount[]>([]);
  const [reconciledExpenseIds, setReconciledExpenseIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingExpense, setEditingExpense] = useState<FinanceExpense | null>(null);
  const [filterType, setFilterType] = useState<'all' | 'import' | 'sales' | 'staff' | 'operations' | 'admin'>('all');
  const [reconFilter, setReconFilter] = useState<'all' | 'reconciled' | 'not_reconciled'>('all');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [uploadingFiles, setUploadingFiles] = useState<File[]>([]);

  // Default to 1 month date range
  const getDefaultStartDate = () => {
    const date = new Date();
    date.setMonth(date.getMonth() - 1);
    return date.toISOString().split('T')[0];
  };
  const getDefaultEndDate = () => new Date().toISOString().split('T')[0];

  const [startDate, setStartDate] = useState(getDefaultStartDate());
  const [endDate, setEndDate] = useState(getDefaultEndDate());
  const [sortConfig, setSortConfig] = useState<{ key: string; direction: 'asc' | 'desc' } | null>(null);

  const [formData, setFormData] = useState({
    expense_category: 'other',
    amount: 0,
    expense_date: new Date().toISOString().split('T')[0],
    description: '',
    batch_id: '',
    import_container_id: '',
    delivery_challan_id: '',
    payment_method: 'bank_transfer',
    bank_account_id: '',
    payment_reference: '',
    document_urls: [] as string[],
  });

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      setLoading(true);
      const [expensesRes, batchesRes, containersRes, challansRes, banksRes, bankStmtRes] = await Promise.all([
        supabase
          .from('finance_expenses')
          .select(`
            *,
            batches(batch_number),
            import_containers(container_ref),
            delivery_challans(challan_number),
            bank_accounts(bank_name, account_number),
            petty_cash_transactions!petty_cash_transaction_id(transaction_number),
            bank_statement_lines(
              bank_account_id,
              bank_accounts(bank_name, account_number)
            )
          `)
          .neq('paid_by', 'cash')
          .order('expense_date', { ascending: false })
          .order('created_at', { ascending: false }),
        supabase
          .from('batches')
          .select('id, batch_number')
          .order('batch_number'),
        supabase
          .from('import_containers')
          .select('id, container_ref')
          .order('container_ref'),
        supabase
          .from('delivery_challans')
          .select('id, challan_number, challan_date, customers(company_name)')
          .order('challan_number', { ascending: false })
          .limit(50),
        supabase
          .from('bank_accounts')
          .select('id, bank_name, account_number')
          .order('bank_name'),
        supabase
          .from('bank_statement_lines')
          .select('matched_expense_id')
          .not('matched_expense_id', 'is', null),
      ]);

      if (expensesRes.error) throw expensesRes.error;
      setExpenses(expensesRes.data || []);
      setBatches(batchesRes.data || []);
      setContainers(containersRes.data || []);
      setChallans(challansRes.data || []);
      setBankAccounts(banksRes.data || []);

      // Build set of reconciled expense IDs
      const reconciledIds = new Set<string>();
      if (bankStmtRes.data) {
        bankStmtRes.data.forEach(line => {
          if (line.matched_expense_id) {
            reconciledIds.add(line.matched_expense_id);
          }
        });
      }
      setReconciledExpenseIds(reconciledIds);
    } catch (error: any) {
      console.error('Error loading data:', error.message);
      alert('Failed to load expenses');
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    try {
      const category = expenseCategories.find(c => c.value === formData.expense_category);

      // Upload new files first
      const uploadedUrls: string[] = [];
      if (uploadingFiles.length > 0) {
        for (const file of uploadingFiles) {
          const fileName = `${Date.now()}_${file.name}`;
          const filePath = `${formData.expense_category}/${fileName}`;

          const { error: uploadError } = await supabase.storage
            .from('expense-documents')
            .upload(filePath, file);

          if (uploadError) throw uploadError;

          const { data: { publicUrl } } = supabase.storage
            .from('expense-documents')
            .getPublicUrl(filePath);

          uploadedUrls.push(publicUrl);
        }
      }

      // Combine existing URLs with newly uploaded ones
      const allDocumentUrls = [...formData.document_urls, ...uploadedUrls];

      const expenseData = {
        expense_category: formData.expense_category,
        expense_type: category?.type || 'admin',
        amount: formData.amount,
        expense_date: formData.expense_date,
        description: formData.description || null,
        batch_id: formData.batch_id || null,
        import_container_id: formData.import_container_id || null,
        delivery_challan_id: formData.delivery_challan_id || null,
        payment_method: formData.payment_method,
        bank_account_id: formData.bank_account_id || null,
        payment_reference: formData.payment_reference || null,
        paid_by: formData.payment_method === 'cash' ? 'cash' : 'bank',
        document_urls: allDocumentUrls.length > 0 ? allDocumentUrls : null,
      };

      if (editingExpense) {
        // Check if user changed payment method to cash - move to Petty Cash
        if (formData.payment_method === 'cash') {
          const { data: { user } } = await supabase.auth.getUser();
          if (!user) throw new Error('Not authenticated');

          // Generate petty cash transaction number
          const year = new Date().getFullYear().toString().slice(-2);
          const month = (new Date().getMonth() + 1).toString().padStart(2, '0');
          const { count } = await supabase
            .from('petty_cash_transactions')
            .select('*', { count: 'exact', head: true })
            .like('transaction_number', `PCE${year}${month}%`);

          const transactionNumber = `PCE${year}${month}-${String((count || 0) + 1).padStart(4, '0')}`;

          // Create petty cash transaction
          const { error: pettyCashError } = await supabase
            .from('petty_cash_transactions')
            .insert([{
              transaction_number: transactionNumber,
              transaction_date: formData.expense_date,
              transaction_type: 'expense',
              amount: formData.amount,
              description: formData.description || null,
              expense_category: formData.expense_category,
              paid_to: null,
              paid_by_staff_name: null,
              created_by: user.id
            }]);

          if (pettyCashError) throw pettyCashError;

          // Delete from finance_expenses
          const { error: deleteError } = await supabase
            .from('finance_expenses')
            .delete()
            .eq('id', editingExpense.id);

          if (deleteError) throw deleteError;

          alert('Expense moved to Petty Cash successfully');
        } else {
          // Regular update
          const { error } = await supabase
            .from('finance_expenses')
            .update(expenseData)
            .eq('id', editingExpense.id);

          if (error) throw error;
          alert('Expense updated successfully');
        }
      } else {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) throw new Error('Not authenticated');

        // Check if payment method is cash - create in Petty Cash instead
        if (formData.payment_method === 'cash') {
          // Generate petty cash transaction number
          const year = new Date().getFullYear().toString().slice(-2);
          const month = (new Date().getMonth() + 1).toString().padStart(2, '0');
          const { count } = await supabase
            .from('petty_cash_transactions')
            .select('*', { count: 'exact', head: true })
            .like('transaction_number', `PCE${year}${month}%`);

          const transactionNumber = `PCE${year}${month}-${String((count || 0) + 1).padStart(4, '0')}`;

          const { error: pettyCashError } = await supabase
            .from('petty_cash_transactions')
            .insert([{
              transaction_number: transactionNumber,
              transaction_date: formData.expense_date,
              transaction_type: 'expense',
              amount: formData.amount,
              description: formData.description || null,
              expense_category: formData.expense_category,
              paid_to: null,
              paid_by_staff_name: null,
              created_by: user.id
            }]);

          if (pettyCashError) throw pettyCashError;
          alert('Expense recorded in Petty Cash successfully');
        } else {
          const { error } = await supabase
            .from('finance_expenses')
            .insert([{ ...expenseData, created_by: user.id }]);

          if (error) throw error;
          alert('Expense recorded successfully');
        }
      }

      setModalOpen(false);
      resetForm();
      loadData();
    } catch (error: any) {
      console.error('Error saving expense:', error.message);
      // Show clear error message from backend validation
      const errorMessage = error.message || 'Unknown error occurred';
      if (errorMessage.includes('Import expenses must be linked')) {
        alert('❌ Context Required\n\nImport expenses must be linked to an Import Container.\nPlease select a container before saving.');
      } else {
        alert('Failed to save expense:\n\n' + errorMessage);
      }
    }
  };

  const handleEdit = (expense: FinanceExpense) => {
    setEditingExpense(expense);

    // Check if expense is reconciled to a bank statement
    const reconciledBankInfo = expense.bank_statement_lines && expense.bank_statement_lines.length > 0
      ? expense.bank_statement_lines[0]
      : null;

    // Use reconciled bank info if available, otherwise use expense's own payment info
    const effectiveBankAccountId = reconciledBankInfo?.bank_account_id || expense.bank_account_id || '';
    const effectivePaymentMethod = reconciledBankInfo?.bank_account_id
      ? 'bank_transfer'
      : (expense.payment_method || 'cash');

    setFormData({
      expense_category: expense.expense_category,
      amount: expense.amount,
      expense_date: expense.expense_date,
      description: expense.description || '',
      batch_id: expense.batch_id || '',
      import_container_id: expense.import_container_id || '',
      delivery_challan_id: expense.delivery_challan_id || '',
      payment_method: effectivePaymentMethod,
      bank_account_id: effectiveBankAccountId,
      payment_reference: expense.payment_reference || '',
      document_urls: expense.document_urls || [],
    });
    setModalOpen(true);
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Are you sure you want to delete this expense?')) return;

    try {
      const { error } = await supabase
        .from('finance_expenses')
        .delete()
        .eq('id', id);

      if (error) throw error;
      alert('Expense deleted successfully');
      loadData();
    } catch (error: any) {
      console.error('Error deleting expense:', error.message);
      alert('Failed to delete expense: ' + error.message);
    }
  };

  const handleMoveToPettyCash = async (expenseId: string) => {
    if (!confirm('Move this expense to Petty Cash? This will link it to the petty cash system.')) return;

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const { data, error } = await supabase.rpc('move_expense_to_petty_cash', {
        p_expense_id: expenseId,
        p_user_id: user.id
      });

      if (error) throw error;

      alert('Expense moved to Petty Cash successfully!');
      loadData();
    } catch (error: any) {
      console.error('Error moving expense:', error.message);
      alert('Failed to move expense: ' + error.message);
    }
  };

  const handleUnlinkFromBankStatement = async (expenseId: string) => {
    if (!confirm(
      'Are you sure you want to unlink this expense from the bank statement?\n\n' +
      'The bank statement line will be set back to "Unmatched" status.'
    )) return;

    try {
      const { error } = await supabase
        .from('bank_statement_lines')
        .update({
          expense_id: null,
          status: 'unmatched',
          matched_date: null
        })
        .eq('expense_id', expenseId);

      if (error) throw error;

      alert('Expense unlinked from bank statement successfully');
      setModalOpen(false);
      setEditingExpense(null);
      resetForm();
      loadData();
    } catch (error: any) {
      console.error('Error unlinking expense:', error.message);
      alert('Failed to unlink expense: ' + error.message);
    }
  };

  const handleRemoveDocument = (urlToRemove: string) => {
    setFormData({
      ...formData,
      document_urls: formData.document_urls.filter(url => url !== urlToRemove)
    });
  };

  const handleRemoveUploadingFile = (indexToRemove: number) => {
    setUploadingFiles(uploadingFiles.filter((_, index) => index !== indexToRemove));
  };

  const resetForm = () => {
    setEditingExpense(null);
    setUploadingFiles([]);
    setFormData({
      expense_category: 'other',
      amount: 0,
      expense_date: new Date().toISOString().split('T')[0],
      description: '',
      batch_id: '',
      import_container_id: '',
      delivery_challan_id: '',
      payment_method: 'bank_transfer',
      bank_account_id: '',
      payment_reference: '',
      document_urls: [],
    });
  };

  const selectedCategory = expenseCategories.find(c => c.value === formData.expense_category);
  const requiresContainer = selectedCategory?.type === 'import';
  const requiresDC = selectedCategory?.type === 'sales';

  const filteredExpenses = expenses.filter(exp => {
    // Filter by type
    if (filterType !== 'all') {
      const cat = expenseCategories.find(c => c.value === exp.expense_category);
      if (cat?.type !== filterType) return false;
    }

    // Filter by specific category
    if (categoryFilter !== 'all' && exp.expense_category !== categoryFilter) {
      return false;
    }

    // Filter by reconciliation status
    if (reconFilter === 'reconciled') {
      if (!reconciledExpenseIds.has(exp.id)) return false;
    } else if (reconFilter === 'not_reconciled') {
      if (reconciledExpenseIds.has(exp.id)) return false;
    }

    // Filter by date range
    if (startDate && exp.expense_date < startDate) return false;
    if (endDate && exp.expense_date > endDate) return false;

    return true;
  });

  // Sorting function
  const handleSort = (key: string) => {
    let direction: 'asc' | 'desc' = 'asc';
    if (sortConfig && sortConfig.key === key && sortConfig.direction === 'asc') {
      direction = 'desc';
    }
    setSortConfig({ key, direction });
  };

  const sortedExpenses = [...filteredExpenses].sort((a, b) => {
    if (!sortConfig) return 0;

    const { key, direction } = sortConfig;
    let aValue: any;
    let bValue: any;

    if (key === 'date') {
      aValue = new Date(a.expense_date).getTime();
      bValue = new Date(b.expense_date).getTime();
    } else if (key === 'category') {
      const aCat = expenseCategories.find(c => c.value === a.expense_category);
      const bCat = expenseCategories.find(c => c.value === b.expense_category);
      aValue = aCat?.label?.toLowerCase() || '';
      bValue = bCat?.label?.toLowerCase() || '';
    } else if (key === 'amount') {
      aValue = Number(a.amount) || 0;
      bValue = Number(b.amount) || 0;
    } else if (key === 'description') {
      aValue = (a.description || '').toLowerCase();
      bValue = (b.description || '').toLowerCase();
    } else {
      aValue = a[key as keyof FinanceExpense];
      bValue = b[key as keyof FinanceExpense];
      if (typeof aValue === 'string') aValue = aValue.toLowerCase();
      if (typeof bValue === 'string') bValue = bValue.toLowerCase();
    }

    if (aValue < bValue) return direction === 'asc' ? -1 : 1;
    if (aValue > bValue) return direction === 'asc' ? 1 : -1;
    return 0;
  });

  const exportToCSV = () => {
    if (filteredExpenses.length === 0) {
      alert('No expenses to export');
      return;
    }

    const headers = ['Date', 'Category', 'Description', 'Amount'];
    const rows = filteredExpenses.map(exp => {
      const category = expenseCategories.find(c => c.value === exp.expense_category);
      return [
        exp.expense_date,
        category?.label || exp.expense_category,
        exp.description || '',
        exp.amount.toString()
      ];
    });

    const csvContent = [
      headers.join(','),
      ...rows.map(row => row.map(cell => `"${cell}"`).join(','))
    ].join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.setAttribute('href', url);
    link.setAttribute('download', `expenses_${startDate || 'all'}_to_${endDate || 'all'}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const getTypeColor = (type: string) => {
    switch (type) {
      case 'import': return 'bg-blue-100 text-blue-800 border-blue-300';
      case 'sales': return 'bg-green-100 text-green-800 border-green-300';
      case 'staff': return 'bg-purple-100 text-purple-800 border-purple-300';
      case 'operations': return 'bg-orange-100 text-orange-800 border-orange-300';
      case 'admin': return 'bg-gray-100 text-gray-800 border-gray-300';
      default: return 'bg-gray-100 text-gray-800 border-gray-300';
    }
  };

  const formatCurrency = (amount: number) => {
    return `Rp ${amount?.toLocaleString('id-ID')}`;
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const year = date.getFullYear();
    return `${day}/${month}/${year}`;
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold text-gray-900">Expense Tracker</h2>
          <p className="text-sm text-gray-600">Track import costs, delivery expenses, and operational costs</p>
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
            Record Expense
          </button>
        )}
      </div>

      <div className="space-y-3">
        <div className="flex gap-2 border-b border-gray-200 overflow-x-auto">
          {[
            { value: 'all', label: 'All Expenses' },
            { value: 'import', label: 'Import Costs' },
            { value: 'sales', label: 'Sales/Delivery' },
            { value: 'staff', label: 'Staff Costs' },
            { value: 'operations', label: 'Operations' },
            { value: 'admin', label: 'Admin' },
          ].map((tab) => (
            <button
              key={tab.value}
              onClick={() => setFilterType(tab.value as any)}
              className={`px-4 py-2 font-medium transition-colors whitespace-nowrap ${
                filterType === tab.value
                  ? 'text-blue-600 border-b-2 border-blue-600'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="flex gap-2 items-center">
          <span className="text-sm font-medium text-gray-700">Bank Reconciliation:</span>
          {[
            { value: 'all', label: 'All', count: expenses.length },
            { value: 'reconciled', label: 'Reconciled', count: expenses.filter(e => reconciledExpenseIds.has(e.id)).length },
            { value: 'not_reconciled', label: 'Not Reconciled', count: expenses.filter(e => !reconciledExpenseIds.has(e.id)).length },
          ].map((filter) => (
            <button
              key={filter.value}
              onClick={() => setReconFilter(filter.value as any)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                reconFilter === filter.value
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
            >
              {filter.label} ({filter.count})
            </button>
          ))}
        </div>

        <div className="flex gap-3 items-center bg-gray-50 p-3 rounded-lg flex-wrap">
          <span className="text-sm font-medium text-gray-700">Date Filter:</span>
          <input
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            placeholder="Start Date"
            className="px-3 py-1.5 border border-gray-300 rounded-lg text-sm"
          />
          <span className="text-gray-500">to</span>
          <input
            type="date"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            placeholder="End Date"
            className="px-3 py-1.5 border border-gray-300 rounded-lg text-sm"
          />
          {(startDate || endDate) && (
            <button
              onClick={() => {
                setStartDate(getDefaultStartDate());
                setEndDate(getDefaultEndDate());
              }}
              className="px-3 py-1.5 bg-gray-200 text-gray-700 rounded-lg text-sm hover:bg-gray-300"
            >
              Reset to 1 Month
            </button>
          )}

          <span className="text-sm font-medium text-gray-700 ml-4">Category:</span>
          <select
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            className="px-3 py-1.5 border border-gray-300 rounded-lg text-sm min-w-[200px]"
          >
            <option value="all">All Categories</option>
            {expenseCategories
              .sort((a, b) => {
                const groupOrder = { 'Import': 1, 'Sales/Delivery': 2, 'Staff': 3, 'Operations': 4, 'Administrative': 5 };
                const aOrder = groupOrder[a.group as keyof typeof groupOrder] || 999;
                const bOrder = groupOrder[b.group as keyof typeof groupOrder] || 999;
                if (aOrder !== bOrder) return aOrder - bOrder;
                return a.label.localeCompare(b.label);
              })
              .map((category) => (
                <option key={category.value} value={category.value}>
                  {category.label} ({category.group})
                </option>
              ))}
          </select>
          {categoryFilter !== 'all' && (
            <button
              onClick={() => setCategoryFilter('all')}
              className="px-3 py-1.5 bg-gray-200 text-gray-700 rounded-lg text-sm hover:bg-gray-300"
            >
              Clear Category
            </button>
          )}

          <button
            onClick={exportToCSV}
            disabled={filteredExpenses.length === 0}
            className="ml-auto px-4 py-1.5 bg-green-600 text-white rounded-lg text-sm hover:bg-green-700 disabled:bg-gray-300 disabled:cursor-not-allowed flex items-center gap-2"
          >
            <Download className="w-4 h-4" />
            Export to CSV ({filteredExpenses.length})
          </button>
        </div>
      </div>

      <div className="bg-white rounded-lg shadow overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th
                onClick={() => handleSort('date')}
                className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase cursor-pointer hover:bg-gray-100 select-none"
              >
                <div className="flex items-center gap-1">
                  Date
                  {sortConfig?.key === 'date' && (
                    <span className="text-blue-600">{sortConfig.direction === 'asc' ? '↑' : '↓'}</span>
                  )}
                </div>
              </th>
              <th
                onClick={() => handleSort('category')}
                className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase cursor-pointer hover:bg-gray-100 select-none"
              >
                <div className="flex items-center gap-1">
                  Category
                  {sortConfig?.key === 'category' && (
                    <span className="text-blue-600">{sortConfig.direction === 'asc' ? '↑' : '↓'}</span>
                  )}
                </div>
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Context</th>
              <th
                onClick={() => handleSort('description')}
                className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase cursor-pointer hover:bg-gray-100 select-none"
              >
                <div className="flex items-center gap-1">
                  Description
                  {sortConfig?.key === 'description' && (
                    <span className="text-blue-600">{sortConfig.direction === 'asc' ? '↑' : '↓'}</span>
                  )}
                </div>
              </th>
              <th
                onClick={() => handleSort('amount')}
                className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase cursor-pointer hover:bg-gray-100 select-none"
              >
                <div className="flex items-center justify-end gap-1">
                  Amount
                  {sortConfig?.key === 'amount' && (
                    <span className="text-blue-600">{sortConfig.direction === 'asc' ? '↑' : '↓'}</span>
                  )}
                </div>
              </th>
              <th className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase">Payment Method</th>
              <th className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase">Treatment</th>
              <th className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase">Bank Recon</th>
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
            ) : filteredExpenses.length === 0 ? (
              <tr>
                <td colSpan={canManage ? 9 : 8} className="px-6 py-8 text-center text-gray-500">
                  No expenses found
                </td>
              </tr>
            ) : (
              sortedExpenses.map((expense) => {
                const category = expenseCategories.find(c => c.value === expense.expense_category);
                const isReconciled = reconciledExpenseIds.has(expense.id);

                // Get bank info from reconciled statement line
                const reconciledBankInfo = expense.bank_statement_lines && expense.bank_statement_lines.length > 0
                  ? expense.bank_statement_lines[0].bank_accounts
                  : null;

                return (
                  <tr key={expense.id} className="hover:bg-gray-50">
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="text-sm text-gray-900">
                        {formatDate(expense.expense_date)}
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <div className="text-sm font-medium text-gray-900">
                        {category?.label || expense.expense_category}
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      {expense.import_container_id && expense.import_containers ? (
                        <div className="flex items-center gap-2 text-sm">
                          <Package className="w-4 h-4 text-blue-600 flex-shrink-0" />
                          <span className="text-blue-700 font-medium">
                            {expense.import_containers.container_ref}
                          </span>
                        </div>
                      ) : expense.delivery_challan_id && expense.delivery_challans ? (
                        <div className="flex items-center gap-2 text-sm">
                          <Truck className="w-4 h-4 text-green-600 flex-shrink-0" />
                          <span className="text-green-700 font-medium">
                            {expense.delivery_challans.challan_number}
                          </span>
                        </div>
                      ) : category?.requiresContainer ? (
                        <span className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-red-700 bg-red-50 border border-red-200 rounded">
                          ⚠️ Missing Context
                        </span>
                      ) : (
                        <span className="text-gray-400 text-sm italic">No link</span>
                      )}
                    </td>
                    <td className="px-6 py-4">
                      <div className="text-sm text-gray-700">{expense.description || '-'}</div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-right">
                      <div className="text-sm font-medium text-gray-900">
                        {formatCurrency(expense.amount)}
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-center">
                      {expense.petty_cash_transaction_id && expense.petty_cash_transactions ? (
                        <div className="text-sm">
                          <div className="inline-flex items-center gap-1 px-2 py-1 bg-green-50 border border-green-200 rounded text-green-700 font-medium">
                            💰 Petty Cash
                          </div>
                          <div className="text-xs text-gray-500 mt-1">{expense.petty_cash_transactions.transaction_number}</div>
                        </div>
                      ) : isReconciled && reconciledBankInfo ? (
                        <div className="text-sm">
                          <div className="font-medium text-blue-700">{reconciledBankInfo.bank_name}</div>
                          <div className="text-xs text-gray-500">{reconciledBankInfo.account_number}</div>
                        </div>
                      ) : expense.bank_account_id && expense.bank_accounts ? (
                        <div className="text-sm">
                          <div className="font-medium text-gray-700">{expense.bank_accounts.bank_name}</div>
                          <div className="text-xs text-gray-500">{expense.bank_accounts.account_number}</div>
                        </div>
                      ) : (
                        <span className="text-sm text-gray-600 capitalize">{expense.payment_method}</span>
                      )}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-center">
                      <span className={`inline-flex px-2 py-1 text-xs font-medium rounded border ${getTypeColor(category?.type || 'admin')}`}>
                        {category?.type === 'import' && 'CAPITALIZED'}
                        {category?.type === 'sales' && 'EXPENSE'}
                        {category?.type === 'admin' && 'EXPENSE'}
                      </span>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-center">
                      {isReconciled ? (
                        <span className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-green-700 bg-green-50 border border-green-300 rounded">
                          ✓ Linked to Bank
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-orange-700 bg-orange-50 border border-orange-300 rounded">
                          ⚠ Not Reconciled
                        </span>
                      )}
                    </td>
                    {canManage && (
                      <td className="px-6 py-4 whitespace-nowrap text-center">
                        <div className="flex items-center justify-center gap-2">
                          <button
                            onClick={() => handleEdit(expense)}
                            className="text-blue-600 hover:text-blue-800"
                            title="Edit"
                          >
                            <Edit className="w-4 h-4" />
                          </button>
                          {!expense.petty_cash_transaction_id && (
                            <button
                              onClick={() => handleMoveToPettyCash(expense.id)}
                              className="text-green-600 hover:text-green-800"
                              title="Move to Petty Cash"
                            >
                              <ArrowRightLeft className="w-4 h-4" />
                            </button>
                          )}
                          <button
                            onClick={() => handleDelete(expense.id)}
                            className="text-red-600 hover:text-red-800"
                            title="Delete"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </td>
                    )}
                  </tr>
                );
              })
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
          title={editingExpense ? 'Edit Expense' : 'Record New Expense'}
          maxWidth="max-w-2xl"
        >
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Expense Category <span className="text-red-500">*</span>
              </label>
              <select
                value={formData.expense_category}
                onChange={(e) => {
                  const newCategory = e.target.value;
                  const cat = expenseCategories.find(c => c.value === newCategory);
                  // Clear container/DC when changing categories
                  setFormData({
                    ...formData,
                    expense_category: newCategory,
                    import_container_id: cat?.type === 'import' ? formData.import_container_id : '',
                    delivery_challan_id: cat?.type === 'sales' ? formData.delivery_challan_id : ''
                  });
                }}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
                required
              >
                <option value="">Select Category</option>

                {/* Import Costs - Capitalized to Inventory */}
                <optgroup label="═══ IMPORT COSTS (Capitalized to Inventory) ═══">
                  {expenseCategories.filter(c => c.group === 'Import Costs').map((cat) => (
                    <option key={cat.value} value={cat.value}>
                      {cat.label} [Requires Container]
                    </option>
                  ))}
                </optgroup>

                {/* Sales & Distribution - P&L Expense */}
                <optgroup label="═══ SALES & DISTRIBUTION (P&L Expense) ═══">
                  {expenseCategories.filter(c => c.group === 'Sales & Distribution').map((cat) => (
                    <option key={cat.value} value={cat.value}>
                      {cat.label}
                    </option>
                  ))}
                </optgroup>

                {/* Staff Costs - P&L Expense */}
                <optgroup label="═══ STAFF COSTS (P&L Expense) ═══">
                  {expenseCategories.filter(c => c.group === 'Staff Costs').map((cat) => (
                    <option key={cat.value} value={cat.value}>
                      {cat.label}
                    </option>
                  ))}
                </optgroup>

                {/* Operations - P&L Expense */}
                <optgroup label="═══ OPERATIONS (P&L Expense) ═══">
                  {expenseCategories.filter(c => c.group === 'Operations').map((cat) => (
                    <option key={cat.value} value={cat.value}>
                      {cat.label}
                    </option>
                  ))}
                </optgroup>

                {/* Administrative - P&L Expense */}
                <optgroup label="═══ ADMINISTRATIVE (P&L Expense) ═══">
                  {expenseCategories.filter(c => c.group === 'Administrative').map((cat) => (
                    <option key={cat.value} value={cat.value}>
                      {cat.label}
                    </option>
                  ))}
                </optgroup>
              </select>
              {selectedCategory && (
                <div className={`mt-2 p-3 rounded-lg border ${getTypeColor(selectedCategory.type)}`}>
                  <p className="text-sm font-medium">{selectedCategory.description}</p>
                  {selectedCategory.requiresContainer && (
                    <p className="text-xs font-semibold text-red-600 mt-1">
                      ⚠️ Must be linked to Import Container
                    </p>
                  )}
                </div>
              )}
            </div>

            {requiresContainer && (
              <div className="bg-blue-50 border-2 border-blue-300 rounded-lg p-4">
                <label className="block text-sm font-medium text-blue-900 mb-2">
                  <Package className="w-4 h-4 inline mr-1" />
                  Import Container <span className="text-red-500">* REQUIRED</span>
                </label>
                <select
                  value={formData.import_container_id}
                  onChange={(e) => setFormData({ ...formData, import_container_id: e.target.value })}
                  className="w-full px-3 py-2 border border-blue-300 rounded-lg bg-white"
                  required={requiresContainer}
                >
                  <option value="">Select Container (Required)</option>
                  {containers.map((container) => (
                    <option key={container.id} value={container.id}>
                      {container.container_ref}
                    </option>
                  ))}
                </select>
                <p className="mt-2 text-xs text-blue-800 font-medium">
                  ✓ This expense will be CAPITALIZED to inventory and allocated to batches
                </p>
                <p className="mt-1 text-xs text-red-700 font-semibold">
                  ⚠️ Backend will block saving without a container selection
                </p>
              </div>
            )}

            {requiresDC && (
              <div className="bg-green-50 border border-green-200 rounded-lg p-4">
                <label className="block text-sm font-medium text-green-900 mb-2">
                  Delivery Challan (Optional)
                </label>
                <select
                  value={formData.delivery_challan_id}
                  onChange={(e) => setFormData({ ...formData, delivery_challan_id: e.target.value })}
                  className="w-full px-3 py-2 border border-green-300 rounded-lg"
                >
                  <option value="">Select DC (Optional)</option>
                  {challans.map((challan) => (
                    <option key={challan.id} value={challan.id}>
                      {challan.challan_number} - {new Date(challan.challan_date).toLocaleDateString('en-GB')} - {challan.customers?.company_name || 'No Customer'}
                    </option>
                  ))}
                </select>
                <p className="mt-2 text-xs text-green-700">
                  This expense will be EXPENSED to P&L (not capitalized)
                </p>
              </div>
            )}

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Date <span className="text-red-500">*</span>
                </label>
                <input
                  type="date"
                  value={formData.expense_date}
                  onChange={(e) => setFormData({ ...formData, expense_date: e.target.value })}
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
                  value={formData.amount}
                  onChange={(e) => setFormData({ ...formData, amount: parseFloat(e.target.value) || 0 })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                  required
                />
              </div>
            </div>

            {/* Payment Method Section */}
            <div className="border-2 border-blue-200 rounded-lg p-4 bg-blue-50">
              <h3 className="text-sm font-semibold text-blue-900 mb-3">Payment Details</h3>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Payment Method <span className="text-red-500">*</span>
                  </label>
                  <select
                    value={formData.payment_method}
                    onChange={(e) => setFormData({ ...formData, payment_method: e.target.value, bank_account_id: e.target.value === 'cash' ? '' : formData.bank_account_id })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                    required
                  >
                    <option value="cash">💵 Cash (→ Petty Cash)</option>
                    <option value="bank_transfer">🏦 Bank Transfer (→ Expense Tracker)</option>
                    <option value="check">Check (→ Expense Tracker)</option>
                    <option value="giro">Giro (→ Expense Tracker)</option>
                    <option value="other">Other (→ Expense Tracker)</option>
                  </select>
                  <p className="text-xs text-gray-600 mt-1">
                    {formData.payment_method === 'cash'
                      ? '✓ Will go to Petty Cash'
                      : '✓ Will appear in Bank Reconciliation'}
                  </p>
                </div>

                {formData.payment_method !== 'cash' && (
                  <>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Bank Account <span className="text-red-500">*</span>
                      </label>
                      <select
                        value={formData.bank_account_id}
                        onChange={(e) => setFormData({ ...formData, bank_account_id: e.target.value })}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                        required={formData.payment_method !== 'cash'}
                      >
                        <option value="">Select Bank Account</option>
                        {bankAccounts.map((bank) => (
                          <option key={bank.id} value={bank.id}>
                            {bank.bank_name} - {bank.account_number}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Reference (Check#/Transfer ID)
                      </label>
                      <input
                        type="text"
                        value={formData.payment_reference}
                        onChange={(e) => setFormData({ ...formData, payment_reference: e.target.value })}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                        placeholder="Enter reference number"
                      />
                    </div>
                  </>
                )}
              </div>
            </div>

            {/* Linked Bank Statement Section */}
            {editingExpense && editingExpense.bank_statement_lines && editingExpense.bank_statement_lines.length > 0 && (
              <div className="p-4 bg-blue-50 border border-blue-200 rounded-lg">
                <div className="flex items-start justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <FileText className="w-5 h-5 text-blue-600" />
                    <h4 className="font-semibold text-blue-900">Linked to Bank Statement</h4>
                  </div>
                  {canManage && (
                    <button
                      type="button"
                      onClick={() => handleUnlinkFromBankStatement(editingExpense.id)}
                      className="text-sm text-red-600 hover:text-red-700 font-medium"
                    >
                      Unlink
                    </button>
                  )}
                </div>
                <div className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-gray-600">Bank Account:</span>
                    <span className="font-medium text-gray-900">
                      {editingExpense.bank_statement_lines[0]?.bank_accounts?.bank_name || 'Unknown'} - {editingExpense.bank_statement_lines[0]?.bank_accounts?.account_number || ''}
                    </span>
                  </div>
                  <div className="pt-2 border-t border-blue-200">
                    <p className="text-xs text-gray-600">
                      This expense is linked to a bank statement line. If incorrectly linked, click "Unlink" to remove the connection.
                    </p>
                  </div>
                </div>
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
              <textarea
                value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                rows={2}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg"
              />
            </div>

            <div className="border-t pt-4">
              <label className="block text-sm font-medium text-gray-700 mb-2">
                <FileText className="w-4 h-4 inline mr-1" />
                Supporting Documents (Invoices, Receipts, Bills)
              </label>

              {/* Existing documents */}
              {formData.document_urls.length > 0 && (
                <div className="mb-3 space-y-2">
                  <p className="text-xs text-gray-600 font-medium">Uploaded Documents:</p>
                  {formData.document_urls.map((url, index) => (
                    <div key={index} className="flex items-center gap-2 p-2 bg-green-50 border border-green-200 rounded">
                      <FileText className="w-4 h-4 text-green-600 flex-shrink-0" />
                      <a
                        href={url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex-1 text-sm text-green-700 hover:text-green-900 truncate"
                      >
                        Document {index + 1}
                      </a>
                      <a
                        href={url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="p-1 text-green-600 hover:bg-green-100 rounded"
                      >
                        <ExternalLink className="w-3 h-3" />
                      </a>
                      <button
                        type="button"
                        onClick={() => handleRemoveDocument(url)}
                        className="p-1 text-red-600 hover:bg-red-100 rounded"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {/* Files being uploaded */}
              {uploadingFiles.length > 0 && (
                <div className="mb-3 space-y-2">
                  <p className="text-xs text-gray-600 font-medium">Files to Upload:</p>
                  {uploadingFiles.map((file, index) => (
                    <div key={index} className="flex items-center gap-2 p-2 bg-blue-50 border border-blue-200 rounded">
                      <Upload className="w-4 h-4 text-blue-600 flex-shrink-0" />
                      <span className="flex-1 text-sm text-blue-700 truncate">{file.name}</span>
                      <span className="text-xs text-blue-600">{(file.size / 1024).toFixed(1)} KB</span>
                      <button
                        type="button"
                        onClick={() => handleRemoveUploadingFile(index)}
                        className="p-1 text-red-600 hover:bg-red-100 rounded"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {/* File upload component */}
              <FileUpload
                onFilesSelected={(files) => setUploadingFiles([...uploadingFiles, ...files])}
                accept="image/*,.pdf,.doc,.docx,.xls,.xlsx"
                multiple
              />
              <p className="text-xs text-gray-500 mt-1">
                Upload invoices, receipts, or bills (PDF, images, or documents)
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
                {editingExpense ? 'Update' : 'Record'} Expense
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
