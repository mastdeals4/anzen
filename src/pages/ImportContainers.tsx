import { useState, useEffect, useRef, useMemo } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { useLanguage } from '../contexts/LanguageContext';
import { Layout } from '../components/Layout';
import { Plus, CreditCard as Edit, Lock, CheckCircle, AlertCircle, FileText, X, Search, ChevronDown } from 'lucide-react';
import { Modal } from '../components/Modal';
import { SearchableSelect } from '../components/SearchableSelect';
import { MoneyInput } from '../components/MoneyInput';
import { FloatingField, FLOAT_INPUT, FLOAT_TEXTAREA } from '../components/finance/FloatingField';
import { SapRow } from '../components/finance/SapLayout';
import { showToast } from '../components/ToastNotification';

import { formatDate } from '../utils/dateFormat';
import { canSeeInventoryCosting } from '../utils/permissions';
import type { BrokerItem } from '../utils/taxCalculations';
import {
  calculateContainerLandedCostPool,
  isCapitalizableLandedCostCategory,
  isImportExpenseCategory,
  calculateExpenseLandedCostAmount,
} from '../utils/landedCost.ts';
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
  purchase_invoice_ids?: string[] | null;
  suppliers?: Supplier;
  linked_expenses_total?: number;
  linked_petty_cash_total?: number;
  canonical_landed_cost_pool?: number;
}

interface SelectablePI {
  id: string;
  invoice_number: string;
  invoice_date: string;
  supplier_id: string;
  supplier_name: string;
  currency: string;
  exchange_rate: number;
  subtotal: number;
  total_amount: number;
  po_number?: string;
  lines_count?: number;
  linked_container_id?: string | null;
  linked_container_ref?: string | null;
}

interface LinkedExpense {
  id: string;
  expense_category: string;
  amount: number;
  expense_date: string;
  description: string | null;
  voucher_number?: string | null;
  invoice_number?: string | null;
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
  referenceNumber: string;
  category: string;
  amount: number;
  date: string;
  description: string;
  include_in_landed_cost: boolean;
  isCapitalizable: boolean;
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
  const [availablePIs, setAvailablePIs] = useState<SelectablePI[]>([]);
  const [selectedPiIds, setSelectedPiIds] = useState<string[]>([]);
  const [piSearchQuery, setPiSearchQuery] = useState('');
  const [isPiDropdownOpen, setIsPiDropdownOpen] = useState(false);
  const piDropdownRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editingContainer, setEditingContainer] = useState<ImportContainer | null>(null);
  const [linkedExpenses, setLinkedExpenses] = useState<LinkedExpense[]>([]);
  const [linkedPettyCash, setLinkedPettyCash] = useState<LinkedPettyCash[]>([]);
  const [inclusionMap, setInclusionMap] = useState<Record<string, boolean>>({});
  const [savingInclusion, setSavingInclusion] = useState(false);
  const [expandedDescIds, setExpandedDescIds] = useState<Set<string>>(new Set());
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

  const toggleDescExpand = (id: string) => {
    setExpandedDescIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  useEffect(() => {
    fetchContainers();
    fetchSuppliers();
    fetchAvailablePIs();

    const containerSubscription = supabase
      .channel('container-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'import_containers' }, () => {
        fetchContainers();
        fetchAvailablePIs();
      })
      .subscribe();

    const piSubscription = supabase
      .channel('pi-container-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'purchase_invoices' }, () => {
        fetchAvailablePIs();
      })
      .subscribe();

    const piraSubscription = supabase
      .channel('pira-container-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'purchase_invoice_receiving_allocations' }, () => {
        fetchAvailablePIs();
      })
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
      supabase.removeChannel(containerSubscription);
      supabase.removeChannel(piSubscription);
      supabase.removeChannel(piraSubscription);
      supabase.removeChannel(expenseSubscription);
      supabase.removeChannel(pettyCashSubscription);
    };
  }, [canViewCosting]);

  // Close PI multi-select dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (piDropdownRef.current && !piDropdownRef.current.contains(event.target as Node)) {
        setIsPiDropdownOpen(false);
      }
    };
    if (isPiDropdownOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isPiDropdownOpen]);

  const fetchContainers = async () => {
    try {
      setLoading(true);
      const containerColumns = canViewCosting
        ? '*, suppliers(id, company_name)'
        : `id, container_ref, supplier_id, import_date, status, locked_at, notes, purchase_invoice_ids, suppliers(id, company_name)`;
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
                supabase.from('finance_expenses').select('id, amount, expense_category, ppn_amount, stamp_duty_amount, broker_items, include_in_landed_cost, pib_bm_amount, pib_ppn_amount, pib_pph_amount, voucher_number, invoice_number').eq('import_container_id', container.id),
                supabase.from('petty_cash_transactions').select('id, amount, transaction_number, transaction_type, expense_category, include_in_landed_cost').eq('import_container_id', container.id),
              ]);
              const states = await getEffectiveExpensePostingStates((expenses || []).map(e => e.id));
              const activeExpenses = (expenses || []).filter(e => isEffectiveExpensePosting(states.get(e.id)?.effective_posting_state));
              const breakdown = calculateContainerLandedCostPool({
                linkedExpenses: activeExpenses,
                linkedPettyCash: pettyCash || [],
                otherImportCosts: container.other_import_costs || 0,
              });
              return {
                ...container,
                linked_expenses_total: breakdown.selectedLandedExpensesTotal,
                linked_petty_cash_total: breakdown.selectedLandedPettyCashTotal,
                canonical_landed_cost_pool: breakdown.containerLandedCostPool,
              };
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
      const { data, error } = await supabase
        .from('suppliers')
        .select('id, company_name')
        .order('company_name');
      if (error) throw error;
      setSuppliers(data || []);
    } catch (error: any) {
      console.error('Error fetching suppliers:', error.message);
    }
  };

  const fetchAvailablePIs = async () => {
    try {
      // Query existing import relationships: import containers and receiving allocations
      const [{ data: icRows }, { data: piraRows }] = await Promise.all([
        supabase.from('import_containers').select('id, container_ref, purchase_invoice_ids'),
        supabase
          .from('purchase_invoice_receiving_allocations')
          .select('purchase_invoice_id, import_container_id')
          .not('import_container_id', 'is', null),
      ]);

      // Map container reference by container ID
      const containerRefById = new Map<string, string>();
      (icRows || []).forEach((ic: any) => {
        if (ic.id) containerRefById.set(ic.id, ic.container_ref || 'Existing Container');
      });

      // Build mapping from purchase_invoice_id -> { id: container_id, ref: container_ref }
      const piContainerMap = new Map<string, { id: string; ref: string }>();
      (icRows || []).forEach((ic: any) => {
        if (Array.isArray(ic.purchase_invoice_ids)) {
          ic.purchase_invoice_ids.forEach((id: string) => {
            if (id && !piContainerMap.has(id)) {
              piContainerMap.set(id, { id: ic.id, ref: ic.container_ref || 'Existing Container' });
            }
          });
        }
      });
      (piraRows || []).forEach((r: any) => {
        if (r.purchase_invoice_id && r.import_container_id && !piContainerMap.has(r.purchase_invoice_id)) {
          piContainerMap.set(r.purchase_invoice_id, {
            id: r.import_container_id,
            ref: containerRefById.get(r.import_container_id) || 'Existing Container',
          });
        }
      });

      const { data, error } = await supabase
        .from('purchase_invoices')
        .select(`
          id,
          invoice_number,
          invoice_date,
          supplier_id,
          currency,
          exchange_rate,
          subtotal,
          total_amount,
          status,
          purchase_type,
          purchase_orders(po_number),
          suppliers(company_name, country),
          purchase_invoice_items(id)
        `)
        .order('invoice_date', { ascending: false });

      if (error) throw error;

      // Filter only to PIs belonging to the SAPJ Import workflow:
      // Excludes cancelled invoices.
      // Must be an import PI: foreign currency (e.g. USD, EUR), explicit purchase_type === 'import',
      // overseas supplier, or linked to an import container.
      // Strictly excludes domestic/local purchase invoices (e.g. PT. Kairos Tritunggal, PT. Anugerah Mentari Distrindo)
      const importPIs = (data || []).filter((pi: any) => {
        if (pi.status === 'cancelled') return false;
        const isForeignCurrency = Boolean(pi.currency && pi.currency.toUpperCase() !== 'IDR');
        const isImportType = pi.purchase_type === 'import';
        const isOverseasSupplier = Boolean(
          pi.suppliers?.country && pi.suppliers.country.trim().toLowerCase() !== 'indonesia'
        );
        const isLinkedToContainer = piContainerMap.has(pi.id);
        return isForeignCurrency || isImportType || isOverseasSupplier || isLinkedToContainer;
      });

      const formatted: SelectablePI[] = importPIs.map((pi: any) => {
        const link = piContainerMap.get(pi.id);
        return {
          id: pi.id,
          invoice_number: pi.invoice_number,
          invoice_date: pi.invoice_date,
          supplier_id: pi.supplier_id,
          supplier_name: pi.suppliers?.company_name || 'Unknown Supplier',
          currency: pi.currency || 'USD',
          exchange_rate: Number(pi.exchange_rate) || 15000,
          subtotal: Number(pi.subtotal) || Number(pi.total_amount) || 0,
          total_amount: Number(pi.total_amount) || 0,
          po_number: pi.purchase_orders?.po_number,
          lines_count: Array.isArray(pi.purchase_invoice_items) ? pi.purchase_invoice_items.length : 0,
          linked_container_id: link ? link.id : null,
          linked_container_ref: link ? link.ref : null,
        };
      });

      setAvailablePIs(formatted);
    } catch (error: any) {
      console.error('Error fetching purchase invoices:', error.message);
    }
  };

  // When a user toggles / selects a PI in the multi-select
  const handleSelectPI = (piId: string) => {
    const targetPI = availablePIs.find(p => p.id === piId);
    if (!targetPI) return;

    if (selectedPiIds.includes(piId)) {
      // Deselect
      const updated = selectedPiIds.filter(id => id !== piId);
      setSelectedPiIds(updated);
      recalculateFromSelectedPIs(updated);
      return;
    }

    // Validate consistency with already selected PIs
    if (selectedPiIds.length > 0) {
      const firstSelected = availablePIs.find(p => p.id === selectedPiIds[0]);
      if (firstSelected) {
        if (firstSelected.supplier_id !== targetPI.supplier_id) {
          showToast({
            type: 'error',
            title: 'Supplier Mismatch',
            message: `Selected PI has supplier "${targetPI.supplier_name}", but this container is for "${firstSelected.supplier_name}". All PIs in a container must share the same supplier.`
          });
          return;
        }
        if (firstSelected.currency !== targetPI.currency) {
          showToast({
            type: 'error',
            title: 'Currency Mismatch',
            message: `Selected PI currency (${targetPI.currency}) does not match container currency (${firstSelected.currency}).`
          });
          return;
        }
      }
    }

    const updated = [...selectedPiIds, piId];
    setSelectedPiIds(updated);
    recalculateFromSelectedPIs(updated);
  };

  const handleRemovePI = (piId: string) => {
    const updated = selectedPiIds.filter(id => id !== piId);
    setSelectedPiIds(updated);
    recalculateFromSelectedPIs(updated);
  };

  const recalculateFromSelectedPIs = (piIds: string[]) => {
    if (piIds.length === 0) return;
    const selectedObjects = availablePIs.filter(p => piIds.includes(p.id));
    if (selectedObjects.length === 0) return;

    const first = selectedObjects[0];
    const totalGoodsSubtotal = selectedObjects.reduce((sum, p) => sum + (p.subtotal || 0), 0);

    setFormData(prev => ({
      ...prev,
      supplier_id: first.supplier_id,
      currency: first.currency,
      exchange_rate: first.exchange_rate || prev.exchange_rate,
      import_invoice_value: Math.round(totalGoodsSubtotal * 100) / 100,
    }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const operationalData = {
        container_ref: formData.container_ref,
        supplier_id: formData.supplier_id,
        import_date: formData.import_date,
        notes: formData.notes,
        purchase_invoice_ids: selectedPiIds,
        created_by: user?.id
      };
      const costingData = canViewCosting ? {
        import_invoice_value: formData.import_invoice_value,
        currency: formData.currency,
        exchange_rate: formData.exchange_rate,
        other_import_costs: formData.other_import_costs,
      } : editingContainer ? {} : { import_invoice_value: 0, currency: 'USD', exchange_rate: 15000, other_import_costs: 0 };
      const containerData = { ...operationalData, ...costingData };

      let containerId = editingContainer?.id;

      if (editingContainer) {
        const { error } = await supabase.from('import_containers').update(containerData).eq('id', editingContainer.id);
        if (error) throw error;
        showToast({ type: 'success', title: t('common.success'), message: t('success.updated') });
      } else {
        const { data: newContainer, error } = await supabase.from('import_containers').insert([containerData]).select().single();
        if (error) throw error;
        containerId = newContainer.id;
        showToast({ type: 'success', title: t('common.success'), message: t('success.created') });
      }

      // Sync links in purchase_invoice_receiving_allocations
      if (containerId) {
        const uniquePiIds = Array.from(new Set(selectedPiIds));
        if (uniquePiIds.length > 0) {
          await supabase
            .from('purchase_invoice_receiving_allocations')
            .update({ import_container_id: containerId })
            .in('purchase_invoice_id', uniquePiIds);
        }
        if (editingContainer) {
          const prevIds = (editingContainer.purchase_invoice_ids || []) as string[];
          const removedIds = prevIds.filter(id => !selectedPiIds.includes(id));
          if (removedIds.length > 0) {
            await supabase
              .from('purchase_invoice_receiving_allocations')
              .update({ import_container_id: null })
              .in('purchase_invoice_id', removedIds)
              .eq('import_container_id', containerId);
          }
        }
      }

      setShowModal(false);
      setEditingContainer(null);
      resetForm();
      await Promise.all([fetchContainers(), fetchAvailablePIs()]);
    } catch (error: any) {
      showToast({ type: 'error', title: t('common.error'), message: 'Failed to save container: ' + error.message });
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
      other_import_costs: 0,
      notes: ''
    });
    setSelectedPiIds([]);
    setPiSearchQuery('');
    setIsPiDropdownOpen(false);
    setLinkedExpenses([]);
    setLinkedPettyCash([]);
    setInclusionMap({});
  };

  const loadLinkedExpenses = async (containerId: string) => {
    try {
      const [{ data: expData, error: expError }, { data: pcData, error: pcError }] = await Promise.all([
        supabase.from('finance_expenses').select('id, expense_category, amount, expense_date, description, voucher_number, invoice_number, ppn_amount, pph_amount, stamp_duty_amount, bank_charges_amount, broker_items, include_in_landed_cost, pib_bm_amount, pib_ppn_amount, pib_pph_amount').eq('import_container_id', containerId).order('expense_date', { ascending: false }),
        supabase.from('petty_cash_transactions').select('id, transaction_number, transaction_type, amount, description, transaction_date, expense_category, include_in_landed_cost').eq('import_container_id', containerId).order('transaction_date', { ascending: false }),
      ]);
      if (expError) throw expError;
      if (pcError) throw pcError;

      const states = await getEffectiveExpensePostingStates((expData || []).map(e => e.id));
      const activeExpenses = (expData || [])
        .filter(e => isEffectiveExpensePosting(states.get(e.id)?.effective_posting_state))
        .filter(e => isImportExpenseCategory(e.expense_category));

      const filteredPettyCash = (pcData || [])
        .filter((pc: any) => !pc.expense_category || isImportExpenseCategory(pc.expense_category));

      setLinkedExpenses(activeExpenses);
      setLinkedPettyCash(filteredPettyCash as LinkedPettyCash[]);

      const map: Record<string, boolean> = {};
      for (const e of activeExpenses) map[e.id] = e.include_in_landed_cost === true;
      for (const pc of filteredPettyCash) map[pc.id] = pc.include_in_landed_cost === true;
      setInclusionMap(map);
    } catch {
      setLinkedExpenses([]);
      setLinkedPettyCash([]);
      setInclusionMap({});
    }
  };

  const handleToggleInclusion = async (itemId: string, source: SourceType, checked: boolean) => {
    const previousState = inclusionMap[itemId];
    setInclusionMap(prev => ({ ...prev, [itemId]: checked }));
    setSavingInclusion(true);
    try {
      const table = source === 'expense' ? 'finance_expenses' : 'petty_cash_transactions';
      const { error } = await supabase.from(table).update({ include_in_landed_cost: checked }).eq('id', itemId);
      if (error) throw error;
    } catch (error: any) {
      setInclusionMap(prev => ({ ...prev, [itemId]: previousState }));
      if (editingContainer) {
        await loadLinkedExpenses(editingContainer.id);
      }
      showToast({ type: 'error', title: t('common.error'), message: 'Failed to update: ' + error.message });
    } finally {
      setSavingInclusion(false);
    }
  };

  const handleSelectAll = async () => {
    const previousInclusionMap = { ...inclusionMap };
    const updates: Record<string, boolean> = {};
    for (const item of unifiedItems) {
      if (!item.isPIB && item.isCapitalizable) { updates[item.id] = true; }
    }
    setInclusionMap(prev => ({ ...prev, ...updates }));
    setSavingInclusion(true);
    try {
      for (const item of unifiedItems) {
        if (!item.isPIB && item.isCapitalizable) {
          const table = item.source === 'expense' ? 'finance_expenses' : 'petty_cash_transactions';
          const { error } = await supabase.from(table).update({ include_in_landed_cost: true }).eq('id', item.id);
          if (error) throw error;
        }
      }
    } catch (error: any) {
      setInclusionMap(previousInclusionMap);
      if (editingContainer) {
        await loadLinkedExpenses(editingContainer.id);
      }
      showToast({ type: 'error', title: t('common.error'), message: 'Failed to select all: ' + (error?.message || 'Database update failed') });
    } finally {
      setSavingInclusion(false);
    }
  };

  const handleClearAll = async () => {
    const previousInclusionMap = { ...inclusionMap };
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
          const { error } = await supabase.from(table).update({ include_in_landed_cost: false }).eq('id', item.id);
          if (error) throw error;
        }
      }
    } catch (error: any) {
      setInclusionMap(previousInclusionMap);
      if (editingContainer) {
        await loadLinkedExpenses(editingContainer.id);
      }
      showToast({ type: 'error', title: t('common.error'), message: 'Failed to clear all: ' + (error?.message || 'Database update failed') });
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
    await fetchAvailablePIs();

    // Fetch linked PIs from receiving allocations or container array
    const { data: allocPIs } = await supabase
      .from('purchase_invoice_receiving_allocations')
      .select('purchase_invoice_id')
      .eq('import_container_id', container.id);

    const directPiIds = (container.purchase_invoice_ids || []) as string[];
    const allocPiIds = (allocPIs || []).map((a: any) => a.purchase_invoice_id).filter(Boolean);
    const combinedPiIds = Array.from(new Set([...directPiIds, ...allocPiIds]));
    setSelectedPiIds(combinedPiIds);

    setFormData({
      container_ref: container.container_ref,
      supplier_id: container.supplier_id,
      import_date: container.import_date,
      import_invoice_value: container.import_invoice_value || 0,
      currency: container.currency || 'USD',
      exchange_rate: container.exchange_rate || 15000,
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
        <Icon className="w-3 h-3" />{config.label}
      </span>
    );
  };

  const formatCurrency = (amount: number, currency: string = 'IDR') => {
    if (currency === 'USD') return `$ ${amount?.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    return `Rp ${amount?.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };

  const unifiedItems: UnifiedLinkedItem[] = [
    ...linkedExpenses.filter(e => e.expense_category !== 'pib_import').map(e => ({
      id: e.id,
      source: 'expense' as SourceType,
      referenceNumber: e.voucher_number || e.invoice_number || 'EXP',
      category: e.expense_category,
      amount: calculateExpenseLandedCostAmount(e).amount,
      date: e.expense_date,
      description: e.description || '',
      include_in_landed_cost: inclusionMap[e.id] ?? false,
      isCapitalizable: isCapitalizableLandedCostCategory(e.expense_category),
      isPIB: false,
      rawExpense: e,
    })),
    ...linkedPettyCash.map(pc => ({
      id: pc.id,
      source: 'petty_cash' as SourceType,
      referenceNumber: pc.transaction_number || 'PC',
      category: pc.expense_category || pc.transaction_type,
      amount: Number(pc.amount || 0),
      date: pc.transaction_date,
      description: pc.description || '',
      include_in_landed_cost: inclusionMap[pc.id] ?? false,
      isCapitalizable: isCapitalizableLandedCostCategory(pc.expense_category || pc.transaction_type),
      isPIB: false,
    }))
  ];

  const pibExpenses = linkedExpenses.filter(e => e.expense_category === 'pib_import');

  const landedCostBreakdown = useMemo(() => {
    return calculateContainerLandedCostPool({
      linkedExpenses,
      linkedPettyCash,
      inclusionMap,
      otherImportCosts: formData.other_import_costs || 0,
    });
  }, [linkedExpenses, linkedPettyCash, inclusionMap, formData.other_import_costs]);

  const hasLinkedItems = unifiedItems.length > 0;

  // Filter eligible PIs based on current modal mode:
  // - If creating a new container (editingContainer is null): only PIs NOT linked to any container are offered.
  // - If editing a container: PIs linked to THIS container + unlinked PIs are offered; PIs linked to OTHER containers are excluded.
  const eligiblePIs = availablePIs.filter(pi => {
    if (pi.linked_container_id) {
      if (!editingContainer || pi.linked_container_id !== editingContainer.id) {
        return false;
      }
    }
    return true;
  });

  const filteredPIs = eligiblePIs.filter(pi => {
    if (!piSearchQuery.trim()) return true;
    const q = piSearchQuery.toLowerCase();
    return (
      pi.invoice_number.toLowerCase().includes(q) ||
      pi.supplier_name.toLowerCase().includes(q) ||
      (pi.po_number && pi.po_number.toLowerCase().includes(q))
    );
  });

  const selectedPiObjects = availablePIs.filter(pi => selectedPiIds.includes(pi.id));

  return (
    <Layout>
      <div className="space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">{t('importContainers.title')}</h1>
            <p className="text-sm text-gray-600 mt-1">{t('importContainers.subtitle')}</p>
          </div>
          <button
            onClick={() => {
              setEditingContainer(null);
              resetForm();
              fetchAvailablePIs();
              setShowModal(true);
            }}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm self-start sm:self-auto shadow-sm"
          >
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
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Linked PIs</th>
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
                {loading ? (
                  <tr><td colSpan={canViewCosting ? 8 : 6} className="px-4 py-8 text-center text-gray-500">{t('common.loading')}</td></tr>
                ) : containers.length === 0 ? (
                  <tr><td colSpan={canViewCosting ? 8 : 6} className="px-4 py-8 text-center text-gray-500">{t('importContainers.noContainers')}</td></tr>
                ) : containers.map((container) => (
                  <tr key={container.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 whitespace-nowrap text-sm font-medium text-gray-900">{container.container_ref}</td>
                    <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-900">{container.suppliers?.company_name}</td>
                    <td className="px-4 py-3 whitespace-nowrap text-xs text-gray-600">
                      {container.purchase_invoice_ids && container.purchase_invoice_ids.length > 0 ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-blue-50 text-blue-700 font-medium">
                          <FileText className="w-3 h-3" /> {container.purchase_invoice_ids.length} PI(s)
                        </span>
                      ) : (
                        <span className="text-gray-400">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-900 hidden sm:table-cell">{formatDate(container.import_date)}</td>
                    {canViewCosting && (<>
                      <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-900 text-right hidden md:table-cell">{formatCurrency(container.import_invoice_value, container.currency)}</td>
                      <td className="px-4 py-3 whitespace-nowrap text-right">
                        <div className="text-sm text-gray-900 font-semibold">{formatCurrency(container.canonical_landed_cost_pool || 0, 'IDR')}</div>
                        <div className="text-xs text-gray-500">Canonical dynamic pool</div>
                      </td>
                    </>)}
                    <td className="px-4 py-3 whitespace-nowrap text-center">{getStatusBadge(container.status)}</td>
                    <td className="px-4 py-3 whitespace-nowrap text-center">
                      <div className="flex items-center justify-center gap-2">
                        <button onClick={() => handleEdit(container)} className="text-blue-600 hover:text-blue-800" title={t('common.edit')}>
                          <Edit className="w-4 h-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* MODAL */}
        {showModal && (
          <Modal
            isOpen={showModal}
            onClose={() => { setShowModal(false); setEditingContainer(null); resetForm(); }}
            title={editingContainer ? t('importContainers.editContainer') : t('importContainers.addContainer')}
            maxWidth="max-w-4xl"
            footer={
              <div className="flex items-center justify-end gap-3 w-full">
                <button
                  type="button"
                  onClick={() => { setShowModal(false); setEditingContainer(null); resetForm(); }}
                  className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-100 text-sm font-medium text-gray-700 transition"
                >
                  {t('common.cancel')}
                </button>
                <button
                  type="submit"
                  form="import-container-form"
                  className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-medium shadow-2xs transition"
                >
                  {editingContainer ? t('common.update') : t('common.create')}
                </button>
              </div>
            }
          >
            <form id="import-container-form" onSubmit={handleSubmit} className="space-y-4 pt-1">
              {/* COMPACT SEARCHABLE MULTI-PI SELECTOR DROPDOWN */}
              <div className="space-y-1 relative" ref={piDropdownRef}>
                <label className="block text-xs font-semibold text-gray-700 uppercase tracking-wider">
                  Link Purchase Invoices (PIs)
                </label>

                {/* Single-line compact dropdown trigger */}
                <button
                  type="button"
                  onClick={() => setIsPiDropdownOpen(prev => !prev)}
                  className="w-full flex items-center justify-between px-3 py-2 bg-white border border-gray-300 rounded-lg text-xs hover:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-500 transition shadow-2xs"
                >
                  <div className="flex items-center gap-2 truncate">
                    <FileText className="w-3.5 h-3.5 text-blue-600 shrink-0" />
                    <span className="text-gray-700 truncate font-normal">
                      {selectedPiIds.length === 0
                        ? 'Select Purchase Invoices (PIs)...'
                        : `${selectedPiIds.length} PI${selectedPiIds.length > 1 ? 's' : ''} selected`}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 text-gray-500 shrink-0 ml-2">
                    {selectedPiIds.length > 0 && (
                      <span className="text-[11px] font-semibold px-2 py-0.5 rounded bg-blue-100 text-blue-800">
                        {selectedPiIds.length} selected
                      </span>
                    )}
                    <ChevronDown className={`w-4 h-4 text-gray-500 transition-transform duration-200 ${isPiDropdownOpen ? 'rotate-180' : ''}`} />
                  </div>
                </button>

                {/* Floating Multi-Select Dropdown Panel */}
                {isPiDropdownOpen && (
                  <div className="absolute z-50 left-0 right-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-xl overflow-hidden divide-y divide-gray-100">
                    {/* Search box inside dropdown */}
                    <div className="p-2.5 bg-gray-50 border-b border-gray-200 relative">
                      <Search className="w-3.5 h-3.5 text-gray-400 absolute left-5 top-4.5" />
                      <input
                        type="text"
                        placeholder="Search PI #, Supplier, or PO #..."
                        value={piSearchQuery}
                        onChange={(e) => setPiSearchQuery(e.target.value)}
                        onClick={(e) => e.stopPropagation()}
                        className="w-full pl-8 pr-3 py-1.5 bg-white border border-gray-300 rounded text-xs focus:ring-1 focus:ring-blue-500 outline-none"
                        autoFocus
                      />
                    </div>

                    {/* Scrollable Checkbox List of Available Import PIs */}
                    <div className="max-h-56 overflow-y-auto divide-y divide-gray-50">
                      {filteredPIs.length === 0 ? (
                        <div className="p-4 text-xs text-gray-500 text-center">No matching import purchase invoices found.</div>
                      ) : (
                        filteredPIs.map(pi => {
                          const isSelected = selectedPiIds.includes(pi.id);
                          return (
                            <div
                              key={pi.id}
                              onClick={() => handleSelectPI(pi.id)}
                              className={`p-2.5 flex items-center justify-between text-xs cursor-pointer transition ${
                                isSelected ? 'bg-blue-50 font-medium' : 'hover:bg-gray-50'
                              }`}
                            >
                              <div className="flex items-center gap-2.5 min-w-0 pr-2">
                                <input
                                  type="checkbox"
                                  checked={isSelected}
                                  onChange={() => {}}
                                  className="rounded border-gray-300 text-blue-600 pointer-events-none shrink-0"
                                />
                                <div className="truncate">
                                  <span className="font-semibold text-gray-900">{pi.invoice_number}</span>
                                  <span className="text-gray-500 ml-1.5 truncate">— {pi.supplier_name}</span>
                                  {pi.po_number && <span className="text-blue-600 ml-1.5 font-mono text-[10px]">PO: {pi.po_number}</span>}
                                </div>
                              </div>
                              <div className="text-right shrink-0">
                                <span className="font-semibold text-gray-800">
                                  {formatCurrency(pi.subtotal, pi.currency)}
                                </span>
                                <span className="text-gray-400 ml-1.5 text-[10px]">({formatDate(pi.invoice_date)})</span>
                              </div>
                            </div>
                          );
                        })
                      )}
                    </div>

                    {/* Footer summary & close button */}
                    <div className="p-2 bg-gray-50 flex items-center justify-between text-xs text-gray-500">
                      <span>{selectedPiIds.length} PI(s) selected</span>
                      <button
                        type="button"
                        onClick={() => setIsPiDropdownOpen(false)}
                        className="text-blue-600 hover:text-blue-800 font-semibold px-2 py-0.5 rounded hover:bg-blue-100 transition"
                      >
                        Done
                      </button>
                    </div>
                  </div>
                )}

                {/* Selected PI Badges under dropdown trigger */}
                {selectedPiObjects.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    {selectedPiObjects.map(pi => (
                      <span
                        key={pi.id}
                        className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-blue-50 text-blue-800 text-xs font-medium border border-blue-200"
                      >
                        <FileText className="w-3 h-3 text-blue-600 shrink-0" />
                        <span className="font-semibold">{pi.invoice_number}</span>
                        <span className="text-blue-600 font-mono">({formatCurrency(pi.subtotal, pi.currency)})</span>
                        <button
                          type="button"
                          onClick={() => handleRemovePI(pi.id)}
                          className="text-blue-400 hover:text-blue-700 ml-0.5 rounded hover:bg-blue-100 p-0.5 transition"
                          title="Remove PI"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
              </div>

              <SapRow>
                <FloatingField label={t('importContainers.containerRef')} filled={!!formData.container_ref} required span={6}>
                  <input
                    name="container_ref"
                    aria-label="Container Ref"
                    type="text"
                    value={formData.container_ref}
                    onChange={(e) => setFormData({ ...formData, container_ref: e.target.value })}
                    className={FLOAT_INPUT}
                    required
                  />
                </FloatingField>
                <FloatingField label={t('common.supplier')} filled={!!formData.supplier_id} required span={6}>
                  <SearchableSelect
                    value={formData.supplier_id}
                    onChange={(val) => setFormData({ ...formData, supplier_id: val })}
                    options={suppliers.map(s => ({ value: s.id, label: s.company_name }))}
                    placeholder={t('finance.selectSupplier')}
                  />
                </FloatingField>
              </SapRow>

              <SapRow>
                <FloatingField label={t('importContainers.importDate')} filled={!!formData.import_date} required span={canViewCosting ? 4 : 12}>
                  <input
                    name="import_date"
                    aria-label="Import Date"
                    type="date"
                    value={formData.import_date}
                    onChange={(e) => setFormData({ ...formData, import_date: e.target.value })}
                    className={FLOAT_INPUT}
                    required
                  />
                </FloatingField>
                {canViewCosting && (<>
                  <FloatingField label={t('salesOrders.currency')} filled={!!formData.currency} span={4}>
                    <select
                      name="currency"
                      aria-label="Currency"
                      value={formData.currency}
                      onChange={(e) => setFormData({ ...formData, currency: e.target.value })}
                      className={FLOAT_INPUT}
                    >
                      <option>USD</option>
                      <option>IDR</option>
                      <option>CNY</option>
                      <option>INR</option>
                    </select>
                  </FloatingField>
                  <FloatingField label={`Exchange Rate (IDR per ${formData.currency})`} filled={!!formData.exchange_rate} span={4}>
                    <input
                      name="exchange_rate"
                      aria-label="Exchange Rate"
                      type="number"
                      step="0.01"
                      value={formData.exchange_rate}
                      onChange={(e) => setFormData({ ...formData, exchange_rate: parseFloat(e.target.value) || 0 })}
                      className={FLOAT_INPUT}
                    />
                  </FloatingField>
                </>)}
              </SapRow>

              {canViewCosting && (
                <SapRow>
                  <FloatingField
                    label={`${t('importContainers.invoiceValue')} (Goods Subtotal)`}
                    filled={!!formData.import_invoice_value}
                    required
                    span={12}
                    hint={selectedPiIds.length > 0 ? `Auto-derived goods subtotal from ${selectedPiIds.length} linked PI(s).` : undefined}
                  >
                    <MoneyInput
                      value={formData.import_invoice_value}
                      onChange={(amount) => setFormData({ ...formData, import_invoice_value: amount })}
                      className={FLOAT_INPUT}
                      required
                    />
                  </FloatingField>
                </SapRow>
              )}

              {/* Linked Expenses + Petty Cash */}
              {canViewCosting && editingContainer && hasLinkedItems && (
                <div className="bg-green-50/70 border border-green-200 rounded-xl p-3 sm:p-4 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <h3 className="text-xs font-bold text-green-950 uppercase tracking-wider">
                        Linked Costs ({unifiedItems.length} items)
                      </h3>
                      <p className="text-[11px] text-green-800 font-normal">
                        Select capitalizable shipping and handling costs to include in container landed cost.
                      </p>
                    </div>
                    {unifiedItems.length > 0 && (
                      <div className="flex gap-2 shrink-0">
                        <button
                          type="button"
                          onClick={handleSelectAll}
                          disabled={savingInclusion}
                          className="text-xs px-2.5 py-1 bg-green-700 text-white font-medium rounded-md hover:bg-green-800 transition disabled:opacity-50"
                        >
                          Select All
                        </button>
                        <button
                          type="button"
                          onClick={handleClearAll}
                          disabled={savingInclusion}
                          className="text-xs px-2.5 py-1 bg-white border border-gray-300 text-gray-700 font-medium rounded-md hover:bg-gray-50 transition disabled:opacity-50"
                        >
                          Clear All
                        </button>
                      </div>
                    )}
                  </div>

                  <div className="space-y-1.5 max-h-72 sm:max-h-80 overflow-y-auto pr-0.5">
                    {unifiedItems.map((item) => {
                      const isExpanded = expandedDescIds.has(item.id);
                      const hasLongDesc = (item.description || '').length > 35;
                      const isChecked = item.include_in_landed_cost && item.isCapitalizable;

                      return (
                        <div
                          key={item.id}
                          className={`p-2.5 rounded-lg border transition ${
                            isChecked
                              ? 'bg-white border-green-300 shadow-2xs'
                              : !item.isCapitalizable
                              ? 'bg-purple-50/40 border-purple-200'
                              : 'bg-white/80 border-gray-200 opacity-80'
                          }`}
                        >
                          <div className="flex items-start sm:items-center gap-2.5 text-xs">
                            <input
                              name="include_in_landed_cost"
                              aria-label="Include In Landed Cost"
                              type="checkbox"
                              checked={isChecked}
                              onChange={(e) => handleToggleInclusion(item.id, item.source, e.target.checked)}
                              disabled={savingInclusion || !item.isCapitalizable}
                              title={
                                !item.isCapitalizable
                                  ? 'Regulatory operational fee (Account 5410) — excluded from inventory landed cost'
                                  : undefined
                              }
                              className="w-4 h-4 mt-0.5 sm:mt-0 rounded border-gray-300 text-blue-600 focus:ring-1 focus:ring-blue-500 cursor-pointer shrink-0 disabled:cursor-not-allowed disabled:opacity-40"
                            />

                            <div className="flex items-center gap-1.5 shrink-0 flex-wrap">
                              <span
                                className={`px-1.5 py-0.5 rounded text-[10px] font-semibold tracking-wide ${
                                  item.source === 'expense' ? 'bg-blue-100 text-blue-700' : 'bg-orange-100 text-orange-700'
                                }`}
                              >
                                {item.source === 'expense' ? 'Expense' : 'Petty Cash'}
                              </span>
                              <span className="font-mono text-[11px] font-medium bg-gray-100 text-gray-700 px-1.5 py-0.5 rounded border border-gray-200">
                                {item.referenceNumber}
                              </span>
                              <span className="font-semibold text-gray-800">
                                {getCategoryLabel(item.category)}
                              </span>
                              {!item.isCapitalizable && (
                                <span
                                  className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-purple-100 text-purple-800 border border-purple-200"
                                  title="Operational regulatory fee posted to P&L 5410. Excluded from inventory landed-cost capitalization to prevent duplicate COGS 5100 expense recognition."
                                >
                                  Operational (P&L 5410 Excluded)
                                </span>
                              )}
                            </div>

                            <div className="flex-1 min-w-0 px-2 text-gray-600">
                              <div
                                className={`text-xs ${isExpanded ? 'whitespace-normal' : 'truncate'}`}
                                title={item.description}
                              >
                                <span>{item.description || '—'}</span>
                                {hasLongDesc && (
                                  <button
                                    type="button"
                                    onClick={() => toggleDescExpand(item.id)}
                                    className="ml-1 text-[10px] text-blue-600 hover:underline font-semibold"
                                  >
                                    {isExpanded ? 'show less' : '...more'}
                                  </button>
                                )}
                              </div>
                            </div>

                            <div className="text-right shrink-0 pl-2">
                              <div
                                className={`font-bold tabular-nums text-xs ${
                                  isChecked
                                    ? 'text-green-800'
                                    : !item.isCapitalizable
                                    ? 'text-purple-700'
                                    : 'text-gray-400'
                                }`}
                              >
                                {formatCurrency(item.amount, 'IDR')}
                              </div>
                              {item.date && (
                                <div className="text-[10px] text-gray-400 tabular-nums">
                                  {formatDate(item.date)}
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  <div className="mt-3 pt-3 border-t border-green-200 space-y-1.5 text-xs">
                    <div className="flex justify-between items-center">
                      <span className="font-semibold text-green-950">Selected Capitalizable Linked Costs:</span>
                      <span className="font-bold text-green-900 tabular-nums">
                        {formatCurrency(landedCostBreakdown.selectedLandedLinkedTotal, 'IDR')}
                      </span>
                    </div>
                    {landedCostBreakdown.excludedOperationalExpensesTotal > 0 && (
                      <div className="flex justify-between items-center text-purple-900 bg-purple-50/70 border border-purple-200 px-2.5 py-1 rounded-md">
                        <span className="font-medium flex items-center gap-1">
                          Operational Linked Costs (P&L 5410 Excluded):
                        </span>
                        <span className="font-bold tabular-nums">
                          {formatCurrency(landedCostBreakdown.excludedOperationalExpensesTotal, 'IDR')}
                        </span>
                      </div>
                    )}
                    <div className="flex justify-between items-center">
                      <span className="font-semibold text-green-950">Import Duty (Bea Masuk):</span>
                      <span className="font-bold text-green-900 tabular-nums">
                        {formatCurrency(landedCostBreakdown.pibDutyTotal, 'IDR')}
                      </span>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="font-semibold text-green-950">Other Import Costs:</span>
                      <span className="font-bold text-green-900 tabular-nums">
                        {formatCurrency(landedCostBreakdown.otherImportCosts, 'IDR')}
                      </span>
                    </div>
                    <div className="flex justify-between items-center pt-2 border-t border-green-300">
                      <span className="font-extrabold text-green-950 text-sm">Container Landed-Cost Pool:</span>
                      <span className="text-base font-black text-green-950 tabular-nums">
                        {formatCurrency(landedCostBreakdown.containerLandedCostPool, 'IDR')}
                      </span>
                    </div>
                  </div>
                </div>
              )}

              {/* PIB Breakdown */}
              {canViewCosting && editingContainer && pibExpenses.length > 0 && (landedCostBreakdown.pibPaymentTotal > 0) && (
                <div className="bg-amber-50/80 border border-amber-200 rounded-xl p-3 sm:p-4">
                  <div className="flex items-start gap-2.5">
                    <AlertCircle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                    <div className="flex-1 min-w-0">
                      <h3 className="text-xs font-bold text-amber-950 uppercase tracking-wider mb-2">
                        PIB / Customs Breakdown
                      </h3>
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                        <div className="bg-white/80 p-2 rounded-lg border border-amber-200">
                          <div className="text-amber-800 font-medium text-[11px]">Import Duty (BM)</div>
                          <div className="font-bold text-amber-950 text-sm tabular-nums mt-0.5">
                            {formatCurrency(landedCostBreakdown.pibDutyTotal)}
                          </div>
                          <div className="text-[10px] text-green-700 font-medium mt-0.5">Capitalized to Inventory</div>
                        </div>
                        <div className="bg-white/80 p-2 rounded-lg border border-amber-200">
                          <div className="text-gray-600 font-medium text-[11px]">Import PPN</div>
                          <div className="font-bold text-gray-700 text-sm tabular-nums mt-0.5">
                            {formatCurrency(landedCostBreakdown.pibPpnTotal)}
                          </div>
                          <div className="text-[10px] text-gray-500 mt-0.5">Input VAT 1150 (Excluded)</div>
                        </div>
                        <div className="bg-white/80 p-2 rounded-lg border border-amber-200">
                          <div className="text-gray-600 font-medium text-[11px]">Import PPh22</div>
                          <div className="font-bold text-gray-700 text-sm tabular-nums mt-0.5">
                            {formatCurrency(landedCostBreakdown.pibPphTotal)}
                          </div>
                          <div className="text-[10px] text-gray-500 mt-0.5">Prepaid Tax 1155 (Excluded)</div>
                        </div>
                        <div className="bg-white/80 p-2 rounded-lg border border-amber-200">
                          <div className="text-amber-900 font-medium text-[11px]">PIB Total Payment</div>
                          <div className="font-bold text-amber-950 text-sm tabular-nums mt-0.5">
                            {formatCurrency(landedCostBreakdown.pibPaymentTotal)}
                          </div>
                          <div className="text-[10px] text-gray-500 mt-0.5">Customs billing total</div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Other Import Costs */}
              {canViewCosting && (
                <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
                  <SapRow>
                    <FloatingField
                      label="Other Import Costs"
                      filled={!!formData.other_import_costs}
                      span={12}
                      hint="Miscellaneous costs not covered by linked expenses. Does not create a finance expense or journal."
                    >
                      <MoneyInput
                        value={formData.other_import_costs}
                        onChange={(amount) => setFormData({ ...formData, other_import_costs: amount })}
                        className={FLOAT_INPUT}
                      />
                    </FloatingField>
                  </SapRow>
                </div>
              )}

              <SapRow>
                <FloatingField label={t('common.notes')} filled={!!formData.notes} span={12} textarea>
                  <textarea
                    name="notes"
                    aria-label="Notes"
                    value={formData.notes}
                    onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                    rows={2}
                    className={FLOAT_TEXTAREA}
                  />
                </FloatingField>
              </SapRow>
            </form>
          </Modal>
        )}
      </div>
    </Layout>
  );
}
