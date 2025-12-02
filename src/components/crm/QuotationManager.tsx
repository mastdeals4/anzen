import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../contexts/AuthContext';
import { DataTable } from '../DataTable';
import { Modal } from '../Modal';
import { Plus, Edit, Trash2, FileText, Send, Check, X, Clock } from 'lucide-react';

interface Product {
  id: string;
  product_name: string;
  unit: string;
}

interface QuotationItem {
  id?: string;
  product_id: string;
  product_name: string;
  quantity: number;
  unit_price: number;
  tax_rate: number;
  discount_percent: number;
}

interface Quotation {
  id: string;
  quotation_number: string;
  lead_id: string | null;
  customer_id: string | null;
  quotation_date: string;
  valid_until: string;
  subtotal: number;
  tax_amount: number;
  discount_amount: number;
  total_amount: number;
  status: 'draft' | 'sent' | 'accepted' | 'rejected' | 'expired';
  notes: string | null;
  terms_conditions: string | null;
  created_at: string;
  crm_leads?: {
    company_name: string;
  } | null;
  customers?: {
    company_name: string;
  } | null;
}

interface QuotationManagerProps {
  leadId?: string;
  customerId?: string;
  canManage: boolean;
}

export function QuotationManager({ leadId, customerId, canManage }: QuotationManagerProps) {
  const { profile } = useAuth();
  const [quotations, setQuotations] = useState<Quotation[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingQuotation, setEditingQuotation] = useState<Quotation | null>(null);
  const [formData, setFormData] = useState({
    quotation_date: new Date().toISOString().split('T')[0],
    valid_until: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
    notes: '',
    terms_conditions: 'Payment Terms: Net 30 days\nDelivery: 2-3 weeks from order confirmation\nPrices are valid for 30 days',
  });
  const [items, setItems] = useState<QuotationItem[]>([{
    product_id: '',
    product_name: '',
    quantity: 0,
    unit_price: 0,
    tax_rate: 11,
    discount_percent: 0,
  }]);

  useEffect(() => {
    loadQuotations();
    loadProducts();
  }, [leadId, customerId]);

  const loadQuotations = async () => {
    try {
      let query = supabase
        .from('crm_quotations')
        .select(`
          *,
          crm_leads (company_name),
          customers (company_name)
        `)
        .order('created_at', { ascending: false });

      if (leadId) {
        query = query.eq('lead_id', leadId);
      }

      if (customerId) {
        query = query.eq('customer_id', customerId);
      }

      const { data, error } = await query;

      if (error) throw error;
      setQuotations(data || []);
    } catch (error) {
      console.error('Error loading quotations:', error);
    } finally {
      setLoading(false);
    }
  };

  const loadProducts = async () => {
    try {
      const { data, error } = await supabase
        .from('products')
        .select('id, product_name, unit')
        .eq('is_active', true)
        .order('product_name');

      if (error) throw error;
      setProducts(data || []);
    } catch (error) {
      console.error('Error loading products:', error);
    }
  };

  const generateQuotationNumber = async () => {
    const prefix = 'QT';
    const year = new Date().getFullYear();

    const { data } = await supabase
      .from('crm_quotations')
      .select('quotation_number')
      .like('quotation_number', `${prefix}-${year}%`)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (data?.quotation_number) {
      const lastNumber = parseInt(data.quotation_number.split('-')[2]);
      return `${prefix}-${year}-${String(lastNumber + 1).padStart(5, '0')}`;
    }

    return `${prefix}-${year}-00001`;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (items.length === 0 || items.some(item => !item.product_id || item.quantity <= 0)) {
      alert('Please add at least one valid line item');
      return;
    }

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      let quotationId: string;

      if (editingQuotation) {
        const { error } = await supabase
          .from('crm_quotations')
          .update({
            quotation_date: formData.quotation_date,
            valid_until: formData.valid_until,
            notes: formData.notes || null,
            terms_conditions: formData.terms_conditions || null,
          })
          .eq('id', editingQuotation.id);

        if (error) throw error;

        await supabase
          .from('crm_quotation_items')
          .delete()
          .eq('quotation_id', editingQuotation.id);

        quotationId = editingQuotation.id;
      } else {
        const quotationNumber = await generateQuotationNumber();

        const { data: newQuotation, error } = await supabase
          .from('crm_quotations')
          .insert([{
            quotation_number: quotationNumber,
            lead_id: leadId || null,
            customer_id: customerId || null,
            quotation_date: formData.quotation_date,
            valid_until: formData.valid_until,
            notes: formData.notes || null,
            terms_conditions: formData.terms_conditions || null,
            created_by: user.id,
          }])
          .select()
          .single();

        if (error) throw error;
        quotationId = newQuotation.id;
      }

      const itemsToInsert = items.map(item => ({
        quotation_id: quotationId,
        product_id: item.product_id,
        product_name: item.product_name,
        quantity: item.quantity,
        unit_price: item.unit_price,
        tax_rate: item.tax_rate,
        discount_percent: item.discount_percent,
      }));

      const { error: itemsError } = await supabase
        .from('crm_quotation_items')
        .insert(itemsToInsert);

      if (itemsError) throw itemsError;

      setModalOpen(false);
      resetForm();
      loadQuotations();
    } catch (error) {
      console.error('Error saving quotation:', error);
      alert('Failed to save quotation. Please try again.');
    }
  };

  const handleEdit = async (quotation: Quotation) => {
    setEditingQuotation(quotation);
    setFormData({
      quotation_date: quotation.quotation_date,
      valid_until: quotation.valid_until,
      notes: quotation.notes || '',
      terms_conditions: quotation.terms_conditions || '',
    });

    const { data: quotationItems, error } = await supabase
      .from('crm_quotation_items')
      .select('*')
      .eq('quotation_id', quotation.id);

    if (error) {
      console.error('Error loading quotation items:', error);
      return;
    }

    setItems(quotationItems.map(item => ({
      product_id: item.product_id || '',
      product_name: item.product_name,
      quantity: item.quantity,
      unit_price: item.unit_price,
      tax_rate: item.tax_rate,
      discount_percent: item.discount_percent,
    })));

    setModalOpen(true);
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Are you sure you want to delete this quotation?')) return;

    try {
      const { error } = await supabase
        .from('crm_quotations')
        .delete()
        .eq('id', id);

      if (error) throw error;
      loadQuotations();
    } catch (error) {
      console.error('Error deleting quotation:', error);
      alert('Failed to delete quotation. Please try again.');
    }
  };

  const handleStatusChange = async (id: string, status: Quotation['status']) => {
    try {
      const { error } = await supabase
        .from('crm_quotations')
        .update({ status, updated_at: new Date().toISOString() })
        .eq('id', id);

      if (error) throw error;
      loadQuotations();
    } catch (error) {
      console.error('Error updating quotation status:', error);
      alert('Failed to update quotation status. Please try again.');
    }
  };

  const resetForm = () => {
    setEditingQuotation(null);
    setFormData({
      quotation_date: new Date().toISOString().split('T')[0],
      valid_until: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
      notes: '',
      terms_conditions: 'Payment Terms: Net 30 days\nDelivery: 2-3 weeks from order confirmation\nPrices are valid for 30 days',
    });
    setItems([{
      product_id: '',
      product_name: '',
      quantity: 0,
      unit_price: 0,
      tax_rate: 11,
      discount_percent: 0,
    }]);
  };

  const addItem = () => {
    setItems([...items, {
      product_id: '',
      product_name: '',
      quantity: 0,
      unit_price: 0,
      tax_rate: 11,
      discount_percent: 0,
    }]);
  };

  const removeItem = (index: number) => {
    setItems(items.filter((_, i) => i !== index));
  };

  const updateItem = (index: number, field: keyof QuotationItem, value: any) => {
    const newItems = [...items];
    newItems[index] = { ...newItems[index], [field]: value };

    if (field === 'product_id') {
      const product = products.find(p => p.id === value);
      if (product) {
        newItems[index].product_name = product.product_name;
      }
    }

    setItems(newItems);
  };

  const calculateLineTotal = (item: QuotationItem) => {
    const baseAmount = item.quantity * item.unit_price;
    const afterDiscount = baseAmount * (1 - item.discount_percent / 100);
    const withTax = afterDiscount * (1 + item.tax_rate / 100);
    return withTax;
  };

  const calculateTotals = () => {
    const subtotal = items.reduce((sum, item) =>
      sum + (item.quantity * item.unit_price * (1 - item.discount_percent / 100)), 0
    );
    const taxAmount = items.reduce((sum, item) =>
      sum + (item.quantity * item.unit_price * (1 - item.discount_percent / 100) * (item.tax_rate / 100)), 0
    );
    const total = subtotal + taxAmount;
    return { subtotal, taxAmount, total };
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'draft':
        return 'bg-gray-100 text-gray-800';
      case 'sent':
        return 'bg-blue-100 text-blue-800';
      case 'accepted':
        return 'bg-green-100 text-green-800';
      case 'rejected':
        return 'bg-red-100 text-red-800';
      case 'expired':
        return 'bg-orange-100 text-orange-800';
      default:
        return 'bg-gray-100 text-gray-800';
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'sent':
        return <Send className="w-3 h-3" />;
      case 'accepted':
        return <Check className="w-3 h-3" />;
      case 'rejected':
        return <X className="w-3 h-3" />;
      case 'expired':
        return <Clock className="w-3 h-3" />;
      default:
        return <FileText className="w-3 h-3" />;
    }
  };

  const columns = [
    {
      key: 'quotation_number',
      label: 'Quotation #',
      render: (q: Quotation) => (
        <span className="font-medium text-gray-900">{q.quotation_number}</span>
      )
    },
    {
      key: 'company',
      label: 'Company',
      render: (q: Quotation) => q.crm_leads?.company_name || q.customers?.company_name || 'N/A'
    },
    {
      key: 'quotation_date',
      label: 'Date',
      render: (q: Quotation) => new Date(q.quotation_date).toLocaleDateString()
    },
    {
      key: 'valid_until',
      label: 'Valid Until',
      render: (q: Quotation) => {
        const validDate = new Date(q.valid_until);
        const isExpired = validDate < new Date() && q.status !== 'accepted';
        return (
          <span className={isExpired ? 'text-red-600 font-medium' : ''}>
            {validDate.toLocaleDateString()}
          </span>
        );
      }
    },
    {
      key: 'total_amount',
      label: 'Total Amount',
      render: (q: Quotation) => (
        <span className="font-semibold text-blue-600">
          Rp {q.total_amount.toLocaleString('id-ID')}
        </span>
      )
    },
    {
      key: 'status',
      label: 'Status',
      render: (q: Quotation) => (
        <span className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium ${getStatusColor(q.status)}`}>
          {getStatusIcon(q.status)}
          {q.status.toUpperCase()}
        </span>
      )
    },
  ];

  const totals = calculateTotals();

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">Quotations</h3>
        {canManage && (
          <button
            onClick={() => {
              resetForm();
              setModalOpen(true);
            }}
            className="flex items-center gap-2 bg-blue-600 text-white px-3 py-1.5 rounded-lg hover:bg-blue-700 transition text-sm"
          >
            <Plus className="w-4 h-4" />
            New Quotation
          </button>
        )}
      </div>

      <DataTable
        columns={columns}
        data={quotations}
        loading={loading}
        actions={canManage ? (quotation) => (
          <div className="flex items-center gap-2">
            {quotation.status === 'draft' && (
              <button
                onClick={() => handleStatusChange(quotation.id, 'sent')}
                className="p-1 text-blue-600 hover:bg-blue-50 rounded"
                title="Mark as Sent"
              >
                <Send className="w-4 h-4" />
              </button>
            )}
            {quotation.status === 'sent' && (
              <>
                <button
                  onClick={() => handleStatusChange(quotation.id, 'accepted')}
                  className="p-1 text-green-600 hover:bg-green-50 rounded"
                  title="Mark as Accepted"
                >
                  <Check className="w-4 h-4" />
                </button>
                <button
                  onClick={() => handleStatusChange(quotation.id, 'rejected')}
                  className="p-1 text-red-600 hover:bg-red-50 rounded"
                  title="Mark as Rejected"
                >
                  <X className="w-4 h-4" />
                </button>
              </>
            )}
            <button
              onClick={() => handleEdit(quotation)}
              className="p-1 text-blue-600 hover:bg-blue-50 rounded"
              title="Edit"
            >
              <Edit className="w-4 h-4" />
            </button>
            <button
              onClick={() => handleDelete(quotation.id)}
              className="p-1 text-red-600 hover:bg-red-50 rounded"
              title="Delete"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        ) : undefined}
      />

      <Modal
        isOpen={modalOpen}
        onClose={() => {
          setModalOpen(false);
          resetForm();
        }}
        title={editingQuotation ? 'Edit Quotation' : 'Create Quotation'}
      >
        <form onSubmit={handleSubmit} className="space-y-4 max-h-[70vh] overflow-y-auto">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Quotation Date *
              </label>
              <input
                type="date"
                value={formData.quotation_date}
                onChange={(e) => setFormData({ ...formData, quotation_date: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                required
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Valid Until *
              </label>
              <input
                type="date"
                value={formData.valid_until}
                onChange={(e) => setFormData({ ...formData, valid_until: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                required
              />
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="block text-sm font-medium text-gray-700">
                Line Items *
              </label>
              <button
                type="button"
                onClick={addItem}
                className="text-sm text-blue-600 hover:text-blue-700"
              >
                + Add Item
              </button>
            </div>
            <div className="space-y-2">
              {items.map((item, index) => (
                <div key={index} className="grid grid-cols-12 gap-2 items-start p-2 bg-gray-50 rounded">
                  <div className="col-span-3">
                    <select
                      value={item.product_id}
                      onChange={(e) => updateItem(index, 'product_id', e.target.value)}
                      className="w-full px-2 py-1 border border-gray-300 rounded text-sm"
                      required
                    >
                      <option value="">Select Product</option>
                      {products.map(product => (
                        <option key={product.id} value={product.id}>
                          {product.product_name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="col-span-2">
                    <input
                      type="number"
                      value={item.quantity === 0 ? '' : item.quantity}
                      onChange={(e) => updateItem(index, 'quantity', e.target.value === '' ? 0 : Number(e.target.value))}
                      className="w-full px-2 py-1 border border-gray-300 rounded text-sm"
                      placeholder="Qty"
                      min="0"
                      required
                    />
                  </div>
                  <div className="col-span-2">
                    <input
                      type="number"
                      value={item.unit_price === 0 ? '' : item.unit_price}
                      onChange={(e) => updateItem(index, 'unit_price', e.target.value === '' ? 0 : Number(e.target.value))}
                      className="w-full px-2 py-1 border border-gray-300 rounded text-sm"
                      placeholder="Price"
                      min="0"
                      required
                    />
                  </div>
                  <div className="col-span-1">
                    <input
                      type="number"
                      value={item.tax_rate}
                      onChange={(e) => updateItem(index, 'tax_rate', Number(e.target.value))}
                      className="w-full px-2 py-1 border border-gray-300 rounded text-sm"
                      placeholder="Tax%"
                      min="0"
                    />
                  </div>
                  <div className="col-span-1">
                    <input
                      type="number"
                      value={item.discount_percent}
                      onChange={(e) => updateItem(index, 'discount_percent', Number(e.target.value))}
                      className="w-full px-2 py-1 border border-gray-300 rounded text-sm"
                      placeholder="Disc%"
                      min="0"
                      max="100"
                    />
                  </div>
                  <div className="col-span-2 text-right text-sm font-medium py-1">
                    Rp {calculateLineTotal(item).toLocaleString('id-ID', { maximumFractionDigits: 0 })}
                  </div>
                  <div className="col-span-1">
                    {items.length > 1 && (
                      <button
                        type="button"
                        onClick={() => removeItem(index)}
                        className="p-1 text-red-600 hover:bg-red-50 rounded"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="bg-blue-50 p-3 rounded-lg">
            <div className="flex justify-between text-sm mb-1">
              <span>Subtotal:</span>
              <span className="font-medium">Rp {totals.subtotal.toLocaleString('id-ID')}</span>
            </div>
            <div className="flex justify-between text-sm mb-1">
              <span>Tax:</span>
              <span className="font-medium">Rp {totals.taxAmount.toLocaleString('id-ID')}</span>
            </div>
            <div className="flex justify-between text-lg font-bold border-t border-blue-200 pt-2 mt-2">
              <span>Total:</span>
              <span className="text-blue-600">Rp {totals.total.toLocaleString('id-ID')}</span>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Notes
            </label>
            <textarea
              value={formData.notes}
              onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
              rows={2}
              placeholder="Internal notes about this quotation"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Terms & Conditions
            </label>
            <textarea
              value={formData.terms_conditions}
              onChange={(e) => setFormData({ ...formData, terms_conditions: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
              rows={3}
              placeholder="Terms and conditions for this quotation"
            />
          </div>

          <div className="flex justify-end gap-3 pt-4 border-t sticky bottom-0 bg-white">
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
              className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition"
            >
              {editingQuotation ? 'Update Quotation' : 'Create Quotation'}
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
