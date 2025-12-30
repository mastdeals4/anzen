import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { Plus, DollarSign, Package, Truck, Building2, Edit, Trash2, FileText, Upload, X, ExternalLink } from 'lucide-react';
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
  created_at: string;
  batches?: { batch_number: string } | null;
  import_containers?: { container_ref: string } | null;
  delivery_challans?: { challan_number: string } | null;
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
    requiresContainer: true
  },
  {
    value: 'ppn_import',
    label: 'PPN Import',
    type: 'import',
    icon: Building2,
    description: 'Import VAT - CAPITALIZED to inventory',
    requiresContainer: true
  },
  {
    value: 'pph_import',
    label: 'PPh Import',
    type: 'import',
    icon: Building2,
    description: 'Import withholding tax - CAPITALIZED to inventory',
    requiresContainer: true
  },
  {
    value: 'freight_import',
    label: 'Freight (Import)',
    type: 'import',
    icon: Package,
    description: 'International freight charges - CAPITALIZED to inventory',
    requiresContainer: true
  },
  {
    value: 'clearing_forwarding',
    label: 'Clearing & Forwarding',
    type: 'import',
    icon: Building2,
    description: 'Customs clearance - CAPITALIZED to inventory',
    requiresContainer: true
  },
  {
    value: 'port_charges',
    label: 'Port Charges',
    type: 'import',
    icon: Building2,
    description: 'Port handling charges - CAPITALIZED to inventory',
    requiresContainer: true
  },
  {
    value: 'container_handling',
    label: 'Container Handling',
    type: 'import',
    icon: Package,
    description: 'Container unloading - CAPITALIZED to inventory',
    requiresContainer: true
  },
  {
    value: 'transport_import',
    label: 'Transportation (Import)',
    type: 'import',
    icon: Truck,
    description: 'Port to godown transport - CAPITALIZED to inventory',
    requiresContainer: true
  },
  {
    value: 'delivery_sales',
    label: 'Delivery / Dispatch (Sales)',
    type: 'sales',
    icon: Truck,
    description: 'Customer delivery - EXPENSED to P&L',
    requiresContainer: false
  },
  {
    value: 'loading_sales',
    label: 'Loading / Unloading (Sales)',
    type: 'sales',
    icon: Truck,
    description: 'Sales loading charges - EXPENSED to P&L',
    requiresContainer: false
  },
  {
    value: 'warehouse_rent',
    label: 'Warehouse Rent',
    type: 'admin',
    icon: Building2,
    description: 'Rent expense - EXPENSED to P&L',
    requiresContainer: false
  },
  {
    value: 'utilities',
    label: 'Utilities',
    type: 'admin',
    icon: Building2,
    description: 'Electricity, water, etc - EXPENSED to P&L',
    requiresContainer: false
  },
  {
    value: 'salary',
    label: 'Salary',
    type: 'admin',
    icon: DollarSign,
    description: 'Staff salaries - EXPENSED to P&L',
    requiresContainer: false
  },
  {
    value: 'office_admin',
    label: 'Office & Admin',
    type: 'admin',
    icon: Building2,
    description: 'General admin expenses - EXPENSED to P&L',
    requiresContainer: false
  },
  {
    value: 'other',
    label: 'Other',
    type: 'admin',
    icon: DollarSign,
    description: 'Miscellaneous expenses - EXPENSED to P&L',
    requiresContainer: false
  },
];

export function ExpenseManager({ canManage }: ExpenseManagerProps) {
  const [expenses, setExpenses] = useState<FinanceExpense[]>([]);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [containers, setContainers] = useState<ImportContainer[]>([]);
  const [challans, setChallans] = useState<DeliveryChallan[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingExpense, setEditingExpense] = useState<FinanceExpense | null>(null);
  const [filterType, setFilterType] = useState<'all' | 'import' | 'sales' | 'admin'>('all');
  const [uploadingFiles, setUploadingFiles] = useState<File[]>([]);

  const [formData, setFormData] = useState({
    expense_category: 'other',
    amount: 0,
    expense_date: new Date().toISOString().split('T')[0],
    description: '',
    batch_id: '',
    import_container_id: '',
    delivery_challan_id: '',
    document_urls: [] as string[],
  });

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      setLoading(true);
      const [expensesRes, batchesRes, containersRes, challansRes] = await Promise.all([
        supabase
          .from('finance_expenses')
          .select(`
            *,
            batches(batch_number),
            import_containers(container_ref),
            delivery_challans(challan_number)
          `)
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
          .select('id, challan_number')
          .order('challan_number', { ascending: false })
          .limit(50),
      ]);

      if (expensesRes.error) throw expensesRes.error;
      setExpenses(expensesRes.data || []);
      setBatches(batchesRes.data || []);
      setContainers(containersRes.data || []);
      setChallans(challansRes.data || []);
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
        document_urls: allDocumentUrls.length > 0 ? allDocumentUrls : null,
      };

      if (editingExpense) {
        const { error } = await supabase
          .from('finance_expenses')
          .update(expenseData)
          .eq('id', editingExpense.id);

        if (error) throw error;
        alert('Expense updated successfully');
      } else {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) throw new Error('Not authenticated');

        const { error } = await supabase
          .from('finance_expenses')
          .insert([{ ...expenseData, created_by: user.id }]);

        if (error) throw error;
        alert('Expense recorded successfully');
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
    setFormData({
      expense_category: expense.expense_category,
      amount: expense.amount,
      expense_date: expense.expense_date,
      description: expense.description || '',
      batch_id: expense.batch_id || '',
      import_container_id: expense.import_container_id || '',
      delivery_challan_id: expense.delivery_challan_id || '',
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
      document_urls: [],
    });
  };

  const selectedCategory = expenseCategories.find(c => c.value === formData.expense_category);
  const requiresContainer = selectedCategory?.type === 'import';
  const requiresDC = selectedCategory?.type === 'sales';

  const filteredExpenses = expenses.filter(exp => {
    if (filterType === 'all') return true;
    const cat = expenseCategories.find(c => c.value === exp.expense_category);
    return cat?.type === filterType;
  });

  const getTypeColor = (type: string) => {
    switch (type) {
      case 'import': return 'bg-blue-100 text-blue-800 border-blue-300';
      case 'sales': return 'bg-green-100 text-green-800 border-green-300';
      case 'admin': return 'bg-gray-100 text-gray-800 border-gray-300';
      default: return 'bg-gray-100 text-gray-800 border-gray-300';
    }
  };

  const formatCurrency = (amount: number) => {
    return `Rp ${amount?.toLocaleString('id-ID')}`;
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

      <div className="flex gap-2 border-b border-gray-200">
        {[
          { value: 'all', label: 'All Expenses' },
          { value: 'import', label: 'Import Costs' },
          { value: 'sales', label: 'Sales/Delivery' },
          { value: 'admin', label: 'Admin/Office' },
        ].map((tab) => (
          <button
            key={tab.value}
            onClick={() => setFilterType(tab.value as any)}
            className={`px-4 py-2 font-medium transition-colors ${
              filterType === tab.value
                ? 'text-blue-600 border-b-2 border-blue-600'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="bg-white rounded-lg shadow overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Date</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Category</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Context</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Description</th>
              <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">Amount</th>
              <th className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase">Treatment</th>
              {canManage && <th className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase">Actions</th>}
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {loading ? (
              <tr>
                <td colSpan={canManage ? 7 : 6} className="px-6 py-8 text-center text-gray-500">
                  Loading...
                </td>
              </tr>
            ) : filteredExpenses.length === 0 ? (
              <tr>
                <td colSpan={canManage ? 7 : 6} className="px-6 py-8 text-center text-gray-500">
                  No expenses found
                </td>
              </tr>
            ) : (
              filteredExpenses.map((expense) => {
                const category = expenseCategories.find(c => c.value === expense.expense_category);
                return (
                  <tr key={expense.id} className="hover:bg-gray-50">
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="text-sm text-gray-900">
                        {new Date(expense.expense_date).toLocaleDateString()}
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
                      <span className={`inline-flex px-2 py-1 text-xs font-medium rounded border ${getTypeColor(category?.type || 'admin')}`}>
                        {category?.type === 'import' && 'CAPITALIZED'}
                        {category?.type === 'sales' && 'EXPENSE'}
                        {category?.type === 'admin' && 'EXPENSE'}
                      </span>
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
                className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                required
              >
                <option value="">Select Category</option>
                {expenseCategories.map((cat) => {
                  const contextLabel = cat.requiresContainer ? ' [Requires Container]' : '';
                  return (
                    <option key={cat.value} value={cat.value}>
                      {cat.label}{contextLabel}
                    </option>
                  );
                })}
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
                      {challan.challan_number}
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
