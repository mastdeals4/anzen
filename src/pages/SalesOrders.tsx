import { useState, useEffect, type ComponentProps } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { useNavigation } from '../contexts/NavigationContext';
import { useLanguage } from '../contexts/LanguageContext';
import { useFinance } from '../contexts/FinanceContext';
import { Layout } from '../components/Layout';
import { FileText, Plus, Search, Eye, Pencil as Edit, Trash2, XCircle, FileCheck, CheckCircle, Paperclip, Download, AlertTriangle, Clock, ExternalLink, Truck } from 'lucide-react';
import { Modal } from '../components/Modal';
import SalesOrderForm from '../components/SalesOrderForm';
import { ProformaInvoiceView } from '../components/ProformaInvoiceView';
import { DeliveryChallanView } from '../components/DeliveryChallanView';
import { InvoiceView } from '../components/InvoiceView';
import { loadInvoiceDisplayItems } from '../utils/invoiceItemDisplay';
import { showToast } from '../components/ToastNotification';
import { showConfirm } from '../components/ConfirmDialog';
import { formatDate } from '../utils/dateFormat';
import { fetchLinkedDocumentsBundle, LinkedDocRef } from '../utils/linkedDocuments';
import { LinkedDocsCell } from '../components/LinkedDocsCell';
import { useDebounce } from '../hooks/useDebounce';
import { fetchApprovedDeliverySalesOrderIds, getDeliveryAlertForOrder } from '../utils/salesOrderDeliveryAlerts';
import { resolveStorageUrlCached } from '../utils/signedUrlCache';

interface Customer {
  id: string;
  company_name: string;
  address?: string;
  city?: string;
  phone?: string;
  npwp?: string;
  pharmacy_license?: string;
  gst_vat_type?: string;
}

interface Product {
  id: string;
  product_name: string;
  product_code: string;
  unit: string;
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
  quoted_usd_unit_price?: number | null;
  products?: Product;
}

interface SODeliveryInvoiceStatus {
  so_id: string;
  delivery_status: 'pending' | 'partial' | 'completed';
  invoice_status: 'pending' | 'partial' | 'completed';
  special_status: string | null;
  approved_dc_count: number;
  invoice_count: number;
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
  expected_delivery_date?: string | null;
  notes?: string | null;
  status: string;
  subtotal_amount: number;
  tax_amount: number;
  total_amount: number;
  created_by: string;
  created_at: string;
  inquiry_id?: string | null;
  approved_by?: string;
  approved_at?: string;
  rejected_by?: string;
  rejected_at?: string;
  rejection_reason?: string;
  customers?: Customer;
  sales_order_items?: SalesOrderItem[];
}
interface LinkedDeliveryChallan { id: string; challan_number: string; challan_date: string; status: string; total_amount: number; }
interface LinkedSalesInvoice { id: string; invoice_number: string; invoice_date: string; payment_status: string; total_amount: number; }
type SortField = 'status' | 'date' | 'so_number' | 'customer' | 'amount';
type SortDirection = 'asc' | 'desc';

export default function SalesOrders() {
  const { profile } = useAuth();
  const { navigationData, clearNavigationData, setNavigationData, setCurrentPage } = useNavigation();
  const { t } = useLanguage();
  const { dateRange } = useFinance();
  const [activeTab, setActiveTab] = useState<'active' | 'archived'>('active');
  const [salesOrders, setSalesOrders] = useState<SalesOrder[]>([]);
  const [filteredOrders, setFilteredOrders] = useState<SalesOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editingOrder, setEditingOrder] = useState<SalesOrder | null>(null);
  const [createPrefill, setCreatePrefill] = useState<ComponentProps<typeof SalesOrderForm>['prefill']>();
  const [showRejectModal, setShowRejectModal] = useState(false);
  const [rejectionReason, setRejectionReason] = useState('');
  const [orderToReject, setOrderToReject] = useState<string | null>(null);
  const [showPOModal, setShowPOModal] = useState(false);
  const [selectedPOUrl, setSelectedPOUrl] = useState<string | null>(null);
  const [poBlobUrl, setPoBlobUrl] = useState<string | null>(null);
  const [poLoading, setPoLoading] = useState(false);
  const [showArchiveModal, setShowArchiveModal] = useState(false);
  const [archiveReason, setArchiveReason] = useState('');
  const [orderToArchive, setOrderToArchive] = useState<string | null>(null);
  const [showProformaModal, setShowProformaModal] = useState(false);
  const [proformaOrder, setProformaOrder] = useState<SalesOrder | null>(null);
  const [soStatuses, setSoStatuses] = useState<Map<string, SODeliveryInvoiceStatus>>(new Map());
  const [approvedDeliverySoIds, setApprovedDeliverySoIds] = useState<Set<string>>(new Set());
  const [soLinkedChallans, setSoLinkedChallans] = useState<Map<string, LinkedDeliveryChallan[]>>(new Map());
  const [soLinkedInvoices, setSoLinkedInvoices] = useState<Map<string, LinkedSalesInvoice[]>>(new Map());
  const [linkedChallanPreview, setLinkedChallanPreview] = useState<any | null>(null);
  const [linkedChallanItems, setLinkedChallanItems] = useState<any[]>([]);
  const [linkedInvoicePreview, setLinkedInvoicePreview] = useState<any | null>(null);
  const [linkedInvoiceItems, setLinkedInvoiceItems] = useState<any[]>([]);
  const [sortConfig, setSortConfig] = useState<{ field: SortField; direction: SortDirection }>({ field: 'date', direction: 'desc' });
  const debouncedSearchTerm = useDebounce(searchTerm, 250);

  useEffect(() => {
    fetchSalesOrders();
  }, [activeTab, dateRange.startDate, dateRange.endDate]);

  useEffect(() => {
    filterOrders();
  }, [debouncedSearchTerm, statusFilter, salesOrders, activeTab, soStatuses, approvedDeliverySoIds, sortConfig]);

  useEffect(() => {
    const requestedId = navigationData?.salesOrderId;
    if (typeof requestedId !== 'string' || !salesOrders.length) return;
    const requestedOrder = salesOrders.find((order) => order.id === requestedId);
    if (requestedOrder) {
      setProformaOrder(requestedOrder);
      setShowProformaModal(true);
      clearNavigationData();
    }
  }, [navigationData, salesOrders, clearNavigationData]);

  useEffect(() => {
    if (navigationData?.createSalesOrder !== true) return;
    const prefill = navigationData.salesOrderPrefill;
    setEditingOrder(null);
    setCreatePrefill(prefill && typeof prefill === 'object' ? prefill as ComponentProps<typeof SalesOrderForm>['prefill'] : undefined);
    setShowCreateModal(true);
    clearNavigationData();
  }, [navigationData, clearNavigationData]);

  const fetchSOStatuses = async (orderIds: string[]) => {
    if (orderIds.length === 0) return;
    try {
      const { data, error } = await supabase
        .from('so_delivery_invoice_status')
        .select('*')
        .in('so_id', orderIds);
      if (error) throw error;
      const map = new Map<string, SODeliveryInvoiceStatus>();
      (data || []).forEach((row: SODeliveryInvoiceStatus) => map.set(row.so_id, row));
      setSoStatuses(map);
    } catch (err) {
      console.error('Error fetching SO statuses:', err);
    }
  };

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
            quoted_usd_unit_price,
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

      query = query
        .gte('so_date', dateRange.startDate)
        .lte('so_date', dateRange.endDate);

      const { data, error } = await query.order('created_at', { ascending: false });

      if (error) throw error;
      setSalesOrders(data || []);
      const orderIds = (data || []).map((o: SalesOrder) => o.id);
      fetchSOStatuses(orderIds);
      fetchLinkedDocuments(orderIds);
      fetchApprovedDeliverySalesOrderIds(orderIds)
        .then(setApprovedDeliverySoIds)
        .catch((err) => {
          console.error('Error fetching approved delivery links:', err);
          setApprovedDeliverySoIds(new Set());
        });
    } catch (error: any) {
      console.error('Error fetching sales orders:', error.message);
      showToast({ type: 'error', title: 'Error', message: t('errors.failedToLoadSalesOrders') });
    } finally {
      setLoading(false);
    }
  };
  const fetchLinkedDocuments = async (orderIds: string[]) => {
    if (orderIds.length === 0) return;
    try {
      const { soMap } = await fetchLinkedDocumentsBundle();
      const dcMap = new Map<string, LinkedDeliveryChallan[]>();
      const invMap = new Map<string, LinkedSalesInvoice[]>();
      orderIds.forEach((id) => {
        const linked = soMap.get(id);
        dcMap.set(id, (linked?.dcs || []).map((dc) => ({ id: dc.id, challan_number: dc.number, challan_date: '', status: '', total_amount: 0 })));
        invMap.set(id, (linked?.invs || []).map((inv) => ({ id: inv.id, invoice_number: inv.number, invoice_date: '', payment_status: '', total_amount: 0 })));
      });
      setSoLinkedChallans(dcMap);
      setSoLinkedInvoices(invMap);
    } catch (err) {
      console.error('Error fetching linked SO docs:', err);
    }
  };


  const openLinkedChallanView = async (challanId: string) => {
    const [{ data: challan }, { data: items }] = await Promise.all([
      supabase.from('delivery_challans').select('*, customers(company_name, address, city, phone, pbf_license)').eq('id', challanId).maybeSingle(),
      supabase.from('delivery_challan_items').select('*, products(product_name, product_code, unit), batches(batch_number, expiry_date, packaging_details)').eq('challan_id', challanId)
    ]);
    if (!challan) return;
    setLinkedChallanPreview(challan);
    setLinkedChallanItems(items || []);
  };

  const openLinkedInvoiceView = async (invoiceId: string) => {
    const { data: invoice } = await supabase
      .from('sales_invoices')
      .select('*, customers(company_name, address, city, phone, npwp, pharmacy_license, gst_vat_type)')
      .eq('id', invoiceId)
      .maybeSingle();
    if (!invoice) return;
    const items = await loadInvoiceDisplayItems(supabase, invoice.id);
    setLinkedInvoicePreview(invoice);
    setLinkedInvoiceItems(items || []);
  };

  const formatCurrency = (amount: number, currency: string) => {
    if (currency === 'USD') {
      return `$ ${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    }
    return `Rp ${amount.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };

  type BusinessStatus = 'pending' | 'processing' | 'shortage' | 'delivered' | 'completed' | 'rejected' | 'cancelled';

  const businessStatusConfig: Record<BusinessStatus, { label: string; color: string }> = {
    pending: { label: 'Pending', color: 'bg-gray-100 text-gray-700' },
    processing: { label: 'Processing', color: 'bg-blue-100 text-blue-700' },
    shortage: { label: 'Shortage', color: 'bg-orange-100 text-orange-800' },
    delivered: { label: 'Delivered', color: 'bg-teal-100 text-teal-800' },
    completed: { label: 'Completed', color: 'bg-green-100 text-green-800' },
    rejected: { label: 'Rejected', color: 'bg-red-100 text-red-800' },
    cancelled: { label: 'Cancelled', color: 'bg-red-100 text-red-800' },
  };

  const getBusinessStatus = (order: SalesOrder): BusinessStatus => {
    if (order.status === 'cancelled') return 'cancelled';
    if (order.status === 'rejected') return 'rejected';
    if (order.status === 'shortage') return 'shortage';
    if (order.status === 'closed') return 'completed';
    if (order.status === 'delivered' || order.status === 'partially_delivered') return 'delivered';
    if (order.status === 'draft' || order.status === 'pending_approval') return 'pending';

    const s = soStatuses.get(order.id);
    if (s?.delivery_status === 'completed' && s?.invoice_status === 'completed') return 'completed';
    if (s?.delivery_status === 'completed') return 'delivered';
    if ((s?.approved_dc_count || 0) > 0 || (s?.invoice_count || 0) > 0) return 'processing';

    return 'processing';
  };

  const getOrderStatusBadge = (order: SalesOrder) => {
    const status = getBusinessStatus(order);
    const config = businessStatusConfig[status];
    return (
      <span className={`px-1.5 py-0.5 text-[11px] leading-tight font-semibold rounded-full ${config.color}`}>
        {config.label}
      </span>
    );
  };

  const statusSortRank: Record<BusinessStatus, number> = {
    pending: 1,
    processing: 2,
    shortage: 3,
    delivered: 4,
    completed: 5,
    rejected: 6,
    cancelled: 7,
  };

  const handleSort = (field: SortField) => {
    setSortConfig(current => ({
      field,
      direction: current.field === field && current.direction === 'asc' ? 'desc' : 'asc',
    }));
  };

  const sortIndicator = (field: SortField) => (
    sortConfig.field === field ? <span className="ml-1 text-blue-600">{sortConfig.direction === 'asc' ? '^' : 'v'}</span> : null
  );

  const sortableHeader = (field: SortField, label: string, className = 'px-3 py-2 text-left') => (
    <th className={`${className} text-xs font-medium text-gray-500 uppercase`}>
      <button
        type="button"
        onClick={() => handleSort(field)}
        className="inline-flex items-center gap-1 hover:text-gray-800"
      >
        {label}
        {sortIndicator(field)}
      </button>
    </th>
  );

  const filterOrders = () => {
    let filtered = salesOrders;

    if (debouncedSearchTerm) {
      const term = debouncedSearchTerm.toLowerCase().trim();
      filtered = filtered.filter(order =>
        order.so_number?.toLowerCase().includes(term) ||
        order.customer_po_number?.toLowerCase().includes(term) ||
        order.customers?.company_name?.toLowerCase().includes(term) ||
        order.sales_order_items?.some(item =>
          item.products?.product_name?.toLowerCase().includes(term) ||
          item.products?.product_code?.toLowerCase().includes(term)
        )
      );
    }

    if (statusFilter !== 'all') {
      filtered = filtered.filter(order => (
        statusFilter === 'overdue'
          ? getDeliveryAlert(order)?.level === 'overdue'
          : getBusinessStatus(order) === statusFilter
      ));
    }

    filtered = [...filtered].sort((a, b) => {
      let result = 0;
      if (sortConfig.field === 'status') {
        result = statusSortRank[getBusinessStatus(a)] - statusSortRank[getBusinessStatus(b)];
      } else if (sortConfig.field === 'date') {
        result = new Date(a.so_date || '').getTime() - new Date(b.so_date || '').getTime();
      } else if (sortConfig.field === 'so_number') {
        result = (a.so_number || '').localeCompare(b.so_number || '', undefined, { numeric: true, sensitivity: 'base' });
      } else if (sortConfig.field === 'customer') {
        result = (a.customers?.company_name || '').localeCompare(b.customers?.company_name || '', undefined, { sensitivity: 'base' });
      } else if (sortConfig.field === 'amount') {
        result = Number(a.total_amount || 0) - Number(b.total_amount || 0);
      }
      if (result === 0) {
        result = (a.so_number || '').localeCompare(b.so_number || '', undefined, { numeric: true, sensitivity: 'base' });
      }
      return sortConfig.direction === 'asc' ? result : -result;
    });

    setFilteredOrders(filtered);
  };

  const getDeliveryAlert = (order: SalesOrder) => {
    const status = soStatuses.get(order.id);
    return getDeliveryAlertForOrder({
      id: order.id,
      so_number: order.so_number,
      expected_delivery_date: order.expected_delivery_date || null,
      status: order.status,
      customers: order.customers || null,
    }, Number(status?.approved_dc_count || 0) > 0 || approvedDeliverySoIds.has(order.id));
  };

  const getDeliveryDueBadge = (order: SalesOrder) => {
    const alert = getDeliveryAlert(order);
    if (!alert) return null;

    if (alert.level === 'overdue') {
      return (
        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 mt-1 text-[11px] leading-tight font-medium rounded-full bg-red-100 text-red-700">
          <AlertTriangle className="w-3 h-3" />
          Overdue
        </span>
      );
    }

    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 mt-1 text-[11px] leading-tight font-medium rounded-full bg-yellow-100 text-yellow-700">
        <Clock className="w-3 h-3" />
        Due Soon
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

      const { data: reserveResult, error: reserveError } = await supabase
        .rpc('approve_sales_order_product_reservation_v2', {
          p_so_id: orderId,
          p_approved_by: user.id,
        });

      if (reserveError) {
        console.error('Error approving and reserving stock:', reserveError);
        console.error('Supabase request failed', reserveError);
        throw reserveError;
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

      // Fire email notification (non-blocking — don't fail if it errors)
      supabase.functions.invoke('send-app-notifications', {
        body: { type: 'so_approved', data: { so_id: orderId } }
      }).catch(() => {});

    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      console.error('Error approving order:', msg);
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

  const handleViewPO = async (poUrl: string) => {
    const signedUrl = await resolveStorageUrlCached(poUrl, 3600);
    setSelectedPOUrl(signedUrl);
    setShowPOModal(true);
    setPoLoading(true);
    setPoBlobUrl(null);
    try {
      const res = await fetch(signedUrl);
      if (!res.ok) {
        // Bucket missing or file deleted — show fallback, don't render error JSON
        setPoBlobUrl(null);
        return;
      }
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      setPoBlobUrl(blobUrl);
    } catch {
      setPoBlobUrl(null);
    } finally {
      setPoLoading(false);
    }
  };

  const handleDownloadPO = async (poUrl: string, filename?: string) => {
    try {
      const signedUrl = await resolveStorageUrlCached(poUrl, 3600);
      const res = await fetch(signedUrl);
      if (!res.ok) {
        showToast({ type: 'error', title: 'Download Failed', message: 'File not found. The storage bucket may not be set up yet.' });
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      // Try to get filename from URL, fallback to provided name or generic name
      const urlFilename = poUrl.split('/').pop()?.split('?')[0] || 'customer-po';
      a.download = filename || urlFilename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch {
      showToast({ type: 'error', title: 'Download Failed', message: 'Could not download the file.' });
    }
  };

  const stats = {
    total: salesOrders.length,
    processing: salesOrders.filter(o => getBusinessStatus(o) === 'processing').length,
    shortage: salesOrders.filter(o => getBusinessStatus(o) === 'shortage').length,
    completed: salesOrders.filter(o => getBusinessStatus(o) === 'completed').length,
    overdue: salesOrders.filter(o => getDeliveryAlert(o)?.level === 'overdue').length,
  };

  const summaryCards: Array<{
    key: BusinessStatus | 'all' | 'overdue';
    label: string;
    value: number;
    valueClass: string;
  }> = [
    { key: 'all', label: 'Total Orders', value: stats.total, valueClass: 'text-gray-900' },
    { key: 'processing', label: 'Processing', value: stats.processing, valueClass: 'text-blue-600' },
    { key: 'shortage', label: 'Shortage', value: stats.shortage, valueClass: 'text-orange-600' },
    { key: 'completed', label: 'Completed', value: stats.completed, valueClass: 'text-green-600' },
    { key: 'overdue', label: 'Overdue', value: stats.overdue, valueClass: 'text-red-600' },
  ];

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

      <div className="mb-4 border-b border-gray-200">
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

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3 mb-4">
        {summaryCards.map((card) => {
          const isActive = statusFilter === card.key;
          return (
            <button
              key={card.key}
              type="button"
              onClick={() => setStatusFilter(card.key)}
              className={`bg-white p-2.5 rounded-lg shadow text-left transition hover:shadow-md focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                isActive ? 'ring-2 ring-blue-500 bg-blue-50' : ''
              }`}
            >
              <div className="text-xs md:text-sm text-gray-600 truncate">{card.label}</div>
              <div className={`text-xl md:text-2xl font-bold ${card.valueClass}`}>{card.value}</div>
            </button>
          );
        })}
      </div>

      <div className="bg-white rounded-lg shadow mb-4 sales-transaction-table">
        <div className="p-2 border-b flex flex-col md:flex-row gap-2">
          <div className="flex-1 relative">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-4 h-4" />
            <input
              type="text"
              placeholder="Search by SO number, PO number, customer, or product..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full pl-9 pr-3 py-1.5 text-sm border rounded-lg"
            />
          </div>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="border rounded-lg px-3 py-1.5 text-sm"
          >
            <option value="all">All Status</option>
            <option value="pending">Pending</option>
            <option value="processing">Processing</option>
            <option value="shortage">Shortage</option>
            <option value="delivered">Delivered</option>
            <option value="completed">Completed</option>
            <option value="overdue">Overdue</option>
            <option value="rejected">Rejected</option>
            <option value="cancelled">Cancelled</option>
          </select>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[1200px]">
            <thead className="bg-gray-50">
              <tr>
                {sortableHeader('so_number', 'SO Number')}
                {sortableHeader('customer', 'Customer')}
                <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">PO Number</th>
                {sortableHeader('date', 'SO Date')}
                <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Delivery Date</th>
                {sortableHeader('amount', 'Amount', 'px-4 py-2 text-left')}
                <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase min-w-[150px]">Linked Docs</th>
                {sortableHeader('status', 'Order Status', 'px-3 py-2 text-center')}
                <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Actions</th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {loading ? (
                <tr>
                  <td colSpan={9} className="px-3 py-2 text-center text-gray-500">
                    Loading...
                  </td>
                </tr>
              ) : filteredOrders.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-3 py-2 text-center text-gray-500">
                    No sales orders found
                  </td>
                </tr>
              ) : (
                filteredOrders.map((order) => (
                  <tr key={order.id} className="hover:bg-gray-50">
                    <td className="px-3 py-2 whitespace-nowrap">
                      <div className="text-sm font-medium text-gray-900">{order.so_number}</div>
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <div className="text-sm text-gray-900">{order.customers?.company_name}</div>
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <div className="flex items-center gap-1">
                        <div className="text-sm text-gray-900">{order.customer_po_number}</div>
                        {order.customer_po_file_url && (
                          <>
                            <button
                              onClick={() => handleViewPO(order.customer_po_file_url!)}
                              className="text-blue-600 hover:text-blue-800"
                              title="View uploaded PO"
                              type="button"
                            >
                              <Paperclip className="w-3.5 h-3.5" />
                            </button>
                            <button
                              onClick={() => handleDownloadPO(order.customer_po_file_url!, order.customer_po_number || 'customer-po')}
                              className="text-gray-500 hover:text-gray-700"
                              title="Download uploaded PO"
                              type="button"
                            >
                              <Download className="w-3.5 h-3.5" />
                            </button>
                          </>
                        )}
                      </div>
                      <div className="text-xs text-gray-500">{formatDate(order.customer_po_date)}</div>
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap text-sm text-gray-500">
                      {formatDate(order.so_date)}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap text-sm text-gray-500">
                      <div>{order.expected_delivery_date ? formatDate(order.expected_delivery_date) : '-'}</div>
                      {getDeliveryDueBadge(order)}
                    </td>
                    <td className="px-4 py-2 whitespace-nowrap text-xs font-medium text-gray-900">{formatCurrency(order.total_amount, order.currency || 'IDR')}</td>
                    <td className="px-3 py-2 min-w-[150px]">
                      <LinkedDocsCell
                        sos={[]}
                        dcs={(soLinkedChallans.get(order.id) || []).map((dc) => ({ id: dc.id, number: dc.challan_number, type: 'dc' as const }))}
                        invs={(soLinkedInvoices.get(order.id) || []).map((inv) => ({ id: inv.id, number: inv.invoice_number, type: 'inv' as const }))}
                        show={{ so: false }}
                        onClick={(doc: LinkedDocRef) => { if (doc.type === 'dc') openLinkedChallanView(doc.id); if (doc.type === 'inv') openLinkedInvoiceView(doc.id); }}
                      />
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <div className="flex flex-col items-center gap-1">
                        {getOrderStatusBadge(order)}
                        {order.status === 'pending_approval' && (
                          <span className="text-[11px] text-yellow-700">Awaiting approval</span>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap text-sm">
                      <div className="flex items-center gap-2">
                        {order.status === 'pending_approval' && profile?.role === 'admin' && (
                          <>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                handleApproveOrder(order.id);
                              }}
                              className="inline-flex items-center gap-1 px-2 py-1 bg-green-600 text-white rounded text-xs hover:bg-green-700"
                              title="Approve Sales Order"
                            >
                              <CheckCircle className="w-3.5 h-3.5" />
                              Approve
                            </button>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                setOrderToReject(order.id);
                                setShowRejectModal(true);
                              }}
                              className="inline-flex items-center gap-1 px-2 py-1 bg-red-600 text-white rounded text-xs hover:bg-red-700"
                              title="Reject Sales Order"
                            >
                              <XCircle className="w-3.5 h-3.5" />
                              Reject
                            </button>
                          </>
                        )}
                        <button
                          onClick={() => handleViewOrder(order)}
                          className="text-blue-600 hover:text-blue-800"
                          title="View Sales Order"
                        >
                          <Eye className="w-4 h-4" />
                        </button>
                        {!['delivered', 'closed', 'cancelled', 'partially_delivered', 'pending_delivery'].includes(order.status) &&
                          (!['approved', 'stock_reserved', 'shortage'].includes(order.status) || profile?.role === 'admin') && (
                          <button
                            onClick={() => handleEditOrder(order)}
                            className="text-indigo-600 hover:text-indigo-800"
                            title={['approved', 'stock_reserved', 'shortage'].includes(order.status) ? 'Edit (Admin Only)' : 'Edit'}
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
                        {!['cancelled', 'closed', 'delivered', 'rejected'].includes(order.status) &&
                          activeTab === 'active' &&
                          (!['approved', 'stock_reserved', 'shortage', 'pending_delivery'].includes(order.status) || profile?.role === 'admin') && (
                          <button
                            onClick={() => handleCancelOrder(order.id)}
                            className="text-orange-600 hover:text-orange-800"
                            title="Cancel"
                          >
                            <XCircle className="w-4 h-4" />
                          </button>
                        )}
                        {['approved', 'stock_reserved', 'pending_delivery', 'partially_delivered'].includes(order.status)
                          && !approvedDeliverySoIds.has(order.id) && (
                          <button
                            onClick={() => {
                              setNavigationData({ createDeliveryChallanFromSO: order.id });
                              setCurrentPage('delivery-challan');
                            }}
                            className="text-green-600 hover:text-green-800"
                            title="Create Delivery Challan"
                          >
                            <Truck className="w-4 h-4" />
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
            existingOrder={(editingOrder as any) || undefined}
            prefill={!editingOrder ? createPrefill : undefined}
            onSuccess={() => {
              setShowCreateModal(false);
              setEditingOrder(null);
              setCreatePrefill(undefined);
              fetchSalesOrders();
            }}
            onCancel={() => {
              setShowCreateModal(false);
              setEditingOrder(null);
              setCreatePrefill(undefined);
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
            if (poBlobUrl) { URL.revokeObjectURL(poBlobUrl); setPoBlobUrl(null); }
          }}
          title="Customer Purchase Order"
          size="xl"
        >
          <div className="flex flex-col gap-2" style={{ height: '75vh' }}>
            {/* Action bar — always visible */}
            <div className="flex justify-end gap-2">
              <button
                onClick={() => handleDownloadPO(selectedPOUrl!)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs text-green-700 border border-green-200 rounded-lg hover:bg-green-50 transition"
              >
                <Download className="w-3.5 h-3.5" />
                Download
              </button>
              <a
                href={selectedPOUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs text-blue-600 border border-blue-200 rounded-lg hover:bg-blue-50 transition"
              >
                <ExternalLink className="w-3.5 h-3.5" />
                Open in new tab
              </a>
            </div>

            {poLoading && (
              <div className="flex-1 flex items-center justify-center bg-gray-50 rounded-lg border border-gray-200">
                <div className="text-center text-gray-500">
                  <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-2" />
                  <p className="text-sm">Loading document...</p>
                </div>
              </div>
            )}
            {!poLoading && poBlobUrl && (
              <iframe
                src={poBlobUrl}
                className="flex-1 w-full rounded-lg border border-gray-200"
                title="Customer Purchase Order"
              />
            )}
            {!poLoading && !poBlobUrl && (
              <div className="flex-1 flex items-center justify-center bg-gray-50 rounded-lg border border-gray-200">
                <div className="text-center text-gray-500 px-6">
                  <FileText className="w-10 h-10 mx-auto mb-3 text-gray-400" />
                  <p className="text-sm font-medium mb-2">Document cannot be previewed</p>
                  <p className="text-xs text-gray-400 mb-1">This usually means the storage bucket is not set up in Supabase.</p>
                  <p className="text-xs text-gray-400 mb-5">Please run the storage setup migration, then re-upload the file.</p>
                  <div className="flex justify-center gap-3">
                    <button
                      onClick={() => handleDownloadPO(selectedPOUrl!)}
                      className="inline-flex items-center gap-1.5 px-4 py-2 bg-green-600 text-white text-sm rounded-lg hover:bg-green-700 transition"
                    >
                      <Download className="w-4 h-4" />
                      Try Download
                    </button>
                    <a
                      href={selectedPOUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 transition"
                    >
                      <ExternalLink className="w-4 h-4" />
                      Open in new tab
                    </a>
                  </div>
                </div>
              </div>
            )}
          </div>
        </Modal>
      )}

      {showProformaModal && proformaOrder && (
        <ProformaInvoiceView
          salesOrder={proformaOrder as any}
          items={(proformaOrder.sales_order_items || []) as any}
          onClose={() => {
            setShowProformaModal(false);
            setProformaOrder(null);
          }}
          companyProfile={(proformaOrder as any).company_snapshot ?? undefined}
        />
      )}
      {linkedChallanPreview && (
        <DeliveryChallanView
          challan={linkedChallanPreview}
          items={linkedChallanItems}
          onClose={() => {
            setLinkedChallanPreview(null);
            setLinkedChallanItems([]);
          }}
          companyProfile={(linkedChallanPreview as any).company_snapshot ?? undefined}
        />
      )}

      {linkedInvoicePreview && (
        <InvoiceView
          invoice={linkedInvoicePreview}
          items={linkedInvoiceItems}
          onClose={() => {
            setLinkedInvoicePreview(null);
            setLinkedInvoiceItems([]);
          }}
        />
      )}

      </div>
    </Layout>
  );
}
