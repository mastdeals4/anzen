import { useEffect, useState, useCallback } from 'react';
import { supabase } from '../../lib/supabase';
import { Plus, Wallet, ArrowDownCircle, ArrowUpCircle, RefreshCw, Upload, X, FileText, Image, Eye, Edit2, Trash2, ExternalLink, Download, Clipboard, DollarSign, Package, Truck, Building2 } from 'lucide-react';
import { Modal } from '../Modal';
import { useFinance } from '../../contexts/FinanceContext';
import { useAuth } from '../../contexts/AuthContext';
import { showToast } from '../ToastNotification';
import { showConfirm } from '../ConfirmDialog';

interface PettyCashDocument {
  id: string;
  file_type: string;
  file_name: string;
  file_url: string;
  file_size: number | null;
  uploaded_at?: string;
  created_at?: string;
}

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
  import_container_id: string | null;
  delivery_challan_id: string | null;
  voucher_number: string | null;
  bank_accounts?: { account_name: string; bank_name: string; alias: string | null; currency: string } | null;
  import_containers?: { container_ref: string } | null;
  delivery_challans?: { challan_number: string } | null;
  created_at: string;
  petty_cash_documents?: PettyCashDocument[];
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
  alias: string | null;
  currency: string;
}

interface PettyCashManagerProps {
  canManage: boolean;
  onNavigateToFundTransfer?: () => void;
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
    type: 'operations',
    icon: DollarSign,
    description: 'Import VAT - EXPENSED to P&L',
    requiresContainer: false,
    group: 'Operations'
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
    value: 'bpom_ski_fees',
    label: 'BPOM / SKI Fees',
    type: 'import',
    icon: FileText,
    description: 'BPOM/SKI regulatory fees - CAPITALIZED to inventory',
    requiresContainer: true,
    group: 'Import Costs'
  },
  {
    value: 'other_import',
    label: 'Other (Import)',
    type: 'import',
    icon: DollarSign,
    description: 'Other import-related expenses - CAPITALIZED to inventory',
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
    value: 'other_sales',
    label: 'Other (Sales)',
    type: 'sales',
    icon: DollarSign,
    description: 'Other sales-related expenses - EXPENSED to P&L',
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
    value: 'fixed_assets',
    label: 'Fixed Assets / Equipment',
    type: 'assets',
    icon: Package,
    description: 'Purchase of fixed assets - CAPITALIZED (see Asset Guide)',
    requiresContainer: false,
    group: 'Assets'
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

export function PettyCashManager({ canManage, onNavigateToFundTransfer }: PettyCashManagerProps) {
  const [transactions, setTransactions] = useState<PettyCashTransaction[]>([]);
  const [containers, setContainers] = useState<ImportContainer[]>([]);
  const [challans, setChallans] = useState<DeliveryChallan[]>([]);
  const [bankAccounts, setBankAccounts] = useState<BankAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [viewModalOpen, setViewModalOpen] = useState(false);
  const [viewingTransaction, setViewingTransaction] = useState<PettyCashTransaction | null>(null);
  const [editingTransaction, setEditingTransaction] = useState<PettyCashTransaction | null>(null);
  const [cashBalance, setCashBalance] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [uploadingFiles, setUploadingFiles] = useState<File[]>([]);
  const [existingDocuments, setExistingDocuments] = useState<PettyCashDocument[]>([]);
  const [sortConfig, setSortConfig] = useState<{ key: string; direction: 'asc' | 'desc' } | null>(null);
  const [showPasteHint, setShowPasteHint] = useState(false);
  const [filterType, setFilterType] = useState<'all' | 'import' | 'sales' | 'staff' | 'operations' | 'admin' | 'assets'>('all');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');

  const { dateRange } = useFinance();
  const { profile } = useAuth();
  const startDate = dateRange.startDate;
  const endDate = dateRange.endDate;

  const [formData, setFormData] = useState({
    transaction_type: 'expense' as 'withdraw' | 'expense',
    transaction_date: new Date().toISOString().split('T')[0],
    amount: 0,
    description: '',
    expense_category: '',
    bank_account_id: '',
    paid_to: '',
    paid_by_staff_name: '',
    paid_by: 'cash' as 'cash' | 'bank',
    source: '',
    received_by_staff_name: '',
    import_container_id: '',
    delivery_challan_id: '',
  });

  const loadData = useCallback(async () => {
    try {
      const [txRes, balanceRes, containersRes, challansRes, bankRes] = await Promise.all([
        supabase
          .from('petty_cash_transactions')
          .select(`
            *,
            bank_accounts:bank_account_id (
              account_name,
              bank_name,
              alias,
              currency
            ),
            import_containers:import_container_id (
              container_ref
            ),
            delivery_challans:delivery_challan_id (
              challan_number
            ),
            petty_cash_documents (*)
          `)
          .gte('transaction_date', startDate)
          .lte('transaction_date', endDate)
          .order('transaction_date', { ascending: false })
          .order('transaction_number', { ascending: false }),

        supabase.rpc('get_petty_cash_balance'),

        supabase
          .from('import_containers')
          .select('id, container_ref')
          .order('container_ref', { ascending: false }),

        supabase
          .from('delivery_challans')
          .select(`
            id,
            challan_number,
            challan_date,
            customers:customer_id (
              company_name
            )
          `)
          .order('challan_date', { ascending: false }),

        supabase
          .from('bank_accounts')
          .select('*')
          .order('bank_name', { ascending: true })
      ]);

      if (txRes.error) throw txRes.error;
      if (balanceRes.error) throw balanceRes.error;

      setTransactions(txRes.data || []);
      setCashBalance(balanceRes.data || 0);
      setContainers(containersRes.data || []);
      setChallans(challansRes.data || []);
      setBankAccounts(bankRes.data || []);
    } catch (error: any) {
      console.error('Error loading petty cash data:', error);
      showToast({ type: 'error', title: 'Error', message: 'Failed to load petty cash data: ' + error.message });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [startDate, endDate]);

  useEffect(() => {
    loadData();

    const subscription = supabase
      .channel('petty-cash-changes')
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'petty_cash_transactions' },
        () => {
          loadData();
        }
      )
      .subscribe();

    return () => {
      subscription.unsubscribe();
    };
  }, [loadData]);

  const handleRefresh = () => {
    setRefreshing(true);
    loadData();
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;

    setUploadingFiles(files);
  };

  const handlePaste = async (e: React.ClipboardEvent) => {
    const items = Array.from(e.clipboardData.items);
    const imageItems = items.filter(item => item.type.startsWith('image/'));

    if (imageItems.length > 0) {
      e.preventDefault();
      const files = await Promise.all(
        imageItems.map(item => {
          const blob = item.getAsFile();
          if (blob) {
            return new File([blob], `pasted-image-${Date.now()}.png`, { type: blob.type });
          }
          return null;
        })
      );

      const validFiles = files.filter((f): f is File => f !== null);
      if (validFiles.length > 0) {
        setUploadingFiles(prev => [...prev, ...validFiles]);
      }
    }
  };

  const removeUploadingFile = (index: number) => {
    setUploadingFiles(prev => prev.filter((_, i) => i !== index));
  };

  const deleteExistingDocument = async (documentId: string) => {
    if (!await showConfirm({ title: 'Confirm', message: 'Are you sure you want to delete this document?', variant: 'danger', confirmLabel: 'Delete' })) {
      return;
    }

    try {
      const { error } = await supabase
        .from('petty_cash_documents')
        .delete()
        .eq('id', documentId);

      if (error) throw error;

      setExistingDocuments(prev => prev.filter(doc => doc.id !== documentId));
      showToast({ type: 'success', title: 'Success', message: 'Document deleted successfully!' });
    } catch (error) {
      console.error('Error deleting document:', error);
      showToast({ type: 'error', title: 'Error', message: 'Failed to delete document' });
    }
  };

  const closeModal = () => {
    setModalOpen(false);
    setEditingTransaction(null);
    setExistingDocuments([]);
    setUploadingFiles([]);
  };

  const openAddModal = () => {
    setEditingTransaction(null);
    setFormData({
      transaction_type: 'expense',
      transaction_date: new Date().toISOString().split('T')[0],
      amount: 0,
      description: '',
      expense_category: '',
      bank_account_id: '',
      paid_to: '',
      paid_by_staff_name: '',
      paid_by: 'cash',
      source: '',
      received_by_staff_name: '',
      import_container_id: '',
      delivery_challan_id: '',
    });
    setExistingDocuments([]);
    setUploadingFiles([]);
    setModalOpen(true);
  };

  const openEditModal = (transaction: PettyCashTransaction) => {
    setEditingTransaction(transaction);
    setFormData({
      transaction_type: transaction.transaction_type,
      transaction_date: transaction.transaction_date,
      amount: transaction.amount,
      description: transaction.description,
      expense_category: transaction.expense_category || '',
      bank_account_id: transaction.bank_account_id || '',
      paid_to: transaction.paid_to || '',
      paid_by_staff_name: transaction.paid_by_staff_name || '',
      paid_by: 'cash',
      source: transaction.source || '',
      received_by_staff_name: transaction.received_by_staff_name || '',
      import_container_id: transaction.import_container_id || '',
      delivery_challan_id: transaction.delivery_challan_id || '',
    });
    setExistingDocuments(transaction.petty_cash_documents || []);
    setUploadingFiles([]);
    setModalOpen(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (formData.transaction_type === 'expense' && !formData.expense_category) {
      showToast({ type: 'error', title: 'Error', message: 'Please select an expense category' });
      return;
    }

    const selectedCategory = expenseCategories.find(c => c.value === formData.expense_category);
    if (selectedCategory?.requiresContainer && !formData.import_container_id) {
      showToast({ type: 'error', title: 'Error', message: `${selectedCategory.label} requires linking to an import container` });
      return;
    }

    try {
      const payload = {
        transaction_type: formData.transaction_type,
        transaction_date: formData.transaction_date,
        amount: formData.amount,
        description: formData.description,
        expense_category: formData.transaction_type === 'expense' ? formData.expense_category : null,
        bank_account_id: formData.transaction_type === 'withdraw' ? formData.bank_account_id : null,
        paid_to: formData.transaction_type === 'expense' ? formData.paid_to : null,
        paid_by_staff_name: formData.transaction_type === 'expense' ? formData.paid_by_staff_name : null,
        source: formData.transaction_type === 'withdraw' ? formData.source : null,
        received_by_staff_name: formData.transaction_type === 'withdraw' ? formData.received_by_staff_name : null,
        import_container_id: formData.import_container_id || null,
        delivery_challan_id: formData.delivery_challan_id || null,
      };

      let transactionId: string;

      if (editingTransaction) {
        const { error } = await supabase
          .from('petty_cash_transactions')
          .update(payload)
          .eq('id', editingTransaction.id);

        if (error) throw error;
        transactionId = editingTransaction.id;
      } else {
        const { data, error } = await supabase
          .from('petty_cash_transactions')
          .insert([payload])
          .select('id')
          .single();

        if (error) throw error;
        if (!data) throw new Error('Failed to create transaction');
        transactionId = data.id;
      }

      // Upload documents if any
      if (uploadingFiles.length > 0) {
        const uploadPromises = uploadingFiles.map(async (file) => {
          const fileExt = file.name.split('.').pop();
          const fileName = `${transactionId}_${Date.now()}.${fileExt}`;
          const filePath = `${fileName}`;

          const { error: uploadError } = await supabase.storage
            .from('petty-cash-receipts')
            .upload(filePath, file);

          if (uploadError) throw uploadError;

          const { data: { publicUrl } } = supabase.storage
            .from('petty-cash-receipts')
            .getPublicUrl(filePath);

          // Map MIME type to database-allowed file types
          let fileType = 'proof'; // default
          if (file.type.startsWith('image/')) {
            fileType = 'photo';
          } else if (file.type === 'application/pdf') {
            fileType = 'invoice';
          }

          // Save document record
          const { error: docError } = await supabase
            .from('petty_cash_documents')
            .insert([{
              petty_cash_transaction_id: transactionId,
              file_type: fileType,
              file_name: file.name,
              file_url: publicUrl,
              file_size: file.size,
              uploaded_by: profile?.id,
            }]);

          if (docError) throw docError;
        });

        await Promise.all(uploadPromises);
      }

      showToast({ type: 'success', title: 'Success', message: editingTransaction ? 'Petty cash transaction updated successfully!' : 'Petty cash transaction added successfully!' });
      closeModal();
      loadData();
    } catch (error: any) {
      console.error('Error saving petty cash transaction:', error);
      showToast({ type: 'error', title: 'Error', message: 'Failed to save transaction: ' + error.message });
    }
  };

  const handleDelete = async (id: string) => {
    if (!await showConfirm({ title: 'Confirm', message: 'Are you sure you want to delete this transaction?', variant: 'danger', confirmLabel: 'Delete' })) return;

    try {
      // Get associated documents to delete from storage
      const { data: docs } = await supabase
        .from('petty_cash_documents')
        .select('file_url')
        .eq('petty_cash_transaction_id', id);

      // Delete transaction (CASCADE will delete documents from DB)
      const { error } = await supabase
        .from('petty_cash_transactions')
        .delete()
        .eq('id', id);

      if (error) throw error;

      // Delete files from storage
      if (docs && docs.length > 0) {
        const filePaths = docs.map(doc => {
          const url = doc.file_url;
          const fileName = url.split('/').pop();
          return fileName || '';
        }).filter(Boolean);

        if (filePaths.length > 0) {
          await supabase.storage
            .from('petty-cash-receipts')
            .remove(filePaths);
        }
      }

      showToast({ type: 'success', title: 'Success', message: 'Transaction deleted successfully!' });
      await loadData();
    } catch (error: any) {
      console.error('Error deleting transaction:', error);
      showToast({ type: 'error', title: 'Error', message: 'Failed to delete transaction: ' + error.message });
    }
  };

  const exportToCSV = () => {
    if (filteredTransactions.length === 0) {
      showToast({ type: 'info', title: 'Notice', message: 'No transactions to export' });
      return;
    }

    const headers = ['Date', 'Number', 'Type', 'Category', 'Description', 'Amount', 'Paid To'];
    const rows = filteredTransactions.map(tx => {
      const category = tx.expense_category ? getCategoryInfo(tx.expense_category) : null;
      return [
        tx.transaction_date,
        tx.transaction_number,
        tx.transaction_type === 'withdraw' ? 'Withdrawal' : 'Expense',
        category?.label || '',
        tx.description,
        tx.amount.toString(),
        tx.paid_to || ''
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
    link.setAttribute('download', `petty_cash_${startDate || 'all'}_to_${endDate || 'all'}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const viewTransaction = (transaction: PettyCashTransaction) => {
    setViewingTransaction(transaction);
    setViewModalOpen(true);
  };

  const handleSort = (key: string) => {
    let direction: 'asc' | 'desc' = 'asc';
    if (sortConfig && sortConfig.key === key && sortConfig.direction === 'asc') {
      direction = 'desc';
    }
    setSortConfig({ key, direction });
  };

  const sortedTransactions = [...transactions].sort((a, b) => {
    if (!sortConfig) return 0;

    const aValue = a[sortConfig.key as keyof PettyCashTransaction];
    const bValue = b[sortConfig.key as keyof PettyCashTransaction];

    if (aValue === null || aValue === undefined) return 1;
    if (bValue === null || bValue === undefined) return -1;

    if (aValue < bValue) return sortConfig.direction === 'asc' ? -1 : 1;
    if (aValue > bValue) return sortConfig.direction === 'asc' ? 1 : -1;
    return 0;
  });

  const filteredTransactions = sortedTransactions.filter(tx => {
    if (filterType !== 'all' && tx.transaction_type === 'expense') {
      const category = expenseCategories.find(c => c.value === tx.expense_category);
      if (!category || category.type !== filterType) return false;
    }

    if (categoryFilter !== 'all' && tx.expense_category !== categoryFilter) {
      return false;
    }

    return true;
  });

  const getCategoryInfo = (value: string) => {
    return expenseCategories.find(c => c.value === value);
  };

  const selectedCategory = getCategoryInfo(formData.expense_category);

  if (loading) {
    return <div className="flex items-center justify-center h-64">Loading petty cash data...</div>;
  }

  const totalExpense = filteredTransactions
    .filter(t => t.transaction_type === 'expense')
    .reduce((sum, t) => sum + Number(t.amount), 0);

  const totalWithdraw = filteredTransactions
    .filter(t => t.transaction_type === 'withdraw')
    .reduce((sum, t) => sum + Number(t.amount), 0);

  const groupedCategories = expenseCategories.reduce((acc, cat) => {
    if (!acc[cat.group]) {
      acc[cat.group] = [];
    }
    acc[cat.group].push(cat);
    return acc;
  }, {} as Record<string, typeof expenseCategories>);

  return (
    <div className="space-y-4">
      {/* Compact Header */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div>
              <h2 className="text-xl font-bold text-gray-900">Petty Cash</h2>
              <p className="text-xs text-gray-600 mt-0.5">Track cash withdrawals and expenses</p>
            </div>
            <div className="flex items-center gap-4 ml-8">
              <div className="text-center">
                <div className="text-xs text-gray-500">Balance</div>
                <div className="text-sm font-bold text-green-600">Rp {cashBalance.toLocaleString()}</div>
              </div>
              <div className="h-6 w-px bg-gray-300"></div>
              <div className="text-center">
                <div className="text-xs text-gray-500">Withdrawals</div>
                <div className="text-sm font-bold text-blue-600">Rp {totalWithdraw.toLocaleString()}</div>
              </div>
              <div className="h-6 w-px bg-gray-300"></div>
              <div className="text-center">
                <div className="text-xs text-gray-500">Expenses</div>
                <div className="text-sm font-bold text-red-600">Rp {totalExpense.toLocaleString()}</div>
              </div>
            </div>
          </div>
          {canManage && (
            <button
              onClick={openAddModal}
              className="flex items-center gap-1.5 px-2.5 py-1.5 bg-white text-blue-600 rounded hover:bg-blue-50 font-medium transition-all shadow-sm text-xs"
            >
              <Plus className="w-3.5 h-3.5" />
              New
            </button>
          )}
        </div>
      </div>

      {/* Compact Single-Line Filter Bar */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-2">
        <div className="flex items-center gap-3 flex-wrap">
          {/* Type Filter Pills */}
          <div className="flex gap-1">
            {[
              { value: 'all', label: 'All', icon: '📋' },
              { value: 'import', label: 'Import', icon: '📦' },
              { value: 'sales', label: 'Sales', icon: '🚚' },
              { value: 'staff', label: 'Staff', icon: '👥' },
              { value: 'operations', label: 'Ops', icon: '🏢' },
              { value: 'admin', label: 'Admin', icon: '📄' },
              { value: 'assets', label: 'Assets', icon: '🏦' },
            ].map((tab) => (
              <button
                key={tab.value}
                onClick={() => setFilterType(tab.value as any)}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
                  filterType === tab.value
                    ? 'bg-blue-600 text-white shadow-sm'
                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                }`}
              >
                {tab.icon} {tab.label}
              </button>
            ))}
          </div>

          <div className="h-6 w-px bg-gray-300"></div>

          {/* Category Filter */}
          <select
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            className="px-2 py-1 border border-gray-300 rounded-md text-xs"
          >
            <option value="all">All Categories</option>
            {expenseCategories.map(cat => (
              <option key={cat.value} value={cat.value}>{cat.label}</option>
            ))}
          </select>

          {/* Export Button */}
          <button
            onClick={exportToCSV}
            disabled={filteredTransactions.length === 0}
            className="ml-auto px-3 py-1.5 bg-green-600 text-white rounded-md text-xs hover:bg-green-700 disabled:bg-gray-300 disabled:cursor-not-allowed flex items-center gap-1.5 font-medium"
          >
            <Download className="w-3.5 h-3.5" />
            Export ({filteredTransactions.length})
          </button>
        </div>
      </div>

      <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-x-auto">
        <table className="min-w-full">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              <th
                onClick={() => handleSort('transaction_date')}
                className="px-4 py-2.5 text-left text-xs font-semibold text-gray-600 cursor-pointer hover:bg-gray-100 select-none"
              >
                <div className="flex items-center gap-1">
                  Date
                  {sortConfig?.key === 'transaction_date' && (
                    <span className="text-blue-600 text-sm">{sortConfig.direction === 'asc' ? '↑' : '↓'}</span>
                  )}
                </div>
              </th>
              <th
                onClick={() => handleSort('transaction_number')}
                className="px-4 py-2.5 text-left text-xs font-semibold text-gray-600 cursor-pointer hover:bg-gray-100 select-none"
              >
                <div className="flex items-center gap-1">
                  Number
                  {sortConfig?.key === 'transaction_number' && (
                    <span className="text-blue-600 text-sm">{sortConfig.direction === 'asc' ? '↑' : '↓'}</span>
                  )}
                </div>
              </th>
              <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-600">Type</th>
              <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-600">Category</th>
              <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-600">Description</th>
              <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-600">Linked To</th>
              <th
                onClick={() => handleSort('amount')}
                className="px-4 py-2.5 text-right text-xs font-semibold text-gray-600 cursor-pointer hover:bg-gray-100 select-none"
              >
                <div className="flex items-center justify-end gap-1">
                  Amount
                  {sortConfig?.key === 'amount' && (
                    <span className="text-blue-600 text-sm">{sortConfig.direction === 'asc' ? '↑' : '↓'}</span>
                  )}
                </div>
              </th>
              {canManage && <th className="px-4 py-2.5 text-center text-xs font-semibold text-gray-600">Actions</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr>
                <td colSpan={canManage ? 8 : 7} className="px-6 py-8 text-center text-gray-500">
                  Loading...
                </td>
              </tr>
            ) : filteredTransactions.length === 0 ? (
              <tr>
                <td colSpan={canManage ? 8 : 7} className="px-6 py-8 text-center text-gray-500">
                  No transactions found
                </td>
              </tr>
            ) : (
              filteredTransactions.map((tx) => {
                const categoryInfo = tx.expense_category ? getCategoryInfo(tx.expense_category) : null;
                const Icon = categoryInfo?.icon;

                return (
                  <tr key={tx.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-900">
                      {new Date(tx.transaction_date).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-blue-600">{tx.transaction_number}</span>
                        {tx.voucher_number && (
                          <span className="text-xs text-gray-500 bg-gray-100 px-2 py-1 rounded">
                            {tx.voucher_number}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <span className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium ${
                        tx.transaction_type === 'withdraw'
                          ? 'bg-blue-100 text-blue-800'
                          : 'bg-red-100 text-red-800'
                      }`}>
                        {tx.transaction_type === 'withdraw' ? (
                          <>
                            <ArrowDownCircle className="h-3 w-3" />
                            Withdrawal
                          </>
                        ) : (
                          <>
                            <ArrowUpCircle className="h-3 w-3" />
                            Expense
                          </>
                        )}
                      </span>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      {categoryInfo && (
                        <div className="flex items-center gap-2">
                          {Icon && <Icon className="h-4 w-4 text-gray-500" />}
                          <span className="text-sm text-gray-900">{categoryInfo.label}</span>
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-600">
                      <div className="max-w-xs truncate">
                        {tx.description}
                        {tx.paid_to && <div className="text-xs text-gray-500">To: {tx.paid_to}</div>}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-sm">
                      <div className="space-y-1">
                        {tx.import_containers && (
                          <div className="flex items-center gap-1 text-purple-600">
                            <Package className="h-3 w-3" />
                            <span className="text-xs">{tx.import_containers.container_ref}</span>
                          </div>
                        )}
                        {tx.delivery_challans && (
                          <div className="flex items-center gap-1 text-green-600">
                            <Truck className="h-3 w-3" />
                            <span className="text-xs">{tx.delivery_challans.challan_number}</span>
                          </div>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-right">
                      <span className={`text-sm font-medium ${
                        tx.transaction_type === 'withdraw' ? 'text-blue-600' : 'text-red-600'
                      }`}>
                        Rp {Number(tx.amount).toLocaleString()}
                      </span>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-right text-sm">
                      <div className="flex items-center justify-end gap-2">
                        <button
                          onClick={() => viewTransaction(tx)}
                          className="text-blue-600 hover:text-blue-900"
                          title="View Details"
                        >
                          <Eye className="h-4 w-4" />
                        </button>
                        {canManage && (
                          <>
                            <button
                              onClick={() => openEditModal(tx)}
                              className="text-yellow-600 hover:text-yellow-900"
                              title="Edit"
                            >
                              <Edit2 className="h-4 w-4" />
                            </button>
                            <button
                              onClick={() => handleDelete(tx.id)}
                              className="text-red-600 hover:text-red-900"
                              title="Delete"
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <Modal isOpen={modalOpen} onClose={closeModal} title={editingTransaction ? 'Edit Transaction' : 'Add Petty Cash Transaction'}>
        <form onSubmit={handleSubmit} className="space-y-4" onPaste={handlePaste}>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Transaction Type</label>
            <select
              value={formData.transaction_type}
              onChange={(e) => setFormData({ ...formData, transaction_type: e.target.value as 'withdraw' | 'expense' })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg"
              required
            >
              <option value="expense">Expense (Cash Out)</option>
              <option value="withdraw">Withdraw from Bank</option>
            </select>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Date</label>
              <input
                type="date"
                value={formData.transaction_date}
                onChange={(e) => setFormData({ ...formData, transaction_date: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                required
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Amount (Rp)</label>
              <input
                type="number"
                value={formData.amount || ''}
                onChange={(e) => setFormData({ ...formData, amount: parseFloat(e.target.value) || 0 })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                required
                min="0"
                step="0.01"
              />
            </div>
          </div>

          {formData.transaction_type === 'expense' && (
            <>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Expense Category <span className="text-red-500">*</span>
                </label>
                <select
                  value={formData.expense_category}
                  onChange={(e) => setFormData({ ...formData, expense_category: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                  required
                >
                  <option value="">Select expense category...</option>
                  {Object.entries(groupedCategories).map(([group, categories]) => (
                    <optgroup key={group} label={group}>
                      {categories.map((cat) => (
                        <option key={cat.value} value={cat.value}>
                          {cat.label}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
                {formData.expense_category && selectedCategory && (
                  <p className="mt-1 text-xs text-gray-600">
                    {selectedCategory.description}
                  </p>
                )}
              </div>

              {selectedCategory?.requiresContainer && (
                <div className="bg-orange-50 border border-orange-200 rounded-lg p-3">
                  <div className="flex items-start gap-2">
                    <Package className="h-5 w-5 text-orange-600 flex-shrink-0 mt-0.5" />
                    <div>
                      <div className="text-sm font-medium text-orange-900">Import Container Required</div>
                      <div className="text-xs text-orange-700 mt-1">
                        This expense category requires linking to an import container for proper cost allocation
                      </div>
                    </div>
                  </div>
                </div>
              )}

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Link to Container {selectedCategory?.requiresContainer && <span className="text-red-500">*</span>}
                  </label>
                  <select
                    value={formData.import_container_id}
                    onChange={(e) => setFormData({ ...formData, import_container_id: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                    required={selectedCategory?.requiresContainer}
                  >
                    <option value="">None</option>
                    {containers.map((c) => (
                      <option key={c.id} value={c.id}>{c.container_ref}</option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Link to Delivery Challan (Sales)</label>
                  <select
                    value={formData.delivery_challan_id}
                    onChange={(e) => setFormData({ ...formData, delivery_challan_id: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                  >
                    <option value="">None</option>
                    {challans.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.challan_number} - {c.customers?.company_name} ({new Date(c.challan_date).toLocaleDateString()})
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Paid To</label>
                  <input
                    type="text"
                    value={formData.paid_to}
                    onChange={(e) => setFormData({ ...formData, paid_to: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                    placeholder="Vendor/Supplier name"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Paid By (Staff)</label>
                  <input
                    type="text"
                    value={formData.paid_by_staff_name}
                    onChange={(e) => setFormData({ ...formData, paid_by_staff_name: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                    placeholder="Staff member name"
                  />
                </div>
              </div>
            </>
          )}

          {formData.transaction_type === 'withdraw' && (
            <>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Bank Account</label>
                <select
                  value={formData.bank_account_id}
                  onChange={(e) => setFormData({ ...formData, bank_account_id: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                  required
                >
                  <option value="">Select bank account</option>
                  {bankAccounts.map((acc) => (
                    <option key={acc.id} value={acc.id}>
                      {acc.alias || acc.bank_name} - {acc.account_number} ({acc.currency})
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Source/Reference</label>
                  <input
                    type="text"
                    value={formData.source}
                    onChange={(e) => setFormData({ ...formData, source: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                    placeholder="Check number, transfer ref"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Received By</label>
                  <input
                    type="text"
                    value={formData.received_by_staff_name}
                    onChange={(e) => setFormData({ ...formData, received_by_staff_name: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                    placeholder="Staff member name"
                  />
                </div>
              </div>
            </>
          )}

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
            <textarea
              value={formData.description}
              onChange={(e) => setFormData({ ...formData, description: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg"
              rows={3}
              required
              placeholder="Enter transaction details"
            />
          </div>

          {/* Existing Documents (Edit Mode) */}
          {editingTransaction && existingDocuments.length > 0 && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Existing Documents ({existingDocuments.length})
              </label>
              <div className="grid grid-cols-2 gap-3 mb-4">
                {existingDocuments.map((doc) => (
                  <div
                    key={doc.id}
                    className="group relative border border-gray-200 rounded-lg overflow-hidden hover:border-red-500 transition-colors"
                  >
                    {doc.file_type === 'photo' ? (
                      <div className="aspect-square bg-gray-100 relative">
                        <img
                          src={doc.file_url}
                          alt={doc.file_name}
                          className="w-full h-full object-cover"
                        />
                      </div>
                    ) : (
                      <div className="aspect-square bg-red-50 flex flex-col items-center justify-center p-3">
                        <FileText className="h-10 w-10 text-red-600 mb-2" />
                        <p className="text-xs text-center text-gray-700 line-clamp-2 px-2">{doc.file_name}</p>
                      </div>
                    )}
                    <div className="absolute bottom-0 left-0 right-0 bg-black bg-opacity-60 text-white text-xs px-2 py-1.5 flex items-center justify-between">
                      <span>{(doc.file_size / 1024).toFixed(0)} KB</span>
                      <div className="flex gap-1">
                        <a
                          href={doc.file_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="p-1 hover:bg-white hover:bg-opacity-20 rounded"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <ExternalLink className="h-3.5 w-3.5" />
                        </a>
                        <button
                          type="button"
                          onClick={() => deleteExistingDocument(doc.id)}
                          className="p-1 hover:bg-red-500 rounded"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              {editingTransaction ? 'Upload Additional Documents/Receipts' : 'Upload Documents/Receipts'}
            </label>
            <div className="border-2 border-dashed border-gray-300 rounded-lg p-4 text-center hover:border-blue-500 transition-colors">
              <input
                type="file"
                onChange={handleFileUpload}
                accept="image/*,.pdf"
                multiple
                className="hidden"
                id="file-upload"
              />
              <label htmlFor="file-upload" className="cursor-pointer">
                <Upload className="h-8 w-8 text-gray-400 mx-auto mb-2" />
                <p className="text-sm text-gray-600">Click to upload or drag and drop</p>
                <p className="text-xs text-gray-500 mt-1">Images or PDF files</p>
              </label>
              {!showPasteHint && uploadingFiles.length === 0 && (
                <button
                  type="button"
                  onClick={() => setShowPasteHint(true)}
                  className="text-xs text-blue-600 hover:text-blue-700 mt-2"
                >
                  💡 You can also paste images here
                </button>
              )}
            </div>

            {uploadingFiles.length > 0 && (
              <div className="mt-3 space-y-2">
                <p className="text-sm font-medium text-gray-700">{uploadingFiles.length} file(s) ready:</p>
                <div className="space-y-1">
                  {uploadingFiles.map((file, idx) => (
                    <div key={idx} className="flex items-center justify-between bg-gray-50 px-3 py-2 rounded">
                      <div className="flex items-center gap-2">
                        {file.type.startsWith('image/') ? (
                          <Image className="h-4 w-4 text-blue-600" />
                        ) : (
                          <FileText className="h-4 w-4 text-red-600" />
                        )}
                        <span className="text-sm text-gray-700">{file.name}</span>
                        <span className="text-xs text-gray-500">({(file.size / 1024).toFixed(1)} KB)</span>
                      </div>
                      <button
                        type="button"
                        onClick={() => removeUploadingFile(idx)}
                        className="text-red-600 hover:text-red-800"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="flex justify-end gap-3 pt-4">
            <button
              type="button"
              onClick={closeModal}
              className="px-4 py-2 text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
            >
              {editingTransaction ? 'Update' : 'Save'} Transaction
            </button>
          </div>
        </form>
      </Modal>

      <Modal
        isOpen={viewModalOpen}
        onClose={() => setViewModalOpen(false)}
        title="Petty Cash Receipt"
        maxWidth="max-w-lg"
      >
        {viewingTransaction && (
          <div className="space-y-3 text-sm">
            {/* Compact Header Bar */}
            <div className="bg-gradient-to-r from-blue-500 to-blue-600 text-white px-3 py-2 rounded -mt-1 -mx-1">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs opacity-90">Transaction #</p>
                  <p className="text-base font-bold">{viewingTransaction.transaction_number}</p>
                </div>
                <div className="text-right">
                  <p className="text-xs opacity-90">Date</p>
                  <p className="text-base font-semibold">
                    {new Date(viewingTransaction.transaction_date).toLocaleDateString('id-ID', {
                      day: '2-digit',
                      month: 'short',
                      year: 'numeric'
                    })}
                  </p>
                </div>
              </div>
            </div>

            {/* Type, Category, Amount - All in one line */}
            <div className="py-2 border-b border-gray-200">
              <div className="flex items-center justify-between flex-wrap gap-3">
                <div className="flex items-center gap-4">
                  <div>
                    <p className="text-xs text-gray-500 mb-0.5">Type</p>
                    <div className="flex items-center gap-1">
                      {viewingTransaction.transaction_type === 'withdraw' ? (
                        <>
                          <ArrowDownCircle className="h-3.5 w-3.5 text-blue-600" />
                          <span className="text-sm font-medium text-blue-900">Withdrawal</span>
                        </>
                      ) : (
                        <>
                          <ArrowUpCircle className="h-3.5 w-3.5 text-red-600" />
                          <span className="text-sm font-medium text-red-900">Expense</span>
                        </>
                      )}
                    </div>
                  </div>

                  {viewingTransaction.expense_category && (
                    <div>
                      <p className="text-xs text-gray-500 mb-0.5">Category</p>
                      <div className="flex items-center gap-1.5">
                        {(() => {
                          const categoryInfo = getCategoryInfo(viewingTransaction.expense_category);
                          const Icon = categoryInfo?.icon;
                          return (
                            <>
                              {Icon && <Icon className="h-4 w-4 text-amber-600" />}
                              <span className="text-sm font-medium text-gray-900">{categoryInfo?.label}</span>
                            </>
                          );
                        })()}
                      </div>
                    </div>
                  )}
                </div>

                <div>
                  <p className="text-xs text-gray-500 mb-0.5">Amount</p>
                  <p className="text-lg font-bold text-gray-900">
                    Rp {Number(viewingTransaction.amount).toLocaleString('id-ID')}
                  </p>
                </div>
              </div>
            </div>

            {/* Description */}
            <div className="py-2 border-b border-gray-200">
              <p className="text-xs text-gray-500 mb-1">Description</p>
              <p className="text-sm font-semibold text-gray-900">{viewingTransaction.description}</p>
            </div>

            {/* Payment Details - Compact */}
            <div className="py-2 border-b border-gray-200 space-y-1.5">
              {(viewingTransaction.paid_to || viewingTransaction.paid_by_staff_name) && (
                <div className="flex items-center gap-4 flex-wrap">
                  {viewingTransaction.paid_to && (
                    <div className="flex items-center gap-1.5">
                      <p className="text-xs text-gray-500">Paid To:</p>
                      <p className="text-sm font-medium text-gray-900">{viewingTransaction.paid_to}</p>
                    </div>
                  )}
                  {viewingTransaction.paid_by_staff_name && (
                    <div className="flex items-center gap-1.5">
                      <p className="text-xs text-gray-500">Paid By:</p>
                      <p className="text-sm font-medium text-gray-900">{viewingTransaction.paid_by_staff_name}</p>
                    </div>
                  )}
                </div>
              )}
              {viewingTransaction.received_by_staff_name && (
                <div className="flex items-center gap-1.5">
                  <p className="text-xs text-gray-500">Received By:</p>
                  <p className="text-sm font-medium text-gray-900">{viewingTransaction.received_by_staff_name}</p>
                </div>
              )}
              {viewingTransaction.source && (
                <div className="flex items-center gap-1.5">
                  <p className="text-xs text-gray-500">Source:</p>
                  <p className="text-sm font-medium text-gray-900">{viewingTransaction.source}</p>
                </div>
              )}
            </div>

            {/* Linked References - Compact */}
            {(viewingTransaction.import_containers || viewingTransaction.delivery_challans || viewingTransaction.bank_accounts) && (
              <div className="py-2 border-b border-gray-200">
                <p className="text-xs text-gray-500 mb-1.5">Linked To</p>
                <div className="space-y-1">
                  {viewingTransaction.import_containers && (
                    <div className="flex items-center gap-1.5 text-xs">
                      <Package className="h-3.5 w-3.5 text-purple-600" />
                      <span className="text-gray-600">Container:</span>
                      <span className="font-medium text-gray-900">{viewingTransaction.import_containers.container_ref}</span>
                    </div>
                  )}
                  {viewingTransaction.delivery_challans && (
                    <div className="flex items-center gap-1.5 text-xs">
                      <Truck className="h-3.5 w-3.5 text-green-600" />
                      <span className="text-gray-600">Challan:</span>
                      <span className="font-medium text-gray-900">{viewingTransaction.delivery_challans.challan_number}</span>
                    </div>
                  )}
                  {viewingTransaction.bank_accounts && (
                    <div className="flex items-center gap-1.5 text-xs">
                      <Building2 className="h-3.5 w-3.5 text-blue-600" />
                      <span className="text-gray-600">Bank:</span>
                      <span className="font-medium text-gray-900">
                        {viewingTransaction.bank_accounts.alias || viewingTransaction.bank_accounts.bank_name}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Attached Documents with Thumbnails */}
            {viewingTransaction.petty_cash_documents && viewingTransaction.petty_cash_documents.length > 0 && (
              <div className="pt-2">
                <p className="text-xs text-gray-500 mb-2">Attachments ({viewingTransaction.petty_cash_documents.length})</p>
                <div className="grid grid-cols-2 gap-2">
                  {viewingTransaction.petty_cash_documents.map((doc) => (
                    <a
                      key={doc.id}
                      href={doc.file_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="group relative border border-gray-200 rounded overflow-hidden hover:border-blue-500 transition-colors"
                    >
                      {doc.file_type === 'photo' ? (
                        <div className="aspect-square bg-gray-100 relative">
                          <img
                            src={doc.file_url}
                            alt={doc.file_name}
                            className="w-full h-full object-cover"
                          />
                          <div className="absolute inset-0 bg-black bg-opacity-0 group-hover:bg-opacity-10 transition-opacity flex items-center justify-center">
                            <ExternalLink className="h-5 w-5 text-white opacity-0 group-hover:opacity-100 transition-opacity" />
                          </div>
                        </div>
                      ) : (
                        <div className="aspect-square bg-red-50 flex flex-col items-center justify-center p-3">
                          <FileText className="h-8 w-8 text-red-600 mb-2" />
                          <p className="text-xs text-center text-gray-700 line-clamp-2">{doc.file_name}</p>
                        </div>
                      )}
                      {doc.file_size && (
                        <div className="absolute bottom-0 left-0 right-0 bg-black bg-opacity-60 text-white text-xs px-2 py-0.5">
                          {(doc.file_size / 1024).toFixed(0)} KB
                        </div>
                      )}
                    </a>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </Modal>

      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
        <div className="flex items-start gap-3">
          <FileText className="h-5 w-5 text-blue-600 flex-shrink-0 mt-0.5" />
          <div className="flex-1">
            <h4 className="text-sm font-semibold text-blue-900 mb-2">Recording Fixed Assets</h4>
            <div className="text-sm text-blue-800 space-y-2">
              <p><strong>For Equipment/Asset Purchases:</strong></p>
              <ol className="list-decimal list-inside space-y-1 ml-2">
                <li>Use category "Fixed Assets / Equipment"</li>
                <li>Record the purchase here with full details</li>
                <li>This creates a debit to "Fixed Assets" account</li>
                <li>Assets are CAPITALIZED (not expensed immediately)</li>
                <li>Later: Finance team will set up depreciation schedule</li>
              </ol>
              <p className="text-xs mt-2 bg-blue-100 p-2 rounded">
                💡 Examples: Computers, machinery, furniture, vehicles, AC units, shelving
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
