import { useEffect, useState } from 'react';
import { Layout } from '../components/Layout';
import { DataTable } from '../components/DataTable';
import { Modal } from '../components/Modal';
import { SearchableSelect } from '../components/SearchableSelect';
import { CreditNoteView } from '../components/CreditNoteView';
import { useLanguage } from '../contexts/LanguageContext';
import { useAuth } from '../contexts/AuthContext';
import { supabase } from '../lib/supabase';
import {
  Plus,
  Eye,
  Trash2,
  AlertCircle,
  CheckCircle,
  XCircle,
  RotateCcw,
  Filter,
  Pencil,
  ArrowRight,
  DollarSign,
  ShieldCheck,
  BookOpen,
} from 'lucide-react';
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

export const BUSINESS_CASES = [
  { value: 'full_physical_return', label: 'Full Physical Return', type: 'physical_return', defaultDisp: 'saleable', desc: 'Complete goods return; restocks inventory & full A/R credit' },
  { value: 'partial_physical_return', label: 'Partial Physical Return', type: 'physical_return', defaultDisp: 'saleable', desc: 'Partial goods return; restocks accepted qty & reverses proportional COGS' },
  { value: 'damaged_packaging', label: 'Damaged Packaging Return', type: 'physical_return', defaultDisp: 'quarantine', desc: 'Packaging damaged in transit; received into quarantine for repacking' },
  { value: 'damaged_product', label: 'Damaged Product Return', type: 'physical_return', defaultDisp: 'damaged', desc: 'Product damaged / unusable; recognized as inventory impairment (5190)' },
  { value: 'quality_rejection', label: 'Quality Rejection', type: 'physical_return', defaultDisp: 'quarantine', desc: 'Customer QA rejected; held in quarantine / pending supplier claim' },
  { value: 'price_adjustment', label: 'Commercial Price Adjustment', type: 'commercial_credit', defaultDisp: 'saleable', desc: 'Billing / price rate adjustment; zero inventory & COGS movement' },
  { value: 'post_invoice_discount', label: 'Post-Invoice Discount / Allowance', type: 'commercial_credit', defaultDisp: 'saleable', desc: 'Volume or agreed allowance granted post-invoicing' },
  { value: 'customer_refund', label: 'Customer Refund', type: 'commercial_credit', defaultDisp: 'saleable', desc: 'Overpayment or return settled via cash/bank payout' },
  { value: 'future_credit_adjustment', label: 'Future Invoice Credit Balance', type: 'commercial_credit', defaultDisp: 'saleable', desc: 'Credit retained on customer account to offset future billing' },
] as const;

export const STOCK_DISPOSITIONS = [
  { value: 'saleable', label: 'Saleable (Restock to batch & reverse FIFO COGS)' },
  { value: 'quarantine', label: 'Quarantine (Hold for inspection / QC review)' },
  { value: 'damaged', label: 'Damaged (Write off to Loss 5190, no saleable stock)' },
  { value: 'scrap', label: 'Scrap / Disposal (Loss 5190, discard material)' },
  { value: 'rejected', label: 'Rejected (Non-recoverable / return to supplier)' },
] as const;

export const ITEM_CONDITIONS = [
  { value: 'good', label: 'Good / Intact' },
  { value: 'packaging_damaged', label: 'Packaging Damaged Only' },
  { value: 'damaged', label: 'Product Damaged' },
  { value: 'expired', label: 'Expired / Near Expiry' },
  { value: 'defective', label: 'Defective / Off-spec' },
] as const;

interface CreditNote {
  id: string;
  credit_note_number: string;
  credit_note_date: string;
  customer_id: string;
  original_invoice_id?: string;
  original_invoice_number?: string;
  sales_invoices?: {
    id?: string;
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
  business_case?: string;
  stock_disposition?: string;
  warehouse_id?: string;
  godown?: string;
  customer_credit_balance?: number;
  settlement_status?: string;
  applied_to_invoice_id?: string;
  applied_amount?: number;
  refund_amount?: number;
  refund_date?: string;
  refund_payment_voucher_id?: string;
  goods_return_receipt_id?: string;
  nota_retur_id?: string;
  journal_entry_id?: string;
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
  journal_entries?: {
    id: string;
    entry_number: string;
    entry_date: string;
  } | null;
  nota_retur?: {
    id: string;
    nomor_nota_retur: string;
    tanggal_nota_retur: string;
    status: string;
  } | null;
}

interface CreditNoteItem {
  id?: string;
  credit_note_id?: string;
  sales_invoice_item_id?: string;
  delivery_challan_item_id?: string;
  product_id: string;
  batch_id: string;
  quantity: number;
  unit_price: number;
  condition?: string;
  disposition?: string;
  accepted_quantity?: number;
  damaged_quantity?: number;
  rejected_quantity?: number;
  original_invoice_quantity?: number;
  already_returned_quantity?: number;
  remaining_returnable?: number;
  products?: {
    product_name: string;
    product_code: string;
  } | null;
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

  // Settlement and Nota Retur Modals
  const [applyModalOpen, setApplyModalOpen] = useState(false);
  const [targetCreditNoteForApply, setTargetCreditNoteForApply] = useState<CreditNote | null>(null);
  const [unpaidInvoices, setUnpaidInvoices] = useState<any[]>([]);
  const [selectedTargetInvoiceId, setSelectedTargetInvoiceId] = useState('');
  const [applyAmount, setApplyAmount] = useState(0);
  const [applyingCredit, setApplyingCredit] = useState(false);

  const [refundModalOpen, setRefundModalOpen] = useState(false);
  const [targetCreditNoteForRefund, setTargetCreditNoteForRefund] = useState<CreditNote | null>(null);
  const [refundAmount, setRefundAmount] = useState(0);
  const [refundDate, setRefundDate] = useState(new Date().toISOString().split('T')[0]);
  const [refundingCredit, setRefundingCredit] = useState(false);

  const [notaReturModalOpen, setNotaReturModalOpen] = useState(false);
  const [targetCreditNoteForNotaRetur, setTargetCreditNoteForNotaRetur] = useState<CreditNote | null>(null);
  const [nomorNotaRetur, setNomorNotaRetur] = useState('');
  const [tanggalNotaRetur, setTanggalNotaRetur] = useState(new Date().toISOString().split('T')[0]);
  const [generatingNotaRetur, setGeneratingNotaRetur] = useState(false);

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
    business_case: 'full_physical_return',
    stock_disposition: 'saleable',
    godown: 'Main Warehouse',
  });

  const [items, setItems] = useState<Omit<CreditNoteItem, 'id'>[]>([
    {
      product_id: '',
      batch_id: '',
      quantity: 0,
      unit_price: 0,
      condition: 'good',
      disposition: 'saleable',
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
      const { data: rpcNum, error: rpcErr } = await supabase.rpc('generate_credit_note_number');
      if (!rpcErr && rpcNum && typeof rpcNum === 'string') {
        return rpcNum;
      }
    } catch {
      // Fall through to query-based generation
    }

    try {
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
      const { data, error } = await supabase
        .from('credit_notes')
        .select(`
          *,
          customers(company_name, address, city, phone, npwp, pharmacy_license),
          material_returns:material_return_id(id, return_number, return_date, status, restocked),
          sales_invoices:original_invoice_id(id, invoice_number),
          journal_entries:journal_entry_id(id, entry_number, entry_date),
          nota_retur:nota_retur_id(id, nomor_nota_retur, tanggal_nota_retur, status)
        `)
        .order('created_at', { ascending: false });

      if (error) throw error;
      const normalizedData = (data || []).map((cn: any) => ({
        ...cn,
        customers: normalizeNestedRelation(cn.customers),
        material_returns: normalizeNestedRelation(cn.material_returns),
        sales_invoices: normalizeNestedRelation(cn.sales_invoices),
        journal_entries: normalizeNestedRelation(cn.journal_entries),
        nota_retur: normalizeNestedRelation(cn.nota_retur),
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
      setItems([{ product_id: '', batch_id: '', quantity: 0, unit_price: 0, condition: 'good', disposition: formData.stock_disposition }]);
    }
  };

  const loadInvoiceItems = async (invoiceId: string) => {
    try {
      const { data, error } = await supabase
        .from('sales_invoice_items')
        .select(`
          id,
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

      // Query already credited quantities for this invoice (excluding rejected and current editing note)
      const { data: existingCNItems } = await supabase
        .from('credit_note_items')
        .select('sales_invoice_item_id, product_id, batch_id, quantity, credit_notes!inner(id, status)')
        .eq('credit_notes.original_invoice_id', invoiceId)
        .neq('credit_notes.status', 'rejected');

      const returnedByItemId: Record<string, number> = {};
      (existingCNItems || []).forEach((cni: any) => {
        if (editingCreditNoteId && cni.credit_notes?.id === editingCreditNoteId) return;
        const key = cni.sales_invoice_item_id || `${cni.product_id}_${cni.batch_id}`;
        returnedByItemId[key] = (returnedByItemId[key] || 0) + Number(cni.quantity || 0);
      });

      if (data && data.length > 0) {
        const invoiceItems = data.map(item => {
          const batch = normalizeNestedRelation(item.batches);
          const alreadyReturned = returnedByItemId[item.id] || returnedByItemId[`${item.product_id}_${item.batch_id}`] || 0;
          const origQty = Number(item.quantity) || 0;
          const remainingReturnable = Math.max(0, origQty - alreadyReturned);

          return {
            sales_invoice_item_id: item.id,
            product_id: item.product_id,
            batch_id: item.batch_id || '',
            original_invoice_quantity: origQty,
            already_returned_quantity: alreadyReturned,
            remaining_returnable: remainingReturnable,
            quantity: remainingReturnable,
            unit_price: Number(item.unit_price) || 0,
            condition: 'good',
            disposition: formData.stock_disposition || 'saleable',
            batches: batch ? {
              ...batch,
              product_sources: normalizeNestedRelation(batch.product_sources),
            } : null,
            products: normalizeNestedRelation(item.products),
          };
        });
        setItems(invoiceItems);
      }
    } catch (error) {
      console.error('Error loading invoice items:', error);
    }
  };

  const addItem = () => {
    setItems([...items, { product_id: '', batch_id: '', quantity: 0, unit_price: 0, condition: 'good', disposition: formData.stock_disposition }]);
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

  const handleBusinessCaseChange = (bcValue: string) => {
    const bc = BUSINESS_CASES.find(b => b.value === bcValue);
    if (!bc) return;

    setFormData(prev => ({
      ...prev,
      business_case: bc.value,
      credit_note_type: bc.type,
      stock_disposition: bc.defaultDisp,
    }));

    // Update line items disposition to match default
    setItems(prev => prev.map(item => ({
      ...item,
      disposition: bc.defaultDisp,
    })));
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
          id,
          sales_invoice_item_id,
          delivery_challan_item_id,
          product_id,
          batch_id,
          quantity,
          unit_price,
          condition,
          disposition,
          accepted_quantity,
          damaged_quantity,
          rejected_quantity,
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
        credit_note_type: creditNote.credit_note_type || (creditNote.material_return_id ? 'physical_return' : 'physical_return'),
        business_case: creditNote.business_case || 'full_physical_return',
        stock_disposition: creditNote.stock_disposition || 'saleable',
        godown: creditNote.godown || 'Main Warehouse',
      });

      if (creditNote.customer_id) {
        await loadInvoicesForCustomer(creditNote.customer_id);
      }

      if (itemRows && itemRows.length > 0) {
        const loadedItems = itemRows.map((item: any) => {
          const batch = normalizeNestedRelation(item.batches);
          return {
            id: item.id,
            sales_invoice_item_id: item.sales_invoice_item_id,
            product_id: item.product_id,
            batch_id: item.batch_id || '',
            quantity: Number(item.quantity) || 0,
            unit_price: Number(item.unit_price) || 0,
            condition: item.condition || 'good',
            disposition: item.disposition || creditNote.stock_disposition || 'saleable',
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

    // Validate quantity against remaining returnable if invoice is linked
    for (const item of items) {
      if (item.remaining_returnable !== undefined && item.quantity > item.remaining_returnable + 0.0001) {
        showToast({
          type: 'error',
          title: 'Return Limit Exceeded',
          message: `Return quantity (${item.quantity} kg) exceeds remaining returnable quantity (${item.remaining_returnable} kg) for this invoice line.`,
        });
        return;
      }
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
            business_case: formData.business_case || 'full_physical_return',
            stock_disposition: formData.stock_disposition || 'saleable',
            godown: formData.godown || 'Main Warehouse',
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

        const itemsWithCreditNoteId = items.map(({ products: _products, batches: _batches, ...item }) => {
          const itemDisp = item.disposition || formData.stock_disposition || 'saleable';
          return {
            credit_note_id: editingCreditNoteId,
            sales_invoice_item_id: item.sales_invoice_item_id || null,
            delivery_challan_item_id: item.delivery_challan_item_id || null,
            product_id: item.product_id,
            batch_id: item.batch_id,
            quantity: item.quantity,
            unit_price: item.unit_price,
            condition: item.condition || 'good',
            disposition: itemDisp,
            accepted_quantity: itemDisp === 'saleable' ? item.quantity : 0,
            damaged_quantity: ['damaged', 'quarantine', 'scrap'].includes(itemDisp) ? item.quantity : 0,
            rejected_quantity: itemDisp === 'rejected' ? item.quantity : 0,
          };
        });

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
        business_case: formData.business_case || 'full_physical_return',
        stock_disposition: formData.stock_disposition || 'saleable',
        godown: formData.godown || 'Main Warehouse',
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

      const itemsWithCreditNoteId = items.map(({ products: _products, batches: _batches, ...item }) => {
        const itemDisp = item.disposition || formData.stock_disposition || 'saleable';
        return {
          credit_note_id: creditNoteData.id,
          sales_invoice_item_id: item.sales_invoice_item_id || null,
          delivery_challan_item_id: item.delivery_challan_item_id || null,
          product_id: item.product_id,
          batch_id: item.batch_id,
          quantity: item.quantity,
          unit_price: item.unit_price,
          condition: item.condition || 'good',
          disposition: itemDisp,
          accepted_quantity: itemDisp === 'saleable' ? item.quantity : 0,
          damaged_quantity: ['damaged', 'quarantine', 'scrap'].includes(itemDisp) ? item.quantity : 0,
          rejected_quantity: itemDisp === 'rejected' ? item.quantity : 0,
        };
      });

      const { error: itemsError } = await supabase
        .from('credit_note_items')
        .insert(itemsWithCreditNoteId);

      if (itemsError) {
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

    if (!await showConfirm({
      title: 'Approve Credit Note',
      message: 'Approve this credit note? Operational inventory movements, A/R balances, and General Ledger journal entries will be posted.',
      variant: 'warning',
    })) return;

    try {
      const updatePayload: Record<string, any> = {
        status: 'approved',
        approved_by: user?.id,
        approval_date: new Date().toISOString(),
      };

      if (!targetNote?.credit_note_number || targetNote.credit_note_number.trim() === '') {
        const nextNum = await generateNextCreditNoteNumber();
        updatePayload.credit_note_number = nextNum;
      }

      const { error } = await supabase
        .from('credit_notes')
        .update(updatePayload)
        .eq('id', id);

      if (error) throw error;
      showToast({ type: 'success', title: 'Approved', message: 'Credit note approved, General Ledger posted, and inventory reconciled.' });
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

    if (targetNote.nota_retur_id) {
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

  // Settlement Actions
  const handleOpenApplyModal = async (cn: CreditNote) => {
    setTargetCreditNoteForApply(cn);
    setSelectedTargetInvoiceId('');
    setApplyAmount(0);
    setApplyModalOpen(true);
    try {
      const { data, error } = await supabase
        .from('sales_invoices')
        .select('id, invoice_number, invoice_date, total_amount, paid_amount, balance_due, payment_status, notes')
        .eq('customer_id', cn.customer_id)
        .order('invoice_date', { ascending: false });

      if (error) throw error;
      const activeUnpaid = (data || []).filter((inv: any) => {
        if (inv.notes?.includes('[CANCELLED') || inv.notes?.toLowerCase().startsWith('cancelled')) return false;
        const remaining = Number(inv.balance_due ?? (Number(inv.total_amount) - Number(inv.paid_amount || 0)));
        return remaining > 0.01;
      }).map((inv: any) => ({
        ...inv,
        outstanding: Number(inv.balance_due ?? (Number(inv.total_amount) - Number(inv.paid_amount || 0))),
      }));

      setUnpaidInvoices(activeUnpaid);
      if (activeUnpaid.length > 0) {
        setSelectedTargetInvoiceId(activeUnpaid[0].id);
        const maxApply = Math.min(Number(cn.customer_credit_balance || 0), activeUnpaid[0].outstanding);
        setApplyAmount(maxApply);
      }
    } catch (err: any) {
      console.error('Error loading invoices for credit application:', err);
      showToast({ type: 'error', title: 'Error', message: 'Failed to load eligible customer invoices' });
    }
  };

  const handleExecuteApply = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!targetCreditNoteForApply || !selectedTargetInvoiceId || applyAmount <= 0) {
      showToast({ type: 'error', title: 'Validation Error', message: 'Please select an invoice and enter a valid application amount.' });
      return;
    }

    setApplyingCredit(true);
    try {
      const { data: _data, error } = await supabase.rpc('apply_credit_note_to_invoice', {
        p_credit_note_id: targetCreditNoteForApply.id,
        p_target_invoice_id: selectedTargetInvoiceId,
        p_amount: applyAmount,
        p_user_id: user?.id || null,
      });

      if (error) throw error;

      showToast({ type: 'success', title: 'Credit Applied', message: `Rp ${applyAmount.toLocaleString('id-ID')} applied successfully to target invoice.` });
      setApplyModalOpen(false);
      emitErpSync('credit_notes', 'updated', { entityId: targetCreditNoteForApply.id });
      emitErpSync('sales_invoices', 'updated');
      await loadData();
    } catch (err: any) {
      console.error('Error applying credit note:', err);
      showToast({ type: 'error', title: 'Application Failed', message: err.message || 'Failed to apply credit note.' });
    } finally {
      setApplyingCredit(false);
    }
  };

  const handleOpenRefundModal = (cn: CreditNote) => {
    setTargetCreditNoteForRefund(cn);
    setRefundAmount(Number(cn.customer_credit_balance || 0));
    setRefundDate(new Date().toISOString().split('T')[0]);
    setRefundModalOpen(true);
  };

  const handleExecuteRefund = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!targetCreditNoteForRefund || refundAmount <= 0) {
      showToast({ type: 'error', title: 'Validation Error', message: 'Please enter a valid refund amount' });
      return;
    }

    setRefundingCredit(true);
    try {
      const { data: _data, error } = await supabase.rpc('refund_credit_note', {
        p_credit_note_id: targetCreditNoteForRefund.id,
        p_refund_amount: refundAmount,
        p_refund_date: refundDate,
        p_user_id: user?.id || null,
      });

      if (error) throw error;

      showToast({ type: 'success', title: 'Refund Recorded', message: `Customer refund of Rp ${refundAmount.toLocaleString('id-ID')} recorded successfully.` });
      setRefundModalOpen(false);
      emitErpSync('credit_notes', 'updated', { entityId: targetCreditNoteForRefund.id });
      emitErpSync('sales_invoices', 'updated');
      await loadData();
    } catch (err: any) {
      console.error('Error recording refund:', err);
      showToast({ type: 'error', title: 'Refund Failed', message: err.message || 'Failed to record refund.' });
    } finally {
      setRefundingCredit(false);
    }
  };

  const handleOpenNotaReturModal = (cn: CreditNote) => {
    setTargetCreditNoteForNotaRetur(cn);
    setNomorNotaRetur(cn.nota_retur?.nomor_nota_retur || '');
    setTanggalNotaRetur(cn.nota_retur?.tanggal_nota_retur || cn.credit_note_date || new Date().toISOString().split('T')[0]);
    setNotaReturModalOpen(true);
  };

  const handleExecuteNotaRetur = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!targetCreditNoteForNotaRetur) return;

    setGeneratingNotaRetur(true);
    try {
      const { data: _data, error } = await supabase.rpc('link_or_generate_nota_retur_for_credit_note', {
        p_credit_note_id: targetCreditNoteForNotaRetur.id,
        p_nomor_nota_retur: nomorNotaRetur.trim() || null,
        p_tanggal_nota_retur: tanggalNotaRetur,
        p_user_id: user?.id || null,
      });

      if (error) throw error;

      showToast({ type: 'success', title: 'Nota Retur Registered', message: 'Coretax Nota Retur tax document registered/linked successfully.' });
      setNotaReturModalOpen(false);
      emitErpSync('credit_notes', 'updated', { entityId: targetCreditNoteForNotaRetur.id });
      await loadData();
    } catch (err: any) {
      console.error('Error registering Nota Retur:', err);
      showToast({ type: 'error', title: 'Registration Failed', message: err.message || 'Failed to register Nota Retur.' });
    } finally {
      setGeneratingNotaRetur(false);
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
      business_case: 'full_physical_return',
      stock_disposition: 'saleable',
      godown: 'Main Warehouse',
    });
    setItems([{ product_id: '', batch_id: '', quantity: 0, unit_price: 0, condition: 'good', disposition: 'saleable' }]);
  };

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
        business_case: 'full_physical_return',
        stock_disposition: 'saleable',
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
      render: (_value: any, cn: CreditNote) => cn.credit_note_number?.trim() ? (
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
      render: (_value: any, cn: CreditNote) => formatDate(cn.credit_note_date)
    },
    {
      key: 'customer',
      label: 'Customer',
      render: (_value: any, cn: CreditNote) => {
        const customer = normalizeNestedRelation(cn.customers);
        return customer?.company_name || 'N/A';
      }
    },
    {
      key: 'original_invoice_number',
      label: 'Original Invoice',
      render: (_value: any, cn: CreditNote) => {
        const invoice = normalizeNestedRelation(cn.sales_invoices);
        const invNum = cn.original_invoice_number || invoice?.invoice_number;
        return invNum ? (
          <span className="font-mono text-xs font-semibold text-gray-800">{invNum}</span>
        ) : (
          <span className="text-gray-400 italic">None</span>
        );
      }
    },
    {
      key: 'business_case',
      label: 'Business Case / Disposition',
      render: (_value: any, cn: CreditNote) => {
        const bc = BUSINESS_CASES.find(b => b.value === cn.business_case);
        const disp = cn.stock_disposition || 'saleable';
        return (
          <div className="flex flex-col gap-1 text-xs">
            <span className="font-medium text-gray-900">{bc?.label || cn.business_case || 'Standard Return'}</span>
            <div className="flex items-center gap-1">
              <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase ${
                cn.credit_note_type === 'commercial_credit'
                  ? 'bg-blue-100 text-blue-800'
                  : 'bg-emerald-100 text-emerald-800'
              }`}>
                {cn.credit_note_type === 'commercial_credit' ? 'Commercial' : 'Physical'}
              </span>
              {cn.credit_note_type !== 'commercial_credit' && (
                <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-medium ${
                  disp === 'saleable' ? 'bg-teal-50 text-teal-700 border border-teal-200' :
                  disp === 'quarantine' ? 'bg-amber-50 text-amber-700 border border-amber-200' :
                  disp === 'damaged' || disp === 'scrap' ? 'bg-rose-50 text-rose-700 border border-rose-200' :
                  'bg-gray-100 text-gray-700'
                }`}>
                  {disp}
                </span>
              )}
            </div>
          </div>
        );
      }
    },
    {
      key: 'total_amount',
      label: 'Amount',
      render: (_value: any, cn: CreditNote) => (
        <span className="font-semibold text-gray-900">
          {cn.currency} {cn.total_amount.toLocaleString('id-ID', { minimumFractionDigits: 2 })}
        </span>
      )
    },
    {
      key: 'status',
      label: 'Status',
      render: (_value: any, cn: CreditNote) => (
        <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-semibold ${
          cn.status === 'approved' ? 'bg-emerald-100 text-emerald-800' :
          cn.status === 'rejected' ? 'bg-red-100 text-red-800' :
          'bg-amber-100 text-amber-800'
        }`}>
          {cn.status?.replace('_', ' ') || 'pending approval'}
        </span>
      )
    },
    {
      key: 'settlement',
      label: 'Settlement / A/R',
      render: (_value: any, cn: CreditNote) => {
        if (cn.status !== 'approved') {
          return <span className="text-gray-400 text-xs italic">—</span>;
        }

        const balance = Number(cn.customer_credit_balance || 0);
        const status = cn.settlement_status || (balance > 0.01 ? 'unsettled' : 'settled');

        if (balance > 0.01) {
          return (
            <div className="flex flex-col gap-1 items-start">
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-semibold bg-amber-100 text-amber-900 border border-amber-200">
                Credit Bal: Rp {balance.toLocaleString('id-ID')}
              </span>
              <div className="flex items-center gap-1 mt-0.5">
                <button
                  onClick={() => handleOpenApplyModal(cn)}
                  className="text-[10px] bg-indigo-50 text-indigo-700 hover:bg-indigo-100 px-1.5 py-0.5 rounded font-semibold border border-indigo-200 transition"
                  title="Apply credit to another invoice"
                >
                  Apply
                </button>
                <button
                  onClick={() => handleOpenRefundModal(cn)}
                  className="text-[10px] bg-rose-50 text-rose-700 hover:bg-rose-100 px-1.5 py-0.5 rounded font-semibold border border-rose-200 transition"
                  title="Record customer refund"
                >
                  Refund
                </button>
              </div>
            </div>
          );
        }

        if (status === 'refunded') {
          return (
            <span className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded bg-purple-50 text-purple-700 border border-purple-200 font-medium">
              Refunded
            </span>
          );
        }

        return (
          <span className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200 font-medium">
            Settled (A/R Reduced)
          </span>
        );
      }
    },
    {
      key: 'accounting_tax',
      label: 'GL & Tax Nota Retur',
      render: (_value: any, cn: CreditNote) => {
        const glEntry = cn.journal_entries?.entry_number;
        const notaReturNum = cn.nota_retur?.nomor_nota_retur;

        return (
          <div className="flex flex-col gap-1 text-xs">
            {glEntry ? (
              <span className="inline-flex items-center gap-1 text-[11px] font-mono text-emerald-700 font-medium">
                <BookOpen className="w-3 h-3 text-emerald-600" />
                {glEntry}
              </span>
            ) : cn.status === 'approved' ? (
              <span className="text-[10px] text-gray-400 italic">No GL posted</span>
            ) : null}

            {notaReturNum ? (
              <span className="inline-flex items-center gap-1 text-[11px] font-mono text-indigo-700 font-medium">
                <ShieldCheck className="w-3 h-3 text-indigo-600" />
                {notaReturNum}
              </span>
            ) : cn.status === 'approved' && cn.tax_amount > 0 ? (
              <button
                onClick={() => handleOpenNotaReturModal(cn)}
                className="inline-flex items-center gap-1 text-[10px] text-amber-700 hover:text-amber-900 font-medium underline"
                title="Link or generate DJP Coretax Nota Retur"
              >
                + Nota Retur
              </button>
            ) : null}
          </div>
        );
      }
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
            <p className="text-xs text-gray-500 mt-0.5">End-to-end sales returns, commercial credits, warehouse dispositions, and DJP Coretax accounting</p>
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

        <div className="bg-blue-50 border border-blue-200 rounded-lg p-3.5 flex gap-3 text-xs text-blue-900">
          <AlertCircle className="w-4 h-4 text-blue-600 flex-shrink-0 mt-0.5" />
          <div className="space-y-1">
            <p className="font-semibold text-blue-950">SAPJ ERP Credit Note & Sales Return Framework:</p>
            <p>
              Supports all 9 commercial & operational return cases. Automatically posts exact historical FIFO COGS reversals for recoverable stock, registers impairment losses (account 5190) for damaged/scrap items, updates customer A/R balances, tracks customer credit balances for paid invoices, and maintains Indonesian Coretax electronic Nota Retur compliance.
            </p>
          </div>
        </div>

        {/* Filter bar */}
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
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => handleViewCreditNote(creditNote)}
                className="p-1 text-blue-600 hover:bg-blue-50 rounded"
                title="View Full Impact & Journal Breakdown"
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

              {creditNote.status === 'approved' && Number(creditNote.customer_credit_balance || 0) > 0.01 && (
                <>
                  <button
                    onClick={() => handleOpenApplyModal(creditNote)}
                    className="p-1 text-indigo-600 hover:bg-indigo-50 rounded"
                    title="Apply Credit Balance to Another Invoice"
                  >
                    <ArrowRight className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => handleOpenRefundModal(creditNote)}
                    className="p-1 text-purple-600 hover:bg-purple-50 rounded"
                    title="Issue Cash/Bank Refund"
                  >
                    <DollarSign className="w-4 h-4" />
                  </button>
                </>
              )}

              {creditNote.status === 'approved' && !creditNote.nota_retur_id && creditNote.tax_amount > 0 && (
                <button
                  onClick={() => handleOpenNotaReturModal(creditNote)}
                  className="p-1 text-amber-600 hover:bg-amber-50 rounded"
                  title="Generate or Link Coretax Nota Retur"
                >
                  <ShieldCheck className="w-4 h-4" />
                </button>
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

        {/* Modal Create / Edit */}
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

              <FloatingField label="Original Sales Invoice (Optional)" span={6} filled={!!formData.original_invoice_id}>
                <select
                  name="original_invoice_optional"
                  aria-label="Original Invoice (Optional)"
                  value={formData.original_invoice_id}
                  onChange={(e) => handleInvoiceChange(e.target.value)}
                  disabled={!formData.customer_id}
                  className={FLOAT_INPUT}
                >
                  <option value="">— Select Invoice (Optional) —</option>
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
                <p className="text-xs text-purple-700 font-medium mb-2">
                  Link to approved warehouse Material Return receipt:
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
              <FloatingField label="Commercial / Operational Business Case" required span={6} filled={!!formData.business_case}>
                <select
                  name="business_case"
                  aria-label="Business Case"
                  value={formData.business_case}
                  onChange={(e) => handleBusinessCaseChange(e.target.value)}
                  className={FLOAT_INPUT}
                >
                  {BUSINESS_CASES.map(bc => (
                    <option key={bc.value} value={bc.value}>
                      {bc.label}
                    </option>
                  ))}
                </select>
              </FloatingField>

              <FloatingField label="Stock Disposition" required span={6} filled={!!formData.stock_disposition} hint={formData.credit_note_type === 'commercial_credit' ? 'Commercial credits do not affect inventory' : undefined}>
                <select
                  name="stock_disposition"
                  aria-label="Stock Disposition"
                  value={formData.stock_disposition}
                  onChange={(e) => {
                    const disp = e.target.value;
                    setFormData(prev => ({ ...prev, stock_disposition: disp }));
                    setItems(prev => prev.map(item => ({ ...item, disposition: disp })));
                  }}
                  disabled={formData.credit_note_type === 'commercial_credit'}
                  className={FLOAT_INPUT}
                >
                  {STOCK_DISPOSITIONS.map(disp => (
                    <option key={disp.value} value={disp.value}>
                      {disp.label}
                    </option>
                  ))}
                </select>
              </FloatingField>
            </SapRow>

            <SapRow>
              <FloatingField label="Godown / Warehouse" span={6} filled={!!formData.godown}>
                <input
                  name="godown"
                  aria-label="Godown / Warehouse"
                  type="text"
                  value={formData.godown}
                  onChange={(e) => setFormData({ ...formData, godown: e.target.value })}
                  placeholder="Main Warehouse"
                  className={FLOAT_INPUT}
                />
              </FloatingField>

              <FloatingField label="Currency" span={6} filled={!!formData.currency}>
                <select
                  name="currency"
                  aria-label="Currency"
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
                <textarea
                  name="reason_for_credit_note"
                  aria-label="Reason for Credit Note"
                  value={formData.reason}
                  onChange={(e) => setFormData({ ...formData, reason: e.target.value })}
                  required
                  rows={2}
                  placeholder="e.g., Goods returned due to quality issue, commercial discount, or damaged packaging"
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
                    className="text-xs text-red-600 hover:text-red-700 font-semibold flex items-center gap-1"
                  >
                    <Plus className="w-3.5 h-3.5" /> Add Item
                  </button>
                )}
              </div>

              <div className="space-y-3">
                {items.map((item, index) => {
                  const selectedBatch = batches.find(batch => batch.id === item.batch_id) || item.batches;
                  const makeName = selectedBatch?.product_sources?.supplier_name || 'Not recorded';

                  return (
                    <div key={index} className="p-3 border border-gray-200 rounded-lg space-y-2 bg-gray-50/50">
                      {item.remaining_returnable !== undefined && (
                        <div className="flex items-center justify-between text-xs bg-white px-2.5 py-1.5 rounded border border-gray-200 mb-2 font-mono">
                          <span className="text-gray-600">
                            Invoiced: <strong className="text-gray-900">{item.original_invoice_quantity} kg</strong>
                          </span>
                          <span className="text-amber-700">
                            Already Credited: <strong>{item.already_returned_quantity} kg</strong>
                          </span>
                          <span className="text-emerald-700 font-semibold">
                            Remaining Returnable: {item.remaining_returnable} kg
                          </span>
                        </div>
                      )}

                      <SapRow>
                        <FloatingField label="Product" required span={6} filled={!!item.product_id}>
                          <select
                            name="product_id"
                            aria-label="Product Id"
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
                          <select
                            name="batch_id"
                            aria-label="Batch Id"
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
                      </SapRow>

                      <SapRow>
                        <FloatingField label="Quantity (Kg)" required span={3} filled={!!item.quantity}>
                          <input
                            name="quantity_kg"
                            aria-label="Quantity (Kg)"
                            type="number"
                            step="0.001"
                            placeholder="Qty in Kg"
                            value={item.quantity || ''}
                            onChange={(e) => updateItem(index, 'quantity', parseFloat(e.target.value) || 0)}
                            required
                            min="0.001"
                            max={item.remaining_returnable !== undefined ? item.remaining_returnable : undefined}
                            className={FLOAT_INPUT}
                          />
                        </FloatingField>

                        <FloatingField label="Unit Price (per Kg)" required span={3} filled={!!item.unit_price}>
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

                        <FloatingField label="Condition" span={3} filled={!!item.condition}>
                          <select
                            name="item_condition"
                            aria-label="Item Condition"
                            value={item.condition || 'good'}
                            onChange={(e) => updateItem(index, 'condition', e.target.value)}
                            className={FLOAT_INPUT}
                          >
                            {ITEM_CONDITIONS.map(cond => (
                              <option key={cond.value} value={cond.value}>{cond.label}</option>
                            ))}
                          </select>
                        </FloatingField>

                        <FloatingField label="Disposition" span={3} filled={!!item.disposition}>
                          <select
                            name="item_disposition"
                            aria-label="Item Disposition"
                            value={item.disposition || formData.stock_disposition || 'saleable'}
                            onChange={(e) => updateItem(index, 'disposition', e.target.value)}
                            disabled={formData.credit_note_type === 'commercial_credit'}
                            className={FLOAT_INPUT}
                          >
                            {STOCK_DISPOSITIONS.map(disp => (
                              <option key={disp.value} value={disp.value}>{disp.label.split(' ')[0]}</option>
                            ))}
                          </select>
                        </FloatingField>
                      </SapRow>

                      <div className="flex items-center justify-between text-xs pt-1 border-t border-gray-200">
                        <span className="text-gray-600 font-medium">
                          Line Total: <strong className="text-gray-900 font-mono">{formData.currency} {(item.quantity * item.unit_price).toLocaleString('id-ID', { minimumFractionDigits: 2 })}</strong>
                        </span>
                        {items.length > 1 && !formData.original_invoice_id && (
                          <button
                            type="button"
                            onClick={() => removeItem(index)}
                            className="text-red-600 hover:text-red-800 text-xs flex items-center gap-1"
                          >
                            <Trash2 className="w-3.5 h-3.5" /> Remove Line
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="border-t pt-3 bg-gray-50 p-3 rounded-lg space-y-1.5 text-xs">
              <div className="flex justify-between text-gray-600">
                <span>Subtotal (Goods / Concession):</span>
                <span className="font-mono font-medium">{formData.currency} {totals.subtotal.toLocaleString('id-ID', { minimumFractionDigits: 2 })}</span>
              </div>
              <div className="flex justify-between text-gray-600">
                <span>PPN 11% (DJP Nota Retur Reduction):</span>
                <span className="font-mono font-medium">{formData.currency} {totals.tax_amount.toLocaleString('id-ID', { minimumFractionDigits: 2 })}</span>
              </div>
              <div className="flex justify-between text-sm font-bold border-t pt-2 text-gray-900">
                <span>Total Credit Value:</span>
                <span className="text-red-600 font-mono text-base">{formData.currency} {totals.total_amount.toLocaleString('id-ID', { minimumFractionDigits: 2 })}</span>
              </div>
            </div>

            <SapRow>
              <FloatingField label="Additional Notes" span={12} textarea filled={!!formData.notes}>
                <textarea
                  name="additional_notes"
                  aria-label="Additional Notes"
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
                className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 transition text-xs font-semibold"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isSubmitting}
                className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition disabled:opacity-50 flex items-center gap-2 text-xs font-semibold"
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

        {/* Modal: Apply Credit to Invoice */}
        <Modal
          isOpen={applyModalOpen}
          onClose={() => {
            setApplyModalOpen(false);
            setTargetCreditNoteForApply(null);
          }}
          title="Apply Customer Credit Balance to Sales Invoice"
        >
          <form onSubmit={handleExecuteApply} className="space-y-4 text-xs">
            {targetCreditNoteForApply && (
              <div className="bg-indigo-50 border border-indigo-200 rounded-lg p-3 text-indigo-900 space-y-1">
                <div className="flex justify-between">
                  <span className="font-semibold">Credit Note:</span>
                  <span className="font-mono font-bold">{targetCreditNoteForApply.credit_note_number}</span>
                </div>
                <div className="flex justify-between">
                  <span>Available Credit Balance:</span>
                  <span className="font-mono font-bold text-indigo-700">
                    Rp {Number(targetCreditNoteForApply.customer_credit_balance || 0).toLocaleString('id-ID')}
                  </span>
                </div>
              </div>
            )}

            <div>
              <label className="block text-gray-700 font-semibold mb-1">Target Sales Invoice to Offset:</label>
              {unpaidInvoices.length === 0 ? (
                <p className="text-gray-500 italic p-2 bg-gray-50 rounded border">No outstanding unpaid invoices found for this customer.</p>
              ) : (
                <select
                  value={selectedTargetInvoiceId}
                  onChange={(e) => {
                    const invId = e.target.value;
                    setSelectedTargetInvoiceId(invId);
                    const inv = unpaidInvoices.find(i => i.id === invId);
                    if (inv && targetCreditNoteForApply) {
                      setApplyAmount(Math.min(Number(targetCreditNoteForApply.customer_credit_balance || 0), inv.outstanding));
                    }
                  }}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg bg-white"
                  required
                >
                  {unpaidInvoices.map((inv) => (
                    <option key={inv.id} value={inv.id}>
                      {inv.invoice_number} ({formatDate(inv.invoice_date)}) — Outstanding: Rp {inv.outstanding.toLocaleString('id-ID')}
                    </option>
                  ))}
                </select>
              )}
            </div>

            <div>
              <label className="block text-gray-700 font-semibold mb-1">Amount to Apply (Rp):</label>
              <MoneyInput
                value={applyAmount}
                onChange={(amt) => setApplyAmount(amt)}
                max={targetCreditNoteForApply ? Number(targetCreditNoteForApply.customer_credit_balance || 0) : undefined}
                required
                className="w-full px-3 py-2 border border-gray-300 rounded-lg font-mono text-sm"
              />
            </div>

            <div className="flex justify-end gap-2.5 pt-4 border-t">
              <button
                type="button"
                onClick={() => setApplyModalOpen(false)}
                className="px-3.5 py-1.5 border border-gray-300 rounded-lg hover:bg-gray-50 transition font-semibold"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={applyingCredit || unpaidInvoices.length === 0 || applyAmount <= 0}
                className="px-4 py-1.5 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition disabled:opacity-50 font-semibold flex items-center gap-1.5"
              >
                {applyingCredit ? 'Applying...' : 'Apply Credit to Invoice'}
              </button>
            </div>
          </form>
        </Modal>

        {/* Modal: Refund Credit Note */}
        <Modal
          isOpen={refundModalOpen}
          onClose={() => {
            setRefundModalOpen(false);
            setTargetCreditNoteForRefund(null);
          }}
          title="Process Customer Refund"
        >
          <form onSubmit={handleExecuteRefund} className="space-y-4 text-xs">
            {targetCreditNoteForRefund && (
              <div className="bg-rose-50 border border-rose-200 rounded-lg p-3 text-rose-900 space-y-1">
                <div className="flex justify-between">
                  <span className="font-semibold">Credit Note:</span>
                  <span className="font-mono font-bold">{targetCreditNoteForRefund.credit_note_number}</span>
                </div>
                <div className="flex justify-between">
                  <span>Available Credit Balance:</span>
                  <span className="font-mono font-bold text-rose-700">
                    Rp {Number(targetCreditNoteForRefund.customer_credit_balance || 0).toLocaleString('id-ID')}
                  </span>
                </div>
              </div>
            )}

            <div>
              <label className="block text-gray-700 font-semibold mb-1">Refund Amount (Rp):</label>
              <MoneyInput
                value={refundAmount}
                onChange={(amt) => setRefundAmount(amt)}
                max={targetCreditNoteForRefund ? Number(targetCreditNoteForRefund.customer_credit_balance || 0) : undefined}
                required
                className="w-full px-3 py-2 border border-gray-300 rounded-lg font-mono text-sm"
              />
            </div>

            <div>
              <label className="block text-gray-700 font-semibold mb-1">Refund Date:</label>
              <input
                type="date"
                value={refundDate}
                onChange={(e) => setRefundDate(e.target.value)}
                required
                className="w-full px-3 py-2 border border-gray-300 rounded-lg bg-white"
              />
            </div>

            <div className="flex justify-end gap-2.5 pt-4 border-t">
              <button
                type="button"
                onClick={() => setRefundModalOpen(false)}
                className="px-3.5 py-1.5 border border-gray-300 rounded-lg hover:bg-gray-50 transition font-semibold"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={refundingCredit || refundAmount <= 0}
                className="px-4 py-1.5 bg-rose-600 text-white rounded-lg hover:bg-rose-700 transition disabled:opacity-50 font-semibold flex items-center gap-1.5"
              >
                {refundingCredit ? 'Processing...' : 'Record Refund'}
              </button>
            </div>
          </form>
        </Modal>

        {/* Modal: Link or Generate Nota Retur */}
        <Modal
          isOpen={notaReturModalOpen}
          onClose={() => {
            setNotaReturModalOpen(false);
            setTargetCreditNoteForNotaRetur(null);
          }}
          title="Indonesian DJP Coretax Nota Retur Registration"
        >
          <form onSubmit={handleExecuteNotaRetur} className="space-y-4 text-xs">
            {targetCreditNoteForNotaRetur && (
              <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-amber-900 space-y-1">
                <div className="flex justify-between">
                  <span className="font-semibold">Credit Note:</span>
                  <span className="font-mono font-bold">{targetCreditNoteForNotaRetur.credit_note_number}</span>
                </div>
                <div className="flex justify-between">
                  <span>Output PPN Tax Being Reduced:</span>
                  <span className="font-mono font-bold text-amber-700">
                    Rp {Number(targetCreditNoteForNotaRetur.tax_amount || 0).toLocaleString('id-ID')}
                  </span>
                </div>
              </div>
            )}

            <div>
              <label className="block text-gray-700 font-semibold mb-1">Nomor Nota Retur (Leave blank to auto-generate):</label>
              <input
                type="text"
                placeholder="Auto-generated e.g. NR-2026-0001"
                value={nomorNotaRetur}
                onChange={(e) => setNomorNotaRetur(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg bg-white font-mono"
              />
            </div>

            <div>
              <label className="block text-gray-700 font-semibold mb-1">Tanggal Nota Retur:</label>
              <input
                type="date"
                value={tanggalNotaRetur}
                onChange={(e) => setTanggalNotaRetur(e.target.value)}
                required
                className="w-full px-3 py-2 border border-gray-300 rounded-lg bg-white"
              />
            </div>

            <div className="flex justify-end gap-2.5 pt-4 border-t">
              <button
                type="button"
                onClick={() => setNotaReturModalOpen(false)}
                className="px-3.5 py-1.5 border border-gray-300 rounded-lg hover:bg-gray-50 transition font-semibold"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={generatingNotaRetur}
                className="px-4 py-1.5 bg-amber-600 text-white rounded-lg hover:bg-amber-700 transition disabled:opacity-50 font-semibold flex items-center gap-1.5"
              >
                {generatingNotaRetur ? 'Registering...' : 'Register Nota Retur'}
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
