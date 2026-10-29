import { useEffect, useState } from 'react';
import { Layout } from '../components/Layout';
import { DataTable } from '../components/DataTable';
import { Modal } from '../components/Modal';
import { SearchableSelect } from '../components/SearchableSelect';
import { CreditNoteView } from '../components/CreditNoteView';
import { useLanguage } from '../contexts/LanguageContext';
import { useAuth } from '../contexts/AuthContext';
import { supabase } from '../lib/supabase';
import { Plus, Eye, Trash2, AlertCircle, CheckCircle, XCircle, RotateCcw, Filter, Pencil } from 'lucide-react';
import { showToast } from '../components/ToastNotification';
import { showConfirm } from '../components/ConfirmDialog';
import { formatDate } from '../utils/dateFormat';
import { MoneyInput } from '../components/MoneyInput';
import { FloatingField, FLOAT_INPUT, FLOAT_TEXTAREA } from '../components/finance/FloatingField';
import { SapRow } from '../components/finance/SapLayout';
import { useSupabaseRealtimeChannel } from '../hooks/useSupabaseRealtimeChannel';
import { useErpSyncListener, emitErpSync } from '../utils/erpSyncBus';

function normalizeNestedRelation<T>(value: T | T[] | null | undefined): T | null {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

interface CreditNote {
  id: string;
  credit_note_number: string;
  credit_note_date: string;
  customer_id: string;
  original_invoice_id?: string;
  original_invoice_number?: string;
  sales_invoices?: {
    invoice_number: string;
  } | null;
  reason: string;
  notes?: string;
  currency: string;
  subtotal: number;
  tax_amount: number;
  total_amount: number;
  status?: string;
  credit_note_type?: 'physical_return' | 'commercial_credit' | null;
  approved_by?: string;
  material_return_id?: string;
  material_returns?: {
    id: string;
    return_number: string;
    return_date: string;
    status: string;
    restocked: boolean;
  } | null;
  customers?: {
    company_name: string;
    address: string;
    city: string;
    phone: string;
    npwp: string;
    pharmacy_license: string;
  } | null;
}

interface CreditNoteItem {
  id?: string;
  product_id: string;
  batch_id: string;
  quantity: number;
  unit_price: number;
  products?: {
    product_name: string;
    product_code: string;
  };
  batches?: {
    batch_number: string;
    current_stock?: number;
    product_sources?: {
      supplier_name: string | null;
      grade: string | null;
    } | null;
  } | null;
}

interface Customer {
  id: string;
  company_name: string;
}

interface Product {
  id: string;
  product_name: string;
  product_code: string;
}

interface Batch {
  id: string;
  batch_number: string;
  product_id: string;
  current_stock: number;
  product_sources?: {
    supplier_name: string | null;
    grade: string | null;
  } | null;
}

interface SalesInvoice {
  id: string;
  invoice_number: string;
  invoice_date: string;
  total_amount: number;
}

export function CreditNotes() {
  const { t } = useLanguage();
  const { user, profile } = useAuth();
  const [creditNotes, setCreditNotes] = useState<CreditNote[]>([]);
  const [loading, setLoading] = useState(true);
  const [queryError, setQueryError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [viewModalOpen, setViewModalOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [selectedCreditNote, setSelectedCreditNote] = useState<CreditNote | null>(null);
  const [selectedCreditNoteItems, setSelectedCreditNoteItems] = useState<any[]>([]);
  const [editingCreditNoteId, setEditingCreditNoteId] = useState<string | null>(null);

  // Realtime updates for credit notes and material returns
  useSupabaseRealtimeChannel({
    channelName: 'credit_notes_realtime_changes',
    table: 'credit_notes',
    onEvent: () => {
      loadCreditNotes();
    },
  });
  useSupabaseRealtimeChannel({
    channelName: 'credit_notes_material_returns_changes',
    table: 'material_returns',
    onEvent: () => {
      loadApprovedReturns();
    },
  });

  // Filtering: defaults to showing all records; date filter filters by commercial credit_note_date
  const [statusFilter, setStatusFilter] = useState<'all' | 'pending_approval' | 'approved' | 'rejected'>('all');
  const [dateFilter, setDateFilter] = useState({
    startDate: '',
    endDate: '',
  });

  const [customers, setCustomers] = useState<Customer[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [invoices, setInvoices] = useState<SalesInvoice[]>([]);
  const [approvedReturns, setApprovedReturns] = useState<any[]>([]);

  const [formData, setFormData] = useState({
    credit_note_number: '',
    credit_note_date: new Date().toISOString().split('T')[0],
    customer_id: '',
    original_invoice_id: '',
    original_invoice_number: '',
    reason: '',
    notes: '',
    currency: 'IDR',
    material_return_id: '',
    credit_note_type: 'physical_return' as 'physical_return' | 'commercial_credit' | '',
  });

  const [items, setItems] = useState<Omit<CreditNoteItem, 'id'>[]>([
    {
      product_id: '',
      batch_id: '',
      quantity: 0,
      unit_price: 0,
    },
  ]);

  useEffect(() => {
    loadData();
  }, []);

  useErpSyncListener(
    ['credit_notes', 'sales_invoices', 'material_returns', 'inventory'],
    () => {
      loadData();
    }
  );

  const loadData = async () => {
    setLoading(true);
    await loadCreditNotes();
    await loadCustomers();
    await loadProducts();
    await loadApprovedReturns();
    setLoading(false);
  };

  const generateNextCreditNoteNumber = async (): Promise<string> => {
    try {
      // 1. Attempt RPC first if available/permitted
      const { data: rpcNum, error: rpcErr } = await supabase.rpc('generate_credit_note_number');
      if (!rpcErr && rpcNum && typeof rpcNum === 'string') {
        return rpcNum;
      }
    } catch {
      // Fall through to query-based generation
    }

    try {
      // 2. Query-based generation matching SAPJ ERP convention: CN-YY-XXXX
      const { data: yearCode } = await supabase.rpc('get_current_financial_year');
      const year = yearCode || new Date().getFullYear().toString().slice(-2);
      const prefix = `CN-${year}`;

      const { data: existingNotes } = await supabase
        .from('credit_notes')
        .select('credit_note_number')
        .like('credit_note_number', `${prefix}-%`);

      let nextSeq = 1;
      if (existingNotes && existingNotes.length > 0) {
        const seqs = existingNotes
          .map(n => {
            const match = n.credit_note_number?.match(/-(\d+)$/);
            return match ? parseInt(match[1], 10) : 0;
          })
          .filter(n => !isNaN(n));
        if (seqs.length > 0) {
          nextSeq = Math.max(...seqs) + 1;
        }
      }
      return `${prefix}-${String(nextSeq).padStart(4, '0')}`;
    } catch (err) {
      console.error('Error generating credit note number:', err);
      const fallbackYear = new Date().getFullYear().toString().slice(-2);
      return `CN-${fallbackYear}-0001`;
    }
  };

  const loadCreditNotes = async () => {
    try {
      setQueryError(null);
      // Explicit foreign-key disambiguation for material_returns to avoid PGRST201 Multiple Choices error
      // Also joins sales_invoices to display canonical invoice number even if original_invoice_number was unset
      const { data, error } = await supabase
        .from('credit_notes')
        .select(`
          *,
          customers(company_name, address, city, phone, npwp, pharmacy_license),
          material_returns:material_return_id(id, return_number, return_date, status, restocked),
          sales_invoices:original_invoice_id(invoice_number)
        `)
        .order('created_at', { ascending: false });

      if (error) throw error;
      const normalizedData = (data || []).map((cn: any) => ({
        ...cn,
        customers: normalizeNestedRelation(cn.customers),
        material_returns: normalizeNestedRelation(cn.material_returns),
        sales_invoices: normalizeNestedRelation(cn.sales_invoices),
      }));
      setCreditNotes(normalizedData);
    } catch (error: any) {
      console.error('Error loading credit notes:', error);
      const errorMsg = error?.message || 'Failed to load credit notes from server';
      setQueryError(errorMsg);
      showToast({ type: 'error', title: 'Error Loading Credit Notes', message: errorMsg });
    }
  };

  const loadApprovedReturns = async () => {
    try {
      const { data, error } = await supabase
        .from('material_returns')
        .select(`
          id,
          return_number,
          return_date,
          customer_id,
          original_invoice_id,
          financial_impact,
          return_reason,
          status,
          restocked,
          customers(company_name),
          sales_invoices(invoice_number)
        `)
        .eq('status', 'approved')
        .is('credit_note_id', null)
        .order('return_date', { ascending: false });

      if (error) throw error;
      setApprovedReturns(data || []);
    } catch (error) {
      console.error('Error loading approved returns:', error);
    }
  };

  const loadCustomers = async () => {
    try {
      const { data, error } = await supabase
        .from('customers')
        .select('id, company_name')
        .eq('is_active', true)
        .order('company_name');

      if (error) throw error;
      setCustomers(data || []);
    } catch (error) {
      console.error('Error loading customers:', error);
    }
  };

  const loadProducts = async () => {
    try {
      const { data, error } = await supabase
        .from('products')
        .select('id, product_name, product_code')
        .eq('is_active', true)
        .order('product_name');

      if (error) throw error;
      setProducts(data || []);
    } catch (error) {
      console.error('Error loading products:', error);
    }
  };

  const loadBatchesForProduct = async (productId: string) => {
    try {
      const { data, error } = await supabase
        .from('batches')
        .select(`
          id,
          batch_number,
          product_id,
          current_stock,
          product_sources!batches_make_id_fkey(supplier_name, grade)
        `)
        .eq('product_id', productId)
        .eq('is_active', true)
        .order('batch_number');

      if (error) throw error;
      setBatches((data || []).map(batch => ({
        ...batch,
        product_sources: normalizeNestedRelation(batch.product_sources),
      })));
    } catch (error) {
      console.error('Error loading batches:', error);
    }
  };

  const handleViewCreditNote = async (creditNote: CreditNote) => {
    setSelectedCreditNote(creditNote);
    try {
      const { data, error } = await supabase
        .from('credit_note_items')
        .select(`
          *,
          products(product_name, product_code),
          batches(
            batch_number,
            product_sources!batches_make_id_fkey(supplier_name, grade)
          )
        `)
        .eq('credit_note_id', creditNote.id);

      if (error) throw error;
      setSelectedCreditNoteItems(data || []);
      setViewModalOpen(true);
    } catch (error) {
      console.error('Error loading credit note items:', error);
    }
  };

  const loadInvoicesForCustomer = async (customerId: string) => {
    try {
      const { data, error } = await supabase
        .from('sales_invoices')
        .select('id, invoice_number, invoice_date, total_amount, notes')
        .eq('customer_id', customerId)
        .order('invoice_date', { ascending: false });

      if (error) throw error;
      const activeInvoices = (data || []).filter(
        (inv: any) => !inv.notes?.includes('[CANCELLED') && !inv.notes?.toLowerCase().startsWith('cancelled')
      );
      setInvoices(activeInvoices);
    } catch (error) {
      console.error('Error loading invoices:', error);
    }
  };

  const handleCustomerChange = (customerId: string) => {
    setFormData({ ...formData, customer_id: customerId, original_invoice_id: '', original_invoice_number: '' });
    if (customerId) {
      loadInvoicesForCustomer(customerId);
    } else {
      setInvoices([]);
    }
  };

  const handleInvoiceChange = async (invoiceId: string) => {
    const invoice = invoices.find(inv => inv.id === invoiceId);
    setFormData({
      ...formData,
      original_invoice_id: invoiceId,
      original_invoice_number: invoice?.invoice_number || '',
    });

    if (invoiceId) {
      await loadInvoiceItems(invoiceId);
    } else {
      setItems([{ product_id: '', batch_id: '', quantity: 0, unit_price: 0 }]);
    }
  };

  const loadInvoiceItems = async (invoiceId: string) => {
    try {
      const { data, error } = await supabase
        .from('sales_invoice_items')
        .select(`
          product_id,
          batch_id,
          quantity,
          unit_price,
          products(product_name, product_code),
          batches(
            batch_number,
            current_stock,
            product_sources!batches_make_id_fkey(supplier_name, grade)
          )
        `)
        .eq('invoice_id', invoiceId);

      if (error) throw error;

      if (data && data.length > 0) {
        const invoiceItems = data.map(item => {
          const batch = normalizeNestedRelation(item.batches);
          return {
          product_id: item.product_id,
          batch_id: item.batch_id || '',
          quantity: item.quantity,
          unit_price: item.unit_price,
          batches: batch ? {
            ...batch,
            product_sources: normalizeNestedRelation(batch.product_sources),
          } : null,
          };
        });
        setItems(invoiceItems);
      }
    } catch (error) {
      console.error('Error loading invoice items:', error);
    }
  };

  const addItem = () => {
    setItems([...items, { product_id: '', batch_id: '', quantity: 0, unit_price: 0 }]);
  };

  const removeItem = (index: number) => {
    if (items.length > 1) {
      setItems(items.filter((_, i) => i !== index));
    }
  };

  const updateItem = (index: number, field: string, value: any) => {
    const updated = [...items];
    updated[index] = { ...updated[index], [field]: value };

    if (field === 'product_id') {
      loadBatchesForProduct(value);
      updated[index].batch_id = '';
    }

    setItems(updated);
  };

  const calculateTotals = () => {
    const subtotal = items.reduce((sum, item) => sum + (item.quantity * item.unit_price), 0);
    const tax_amount = subtotal * 0.11;
    const total_amount = subtotal + tax_amount;
    return { subtotal, tax_amount, total_amount };
  };

  const handleEditCreditNote = async (creditNote: CreditNote) => {
    if (creditNote.status === 'approved') {
      showToast({
        type: 'error',
        title: 'Cannot Edit',
        message: 'Approved credit notes have posted general ledger and inventory records and cannot be edited. Please reverse the credit note if adjustments are needed.',
      });
      return;
    }

    try {
      setLoading(true);
      const { data: itemRows, error: itemErr } = await supabase
        .from('credit_note_items')
        .select(`
          product_id,
          batch_id,
          quantity,
          unit_price,
          products(product_name, product_code),
          batches(
            batch_number,
            current_stock,
            product_sources!batches_make_id_fkey(supplier_name, grade)
          )
        `)
        .eq('credit_note_id', creditNote.id);

      if (itemErr) throw itemErr;

      setEditingCreditNoteId(creditNote.id);
      setFormData({
        credit_note_number: creditNote.credit_note_number,
        credit_note_date: creditNote.credit_note_date,
        customer_id: creditNote.customer_id,
        original_invoice_id: creditNote.original_invoice_id || '',
        original_invoice_number: creditNote.original_invoice_number || '',
        reason: creditNote.reason || '',
        notes: creditNote.notes || '',
        currency: creditNote.currency || 'IDR',
        material_return_id: creditNote.material_return_id || '',
        credit_note_type: creditNote.credit_note_type || (creditNote.material_return_id ? 'physical_return' : ''),
      });

      if (creditNote.customer_id) {
        await loadInvoicesForCustomer(creditNote.customer_id);
      }

      if (itemRows && itemRows.length > 0) {
        const loadedItems = itemRows.map((item: any) => {
          const batch = normalizeNestedRelation(item.batches);
          return {
            product_id: item.product_id,
            batch_id: item.batch_id || '',
            quantity: Number(item.quantity) || 0,
            unit_price: Number(item.unit_price) || 0,
            batches: batch ? {
              ...batch,
              product_sources: normalizeNestedRelation(batch.product_sources),
            } : null,
          };
        });
        setItems(loadedItems);
        if (loadedItems[0]?.product_id) {
          loadBatchesForProduct(loadedItems[0].product_id);
        }
      }

      setModalOpen(true);
    } catch (err: any) {
      console.error('Error loading credit note for edit:', err);
      showToast({ type: 'error', title: 'Error', message: err?.message || 'Failed to load credit note details' });
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (isSubmitting) return;

    if (!formData.customer_id || !formData.reason || items.length === 0) {
      showToast({ type: 'error', title: 'Error', message: 'Please complete all required fields' });
      return;
    }

    if (!formData.credit_note_type && !formData.material_return_id) {
      showToast({ type: 'error', title: 'Classification Required', message: 'Please select a Credit Note Type (Physical Return or Commercial Credit).' });
      return;
    }

    const hasInvalidItems = items.some(item => !item.product_id || !item.batch_id || item.quantity <= 0 || item.unit_price <= 0);
    if (hasInvalidItems) {
      showToast({ type: 'error', title: 'Error', message: 'Please complete all item details' });
      return;
    }

    // Branch for Editing existing draft credit note
    if (editingCreditNoteId) {
      setIsSubmitting(true);
      try {
        const totals = calculateTotals();
        const { error: updateErr } = await supabase
          .from('credit_notes')
          .update({
            credit_note_date: formData.credit_note_date,
            customer_id: formData.customer_id,
            original_invoice_id: formData.original_invoice_id || null,
            original_invoice_number: formData.original_invoice_number || null,
            reason: formData.reason,
            notes: formData.notes || null,
            currency: formData.currency,
            material_return_id: formData.material_return_id || null,
            credit_note_type: formData.material_return_id ? 'physical_return' : formData.credit_note_type,
            ...totals,
            updated_at: new Date().toISOString(),
          })
          .eq('id', editingCreditNoteId)
          .eq('status', 'pending_approval');

        if (updateErr) throw updateErr;

        // Replace items
        const { error: delErr } = await supabase
          .from('credit_note_items')
          .delete()
          .eq('credit_note_id', editingCreditNoteId);
        if (delErr) throw delErr;

        const itemsWithCreditNoteId = items.map(({ products: _products, batches: _batches, ...item }) => ({
          ...item,
          credit_note_id: editingCreditNoteId,
        }));

        const { error: itemsInsertErr } = await supabase
          .from('credit_note_items')
          .insert(itemsWithCreditNoteId);
        if (itemsInsertErr) throw itemsInsertErr;

        showToast({ type: 'success', title: 'Updated', message: `Credit note ${formData.credit_note_number} updated successfully.` });
        setModalOpen(false);
        resetForm();
        emitErpSync('credit_notes', 'updated', { entityId: editingCreditNoteId });
        emitErpSync('sales_invoices', 'updated');
        await loadData();
      } catch (error: any) {
        console.error('Error updating credit note:', error);
        showToast({ type: 'error', title: 'Error', message: error.message || 'Failed to update credit note.' });
      } finally {
        setIsSubmitting(false);
      }
      return;
    }

    setIsSubmitting(true);
    let creditNoteId: string | null = null;

    try {
      const totals = calculateTotals();
      const finalNumber = formData.credit_note_number.trim() || await generateNextCreditNoteNumber();

      const insertPayload: Record<string, any> = {
        credit_note_number: finalNumber,
        credit_note_date: formData.credit_note_date,
        customer_id: formData.customer_id,
        original_invoice_id: formData.original_invoice_id || null,
        original_invoice_number: formData.original_invoice_number || null,
        reason: formData.reason,
        notes: formData.notes || null,
        currency: formData.currency,
        credit_note_type: formData.material_return_id ? 'physical_return' : formData.credit_note_type,
        ...totals,
        created_by: user?.id,
      };
      if (formData.material_return_id) insertPayload.material_return_id = formData.material_return_id;

      const { data: creditNoteData, error: creditNoteError } = await supabase
        .from('credit_notes')
        .insert(insertPayload)
        .select()
        .single();

      if (creditNoteError) throw creditNoteError;
      creditNoteId = creditNoteData.id;

      const itemsWithCreditNoteId = items.map(({ products: _products, batches: _batches, ...item }) => ({
        ...item,
        credit_note_id: creditNoteData.id,
      }));

      const { error: itemsError } = await supabase
        .from('credit_note_items')
        .insert(itemsWithCreditNoteId);

      if (itemsError) {
        // Safe rollback of orphaned header if item insertion fails
        await supabase.from('credit_notes').delete().eq('id', creditNoteId);
        throw new Error(`Failed to save credit note items: ${itemsError.message}`);
      }

      showToast({ type: 'success', title: 'Created', message: `Credit note ${finalNumber} created and is pending approval.` });
      setModalOpen(false);
      resetForm();
      emitErpSync('credit_notes', 'created', { entityId: creditNoteId || undefined });
      emitErpSync('sales_invoices', 'updated');
      await loadData();
    } catch (error: any) {
      console.error('Error creating credit note:', error);
      showToast({ type: 'error', title: 'Error', message: error.message || 'Failed to create credit note. Please try again.' });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleApprove = async (id: string) => {
    const targetNote = creditNotes.find(cn => cn.id === id);
    if (!targetNote?.credit_note_type && !targetNote?.material_return_id) {
      showToast({
        type: 'error',
        title: 'Classification Required',
        message: 'This credit note is unclassified. Please edit the credit note to specify Physical Return or Commercial Credit before approving.',
      });
      return;
    }

    if (!await showConfirm({ title: 'Confirm', message: 'Approve this credit note? Stock and General Ledger will be adjusted accordingly.', variant: 'warning' })) return;

    try {
      const updatePayload: Record<string, any> = {
        status: 'approved',
        approved_by: user?.id,
        approval_date: new Date().toISOString(),
      };

      // If existing legacy credit note had a blank number, assign a sequential number upon approval
      if (!targetNote?.credit_note_number || targetNote.credit_note_number.trim() === '') {
        const nextNum = await generateNextCreditNoteNumber();
        updatePayload.credit_note_number = nextNum;
      }

      const { error } = await supabase
        .from('credit_notes')
        .update(updatePayload)
        .eq('id', id);

      if (error) throw error;
      showToast({ type: 'success', title: 'Success', message: 'Credit note approved successfully' });
      emitErpSync('credit_notes', 'approved', { entityId: id });
      emitErpSync('sales_invoices', 'updated');
      emitErpSync('inventory', 'updated');
      await loadData();
    } catch (error: any) {
      console.error('Error approving credit note:', error);
      showToast({ type: 'error', title: 'Error', message: error.message || 'Failed to approve credit note' });
    }
  };

  const handleReject = async (id: string) => {
    const reason = prompt('Enter reason for rejection:');
    if (!reason) return;

    try {
      const { error } = await supabase
        .from('credit_notes')
        .update({
          status: 'rejected',
          approved_by: user?.id,
          notes: reason,
        })
        .eq('id', id);

      if (error) throw error;
      showToast({ type: 'success', title: 'Success', message: 'Credit note rejected' });
      emitErpSync('credit_notes', 'rejected', { entityId: id });
      emitErpSync('sales_invoices', 'updated');
      await loadData();
    } catch (error: any) {
      console.error('Error rejecting credit note:', error);
      showToast({ type: 'error', title: 'Error', message: error.message || 'Failed to reject credit note' });
    }
  };

  const handleDelete = async (id: string) => {
    const targetNote = creditNotes.find(cn => cn.id === id);
    if (!targetNote) return;

    if (targetNote.status === 'approved') {
      showToast({
        type: 'error',
        title: 'Cannot Delete',
        message: 'Approved credit notes have posted general ledger and inventory records and cannot be deleted. Please reject or reverse the credit note instead.',
      });
      return;
    }

    if ((targetNote as any).nota_retur_id) {
      showToast({
        type: 'error',
        title: 'Cannot Delete',
        message: 'This credit note is linked to a registered Coretax Nota Retur tax document and cannot be deleted.',
      });
      return;
    }

    const linkedReturnMsg = targetNote.material_return_id
      ? ' This credit note is linked to a Material Return. Deleting it will release the return so a new credit note can be re-issued.'
      : '';

    if (!await showConfirm({
      title: 'Confirm Delete',
      message: `Are you sure you want to delete credit note ${targetNote.credit_note_number || 'Draft'}?${linkedReturnMsg}`,
      variant: 'danger',
      confirmLabel: 'Delete',
    })) {
      return;
    }

    try {
      const { error } = await supabase
        .from('credit_notes')
        .delete()
        .eq('id', id);

      if (error) throw error;

      showToast({ type: 'success', title: 'Success', message: 'Credit note deleted successfully' });
      emitErpSync('credit_notes', 'deleted', { entityId: id });
      emitErpSync('sales_invoices', 'updated');
      await loadData();
    } catch (error: any) {
      console.error('Error deleting credit note:', error);
      showToast({ type: 'error', title: 'Error', message: error.message || 'Failed to delete credit note' });
    }
  };

  const handleOpenCreateModal = async () => {
    resetForm();
    const nextNumber = await generateNextCreditNoteNumber();
    setFormData(prev => ({
      ...prev,
      credit_note_number: nextNumber,
    }));
    setModalOpen(true);
  };

  const resetForm = () => {
    setEditingCreditNoteId(null);
    setFormData({
      credit_note_number: '',
      credit_note_date: new Date().toISOString().split('T')[0],
      customer_id: '',
      original_invoice_id: '',
      original_invoice_number: '',
      reason: '',
      notes: '',
      currency: 'IDR',
      material_return_id: '',
      credit_note_type: 'physical_return',
    });
    setItems([{ product_id: '', batch_id: '', quantity: 0, unit_price: 0 }]);
  };

  // Auto-populate form when navigated from Material Returns "Issue CN" button
  useEffect(() => {
    const returnId = sessionStorage.getItem('anzen_originating_return_id');
    if (returnId && modalOpen) {
      sessionStorage.removeItem('anzen_originating_return_id');
    }
  }, [modalOpen]);

  useEffect(() => {
    const returnId = sessionStorage.getItem('anzen_originating_return_id');
    if (!returnId) return;
    const ret = approvedReturns.find(r => r.id === returnId);
    if (!ret) return;
    sessionStorage.removeItem('anzen_originating_return_id');
    generateNextCreditNoteNumber().then(nextNum => {
      setFormData(prev => ({
        ...prev,
        credit_note_number: nextNum,
        customer_id: ret.customer_id || '',
        original_invoice_id: ret.original_invoice_id || '',
        original_invoice_number: ret.sales_invoices?.invoice_number || '',
        reason: `Return ${ret.return_number}: ${ret.return_reason || 'Customer material return'}`,
        material_return_id: ret.id,
        credit_note_type: 'physical_return',
      }));
    });
    if (ret.customer_id) loadInvoicesForCustomer(ret.customer_id);
    if (ret.original_invoice_id) loadInvoiceItems(ret.original_invoice_id);
    setModalOpen(true);
  }, [approvedReturns]);

  const canManage = profile?.role === 'admin' || profile?.role === 'sales' || profile?.role === 'warehouse' || profile?.role === 'manager';
  const isManager = profile?.role === 'admin' || profile?.role === 'manager';

  const columns = [
    {
      key: 'credit_note_number',
      label: 'Credit Note #',
      render: (value: any, cn: CreditNote) => cn.credit_note_number?.trim() ? (
        <span className="font-mono font-medium text-gray-900">{cn.credit_note_number}</span>
      ) : (
        <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-amber-50 text-amber-700 border border-amber-200 font-mono">
          Pending
        </span>
      )
    },
    {
      key: 'credit_note_date',
      label: 'Date',
      render: (value: any, cn: CreditNote) => formatDate(cn.credit_note_date)
    },
    {
      key: 'customer',
      label: 'Customer',
      render: (value: any, cn: CreditNote) => {
        const customer = normalizeNestedRelation(cn.customers);
        return customer?.company_name || 'N/A';
      }
    },
    {
      key: 'original_invoice_number',
      label: 'Original Invoice',
      render: (value: any, cn: CreditNote) => {
        const invoice = normalizeNestedRelation(cn.sales_invoices);
        return cn.original_invoice_number || invoice?.invoice_number || 'N/A';
      }
    },
    {
      key: 'linked_return',
      label: 'Type / Linked Return',
      render: (value: any, cn: CreditNote) => {
        const ret = normalizeNestedRelation(cn.material_returns);
        if (ret) {
          return (
            <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-purple-50 text-purple-700 border border-purple-200 font-mono font-medium">
              {ret.return_number}
            </span>
          );
        }
        if (cn.credit_note_type === 'physical_return') {
          return (
            <span
              className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200 font-medium"
              title="Physical Goods Return: Goods received into warehouse and restocked into batches"
            >
              Physical Return
            </span>
          );
        }
        if (cn.credit_note_type === 'commercial_credit') {
          return (
            <span
              className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-200 font-medium"
              title="Commercial Credit Note: Price adjustment / damaged packaging concession without physical goods return"
            >
              Commercial
            </span>
          );
        }
        return (
          <span
            className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded bg-amber-50 text-amber-700 border border-amber-200 font-medium"
            title="Historical Unclassified Record: Requires manual audit before approval"
          >
            Unclassified (Review Required)
          </span>
        );
      }
    },
    {
      key: 'total_amount',
      label: 'Amount',
      render: (value: any, cn: CreditNote) => `${cn.currency} ${cn.total_amount.toLocaleString('id-ID', { minimumFractionDigits: 2 })}`
    },
    {
      key: 'status',
      label: 'Status',
      render: (value: any, cn: CreditNote) => (
        <span className={`inline-block px-2 py-1 rounded-full text-xs font-medium ${
          cn.status === 'approved' ? 'bg-green-100 text-green-800' :
          cn.status === 'rejected' ? 'bg-red-100 text-red-800' :
          'bg-yellow-100 text-yellow-800'
        }`}>
          {cn.status?.replace('_', ' ') || 'pending approval'}
        </span>
      )
    },
    {
      key: 'reason',
      label: 'Reason',
      render: (value: any, cn: CreditNote) => (
        <span className="text-sm text-gray-600 truncate max-w-xs block">
          {cn.reason}
        </span>
      )
    },
  ];

  const totals = calculateTotals();

  const filteredCreditNotes = creditNotes.filter(cn => {
    if (statusFilter !== 'all' && (cn.status || 'pending_approval') !== statusFilter) {
      return false;
    }
    if (dateFilter.startDate && cn.credit_note_date < dateFilter.startDate) {
      return false;
    }
    if (dateFilter.endDate && cn.credit_note_date > dateFilter.endDate) {
      return false;
    }
    return true;
  });

  return (
    <Layout>
      <div className="space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 pb-2 border-b border-gray-200">
          <div>
            <h1 className="text-lg sm:text-xl font-bold text-gray-900 tracking-tight">{t('creditNotes.title')}</h1>
            <p className="text-xs text-gray-500 mt-0.5">Manage credit notes for returns and adjustments after invoicing</p>
          </div>
          {canManage && (
            <button
              onClick={handleOpenCreateModal}
              className="flex items-center gap-1.5 bg-red-600 text-white px-3 py-1.5 rounded-lg text-xs font-semibold hover:bg-red-700 shadow-xs transition"
            >
              <Plus className="w-3.5 h-3.5" />
              {t('creditNotes.createCreditNote')}
            </button>
          )}
        </div>

        {queryError && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-3 flex items-center justify-between text-xs text-red-700">
            <div className="flex items-center gap-2">
              <XCircle className="w-4 h-4 text-red-500 flex-shrink-0" />
              <div>
                <span className="font-semibold">Failed to load credit notes: </span>
                <span>{queryError}</span>
              </div>
            </div>
            <button
              onClick={() => loadCreditNotes()}
              className="px-2.5 py-1 bg-red-600 text-white rounded text-xs font-medium hover:bg-red-700 transition flex items-center gap-1"
            >
              <RotateCcw className="w-3 h-3" />
              Retry Query
            </button>
          </div>
        )}

        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 flex gap-3">
          <AlertCircle className="w-5 h-5 text-yellow-600 flex-shrink-0 mt-0.5" />
          <div className="text-sm text-yellow-800">
            <p className="font-medium">When to use Credit Notes:</p>
            <p className="mt-1">Use Credit Notes for goods returned or price adjustments AFTER an invoice has been issued and filed for tax purposes. For physical returns before invoicing, use Material Returns instead.</p>
          </div>
        </div>

        {/* Filter bar: Defaults to showing all credit notes. Allows narrowing by status and commercial Credit Note Date */}
        <div className="flex flex-wrap items-center justify-between gap-2.5 bg-white p-2.5 rounded-lg border border-gray-200 shadow-xs text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-gray-500 font-medium flex items-center gap-1">
              <Filter className="w-3.5 h-3.5" /> Status:
            </span>
            {(['all', 'pending_approval', 'approved', 'rejected'] as const).map((status) => (
              <button
                key={status}
                onClick={() => setStatusFilter(status)}
                className={`px-2.5 py-1 rounded text-xs font-medium transition ${
                  statusFilter === status
                    ? 'bg-red-600 text-white'
                    : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                }`}
              >
                {status === 'all' ? 'All' : status.replace('_', ' ')}
              </button>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <span className="text-gray-500 font-medium">Date Range (CN Date):</span>
            <input
              type="date"
              aria-label="Filter Start Date"
              value={dateFilter.startDate}
              onChange={(e) => setDateFilter(prev => ({ ...prev, startDate: e.target.value }))}
              className="px-2 py-1 text-xs border border-gray-300 rounded bg-white"
            />
            <span className="text-gray-400">to</span>
            <input
              type="date"
              aria-label="Filter End Date"
              value={dateFilter.endDate}
              onChange={(e) => setDateFilter(prev => ({ ...prev, endDate: e.target.value }))}
              className="px-2 py-1 text-xs border border-gray-300 rounded bg-white"
            />
            {(statusFilter !== 'all' || dateFilter.startDate || dateFilter.endDate) && (
              <button
                onClick={() => {
                  setStatusFilter('all');
                  setDateFilter({ startDate: '', endDate: '' });
                }}
                className="text-xs text-red-600 hover:text-red-800 underline ml-1"
              >
                Reset Filters
              </button>
            )}
            <span className="text-gray-400 text-[11px] ml-2">
              Showing {filteredCreditNotes.length} of {creditNotes.length}
            </span>
          </div>
        </div>

        <DataTable
          columns={columns}
          data={filteredCreditNotes}
          loading={loading}
          actions={(creditNote) => (
            <div className="flex items-center gap-2">
              <button
                onClick={() => handleViewCreditNote(creditNote)}
                className="p-1 text-blue-600 hover:bg-blue-50 rounded"
                title="View Credit Note"
              >
                <Eye className="w-4 h-4" />
              </button>

              {canManage && (!creditNote.status || creditNote.status === 'pending_approval') && (
                <button
                  onClick={() => handleEditCreditNote(creditNote)}
                  className="p-1 text-indigo-600 hover:bg-indigo-50 rounded"
                  title="Edit Credit Note"
                >
                  <Pencil className="w-4 h-4" />
                </button>
              )}

              {isManager && (!creditNote.status || creditNote.status === 'pending_approval') && (
                <>
                  <button
                    onClick={() => handleApprove(creditNote.id)}
                    className="p-1 text-green-600 hover:bg-green-50 rounded"
                    title="Approve Credit Note"
                  >
                    <CheckCircle className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => handleReject(creditNote.id)}
                    className="p-1 text-red-600 hover:bg-red-50 rounded"
                    title="Reject Credit Note"
                  >
                    <XCircle className="w-4 h-4" />
                  </button>
                </>
              )}

              {canManage && (!creditNote.status || creditNote.status === 'pending_approval' || creditNote.status === 'rejected') && (
                <button
                  onClick={() => handleDelete(creditNote.id)}
                  className="p-1 text-red-600 hover:bg-red-50 rounded"
                  title="Delete Credit Note"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              )}
            </div>
          )}
        />

        <Modal
          isOpen={modalOpen}
          onClose={() => {
            setModalOpen(false);
            resetForm();
          }}
          title={editingCreditNoteId ? 'Edit Credit Note' : 'Create Credit Note'}
        >
          <form onSubmit={handleSubmit} className="space-y-4">
            <SapRow>
              <FloatingField label="Credit Note # (Auto)" span={6} filled={!!formData.credit_note_number} hint="System-assigned sequential ID">
                <input
                  name="credit_note_number"
                  aria-label="Credit Note Number"
                  type="text"
                  value={formData.credit_note_number}
                  readOnly
                  placeholder="Generating..."
                  className={`${FLOAT_INPUT} bg-gray-50 font-mono`}
                />
              </FloatingField>

              <FloatingField label="Credit Note Date" required span={6} filled={!!formData.credit_note_date}>
                <input
                  name="credit_note_date"
                  aria-label="Credit Note Date"
                  type="date"
                  value={formData.credit_note_date}
                  onChange={(e) => setFormData({ ...formData, credit_note_date: e.target.value })}
                  required
                  className={FLOAT_INPUT}
                />
              </FloatingField>
            </SapRow>

            <SapRow>
              <FloatingField label="Customer" required span={6} filled={!!formData.customer_id}>
                <SearchableSelect
                  value={formData.customer_id}
                  onChange={(val) => handleCustomerChange(val)}
                  options={customers.map(c => ({ value: c.id, label: c.company_name }))}
                  placeholder="Select Customer"
                />
              </FloatingField>

              <FloatingField label="Original Invoice (Optional)" span={6} filled={!!formData.original_invoice_id}>
                <select name="original_invoice_optional" aria-label="Original Invoice (Optional)"
                  value={formData.original_invoice_id}
                  onChange={(e) => handleInvoiceChange(e.target.value)}
                  disabled={!formData.customer_id}
                  className={FLOAT_INPUT}
                >
                  <option value="">Select Invoice</option>
                  {invoices.map((invoice) => (
                    <option key={invoice.id} value={invoice.id}>
                      {invoice.invoice_number} - {formatDate(invoice.invoice_date)} - Rp {invoice.total_amount.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </option>
                  ))}
                </select>
              </FloatingField>
            </SapRow>

            {approvedReturns.filter(r => !formData.customer_id || r.customer_id === formData.customer_id).length > 0 && (
              <div className="bg-purple-50 border border-purple-200 rounded-lg p-3">
                <p className="text-xs text-purple-600 mb-2">
                  If this Credit Note is being issued because of a Material Return, link it here for complete financial traceability.
                </p>
                <SapRow>
                  <FloatingField label="Link to Approved Material Return" span={12} filled={!!formData.material_return_id}>
                    <select
                      name="material_return_id"
                      aria-label="Link to Approved Material Return"
                      value={formData.material_return_id}
                      onChange={(e) => {
                        const retId = e.target.value;
                        const ret = approvedReturns.find(r => r.id === retId);
                        setFormData(prev => ({
                          ...prev,
                          material_return_id: retId,
                          ...(ret && !formData.customer_id ? { customer_id: ret.customer_id } : {}),
                          ...(ret?.original_invoice_id && !formData.original_invoice_id ? {
                            original_invoice_id: ret.original_invoice_id,
                            original_invoice_number: ret.sales_invoices?.invoice_number || '',
                          } : {}),
                          ...(ret && !formData.reason ? { reason: `Return ${ret.return_number}: ${ret.return_reason || 'Customer material return'}` } : {}),
                        }));
                        if (ret?.customer_id && !formData.customer_id) loadInvoicesForCustomer(ret.customer_id);
                        if (ret?.original_invoice_id && !formData.original_invoice_id) loadInvoiceItems(ret.original_invoice_id);
                      }}
                      className={FLOAT_INPUT}
                    >
                      <option value="">— No linked return —</option>
                      {approvedReturns
                        .filter(r => !formData.customer_id || r.customer_id === formData.customer_id)
                        .map(ret => (
                          <option key={ret.id} value={ret.id}>
                            {ret.return_number} — {ret.customers?.company_name || 'Unknown'} — Rp {(ret.financial_impact || 0).toLocaleString('id-ID')}
                            {ret.sales_invoices?.invoice_number ? ` (Invoice: ${ret.sales_invoices.invoice_number})` : ''}
                          </option>
                        ))
                      }
                    </select>
                  </FloatingField>
                </SapRow>
              </div>
            )}

            <SapRow>
              <FloatingField label="Credit Note Type" required span={6} filled={!!formData.credit_note_type || !!formData.material_return_id} hint={formData.material_return_id ? 'Linked Material Returns are physical returns' : undefined}>
                <select
                  name="credit_note_type"
                  aria-label="Credit Note Type"
                  value={formData.material_return_id ? 'physical_return' : formData.credit_note_type}
                  onChange={(e) => setFormData({ ...formData, credit_note_type: e.target.value as 'physical_return' | 'commercial_credit' })}
                  disabled={!!formData.material_return_id}
                  className={FLOAT_INPUT}
                >
                  {!formData.credit_note_type && !formData.material_return_id && (
                    <option value="">— Select Credit Note Type —</option>
                  )}
                  <option value="physical_return">Physical Return (Restocks stock & reverses COGS)</option>
                  <option value="commercial_credit">Commercial Credit (Financial/price concession only)</option>
                </select>
              </FloatingField>

              <FloatingField label="Currency" span={6} filled={!!formData.currency}>
                <select name="currency" aria-label="Currency"
                  value={formData.currency}
                  onChange={(e) => setFormData({ ...formData, currency: e.target.value })}
                  className={FLOAT_INPUT}
                >
                  <option value="IDR">IDR</option>
                  <option value="USD">USD</option>
                </select>
              </FloatingField>
            </SapRow>

            <SapRow>
              <FloatingField label="Reason for Credit Note" required span={12} textarea filled={!!formData.reason}>
                <textarea name="reason_for_credit_note" aria-label="Reason for Credit Note"
                  value={formData.reason}
                  onChange={(e) => setFormData({ ...formData, reason: e.target.value })}
                  required
                  rows={2}
                  placeholder="e.g., Goods returned due to quality issue, Price adjustment, etc."
                  className={FLOAT_TEXTAREA}
                />
              </FloatingField>
            </SapRow>

            <div className="border-t pt-4">
              <div className="flex items-center justify-between mb-3">
                <h4 className="text-sm font-semibold text-gray-900">Items Being Credited</h4>
                {!formData.original_invoice_id && (
                  <button
                    type="button"
                    onClick={addItem}
                    className="text-sm text-red-600 hover:text-red-700 font-medium"
                  >
                    + Add Item
                  </button>
                )}
              </div>

              <div className="space-y-3">
                {items.map((item, index) => {
                  const selectedBatch = batches.find(batch => batch.id === item.batch_id) || item.batches;
                  const makeName = selectedBatch?.product_sources?.supplier_name || 'Not recorded';

                  return (
                  <div key={index} className="p-3 border border-gray-200 rounded-lg space-y-2">
                    <SapRow>
                      <FloatingField label="Product" required span={6} filled={!!item.product_id}>
                        <select name="product_id" aria-label="Product Id"
                          value={item.product_id}
                          onChange={(e) => updateItem(index, 'product_id', e.target.value)}
                          required
                          disabled={!!formData.original_invoice_id}
                          className={FLOAT_INPUT}
                        >
                          <option value="">Select Product</option>
                          {products.map((product) => (
                            <option key={product.id} value={product.id}>
                              {product.product_name} ({product.product_code})
                            </option>
                          ))}
                        </select>
                      </FloatingField>

                      <FloatingField label="Batch" required span={6} filled={!!item.batch_id} hint={item.batch_id ? `Make: ${makeName}` : undefined}>
                        <select name="batch_id" aria-label="Batch Id"
                          value={item.batch_id}
                          onChange={(e) => updateItem(index, 'batch_id', e.target.value)}
                          required
                          disabled={!item.product_id || !!formData.original_invoice_id}
                          className={FLOAT_INPUT}
                        >
                          <option value="">Select Batch</option>
                          {batches
                            .filter(b => b.product_id === item.product_id)
                            .map((batch) => (
                              <option key={batch.id} value={batch.id}>
                                {batch.batch_number} (Stock: {batch.current_stock})
                              </option>
                            ))}
                        </select>
                      </FloatingField>

                      <FloatingField label="Quantity (Kg)" required span={6} filled={!!item.quantity}>
                        <input name="quantity_kg" aria-label="Quantity (Kg)"
                          type="number"
                          step="0.001"
                          placeholder="Quantity in Kg"
                          value={item.quantity || ''}
                          onChange={(e) => updateItem(index, 'quantity', parseFloat(e.target.value) || 0)}
                          required
                          min="0.001"
                          className={FLOAT_INPUT}
                        />
                      </FloatingField>

                      <FloatingField label="Unit Price (per Kg)" required span={6} filled={!!item.unit_price}>
                        <MoneyInput
                          placeholder="Price per Kg"
                          value={item.unit_price}
                          onChange={(amount) => updateItem(index, 'unit_price', amount)}
                          required
                          min="0"
                          className={FLOAT_INPUT}
                          maximumFractionDigits={4}
                        />
                      </FloatingField>
                    </SapRow>

                    <div className="flex items-center justify-between text-sm">
                      <span className="text-gray-600">
                        Line Total: <span className="font-semibold">{formData.currency} {(item.quantity * item.unit_price).toLocaleString('id-ID', { minimumFractionDigits: 2 })}</span>
                      </span>
                      {items.length > 1 && (
                        <button
                          type="button"
                          onClick={() => removeItem(index)}
                          className="text-red-600 hover:text-red-800"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  </div>
                  );
                })}
              </div>
            </div>

            <div className="border-t pt-4">
              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-gray-600">Subtotal:</span>
                  <span className="font-semibold">{formData.currency} {totals.subtotal.toLocaleString('id-ID', { minimumFractionDigits: 2 })}</span>
                </div>
                <div className="flex justify-between text-lg font-bold border-t pt-2">
                  <span>Total Credit:</span>
                  <span className="text-red-600">{formData.currency} {totals.total_amount.toLocaleString('id-ID', { minimumFractionDigits: 2 })}</span>
                </div>
              </div>
            </div>

            <SapRow>
              <FloatingField label="Additional Notes" span={12} textarea filled={!!formData.notes}>
                <textarea name="additional_notes" aria-label="Additional Notes"
                  value={formData.notes}
                  onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                  rows={2}
                  className={FLOAT_TEXTAREA}
                />
              </FloatingField>
            </SapRow>

            <div className="flex justify-end gap-3 pt-4 border-t">
              <button
                type="button"
                onClick={() => {
                  setModalOpen(false);
                  resetForm();
                }}
                className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 transition"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isSubmitting}
                className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition disabled:opacity-50 flex items-center gap-2"
              >
                {isSubmitting ? (
                  <>
                    <span className="inline-block animate-spin rounded-full h-3.5 w-3.5 border-2 border-white border-t-transparent" />
                    <span>{editingCreditNoteId ? 'Saving...' : 'Creating...'}</span>
                  </>
                ) : (
                  editingCreditNoteId ? 'Update Credit Note' : 'Create Credit Note'
                )}
              </button>
            </div>
          </form>
        </Modal>

        {viewModalOpen && selectedCreditNote && (
          <CreditNoteView
            creditNote={selectedCreditNote as any}
            items={selectedCreditNoteItems}
            onClose={() => {
              setViewModalOpen(false);
              setSelectedCreditNote(null);
              setSelectedCreditNoteItems([]);
            }}
            companyProfile={(selectedCreditNote as any).company_snapshot ?? undefined}
          />
        )}
      </div>
    </Layout>
  );
}
