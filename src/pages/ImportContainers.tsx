import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { useLanguage } from '../contexts/LanguageContext';
import { Layout } from '../components/Layout';
import { Package, Plus, CreditCard as Edit, Lock, CheckCircle, AlertCircle, Info } from 'lucide-react';
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
  other_import_costs: number;
  total_import_expenses: number;
  allocated_expenses: number;
  allocation_method: string;
  status: string;
  locked_at: string | null;
  notes: string;
  suppliers?: Supplier;
  linked_expenses_total?: number;
  linked_petty_cash_total?: number;
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
  include_in_landed_cost?: boolean | null;
  pib_bm_amount?: number | null;
  pib_ppn_amount?: number | null;
  pib_pph_amount?: number | null;
}

interface LinkedPettyCash {
  id: string;
  transaction_number: string;
  transaction_type: string;
  amount: number;
  description: string;
  transaction_date: string;
  expense_category: string | null;
  include_in_landed_cost?: boolean | null;
}

type SourceType = 'expense' | 'petty_cash';

interface UnifiedLinkedItem {
  id: string;
  source: SourceType;
  category: string;
  amount: number;
  date: string;
  description: string;
  include_in_landed_cost: boolean;
  isPIB: boolean;
  pib_bm_amount?: number | null;
  pib_ppn_amount?: number | null;
  pib_pph_amount?: number | null;
  rawExpense?: LinkedExpense;
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
  const [linkedPettyCash, setLinkedPettyCash] = useState<LinkedPettyCash[]>([]);
  const [inclusionMap, setInclusionMap] = useState<Record<string, boolean>>({});
  const [savingInclusion, setSavingInclusion] = useState(false);
  const [formData, setFormData] = useState({
    container_ref: '',
    supplier_id: '',
    import_date: new Date().toISOString().split('T')[0],
    import_invoice_value: 0,
    currency: 'USD',
    exchange_rate: 15000,
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

    const pettyCashSubscription = supabase
      .channel('petty-cash-container-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'petty_cash_transactions' }, () => fetchContainers())
      .subscribe();

    return () => {
      containerSubscription.unsubscribe();
      expenseSubscription.unsubscribe();
      pettyCashSubscription.unsubscribe();
    };
  }, [canViewCosting]);

  const fetchContainers = async () => {
    try {
      setLoading(true);
      const containerColumns = canViewCosting
        ? '*, suppliers(id, company_name)'
        : `id, container_ref, supplier_id, import_date, status, locked_at, notes, suppliers(id, company_name)`;
      const { data: containersData, error } = await supabase
        .from('import_containers')
        .select(containerColumns)
        .order('created_at', { ascending: false });

      if (error) throw error;

      const containerRows = (containersData ?? []) as unknown as ImportContainer[];
      const containersWithExpenses = canViewCosting
        ? await Promise.all(
            containerRows.map(async (container) => {
              const [{ data: expenses }, { data: pettyCash }] = await Promise.all([
                supabase.from('finance_expenses').select('id, amount, expense_category, include_in_landed_cost').eq('import_container_id', container.id),
                supabase.from('petty_cash_transactions').select('id, amount, include_in_landed_cost').eq('import_container_id', container.id),
              ]);
              const states = await getEffectiveExpensePostingStates((expenses || []).map(e => e.id));
              const linkedExpensesTotal = (expenses || [])
                .filter(e => isEffectiveExpensePosting(states.get(e.id)?.effective_posting_state))
                .filter(e => e.include_in_landed_cost === true)
                .reduce((sum, e) => sum + calculateCanonicalExpenseTotal(e), 0) || 0;
              const linkedPettyCashTotal = (pettyCash || [])
                .filter(pc => pc.include_in_landed_cost === true)
                .reduce((sum, pc) => sum + (pc.amount || 0), 0) || 0;
              return { ...container, linked_expenses_total: linkedExpensesTotal, linked_petty_cash_total: linkedPettyCashTotal };
            })
          )
        : containerRows;

      setContainers(containersWithExpenses);
    } catch {
      showToast({ type: 'error', title: t('common.error'), message: 'Failed to load import containers' });
    } finally {
      setLoading(false);
    }
  };

  const fetchSuppliers = async () => {
    try {
      const { data, error } = await supabase.from('suppliers').select('id, company_name').eq('is_active', true).order('company_name');
      if (error) throw error;
      setSuppliers(data || []);
    } catch (error: any) {
      console.error('Error fetching suppliers:', error.message);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const operationalData = { container_ref: formData.container_ref, supplier_id: formData.supplier_id, import_date: formData.import_date, notes: formData.notes, created_by: user?.id };
      const costingData = canViewCosting ? {
        import_invoice_value: formData.import_invoice_value, currency: formData.currency, exchange_rate: formData.exchange_rate, other_import_costs: formData.other_import_costs,
      } : editingContainer ? {} : { import_invoice_value: 0, currency: 'USD', exchange_rate: 15000, other_import_costs: 0 };
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
      setShowModal(false); setEditingContainer(null); resetForm(); fetchContainers();
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
        const message = canViewCosting ? `Allocated costs to ${result.batches_allocated} batches. Total: Rp ${result.total_cost?.toLocaleString()}` : `Allocated costs to ${result.batches_allocated} batches.`;
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
    setFormData({ container_ref: '', supplier_id: '', import_date: new Date().toISOString().split('T')[0], import_invoice_value: 0, currency: 'USD', exchange_rate: 15000, other_import_costs: 0, notes: '' });
    setLinkedExpenses([]); setLinkedPettyCash([]); setInclusionMap({});
  };

  const loadLinkedExpenses = async (containerId: string) => {
    try {
      const [{ data: expData, error: expError }, { data: pcData, error: pcError }] = await Promise.all([
        supabase.from('finance_expenses').select('id, expense_category, amount, expense_date, description, ppn_amount, pph_amount, stamp_duty_amount, bank_charges_amount, broker_items, include_in_landed_cost, pib_bm_amount, pib_ppn_amount, pib_pph_amount').eq('import_container_id', containerId).order('expense_date', { ascending: false }),
        supabase.from('petty_cash_transactions').select('id, transaction_number, transaction_type, amount, description, transaction_date, expense_category, include_in_landed_cost').eq('import_container_id', containerId).order('transaction_date', { ascending: false }),
      ]);
      if (expError) throw expError;
      if (pcError) throw pcError;

      const states = await getEffectiveExpensePostingStates((expData || []).map(e => e.id));
      const activeExpenses = (expData || []).filter(e => isEffectiveExpensePosting(states.get(e.id)?.effective_posting_state));
      setLinkedExpenses(activeExpenses);
      setLinkedPettyCash((pcData || []) as LinkedPettyCash[]);

      const map: Record<string, boolean> = {};
      for (const e of activeExpenses) map[e.id] = e.include_in_landed_cost === true;
      for (const pc of (pcData || [])) map[pc.id] = pc.include_in_landed_cost === true;
      setInclusionMap(map);
    } catch {
      setLinkedExpenses([]); setLinkedPettyCash([]); setInclusionMap({});
    }
  };

  const handleToggleInclusion = async (itemId: string, source: SourceType, checked: boolean) => {
    setInclusionMap(prev => ({ ...prev, [itemId]: checked }));
    setSavingInclusion(true);
    try {
      const table = source === 'expense' ? 'finance_expenses' : 'petty_cash_transactions';
      const { error } = await supabase.from(table).update({ include_in_landed_cost: checked }).eq('id', itemId);
      if (error) throw error;
    } catch (error: any) {
      setInclusionMap(prev => ({ ...prev, [itemId]: !checked }));
      showToast({ type: 'error', title: t('common.error'), message: 'Failed to update: ' + error.message });
    } finally {
      setSavingInclusion(false);
    }
  };

  const handleSelectAll = async () => {
    const updates: Record<string, boolean> = {};
    for (const item of unifiedItems) {
      if (!item.isPIB) { updates[item.id] = true; }
    }
    setInclusionMap(prev => ({ ...prev, ...updates }));
    setSavingInclusion(true);
    try {
      for (const item of unifiedItems) {
        if (!item.isPIB && !updates[item.id]) continue;
        if (!item.isPIB) {
          const table = item.source === 'expense' ? 'finance_expenses' : 'petty_cash_transactions';
          await supabase.from(table).update({ include_in_landed_cost: true }).eq('id', item.id);
        }
      }
    } catch (error: any) {
      showToast({ type: 'error', title: t('common.error'), message: 'Failed to select all: ' + error.message });
    } finally {
      setSavingInclusion(false);
    }
  };

  const handleClearAll = async () => {
    const updates: Record<string, boolean> = {};
    for (const item of unifiedItems) {
      if (!item.isPIB) { updates[item.id] = false; }
    }
    setInclusionMap(prev => ({ ...prev, ...updates }));
    setSavingInclusion(true);
    try {
      for (const item of unifiedItems) {
        if (!item.isPIB) {
          const table = item.source === 'expense' ? 'finance_expenses' : 'petty_cash_transactions';
          await supabase.from(table).update({ include_in_landed_cost: false }).eq('id', item.id);
        }
      }
    } catch (error: any) {
      showToast({ type: 'error', title: t('common.error'), message: 'Failed to clear all: ' + error.message });
    } finally {
      setSavingInclusion(false);
    }
  };

  const getCategoryLabel = (category: string): string => {
    const labels: Record<string, string> = {
      duty_customs: 'Duty & Customs (BM)', duty_import: 'Import Duty', ppn_import: 'PPN Import', pph_import: 'PPh Import',
      pib_import: 'PIB Import', freight_import: 'Freight (Import)', clearing_forwarding: 'Clearing & Forwarding',
      port_charges: 'Port Charges', container_handling: 'Container Handling', transport_import: 'Transportation (Import)',
      loading_import: 'Loading / Unloading', bpom_ski_fees: 'BPOM / SKI Fees', import_broker: 'Import Broker',
      other_import: 'Other Import Cost', staff_welfare: 'Staff Welfare', staff_salary: 'Staff Salary',
      staff_advance: 'Staff Advance', office: 'Office', utilities: 'Utilities', salary: 'Salary',
    };
    return labels[category] || category;
  };

  const handleEdit = async (container: ImportContainer) => {
    setEditingContainer(container);
    setFormData({
      container_ref: container.container_ref, supplier_id: container.supplier_id, import_date: container.import_date,
      import_invoice_value: container.import_invoice_value || 0, currency: container.currency || 'USD',
      exchange_rate: container.exchange_rate || 15000, other_import_costs: container.other_import_costs || 0, notes: container.notes || ''
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
    return (<span className={`inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded ${config.color}`}><Icon className="w-3 h-3" />{config.label}</span>);
  };

  const formatCurrency = (amount: number, currency: string = 'IDR') => {
    if (currency === 'USD') return `$ ${amount?.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    return `Rp ${amount?.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };

  // Build unified list: expenses (excluding PIB) + petty cash
  const unifiedItems: UnifiedLinkedItem[] = [
    ...linkedExpenses.filter(e => e.expense_category !== 'pib_import').map(e => ({
      id: e.id, source: 'expense' as SourceType, category: e.expense_category, amount: calculateCanonicalExpenseTotal(e),
      date: e.expense_date, description: e.description || '', include_in_landed_cost: inclusionMap[e.id] === true,
      isPIB: false,
    })),
    ...linkedPettyCash.map(pc => ({
      id: pc.id, source: 'petty_cash' as SourceType, category: pc.expense_category || pc.transaction_type,
      amount: pc.amount, date: pc.transaction_date, description: pc.description || '',
      include_in_landed_cost: inclusionMap[pc.id] === true, isPIB: false,
    })),
  ];

  // PIB expenses shown only in breakdown section
  const pibExpenses = linkedExpenses.filter(e => e.expense_category === 'pib_import');
  const pibDutyTotal = pibExpenses.reduce((s, e) => s + (e.pib_bm_amount || 0), 0);
  const pibPpnTotal = pibExpenses.reduce((s, e) => s + (e.pib_ppn_amount || 0), 0);
  const pibPphTotal = pibExpenses.reduce((s, e) => s + (e.pib_pph_amount || 0), 0);
  const pibPaymentTotal = pibExpenses.reduce((s, e) => s + (e.amount || 0), 0);

  const selectedLinkedTotal = unifiedItems.filter(i => i.include_in_landed_cost).reduce((s, i) => s + i.amount, 0);
  const landedCostPool = selectedLinkedTotal + (formData.other_import_costs || 0);
  const hasLinkedItems = unifiedItems.length > 0 || pibExpenses.length > 0;

  return (
    <Layout>
      <div className="space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center gap-3 justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-blue-100 rounded-lg flex-shrink-0"><Package className="w-6 h-6 text-blue-600" /></div>
            <div><h1 className="text-xl sm:text-2xl font-bold text-gray-900">{t('importContainers.title')}</h1><p className="text-sm text-gray-600">{t('importContainers.subtitle')}</p></div>
          </div>
          <button onClick={() => { setEditingContainer(null); resetForm(); setShowModal(true); }} className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm self-start sm:self-auto">
            <Plus className="w-4 h-4" />{t('importContainers.newContainer')}
          </button>
        </div>

        <div className="bg-white rounded-lg shadow overflow-hidden">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">{t('importContainers.containerRef')}</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">{t('common.supplier')}</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase hidden sm:table-cell">{t('importContainers.importDate')}</th>
                  {canViewCosting && (<>
                    <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase hidden md:table-cell">{t('importContainers.invoiceValue')}</th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Landed-Cost Pool</th>
                  </>)}
                  <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase">{t('common.status')}</th>
                  <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase">{t('common.actions')}</th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {loading ? (<tr><td colSpan={canViewCosting ? 7 : 5} className="px-4 py-8 text-center text-gray-500">{t('common.loading')}</td></tr>)
                : containers.length === 0 ? (<tr><td colSpan={canViewCosting ? 7 : 5} className="px-4 py-8 text-center text-gray-500">{t('importContainers.noContainers')}</td></tr>)
                : containers.map((container) => (
                  <tr key={container.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 whitespace-nowrap text-sm font-medium text-gray-900">{container.container_ref}</td>
                    <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-900">{container.suppliers?.company_name}</td>
                    <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-900 hidden sm:table-cell">{formatDate(container.import_date)}</td>
                    {canViewCosting && (<>
                      <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-900 text-right hidden md:table-cell">{formatCurrency(container.import_invoice_value, container.currency)}</td>
                      <td className="px-4 py-3 whitespace-nowrap text-right">
                        <div className="text-sm text-gray-900 font-semibold">{formatCurrency((container.linked_expenses_total || 0) + (container.linked_petty_cash_total || 0) + (container.other_import_costs || 0), 'IDR')}</div>
                        <div className="text-xs text-gray-500">Linked: {formatCurrency((container.linked_expenses_total || 0) + (container.linked_petty_cash_total || 0), 'IDR')} + Other: {formatCurrency(container.other_import_costs || 0, 'IDR')}</div>
                      </td>
                    </>)}
                    <td className="px-4 py-3 whitespace-nowrap text-center">{getStatusBadge(container.status)}</td>
                    <td className="px-4 py-3 whitespace-nowrap text-center">
                      <div className="flex items-center justify-center gap-2">
                        {container.status === 'draft' ? (<>
                          <button onClick={() => handleEdit(container)} className="text-blue-600 hover:text-blue-800" title={t('common.edit')}><Edit className="w-4 h-4" /></button>
                          <button onClick={() => handleAllocate(container.id)} className="text-green-600 hover:text-green-800" title={t('importContainers.allocateCosts')}><CheckCircle className="w-4 h-4" /></button>
                        </>) : (<span className="text-gray-400 text-xs">{t('importContainers.locked')}</span>)}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {showModal && (
          <Modal isOpen={showModal} onClose={() => { setShowModal(false); setEditingContainer(null); resetForm(); }} title={editingContainer ? t('importContainers.editContainer') : t('importContainers.addContainer')} maxWidth="max-w-4xl">
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">{t('importContainers.containerRef')} <span className="text-red-500">*</span></label>
                  <input type="text" value={formData.container_ref} onChange={(e) => setFormData({ ...formData, container_ref: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none" required />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">{t('common.supplier')} <span className="text-red-500">*</span></label>
                  <SearchableSelect value={formData.supplier_id} onChange={(val) => setFormData({ ...formData, supplier_id: val })} options={suppliers.map(s => ({ value: s.id, label: s.company_name }))} placeholder={t('finance.selectSupplier')} />
                </div>
              </div>

              <div className={`grid grid-cols-1 ${canViewCosting ? 'sm:grid-cols-3' : 'sm:grid-cols-1'} gap-4`}>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">{t('importContainers.importDate')} <span className="text-red-500">*</span></label>
                  <input type="date" value={formData.import_date} onChange={(e) => setFormData({ ...formData, import_date: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none" required />
                </div>
                {canViewCosting && (<>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">{t('salesOrders.currency')}</label>
                    <select value={formData.currency} onChange={(e) => setFormData({ ...formData, currency: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"><option>USD</option><option>IDR</option><option>CNY</option><option>INR</option></select>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Exchange Rate (IDR per USD)</label>
                    <input type="number" step="0.01" value={formData.exchange_rate} onChange={(e) => setFormData({ ...formData, exchange_rate: parseFloat(e.target.value) || 0 })} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none" />
                  </div>
                </>)}
              </div>

              {canViewCosting && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">{t('importContainers.invoiceValue')} <span className="text-red-500">*</span></label>
                  <MoneyInput value={formData.import_invoice_value} onChange={(amount) => setFormData({ ...formData, import_invoice_value: amount })} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none" required />
                </div>
              )}

              {/* Linked Expenses + Petty Cash — compact */}
              {canViewCosting && editingContainer && hasLinkedItems && (
                <div className="bg-green-50 border border-green-200 rounded-lg p-3">
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="text-xs font-semibold text-green-900 uppercase">Linked Costs — select to include in landed cost</h3>
                    {unifiedItems.length > 0 && (
                      <div className="flex gap-2">
                        <button type="button" onClick={handleSelectAll} disabled={savingInclusion} className="text-xs px-2 py-1 bg-green-600 text-white rounded hover:bg-green-700">Select All</button>
                        <button type="button" onClick={handleClearAll} disabled={savingInclusion} className="text-xs px-2 py-1 bg-gray-200 text-gray-700 rounded hover:bg-gray-300">Clear All</button>
                      </div>
                    )}
                  </div>
                  <div className="space-y-1 max-h-60 overflow-y-auto">
                    {unifiedItems.map((item) => (
                      <div key={item.id} className="flex items-center gap-2 px-2 py-1.5 bg-white rounded text-xs">
                        <input type="checkbox" checked={item.include_in_landed_cost} onChange={(e) => handleToggleInclusion(item.id, item.source, e.target.checked)} disabled={savingInclusion} className="w-3.5 h-3.5 rounded border-gray-300 text-blue-600 focus:ring-1 focus:ring-blue-500 cursor-pointer flex-shrink-0" />
                        <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium flex-shrink-0 ${item.source === 'expense' ? 'bg-blue-100 text-blue-700' : 'bg-orange-100 text-orange-700'}`}>{item.source === 'expense' ? 'Expense' : 'Petty Cash'}</span>
                        <span className="font-medium text-gray-800 truncate flex-1">{getCategoryLabel(item.category)}</span>
                        <span className="text-gray-500 truncate hidden sm:inline max-w-[200px]">{item.description}</span>
                        <span className={`font-semibold whitespace-nowrap ${item.include_in_landed_cost ? 'text-green-700' : 'text-gray-400'}`}>{formatCurrency(item.amount, 'IDR')}</span>
                      </div>
                    ))}
                  </div>
                  <div className="mt-2 pt-2 border-t border-green-200 space-y-0.5 text-xs">
                    <div className="flex justify-between"><span className="font-semibold text-green-900">Selected Linked Costs:</span><span className="font-bold text-green-900">{formatCurrency(selectedLinkedTotal, 'IDR')}</span></div>
                    <div className="flex justify-between"><span className="font-semibold text-green-900">Other Import Costs:</span><span className="font-bold text-green-900">{formatCurrency(formData.other_import_costs || 0, 'IDR')}</span></div>
                    <div className="flex justify-between pt-1 border-t border-green-200"><span className="font-bold text-green-900">Container Landed-Cost Pool:</span><span className="text-sm font-bold text-green-900">{formatCurrency(landedCostPool, 'IDR')}</span></div>
                  </div>
                </div>
              )}

              {/* PIB Breakdown — separate, no checkboxes */}
              {canViewCosting && editingContainer && pibExpenses.length > 0 && (pibDutyTotal > 0 || pibPpnTotal > 0 || pibPphTotal > 0) && (
                <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
                  <div className="flex items-start gap-2">
                    <AlertCircle className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
                    <div className="flex-1">
                      <h3 className="text-xs font-semibold text-amber-900 uppercase mb-1">PIB / Customs Breakdown</h3>
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                        <div><div className="text-amber-700 font-medium">Import Duty (BM)</div><div className="font-bold text-amber-900">{formatCurrency(pibDutyTotal)}</div></div>
                        <div><div className="text-amber-700 font-medium">Import PPN</div><div className="font-bold text-gray-500">{formatCurrency(pibPpnTotal)}</div><div className="text-[9px] text-gray-400">Excluded</div></div>
                        <div><div className="text-amber-700 font-medium">Import PPh22</div><div className="font-bold text-gray-500">{formatCurrency(pibPphTotal)}</div><div className="text-[9px] text-gray-400">Excluded</div></div>
                        <div><div className="text-amber-700 font-medium">PIB Total</div><div className="font-bold text-amber-900">{formatCurrency(pibPaymentTotal)}</div><div className="text-[9px] text-gray-400">Not landed cost</div></div>
                      </div>
                      {pibDutyTotal > 0 && (<div className="mt-1.5 p-1.5 bg-amber-100 rounded text-[10px] text-amber-800"><strong>Import Duty detected: {formatCurrency(pibDutyTotal)}.</strong> Confirm/enter this duty in the applicable batch. Do not enter the same duty both here and on the batch.</div>)}
                    </div>
                  </div>
                </div>
              )}

              {/* Other Import Costs */}
              {canViewCosting && (
                <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
                  <label className="block text-xs font-semibold text-blue-900 mb-1">Other Import Costs</label>
                  <p className="text-[10px] text-blue-700 mb-1.5">Miscellaneous costs not covered by linked expenses. Does not create a finance expense or journal.</p>
                  <MoneyInput value={formData.other_import_costs} onChange={(amount) => setFormData({ ...formData, other_import_costs: amount })} className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none" />
                </div>
              )}

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">{t('common.notes')}</label>
                <textarea value={formData.notes} onChange={(e) => setFormData({ ...formData, notes: e.target.value })} rows={2} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none" />
              </div>

              {canViewCosting && (
                <div className="bg-amber-50 border border-amber-200 rounded-lg p-2">
                  <div className="flex gap-2"><AlertCircle className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" /><ul className="text-xs text-amber-800 list-disc list-inside space-y-0.5"><li>Link batches before allocating</li><li>Once allocated, costs are locked</li><li>Allocated proportionally by invoice value</li><li>All costs capitalized to inventory</li></ul></div>
                </div>
              )}

              <div className="flex justify-end gap-3 pt-1">
                <button type="button" onClick={() => { setShowModal(false); setEditingContainer(null); resetForm(); }} className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 text-sm">{t('common.cancel')}</button>
                <button type="submit" className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm">{editingContainer ? t('common.update') : t('common.create')}</button>
              </div>
            </form>
          </Modal>
        )}
      </div>
    </Layout>
  );
}
