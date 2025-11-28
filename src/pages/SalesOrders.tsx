import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { useLanguage } from '../contexts/LanguageContext';
import { Layout } from '../components/Layout';
import { FileText, Plus, Search, Filter, Eye, Edit, Trash2, XCircle, FileCheck, CheckCircle, Paperclip, Download } from 'lucide-react';
import { Modal } from '../components/Modal';
import SalesOrderForm from '../components/SalesOrderForm';

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
  const [salesOrders, setSalesOrders] = useState<SalesOrder[]>([]);
  const [filteredOrders, setFilteredOrders] = useState<SalesOrder[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showViewModal, setShowViewModal] = useState(false);
  const [selectedOrder, setSelectedOrder] = useState<SalesOrder | null>(null);
  const [editingOrder, setEditingOrder] = useState<SalesOrder | null>(null);
  const [showRejectModal, setShowRejectModal] = useState(false);
  const [rejectionReason, setRejectionReason] = useState('');
  const [orderToReject, setOrderToReject] = useState<string | null>(null);
  const [showPOModal, setShowPOModal] = useState(false);
  const [selectedPOUrl, setSelectedPOUrl] = useState<string | null>(null);

  useEffect(() => {
    fetchSalesOrders();
    fetchCustomers();
  }, []);

  useEffect(() => {
    filterOrders();
  }, [searchTerm, statusFilter, salesOrders]);

  const fetchSalesOrders = async () => {
    try {
      setLoading(true);
      const { data, error } = await supabase
        .from('sales_orders')
        .select(`
          *,
          customers (
            id,
            company_name
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
              product_code
            )
          )
        `)
        .order('created_at', { ascending: false });

      if (error) throw error;
      setSalesOrders(data || []);
    } catch (error: any) {
      console.error('Error fetching sales orders:', error.message);
      alert('Failed to load sales orders');
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
      draft: { color: 'bg-gray-100 text-gray-800', label: 'Draft' },
      pending_approval: { color: 'bg-yellow-100 text-yellow-800', label: 'Pending Approval' },
      approved: { color: 'bg-green-100 text-green-800', label: 'Approved' },
      rejected: { color: 'bg-red-100 text-red-800', label: 'Rejected' },
      stock_reserved: { color: 'bg-blue-100 text-blue-800', label: 'Stock Reserved' },
      shortage: { color: 'bg-orange-100 text-orange-800', label: 'Shortage' },
      pending_delivery: { color: 'bg-purple-100 text-purple-800', label: 'Pending Delivery' },
      partially_delivered: { color: 'bg-indigo-100 text-indigo-800', label: 'Partially Delivered' },
      delivered: { color: 'bg-teal-100 text-teal-800', label: 'Delivered' },
      closed: { color: 'bg-gray-100 text-gray-800', label: 'Closed' },
      cancelled: { color: 'bg-red-100 text-red-800', label: 'Cancelled' },
    };

    const config = statusConfig[status] || { color: 'bg-gray-100 text-gray-800', label: status };
    return (
      <span className={`px-2 py-1 text-xs font-medium rounded-full ${config.color}`}>
        {config.label}
      </span>
    );
  };

  const handleSubmitForApproval = async (orderId: string) => {
    if (!confirm('Submit this sales order for approval?')) return;

    try {
      const { error } = await supabase
        .from('sales_orders')
        .update({ status: 'pending_approval', updated_at: new Date().toISOString() })
        .eq('id', orderId);

      if (error) throw error;

      alert('Sales order submitted for approval successfully!');
      fetchSalesOrders();
    } catch (error: any) {
      console.error('Error submitting for approval:', error.message);
      alert('Failed to submit for approval');
    }
  };

  const handleCancelOrder = async (orderId: string) => {
    const reason = prompt('Enter cancellation reason:');
    if (!reason) return;

    try {
      const { error } = await supabase.rpc('fn_cancel_sales_order', {
        p_so_id: orderId,
        p_canceller_id: user?.id,
        p_reason: reason
      });

      if (error) throw error;

      alert('Sales order cancelled successfully!');
      fetchSalesOrders();
    } catch (error: any) {
      console.error('Error cancelling order:', error.message);
      alert('Failed to cancel order');
    }
  };

  const handleDeleteOrder = async (orderId: string) => {
    if (!confirm('Are you sure you want to delete this sales order?')) return;

    try {
      const { error } = await supabase
        .from('sales_orders')
        .delete()
        .eq('id', orderId);

      if (error) throw error;

      alert('Sales order deleted successfully!');
      fetchSalesOrders();
    } catch (error: any) {
      console.error('Error deleting order:', error.message);
      alert('Failed to delete order');
    }
  };

  const handleViewOrder = (order: SalesOrder) => {
    setSelectedOrder(order);
    setShowViewModal(true);
  };

  const handleEditOrder = (order: SalesOrder) => {
    setEditingOrder(order);
    setShowCreateModal(true);
  };

  const handleApproveOrder = async (orderId: string) => {
    if (!confirm('Approve this sales order? Stock will be reserved automatically.')) return;

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

      // Call stock reservation function
      const { error: reserveError } = await supabase
        .rpc('reserve_stock_for_sales_order', { p_sales_order_id: orderId });

      if (reserveError) {
        console.error('Error reserving stock:', reserveError);
        alert('Order approved but stock reservation failed. Please check inventory.');
      } else {
        alert('Sales order approved and stock reserved successfully!');
      }

      fetchSalesOrders();
    } catch (error: any) {
      console.error('Error approving order:', error.message);
      alert('Failed to approve order');
    }
  };

  const handleRejectOrder = async () => {
    if (!orderToReject || !rejectionReason.trim()) {
      alert('Please enter a rejection reason');
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

      alert('Sales order rejected');
      setShowRejectModal(false);
      setRejectionReason('');
      setOrderToReject(null);
      fetchSalesOrders();
    } catch (error: any) {
      console.error('Error rejecting order:', error.message);
      alert('Failed to reject order');
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

      <div className="grid grid-cols-1 md:grid-cols-5 gap-4 mb-6">
        <div className="bg-white p-4 rounded-lg shadow">
          <div className="text-sm text-gray-600">Total Orders</div>
          <div className="text-2xl font-bold text-gray-900">{stats.total}</div>
        </div>
        <div className="bg-white p-4 rounded-lg shadow">
          <div className="text-sm text-gray-600">Pending Approval</div>
          <div className="text-2xl font-bold text-yellow-600">{stats.pending_approval}</div>
        </div>
        <div className="bg-white p-4 rounded-lg shadow">
          <div className="text-sm text-gray-600">Stock Reserved</div>
          <div className="text-2xl font-bold text-blue-600">{stats.stock_reserved}</div>
        </div>
        <div className="bg-white p-4 rounded-lg shadow">
          <div className="text-sm text-gray-600">Shortage</div>
          <div className="text-2xl font-bold text-orange-600">{stats.shortage}</div>
        </div>
        <div className="bg-white p-4 rounded-lg shadow">
          <div className="text-sm text-gray-600">Delivered</div>
          <div className="text-2xl font-bold text-green-600">{stats.delivered}</div>
        </div>
      </div>

      <div className="bg-white rounded-lg shadow mb-6">
        <div className="p-4 border-b flex gap-4">
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
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Actions</th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {loading ? (
                <tr>
                  <td colSpan={8} className="px-6 py-4 text-center text-gray-500">
                    Loading...
                  </td>
                </tr>
              ) : filteredOrders.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-6 py-4 text-center text-gray-500">
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
                      Rp {order.total_amount.toLocaleString('id-ID', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      {getStatusBadge(order.status)}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm">
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => handleViewOrder(order)}
                          className="text-blue-600 hover:text-blue-800"
                          title="View"
                        >
                          <Eye className="w-4 h-4" />
                        </button>
                        {order.customer_po_file_url && (
                          <button
                            onClick={() => handleViewPO(order.customer_po_file_url!)}
                            className="text-purple-600 hover:text-purple-800"
                            title="View Customer PO"
                          >
                            <Paperclip className="w-4 h-4" />
                          </button>
                        )}
                        {(order.status === 'draft' || order.status === 'rejected') && (
                          <button
                            onClick={() => handleEditOrder(order)}
                            className="text-indigo-600 hover:text-indigo-800"
                            title="Edit"
                          >
                            <Edit className="w-4 h-4" />
                          </button>
                        )}
                        {order.status === 'pending_approval' && profile?.role === 'admin' && (
                          <>
                            <button
                              onClick={() => handleApproveOrder(order.id)}
                              className="text-green-600 hover:text-green-800"
                              title="Approve Order"
                            >
                              <CheckCircle className="w-4 h-4" />
                            </button>
                            <button
                              onClick={() => {
                                setOrderToReject(order.id);
                                setShowRejectModal(true);
                              }}
                              className="text-red-600 hover:text-red-800"
                              title="Reject Order"
                            >
                              <XCircle className="w-4 h-4" />
                            </button>
                          </>
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
                        {!['cancelled', 'closed', 'delivered', 'rejected'].includes(order.status) && (
                          <button
                            onClick={() => handleCancelOrder(order.id)}
                            className="text-orange-600 hover:text-orange-800"
                            title="Cancel"
                          >
                            <XCircle className="w-4 h-4" />
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

      {showViewModal && selectedOrder && (
        <Modal
          isOpen={showViewModal}
          onClose={() => {
            setShowViewModal(false);
            setSelectedOrder(null);
          }}
          title={`Sales Order: ${selectedOrder.so_number}`}
        >
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-sm font-medium text-gray-700">Customer</label>
                <p className="text-sm text-gray-900">{selectedOrder.customers?.company_name}</p>
              </div>
              <div>
                <label className="text-sm font-medium text-gray-700">Status</label>
                <div className="mt-1">{getStatusBadge(selectedOrder.status)}</div>
              </div>
              <div>
                <label className="text-sm font-medium text-gray-700">Customer PO Number</label>
                <p className="text-sm text-gray-900">{selectedOrder.customer_po_number}</p>
              </div>
              <div>
                <label className="text-sm font-medium text-gray-700">Customer PO Date</label>
                <p className="text-sm text-gray-900">{new Date(selectedOrder.customer_po_date).toLocaleDateString()}</p>
              </div>
              <div>
                <label className="text-sm font-medium text-gray-700">SO Date</label>
                <p className="text-sm text-gray-900">{new Date(selectedOrder.so_date).toLocaleDateString()}</p>
              </div>
              <div>
                <label className="text-sm font-medium text-gray-700">Expected Delivery</label>
                <p className="text-sm text-gray-900">
                  {selectedOrder.expected_delivery_date ? new Date(selectedOrder.expected_delivery_date).toLocaleDateString() : 'Not specified'}
                </p>
              </div>
            </div>

            {selectedOrder.notes && (
              <div>
                <label className="text-sm font-medium text-gray-700">Notes</label>
                <p className="text-sm text-gray-900 mt-1">{selectedOrder.notes}</p>
              </div>
            )}

            <div>
              <label className="text-sm font-medium text-gray-700 mb-2 block">Items</label>
              <table className="w-full text-sm">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-2 text-left">Product</th>
                    <th className="px-4 py-2 text-right">Qty</th>
                    <th className="px-4 py-2 text-right">Price</th>
                    <th className="px-4 py-2 text-right">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {selectedOrder.sales_order_items?.map((item) => (
                    <tr key={item.id} className="border-t">
                      <td className="px-4 py-2">{item.products?.product_name}</td>
                      <td className="px-4 py-2 text-right">{item.quantity}</td>
                      <td className="px-4 py-2 text-right">${item.unit_price.toFixed(2)}</td>
                      <td className="px-4 py-2 text-right">${item.line_total.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="bg-gray-50 font-medium">
                  <tr>
                    <td colSpan={3} className="px-4 py-2 text-right">Total:</td>
                    <td className="px-4 py-2 text-right">${selectedOrder.total_amount.toFixed(2)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>

            {selectedOrder.rejection_reason && (
              <div className="bg-red-50 p-3 rounded">
                <label className="text-sm font-medium text-red-700">Rejection Reason</label>
                <p className="text-sm text-red-900 mt-1">{selectedOrder.rejection_reason}</p>
              </div>
            )}
          </div>
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

      {showPOModal && selectedPOUrl && (
        <Modal
          isOpen={showPOModal}
          onClose={() => {
            setShowPOModal(false);
            setSelectedPOUrl(null);
          }}
          title="Customer Purchase Order"
          maxWidth="max-w-4xl"
        >
          <div className="space-y-4">
            {selectedPOUrl.toLowerCase().endsWith('.pdf') ? (
              <iframe
                src={selectedPOUrl}
                className="w-full h-[600px] border rounded-lg"
                title="Customer PO Document"
              />
            ) : (
              <img
                src={selectedPOUrl}
                alt="Customer PO Document"
                className="w-full h-auto rounded-lg"
              />
            )}
            <div className="flex gap-2 justify-end">
              <a
                href={selectedPOUrl}
                download
                className="flex items-center gap-2 bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700"
              >
                <Download className="w-4 h-4" />
                Download
              </a>
              <button
                onClick={() => {
                  setShowPOModal(false);
                  setSelectedPOUrl(null);
                }}
                className="px-4 py-2 border rounded-lg hover:bg-gray-50"
              >
                Close
              </button>
            </div>
          </div>
        </Modal>
      )}
      </div>
    </Layout>
  );
}
