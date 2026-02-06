import { useEffect, useState } from 'react';
import { Layout } from '../components/Layout';
import { DataTable } from '../components/DataTable';
import { Modal } from '../components/Modal';
import { CreditNoteView } from '../components/CreditNoteView';
import { useLanguage } from '../contexts/LanguageContext';
import { useAuth } from '../contexts/AuthContext';
import { supabase } from '../lib/supabase';
import { Plus, Eye, Trash2, FileX, AlertCircle, CheckCircle, XCircle } from 'lucide-react';
import { showToast } from '../components/ToastNotification';
import { showConfirm } from '../components/ConfirmDialog';

interface CreditNote {
  id: string;
  credit_note_number: string;
  credit_note_date: string;
  customer_id: string;
  original_invoice_id?: string;
  original_invoice_number?: string;
  reason: string;
  notes?: string;
  currency: string;
  subtotal: number;
  tax_amount: number;
  total_amount: number;
  status?: string;
  approved_by?: string;
  customers?: {
    company_name: string;
    address: string;
    city: string;
    phone: string;
    npwp: string;
    pharmacy_license: string;
  };
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
  };
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
  const [modalOpen, setModalOpen] = useState(false);
  const [viewModalOpen, setViewModalOpen] = useState(false);
  const [selectedCreditNote, setSelectedCreditNote] = useState<CreditNote | null>(null);
  const [selectedCreditNoteItems, setSelectedCreditNoteItems] = useState<any[]>([]);

  const [customers, setCustomers] = useState<Customer[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [invoices, setInvoices] = useState<SalesInvoice[]>([]);

  const [formData, setFormData] = useState({
    credit_note_number: '',
    credit_note_date: new Date().toISOString().split('T')[0],
    customer_id: '',
    original_invoice_id: '',
    original_invoice_number: '',
    reason: '',
    notes: '',
    currency: 'IDR',
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

  const loadData = async () => {
    setLoading(true);
    await loadCreditNotes();
    await loadCustomers();
    await loadProducts();
    setLoading(false);
  };

  const loadCreditNotes = async () => {
    try {
      const { data, error } = await supabase
        .from('credit_notes')
        .select(`
          *,
          customers(company_name, address, city, phone, npwp, pharmacy_license)
        `)
        .order('created_at', { ascending: false });

      if (error) throw error;
      setCreditNotes(data || []);
    } catch (error) {
      console.error('Error loading credit notes:', error);
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
        .select('id, batch_number, product_id, current_stock')
        .eq('product_id', productId)
        .eq('is_active', true)
        .order('batch_number');

      if (error) throw error;
      setBatches(data || []);
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
          batches(batch_number)
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
        .select('id, invoice_number, invoice_date, total_amount')
        .eq('customer_id', customerId)
        .order('invoice_date', { ascending: false });

      if (error) throw error;
      setInvoices(data || []);
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
          batches(batch_number, current_stock)
        `)
        .eq('invoice_id', invoiceId);

      if (error) throw error;

      if (data && data.length > 0) {
        const invoiceItems = data.map(item => ({
          product_id: item.product_id,
          batch_id: item.batch_id || '',
          quantity: item.quantity,
          unit_price: item.unit_price,
        }));
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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!formData.customer_id || !formData.reason || items.length === 0) {
      showToast({ type: 'error', title: 'Error', message: 'Please complete all required fields' });
      return;
    }

    const hasInvalidItems = items.some(item => !item.product_id || !item.batch_id || item.quantity <= 0 || item.unit_price <= 0);
    if (hasInvalidItems) {
      showToast({ type: 'error', title: 'Error', message: 'Please complete all item details' });
      return;
    }

    try {
      const totals = calculateTotals();

      const { data: creditNoteData, error: creditNoteError } = await supabase
        .from('credit_notes')
        .insert({
          ...formData,
          ...totals,
          created_by: user?.id,
        })
        .select()
        .single();

      if (creditNoteError) throw creditNoteError;

      const itemsWithCreditNoteId = items.map(item => ({
        ...item,
        credit_note_id: creditNoteData.id,
      }));

      const { error: itemsError } = await supabase
        .from('credit_note_items')
        .insert(itemsWithCreditNoteId);

      if (itemsError) throw itemsError;

      showToast({ type: 'success', title: 'Success', message: 'Credit note created successfully. Stock has been added back to inventory.' });
      setModalOpen(false);
      resetForm();
      loadData();
    } catch (error: any) {
      console.error('Error creating credit note:', error);
      showToast({ type: 'error', title: 'Error', message: error.message || 'Failed to create credit note. Please try again.' });
    }
  };

  const handleApprove = async (id: string) => {
    if (!await showConfirm({ title: 'Confirm', message: 'Approve this credit note? Stock will be adjusted accordingly.', variant: 'warning' })) return;

    try {
      const { error } = await supabase
        .from('credit_notes')
        .update({
          status: 'approved',
          approved_by: user?.id,
        })
        .eq('id', id);

      if (error) throw error;
      showToast({ type: 'success', title: 'Success', message: 'Credit note approved successfully' });
      loadData();
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
      loadData();
    } catch (error: any) {
      console.error('Error rejecting credit note:', error);
      showToast({ type: 'error', title: 'Error', message: error.message || 'Failed to reject credit note' });
    }
  };

  const handleDelete = async (id: string) => {
    if (!await showConfirm({ title: 'Confirm', message: 'Are you sure you want to delete this credit note? This will reverse the stock adjustment.', variant: 'danger', confirmLabel: 'Delete' })) {
      return;
    }

    try {
      const { error } = await supabase
        .from('credit_notes')
        .delete()
        .eq('id', id);

      if (error) throw error;

      showToast({ type: 'success', title: 'Success', message: 'Credit note deleted successfully' });
      loadData();
    } catch (error: any) {
      console.error('Error deleting credit note:', error);
      showToast({ type: 'error', title: 'Error', message: error.message || 'Failed to delete credit note' });
    }
  };

  const resetForm = () => {
    setFormData({
      credit_note_number: '',
      credit_note_date: new Date().toISOString().split('T')[0],
      customer_id: '',
      original_invoice_id: '',
      original_invoice_number: '',
      reason: '',
      notes: '',
      currency: 'IDR',
    });
    setItems([{ product_id: '', batch_id: '', quantity: 0, unit_price: 0 }]);
  };

  const canManage = profile?.role === 'admin' || profile?.role === 'sales' || profile?.role === 'manager';
  const isManager = profile?.role === 'admin' || profile?.role === 'manager';

  const columns = [
    {
      key: 'credit_note_number',
      label: 'Credit Note #',
      render: (value: any, cn: CreditNote) => cn.credit_note_number || 'Pending'
    },
    {
      key: 'credit_note_date',
      label: 'Date',
      render: (value: any, cn: CreditNote) => new Date(cn.credit_note_date).toLocaleDateString()
    },
    {
      key: 'customer',
      label: 'Customer',
      render: (value: any, cn: CreditNote) => cn.customers?.company_name || 'N/A'
    },
    {
      key: 'original_invoice_number',
      label: 'Original Invoice',
      render: (value: any, cn: CreditNote) => cn.original_invoice_number || 'N/A'
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

  return (
    <Layout>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-gray-900">Credit Notes</h1>
            <p className="text-gray-600 mt-1">Manage credit notes for returns and adjustments after invoicing</p>
          </div>
          {canManage && (
            <button
              onClick={() => {
                resetForm();
                setModalOpen(true);
              }}
              className="flex items-center gap-2 bg-red-600 text-white px-4 py-2 rounded-lg hover:bg-red-700 transition"
            >
              <Plus className="w-5 h-5" />
              Create Credit Note
            </button>
          )}
        </div>

        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 flex gap-3">
          <AlertCircle className="w-5 h-5 text-yellow-600 flex-shrink-0 mt-0.5" />
          <div className="text-sm text-yellow-800">
            <p className="font-medium">When to use Credit Notes:</p>
            <p className="mt-1">Use Credit Notes for goods returned or price adjustments AFTER an invoice has been issued and filed for tax purposes. For physical returns before invoicing, use Material Returns instead.</p>
          </div>
        </div>

        <DataTable
          columns={columns}
          data={creditNotes}
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

              {canManage && (!creditNote.status || creditNote.status === 'pending_approval') && (
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
          title="Create Credit Note"
        >
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Customer *
                </label>
                <select
                  value={formData.customer_id}
                  onChange={(e) => handleCustomerChange(e.target.value)}
                  required
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-transparent"
                >
                  <option value="">Select Customer</option>
                  {customers.map((customer) => (
                    <option key={customer.id} value={customer.id}>
                      {customer.company_name}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Original Invoice (Optional)
                </label>
                <select
                  value={formData.original_invoice_id}
                  onChange={(e) => handleInvoiceChange(e.target.value)}
                  disabled={!formData.customer_id}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-transparent disabled:bg-gray-100"
                >
                  <option value="">Select Invoice</option>
                  {invoices.map((invoice) => (
                    <option key={invoice.id} value={invoice.id}>
                      {invoice.invoice_number} - {new Date(invoice.invoice_date).toLocaleDateString()} - Rp {invoice.total_amount.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Credit Note Date *
                </label>
                <input
                  type="date"
                  value={formData.credit_note_date}
                  onChange={(e) => setFormData({ ...formData, credit_note_date: e.target.value })}
                  required
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-transparent"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Currency
                </label>
                <select
                  value={formData.currency}
                  onChange={(e) => setFormData({ ...formData, currency: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-transparent"
                >
                  <option value="IDR">IDR</option>
                  <option value="USD">USD</option>
                </select>
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Reason for Credit Note *
              </label>
              <textarea
                value={formData.reason}
                onChange={(e) => setFormData({ ...formData, reason: e.target.value })}
                required
                rows={2}
                placeholder="e.g., Goods returned due to quality issue, Price adjustment, etc."
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-transparent"
              />
            </div>

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
                {items.map((item, index) => (
                  <div key={index} className="p-3 border border-gray-200 rounded-lg space-y-2">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      <div>
                        <select
                          value={item.product_id}
                          onChange={(e) => updateItem(index, 'product_id', e.target.value)}
                          required
                          disabled={!!formData.original_invoice_id}
                          className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg disabled:bg-gray-100"
                        >
                          <option value="">Select Product</option>
                          {products.map((product) => (
                            <option key={product.id} value={product.id}>
                              {product.product_name} ({product.product_code})
                            </option>
                          ))}
                        </select>
                        {item.product_id && products.find(p => p.id === item.product_id) && (
                          <div className="text-xs text-gray-500 mt-1">
                            {products.find(p => p.id === item.product_id)?.product_name}
                          </div>
                        )}
                      </div>

                      <div>
                        <select
                          value={item.batch_id}
                          onChange={(e) => updateItem(index, 'batch_id', e.target.value)}
                          required
                          disabled={!item.product_id || !!formData.original_invoice_id}
                          className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg disabled:bg-gray-100"
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
                      </div>

                      <div>
                        <label className="block text-xs text-gray-600 mb-1">Quantity (Kg)</label>
                        <input
                          type="number"
                          step="0.001"
                          placeholder="Quantity in Kg"
                          value={item.quantity || ''}
                          onChange={(e) => updateItem(index, 'quantity', parseFloat(e.target.value) || 0)}
                          required
                          min="0.001"
                          className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg"
                        />
                      </div>

                      <div>
                        <label className="block text-xs text-gray-600 mb-1">Unit Price (per Kg)</label>
                        <input
                          type="number"
                          step="0.01"
                          placeholder="Price per Kg"
                          value={item.unit_price || ''}
                          onChange={(e) => updateItem(index, 'unit_price', parseFloat(e.target.value) || 0)}
                          required
                          min="0"
                          className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg"
                        />
                      </div>
                    </div>

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
                ))}
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

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Additional Notes
              </label>
              <textarea
                value={formData.notes}
                onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                rows={2}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-transparent"
              />
            </div>

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
                className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition"
              >
                Create Credit Note
              </button>
            </div>
          </form>
        </Modal>

        {viewModalOpen && selectedCreditNote && (
          <CreditNoteView
            creditNote={selectedCreditNote}
            items={selectedCreditNoteItems}
            onClose={() => {
              setViewModalOpen(false);
              setSelectedCreditNote(null);
              setSelectedCreditNoteItems([]);
            }}
          />
        )}
      </div>
    </Layout>
  );
}
