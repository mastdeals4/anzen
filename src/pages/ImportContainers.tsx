import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { useLanguage } from '../contexts/LanguageContext';
import { Layout } from '../components/Layout';
import { Package, Plus, Edit, Lock, CheckCircle, AlertCircle } from 'lucide-react';
import { Modal } from '../components/Modal';
import { SearchableSelect } from '../components/SearchableSelect';
import { MoneyInput } from '../components/MoneyInput';
import { showToast } from '../components/ToastNotification';
import { showConfirm } from '../components/ConfirmDialog';
import { formatDate } from '../utils/dateFormat';
import { canSeeInventoryCosting } from '../utils/permissions';
import { calculateCanonicalExpenseTotal } from '../utils/taxCalculations';
import type { BrokerItem } from '../utils/taxCalculations';
import { getEffectiveExpensePostingStates, isEffectiveExpensePosting } from '../services/expensePostingLifecycle';

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
  ppn_amount?: number | null;
  pph_amount?: number | null;
  stamp_duty_amount?: number | null;
  bank_charges_amount?: number | null;
  broker_items?: BrokerItem[] | null;
}

export default function ImportContainers() {
  const { user, profile } = useAuth();
  const { t } = useLanguage();
  const canViewCosting = canSeeInventoryCosting(profile?.role);
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

    const containerSubscription = supabase
      .channel('container-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'import_containers' }, () => fetchContainers())
      .subscribe();

    const expenseSubscription = supabase
      .channel('expense-container-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'finance_expenses' }, () => fetchContainers())
      .subscribe();

    return () => {
      containerSubscription.unsubscribe();
      expenseSubscription.unsubscribe();
    };
  }, [canViewCosting]);

  const fetchContainers = async () => {
    try {
      setLoading(true);
      const containerColumns = canViewCosting
        ? '*, suppliers(id, company_name)'
        : `
          id,
          container_ref,
          supplier_id,
          import_date,
          status,
          locked_at,
          notes,
          suppliers(id, company_name)
        `;
      const { data: containersData, error } = await supabase
        .from('import_containers')
        .select(containerColumns)
        .order('created_at', { ascending: false });

      if (error) throw error;

      const containerRows = (containersData ?? []) as unknown as ImportContainer[];
      const containersWithExpenses = canViewCosting
        ? await Promise.all(
            containerRows.map(async (container) => {
              const { data: expenses } = await supabase
                .from('finance_expenses')
                .select('id, amount, expense_category, ppn_amount, pph_amount, stamp_duty_amount, bank_charges_amount, broker_items')
                .eq('import_container_id', container.id);
              const states = await getEffectiveExpensePostingStates((expenses || []).map(expense => expense.id));
              const linkedExpensesTotal = expenses
                ?.filter(expense => isEffectiveExpensePosting(states.get(expense.id)?.effective_posting_state))
                .reduce((sum, exp) => sum + calculateCanonicalExpenseTotal(exp), 0) || 0;
              return { ...container, linked_expenses_total: linkedExpensesTotal };
            })
          )
        : containerRows;

      setContainers(containersWithExpenses);
    } catch (error: any) {
      showToast({ type: 'error', title: t('common.error'), message: 'Failed to load import containers' });
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
      const operationalData = {
        container_ref: formData.container_ref,
        supplier_id: formData.supplier_id,
        import_date: formData.import_date,
        notes: formData.notes,
        created_by: user?.id,
      };
      const costingData = canViewCosting ? {
        import_invoice_value: formData.import_invoice_value,
        currency: formData.currency,
        exchange_rate: formData.exchange_rate,
        duty_bm: formData.duty_bm,
        ppn_import: formData.ppn_import,
        pph_import: formData.pph_import,
        freight_charges: formData.freight_charges,
        clearing_forwarding: formData.clearing_forwarding,
        port_charges: formData.port_charges,
        container_handling: formData.container_handling,
        transportation: formData.transportation,
        loading_import: formData.loading_import,
        bpom_ski_fees: formData.bpom_ski_fees,
        other_import_costs: formData.other_import_costs,
      } : editingContainer ? {} : {
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
      };
      const containerData = { ...operationalData, ...costingData };

      if (editingContainer) {
        const { error } = await supabase.from('import_containers').update(containerData).eq('id', editingContainer.id);
        if (error) throw error;
        showToast({ type: 'success', title: t('common.success'), message: t('success.updated') });
      } else {
        const { error } = await supabase.from('import_containers').insert([containerData]);
        if (error) throw error;
        showToast({ type: 'success', title: t('common.success'), message: t('success.created') });
      }

      setShowModal(false);
      setEditingContainer(null);
      resetForm();
      fetchContainers();
    } catch (error: any) {
      showToast({ type: 'error', title: t('common.error'), message: 'Failed to save container: ' + error.message });
    }
  };

  const handleAllocate = async (containerId: string) => {
    if (!await showConfirm({ title: t('common.confirm'), message: t('confirm.allocateCosts'), variant: 'warning', confirmLabel: t('importContainers.allocateCosts') })) return;

    try {
      const { data, error } = await supabase.rpc('allocate_import_costs_to_batches', { p_container_id: containerId });
      if (error) throw error;

      const result = data as any;
      if (result.success) {
        const message = canViewCosting
          ? `Allocated costs to ${result.batches_allocated} batches. Total: Rp ${result.total_cost?.toLocaleString()}`
          : `Allocated costs to ${result.batches_allocated} batches.`;
        showToast({ type: 'success', title: t('common.success'), message });
        fetchContainers();
      } else {
        showToast({ type: 'error', title: t('common.error'), message: result.error });
      }
    } catch (error: any) {
      showToast({ type: 'error', title: t('common.error'), message: 'Failed to allocate costs: ' + error.message });
    }
  };

  const resetForm = () => {
    setFormData({
      container_ref: '', supplier_id: '',
      import_date: new Date().toISOString().split('T')[0],
      import_invoice_value: 0, currency: 'USD', exchange_rate: 15000,
      duty_bm: 0, ppn_import: 0, pph_import: 0, freight_charges: 0,
      clearing_forwarding: 0, port_charges: 0, container_handling: 0,
      transportation: 0, other_import_costs: 0, notes: ''
      , loading_import: 0, bpom_ski_fees: 0
    });
    setLinkedExpenses([]);
  };

  const loadLinkedExpenses = async (containerId: string) => {
    try {
      const { data, error } = await supabase
        .from('finance_expenses')
        .select('id, expense_category, amount, expense_date, description, ppn_amount, pph_amount, stamp_duty_amount, bank_charges_amount, broker_items')
        .eq('import_container_id', containerId)
        .order('expense_date', { ascending: false });
      if (error) throw error;
      const states = await getEffectiveExpensePostingStates((data || []).map(expense => expense.id));
      setLinkedExpenses((data || []).filter(expense => isEffectiveExpensePosting(states.get(expense.id)?.effective_posting_state)));
    } catch {
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
    await loadLinkedExpenses(container.id);
    setShowModal(true);
  };

  const getStatusBadge = (status: string) => {
    const statusConfig: Record<string, { color: string; label: string; icon: any }> = {
      draft: { color: 'bg-gray-100 text-gray-800', label: t('common.draft'), icon: Edit },
      allocated: { color: 'bg-green-100 text-green-800', label: t('common.approved'), icon: CheckCircle },
      locked: { color: 'bg-blue-100 text-blue-800', label: t('importContainers.locked'), icon: Lock },
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
    if (currency === 'USD') return `$ ${amount?.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    return `Rp ${amount?.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };

  const calculateTotal = () => {
    return (formData.duty_bm || 0) + (formData.ppn_import || 0) + (formData.pph_import || 0) +
      (formData.freight_charges || 0) + (formData.clearing_forwarding || 0) + (formData.port_charges || 0) +
      (formData.container_handling || 0) + (formData.transportation || 0) + (formData.loading_import || 0) +
      (formData.bpom_ski_fees || 0) + (formData.other_import_costs || 0);
  };

  const numInput = (label: string, field: keyof typeof formData, required = false) => (
    <div>
      <label className="block text-xs font-medium text-gray-700 mb-1">{label}{required && <span className="text-red-500 ml-1">*</span>}</label>
      <MoneyInput
        value={(formData as any)[field]}
        onChange={(amount) => setFormData({ ...formData, [field]: amount })}
        className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none"
      />
    </div>
  );

  return (
    <Layout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center gap-3 justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-blue-100 rounded-lg flex-shrink-0">
              <Package className="w-6 h-6 text-blue-600" />
            </div>
            <div>
              <h1 className="text-xl sm:text-2xl font-bold text-gray-900">{t('importContainers.title')}</h1>
              <p className="text-sm text-gray-600">{t('importContainers.subtitle')}</p>
            </div>
          </div>
          <button
            onClick={() => { setEditingContainer(null); resetForm(); setShowModal(true); }}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm self-start sm:self-auto"
          >
            <Plus className="w-4 h-4" />
            {t('importContainers.newContainer')}
          </button>
        </div>

        {/* Table */}
        <div className="bg-white rounded-lg shadow overflow-hidden">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">{t('importContainers.containerRef')}</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">{t('common.supplier')}</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase hidden sm:table-cell">{t('importContainers.importDate')}</th>
                  {canViewCosting && (
                    <>
                      <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase hidden md:table-cell">{t('importContainers.invoiceValue')}</th>
                      <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">{t('importContainers.importExpenses')}</th>
                    </>
                  )}
                  <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase">{t('common.status')}</th>
                  <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase">{t('common.actions')}</th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {loading ? (
                  <tr><td colSpan={canViewCosting ? 7 : 5} className="px-4 py-8 text-center text-gray-500">{t('common.loading')}</td></tr>
                ) : containers.length === 0 ? (
                  <tr><td colSpan={canViewCosting ? 7 : 5} className="px-4 py-8 text-center text-gray-500">{t('importContainers.noContainers')}</td></tr>
                ) : (
                  containers.map((container) => (
                    <tr key={container.id} className="hover:bg-gray-50">
                      <td className="px-4 py-3 whitespace-nowrap text-sm font-medium text-gray-900">{container.container_ref}</td>
                      <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-900">{container.suppliers?.company_name}</td>
                      <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-900 hidden sm:table-cell">{formatDate(container.import_date)}</td>
                      {canViewCosting && (
                        <>
                          <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-900 text-right hidden md:table-cell">
                            {formatCurrency(container.import_invoice_value, container.currency)}
                          </td>
                          <td className="px-4 py-3 whitespace-nowrap text-right">
                            <div className="text-sm text-gray-900 font-semibold">{formatCurrency(container.linked_expenses_total || 0, 'IDR')}</div>
                            {container.total_import_expenses > 0 && (
                              <div className="text-xs text-gray-500">{t('importContainers.directCosts')}: {formatCurrency(container.total_import_expenses, 'IDR')}</div>
                            )}
                          </td>
                        </>
                      )}
                      <td className="px-4 py-3 whitespace-nowrap text-center">{getStatusBadge(container.status)}</td>
                      <td className="px-4 py-3 whitespace-nowrap text-center">
                        <div className="flex items-center justify-center gap-2">
                          {container.status === 'draft' ? (
                            <>
                              <button onClick={() => handleEdit(container)} className="text-blue-600 hover:text-blue-800" title={t('common.edit')}>
                                <Edit className="w-4 h-4" />
                              </button>
                              <button onClick={() => handleAllocate(container.id)} className="text-green-600 hover:text-green-800" title={t('importContainers.allocateCosts')}>
                                <CheckCircle className="w-4 h-4" />
                              </button>
                            </>
                          ) : (
                            <span className="text-gray-400 text-xs">{t('importContainers.locked')}</span>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Modal */}
        {showModal && (
          <Modal
            isOpen={showModal}
            onClose={() => { setShowModal(false); setEditingContainer(null); resetForm(); }}
            title={editingContainer ? t('importContainers.editContainer') : t('importContainers.addContainer')}
            maxWidth="max-w-4xl"
          >
            <form onSubmit={handleSubmit} className="space-y-5">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">{t('importContainers.containerRef')} <span className="text-red-500">*</span></label>
                  <input
                    type="text" value={formData.container_ref}
                    onChange={(e) => setFormData({ ...formData, container_ref: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none" required
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">{t('common.supplier')} <span className="text-red-500">*</span></label>
                  <SearchableSelect
                    value={formData.supplier_id}
                    onChange={(val) => setFormData({ ...formData, supplier_id: val })}
                    options={suppliers.map(s => ({ value: s.id, label: s.company_name }))}
                    placeholder={t('finance.selectSupplier')}
                  />
                </div>
              </div>

              <div className={`grid grid-cols-1 ${canViewCosting ? 'sm:grid-cols-3' : 'sm:grid-cols-1'} gap-4`}>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">{t('importContainers.importDate')} <span className="text-red-500">*</span></label>
                  <input type="date" value={formData.import_date}
                    onChange={(e) => setFormData({ ...formData, import_date: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none" required
                  />
                </div>
                {canViewCosting && (
                  <>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">{t('salesOrders.currency')}</label>
                      <select value={formData.currency} onChange={(e) => setFormData({ ...formData, currency: e.target.value })}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none">
                        <option>USD</option><option>IDR</option><option>CNY</option><option>INR</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">{t('validation.enterExchangeRate').replace('Please enter a valid ', '')}</label>
                      <input type="number" step="0.01" value={formData.exchange_rate}
                        onChange={(e) => setFormData({ ...formData, exchange_rate: parseFloat(e.target.value) || 0 })}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
                      />
                    </div>
                  </>
                )}
              </div>

              {canViewCosting && (
                <>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">{t('importContainers.invoiceValue')} <span className="text-red-500">*</span></label>
                    <MoneyInput value={formData.import_invoice_value}
                      onChange={(amount) => setFormData({ ...formData, import_invoice_value: amount })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none" required
                    />
                  </div>

                  <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                    <h3 className="text-sm font-semibold text-blue-900 mb-3">{t('importContainers.importCostBreakdown')}</h3>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      {numInput(t('importContainers.dutyBm'), 'duty_bm')}
                      {numInput(t('importContainers.ppnImport'), 'ppn_import')}
                      {numInput(t('importContainers.pphImport'), 'pph_import')}
                      {numInput(t('importContainers.freightCharges'), 'freight_charges')}
                      {numInput(t('importContainers.clearingForwarding'), 'clearing_forwarding')}
                      {numInput(t('importContainers.portCharges'), 'port_charges')}
                      {numInput(t('importContainers.containerHandling'), 'container_handling')}
                      {numInput(t('importContainers.transportation'), 'transportation')}
                      {numInput(t('importContainers.loadingUnloading'), 'loading_import')}
                      {numInput(t('importContainers.bpomFees'), 'bpom_ski_fees')}
                      <div className="sm:col-span-2">
                        <label className="block text-xs font-medium text-gray-700 mb-1">
                          {t('importContainers.otherImportCosts')}
                          <span className="text-xs text-blue-600 ml-2">✓ {t('importContainers.autoCalculated')}</span>
                        </label>
                        <MoneyInput value={formData.other_import_costs} readOnly disabled hideZero={false}
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-gray-100 cursor-not-allowed"
                          onChange={() => undefined}
                        />
                      </div>
                    </div>
                    <div className="mt-4 pt-4 border-t border-blue-200 flex justify-between items-center">
                      <span className="text-sm font-semibold text-blue-900">{t('importContainers.totalImportExpenses')}:</span>
                      <span className="text-lg font-bold text-blue-900">{formatCurrency(calculateTotal(), 'IDR')}</span>
                    </div>
                  </div>
                </>
              )}

              {canViewCosting && editingContainer && linkedExpenses.length > 0 && (
                <div className="bg-green-50 border-2 border-green-200 rounded-lg p-4">
                  <h3 className="text-sm font-semibold text-green-900 mb-3">📎 {t('importContainers.linkedExpenses')}</h3>
                  <div className="space-y-2 max-h-60 overflow-y-auto">
                    {linkedExpenses.map((expense) => (
                      <div key={expense.id} className="bg-white rounded p-3 flex justify-between items-center gap-2">
                        <div className="flex-1 min-w-0">
                          <div className="font-medium text-sm text-gray-900 truncate">{getExpenseCategoryLabel(expense.expense_category)}</div>
                          <div className="text-xs text-gray-600">{expense.expense_date} • {expense.description || 'No description'}</div>
                        </div>
                        <div className="font-semibold text-green-700 text-sm whitespace-nowrap">{formatCurrency(calculateCanonicalExpenseTotal(expense), 'IDR')}</div>
                      </div>
                    ))}
                  </div>
                  <div className="mt-3 pt-3 border-t border-green-300 flex justify-between items-center">
                    <span className="text-sm font-semibold text-green-900">{t('importContainers.totalFromLinked')}:</span>
                    <span className="text-lg font-bold text-green-900">{formatCurrency(linkedExpenses.reduce((sum, exp) => sum + calculateCanonicalExpenseTotal(exp), 0), 'IDR')}</span>
                  </div>
                </div>
              )}

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">{t('common.notes')}</label>
                <textarea value={formData.notes} onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                  rows={2} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
                />
              </div>

              {canViewCosting && (
                <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
                <div className="flex gap-2">
                  <AlertCircle className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
                  <ul className="text-sm text-amber-800 list-disc list-inside space-y-1">
                    <li>Link batches to this container before allocating costs</li>
                    <li>Once allocated, container and batch costs are locked</li>
                    <li>Costs are allocated proportionally by invoice value</li>
                    <li>All import costs will be CAPITALIZED to inventory</li>
                  </ul>
                </div>
              </div>
              )}

              <div className="flex justify-end gap-3 pt-2">
                <button type="button" onClick={() => { setShowModal(false); setEditingContainer(null); resetForm(); }}
                  className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 text-sm">
                  {t('common.cancel')}
                </button>
                <button type="submit" className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm">
                  {editingContainer ? t('common.update') : t('common.create')}
                </button>
              </div>
            </form>
          </Modal>
        )}
      </div>
    </Layout>
  );
}
