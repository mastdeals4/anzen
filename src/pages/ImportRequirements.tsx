import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';
import { Layout } from '../components/Layout';
import { useLanguage } from '../contexts/LanguageContext';
import { AlertTriangle, Package, Layers, List, Search, TruckIcon } from 'lucide-react';
import { ImportRequirementsTable, type ImportRequirement, type ImportStatus, STATUS_OPTIONS } from '../components/ImportRequirementsTable';
import { ImportRequirementsProductSummary } from '../components/ImportRequirementsProductSummary';
import { showToast } from '../components/ToastNotification';

export interface ImportContainer {
  id: string;
  container_ref: string;
}

interface ProductSummaryRow {
  product_id: string;
  product_name: string;
  product_code: string;
  so_count: number;
  total_required_qty: number;
  total_ordered_qty: number;
  total_allocated_qty: number;
  total_received_qty: number;
  total_remaining_qty: number;
  procurement_summary_status: 'pending' | 'partial' | 'fully_ordered' | 'fully_received';
  earliest_delivery_date: string;
  highest_priority: 'high' | 'medium' | 'low';
}

type ViewMode = 'so_view' | 'product_summary';

export default function ImportRequirements() {
  const { t } = useLanguage();
  const [requirements, setRequirements] = useState<ImportRequirement[]>([]);
  const [productSummary, setProductSummary] = useState<ProductSummaryRow[]>([]);
  const [containers, setContainers] = useState<ImportContainer[]>([]);
  const [loading, setLoading] = useState(true);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>('product_summary');
  const [statusFilter, setStatusFilter] = useState<string>('active');
  const [priorityFilter, setPriorityFilter] = useState<string>('all');
  const [productSearch, setProductSearch] = useState<string>('');
  const [customerFilter, setCustomerFilter] = useState<string>('');
  const [customers, setCustomers] = useState<{ id: string; company_name: string }[]>([]);

  const canEdit = true;

  // "active" is a virtual filter meaning all non-cancelled, non-received
  const ACTIVE_STATUSES: ImportStatus[] = [
    'pending', 'rfq_sent', 'po_created', 'supplier_confirmed',
    'in_production', 'ready_to_ship', 'in_transit', 'customs_clearance',
    'ordered', 'partially_received',
  ];

  useEffect(() => {
    fetchRequirements();
    fetchCustomers();
    fetchContainers();
  }, [statusFilter]);

  useEffect(() => {
    if (viewMode === 'product_summary') {
      fetchProductSummary();
    }
  }, [viewMode]);

  // Also fetch summary on initial load since default view is product_summary
  useEffect(() => {
    fetchProductSummary();
  }, []);

  const fetchRequirements = async () => {
    try {
      setLoading(true);
      let query = supabase
        .from('import_requirements')
        .select(`
          *,
          products(product_name, product_code),
          sales_orders(so_number),
          customers(company_name),
          import_containers(id, container_ref)
        `)
        .order('priority', { ascending: true })
        .order('required_delivery_date', { ascending: true });

      if (statusFilter === 'active') {
        query = query.in('status', ACTIVE_STATUSES);
      } else if (statusFilter !== 'all') {
        query = query.eq('status', statusFilter as ImportStatus);
      }

      const { data, error } = await query;
      if (error) throw error;
      setRequirements(data || []);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      showToast({ type: 'error', title: t('common.error'), message: 'Failed to load import requirements: ' + msg });
    } finally {
      setLoading(false);
    }
  };

  const fetchProductSummary = async () => {
    try {
      setSummaryLoading(true);
      const { data, error } = await supabase
        .from('vw_import_requirements_by_product')
        .select('*');
      if (error) throw error;
      setProductSummary(data || []);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      showToast({ type: 'error', title: t('common.error'), message: 'Failed to load product summary: ' + msg });
    } finally {
      setSummaryLoading(false);
    }
  };

  const fetchCustomers = async () => {
    const { data } = await supabase
      .from('customers')
      .select('id, company_name')
      .order('company_name');
    setCustomers(data || []);
  };

  const fetchContainers = async () => {
    const { data } = await supabase
      .from('import_containers')
      .select('id, container_ref')
      .order('container_ref');
    setContainers(data || []);
  };

  // Apply client-side filters
  const filteredRequirements = requirements.filter(req => {
    if (priorityFilter !== 'all' && req.priority !== priorityFilter) return false;
    if (productSearch && !req.products?.product_name?.toLowerCase().includes(productSearch.toLowerCase()) &&
        !req.products?.product_code?.toLowerCase().includes(productSearch.toLowerCase())) return false;
    if (customerFilter && req.customer_id !== customerFilter) return false;
    return true;
  });

  const filteredSummary = productSummary.filter(row => {
    if (productSearch && !row.product_name?.toLowerCase().includes(productSearch.toLowerCase()) &&
        !row.product_code?.toLowerCase().includes(productSearch.toLowerCase())) return false;
    return true;
  });

  // Stats (based on active requirements — always uses full requirements list regardless of status filter)
  const stats = {
    products: new Set(requirements.map(r => r.product_id)).size,
    totalRequired: requirements.reduce((sum, r) => sum + r.required_quantity, 0),
    pending: requirements.filter(r => r.status === 'pending').length,
    inTransit: requirements.filter(r => r.status === 'in_transit' || r.status === 'customs_clearance').length,
    highPriority: requirements.filter(r => r.priority === 'high').length,
  };

  return (
    <Layout>
      <div className="space-y-4">
        {/* Header */}
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-xl sm:text-2xl font-bold text-gray-900">Import Requirements</h1>
            <p className="text-gray-500 text-sm mt-0.5">Procurement tracking — shortage analysis and fulfillment status</p>
          </div>
          {/* View Toggle */}
          <div className="flex rounded-lg border border-gray-200 overflow-hidden">
            <button
              onClick={() => setViewMode('product_summary')}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium transition-colors ${
                viewMode === 'product_summary'
                  ? 'bg-blue-600 text-white'
                  : 'bg-white text-gray-600 hover:bg-gray-50'
              }`}
            >
              <Layers className="w-4 h-4" />
              Product Summary
            </button>
            <button
              onClick={() => setViewMode('so_view')}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium transition-colors border-l border-gray-200 ${
                viewMode === 'so_view'
                  ? 'bg-blue-600 text-white'
                  : 'bg-white text-gray-600 hover:bg-gray-50'
              }`}
            >
              <List className="w-4 h-4" />
              By Sales Order
            </button>
          </div>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
          <div className="bg-white p-3 rounded-lg shadow-sm border border-gray-100">
            <div className="flex items-center gap-2">
              <Package className="w-4 h-4 text-blue-500 flex-shrink-0" />
              <div className="min-w-0">
                <div className="text-xs text-gray-500">Products</div>
                <div className="text-xl font-bold text-gray-900">{stats.products}</div>
              </div>
            </div>
          </div>
          <div className="bg-white p-3 rounded-lg shadow-sm border border-gray-100">
            <div className="flex items-center gap-2">
              <Package className="w-4 h-4 text-indigo-500 flex-shrink-0" />
              <div className="min-w-0">
                <div className="text-xs text-gray-500">Total Required</div>
                <div className="text-xl font-bold text-gray-900">{stats.totalRequired.toLocaleString()}</div>
              </div>
            </div>
          </div>
          <div className="bg-white p-3 rounded-lg shadow-sm border border-gray-100">
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0" />
              <div className="min-w-0">
                <div className="text-xs text-gray-500">High Priority</div>
                <div className="text-xl font-bold text-red-600">{stats.highPriority}</div>
              </div>
            </div>
          </div>
          <div className="bg-white p-3 rounded-lg shadow-sm border border-gray-100">
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-yellow-500 flex-shrink-0" />
              <div className="min-w-0">
                <div className="text-xs text-gray-500">Pending</div>
                <div className="text-xl font-bold text-yellow-600">{stats.pending}</div>
              </div>
            </div>
          </div>
          <div className="bg-white p-3 rounded-lg shadow-sm border border-gray-100">
            <div className="flex items-center gap-2">
              <TruckIcon className="w-4 h-4 text-orange-500 flex-shrink-0" />
              <div className="min-w-0">
                <div className="text-xs text-gray-500">In Transit / Customs</div>
                <div className="text-xl font-bold text-orange-600">{stats.inTransit}</div>
              </div>
            </div>
          </div>
        </div>

        {/* Filters + Table */}
        <div className="bg-white rounded-lg shadow-sm border border-gray-200">
          <div className="p-3 border-b flex flex-wrap gap-2 items-center">
            {/* Product Search */}
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input
                type="text"
                placeholder="Search product…"
                value={productSearch}
                onChange={(e) => setProductSearch(e.target.value)}
                className="pl-8 pr-3 py-1.5 border rounded-lg text-sm focus:ring-1 focus:ring-blue-500 outline-none w-44"
              />
            </div>

            {/* Status filter (SO view only) */}
            {viewMode === 'so_view' && (
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className="border rounded-lg px-2.5 py-1.5 text-sm focus:ring-1 focus:ring-blue-500 outline-none"
              >
                <option value="active">All Active</option>
                <option value="all">All Statuses</option>
                {STATUS_OPTIONS.map(opt => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            )}

            {/* Priority filter */}
            <select
              value={priorityFilter}
              onChange={(e) => setPriorityFilter(e.target.value)}
              className="border rounded-lg px-2.5 py-1.5 text-sm focus:ring-1 focus:ring-blue-500 outline-none"
            >
              <option value="all">All Priorities</option>
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
            </select>

            {/* Customer filter (SO view only) */}
            {viewMode === 'so_view' && (
              <select
                value={customerFilter}
                onChange={(e) => setCustomerFilter(e.target.value)}
                className="border rounded-lg px-2.5 py-1.5 text-sm focus:ring-1 focus:ring-blue-500 outline-none max-w-[180px]"
              >
                <option value="">All Customers</option>
                {customers.map(c => (
                  <option key={c.id} value={c.id}>{c.company_name}</option>
                ))}
              </select>
            )}

            <div className="ml-auto text-xs text-gray-400">
              {viewMode === 'so_view'
                ? `${filteredRequirements.length} requirement${filteredRequirements.length !== 1 ? 's' : ''}`
                : `${filteredSummary.length} product${filteredSummary.length !== 1 ? 's' : ''}`}
            </div>
          </div>

          {viewMode === 'so_view' ? (
            loading ? (
              <div className="p-10 text-center text-gray-400 text-sm">Loading…</div>
            ) : (
              <ImportRequirementsTable
                requirements={filteredRequirements}
                containers={containers}
                onRefresh={fetchRequirements}
                canEdit={canEdit}
              />
            )
          ) : (
            <ImportRequirementsProductSummary
              summaryRows={filteredSummary}
              detailRows={requirements.filter(r => r.status !== 'cancelled' && r.status !== 'received')}
              containers={containers}
              loading={summaryLoading || loading}
              onRefresh={() => { fetchRequirements(); fetchProductSummary(); }}
            />
          )}
        </div>
      </div>
    </Layout>
  );
}
