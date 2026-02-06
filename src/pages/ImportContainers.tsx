import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { Layout } from '../components/Layout';
import { Package, Plus, Eye, Edit, Lock, CheckCircle, AlertCircle } from 'lucide-react';
import { Modal } from '../components/Modal';
import { showToast } from '../components/ToastNotification';
import { showConfirm } from '../components/ConfirmDialog';

interface Supplier {
  id: string;
  company_name: string;
}

interface ImportContainer {
  id: string;
  container_ref: string;
  supplier_id: string;
  import_date: string;
  import_invoice_value: number;
  currency: string;
  exchange_rate: number;
  duty_bm: number;
  ppn_import: number;
  pph_import: number;
  freight_charges: number;
  clearing_forwarding: number;
  port_charges: number;
  container_handling: number;
  transportation: number;
  loading_import: number;
  bpom_ski_fees: number;
  other_import_costs: number;
  total_import_expenses: number;
  allocated_expenses: number;
  allocation_method: string;
  status: string;
  locked_at: string | null;
  notes: string;
  suppliers?: Supplier;
  linked_expenses_total?: number;
}

interface LinkedExpense {
  id: string;
  expense_category: string;
  amount: number;
  expense_date: string;
  description: string | null;
}

export default function ImportContainers() {
  const { user } = useAuth();
  const [containers, setContainers] = useState<ImportContainer[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editingContainer, setEditingContainer] = useState<ImportContainer | null>(null);
  const [linkedExpenses, setLinkedExpenses] = useState<LinkedExpense[]>([]);
  const [formData, setFormData] = useState({
    container_ref: '',
    supplier_id: '',
    import_date: new Date().toISOString().split('T')[0],
    import_invoice_value: 0,
    currency: 'USD',
    exchange_rate: 15000,
    duty_bm: 0,
    ppn_import: 0,
    pph_import: 0,
    freight_charges: 0,
    clearing_forwarding: 0,
    port_charges: 0,
    container_handling: 0,
    transportation: 0,
    loading_import: 0,
    bpom_ski_fees: 0,
    other_import_costs: 0,
    notes: ''
  });

  useEffect(() => {
    fetchContainers();
    fetchSuppliers();

    // Set up realtime subscriptions for import containers and linked expenses
    const containerSubscription = supabase
      .channel('container-changes')
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'import_containers' },
        () => {
          fetchContainers();
        }
      )
      .subscribe();

    const expenseSubscription = supabase
      .channel('expense-container-changes')
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'finance_expenses' },
        () => {
          fetchContainers();
        }
      )
      .subscribe();

    return () => {
      containerSubscription.unsubscribe();
      expenseSubscription.unsubscribe();
    };
  }, []);

  const fetchContainers = async () => {
    try {
      setLoading(true);

      // Fetch containers with suppliers
      const { data: containersData, error } = await supabase
        .from('import_containers')
        .select(`
          *,
          suppliers (
            id,
            company_name
          )
        `)
        .order('created_at', { ascending: false});

      if (error) throw error;

      // For each container, calculate linked expenses total
      const containersWithExpenses = await Promise.all(
        (containersData || []).map(async (container) => {
          const { data: expenses } = await supabase
            .from('finance_expenses')
            .select('amount')
            .eq('import_container_id', container.id);

          const linkedExpensesTotal = expenses?.reduce((sum, exp) => sum + Number(exp.amount), 0) || 0;

          return {
            ...container,
            linked_expenses_total: linkedExpensesTotal
          };
        })
      );

      setContainers(containersWithExpenses);
    } catch (error: any) {
      console.error('Error fetching containers:', error.message);
      showToast({ type: 'error', title: 'Error', message: 'Failed to load import containers' });
    } finally {
      setLoading(false);
    }
  };

  const fetchSuppliers = async () => {
    try {
      const { data, error } = await supabase
        .from('suppliers')
        .select('id, company_name')
        .eq('is_active', true)
        .order('company_name');

      if (error) throw error;
      setSuppliers(data || []);
    } catch (error: any) {
      console.error('Error fetching suppliers:', error.message);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    try {
      const containerData = {
        ...formData,
        created_by: user?.id
      };

      if (editingContainer) {
        const { error } = await supabase
          .from('import_containers')
          .update(containerData)
          .eq('id', editingContainer.id);

        if (error) throw error;
        showToast({ type: 'success', title: 'Success', message: 'Container updated successfully' });
      } else {
        const { error } = await supabase
          .from('import_containers')
          .insert([containerData]);

        if (error) throw error;
        showToast({ type: 'success', title: 'Success', message: 'Container created successfully' });
      }

      setShowModal(false);
      setEditingContainer(null);
      resetForm();
      fetchContainers();
    } catch (error: any) {
      console.error('Error saving container:', error.message);
      showToast({ type: 'error', title: 'Error', message: 'Failed to save container: ' + error.message });
    }
  };

  const handleAllocate = async (containerId: string) => {
    if (!await showConfirm({ title: 'Confirm', message: 'Are you sure you want to allocate import costs to batches? This cannot be undone.', variant: 'warning', confirmLabel: 'Allocate' })) {
      return;
    }

    try {
      const { data, error } = await supabase
        .rpc('allocate_import_costs_to_batches', {
          p_container_id: containerId
        });

      if (error) throw error;

      const result = data as any;
      if (result.success) {
        showToast({ type: 'success', title: 'Success', message: `Allocated costs to ${result.batches_allocated} batches. Total cost: Rp ${result.total_cost?.toLocaleString()}` });
        fetchContainers();
      } else {
        showToast({ type: 'error', title: 'Error', message: result.error });
      }
    } catch (error: any) {
      console.error('Error allocating costs:', error.message);
      showToast({ type: 'error', title: 'Error', message: 'Failed to allocate costs: ' + error.message });
    }
  };

  const resetForm = () => {
    setFormData({
      container_ref: '',
      supplier_id: '',
      import_date: new Date().toISOString().split('T')[0],
      import_invoice_value: 0,
      currency: 'USD',
      exchange_rate: 15000,
      duty_bm: 0,
      ppn_import: 0,
      pph_import: 0,
      freight_charges: 0,
      clearing_forwarding: 0,
      port_charges: 0,
      container_handling: 0,
      transportation: 0,
      other_import_costs: 0,
      notes: ''
    });
    setLinkedExpenses([]);
  };

  const loadLinkedExpenses = async (containerId: string) => {
    try {
      const { data, error } = await supabase
        .from('finance_expenses')
        .select('id, expense_category, amount, expense_date, description')
        .eq('import_container_id', containerId)
        .order('expense_date', { ascending: false });

      if (error) throw error;
      setLinkedExpenses(data || []);
    } catch (error: any) {
      console.error('Error loading linked expenses:', error);
      setLinkedExpenses([]);
    }
  };

  const getExpenseCategoryLabel = (category: string): string => {
    const labels: Record<string, string> = {
      duty_customs: 'Duty & Customs (BM)',
      ppn_import: 'PPN Import',
      pph_import: 'PPh Import',
      freight_import: 'Freight (Import)',
      clearing_forwarding: 'Clearing & Forwarding',
      port_charges: 'Port Charges',
      container_handling: 'Container Handling',
      transport_import: 'Transportation (Import)',
      loading_import: 'Loading / Unloading (Import)',
      bpom_ski_fees: 'BPOM / SKI Fees',
    };
    return labels[category] || category;
  };

  const handleEdit = async (container: ImportContainer) => {
    setEditingContainer(container);
    setFormData({
      container_ref: container.container_ref,
      supplier_id: container.supplier_id,
      import_date: container.import_date,
      import_invoice_value: container.import_invoice_value,
      currency: container.currency,
      exchange_rate: container.exchange_rate,
      duty_bm: container.duty_bm || 0,
      ppn_import: container.ppn_import || 0,
      pph_import: container.pph_import || 0,
      freight_charges: container.freight_charges || 0,
      clearing_forwarding: container.clearing_forwarding || 0,
      port_charges: container.port_charges || 0,
      container_handling: container.container_handling || 0,
      transportation: container.transportation || 0,
      loading_import: container.loading_import || 0,
      bpom_ski_fees: container.bpom_ski_fees || 0,
      other_import_costs: container.other_import_costs || 0,
      notes: container.notes || ''
    });

    // Load linked expenses
    await loadLinkedExpenses(container.id);

    setShowModal(true);
  };

  const getStatusBadge = (status: string) => {
    const statusConfig: Record<string, { color: string; label: string; icon: any }> = {
      draft: { color: 'bg-gray-100 text-gray-800', label: 'Draft', icon: Edit },
      allocated: { color: 'bg-green-100 text-green-800', label: 'Allocated', icon: CheckCircle },
      locked: { color: 'bg-blue-100 text-blue-800', label: 'Locked', icon: Lock },
    };

    const config = statusConfig[status] || statusConfig.draft;
    const Icon = config.icon;

    return (
      <span className={`inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded ${config.color}`}>
        <Icon className="w-3 h-3" />
        {config.label}
      </span>
    );
  };

  const formatCurrency = (amount: number, currency: string = 'IDR') => {
    if (currency === 'USD') {
      return `$ ${amount?.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    }
    return `Rp ${amount?.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };

  const calculateTotal = () => {
    return (
      (formData.duty_bm || 0) +
      (formData.ppn_import || 0) +
      (formData.pph_import || 0) +
      (formData.freight_charges || 0) +
      (formData.clearing_forwarding || 0) +
      (formData.port_charges || 0) +
      (formData.container_handling || 0) +
      (formData.transportation || 0) +
      (formData.loading_import || 0) +
      (formData.bpom_ski_fees || 0) +
      (formData.other_import_costs || 0)
    );
  };

  return (
    <Layout>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-blue-100 rounded-lg">
              <Package className="w-6 h-6 text-blue-600" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-gray-900">Import Containers</h1>
              <p className="text-sm text-gray-600">Track import shipments and allocate costs to batches</p>
            </div>
          </div>
          <button
            onClick={() => {
              setEditingContainer(null);
              resetForm();
              setShowModal(true);
            }}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
          >
            <Plus className="w-5 h-5" />
            New Container
          </button>
        </div>

        <div className="bg-white rounded-lg shadow overflow-hidden">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Container Ref</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Supplier</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Import Date</th>
                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">Invoice Value</th>
                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">Import Expenses</th>
                <th className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase">Status</th>
                <th className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase">Actions</th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {loading ? (
                <tr>
                  <td colSpan={7} className="px-6 py-8 text-center text-gray-500">
                    Loading...
                  </td>
                </tr>
              ) : containers.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-6 py-8 text-center text-gray-500">
                    No import containers found. Create your first container to start tracking costs.
                  </td>
                </tr>
              ) : (
                containers.map((container) => (
                  <tr key={container.id} className="hover:bg-gray-50">
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="text-sm font-medium text-gray-900">{container.container_ref}</div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="text-sm text-gray-900">{container.suppliers?.company_name}</div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="text-sm text-gray-900">
                        {new Date(container.import_date).toLocaleDateString()}
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-right">
                      <div className="text-sm text-gray-900">
                        {formatCurrency(container.import_invoice_value, container.currency)}
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-right">
                      <div className="text-sm text-gray-900 font-semibold">
                        {formatCurrency(container.linked_expenses_total || 0, 'IDR')}
                      </div>
                      {container.total_import_expenses > 0 && container.total_import_expenses !== container.linked_expenses_total && (
                        <div className="text-xs text-gray-500">
                          Direct: {formatCurrency(container.total_import_expenses, 'IDR')}
                        </div>
                      )}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-center">
                      {getStatusBadge(container.status)}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-center">
                      <div className="flex items-center justify-center gap-2">
                        {container.status === 'draft' && (
                          <>
                            <button
                              onClick={() => handleEdit(container)}
                              className="text-blue-600 hover:text-blue-800"
                              title="Edit"
                            >
                              <Edit className="w-4 h-4" />
                            </button>
                            <button
                              onClick={() => handleAllocate(container.id)}
                              className="text-green-600 hover:text-green-800"
                              title="Allocate Costs"
                            >
                              <CheckCircle className="w-4 h-4" />
                            </button>
                          </>
                        )}
                        {container.status !== 'draft' && (
                          <span className="text-gray-400 text-xs">Locked</span>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {showModal && (
          <Modal
            isOpen={showModal}
            onClose={() => {
              setShowModal(false);
              setEditingContainer(null);
              resetForm();
            }}
            title={editingContainer ? 'Edit Import Container' : 'New Import Container'}
            maxWidth="max-w-4xl"
          >
            <form onSubmit={handleSubmit} className="space-y-6">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Container Ref <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    value={formData.container_ref}
                    onChange={(e) => setFormData({ ...formData, container_ref: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                    required
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Supplier <span className="text-red-500">*</span>
                  </label>
                  <select
                    value={formData.supplier_id}
                    onChange={(e) => setFormData({ ...formData, supplier_id: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                    required
                  >
                    <option value="">Select Supplier</option>
                    {suppliers.map((supplier) => (
                      <option key={supplier.id} value={supplier.id}>
                        {supplier.company_name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Import Date <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="date"
                    value={formData.import_date}
                    onChange={(e) => setFormData({ ...formData, import_date: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                    required
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Currency</label>
                  <select
                    value={formData.currency}
                    onChange={(e) => setFormData({ ...formData, currency: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                  >
                    <option value="USD">USD</option>
                    <option value="IDR">IDR</option>
                    <option value="CNY">CNY</option>
                    <option value="INR">INR</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Exchange Rate
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    value={formData.exchange_rate}
                    onChange={(e) => setFormData({ ...formData, exchange_rate: parseFloat(e.target.value) || 0 })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Invoice Value <span className="text-red-500">*</span>
                </label>
                <input
                  type="number"
                  step="0.01"
                  value={formData.import_invoice_value}
                  onChange={(e) => setFormData({ ...formData, import_invoice_value: parseFloat(e.target.value) || 0 })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                  required
                />
              </div>

              <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                <h3 className="text-sm font-semibold text-blue-900 mb-3">Import Cost Breakdown (IDR)</h3>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">
                      BM (Duty)
                    </label>
                    <input
                      type="number"
                      step="0.01"
                      value={formData.duty_bm}
                      onChange={(e) => setFormData({ ...formData, duty_bm: parseFloat(e.target.value) || 0 })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">
                      PPN Import
                    </label>
                    <input
                      type="number"
                      step="0.01"
                      value={formData.ppn_import}
                      onChange={(e) => setFormData({ ...formData, ppn_import: parseFloat(e.target.value) || 0 })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">
                      PPh Import
                    </label>
                    <input
                      type="number"
                      step="0.01"
                      value={formData.pph_import}
                      onChange={(e) => setFormData({ ...formData, pph_import: parseFloat(e.target.value) || 0 })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">
                      Freight Charges
                    </label>
                    <input
                      type="number"
                      step="0.01"
                      value={formData.freight_charges}
                      onChange={(e) => setFormData({ ...formData, freight_charges: parseFloat(e.target.value) || 0 })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">
                      Clearing & Forwarding
                    </label>
                    <input
                      type="number"
                      step="0.01"
                      value={formData.clearing_forwarding}
                      onChange={(e) => setFormData({ ...formData, clearing_forwarding: parseFloat(e.target.value) || 0 })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">
                      Port Charges
                    </label>
                    <input
                      type="number"
                      step="0.01"
                      value={formData.port_charges}
                      onChange={(e) => setFormData({ ...formData, port_charges: parseFloat(e.target.value) || 0 })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">
                      Container Handling
                    </label>
                    <input
                      type="number"
                      step="0.01"
                      value={formData.container_handling}
                      onChange={(e) => setFormData({ ...formData, container_handling: parseFloat(e.target.value) || 0 })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">
                      Transportation
                    </label>
                    <input
                      type="number"
                      step="0.01"
                      value={formData.transportation}
                      onChange={(e) => setFormData({ ...formData, transportation: parseFloat(e.target.value) || 0 })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">
                      Loading / Unloading
                    </label>
                    <input
                      type="number"
                      step="0.01"
                      value={formData.loading_import}
                      onChange={(e) => setFormData({ ...formData, loading_import: parseFloat(e.target.value) || 0 })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">
                      BPOM / SKI Fees
                    </label>
                    <input
                      type="number"
                      step="0.01"
                      value={formData.bpom_ski_fees}
                      onChange={(e) => setFormData({ ...formData, bpom_ski_fees: parseFloat(e.target.value) || 0 })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
                    />
                  </div>
                  <div className="col-span-2">
                    <label className="block text-xs font-medium text-gray-700 mb-1">
                      Other Import Costs
                      <span className="text-xs text-blue-600 ml-2">✓ Auto-calculated from expenses</span>
                    </label>
                    <input
                      type="number"
                      step="0.01"
                      value={formData.other_import_costs}
                      readOnly
                      disabled
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-gray-100 cursor-not-allowed"
                      title="This is automatically calculated from all 'Other (Import)' expenses linked to this container"
                    />
                    <p className="text-xs text-gray-600 mt-1">
                      Add expenses with category "Other (Import)" in Finance → Expenses to update this
                    </p>
                  </div>
                </div>

                <div className="mt-4 pt-4 border-t border-blue-200">
                  <div className="flex justify-between items-center">
                    <span className="text-sm font-semibold text-blue-900">Total Import Expenses:</span>
                    <span className="text-lg font-bold text-blue-900">{formatCurrency(calculateTotal(), 'IDR')}</span>
                  </div>
                </div>
              </div>

              {editingContainer && linkedExpenses.length > 0 && (
                <div className="bg-green-50 border-2 border-green-200 rounded-lg p-4">
                  <h3 className="text-sm font-semibold text-green-900 mb-3">
                    📎 Linked Expenses from Finance Tracker
                  </h3>
                  <div className="space-y-2 max-h-60 overflow-y-auto">
                    {linkedExpenses.map((expense) => (
                      <div key={expense.id} className="bg-white rounded p-3 flex justify-between items-center">
                        <div className="flex-1">
                          <div className="font-medium text-sm text-gray-900">
                            {getExpenseCategoryLabel(expense.expense_category)}
                          </div>
                          <div className="text-xs text-gray-600">
                            {expense.expense_date} • {expense.description || 'No description'}
                          </div>
                        </div>
                        <div className="text-right">
                          <div className="font-semibold text-green-700">
                            {formatCurrency(expense.amount, 'IDR')}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="mt-3 pt-3 border-t border-green-300 flex justify-between items-center">
                    <span className="text-sm font-semibold text-green-900">Total from Linked Expenses:</span>
                    <span className="text-lg font-bold text-green-900">
                      {formatCurrency(linkedExpenses.reduce((sum, exp) => sum + exp.amount, 0), 'IDR')}
                    </span>
                  </div>
                  <p className="mt-2 text-xs text-green-700">
                    💡 These expenses are automatically linked to this container. Add new expenses in the Finance &gt; Expense Manager and select this container.
                  </p>
                </div>
              )}

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
                <textarea
                  value={formData.notes}
                  onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                  rows={2}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                />
              </div>

              <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
                <div className="flex gap-2">
                  <AlertCircle className="w-5 h-5 text-amber-600 flex-shrink-0" />
                  <div className="text-sm text-amber-800">
                    <p className="font-medium mb-1">Important:</p>
                    <ul className="list-disc list-inside space-y-1">
                      <li>Link batches to this container before allocating costs</li>
                      <li>Once allocated, container and batch costs are locked</li>
                      <li>Costs are allocated proportionally by invoice value</li>
                      <li>All import costs will be CAPITALIZED to inventory</li>
                    </ul>
                  </div>
                </div>
              </div>

              <div className="flex justify-end gap-3 pt-4">
                <button
                  type="button"
                  onClick={() => {
                    setShowModal(false);
                    setEditingContainer(null);
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
                  {editingContainer ? 'Update' : 'Create'} Container
                </button>
              </div>
            </form>
          </Modal>
        )}
      </div>
    </Layout>
  );
}
