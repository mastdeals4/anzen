import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { useLanguage } from '../contexts/LanguageContext';
import { Layout } from '../components/Layout';
import { FileText, Plus, Search, Eye, Edit, Trash2, CheckCircle, XCircle, Download, Package } from 'lucide-react';
import { Modal } from '../components/Modal';
import { PurchaseOrderView } from '../components/PurchaseOrderView';
import { SearchableSelect } from '../components/SearchableSelect';
import { showToast } from '../components/ToastNotification';
import { showConfirm } from '../components/ConfirmDialog';

interface Supplier {
  id: string;
  company_name: string;
  contact_person?: string;
  email?: string;
  phone?: string;
}

interface Product {
  id: string;
  product_name: string;
  product_code: string;
  unit: string;
}

interface POItem {
  id?: string;
  line_number: number;
  product_id: string;
  description: string;
  quantity: number;
  unit: string;
  unit_price: number;
  discount_percent: number;
  discount_amount: number;
  line_total: number;
  quantity_received: number;
  quantity_pending: number;
  coa_code?: string;
  specification?: string;
  notes?: string;
  products?: Product;
}

interface PurchaseOrder {
  id: string;
  po_number: string;
  po_date: string;
  supplier_id: string;
  expected_delivery_date?: string;
  delivery_address?: string;
  currency: string;
  exchange_rate: number;
  subtotal: number;
  discount_amount: number;
  tax_amount: number;
  freight_amount: number;
  total_amount: number;
  status: string;
  payment_terms?: string;
  notes?: string;
  terms_conditions?: string;
  approved_by?: string;
  approved_at?: string;
  created_by: string;
  created_at: string;
  suppliers?: Supplier;
  purchase_order_items?: POItem[];
}

export default function PurchaseOrders() {
  const { user, profile } = useAuth();
  const { t } = useLanguage();
  const [purchaseOrders, setPurchaseOrders] = useState<PurchaseOrder[]>([]);
  const [filteredPOs, setFilteredPOs] = useState<PurchaseOrder[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showViewModal, setShowViewModal] = useState(false);
  const [selectedPO, setSelectedPO] = useState<PurchaseOrder | null>(null);
  const [editingPO, setEditingPO] = useState<PurchaseOrder | null>(null);

  // Form state
  const [formData, setFormData] = useState({
    supplier_id: '',
    po_date: new Date().toISOString().split('T')[0],
    expected_delivery_date: '',
    delivery_address: '',
    currency: 'IDR',
    exchange_rate: 1,
    payment_terms: 'Net 30',
    notes: '',
    terms_conditions: '',
  });
  const [poItems, setPOItems] = useState<POItem[]>([
    {
      line_number: 1,
      product_id: '',
      description: '',
      quantity: 0,
      unit: '',
      unit_price: 0,
      discount_percent: 0,
      discount_amount: 0,
      line_total: 0,
      quantity_received: 0,
      quantity_pending: 0,
      coa_code: '',
      specification: '',
    },
  ]);

  useEffect(() => {
    fetchPurchaseOrders();
    fetchSuppliers();
    fetchProducts();
  }, []);

  useEffect(() => {
    filterPOs();
  }, [searchTerm, statusFilter, purchaseOrders]);

  const fetchPurchaseOrders = async () => {
    try {
      setLoading(true);
      const { data, error } = await supabase
        .from('purchase_orders')
        .select(`
          *,
          suppliers (
            id,
            company_name,
            contact_person,
            email,
            phone,
            address
          ),
          purchase_order_items (
            *,
            products (
              id,
              product_name,
              product_code,
              unit
            )
          )
        `)
        .order('created_at', { ascending: false });

      if (error) throw error;
      setPurchaseOrders(data || []);
    } catch (error: any) {
      console.error('Error fetching purchase orders:', error.message);
      showToast({ type: 'error', title: 'Error', message: t('errors.failedToLoadPurchaseOrders') });
    } finally {
      setLoading(false);
    }
  };

  const fetchSuppliers = async () => {
    try {
      const { data, error } = await supabase
        .from('suppliers')
        .select('id, company_name, contact_person, email, phone')
        .eq('is_active', true)
        .order('company_name');

      if (error) throw error;
      setSuppliers(data || []);
    } catch (error: any) {
      console.error('Error fetching suppliers:', error.message);
    }
  };

  const fetchProducts = async () => {
    try {
      const { data, error } = await supabase
        .from('products')
        .select('id, product_name, product_code, unit')
        .eq('is_active', true)
        .order('product_name');

      if (error) throw error;
      setProducts(data || []);
    } catch (error: any) {
      console.error('Error fetching products:', error.message);
    }
  };

  const filterPOs = () => {
    let filtered = purchaseOrders;

    if (searchTerm) {
      filtered = filtered.filter(po =>
        po.po_number.toLowerCase().includes(searchTerm.toLowerCase()) ||
        po.suppliers?.company_name.toLowerCase().includes(searchTerm.toLowerCase())
      );
    }

    if (statusFilter !== 'all') {
      filtered = filtered.filter(po => po.status === statusFilter);
    }

    setFilteredPOs(filtered);
  };

  const getStatusBadge = (status: string) => {
    const statusConfig: Record<string, { color: string; label: string }> = {
      draft: { color: 'bg-gray-100 text-gray-800', label: t('common.draft') },
      pending_approval: { color: 'bg-yellow-100 text-yellow-800', label: t('common.pending') },
      approved: { color: 'bg-green-100 text-green-800', label: t('common.approved') },
      partially_received: { color: 'bg-blue-100 text-blue-800', label: 'Partially Received' },
      received: { color: 'bg-purple-100 text-purple-800', label: 'Received' },
      cancelled: { color: 'bg-red-100 text-red-800', label: 'Cancelled' },
    };

    const config = statusConfig[status] || statusConfig.draft;
    return (
      <span className={`px-2 py-1 text-xs font-medium rounded ${config.color}`}>
        {config.label}
      </span>
    );
  };

  const formatCurrency = (amount: number, currency: string) => {
    if (currency === 'USD') {
      return `$ ${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    }
    return `Rp ${amount.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };

  const handleCreateNew = () => {
    setEditingPO(null);
    setFormData({
      supplier_id: '',
      po_date: new Date().toISOString().split('T')[0],
      expected_delivery_date: '',
      delivery_address: '',
      currency: 'IDR',
      exchange_rate: 1,
      payment_terms: 'Net 30',
      notes: '',
      terms_conditions: '',
    });
    setPOItems([
      {
        line_number: 1,
        product_id: '',
        description: '',
        quantity: 0,
        unit: '',
        unit_price: 0,
        discount_percent: 0,
        discount_amount: 0,
        line_total: 0,
        quantity_received: 0,
        quantity_pending: 0,
      },
    ]);
    setShowCreateModal(true);
  };

  const handleEdit = (po: PurchaseOrder) => {
    setEditingPO(po);
    setFormData({
      supplier_id: po.supplier_id,
      po_date: po.po_date,
      expected_delivery_date: po.expected_delivery_date || '',
      delivery_address: po.delivery_address || '',
      currency: po.currency,
      exchange_rate: po.exchange_rate,
      payment_terms: po.payment_terms || 'Net 30',
      notes: po.notes || '',
      terms_conditions: po.terms_conditions || '',
    });
    setPOItems(po.purchase_order_items || []);
    setShowCreateModal(true);
  };

  const handleProductChange = (index: number, productId: string) => {
    const product = products.find(p => p.id === productId);
    if (product) {
      const newItems = [...poItems];
      newItems[index] = {
        ...newItems[index],
        product_id: productId,
        description: product.product_name,
        unit: product.unit,
        unit_price: 0,
      };
      calculateLineTotal(index, newItems);
      setPOItems(newItems);
    }
  };

  const calculateLineTotal = (index: number, items: POItem[]) => {
    const item = items[index];
    const subtotal = item.quantity * item.unit_price;
    const discount = (subtotal * item.discount_percent) / 100;
    items[index].discount_amount = discount;
    items[index].line_total = subtotal - discount;
  };

  const addPOItem = () => {
    setPOItems([
      ...poItems,
      {
        line_number: poItems.length + 1,
        product_id: '',
        description: '',
        quantity: 0,
        unit: '',
        unit_price: 0,
        discount_percent: 0,
        discount_amount: 0,
        line_total: 0,
        quantity_received: 0,
        quantity_pending: 0,
        coa_code: '',
        specification: '',
      },
    ]);
  };

  const removePOItem = (index: number) => {
    if (poItems.length > 1) {
      setPOItems(poItems.filter((_, i) => i !== index));
    }
  };

  const calculateTotals = () => {
    const subtotal = poItems.reduce((sum, item) => sum + item.line_total, 0);
    const tax = 0; // No tax for imports
    const total = subtotal;
    return { subtotal, tax, total };
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!formData.supplier_id) {
      showToast({ type: 'error', title: 'Error', message: t('validation.selectSupplier') });
      return;
    }

    if (!formData.po_date) {
      showToast({ type: 'error', title: 'Error', message: t('validation.selectDate') });
      return;
    }

    if (poItems.length === 0 || !poItems[0].product_id) {
      showToast({ type: 'error', title: 'Error', message: t('validation.addAtLeastOneProduct') });
      return;
    }

    for (let i = 0; i < poItems.length; i++) {
      const item = poItems[i];
      if (!item.product_id) {
        showToast({ type: 'error', title: 'Error', message: t('validation.selectProductForLine') + ` ${i + 1}` });
        return;
      }
      if (item.quantity <= 0) {
        showToast({ type: 'error', title: 'Error', message: t('validation.enterValidQuantityForLine') + ` ${i + 1}` });
        return;
      }
      if (item.unit_price <= 0) {
        showToast({ type: 'error', title: 'Error', message: t('validation.enterValidPriceForLine') + ` ${i + 1}` });
        return;
      }
    }

    try {
      const { subtotal, tax, total } = calculateTotals();

      const poData = {
        ...formData,
        subtotal,
        tax_amount: tax,
        total_amount: total,
        status: 'draft',
        created_by: user?.id,
      };

      if (editingPO) {
        // Update existing PO
        const { error: poError } = await supabase
          .from('purchase_orders')
          .update(poData)
          .eq('id', editingPO.id);

        if (poError) throw poError;

        // Delete old items
        await supabase
          .from('purchase_order_items')
          .delete()
          .eq('po_id', editingPO.id);

        // Insert new items (exclude generated and system columns)
        const itemsToInsert = poItems.map((item, index) => ({
          po_id: editingPO.id,
          line_number: index + 1,
          product_id: item.product_id,
          description: item.description,
          quantity: item.quantity,
          unit: item.unit,
          unit_price: item.unit_price,
          discount_percent: item.discount_percent || 0,
          discount_amount: item.discount_amount || 0,
          line_total: item.line_total,
          quantity_received: 0,
          coa_code: item.coa_code || null,
          specification: item.specification || null,
          notes: item.notes || null,
        }));

        const { error: itemsError } = await supabase
          .from('purchase_order_items')
          .insert(itemsToInsert);

        if (itemsError) throw itemsError;

        showToast({ type: 'success', title: 'Success', message: t('success.saved') });
      } else {
        // Create new PO
        const { data: newPO, error: poError } = await supabase
          .from('purchase_orders')
          .insert(poData)
          .select()
          .single();

        if (poError) throw poError;

        // Insert items (exclude generated and system columns)
        const itemsToInsert = poItems.map((item, index) => ({
          po_id: newPO.id,
          line_number: index + 1,
          product_id: item.product_id,
          description: item.description,
          quantity: item.quantity,
          unit: item.unit,
          unit_price: item.unit_price,
          discount_percent: item.discount_percent || 0,
          discount_amount: item.discount_amount || 0,
          line_total: item.line_total,
          quantity_received: 0,
          coa_code: item.coa_code || null,
          specification: item.specification || null,
          notes: item.notes || null,
        }));

        const { error: itemsError } = await supabase
          .from('purchase_order_items')
          .insert(itemsToInsert);

        if (itemsError) throw itemsError;

        showToast({ type: 'success', title: 'Success', message: t('success.saved') });
      }

      setShowCreateModal(false);
      fetchPurchaseOrders();
    } catch (error: any) {
      console.error('Error saving purchase order:', error);
      showToast({ type: 'error', title: 'Error', message: t('errors.failedToSave') + ': ' + error.message });
    }
  };

  const handleApprove = async (poId: string) => {
    if (!await showConfirm({ title: 'Confirm', message: 'Approve this Purchase Order?', variant: 'warning' })) return;

    try {
      const { error } = await supabase
        .from('purchase_orders')
        .update({
          status: 'approved',
          approved_by: user?.id,
          approved_at: new Date().toISOString(),
        })
        .eq('id', poId);

      if (error) throw error;

      showToast({ type: 'success', title: 'Success', message: t('success.saved') });
      fetchPurchaseOrders();
    } catch (error: any) {
      console.error('Error approving PO:', error);
      showToast({ type: 'error', title: 'Error', message: t('errors.failedToSave') + ': ' + error.message });
    }
  };

  const handleDelete = async (poId: string) => {
    if (!await showConfirm({ title: 'Confirm', message: 'Are you sure you want to delete this Purchase Order?', variant: 'danger', confirmLabel: 'Delete' })) return;

    try {
      const { error } = await supabase
        .from('purchase_orders')
        .delete()
        .eq('id', poId);

      if (error) throw error;

      showToast({ type: 'success', title: 'Success', message: t('success.deleted') });
      fetchPurchaseOrders();
    } catch (error: any) {
      console.error('Error deleting PO:', error);
      showToast({ type: 'error', title: 'Error', message: t('errors.failedToDelete') + ': ' + error.message });
    }
  };

  const handleView = (po: PurchaseOrder) => {
    setSelectedPO(po);
    setShowViewModal(true);
  };

  if (loading) {
    return (
      <Layout>
        <div className="flex items-center justify-center h-64">
          <div className="text-gray-500">Loading...</div>
        </div>
      </Layout>
    );
  }

  return (
    <Layout>
      <div className="p-6">
        {/* Header */}
        <div className="mb-6 flex justify-between items-center">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Purchase Orders</h1>
            <p className="text-gray-600">Manage procurement from suppliers</p>
          </div>
          <button
            onClick={handleCreateNew}
            className="flex items-center gap-2 bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700"
          >
            <Plus className="h-5 w-5" />
            New Purchase Order
          </button>
        </div>

        {/* Filters */}
        <div className="mb-6 flex flex-col md:flex-row gap-4">
          <div className="flex-1">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 h-5 w-5" />
              <input
                type="text"
                placeholder="Search PO number, supplier..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg"
              />
            </div>
          </div>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="px-4 py-2 border border-gray-300 rounded-lg"
          >
            <option value="all">All Status</option>
            <option value="draft">Draft</option>
            <option value="pending_approval">Pending Approval</option>
            <option value="approved">Approved</option>
            <option value="partially_received">Partially Received</option>
            <option value="received">Received</option>
            <option value="cancelled">Cancelled</option>
          </select>
        </div>

        {/* Table */}
        <div className="bg-white rounded-lg shadow overflow-hidden">
          <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">PO Number</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Date</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Supplier</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Products</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Total Amount</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Actions</th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {filteredPOs.map((po) => (
                <tr key={po.id} className="hover:bg-gray-50">
                  <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">
                    {po.po_number}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                    {new Date(po.po_date).toLocaleDateString()}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                    {po.suppliers?.company_name}
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-600">
                    <div className="flex flex-col gap-1 max-w-xs">
                      {po.purchase_order_items && po.purchase_order_items.length > 0 ? (
                        <>
                          {po.purchase_order_items.slice(0, 2).map((item, idx) => (
                            <div key={idx} className="flex items-center gap-1 text-xs">
                              <Package className="w-3 h-3 text-blue-500 flex-shrink-0" />
                              <span className="truncate">
                                {item.products?.product_name || item.description}
                                <span className="text-gray-400 ml-1">×{item.quantity}</span>
                              </span>
                            </div>
                          ))}
                          {po.purchase_order_items.length > 2 && (
                            <span className="text-xs text-gray-400 italic">
                              +{po.purchase_order_items.length - 2} more
                            </span>
                          )}
                        </>
                      ) : (
                        <span className="text-gray-400 text-xs italic">No items</span>
                      )}
                    </div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 font-medium">
                    {formatCurrency(po.total_amount, po.currency)}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    {getStatusBadge(po.status)}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                    <div className="flex gap-2">
                      <button
                        onClick={() => handleView(po)}
                        className="text-blue-600 hover:text-blue-800"
                        title="View"
                      >
                        <Eye className="h-5 w-5" />
                      </button>
                      {po.status === 'draft' && (
                        <>
                          <button
                            onClick={() => handleEdit(po)}
                            className="text-green-600 hover:text-green-800"
                            title="Edit"
                          >
                            <Edit className="h-5 w-5" />
                          </button>
                          <button
                            onClick={() => handleDelete(po.id)}
                            className="text-red-600 hover:text-red-800"
                            title="Delete"
                          >
                            <Trash2 className="h-5 w-5" />
                          </button>
                        </>
                      )}
                      {po.status === 'draft' && profile?.role === 'admin' && (
                        <button
                          onClick={() => handleApprove(po.id)}
                          className="text-purple-600 hover:text-purple-800"
                          title="Approve"
                        >
                          <CheckCircle className="h-5 w-5" />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
          {filteredPOs.length === 0 && (
            <div className="text-center py-12 text-gray-500">
              No purchase orders found
            </div>
          )}
        </div>

        {/* Create/Edit Modal */}
        {showCreateModal && (
          <Modal
            isOpen={showCreateModal}
            onClose={() => setShowCreateModal(false)}
            title={editingPO ? 'Edit Purchase Order' : 'New Purchase Order'}
            maxWidth="max-w-6xl"
          >
            <form onSubmit={handleSubmit} className="space-y-4">
              {/* Header Section - Compact */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Supplier *</label>
                  <SearchableSelect
                    value={formData.supplier_id}
                    onChange={(value) => setFormData({ ...formData, supplier_id: value })}
                    options={suppliers.map(s => ({ value: s.id, label: s.company_name }))}
                    placeholder="Select Supplier"
                    className="text-sm"
                    required
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">PO Date</label>
                  <input
                    type="date"
                    value={formData.po_date}
                    onChange={(e) => setFormData({ ...formData, po_date: e.target.value })}
                    className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded focus:ring-1 focus:ring-blue-500"
                    required
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Expected Delivery</label>
                  <input
                    type="date"
                    value={formData.expected_delivery_date}
                    onChange={(e) => setFormData({ ...formData, expected_delivery_date: e.target.value })}
                    className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded focus:ring-1 focus:ring-blue-500"
                  />
                </div>
              </div>

              {/* Currency and Payment Terms - Compact */}
              <div className="grid grid-cols-1 md:grid-cols-6 gap-3">
                <div className="col-span-1">
                  <label className="block text-xs font-medium text-gray-700 mb-1">Currency</label>
                  <select
                    value={formData.currency}
                    onChange={(e) => setFormData({ ...formData, currency: e.target.value })}
                    className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded focus:ring-1 focus:ring-blue-500"
                  >
                    <option value="IDR">IDR</option>
                    <option value="USD">USD</option>
                  </select>
                </div>
                <div className="col-span-5">
                  <label className="block text-xs font-medium text-gray-700 mb-1">Payment Terms</label>
                  <select
                    value={formData.payment_terms}
                    onChange={(e) => setFormData({ ...formData, payment_terms: e.target.value })}
                    className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded focus:ring-1 focus:ring-blue-500"
                    required
                  >
                    <option value="Net 7">Net 7</option>
                    <option value="Net 15">Net 15</option>
                    <option value="Net 30">Net 30</option>
                    <option value="Net 45">Net 45</option>
                    <option value="Net 60">Net 60</option>
                    <option value="Net 90">Net 90</option>
                    <option value="Advance">Advance Payment</option>
                    <option value="50-50">50% Advance & 50% on Delivery</option>
                    <option value="COD">Cash on Delivery</option>
                  </select>
                </div>
              </div>

              {/* Items - Compact Table */}
              <div>
                <div className="flex justify-between items-center mb-2">
                  <label className="block text-xs font-semibold text-gray-700">Items</label>
                  <button
                    type="button"
                    onClick={addPOItem}
                    className="text-xs text-blue-600 hover:text-blue-800 font-medium"
                  >
                    + Add Item
                  </button>
                </div>

                {/* Compact table with minimal spacing */}
                <div className="border border-gray-300 rounded overflow-x-auto">
                  <table className="min-w-full divide-y divide-gray-200">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="px-2 py-1.5 text-left text-xs font-medium text-gray-600 whitespace-nowrap" style={{width: '180px'}}>Product</th>
                        <th className="px-2 py-1.5 text-left text-xs font-medium text-gray-600 whitespace-nowrap" style={{width: '120px'}}>Specification</th>
                        <th className="px-2 py-1.5 text-left text-xs font-medium text-gray-600 whitespace-nowrap" style={{width: '80px'}}>COA No</th>
                        <th className="px-2 py-1.5 text-left text-xs font-medium text-gray-600 whitespace-nowrap" style={{width: '60px'}}>Qty</th>
                        <th className="px-2 py-1.5 text-left text-xs font-medium text-gray-600 whitespace-nowrap" style={{width: '50px'}}>Unit</th>
                        <th className="px-2 py-1.5 text-left text-xs font-medium text-gray-600 whitespace-nowrap" style={{width: '90px'}}>Price</th>
                        <th className="px-2 py-1.5 text-left text-xs font-medium text-gray-600 whitespace-nowrap" style={{width: '50px'}}>Disc%</th>
                        <th className="px-2 py-1.5 text-left text-xs font-medium text-gray-600 whitespace-nowrap" style={{width: '100px'}}>Total</th>
                        <th className="px-2 py-1.5 text-center text-xs font-medium text-gray-600" style={{width: '40px'}}></th>
                      </tr>
                    </thead>
                    <tbody className="bg-white divide-y divide-gray-200">
                      {poItems.map((item, index) => (
                        <tr key={index} className="hover:bg-gray-50">
                          <td className="px-2 py-1">
                            <SearchableSelect
                              value={item.product_id}
                              onChange={(value) => handleProductChange(index, value)}
                              options={products.map(p => ({ value: p.id, label: p.product_name }))}
                              placeholder="Select"
                              className="text-xs"
                              required
                            />
                          </td>
                          <td className="px-2 py-1">
                            <input
                              type="text"
                              value={item.specification || ''}
                              onChange={(e) => {
                                const newItems = [...poItems];
                                newItems[index].specification = e.target.value;
                                setPOItems(newItems);
                              }}
                              className="w-full px-1.5 py-1 text-xs border border-gray-300 rounded focus:ring-1 focus:ring-blue-500"
                              placeholder="Specs"
                            />
                          </td>
                          <td className="px-2 py-1">
                            <input
                              type="text"
                              value={item.coa_code || ''}
                              onChange={(e) => {
                                const newItems = [...poItems];
                                newItems[index].coa_code = e.target.value;
                                setPOItems(newItems);
                              }}
                              className="w-full px-1.5 py-1 text-xs border border-gray-300 rounded focus:ring-1 focus:ring-blue-500"
                              placeholder="COA"
                            />
                          </td>
                          <td className="px-2 py-1">
                            <input
                              type="number"
                              value={item.quantity}
                              onChange={(e) => {
                                const newItems = [...poItems];
                                newItems[index].quantity = parseFloat(e.target.value) || 0;
                                calculateLineTotal(index, newItems);
                                setPOItems(newItems);
                              }}
                              className="w-full px-1.5 py-1 text-xs border border-gray-300 rounded focus:ring-1 focus:ring-blue-500 text-right"
                              required
                            />
                          </td>
                          <td className="px-2 py-1">
                            <input
                              type="text"
                              value={item.unit}
                              className="w-full px-1.5 py-1 text-xs border border-gray-300 rounded bg-gray-50"
                              readOnly
                            />
                          </td>
                          <td className="px-2 py-1">
                            <input
                              type="number"
                              value={item.unit_price}
                              onChange={(e) => {
                                const newItems = [...poItems];
                                newItems[index].unit_price = parseFloat(e.target.value) || 0;
                                calculateLineTotal(index, newItems);
                                setPOItems(newItems);
                              }}
                              className="w-full px-1.5 py-1 text-xs border border-gray-300 rounded focus:ring-1 focus:ring-blue-500 text-right"
                              required
                            />
                          </td>
                          <td className="px-2 py-1">
                            <input
                              type="number"
                              value={item.discount_percent}
                              onChange={(e) => {
                                const newItems = [...poItems];
                                newItems[index].discount_percent = parseFloat(e.target.value) || 0;
                                calculateLineTotal(index, newItems);
                                setPOItems(newItems);
                              }}
                              className="w-full px-1.5 py-1 text-xs border border-gray-300 rounded focus:ring-1 focus:ring-blue-500 text-right"
                            />
                          </td>
                          <td className="px-2 py-1">
                            <input
                              type="text"
                              value={formatCurrency(item.line_total, formData.currency)}
                              readOnly
                              className="w-full px-1.5 py-1 text-xs border border-gray-300 rounded bg-gray-50 text-right font-medium"
                            />
                          </td>
                          <td className="px-2 py-1 text-center">
                            {poItems.length > 1 && (
                              <button
                                type="button"
                                onClick={() => removePOItem(index)}
                                className="text-red-600 hover:text-red-800 p-0.5"
                              >
                                <Trash2 className="h-4 w-4" />
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Totals - Compact */}
              <div className="border-t pt-2">
                <div className="flex justify-end">
                  <div className="w-56">
                    <div className="flex justify-between text-base font-bold bg-gray-50 px-3 py-2 rounded">
                      <span>Total:</span>
                      <span>{formatCurrency(calculateTotals().total, formData.currency)}</span>
                    </div>
                  </div>
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Notes</label>
                <textarea
                  value={formData.notes}
                  onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                  rows={2}
                  className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded focus:ring-1 focus:ring-blue-500"
                  placeholder="Additional notes or instructions..."
                />
              </div>

              <div className="flex justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                  className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
                >
                  {editingPO ? 'Update' : 'Create'} Purchase Order
                </button>
              </div>
            </form>
          </Modal>
        )}

        {showViewModal && selectedPO && (
          <PurchaseOrderView
            purchaseOrder={selectedPO}
            items={selectedPO.purchase_order_items || []}
            onClose={() => {
              setShowViewModal(false);
              setSelectedPO(null);
            }}
          />
        )}
      </div>
    </Layout>
  );
}
