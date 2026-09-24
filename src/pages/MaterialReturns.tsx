import React, { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { useLanguage } from '../contexts/LanguageContext';
import { useNavigation } from '../contexts/NavigationContext';
import { Plus, Eye, Trash2, PackageX, AlertTriangle, Edit, CheckCircle, XCircle, FileText, ArrowRight, RefreshCw } from 'lucide-react';
import { showToast } from '../components/ToastNotification';
import { showConfirm } from '../components/ConfirmDialog';
import { Modal } from '../components/Modal';
import { SearchableSelect } from '../components/SearchableSelect';
import { DataTable } from '../components/DataTable';
import { MaterialReturnView } from '../components/MaterialReturnView';
import { formatDate } from '../utils/dateFormat';

interface MaterialReturn {
  id: string;
  return_number: string;
  return_date: string;
  return_type: string;
  return_reason: string;
  status: string;
  customer_id: string;
  original_dc_id?: string | null;
  original_invoice_id?: string | null;
  credit_note_issued?: boolean;
  credit_note_number?: string | null;
  credit_note_amount?: number | null;
  notes?: string | null;
  financial_impact?: number;
  restocked?: boolean;
  customers: {
    company_name: string;
  };
  delivery_challans?: {
    challan_number: string;
  } | null;
  sales_invoices?: {
    invoice_number: string;
  } | null;
}

interface ReturnItem {
  product_id: string;
  batch_id: string | null;
  quantity_returned: number;
  original_quantity: number;
  unit_price: number;
  condition: string;
  disposition: string;
  notes?: string;
  product_name?: string;
  product_code?: string;
  batch_number?: string;
}

interface SourceItem {
  product_id: string;
  batch_id: string;
  quantity: number;
  unit_price: number;
  products: {
    product_name: string;
    product_code: string;
  };
  batches: {
    batch_number: string;
  };
}

interface Customer {
  id: string;
  company_name: string;
}

interface DeliveryChallan {
  id: string;
  challan_number: string;
  challan_date: string;
  customer_id: string;
}

interface SalesInvoice {
  id: string;
  invoice_number: string;
  invoice_date: string;
  total_amount: number;
  customer_id: string;
}

export default function MaterialReturns() {
  const { user, profile } = useAuth();
  const { t } = useLanguage();
  const { setCurrentPage } = useNavigation();
  const [returns, setReturns] = useState<MaterialReturn[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [viewModalOpen, setViewModalOpen] = useState(false);
  const [selectedReturn, setSelectedReturn] = useState<any>(null);
  const [selectedReturnItems, setSelectedReturnItems] = useState<any[]>([]);
  const [editMode, setEditMode] = useState(false);
  const [editingReturnId, setEditingReturnId] = useState<string | null>(null);

  const [customers, setCustomers] = useState<Customer[]>([]);
  const [sourceType, setSourceType] = useState<'delivery_challan' | 'sales_invoice'>('delivery_challan');
  const [deliveryChallans, setDeliveryChallans] = useState<DeliveryChallan[]>([]);
  const [salesInvoices, setSalesInvoices] = useState<SalesInvoice[]>([]);
  const [sourceItems, setSourceItems] = useState<SourceItem[]>([]);
  const [returnItems, setReturnItems] = useState<ReturnItem[]>([]);

  const [formData, setFormData] = useState({
    customer_id: '',
    original_dc_id: '',
    original_invoice_id: '',
    return_date: new Date().toISOString().split('T')[0],
    return_type: 'quality_issue',
    return_reason: '',
    notes: '',
  });

  useEffect(() => {
    loadReturns();
    loadCustomers();
  }, []);

  const loadReturns = async () => {
    try {
      const { data, error } = await supabase
        .from('material_returns')
        .select(`
          *,
          customers(company_name, address, city, phone),
          delivery_challans(challan_number),
          sales_invoices(invoice_number)
        `)
        .order('created_at', { ascending: false });

      if (error) throw error;
      setReturns(data || []);
    } catch (error) {
      console.error('Error loading returns:', error);
    } finally {
      setLoading(false);
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

  const loadDeliveryChallans = async (customerId: string) => {
    try {
      const { data, error } = await supabase
        .from('delivery_challans')
        .select('id, challan_number, challan_date, customer_id')
        .eq('customer_id', customerId)
        .order('challan_date', { ascending: false });

      if (error) throw error;
      setDeliveryChallans(data || []);
    } catch (error) {
      console.error('Error loading delivery challans:', error);
    }
  };

  const loadSalesInvoices = async (customerId: string) => {
    try {
      const { data, error } = await supabase
        .from('sales_invoices')
        .select('id, invoice_number, invoice_date, total_amount, customer_id')
        .eq('customer_id', customerId)
        .order('invoice_date', { ascending: false });

      if (error) throw error;
      setSalesInvoices(data || []);
    } catch (error) {
      console.error('Error loading sales invoices:', error);
    }
  };

  const loadChallanItems = async (challanId: string) => {
    try {
      const { data, error } = await supabase
        .from('delivery_challan_items')
        .select(`
          product_id,
          batch_id,
          quantity,
          products(product_name, product_code),
          batches(batch_number, import_price, duty_charges, freight_charges, other_charges, import_quantity)
        `)
        .eq('challan_id', challanId);

      if (error) throw error;

      const normalizedItems: SourceItem[] = (data || []).map((item: any) => {
        const batch = Array.isArray(item.batches) ? item.batches[0] : item.batches;
        let unitPrice = 0;
        if (batch && batch.import_quantity > 0) {
          unitPrice = Math.round(
            (batch.import_price + batch.duty_charges + batch.freight_charges + batch.other_charges) /
            batch.import_quantity * 1.25
          );
        }
        return {
          product_id: item.product_id,
          batch_id: item.batch_id,
          quantity: item.quantity,
          unit_price: unitPrice,
          products: Array.isArray(item.products) ? item.products[0] : item.products,
          batches: batch,
        };
      });

      setSourceItems(normalizedItems);

      const items: ReturnItem[] = normalizedItems.map((item) => ({
        product_id: item.product_id,
        batch_id: item.batch_id,
        quantity_returned: 0,
        original_quantity: item.quantity,
        unit_price: item.unit_price,
        condition: 'good',
        disposition: 'restock',
        notes: '',
        product_name: item.products?.product_name,
        product_code: item.products?.product_code,
        batch_number: item.batches?.batch_number,
      }));

      setReturnItems(items);
    } catch (error) {
      console.error('Error loading challan items:', error);
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
          batches(batch_number)
        `)
        .eq('invoice_id', invoiceId);

      if (error) throw error;

      const normalizedItems: SourceItem[] = (data || []).map((item: any) => ({
        product_id: item.product_id,
        batch_id: item.batch_id,
        quantity: item.quantity,
        unit_price: item.unit_price,
        products: Array.isArray(item.products) ? item.products[0] : item.products,
        batches: Array.isArray(item.batches) ? item.batches[0] : item.batches,
      }));

      setSourceItems(normalizedItems);

      const items: ReturnItem[] = normalizedItems.map((item) => ({
        product_id: item.product_id,
        batch_id: item.batch_id,
        quantity_returned: 0,
        original_quantity: item.quantity,
        unit_price: item.unit_price,
        condition: 'good',
        disposition: 'restock',
        notes: '',
        product_name: item.products?.product_name,
        product_code: item.products?.product_code,
        batch_number: item.batches?.batch_number,
      }));

      setReturnItems(items);
    } catch (error) {
      console.error('Error loading invoice items:', error);
    }
  };

  const handleCustomerChange = (customerId: string) => {
    setFormData({ ...formData, customer_id: customerId, original_dc_id: '', original_invoice_id: '' });
    setSourceItems([]);
    setReturnItems([]);
    if (customerId) {
      loadDeliveryChallans(customerId);
      loadSalesInvoices(customerId);
    } else {
      setDeliveryChallans([]);
      setSalesInvoices([]);
    }
  };

  const handleSourceTypeToggle = (type: 'delivery_challan' | 'sales_invoice') => {
    setSourceType(type);
    setFormData({ ...formData, original_dc_id: '', original_invoice_id: '' });
    setSourceItems([]);
    setReturnItems([]);
  };

  const handleChallanChange = (challanId: string) => {
    setFormData({ ...formData, original_dc_id: challanId, original_invoice_id: '' });
    if (challanId) {
      loadChallanItems(challanId);
    } else {
      setSourceItems([]);
      setReturnItems([]);
    }
  };

  const handleInvoiceChange = (invoiceId: string) => {
    setFormData({ ...formData, original_invoice_id: invoiceId, original_dc_id: '' });
    if (invoiceId) {
      loadInvoiceItems(invoiceId);
    } else {
      setSourceItems([]);
      setReturnItems([]);
    }
  };

  const updateReturnItem = (index: number, field: keyof ReturnItem, value: any) => {
    const updated = [...returnItems];
    updated[index] = { ...updated[index], [field]: value };
    setReturnItems(updated);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    const hasSourceDoc = sourceType === 'delivery_challan' ? !!formData.original_dc_id : !!formData.original_invoice_id;
    if (!formData.customer_id || !hasSourceDoc || !formData.return_reason) {
      showToast({ type: 'error', title: 'Error', message: 'Please complete all required fields' });
      return;
    }

    const validItems = returnItems.filter(item => item.quantity_returned > 0);
    if (validItems.length === 0) {
      showToast({ type: 'error', title: 'Error', message: 'Please enter at least one item with return quantity' });
      return;
    }

    const hasInvalidQuantities = validItems.some(
      item => item.quantity_returned > item.original_quantity
    );
    if (hasInvalidQuantities) {
      showToast({ type: 'error', title: 'Error', message: 'Return quantity cannot exceed original shipped quantity' });
      return;
    }

    try {
      const financialImpact = validItems.reduce((sum, item) =>
        sum + (item.quantity_returned * item.unit_price), 0
      );

      const payload = {
        customer_id: formData.customer_id,
        original_dc_id: sourceType === 'delivery_challan' ? formData.original_dc_id : null,
        original_invoice_id: sourceType === 'sales_invoice' ? formData.original_invoice_id : null,
        return_date: formData.return_date,
        return_type: formData.return_type,
        return_reason: formData.return_reason,
        notes: formData.notes,
        financial_impact: financialImpact,
      };

      if (editMode && editingReturnId) {
        const { error: returnError } = await supabase
          .from('material_returns')
          .update(payload)
          .eq('id', editingReturnId)
          .eq('status', 'pending_approval');

        if (returnError) throw returnError;

        const { error: deleteError } = await supabase
          .from('material_return_items')
          .delete()
          .eq('return_id', editingReturnId);

        if (deleteError) throw deleteError;

        const itemsToInsert = validItems.map(item => ({
          return_id: editingReturnId,
          product_id: item.product_id,
          batch_id: item.batch_id,
          quantity_returned: item.quantity_returned,
          original_quantity: item.original_quantity,
          unit_price: item.unit_price,
          condition: item.condition,
          disposition: item.disposition,
          notes: item.notes,
        }));

        const { error: itemsError } = await supabase
          .from('material_return_items')
          .insert(itemsToInsert);

        if (itemsError) throw itemsError;

        showToast({ type: 'success', title: 'Success', message: 'Material return updated successfully.' });
      } else {
        const { data: returnData, error: returnError} = await supabase
          .from('material_returns')
          .insert({
            ...payload,
            status: 'pending_approval',
            created_by: user?.id,
          })
          .select()
          .single();

        if (returnError) throw returnError;

        const itemsToInsert = validItems.map(item => ({
          return_id: returnData.id,
          product_id: item.product_id,
          batch_id: item.batch_id,
          quantity_returned: item.quantity_returned,
          original_quantity: item.original_quantity,
          unit_price: item.unit_price,
          condition: item.condition,
          disposition: item.disposition,
          notes: item.notes,
        }));

        const { error: itemsError } = await supabase
          .from('material_return_items')
          .insert(itemsToInsert);

        if (itemsError) throw itemsError;

        showToast({ type: 'success', title: 'Success', message: 'Material return created successfully. Pending approval.' });
      }

      setModalOpen(false);
      resetForm();
      loadReturns();
    } catch (error: any) {
      console.error('Error saving return:', error);
      showToast({ type: 'error', title: 'Error', message: error.message || 'Failed to save material return' });
    }
  };

  const handleView = async (materialReturn: MaterialReturn) => {
    try {
      const { data, error } = await supabase
        .from('material_return_items')
        .select(`
          *,
          products(product_name, product_code),
          batches(batch_number)
        `)
        .eq('return_id', materialReturn.id);

      if (error) throw error;

      setSelectedReturn(materialReturn);
      setSelectedReturnItems(data || []);
      setViewModalOpen(true);
    } catch (error) {
      console.error('Error loading return items:', error);
      showToast({ type: 'error', title: 'Error', message: 'Failed to load return details' });
    }
  };

  const handleEdit = async (materialReturn: MaterialReturn) => {
    try {
      const { data: itemsData, error: itemsError } = await supabase
        .from('material_return_items')
        .select(`
          *,
          products(product_name, product_code),
          batches(batch_number)
        `)
        .eq('return_id', materialReturn.id);

      if (itemsError) throw itemsError;

      const isInvoice = !!materialReturn.original_invoice_id;
      setSourceType(isInvoice ? 'sales_invoice' : 'delivery_challan');

      setFormData({
        customer_id: materialReturn.customer_id,
        original_dc_id: materialReturn.original_dc_id || '',
        original_invoice_id: materialReturn.original_invoice_id || '',
        return_date: materialReturn.return_date,
        return_type: materialReturn.return_type,
        return_reason: materialReturn.return_reason,
        notes: materialReturn.notes || '',
      });

      await loadDeliveryChallans(materialReturn.customer_id);
      await loadSalesInvoices(materialReturn.customer_id);

      if (isInvoice && materialReturn.original_invoice_id) {
        await loadInvoiceItems(materialReturn.original_invoice_id);
      } else if (materialReturn.original_dc_id) {
        await loadChallanItems(materialReturn.original_dc_id);
      }

      const mappedItems: ReturnItem[] = (itemsData || []).map((item: any) => ({
        product_id: item.product_id,
        batch_id: item.batch_id,
        quantity_returned: item.quantity_returned,
        original_quantity: item.original_quantity,
        unit_price: item.unit_price,
        condition: item.condition,
        disposition: item.disposition,
        notes: item.notes || '',
        product_name: item.products?.product_name,
        product_code: item.products?.product_code,
        batch_number: item.batches?.batch_number,
      }));

      setReturnItems(mappedItems);
      setEditMode(true);
      setEditingReturnId(materialReturn.id);
      setModalOpen(true);
    } catch (error) {
      console.error('Error loading return for edit:', error);
      showToast({ type: 'error', title: 'Error', message: 'Failed to load return for editing' });
    }
  };

  const handleApprove = async (id: string) => {
    if (!await showConfirm({
      title: 'Approve Material Return',
      message: 'Approve this material return? Note: Items marked with disposition "Restock" will be automatically added back into inventory via canonical Inventory V1.',
      variant: 'warning'
    })) return;

    try {
      const { error } = await supabase
        .from('material_returns')
        .update({
          status: 'approved',
          approved_by: user?.id,
          restocked: true,
        })
        .eq('id', id);

      if (error) throw error;
      showToast({ type: 'success', title: 'Success', message: 'Material return approved. Restock items processed through Inventory V1.' });
      loadReturns();
    } catch (error: any) {
      console.error('Error approving return:', error);
      showToast({ type: 'error', title: 'Error', message: error.message || 'Failed to approve material return' });
    }
  };

  const handleReject = async (id: string) => {
    const reason = prompt('Enter reason for rejection:');
    if (!reason) return;

    try {
      const { error } = await supabase
        .from('material_returns')
        .update({
          status: 'rejected',
          approved_by: user?.id,
          notes: reason,
        })
        .eq('id', id);

      if (error) throw error;
      showToast({ type: 'success', title: 'Success', message: 'Material return rejected' });
      loadReturns();
    } catch (error: any) {
      console.error('Error rejecting return:', error);
      showToast({ type: 'error', title: 'Error', message: error.message || 'Failed to reject material return' });
    }
  };

  const handleDelete = async (id: string) => {
    if (!await showConfirm({ title: 'Delete Return', message: 'Are you sure you want to delete this pending return?', variant: 'danger' })) return;

    try {
      const { error } = await supabase
        .from('material_returns')
        .delete()
        .eq('id', id)
        .eq('status', 'pending_approval');

      if (error) throw error;
      showToast({ type: 'success', title: 'Success', message: 'Material return deleted' });
      loadReturns();
    } catch (error: any) {
      console.error('Error deleting return:', error);
      showToast({ type: 'error', title: 'Error', message: error.message || 'Failed to delete return' });
    }
  };

  const resetForm = () => {
    setFormData({
      customer_id: '',
      original_dc_id: '',
      original_invoice_id: '',
      return_date: new Date().toISOString().split('T')[0],
      return_type: 'quality_issue',
      return_reason: '',
      notes: '',
    });
    setSourceType('delivery_challan');
    setSourceItems([]);
    setReturnItems([]);
    setDeliveryChallans([]);
    setSalesInvoices([]);
    setEditMode(false);
    setEditingReturnId(null);
  };

  const canManage = profile?.role === 'admin' || profile?.role === 'sales' || profile?.role === 'manager';
  const isManager = profile?.role === 'admin' || profile?.role === 'manager';

  const columns = [
    {
      key: 'return_number',
      label: 'Return #',
      render: (value: any, ret: MaterialReturn) => (
        <span className="font-semibold text-gray-900">{ret.return_number || 'Draft'}</span>
      )
    },
    {
      key: 'return_date',
      label: 'Date',
      render: (value: any, ret: MaterialReturn) => formatDate(ret.return_date)
    },
    {
      key: 'customer',
      label: 'Customer',
      render: (value: any, ret: MaterialReturn) => ret.customers?.company_name || 'N/A'
    },
    {
      key: 'source_doc',
      label: 'Source Document',
      render: (value: any, ret: MaterialReturn) => {
        if (ret.delivery_challans?.challan_number) {
          return (
            <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-200">
              <FileText className="w-3 h-3" /> DC: {ret.delivery_challans.challan_number}
            </span>
          );
        }
        if (ret.sales_invoices?.invoice_number) {
          return (
            <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-purple-50 text-purple-700 border border-purple-200">
              <FileText className="w-3 h-3" /> INV: {ret.sales_invoices.invoice_number}
            </span>
          );
        }
        return <span className="text-gray-400 text-xs">—</span>;
      }
    },
    {
      key: 'return_type',
      label: 'Type',
      render: (value: any, ret: MaterialReturn) => (
        <span className="capitalize text-xs text-gray-700">{ret.return_type.replace('_', ' ')}</span>
      )
    },
    {
      key: 'financial_impact',
      label: 'Value',
      render: (value: any, ret: MaterialReturn) => (
        <span className="font-medium text-gray-900">
          Rp {(ret.financial_impact || 0).toLocaleString('id-ID')}
        </span>
      )
    },
    {
      key: 'status',
      label: 'Status',
      render: (value: any, ret: MaterialReturn) => (
        <span className={`inline-block px-2.5 py-0.5 rounded-full text-xs font-semibold ${
          ret.status === 'approved' ? 'bg-green-100 text-green-800' :
          ret.status === 'rejected' ? 'bg-red-100 text-red-800' :
          ret.status === 'completed' ? 'bg-blue-100 text-blue-800' :
          'bg-yellow-100 text-yellow-800'
        }`}>
          {ret.status.replace('_', ' ')}
        </span>
      )
    },
    {
      key: 'financial_linkage',
      label: 'Financial Linkage',
      render: (value: any, ret: MaterialReturn) => {
        if (ret.credit_note_number) {
          return (
            <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded font-mono font-medium ${
              ret.credit_note_issued ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-amber-50 text-amber-700 border border-amber-200'
            }`}>
              <CheckCircle className="w-3 h-3 text-emerald-600" />
              {ret.credit_note_number} {ret.credit_note_issued ? '(Posted)' : '(Draft)'}
            </span>
          );
        }
        if (ret.status === 'approved') {
          return (
            <button
              type="button"
              onClick={() => {
                sessionStorage.setItem('anzen_originating_return_id', ret.id);
                setCurrentPage('credit-notes');
              }}
              className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded bg-purple-50 text-purple-700 hover:bg-purple-100 border border-purple-200 font-medium transition"
              title="Issue Credit Note for this return"
            >
              <FileText className="w-3 h-3" /> Issue CN
            </button>
          );
        }
        return <span className="text-gray-400 text-xs">—</span>;
      }
    },
  ];

  return (
    <div className="space-y-3">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 pb-2 border-b border-gray-200">
        <div>
          <h1 className="text-lg sm:text-xl font-bold text-gray-900 tracking-tight">{t('materialReturns.title')}</h1>
          <p className="text-xs text-gray-500 mt-0.5">Customer return authorizations with canonical Inventory V1 restocking & validation</p>
        </div>
        {canManage && (
          <button
            onClick={() => {
              resetForm();
              setModalOpen(true);
            }}
            className="flex items-center gap-1.5 bg-green-600 text-white px-3 py-1.5 rounded-lg text-xs font-semibold hover:bg-green-700 transition shadow-xs"
          >
            <Plus className="w-3.5 h-3.5" />
            {t('materialReturns.createReturn')}
          </button>
        )}
      </div>

      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 flex gap-3">
        <PackageX className="w-5 h-5 text-blue-600 flex-shrink-0 mt-0.5" />
        <div className="text-sm text-blue-900">
          <p className="font-semibold">Dual-Source Return Management (Delivery Challan OR Sales Invoice):</p>
          <p className="mt-0.5 text-blue-800">
            Source returns directly from a <strong>Delivery Challan</strong> (pre-invoice physical dispatch) or a <strong>Sales Invoice</strong> (delivered & invoiced shipment).
            When approved, items designated as <strong>Restock</strong> are canonically added back to warehouse batch inventory. Items marked Scrap or Return to Supplier are recorded without polluting stock.
          </p>
        </div>
      </div>

      <DataTable
        columns={columns}
        data={returns}
        loading={loading}
        actions={(ret) => (
          <div className="flex items-center gap-2">
            <button
              onClick={() => handleView(ret)}
              className="p-1.5 text-blue-600 hover:bg-blue-50 rounded"
              title="View Return"
            >
              <Eye className="w-4 h-4" />
            </button>

            {canManage && ret.status === 'pending_approval' && (
              <button
                onClick={() => handleEdit(ret)}
                className="p-1.5 text-yellow-600 hover:bg-yellow-50 rounded"
                title="Edit Return"
              >
                <Edit className="w-4 h-4" />
              </button>
            )}

            {isManager && ret.status === 'pending_approval' && (
              <>
                <button
                  onClick={() => handleApprove(ret.id)}
                  className="p-1.5 text-green-600 hover:bg-green-50 rounded"
                  title="Approve Return (Restock)"
                >
                  <CheckCircle className="w-4 h-4" />
                </button>
                <button
                  onClick={() => handleReject(ret.id)}
                  className="p-1.5 text-red-600 hover:bg-red-50 rounded"
                  title="Reject Return"
                >
                  <XCircle className="w-4 h-4" />
                </button>
              </>
            )}

            {canManage && ret.status === 'pending_approval' && (
              <button
                onClick={() => handleDelete(ret.id)}
                className="p-1.5 text-red-600 hover:bg-red-50 rounded"
                title="Delete Return"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            )}
          </div>
        )}
      />

      {/* CREATE / EDIT MODAL */}
      <Modal
        isOpen={modalOpen}
        onClose={() => {
          setModalOpen(false);
          resetForm();
        }}
        title={editMode ? "Edit Material Return" : "Create Material Return"}
        size="xl"
      >
        <form onSubmit={handleSubmit} className="space-y-6">
          {/* Source Document Selection Segmented Toggle */}
          <div className="bg-gray-50 border border-gray-200 rounded-lg p-3">
            <label className="block text-xs font-semibold text-gray-700 uppercase tracking-wider mb-2">
              Select Source Document Type *
            </label>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => handleSourceTypeToggle('delivery_challan')}
                className={`py-2 px-4 rounded-lg text-sm font-medium border flex items-center justify-center gap-2 transition ${
                  sourceType === 'delivery_challan'
                    ? 'bg-blue-600 text-white border-blue-600 shadow-sm'
                    : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
                }`}
              >
                <FileText className="w-4 h-4" />
                Delivery Challan (Dispatch)
              </button>
              <button
                type="button"
                onClick={() => handleSourceTypeToggle('sales_invoice')}
                className={`py-2 px-4 rounded-lg text-sm font-medium border flex items-center justify-center gap-2 transition ${
                  sourceType === 'sales_invoice'
                    ? 'bg-purple-600 text-white border-purple-600 shadow-sm'
                    : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
                }`}
              >
                <FileText className="w-4 h-4" />
                Sales Invoice (Delivered)
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Customer *
              </label>
              <SearchableSelect
                value={formData.customer_id}
                onChange={(val) => handleCustomerChange(val)}
                options={customers.map(c => ({ value: c.id, label: c.company_name }))}
                placeholder="Select Customer"
              />
            </div>

            {sourceType === 'delivery_challan' ? (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Original Delivery Challan *
                </label>
                <select
                  name="original_dc_id"
                  aria-label="Original Delivery Challan"
                  value={formData.original_dc_id}
                  onChange={(e) => handleChallanChange(e.target.value)}
                  required
                  disabled={!formData.customer_id}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:bg-gray-100"
                >
                  <option value="">Select Delivery Challan</option>
                  {deliveryChallans.map((dc) => (
                    <option key={dc.id} value={dc.id}>
                      {dc.challan_number} — {formatDate(dc.challan_date)}
                    </option>
                  ))}
                </select>
                {formData.customer_id && deliveryChallans.length === 0 && (
                  <p className="text-xs text-amber-600 mt-1">No Delivery Challans found for this customer.</p>
                )}
              </div>
            ) : (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Original Sales Invoice *
                </label>
                <select
                  name="original_invoice_id"
                  aria-label="Original Sales Invoice"
                  value={formData.original_invoice_id}
                  onChange={(e) => handleInvoiceChange(e.target.value)}
                  required
                  disabled={!formData.customer_id}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent disabled:bg-gray-100"
                >
                  <option value="">Select Sales Invoice</option>
                  {salesInvoices.map((inv) => (
                    <option key={inv.id} value={inv.id}>
                      {inv.invoice_number} — {formatDate(inv.invoice_date)} (Rp {(inv.total_amount || 0).toLocaleString('id-ID')})
                    </option>
                  ))}
                </select>
                {formData.customer_id && salesInvoices.length === 0 && (
                  <p className="text-xs text-amber-600 mt-1">No Sales Invoices found for this customer.</p>
                )}
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Return Date *
              </label>
              <input
                name="return_date"
                aria-label="Return Date"
                type="date"
                value={formData.return_date}
                onChange={(e) => setFormData({ ...formData, return_date: e.target.value })}
                required
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Return Type *
              </label>
              <select
                name="return_type"
                aria-label="Return Type"
                value={formData.return_type}
                onChange={(e) => setFormData({ ...formData, return_type: e.target.value })}
                required
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              >
                <option value="quality_issue">Quality Issue</option>
                <option value="wrong_product">Wrong Product</option>
                <option value="excess_quantity">Excess Quantity</option>
                <option value="damaged">Damaged</option>
                <option value="expired">Expired</option>
                <option value="other">Other</option>
              </select>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Return Reason *
            </label>
            <textarea
              name="return_reason"
              aria-label="Return Reason"
              value={formData.return_reason}
              onChange={(e) => setFormData({ ...formData, return_reason: e.target.value })}
              required
              rows={2}
              placeholder="Explain why the goods are being returned..."
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>

          {/* Source Document Line Items */}
          {sourceItems.length > 0 && (
            <div className="border-t pt-4">
              <div className="flex items-center justify-between mb-2">
                <h4 className="text-sm font-semibold text-gray-900">
                  Original Shipped Items ({sourceType === 'delivery_challan' ? 'Delivery Challan' : 'Sales Invoice'})
                </h4>
                <span className="text-xs text-blue-700 bg-blue-50 px-2 py-0.5 rounded font-medium">
                  Inventory V1: Restock will only restore items with disposition "Restock"
                </span>
              </div>
              <p className="text-xs text-gray-500 mb-3">
                Specify quantity returned for each line. Maximum return quantity is enforced by database validation.
              </p>

              <div className="space-y-3 max-h-96 overflow-y-auto pr-1">
                {sourceItems.map((item, index) => {
                  const returnItem = returnItems[index];
                  if (!returnItem) return null;

                  return (
                    <div key={index} className="p-3.5 bg-gray-50 rounded-lg border border-gray-200 text-xs">
                      <div className="grid grid-cols-12 gap-3">
                        <div className="col-span-3">
                          <label className="block text-[11px] text-gray-500 mb-0.5 font-medium">Product</label>
                          <div className="text-sm font-semibold text-gray-900 truncate">
                            {item.products?.product_name || 'Product'}
                          </div>
                          <div className="text-[11px] text-gray-500">
                            Code: {item.products?.product_code || '—'}
                          </div>
                        </div>

                        <div className="col-span-2">
                          <label className="block text-[11px] text-gray-500 mb-0.5 font-medium">Batch #</label>
                          <div className="text-xs font-mono font-medium text-gray-800">
                            {item.batches?.batch_number || 'Default Batch'}
                          </div>
                        </div>

                        <div className="col-span-2">
                          <label className="block text-[11px] text-gray-500 mb-0.5 font-medium">Shipped Qty</label>
                          <div className="text-xs font-bold text-blue-700">
                            {item.quantity} Kg
                          </div>
                        </div>

                        <div className="col-span-2">
                          <label className="block text-[11px] text-gray-500 mb-0.5 font-medium">Unit Price</label>
                          <div className="text-xs text-gray-800 font-medium">
                            Rp {(item.unit_price || 0).toLocaleString('id-ID')}
                          </div>
                        </div>

                        <div className="col-span-3">
                          <label className="block text-[11px] text-gray-500 mb-0.5 font-medium">
                            Return Qty (Kg) *
                          </label>
                          <input
                            name="quantity_returned"
                            aria-label="Return Qty"
                            type="number"
                            step="0.01"
                            value={returnItem.quantity_returned || ''}
                            onChange={(e) => updateReturnItem(index, 'quantity_returned', parseFloat(e.target.value) || 0)}
                            max={item.quantity}
                            min="0"
                            placeholder="0.00"
                            className="w-full px-2.5 py-1 text-xs font-bold border border-gray-300 rounded focus:ring-2 focus:ring-blue-500"
                          />
                          {returnItem.quantity_returned > item.quantity && (
                            <p className="text-[10px] text-red-600 mt-0.5">Exceeds {item.quantity} Kg!</p>
                          )}
                        </div>
                      </div>

                      {returnItem.quantity_returned > 0 && (
                        <div className="mt-3 pt-2.5 border-t border-gray-200 grid grid-cols-12 gap-3">
                          <div className="col-span-3">
                            <label className="block text-[11px] text-gray-500 mb-0.5">Condition</label>
                            <select
                              name="condition"
                              aria-label="Condition"
                              value={returnItem.condition}
                              onChange={(e) => updateReturnItem(index, 'condition', e.target.value)}
                              className="w-full px-2 py-1 border border-gray-300 rounded text-xs"
                            >
                              <option value="good">Good</option>
                              <option value="damaged">Damaged</option>
                              <option value="expired">Expired</option>
                              <option value="unusable">Unusable</option>
                            </select>
                          </div>

                          <div className="col-span-4">
                            <label className="block text-[11px] text-gray-500 mb-0.5">
                              Disposition (Stock Action) *
                            </label>
                            <select
                              name="disposition"
                              aria-label="Disposition"
                              value={returnItem.disposition}
                              onChange={(e) => updateReturnItem(index, 'disposition', e.target.value)}
                              className={`w-full px-2 py-1 border rounded text-xs font-semibold ${
                                returnItem.disposition === 'restock'
                                  ? 'bg-green-50 border-green-300 text-green-800'
                                  : 'bg-amber-50 border-amber-300 text-amber-800'
                              }`}
                            >
                              <option value="restock">Restock (Add back to batch inventory)</option>
                              <option value="scrap">Scrap (Do NOT add back to inventory)</option>
                              <option value="return_to_supplier">Return to Supplier</option>
                              <option value="pending">Pending Decision</option>
                            </select>
                          </div>

                          <div className="col-span-5">
                            <label className="block text-[11px] text-gray-500 mb-0.5">Notes</label>
                            <input
                              name="item_notes"
                              aria-label="Notes"
                              type="text"
                              value={returnItem.notes || ''}
                              onChange={(e) => updateReturnItem(index, 'notes', e.target.value)}
                              placeholder="Batch condition or return note..."
                              className="w-full px-2 py-1 border border-gray-300 rounded text-xs"
                            />
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              <div className="mt-4 p-3 bg-blue-50 rounded-lg flex items-center justify-between text-xs text-blue-900">
                <span>Calculated Return Value:</span>
                <span className="text-base font-bold">
                  Rp {returnItems.reduce((sum, item) => sum + ((item.quantity_returned || 0) * (item.unit_price || 0)), 0).toLocaleString('id-ID')}
                </span>
              </div>
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              General Notes (Optional)
            </label>
            <textarea
              name="notes"
              aria-label="Notes"
              value={formData.notes}
              onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
              rows={2}
              placeholder="Additional internal notes..."
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
            />
          </div>

          <div className="flex justify-end gap-3 pt-3 border-t">
            <button
              type="button"
              onClick={() => {
                setModalOpen(false);
                resetForm();
              }}
              className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 text-sm"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-medium shadow-sm"
            >
              {editMode ? 'Update Return' : 'Create Return'}
            </button>
          </div>
        </form>
      </Modal>

      {/* VIEW MODAL */}
      {viewModalOpen && selectedReturn && (
        <MaterialReturnView
          materialReturn={selectedReturn}
          items={selectedReturnItems}
          onClose={() => setViewModalOpen(false)}
          companyProfile={selectedReturn.company_snapshot || {
            company_name: 'PT. SAPJ',
            company_address: 'Jakarta, Indonesia',
            company_phone: '',
            company_email: ''
          }}
        />
      )}
    </div>
  );
}
