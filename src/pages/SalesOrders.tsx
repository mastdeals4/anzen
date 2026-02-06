import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { useLanguage } from '../contexts/LanguageContext';
import { Layout } from '../components/Layout';
import { FileText, Plus, Search, Filter, Eye, Edit, Trash2, XCircle, FileCheck, CheckCircle, Paperclip, Download, ExternalLink } from 'lucide-react';
import { Modal } from '../components/Modal';
import SalesOrderForm from '../components/SalesOrderForm';
import { ProformaInvoiceView } from '../components/ProformaInvoiceView';
import { showToast } from '../components/ToastNotification';
import { showConfirm } from '../components/ConfirmDialog';

interface Customer {
  id: string;
  company_name: string;
}

interface Product {
  id: string;
  product_name: string;
  product_code: string;
}

interface SalesOrderItem {
  id: string;
  product_id: string;
  quantity: number;
  unit_price: number;
  discount_percent: number;
  discount_amount: number;
  tax_percent: number;
  tax_amount: number;
  line_total: number;
  item_delivery_date?: string;
  notes?: string;
  delivered_quantity: number;
  products?: Product;
}

interface SalesOrder {
  id: string;
  so_number: string;
  customer_id: string;
  customer_po_number: string;
  customer_po_date: string;
  customer_po_file_url?: string;
  so_date: string;
  currency: string;
  expected_delivery_date?: string;
  notes?: string;
  status: string;
  subtotal_amount: number;
  tax_amount: number;
  total_amount: number;
  created_by: string;
  created_at: string;
  approved_by?: string;
  approved_at?: string;
  rejected_by?: string;
  rejected_at?: string;
  rejection_reason?: string;
  customers?: Customer;
  sales_order_items?: SalesOrderItem[];
}

export default function SalesOrders() {
  const { user, profile } = useAuth();
  const { t } = useLanguage();
  const [activeTab, setActiveTab] = useState<'active' | 'archived'>('active');
  const [salesOrders, setSalesOrders] = useState<SalesOrder[]>([]);
  const [filteredOrders, setFilteredOrders] = useState<SalesOrder[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editingOrder, setEditingOrder] = useState<SalesOrder | null>(null);
  const [showRejectModal, setShowRejectModal] = useState(false);
  const [rejectionReason, setRejectionReason] = useState('');
  const [orderToReject, setOrderToReject] = useState<string | null>(null);
  const [showPOModal, setShowPOModal] = useState(false);
  const [selectedPOUrl, setSelectedPOUrl] = useState<string | null>(null);
  const [showArchiveModal, setShowArchiveModal] = useState(false);
  const [archiveReason, setArchiveReason] = useState('');
  const [orderToArchive, setOrderToArchive] = useState<string | null>(null);
  const [showProformaModal, setShowProformaModal] = useState(false);
  const [proformaOrder, setProformaOrder] = useState<SalesOrder | null>(null);

  useEffect(() => {
    fetchSalesOrders();
    fetchCustomers();
  }, [activeTab]);

  useEffect(() => {
    filterOrders();
  }, [searchTerm, statusFilter, salesOrders, activeTab]);

  const fetchSalesOrders = async () => {
    try {
      setLoading(true);
      let query = supabase
        .from('sales_orders')
        .select(`
          *,
          customers (
            id,
            company_name,
            address,
            city,
            phone,
            npwp,
            pharmacy_license,
            gst_vat_type
          ),
          sales_order_items (
            id,
            product_id,
            quantity,
            unit_price,
            discount_percent,
            discount_amount,
            tax_percent,
            tax_amount,
            line_total,
            item_delivery_date,
            notes,
            delivered_quantity,
            products (
              id,
              product_name,
              product_code,
              unit
            )
          )
        `);

      if (activeTab === 'active') {
        query = query.eq('is_archived', false);
      } else {
        query = query.eq('is_archived', true);
      }

      const { data, error } = await query.order('created_at', { ascending: false });

      if (error) throw error;
      setSalesOrders(data || []);
    } catch (error: any) {
      console.error('Error fetching sales orders:', error.message);
      showToast({ type: 'error', title: 'Error', message: t('errors.failedToLoadSalesOrders') });
    } finally {
      setLoading(false);
    }
  };

  const fetchCustomers = async () => {
    try {
      const { data, error } = await supabase
        .from('customers')
        .select('id, company_name')
        .eq('is_active', true)
        .order('company_name');

      if (error) throw error;
      setCustomers(data || []);
    } catch (error: any) {
      console.error('Error fetching customers:', error.message);
    }
  };

  const formatCurrency = (amount: number, currency: string) => {
    if (currency === 'USD') {
      return `$ ${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    }
    return `Rp ${amount.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };

  const filterOrders = () => {
    let filtered = salesOrders;

    if (searchTerm) {
      filtered = filtered.filter(order =>
        order.so_number.toLowerCase().includes(searchTerm.toLowerCase()) ||
        order.customer_po_number.toLowerCase().includes(searchTerm.toLowerCase()) ||
        order.customers?.company_name.toLowerCase().includes(searchTerm.toLowerCase())
      );
    }

    if (statusFilter !== 'all') {
      filtered = filtered.filter(order => order.status === statusFilter);
    }

    setFilteredOrders(filtered);
  };

  const getStatusBadge = (status: string) => {
    const statusConfig: Record<string, { color: string; label: string }> = {
      draft: { color: 'bg-gray-100 text-gray-800', label: t('common.draft') },
      pending_approval: { color: 'bg-yellow-100 text-yellow-800', label: t('common.pending') },
      approved: { color: 'bg-green-100 text-green-800', label: t('common.approved') },
      rejected: { color: 'bg-red-100 text-red-800', label: t('common.rejected') },
      stock_reserved: { color: 'bg-blue-100 text-blue-800', label: t('stock.reserved') },
      shortage: { color: 'bg-orange-100 text-orange-800', label: 'Shortage' },
      pending_delivery: { color: 'bg-purple-100 text-purple-800', label: 'Pending Delivery' },
      partially_delivered: { color: 'bg-indigo-100 text-indigo-800', label: 'Partially Delivered' },
      delivered: { color: 'bg-teal-100 text-teal-800', label: 'Delivered' },
      closed: { color: 'bg-gray-100 text-gray-800', label: 'Closed' },
      cancelled: { color: 'bg-red-100 text-red-800', label: t('common.cancelled') },
    };

    const config = statusConfig[status] || { color: 'bg-gray-100 text-gray-800', label: status };
    return (
      <span className={`px-2 py-1 text-xs font-medium rounded-full ${config.color}`}>
        {config.label}
      </span>
    );
  };

  const handleSubmitForApproval = async (orderId: string) => {
    if (!await showConfirm({ title: 'Confirm', message: t('salesOrders.submitForApproval') + '?', variant: 'warning' })) return;

    try {
      const { error } = await supabase
        .from('sales_orders')
        .update({ status: 'pending_approval', updated_at: new Date().toISOString() })
        .eq('id', orderId);

      if (error) throw error;

      showToast({ type: 'success', title: 'Success', message: t('success.salesOrderSubmitted') });
      fetchSalesOrders();
    } catch (error: any) {
      console.error('Error submitting for approval:', error.message);
      showToast({ type: 'error', title: 'Error', message: t('errors.failedToUpdate') });
    }
  };

  const handleArchiveOrder = async () => {
    if (!orderToArchive || !archiveReason.trim()) {
      showToast({ type: 'error', title: 'Error', message: t('validation.enterArchiveReason') });
      return;
    }

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const { error } = await supabase
        .from('sales_orders')
        .update({
          is_archived: true,
          archived_at: new Date().toISOString(),
          archived_by: user.id,
          archive_reason: archiveReason,
          updated_at: new Date().toISOString()
        })
        .eq('id', orderToArchive);

      if (error) throw error;

      showToast({ type: 'success', title: 'Success', message: t('success.salesOrderArchived') });
      setShowArchiveModal(false);
      setArchiveReason('');
      setOrderToArchive(null);
      fetchSalesOrders();
    } catch (error: any) {
      console.error('Error archiving order:', error.message);
      showToast({ type: 'error', title: 'Error', message: t('errors.failedToUpdate') });
    }
  };

  const handleUnarchiveOrder = async (orderId: string) => {
    if (!await showConfirm({ title: 'Confirm', message: t('common.unarchive') + '?', variant: 'warning' })) return;

    try {
      const { error } = await supabase
        .from('sales_orders')
        .update({
          is_archived: false,
          archived_at: null,
          archived_by: null,
          archive_reason: null,
          updated_at: new Date().toISOString()
        })
        .eq('id', orderId);

      if (error) throw error;

      showToast({ type: 'success', title: 'Success', message: t('success.salesOrderUnarchived') });
      fetchSalesOrders();
    } catch (error: any) {
      console.error('Error unarchiving order:', error.message);
      showToast({ type: 'error', title: 'Error', message: t('errors.failedToUpdate') });
    }
  };

  const handleCancelOrder = async (orderId: string) => {
    const reason = prompt('Enter cancellation reason:');
    if (!reason) return;

    try {
      const { data: { user: currentUser } } = await supabase.auth.getUser();
      if (!currentUser) throw new Error('Not authenticated');

      const { error } = await supabase.rpc('fn_cancel_sales_order', {
        p_so_id: orderId,
        p_canceller_id: currentUser.id,
        p_reason: reason
      });

      if (error) throw error;

      showToast({ type: 'success', title: 'Success', message: t('success.salesOrderCancelled') });
      fetchSalesOrders();
    } catch (error: any) {
      console.error('Error cancelling order:', error.message);
      showToast({ type: 'error', title: 'Error', message: 'Failed to cancel order' });
    }
  };

  const handleDeleteOrder = async (orderId: string) => {
    if (!await showConfirm({ title: 'Confirm', message: 'Are you sure you want to delete this sales order?', variant: 'danger', confirmLabel: 'Delete' })) return;

    try {
      const { error } = await supabase
        .from('sales_orders')
        .delete()
        .eq('id', orderId);

      if (error) throw error;

      showToast({ type: 'success', title: 'Success', message: 'Sales order deleted successfully!' });
      fetchSalesOrders();
    } catch (error: any) {
      console.error('Error deleting order:', error.message);
      showToast({ type: 'error', title: 'Error', message: 'Failed to delete order' });
    }
  };

  const handleViewOrder = (order: SalesOrder) => {
    setProformaOrder(order);
    setShowProformaModal(true);
  };

  const handleEditOrder = (order: SalesOrder) => {
    setEditingOrder(order);
    setShowCreateModal(true);
  };

  const handleApproveOrder = async (orderId: string) => {
    if (!await showConfirm({ title: 'Confirm', message: 'Approve this sales order? Stock will be reserved automatically.', variant: 'warning' })) return;

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      // Update order status to approved
      const { error: updateError } = await supabase
        .from('sales_orders')
        .update({
          status: 'approved',
          approved_by: user.id,
          approved_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
        .eq('id', orderId);

      if (updateError) throw updateError;

      // Call NEW stock reservation function (v2 - only reserves, doesn't deduct)
      const { data: reserveResult, error: reserveError } = await supabase
        .rpc('fn_reserve_stock_for_so_v2', { p_so_id: orderId });

      if (reserveError) {
        console.error('Error reserving stock:', reserveError);
        console.error('Supabase request failed', reserveError);
        showToast({ type: 'warning', title: 'Warning', message: 'Order approved but stock reservation failed: ' + reserveError.message });
      } else if (reserveResult && reserveResult.length > 0) {
        const result = reserveResult[0];
        if (result.success) {
          showToast({ type: 'success', title: 'Success', message: 'Sales order approved and stock fully reserved!' });
        } else {
          showToast({ type: 'warning', title: 'Warning', message: 'Order approved with stock shortage.\n\n' + result.message + '\n\nImport requirements have been created automatically.' });
        }
      } else {
        showToast({ type: 'success', title: 'Success', message: 'Sales order approved!' });
      }

      fetchSalesOrders();
    } catch (error: any) {
      console.error('Error approving order:', error.message);
      showToast({ type: 'error', title: 'Error', message: 'Failed to approve order' });
    }
  };

  const handleRejectOrder = async () => {
    if (!orderToReject || !rejectionReason.trim()) {
      showToast({ type: 'error', title: 'Error', message: 'Please enter a rejection reason' });
      return;
    }

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const { error } = await supabase
        .from('sales_orders')
        .update({
          status: 'rejected',
          rejected_by: user.id,
          rejected_at: new Date().toISOString(),
          rejection_reason: rejectionReason,
          updated_at: new Date().toISOString()
        })
        .eq('id', orderToReject);

      if (error) throw error;

      showToast({ type: 'success', title: 'Success', message: 'Sales order rejected' });
      setShowRejectModal(false);
      setRejectionReason('');
      setOrderToReject(null);
      fetchSalesOrders();
    } catch (error: any) {
      console.error('Error rejecting order:', error.message);
      showToast({ type: 'error', title: 'Error', message: 'Failed to reject order' });
    }
  };

  const handleViewPO = (poUrl: string) => {
    setSelectedPOUrl(poUrl);
    setShowPOModal(true);
  };

  const stats = {
    total: salesOrders.length,
    pending_approval: salesOrders.filter(o => o.status === 'pending_approval').length,
    stock_reserved: salesOrders.filter(o => o.status === 'stock_reserved').length,
    shortage: salesOrders.filter(o => o.status === 'shortage').length,
    delivered: salesOrders.filter(o => o.status === 'delivered').length,
  };

  return (
    <Layout>
      <div className="p-6">
        <div className="flex justify-between items-center mb-6">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Sales Orders</h1>
          <p className="text-gray-600 mt-1">Manage customer purchase orders and track delivery</p>
        </div>
        <button
          onClick={() => setShowCreateModal(true)}
          className="flex items-center gap-2 bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700"
        >
          <Plus className="w-5 h-5" />
          New Sales Order
        </button>
      </div>

      <div className="mb-6 border-b border-gray-200">
        <nav className="flex gap-4">
          <button
            onClick={() => setActiveTab('active')}
            className={`px-4 py-2 font-medium border-b-2 transition ${
              activeTab === 'active'
                ? 'border-blue-600 text-blue-600'
                : 'border-transparent text-gray-600 hover:text-gray-900'
            }`}
          >
            Active Orders
          </button>
          <button
            onClick={() => setActiveTab('archived')}
            className={`px-4 py-2 font-medium border-b-2 transition ${
              activeTab === 'archived'
                ? 'border-blue-600 text-blue-600'
                : 'border-transparent text-gray-600 hover:text-gray-900'
            }`}
          >
            Archived Orders
          </button>
        </nav>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3 md:gap-4 mb-6">
        <div className="bg-white p-3 md:p-4 rounded-lg shadow">
          <div className="text-xs md:text-sm text-gray-600 truncate">Total Orders</div>
          <div className="text-xl md:text-2xl font-bold text-gray-900">{stats.total}</div>
        </div>
        <div className="bg-white p-3 md:p-4 rounded-lg shadow">
          <div className="text-xs md:text-sm text-gray-600 truncate">Pending Approval</div>
          <div className="text-xl md:text-2xl font-bold text-yellow-600">{stats.pending_approval}</div>
        </div>
        <div className="bg-white p-3 md:p-4 rounded-lg shadow">
          <div className="text-xs md:text-sm text-gray-600 truncate">Stock Reserved</div>
          <div className="text-xl md:text-2xl font-bold text-blue-600">{stats.stock_reserved}</div>
        </div>
        <div className="bg-white p-3 md:p-4 rounded-lg shadow">
          <div className="text-xs md:text-sm text-gray-600 truncate">Shortage</div>
          <div className="text-xl md:text-2xl font-bold text-orange-600">{stats.shortage}</div>
        </div>
        <div className="bg-white p-3 md:p-4 rounded-lg shadow">
          <div className="text-xs md:text-sm text-gray-600 truncate">Delivered</div>
          <div className="text-xl md:text-2xl font-bold text-green-600">{stats.delivered}</div>
        </div>
      </div>

      <div className="bg-white rounded-lg shadow mb-6">
        <div className="p-4 border-b flex flex-col md:flex-row gap-4">
          <div className="flex-1 relative">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-5 h-5" />
            <input
              type="text"
              placeholder="Search by SO number, PO number, or customer..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full pl-10 pr-4 py-2 border rounded-lg"
            />
          </div>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="border rounded-lg px-4 py-2"
          >
            <option value="all">All Status</option>
            <option value="draft">Draft</option>
            <option value="pending_approval">Pending Approval</option>
            <option value="approved">Approved</option>
            <option value="stock_reserved">Stock Reserved</option>
            <option value="shortage">Shortage</option>
            <option value="pending_delivery">Pending Delivery</option>
            <option value="partially_delivered">Partially Delivered</option>
            <option value="delivered">Delivered</option>
            <option value="rejected">Rejected</option>
            <option value="cancelled">Cancelled</option>
          </select>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">SO Number</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Customer</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">PO Number</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">SO Date</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Delivery Date</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Amount</th>
                <th className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase">Docs</th>
                <th className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase">Status / Approval</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Actions</th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {loading ? (
                <tr>
                  <td colSpan={9} className="px-6 py-4 text-center text-gray-500">
                    Loading...
                  </td>
                </tr>
              ) : filteredOrders.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-6 py-4 text-center text-gray-500">
                    No sales orders found
                  </td>
                </tr>
              ) : (
                filteredOrders.map((order) => (
                  <tr key={order.id} className="hover:bg-gray-50">
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="text-sm font-medium text-gray-900">{order.so_number}</div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="text-sm text-gray-900">{order.customers?.company_name}</div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="text-sm text-gray-900">{order.customer_po_number}</div>
                      <div className="text-xs text-gray-500">{new Date(order.customer_po_date).toLocaleDateString()}</div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                      {new Date(order.so_date).toLocaleDateString()}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                      {order.expected_delivery_date ? new Date(order.expected_delivery_date).toLocaleDateString() : '-'}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">
                      {formatCurrency(order.total_amount, order.currency || 'IDR')}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="flex items-center justify-center">
                        {order.customer_po_file_url ? (
                          <button
                            onClick={() => handleViewPO(order.customer_po_file_url!)}
                            className="inline-flex items-center gap-1 px-3 py-1.5 bg-blue-50 text-blue-700 rounded-lg border border-blue-200 hover:bg-blue-100 transition"
                            title="View Customer PO"
                          >
                            <FileText className="w-4 h-4" />
                            <span className="text-sm font-medium">1</span>
                          </button>
                        ) : (
                          <span className="text-gray-400 text-sm">-</span>
                        )}
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="flex items-center justify-center gap-2">
                        {getStatusBadge(order.status)}
                        {order.status === 'pending_approval' && profile?.role === 'admin' && (
                          <div className="flex items-center gap-1 ml-2">
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                handleApproveOrder(order.id);
                              }}
                              className="p-2 bg-green-100 hover:bg-green-200 rounded-lg transition-colors"
                              title="Approve Order"
                            >
                              <CheckCircle className="w-6 h-6 text-green-600" />
                            </button>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                setOrderToReject(order.id);
                                setShowRejectModal(true);
                              }}
                              className="p-2 bg-red-100 hover:bg-red-200 rounded-lg transition-colors"
                              title="Reject Order"
                            >
                              <XCircle className="w-6 h-6 text-red-600" />
                            </button>
                          </div>
                        )}
                        {order.status === 'approved' && (
                          <CheckCircle className="w-5 h-5 text-green-600 ml-2" title="Approved" />
                        )}
                        {order.status === 'rejected' && (
                          <XCircle className="w-5 h-5 text-red-600 ml-2" title="Rejected" />
                        )}
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm">
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => handleViewOrder(order)}
                          className="text-blue-600 hover:text-blue-800"
                          title="View Proforma Invoice"
                        >
                          <Eye className="w-4 h-4" />
                        </button>
                        {!['delivered', 'closed', 'cancelled', 'partially_delivered', 'pending_delivery'].includes(order.status) && (
                          <button
                            onClick={() => handleEditOrder(order)}
                            className="text-indigo-600 hover:text-indigo-800"
                            title="Edit"
                          >
                            <Edit className="w-4 h-4" />
                          </button>
                        )}
                        {order.status === 'draft' && (
                          <>
                            <button
                              onClick={() => handleSubmitForApproval(order.id)}
                              className="text-green-600 hover:text-green-800"
                              title="Submit for Approval"
                            >
                              <FileCheck className="w-4 h-4" />
                            </button>
                            <button
                              onClick={() => handleDeleteOrder(order.id)}
                              className="text-red-600 hover:text-red-800"
                              title="Delete"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </>
                        )}
                        {!['cancelled', 'closed', 'delivered', 'rejected'].includes(order.status) && activeTab === 'active' && (
                          <button
                            onClick={() => handleCancelOrder(order.id)}
                            className="text-orange-600 hover:text-orange-800"
                            title="Cancel"
                          >
                            <XCircle className="w-4 h-4" />
                          </button>
                        )}
                        {activeTab === 'active' && ['admin', 'sales'].includes(profile?.role || '') && ['delivered', 'cancelled'].includes(order.status) && (
                          <button
                            onClick={() => {
                              setOrderToArchive(order.id);
                              setShowArchiveModal(true);
                            }}
                            className="text-gray-600 hover:text-gray-800"
                            title="Archive Order"
                          >
                            <FileText className="w-4 h-4" />
                          </button>
                        )}
                        {activeTab === 'archived' && ['admin', 'sales'].includes(profile?.role || '') && (
                          <button
                            onClick={() => handleUnarchiveOrder(order.id)}
                            className="text-green-600 hover:text-green-800"
                            title="Unarchive Order"
                          >
                            <FileCheck className="w-4 h-4" />
                          </button>
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

      {showCreateModal && (
        <Modal
          isOpen={showCreateModal}
          onClose={() => {
            setShowCreateModal(false);
            setEditingOrder(null);
          }}
          title={editingOrder ? "Edit Sales Order" : "Create Sales Order"}
          maxWidth="max-w-6xl"
        >
          <SalesOrderForm
            existingOrder={editingOrder || undefined}
            onSuccess={() => {
              setShowCreateModal(false);
              setEditingOrder(null);
              fetchSalesOrders();
            }}
            onCancel={() => {
              setShowCreateModal(false);
              setEditingOrder(null);
            }}
          />
        </Modal>
      )}

      {showRejectModal && (
        <Modal
          isOpen={showRejectModal}
          onClose={() => {
            setShowRejectModal(false);
            setRejectionReason('');
            setOrderToReject(null);
          }}
          title="Reject Sales Order"
        >
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Rejection Reason <span className="text-red-500">*</span>
              </label>
              <textarea
                value={rejectionReason}
                onChange={(e) => setRejectionReason(e.target.value)}
                rows={4}
                className="w-full border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-red-500"
                placeholder="Enter reason for rejecting this sales order..."
              />
            </div>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => {
                  setShowRejectModal(false);
                  setRejectionReason('');
                  setOrderToReject(null);
                }}
                className="px-4 py-2 border rounded-lg hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={handleRejectOrder}
                className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700"
                disabled={!rejectionReason.trim()}
              >
                Reject Order
              </button>
            </div>
          </div>
        </Modal>
      )}

      {showArchiveModal && (
        <Modal
          isOpen={showArchiveModal}
          onClose={() => {
            setShowArchiveModal(false);
            setArchiveReason('');
            setOrderToArchive(null);
          }}
          title="Archive Sales Order"
        >
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Archive Reason <span className="text-red-500">*</span>
              </label>
              <textarea
                value={archiveReason}
                onChange={(e) => setArchiveReason(e.target.value)}
                rows={4}
                className="w-full border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="Enter reason for archiving this sales order (e.g., Completed and delivered, Cancelled by customer)..."
              />
            </div>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => {
                  setShowArchiveModal(false);
                  setArchiveReason('');
                  setOrderToArchive(null);
                }}
                className="px-4 py-2 border rounded-lg hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={handleArchiveOrder}
                className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
                disabled={!archiveReason.trim()}
              >
                Archive Order
              </button>
            </div>
          </div>
        </Modal>
      )}

      {showPOModal && selectedPOUrl && (
        <Modal
          isOpen={showPOModal}
          onClose={() => {
            setShowPOModal(false);
            setSelectedPOUrl(null);
          }}
          title="Customer Purchase Order"
        >
          <div className="space-y-3">
            <a
              href={selectedPOUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-3 p-4 bg-gray-50 rounded-lg border border-gray-200 hover:bg-blue-50 hover:border-blue-300 transition"
            >
              <FileText className="w-6 h-6 text-blue-600 flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-900">Customer Purchase Order</p>
                <p className="text-xs text-gray-500 mt-1">Click to open in new tab</p>
              </div>
              <ExternalLink className="w-5 h-5 text-gray-400 flex-shrink-0" />
            </a>
            <div className="text-xs text-gray-500 text-center pt-2">
              Document opens in a new browser tab
            </div>
          </div>
        </Modal>
      )}

      {showProformaModal && proformaOrder && (
        <ProformaInvoiceView
          salesOrder={proformaOrder}
          items={proformaOrder.sales_order_items || []}
          onClose={() => {
            setShowProformaModal(false);
            setProformaOrder(null);
          }}
        />
      )}
      </div>
    </Layout>
  );
}
