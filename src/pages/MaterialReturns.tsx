import React, { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { useLanguage } from '../contexts/LanguageContext';
import { Plus, Eye, Trash2, PackageX, AlertTriangle, Edit, CheckCircle, XCircle } from 'lucide-react';
import { Modal } from '../components/Modal';
import { DataTable } from '../components/DataTable';
import { MaterialReturnView } from '../components/MaterialReturnView';

interface MaterialReturn {
  id: string;
  return_number: string;
  return_date: string;
  return_type: string;
  return_reason: string;
  status: string;
  customers: {
    company_name: string;
  };
  delivery_challans?: {
    challan_number: string;
  };
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
}

interface ChallanItem {
  product_id: string;
  batch_id: string;
  quantity: number;
  products: {
    product_name: string;
    product_code: string;
  };
  batches: {
    batch_number: string;
    import_price: number;
    duty_charges: number;
    freight_charges: number;
    other_charges: number;
    import_quantity: number;
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

export default function MaterialReturns() {
  const { user, profile } = useAuth();
  const { t } = useLanguage();
  const [returns, setReturns] = useState<MaterialReturn[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [viewModalOpen, setViewModalOpen] = useState(false);
  const [selectedReturn, setSelectedReturn] = useState<any>(null);
  const [selectedReturnItems, setSelectedReturnItems] = useState<any[]>([]);
  const [editMode, setEditMode] = useState(false);
  const [editingReturnId, setEditingReturnId] = useState<string | null>(null);

  const [customers, setCustomers] = useState<Customer[]>([]);
  const [deliveryChallans, setDeliveryChallans] = useState<DeliveryChallan[]>([]);
  const [challanItems, setChallanItems] = useState<ChallanItem[]>([]);
  const [returnItems, setReturnItems] = useState<ReturnItem[]>([]);

  const [formData, setFormData] = useState({
    customer_id: '',
    original_dc_id: '',
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
          delivery_challans(challan_number)
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
      const { data: invoicesData, error: invoicesError } = await supabase
        .from('sales_invoices')
        .select('linked_challan_ids')
        .not('linked_challan_ids', 'is', null);

      if (invoicesError) throw invoicesError;

      const invoicedChallanIds = new Set<string>();
      (invoicesData || []).forEach(invoice => {
        if (invoice.linked_challan_ids && Array.isArray(invoice.linked_challan_ids)) {
          invoice.linked_challan_ids.forEach((id: string) => invoicedChallanIds.add(id));
        }
      });

      const { data, error } = await supabase
        .from('delivery_challans')
        .select('id, challan_number, challan_date, customer_id')
        .eq('customer_id', customerId)
        .order('challan_date', { ascending: false });

      if (error) throw error;

      const uninvoicedChallans = (data || []).filter(dc => !invoicedChallanIds.has(dc.id));
      setDeliveryChallans(uninvoicedChallans);
    } catch (error) {
      console.error('Error loading delivery challans:', error);
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

      setChallanItems(data || []);

      const items: ReturnItem[] = (data || []).map((item) => {
        const batch = item.batches;
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
          quantity_returned: 0,
          original_quantity: item.quantity,
          unit_price: unitPrice,
          condition: 'good',
          disposition: 'pending',
          notes: '',
        };
      });

      setReturnItems(items);
    } catch (error) {
      console.error('Error loading challan items:', error);
    }
  };

  const handleCustomerChange = (customerId: string) => {
    setFormData({ ...formData, customer_id: customerId, original_dc_id: '' });
    setChallanItems([]);
    setReturnItems([]);
    if (customerId) {
      loadDeliveryChallans(customerId);
    } else {
      setDeliveryChallans([]);
    }
  };

  const handleChallanChange = (challanId: string) => {
    setFormData({ ...formData, original_dc_id: challanId });
    if (challanId) {
      loadChallanItems(challanId);
    } else {
      setChallanItems([]);
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

    if (!formData.customer_id || !formData.original_dc_id || !formData.return_reason) {
      alert('Please complete all required fields');
      return;
    }

    const validItems = returnItems.filter(item => item.quantity_returned > 0);
    if (validItems.length === 0) {
      alert('Please enter at least one item with return quantity');
      return;
    }

    const hasInvalidQuantities = validItems.some(
      item => item.quantity_returned > item.original_quantity
    );
    if (hasInvalidQuantities) {
      alert('Return quantity cannot exceed original quantity');
      return;
    }

    try {
      const financialImpact = validItems.reduce((sum, item) =>
        sum + (item.quantity_returned * item.unit_price), 0
      );

      if (editMode && editingReturnId) {
        const { error: returnError } = await supabase
          .from('material_returns')
          .update({
            customer_id: formData.customer_id,
            original_dc_id: formData.original_dc_id,
            return_date: formData.return_date,
            return_type: formData.return_type,
            return_reason: formData.return_reason,
            notes: formData.notes,
            financial_impact: financialImpact,
          })
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

        alert('Material return updated successfully.');
      } else {
        const { data: returnData, error: returnError} = await supabase
          .from('material_returns')
          .insert({
            customer_id: formData.customer_id,
            original_dc_id: formData.original_dc_id,
            return_date: formData.return_date,
            return_type: formData.return_type,
            return_reason: formData.return_reason,
            notes: formData.notes,
            financial_impact: financialImpact,
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

        alert('Material return created successfully. Pending approval.');
      }

      setModalOpen(false);
      resetForm();
      loadReturns();
    } catch (error: any) {
      console.error('Error saving return:', error);
      alert(error.message || 'Failed to save material return');
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
      alert('Failed to load return details');
    }
  };

  const handleEdit = async (materialReturn: MaterialReturn) => {
    try {
      const { data: itemsData, error: itemsError } = await supabase
        .from('material_return_items')
        .select(`
          *,
          products(product_name, product_code),
          batches(batch_number, import_price, duty_charges, freight_charges, other_charges, import_quantity)
        `)
        .eq('return_id', materialReturn.id);

      if (itemsError) throw itemsError;

      setFormData({
        customer_id: materialReturn.customer_id,
        original_dc_id: materialReturn.original_dc_id,
        return_date: materialReturn.return_date,
        return_type: materialReturn.return_type,
        return_reason: materialReturn.return_reason,
        notes: materialReturn.notes || '',
      });

      await loadDeliveryChallans(materialReturn.customer_id);
      await loadChallanItems(materialReturn.original_dc_id);

      const mappedItems: ReturnItem[] = (itemsData || []).map((item) => ({
        product_id: item.product_id,
        batch_id: item.batch_id,
        quantity_returned: item.quantity_returned,
        original_quantity: item.original_quantity,
        unit_price: item.unit_price,
        condition: item.condition,
        disposition: item.disposition,
        notes: item.notes || '',
      }));

      setReturnItems(mappedItems);
      setEditMode(true);
      setEditingReturnId(materialReturn.id);
      setModalOpen(true);
    } catch (error) {
      console.error('Error loading return for edit:', error);
      alert('Failed to load return for editing');
    }
  };

  const handleApprove = async (id: string) => {
    if (!confirm('Approve this material return? Stock will be added back to inventory based on disposition.')) return;

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
      alert('Material return approved successfully');
      loadReturns();
    } catch (error: any) {
      console.error('Error approving return:', error);
      alert(error.message || 'Failed to approve material return');
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
      alert('Material return rejected');
      loadReturns();
    } catch (error: any) {
      console.error('Error rejecting return:', error);
      alert(error.message || 'Failed to reject material return');
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Are you sure you want to delete this material return?')) return;

    try {
      const { error } = await supabase
        .from('material_returns')
        .delete()
        .eq('id', id);

      if (error) throw error;
      loadReturns();
    } catch (error) {
      console.error('Error deleting return:', error);
      alert('Failed to delete material return');
    }
  };

  const resetForm = () => {
    setFormData({
      customer_id: '',
      original_dc_id: '',
      return_date: new Date().toISOString().split('T')[0],
      return_type: 'quality_issue',
      return_reason: '',
      notes: '',
    });
    setChallanItems([]);
    setReturnItems([]);
    setDeliveryChallans([]);
    setEditMode(false);
    setEditingReturnId(null);
  };

  const canManage = profile?.role === 'admin' || profile?.role === 'sales' || profile?.role === 'manager';
  const isManager = profile?.role === 'admin' || profile?.role === 'manager';

  const columns = [
    {
      key: 'return_number',
      label: 'Return #',
      render: (ret: MaterialReturn) => ret.return_number || 'Pending'
    },
    {
      key: 'return_date',
      label: 'Date',
      render: (ret: MaterialReturn) => new Date(ret.return_date).toLocaleDateString()
    },
    {
      key: 'customer',
      label: 'Customer',
      render: (ret: MaterialReturn) => ret.customers?.company_name || 'N/A'
    },
    {
      key: 'dc_number',
      label: 'Original DC',
      render: (ret: MaterialReturn) => ret.delivery_challans?.challan_number || 'N/A'
    },
    {
      key: 'return_type',
      label: 'Type',
      render: (ret: MaterialReturn) => ret.return_type.replace('_', ' ')
    },
    {
      key: 'status',
      label: 'Status',
      render: (ret: MaterialReturn) => (
        <span className={`inline-block px-2 py-1 rounded-full text-xs font-medium ${
          ret.status === 'approved' ? 'bg-green-100 text-green-800' :
          ret.status === 'rejected' ? 'bg-red-100 text-red-800' :
          ret.status === 'completed' ? 'bg-blue-100 text-blue-800' :
          'bg-yellow-100 text-yellow-800'
        }`}>
          {ret.status.replace('_', ' ')}
        </span>
      )
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Material Returns</h1>
          <p className="text-gray-600 mt-1">Manage physical returns before invoicing</p>
        </div>
        {canManage && (
          <button
            onClick={() => {
              resetForm();
              setModalOpen(true);
            }}
            className="flex items-center gap-2 bg-green-600 text-white px-4 py-2 rounded-lg hover:bg-green-700 transition"
          >
            <Plus className="w-5 h-5" />
            Create Material Return
          </button>
        )}
      </div>

      <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 flex gap-3">
        <AlertTriangle className="w-5 h-5 text-yellow-600 flex-shrink-0 mt-0.5" />
        <div className="text-sm text-yellow-800">
          <p className="font-medium">Material Returns vs Credit Notes:</p>
          <p className="mt-1">Use Material Returns for physical goods returned BEFORE invoice is made (e.g., DC 100kg → return 20kg). For returns AFTER invoice filing, use Credit Notes.</p>
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
                className="p-1 text-blue-600 hover:bg-blue-50 rounded"
                title="View Return"
              >
                <Eye className="w-4 h-4" />
              </button>

              {canManage && ret.status === 'pending_approval' && (
                <button
                  onClick={() => handleEdit(ret)}
                  className="p-1 text-yellow-600 hover:bg-yellow-50 rounded"
                  title="Edit Return"
                >
                  <Edit className="w-4 h-4" />
                </button>
              )}

              {isManager && ret.status === 'pending_approval' && (
                <>
                  <button
                    onClick={() => handleApprove(ret.id)}
                    className="p-1 text-green-600 hover:bg-green-50 rounded"
                    title="Approve Return"
                  >
                    <CheckCircle className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => handleReject(ret.id)}
                    className="p-1 text-red-600 hover:bg-red-50 rounded"
                    title="Reject Return"
                  >
                    <XCircle className="w-4 h-4" />
                  </button>
                </>
              )}

              {canManage && ret.status === 'pending_approval' && (
                <button
                  onClick={() => handleDelete(ret.id)}
                  className="p-1 text-red-600 hover:bg-red-50 rounded"
                  title="Delete Return"
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
        title={editMode ? "Edit Material Return" : "Create Material Return"}
        size="xl"
      >
        <form onSubmit={handleSubmit} className="space-y-6">
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
              <div className="flex items-start gap-3">
                <PackageX className="w-5 h-5 text-blue-600 flex-shrink-0 mt-0.5" />
                <div className="text-sm text-blue-800">
                  <p className="font-medium">How Material Returns Work:</p>
                  <ol className="mt-1 list-decimal list-inside space-y-1">
                    <li>Select the customer who is returning goods</li>
                    <li>Choose the Delivery Challan that was originally dispatched</li>
                    <li>The system will show all products, batches, quantities, and prices from that DC</li>
                    <li>Enter the quantity being returned for each item</li>
                    <li>After approval, stock will be added back to inventory</li>
                  </ol>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Customer *
                </label>
                <select
                  value={formData.customer_id}
                  onChange={(e) => handleCustomerChange(e.target.value)}
                  required
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent"
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
                  Original Delivery Challan *
                </label>
                <select
                  value={formData.original_dc_id}
                  onChange={(e) => handleChallanChange(e.target.value)}
                  required
                  disabled={!formData.customer_id}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent disabled:bg-gray-100"
                >
                  <option value="">Select Delivery Challan</option>
                  {deliveryChallans.map((dc) => (
                    <option key={dc.id} value={dc.id}>
                      {dc.challan_number} - {new Date(dc.challan_date).toLocaleDateString()}
                    </option>
                  ))}
                </select>
                {formData.customer_id && deliveryChallans.length === 0 && (
                  <p className="text-xs text-orange-600 mt-1">No uninvoiced delivery challans found. All DCs are already invoiced - use Credit Notes for returns after invoicing.</p>
                )}
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Return Date *
                </label>
                <input
                  type="date"
                  value={formData.return_date}
                  onChange={(e) => setFormData({ ...formData, return_date: e.target.value })}
                  required
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Return Type *
                </label>
                <select
                  value={formData.return_type}
                  onChange={(e) => setFormData({ ...formData, return_type: e.target.value })}
                  required
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent"
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
                value={formData.return_reason}
                onChange={(e) => setFormData({ ...formData, return_reason: e.target.value })}
                required
                rows={3}
                placeholder="Explain why the goods are being returned..."
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent"
              />
            </div>

            {challanItems.length > 0 && (
              <div className="border-t pt-6">
                <h4 className="text-sm font-semibold text-gray-900 mb-4">Items from Delivery Challan</h4>
                <p className="text-sm text-gray-600 mb-4">Enter the quantity being returned for each item. Leave as 0 if not returning that item.</p>

                <div className="space-y-3">
                  {challanItems.map((item, index) => {
                    const returnItem = returnItems[index];
                    if (!returnItem) return null;

                    return (
                      <div key={index} className="p-4 bg-gray-50 rounded-lg border border-gray-200">
                        <div className="grid grid-cols-12 gap-4">
                          <div className="col-span-3">
                            <label className="block text-xs text-gray-600 mb-1">Product</label>
                            <div className="text-sm font-medium text-gray-900">
                              {item.products.product_name}
                            </div>
                            <div className="text-xs text-gray-500">
                              Code: {item.products.product_code}
                            </div>
                          </div>

                          <div className="col-span-2">
                            <label className="block text-xs text-gray-600 mb-1">Batch</label>
                            <div className="text-sm font-medium text-gray-900">
                              {item.batches.batch_number}
                            </div>
                          </div>

                          <div className="col-span-2">
                            <label className="block text-xs text-gray-600 mb-1">Dispatched Qty (Kg)</label>
                            <div className="text-sm font-medium text-blue-600">
                              {item.quantity} Kg
                            </div>
                          </div>

                          <div className="col-span-1">
                            <label className="block text-xs text-gray-600 mb-1">Unit Price (per Kg)</label>
                            <div className="text-sm font-medium text-gray-900">
                              {returnItem.unit_price.toLocaleString()}
                            </div>
                          </div>

                          <div className="col-span-2">
                            <label className="block text-xs text-gray-600 mb-1">Return Qty (Kg) *</label>
                            <input
                              type="number"
                              step="0.01"
                              value={returnItem.quantity_returned || ''}
                              onChange={(e) => updateReturnItem(index, 'quantity_returned', parseFloat(e.target.value) || 0)}
                              max={item.quantity}
                              min="0"
                              className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded focus:ring-2 focus:ring-green-500"
                              placeholder="Enter Kg"
                            />
                            {returnItem.quantity_returned > item.quantity && (
                              <p className="text-xs text-red-600 mt-1">Cannot exceed {item.quantity}</p>
                            )}
                          </div>

                          <div className="col-span-2">
                            <label className="block text-xs text-gray-600 mb-1">Condition</label>
                            <select
                              value={returnItem.condition}
                              onChange={(e) => updateReturnItem(index, 'condition', e.target.value)}
                              className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded focus:ring-2 focus:ring-green-500"
                            >
                              <option value="good">Good</option>
                              <option value="damaged">Damaged</option>
                              <option value="expired">Expired</option>
                              <option value="unusable">Unusable</option>
                            </select>
                          </div>
                        </div>

                        {returnItem.quantity_returned > 0 && (
                          <div className="mt-3 grid grid-cols-2 gap-3">
                            <div>
                              <label className="block text-xs text-gray-600 mb-1">Disposition</label>
                              <select
                                value={returnItem.disposition}
                                onChange={(e) => updateReturnItem(index, 'disposition', e.target.value)}
                                className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded focus:ring-2 focus:ring-green-500"
                              >
                                <option value="pending">Pending Decision</option>
                                <option value="restock">Restock</option>
                                <option value="scrap">Scrap</option>
                                <option value="return_to_supplier">Return to Supplier</option>
                              </select>
                            </div>
                            <div>
                              <label className="block text-xs text-gray-600 mb-1">Notes (optional)</label>
                              <input
                                type="text"
                                value={returnItem.notes || ''}
                                onChange={(e) => updateReturnItem(index, 'notes', e.target.value)}
                                placeholder="Any additional notes..."
                                className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded focus:ring-2 focus:ring-green-500"
                              />
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {challanItems.length === 0 && formData.original_dc_id && (
              <div className="text-center py-8 text-gray-500">
                <PackageX className="w-12 h-12 mx-auto mb-2 text-gray-400" />
                <p>No items found in the selected delivery challan</p>
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Additional Notes
              </label>
              <textarea
                value={formData.notes}
                onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                rows={2}
                placeholder="Any additional information..."
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent"
              />
            </div>

            <div className="flex justify-end gap-3 pt-6 border-t">
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
                className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition"
              >
                {editMode ? 'Update Material Return' : 'Create Material Return'}
              </button>
          </div>
        </form>
      </Modal>

      {viewModalOpen && selectedReturn && (
        <MaterialReturnView
          materialReturn={selectedReturn}
          items={selectedReturnItems}
          onClose={() => {
            setViewModalOpen(false);
            setSelectedReturn(null);
            setSelectedReturnItems([]);
          }}
        />
      )}
    </div>
  );
}
