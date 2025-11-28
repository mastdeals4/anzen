import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';
import { Layout } from '../components/Layout';
import { AlertTriangle, TrendingUp, Package, Calendar, FileText } from 'lucide-react';

interface ImportRequirement {
  id: string;
  product_id: string;
  sales_order_id: string;
  customer_id: string;
  required_quantity: number;
  shortage_quantity: number;
  required_delivery_date: string;
  priority: 'high' | 'medium' | 'low';
  status: 'pending' | 'ordered' | 'partially_received' | 'received' | 'cancelled';
  lead_time_days: number;
  notes?: string;
  created_at: string;
  products?: {
    product_name: string;
    product_code: string;
  };
  sales_orders?: {
    so_number: string;
  };
  customers?: {
    customer_name: string;
    customer_code: string;
  };
}

interface StockInfo {
  product_id: string;
  total_stock: number;
  reserved_stock: number;
  free_stock: number;
}

export default function ImportRequirements() {
  const [requirements, setRequirements] = useState<ImportRequirement[]>([]);
  const [stockInfo, setStockInfo] = useState<Record<string, StockInfo>>({});
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('pending');
  const [priorityFilter, setPriorityFilter] = useState('all');

  useEffect(() => {
    fetchImportRequirements();
  }, [statusFilter]);

  const fetchImportRequirements = async () => {
    try {
      setLoading(true);
      let query = supabase
        .from('import_requirements')
        .select(`
          *,
          products (product_name, product_code),
          sales_orders (so_number),
          customers (customer_name, customer_code)
        `)
        .order('priority', { ascending: true })
        .order('required_delivery_date', { ascending: true });

      if (statusFilter !== 'all') {
        query = query.eq('status', statusFilter);
      }

      const { data, error } = await query;

      if (error) throw error;
      setRequirements(data || []);

      const productIds = [...new Set(data?.map(r => r.product_id))];
      if (productIds.length > 0) {
        await fetchStockInfo(productIds);
      }
    } catch (error: any) {
      console.error('Error fetching import requirements:', error.message);
      alert('Failed to load import requirements');
    } finally {
      setLoading(false);
    }
  };

  const fetchStockInfo = async (productIds: string[]) => {
    try {
      const stockMap: Record<string, StockInfo> = {};

      for (const productId of productIds) {
        const { data: batches } = await supabase
          .from('batches')
          .select('current_stock')
          .eq('product_id', productId);

        const totalStock = batches?.reduce((sum, b) => sum + Number(b.current_stock), 0) || 0;

        const { data: reservations } = await supabase
          .from('stock_reservations')
          .select('reserved_quantity')
          .eq('product_id', productId)
          .eq('status', 'active');

        const reservedStock = reservations?.reduce((sum, r) => sum + Number(r.reserved_quantity), 0) || 0;

        stockMap[productId] = {
          product_id: productId,
          total_stock: totalStock,
          reserved_stock: reservedStock,
          free_stock: totalStock - reservedStock
        };
      }

      setStockInfo(stockMap);
    } catch (error: any) {
      console.error('Error fetching stock info:', error.message);
    }
  };

  const handleStatusChange = async (requirementId: string, newStatus: string) => {
    try {
      const { error } = await supabase
        .from('import_requirements')
        .update({ status: newStatus, updated_at: new Date().toISOString() })
        .eq('id', requirementId);

      if (error) throw error;

      alert('Status updated successfully!');
      fetchImportRequirements();
    } catch (error: any) {
      console.error('Error updating status:', error.message);
      alert('Failed to update status');
    }
  };

  const getPriorityBadge = (priority: string) => {
    const config: Record<string, { color: string; label: string }> = {
      high: { color: 'bg-red-100 text-red-800', label: 'High' },
      medium: { color: 'bg-yellow-100 text-yellow-800', label: 'Medium' },
      low: { color: 'bg-green-100 text-green-800', label: 'Low' },
    };

    const { color, label } = config[priority] || config.medium;
    return (
      <span className={`px-2 py-1 text-xs font-medium rounded-full ${color}`}>
        {label}
      </span>
    );
  };

  const getStatusBadge = (status: string) => {
    const config: Record<string, { color: string; label: string }> = {
      pending: { color: 'bg-yellow-100 text-yellow-800', label: 'Pending' },
      ordered: { color: 'bg-blue-100 text-blue-800', label: 'Ordered' },
      partially_received: { color: 'bg-indigo-100 text-indigo-800', label: 'Partially Received' },
      received: { color: 'bg-green-100 text-green-800', label: 'Received' },
      cancelled: { color: 'bg-gray-100 text-gray-800', label: 'Cancelled' },
    };

    const { color, label } = config[status] || config.pending;
    return (
      <span className={`px-2 py-1 text-xs font-medium rounded-full ${color}`}>
        {label}
      </span>
    );
  };

  const getDaysUntilDelivery = (deliveryDate: string) => {
    const days = Math.ceil((new Date(deliveryDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
    return days;
  };

  const getUrgencyColor = (days: number) => {
    if (days < 7) return 'text-red-600 font-bold';
    if (days < 30) return 'text-yellow-600 font-medium';
    return 'text-green-600';
  };

  const filteredRequirements = requirements.filter(req => {
    if (priorityFilter === 'all') return true;
    return req.priority === priorityFilter;
  });

  const stats = {
    total: requirements.length,
    high_priority: requirements.filter(r => r.priority === 'high' && r.status === 'pending').length,
    pending: requirements.filter(r => r.status === 'pending').length,
    ordered: requirements.filter(r => r.status === 'ordered').length,
  };

  return (
    <Layout>
      <div className="p-6">
      <div className="mb-6">
        <h1 className="text-3xl font-bold text-gray-900">Import Requirements</h1>
        <p className="text-gray-600 mt-1">Track and manage product import needs based on stock shortages</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
        <div className="bg-white p-4 rounded-lg shadow">
          <div className="flex items-center gap-3">
            <Package className="w-8 h-8 text-blue-600" />
            <div>
              <div className="text-sm text-gray-600">Total Requirements</div>
              <div className="text-2xl font-bold text-gray-900">{stats.total}</div>
            </div>
          </div>
        </div>
        <div className="bg-white p-4 rounded-lg shadow">
          <div className="flex items-center gap-3">
            <AlertTriangle className="w-8 h-8 text-red-600" />
            <div>
              <div className="text-sm text-gray-600">High Priority</div>
              <div className="text-2xl font-bold text-red-600">{stats.high_priority}</div>
            </div>
          </div>
        </div>
        <div className="bg-white p-4 rounded-lg shadow">
          <div className="flex items-center gap-3">
            <Calendar className="w-8 h-8 text-yellow-600" />
            <div>
              <div className="text-sm text-gray-600">Pending</div>
              <div className="text-2xl font-bold text-yellow-600">{stats.pending}</div>
            </div>
          </div>
        </div>
        <div className="bg-white p-4 rounded-lg shadow">
          <div className="flex items-center gap-3">
            <TrendingUp className="w-8 h-8 text-green-600" />
            <div>
              <div className="text-sm text-gray-600">Ordered</div>
              <div className="text-2xl font-bold text-green-600">{stats.ordered}</div>
            </div>
          </div>
        </div>
      </div>

      <div className="bg-white rounded-lg shadow mb-6">
        <div className="p-4 border-b flex gap-4">
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="border rounded-lg px-4 py-2"
          >
            <option value="all">All Status</option>
            <option value="pending">Pending</option>
            <option value="ordered">Ordered</option>
            <option value="partially_received">Partially Received</option>
            <option value="received">Received</option>
            <option value="cancelled">Cancelled</option>
          </select>

          <select
            value={priorityFilter}
            onChange={(e) => setPriorityFilter(e.target.value)}
            className="border rounded-lg px-4 py-2"
          >
            <option value="all">All Priorities</option>
            <option value="high">High Priority</option>
            <option value="medium">Medium Priority</option>
            <option value="low">Low Priority</option>
          </select>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Priority</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Product</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Current Stock</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Shortage Qty</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Customer / SO</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Required Date</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Days Left</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
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
              ) : filteredRequirements.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-6 py-4 text-center text-gray-500">
                    No import requirements found
                  </td>
                </tr>
              ) : (
                filteredRequirements.map((req) => {
                  const stock = stockInfo[req.product_id];
                  const daysLeft = getDaysUntilDelivery(req.required_delivery_date);

                  return (
                    <tr key={req.id} className="hover:bg-gray-50">
                      <td className="px-6 py-4 whitespace-nowrap">
                        {getPriorityBadge(req.priority)}
                      </td>
                      <td className="px-6 py-4">
                        <div className="text-sm font-medium text-gray-900">{req.products?.product_name}</div>
                        <div className="text-xs text-gray-500">{req.products?.product_code}</div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        {stock ? (
                          <div className="text-sm">
                            <div>Total: <span className="font-medium">{stock.total_stock}</span></div>
                            <div className="text-xs text-gray-500">Free: {stock.free_stock}</div>
                          </div>
                        ) : (
                          <span className="text-gray-400">-</span>
                        )}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="text-sm font-medium text-red-600">{req.shortage_quantity}</div>
                      </td>
                      <td className="px-6 py-4">
                        <div className="text-sm text-gray-900">{req.customers?.customer_name}</div>
                        <div className="text-xs text-gray-500">{req.sales_orders?.so_number}</div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                        {new Date(req.required_delivery_date).toLocaleDateString()}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className={`text-sm ${getUrgencyColor(daysLeft)}`}>
                          {daysLeft > 0 ? `${daysLeft} days` : 'Overdue'}
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        {getStatusBadge(req.status)}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm">
                        <select
                          value={req.status}
                          onChange={(e) => handleStatusChange(req.id, e.target.value)}
                          className="border rounded px-2 py-1 text-sm"
                        >
                          <option value="pending">Pending</option>
                          <option value="ordered">Ordered</option>
                          <option value="partially_received">Partially Received</option>
                          <option value="received">Received</option>
                          <option value="cancelled">Cancelled</option>
                        </select>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
        <div className="flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-blue-600 mt-0.5" />
          <div>
            <h3 className="text-sm font-medium text-blue-900">About Import Requirements</h3>
            <p className="text-sm text-blue-700 mt-1">
              Import requirements are automatically generated when sales orders are approved but stock is insufficient.
              The system tracks shortages and helps procurement plan imports based on customer delivery dates and priorities.
            </p>
          </div>
        </div>
      </div>
      </div>
    </Layout>
  );
}
