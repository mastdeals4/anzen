import { useEffect, useState } from 'react';
import { Modal } from './Modal';
import { supabase } from '../lib/supabase';
import { formatDate } from '../utils/dateFormat';
import { loadInvoiceDisplayItems } from '../utils/invoiceItemDisplay';
import { ProformaInvoiceView } from './ProformaInvoiceView';
import { DeliveryChallanView } from './DeliveryChallanView';
import { InvoiceView } from './InvoiceView';
import { showToast } from './ToastNotification';
import { Search, ChevronDown, ChevronRight, Package, ExternalLink, Loader2 } from 'lucide-react';

export interface StockMovementsModalProps {
  isOpen: boolean;
  onClose: () => void;
  productId?: string;
  productName?: string;
  productCode?: string;
  batchId?: string;
  batchNumber?: string;
  unit?: string;
}

export function StockMovementsModal({
  isOpen,
  onClose,
  productId,
  productName,
  productCode,
  batchId,
  batchNumber,
  unit = 'KG',
}: StockMovementsModalProps) {
  const [loading, setLoading] = useState(false);
  const [transactionHistory, setTransactionHistory] = useState<any[]>([]);
  const [historyFilter, setHistoryFilter] = useState<'all' | 'in' | 'out' | 'reservations' | 'adjustments'>('all');
  const [historySearch, setHistorySearch] = useState('');
  const [expandedHistoryRows, setExpandedHistoryRows] = useState<Set<string>>(new Set());

  // Quick view states
  const [quickViewSO, setQuickViewSO] = useState<{ order: any; items: any[] } | null>(null);
  const [quickViewDC, setQuickViewDC] = useState<{ challan: any; items: any[] } | null>(null);
  const [quickViewInvoice, setQuickViewInvoice] = useState<{ invoice: any; items: any[] } | null>(null);

  useEffect(() => {
    if (isOpen && (batchId || productId)) {
      setHistoryFilter('all');
      setHistorySearch('');
      setExpandedHistoryRows(new Set());
      loadMovements();
    } else {
      setTransactionHistory([]);
    }
  }, [isOpen, batchId, productId]);

  const loadMovements = async () => {
    setLoading(true);
    try {
      let txnQuery = supabase
        .from('inventory_v1_effective_ledger')
        .select('*, batches(batch_number)')
        .or('metadata->>superseded.is.null,metadata->>superseded.neq.true')
        .order('transaction_date', { ascending: false })
        .order('created_at', { ascending: false });

      if (batchId) {
        txnQuery = txnQuery.eq('batch_id', batchId);
      } else if (productId) {
        txnQuery = txnQuery.eq('product_id', productId);
      }

      let resQuery = supabase
        .from('stock_reservations')
        .select('id, reserved_quantity, status, reserved_at, is_released, released_at, release_reason, batches(batch_number), sales_orders(so_number, customers(company_name))')
        .order('reserved_at', { ascending: false });

      if (batchId) {
        resQuery = resQuery.eq('batch_id', batchId);
      } else if (productId) {
        resQuery = resQuery.eq('product_id', productId);
      }

      const [txnResult, resResult] = await Promise.all([txnQuery, resQuery]);

      if (txnResult.error) {
        console.error('Error loading transaction history:', txnResult.error);
        showToast({ type: 'error', title: 'Error', message: 'Error loading transaction history: ' + txnResult.error.message });
        return;
      }

      const enrichedTxns = await Promise.all((txnResult.data || []).map(async (txn: any) => {
        let dcData = null;
        let soData = null;
        let customerData = null;
        let invoiceData = null;

        // For DC-type transactions
        if (txn.reference_number && txn.reference_number.startsWith('DO-')) {
          const { data: dc } = await supabase
            .from('delivery_challans')
            .select('challan_number, sales_order_id, customer_id, customers(company_name), sales_orders(so_number)')
            .eq('challan_number', txn.reference_number)
            .maybeSingle();
          dcData = dc;
          if (dc?.customers) customerData = dc.customers;
          if (dc?.sales_orders) soData = dc.sales_orders;
        }

        // For sale transactions via invoice
        if (txn.transaction_type === 'sale' && txn.reference_type === 'sales_invoice_item' && txn.reference_id) {
          const { data: sii } = await supabase
            .from('sales_invoice_items')
            .select(`
              delivery_challan_item_id,
              invoice_id,
              sales_invoices(invoice_number, sales_order_id, customer_id, customers(company_name), sales_orders(so_number)),
              delivery_challan_items(challan_id, delivery_challans(challan_number, sales_order_id, sales_orders(so_number)))
            `)
            .eq('id', txn.reference_id)
            .maybeSingle();

          if (sii) {
            const si = sii.sales_invoices as any;
            if (si?.customers) customerData = si.customers;
            if (si?.sales_orders) soData = si.sales_orders;
            invoiceData = { invoice_number: si?.invoice_number };
            const dci = sii.delivery_challan_items as any;
            if (dci?.delivery_challans) {
              dcData = dci.delivery_challans;
              if (!soData && dci.delivery_challans.sales_orders) soData = dci.delivery_challans.sales_orders;
            }
          }
        }

        // Direct SO lookup
        if (!soData && txn.sales_order_id) {
          const { data: so } = await supabase
            .from('sales_orders')
            .select('so_number, customer_id, customers(company_name)')
            .eq('id', txn.sales_order_id)
            .maybeSingle();
          soData = so;
          if (so?.customers) customerData = so.customers;
        }

        return {
          ...txn,
          batch_number: txn.batches?.batch_number || batchNumber,
          delivery_challans: dcData,
          sales_orders: soData,
          customer: customerData,
          invoice: invoiceData,
          _type: 'transaction' as const
        };
      }));

      const reservationEntries = (resResult.data || []).map((r: any) => ({
        id: r.id,
        _type: 'reservation' as const,
        quantity: r.reserved_quantity,
        status: r.status,
        is_released: r.is_released,
        released_at: r.released_at,
        release_reason: r.release_reason,
        created_at: r.reserved_at,
        transaction_date: r.reserved_at?.split('T')[0] || '',
        transaction_type: r.status === 'active' ? 'reserved' : 'reservation_released',
        batch_number: r.batches?.batch_number || batchNumber,
        so_number: r.sales_orders?.so_number,
        customer_name: r.sales_orders?.customers?.company_name,
      }));

      // Group repeated reservation events for the same SO on this batch/product
      const soReservationTimelineMap: Record<string, any[]> = {};
      reservationEntries.forEach((r: any) => {
        if (r.so_number) {
          if (!soReservationTimelineMap[r.so_number]) {
            soReservationTimelineMap[r.so_number] = [];
          }
          soReservationTimelineMap[r.so_number].push(r);
        }
      });

      // Sort chronologically (oldest first) to compute accurate running physical stock
      const chronological = [...enrichedTxns, ...reservationEntries].sort((a: any, b: any) => {
        const timeA = new Date(a.created_at || a.transaction_date).getTime();
        const timeB = new Date(b.created_at || b.transaction_date).getTime();
        if (timeA !== timeB) return timeA - timeB;
        const qtyA = parseFloat(a.quantity) || 0;
        const qtyB = parseFloat(b.quantity) || 0;
        return qtyB - qtyA;
      });

      let runningPhysicalStock = 0;
      const enrichedWithStock = chronological.map((item: any) => {
        const isPhysical = item._type === 'transaction' && item.is_effective !== false;
        const qty = parseFloat(item.quantity) || 0;
        const stockBefore = runningPhysicalStock;
        if (isPhysical) {
          runningPhysicalStock += qty;
        }
        const stockAfter = runningPhysicalStock;
        const soNum = item.so_number || item.sales_orders?.so_number;
        const soTimeline = soNum && soReservationTimelineMap[soNum] ? soReservationTimelineMap[soNum] : [];

        return {
          ...item,
          stock_before: stockBefore,
          stock_after: stockAfter,
          so_timeline: soTimeline,
        };
      });

      // Default: Newest first
      const newestFirst = enrichedWithStock.sort(
        (a: any, b: any) => new Date(b.created_at || b.transaction_date).getTime() - new Date(a.created_at || a.transaction_date).getTime()
      );

      setTransactionHistory(newestFirst);
    } catch (err: any) {
      console.error('Failed to load stock movements:', err);
      showToast({ type: 'error', title: 'Error', message: err.message || 'Failed to load stock movements' });
    } finally {
      setLoading(false);
    }
  };

  const openQuickViewSO = async (soNumber: string) => {
    const { data: order } = await supabase
      .from('sales_orders')
      .select(`*, customers(company_name, address, city, phone, npwp, pharmacy_license, gst_vat_type)`)
      .eq('so_number', soNumber)
      .maybeSingle();
    if (!order) return;
    const { data: items } = await supabase
      .from('sales_order_items')
      .select(`*, products(product_name, product_code, unit)`)
      .eq('sales_order_id', order.id);
    setQuickViewSO({ order, items: items || [] });
  };

  const openQuickViewDC = async (challanNumber: string) => {
    const { data: challan } = await supabase
      .from('delivery_challans')
      .select(`*, customers(company_name, address, city, phone, npwp, pharmacy_license, gst_vat_type)`)
      .eq('challan_number', challanNumber)
      .maybeSingle();
    if (!challan) return;
    const { data: items } = await supabase
      .from('delivery_challan_items')
      .select(`*, products(product_name, product_code, unit), batches(batch_number, expiry_date, packaging_details, products(product_name, product_code, unit), product_sources!batches_make_id_fkey(supplier_name, grade))`)
      .eq('challan_id', challan.id);
    setQuickViewDC({ challan, items: items || [] });
  };

  const openQuickViewInvoice = async (invoiceNumber: string) => {
    const { data: invoice } = await supabase
      .from('sales_invoices')
      .select(`*, customers(company_name, address, city, phone, npwp, pharmacy_license, gst_vat_type)`)
      .eq('invoice_number', invoiceNumber)
      .maybeSingle();
    if (!invoice) return;
    const items = await loadInvoiceDisplayItems(supabase, invoice.id);
    setQuickViewInvoice({ invoice, items: items || [] });
  };

  const toggleRow = (id: string) => {
    setExpandedHistoryRows(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const stockTxns = transactionHistory.filter((t: any) => t._type === 'transaction');
  const resTxns = transactionHistory.filter((t: any) => t._type === 'reservation');
  const activeRes = resTxns.filter((t: any) => t.status === 'active');
  const totalIn = stockTxns.filter((t: any) => parseFloat(t.quantity) > 0).reduce((s: number, t: any) => s + parseFloat(t.quantity), 0);
  const totalOut = stockTxns.filter((t: any) => parseFloat(t.quantity) < 0).reduce((s: number, t: any) => s + Math.abs(parseFloat(t.quantity)), 0);
  const totalReserved = activeRes.reduce((s: number, t: any) => s + parseFloat(t.quantity), 0);
  const currentStock = totalIn - totalOut;
  const freeStock = currentStock - totalReserved;

  const formatQtyValue = (val: number | string) => {
    const num = typeof val === 'string' ? parseFloat(val) : val;
    if (isNaN(num)) return '0';
    return Number.isInteger(num)
      ? num.toLocaleString()
      : num.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 3 });
  };

  const getMovementCategory = (item: any): 'in' | 'out' | 'reservations' | 'adjustments' | 'other' => {
    if (item._type === 'reservation') return 'reservations';
    const type = (item.transaction_type || '').toLowerCase();
    if (type === 'adjustment') return 'adjustments';
    const qty = parseFloat(item.quantity) || 0;
    if (type === 'sales_return' || type === 'return' || qty > 0) return 'in';
    if (qty < 0) return 'out';
    return 'other';
  };

  const counts = {
    all: transactionHistory.length,
    in: transactionHistory.filter((t: any) => getMovementCategory(t) === 'in').length,
    out: transactionHistory.filter((t: any) => getMovementCategory(t) === 'out').length,
    reservations: transactionHistory.filter((t: any) => getMovementCategory(t) === 'reservations').length,
    adjustments: transactionHistory.filter((t: any) => getMovementCategory(t) === 'adjustments').length,
  };

  const filteredHistory = transactionHistory.filter((item: any) => {
    if (historyFilter !== 'all') {
      const cat = getMovementCategory(item);
      if (cat !== historyFilter) return false;
    }

    if (historySearch.trim()) {
      const query = historySearch.toLowerCase().trim();
      const refNum = (item.reference_number || '').toLowerCase();
      const soNum = (item.so_number || item.sales_orders?.so_number || '').toLowerCase();
      const dcNum = (item.delivery_challans?.challan_number || '').toLowerCase();
      const invNum = (item.invoice?.invoice_number || '').toLowerCase();
      const custName = (item.customer?.company_name || item.customer_name || '').toLowerCase();
      const notes = (item.notes || '').toLowerCase();
      const reason = (item.release_reason || '').toLowerCase();
      const typeStr = (item.transaction_type || '').toLowerCase();
      const batchStr = (item.batch_number || '').toLowerCase();

      const matches = refNum.includes(query) ||
        soNum.includes(query) ||
        dcNum.includes(query) ||
        invNum.includes(query) ||
        custName.includes(query) ||
        notes.includes(query) ||
        reason.includes(query) ||
        typeStr.includes(query) ||
        batchStr.includes(query);

      if (!matches) return false;
    }

    return true;
  });

  const renderTypeBadge = (item: any) => {
    if (item._type === 'reservation') {
      const isActive = item.status === 'active';
      return (
        <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold tracking-wide uppercase ${
          isActive
            ? 'bg-amber-50 text-amber-800 border border-amber-300/70'
            : 'bg-slate-100 text-slate-600 border border-slate-300/70'
        }`}>
          {isActive ? 'RESERVATION' : 'RESERVATION RELEASED'}
        </span>
      );
    }

    const type = (item.transaction_type || '').toLowerCase();
    const qty = parseFloat(item.quantity) || 0;

    let badgeStyle = 'bg-gray-100 text-gray-700 border-gray-300';
    let label = type.replace(/_/g, ' ').toUpperCase();
    let sign = '';

    if (type === 'sales_return' || type === 'return') {
      badgeStyle = 'bg-teal-50 text-teal-800 border-teal-300';
      label = 'RETURN';
      sign = '+';
    } else if (type === 'purchase' || type === 'certified_opening' || (qty > 0 && type !== 'adjustment')) {
      badgeStyle = 'bg-emerald-50 text-emerald-800 border-emerald-300';
      label = 'INWARD';
      sign = '+';
    } else if (type === 'delivery_challan') {
      badgeStyle = 'bg-rose-50 text-rose-800 border-rose-300';
      label = 'DELIVERY';
      sign = '-';
    } else if (type === 'sale') {
      badgeStyle = 'bg-rose-50 text-rose-800 border-rose-300';
      label = 'SALE';
      sign = '-';
    } else if (type === 'adjustment') {
      badgeStyle = 'bg-purple-50 text-purple-800 border-purple-300';
      label = 'ADJUSTMENT';
      sign = qty > 0 ? '+' : qty < 0 ? '-' : '';
    }

    return (
      <div className="flex items-center gap-1">
        <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold tracking-wide uppercase border ${badgeStyle}`}>
          {sign && <span className="mr-0.5 font-bold">{sign}</span>}
          {label}
        </span>
        {item.is_effective === false && (
          <span className="inline-flex items-center px-1.5 py-0.2 rounded text-[9px] font-medium bg-gray-100 text-gray-500 border border-gray-300">
            Historical
          </span>
        )}
      </div>
    );
  };

  const modalSubtitle = batchNumber
    ? `${productName || ''} · Batch ${batchNumber}`
    : `${productName || ''} ${productCode ? `(${productCode})` : ''} · All Batches`;

  return (
    <>
      <Modal
        isOpen={isOpen}
        onClose={onClose}
        title="Stock Movements"
        subtitle={modalSubtitle}
        size="xl"
        maxWidth="max-w-5xl"
        maxHeight="max-h-[75vh]"
      >
        {loading ? (
          <div className="flex flex-col items-center justify-center py-16 text-gray-500">
            <Loader2 className="w-8 h-8 animate-spin text-blue-600 mb-2" />
            <p className="text-sm font-medium">Loading stock movements...</p>
          </div>
        ) : (
          <div className="flex flex-col -m-4">
            {/* 1. Top Stock Summary Cards */}
            <div className="p-4 pb-2 bg-gray-50/70 border-b border-gray-200">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                <div className="bg-emerald-50/90 border border-emerald-200 rounded-lg p-2.5 text-center shadow-xs">
                  <div className="text-[11px] font-bold text-emerald-700 uppercase tracking-wider">IN</div>
                  <div className="text-base font-extrabold text-emerald-900 leading-tight mt-0.5">
                    {formatQtyValue(totalIn)} <span className="text-xs font-semibold text-emerald-700">{unit}</span>
                  </div>
                </div>
                <div className="bg-rose-50/90 border border-rose-200 rounded-lg p-2.5 text-center shadow-xs">
                  <div className="text-[11px] font-bold text-rose-700 uppercase tracking-wider">OUT</div>
                  <div className="text-base font-extrabold text-rose-900 leading-tight mt-0.5">
                    {formatQtyValue(totalOut)} <span className="text-xs font-semibold text-rose-700">{unit}</span>
                  </div>
                </div>
                <div className="bg-amber-50/90 border border-amber-200 rounded-lg p-2.5 text-center shadow-xs">
                  <div className="text-[11px] font-bold text-amber-700 uppercase tracking-wider">RESERVED</div>
                  <div className="text-base font-extrabold text-amber-900 leading-tight mt-0.5">
                    {formatQtyValue(totalReserved)} <span className="text-xs font-semibold text-amber-700">{unit}</span>
                  </div>
                </div>
                <div className={`${freeStock < 0 ? 'bg-red-50/90 border-red-200' : 'bg-blue-50/90 border-blue-200'} border rounded-lg p-2.5 text-center shadow-xs`}>
                  <div className={`text-[11px] font-bold uppercase tracking-wider ${freeStock < 0 ? 'text-red-700' : 'text-blue-700'}`}>
                    FREE
                  </div>
                  <div className={`text-base font-extrabold leading-tight mt-0.5 ${freeStock < 0 ? 'text-red-900' : 'text-blue-900'}`}>
                    {formatQtyValue(freeStock)} <span className={`text-xs font-semibold ${freeStock < 0 ? 'text-red-700' : 'text-blue-700'}`}>{unit}</span>
                  </div>
                </div>
              </div>

              {/* 2. Compact Filter Pills & Search Input */}
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mt-3">
                <div className="flex items-center gap-1.5 overflow-x-auto pb-1 sm:pb-0">
                  {[
                    { id: 'all', label: 'All', count: counts.all },
                    { id: 'in', label: 'In', count: counts.in },
                    { id: 'out', label: 'Out', count: counts.out },
                    { id: 'reservations', label: 'Reservations', count: counts.reservations },
                    { id: 'adjustments', label: 'Adjustments', count: counts.adjustments },
                  ].map(tab => (
                    <button
                      key={tab.id}
                      onClick={() => setHistoryFilter(tab.id as any)}
                      className={`px-2.5 py-1 text-xs font-medium rounded-full transition-colors whitespace-nowrap flex items-center gap-1.5 ${
                        historyFilter === tab.id
                          ? 'bg-blue-600 text-white shadow-xs'
                          : 'bg-white text-gray-600 hover:bg-gray-100 border border-gray-200'
                      }`}
                    >
                      <span>{tab.label}</span>
                      <span className={`text-[10px] px-1.5 py-0.2 rounded-full font-semibold ${
                        historyFilter === tab.id ? 'bg-blue-700 text-white' : 'bg-gray-100 text-gray-600'
                      }`}>
                        {tab.count}
                      </span>
                    </button>
                  ))}
                </div>

                <div className="relative min-w-[200px] sm:w-64">
                  <Search className="w-3.5 h-3.5 text-gray-400 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <input
                    type="text"
                    value={historySearch}
                    onChange={(e) => setHistorySearch(e.target.value)}
                    placeholder="Search reference, SO, customer..."
                    className="w-full pl-8 pr-3 py-1 text-xs bg-white border border-gray-300 rounded-md focus:outline-none focus:ring-1 focus:ring-blue-500 shadow-xs"
                  />
                </div>
              </div>
            </div>

            {/* 3. Main Movements Table */}
            <div className="overflow-x-auto max-h-[calc(75vh-200px)] min-h-[180px] overflow-y-auto">
              {filteredHistory.length > 0 ? (
                <table className="w-full text-left text-xs border-collapse">
                  <thead className="bg-gray-100 text-gray-600 font-semibold sticky top-0 z-10 border-b border-gray-200 shadow-xs">
                    <tr>
                      <th className="py-2 px-3 whitespace-nowrap">DATE</th>
                      <th className="py-2 px-3 whitespace-nowrap">TYPE</th>
                      <th className="py-2 px-3 text-right whitespace-nowrap">QTY</th>
                      <th className="py-2 px-3 whitespace-nowrap">REFERENCE</th>
                      <th className="py-2 px-3 whitespace-nowrap">CUSTOMER / DESCRIPTION</th>
                      <th className="py-2 px-3 text-right whitespace-nowrap">STOCK</th>
                      <th className="py-2 px-2 text-center w-8"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {filteredHistory.map((item: any) => {
                      const isReservation = item._type === 'reservation';
                      const isEvidenceOnly = !isReservation && item.is_effective === false;
                      const qty = parseFloat(item.quantity) || 0;
                      const isActiveRes = isReservation && item.status === 'active';
                      const isReleasedRes = isReservation && item.status !== 'active';
                      const isExpanded = expandedHistoryRows.has(item.id);

                      let rowBg = 'hover:bg-blue-50/30';
                      if (isActiveRes) rowBg = 'bg-amber-50/25 hover:bg-amber-50/50';
                      else if (isReleasedRes) rowBg = 'bg-slate-50/40 hover:bg-slate-50/70 text-gray-500';
                      else if (isEvidenceOnly) rowBg = 'bg-gray-50/40 hover:bg-gray-50/70 text-gray-500';

                      return (
                        <tr
                          key={item.id}
                          onClick={() => toggleRow(item.id)}
                          className={`cursor-pointer transition-colors ${rowBg} ${isExpanded ? 'bg-blue-50/40' : ''}`}
                        >
                          <td className="py-2 px-3 whitespace-nowrap text-gray-600 font-medium">
                            {formatDate(item.transaction_date || item.created_at)}
                          </td>

                          <td className="py-2 px-3 whitespace-nowrap">
                            {renderTypeBadge(item)}
                          </td>

                          <td className="py-2 px-3 text-right whitespace-nowrap font-mono">
                            {isReservation ? (
                              isActiveRes ? (
                                <span className="font-semibold text-amber-700">
                                  {formatQtyValue(qty)} {unit}
                                </span>
                              ) : (
                                <span className="text-gray-400 font-normal">—</span>
                              )
                            ) : qty > 0 ? (
                              <span className="font-bold text-emerald-700">
                                +{formatQtyValue(qty)} {unit}
                              </span>
                            ) : qty < 0 ? (
                              <span className="font-bold text-rose-700">
                                -{formatQtyValue(Math.abs(qty))} {unit}
                              </span>
                            ) : (
                              <span className="text-gray-400 font-normal">
                                0 {unit}
                              </span>
                            )}
                          </td>

                          <td className="py-2 px-3 whitespace-nowrap">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              {item.reference_number ? (
                                item.reference_number.startsWith('DO-') ? (
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      openQuickViewDC(item.reference_number);
                                    }}
                                    className="font-mono font-medium text-blue-600 hover:text-blue-800 hover:underline inline-flex items-center gap-0.5"
                                  >
                                    {item.reference_number}
                                    <ExternalLink className="w-2.5 h-2.5" />
                                  </button>
                                ) : item.reference_number.startsWith('INV-') || item.reference_number.startsWith('SAPJ-') || item.transaction_type === 'sale' ? (
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      openQuickViewInvoice(item.reference_number);
                                    }}
                                    className="font-mono font-medium text-blue-600 hover:text-blue-800 hover:underline inline-flex items-center gap-0.5"
                                  >
                                    {item.reference_number}
                                    <ExternalLink className="w-2.5 h-2.5" />
                                  </button>
                                ) : item.reference_number.startsWith('SO-') ? (
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      openQuickViewSO(item.reference_number);
                                    }}
                                    className="font-mono font-medium text-blue-600 hover:text-blue-800 hover:underline inline-flex items-center gap-0.5"
                                  >
                                    {item.reference_number}
                                    <ExternalLink className="w-2.5 h-2.5" />
                                  </button>
                                ) : (
                                  <span className="font-mono text-gray-700">{item.reference_number}</span>
                                )
                              ) : item.so_number ? (
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    openQuickViewSO(item.so_number);
                                  }}
                                  className="font-mono font-medium text-blue-600 hover:text-blue-800 hover:underline inline-flex items-center gap-0.5"
                                >
                                  {item.so_number}
                                  <ExternalLink className="w-2.5 h-2.5" />
                                </button>
                              ) : (
                                <span className="text-gray-400">—</span>
                              )}

                              {/* Show batch tag if viewing product movements across all batches */}
                              {!batchNumber && item.batch_number && (
                                <span className="font-mono text-[10px] text-gray-500 bg-gray-100 px-1 py-0.2 rounded border border-gray-200">
                                  {item.batch_number}
                                </span>
                              )}
                            </div>
                          </td>

                          <td className="py-2 px-3 max-w-[220px] truncate">
                            {isReservation ? (
                              isReleasedRes ? (
                                <span className="text-gray-600">
                                  <strong className="font-medium text-gray-700">{formatQtyValue(qty)} {unit} released</strong>
                                  {item.customer_name ? ` · ${item.customer_name}` : ''}
                                </span>
                              ) : (
                                <span className="text-gray-800 font-medium">{item.customer_name || 'Active Reservation'}</span>
                              )
                            ) : (
                              <span className="text-gray-800 font-medium">
                                {item.customer?.company_name || (item.notes && !item.notes.includes('[backfilled]') ? item.notes : 'Stock Movement')}
                              </span>
                            )}
                          </td>

                          <td className="py-2 px-3 text-right whitespace-nowrap font-mono font-bold text-gray-900">
                            {formatQtyValue(item.stock_after)} <span className="text-[11px] font-normal text-gray-500">{unit}</span>
                          </td>

                          <td className="py-2 px-2 text-center text-gray-400">
                            {isExpanded ? (
                              <ChevronDown className="w-4 h-4 mx-auto text-blue-600" />
                            ) : (
                              <ChevronRight className="w-4 h-4 mx-auto hover:text-gray-600" />
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              ) : (
                <div className="text-center py-10 text-gray-500">
                  <Package className="w-10 h-10 mx-auto mb-2 text-gray-300" />
                  <p className="text-sm font-medium">No stock movements found</p>
                  {historySearch && (
                    <p className="text-xs text-gray-400 mt-1">Try clearing your search filter</p>
                  )}
                </div>
              )}
            </div>

            {/* 4. Row Expansion Details Drawer */}
            {Array.from(expandedHistoryRows).map((rowId) => {
              const item = filteredHistory.find((h: any) => h.id === rowId);
              if (!item) return null;
              const soNum = item.so_number || item.sales_orders?.so_number;
              const soTimeline = item.so_timeline || [];

              return (
                <div key={`expanded-${item.id}`} className="bg-blue-50/30 border-t border-b border-blue-200/80 p-3.5 text-xs">
                  <div className="flex items-center justify-between pb-2 mb-2 border-b border-blue-200/50">
                    <div className="font-semibold text-gray-900 flex items-center gap-2">
                      <span>Details:</span>
                      <span className="font-mono text-gray-600 font-normal">
                        {formatDate(item.transaction_date || item.created_at)} ({new Date(item.created_at).toLocaleTimeString()})
                      </span>
                      {item.batch_number && (
                        <span className="font-mono text-blue-800 bg-blue-100/70 px-1.5 py-0.5 rounded text-[10px]">
                          Batch: {item.batch_number}
                        </span>
                      )}
                    </div>
                    <button
                      onClick={() => toggleRow(item.id)}
                      className="text-gray-400 hover:text-gray-600 text-xs"
                    >
                      Close Details
                    </button>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                    {/* Col 1: Movement Stock Audit */}
                    <div className="bg-white p-2.5 rounded border border-gray-200 shadow-xs space-y-1">
                      <div className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1">
                        Physical Stock Impact
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-500">Stock Before:</span>
                        <span className="font-mono font-semibold text-gray-800">{formatQtyValue(item.stock_before)} {unit}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-500">Movement Qty:</span>
                        <span className="font-mono font-semibold">
                          {item._type === 'reservation' ? (
                            <span className="text-amber-700">{formatQtyValue(item.quantity)} {unit} (Reservation)</span>
                          ) : parseFloat(item.quantity) > 0 ? (
                            <span className="text-emerald-700">+{formatQtyValue(item.quantity)} {unit}</span>
                          ) : (
                            <span className="text-rose-700">-{formatQtyValue(Math.abs(parseFloat(item.quantity)))} {unit}</span>
                          )}
                        </span>
                      </div>
                      <div className="flex justify-between pt-1 border-t border-gray-100">
                        <span className="text-gray-700 font-medium">Stock After:</span>
                        <span className="font-mono font-bold text-gray-900">{formatQtyValue(item.stock_after)} {unit}</span>
                      </div>
                    </div>

                    {/* Col 2: Document Lineage & Customer */}
                    <div className="bg-white p-2.5 rounded border border-gray-200 shadow-xs space-y-1">
                      <div className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1">
                        Document References
                      </div>
                      {(item.customer?.company_name || item.customer_name) && (
                        <div className="flex justify-between">
                          <span className="text-gray-500">Customer:</span>
                          <span className="font-medium text-gray-800 text-right">{item.customer?.company_name || item.customer_name}</span>
                        </div>
                      )}
                      {item.reference_number && (
                        <div className="flex justify-between items-center">
                          <span className="text-gray-500">Reference:</span>
                          <span className="font-mono font-medium text-gray-800">{item.reference_number}</span>
                        </div>
                      )}
                      {soNum && (
                        <div className="flex justify-between items-center">
                          <span className="text-gray-500">Sales Order:</span>
                          <button
                            onClick={() => openQuickViewSO(soNum)}
                            className="font-mono text-blue-600 hover:text-blue-800 hover:underline font-semibold inline-flex items-center gap-0.5"
                          >
                            {soNum}
                            <ExternalLink className="w-2.5 h-2.5" />
                          </button>
                        </div>
                      )}
                      {item.delivery_challans?.challan_number && (
                        <div className="flex justify-between items-center">
                          <span className="text-gray-500">Delivery Challan:</span>
                          <button
                            onClick={() => openQuickViewDC(item.delivery_challans.challan_number)}
                            className="font-mono text-blue-600 hover:text-blue-800 hover:underline font-semibold inline-flex items-center gap-0.5"
                          >
                            {item.delivery_challans.challan_number}
                            <ExternalLink className="w-2.5 h-2.5" />
                          </button>
                        </div>
                      )}
                      {item.invoice?.invoice_number && (
                        <div className="flex justify-between items-center">
                          <span className="text-gray-500">Sales Invoice:</span>
                          <button
                            onClick={() => openQuickViewInvoice(item.invoice.invoice_number)}
                            className="font-mono text-blue-600 hover:text-blue-800 hover:underline font-semibold inline-flex items-center gap-0.5"
                          >
                            {item.invoice.invoice_number}
                            <ExternalLink className="w-2.5 h-2.5" />
                          </button>
                        </div>
                      )}
                    </div>

                    {/* Col 3: Reasons & Technical Audit */}
                    <div className="bg-white p-2.5 rounded border border-gray-200 shadow-xs space-y-1">
                      <div className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1">
                        Notes & Classification
                      </div>
                      {item.release_reason && (
                        <div>
                          <span className="text-gray-500">Release Reason: </span>
                          <span className="text-gray-800 font-medium">{item.release_reason}</span>
                        </div>
                      )}
                      {item.notes && (
                        <div>
                          <span className="text-gray-500">Notes: </span>
                          <span className="text-gray-700 italic">{item.notes}</span>
                        </div>
                      )}
                      {item.is_effective === false && (
                        <div className="p-1.5 bg-amber-50 rounded border border-amber-200 text-[10px] text-amber-800 mt-1">
                          Historical evidence · Preserved for lineage · 0 effective physical stock impact
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Group Repeated Reservation Events for the same SO */}
                  {soTimeline.length > 1 && (
                    <div className="mt-2.5 p-2.5 bg-amber-50/70 border border-amber-200 rounded-md">
                      <div className="font-semibold text-amber-900 text-[11px] mb-1.5 flex items-center justify-between">
                        <span>{soNum} · Reservation History</span>
                        <span className="text-[10px] font-normal text-amber-700">{soTimeline.length} events recorded</span>
                      </div>
                      <div className="space-y-1">
                        {soTimeline.map((rel: any) => (
                          <div key={rel.id} className="flex items-center justify-between text-[11px] py-0.5 border-b border-amber-100 last:border-0">
                            <div className="flex items-center gap-1.5">
                              <span className={`w-1.5 h-1.5 rounded-full ${rel.status === 'active' ? 'bg-amber-500' : 'bg-gray-400'}`} />
                              <span className="font-medium text-gray-800">
                                {rel.status === 'active' ? 'Reserved' : 'Released'} {formatQtyValue(rel.quantity)} {unit}
                              </span>
                              {rel.release_reason && (
                                <span className="text-gray-500 text-[10px]">({rel.release_reason})</span>
                              )}
                            </div>
                            <span className="text-gray-400 font-mono text-[10px]">
                              {formatDate(rel.released_at || rel.created_at)}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}

            {/* 5. Sticky Footer: Current Stock Summary */}
            <div className="bg-gray-50 border-t border-gray-200 px-4 py-2.5 flex flex-wrap items-center justify-between text-xs text-gray-600 gap-2">
              <div className="flex items-center gap-3">
                <span>
                  Current Stock: <strong className="text-gray-900">{formatQtyValue(currentStock)} {unit}</strong>
                </span>
                <span className="text-gray-300">|</span>
                <span>
                  Reserved: <strong className="text-amber-800">{formatQtyValue(totalReserved)} {unit}</strong>
                </span>
                <span className="text-gray-300">|</span>
                <span>
                  Free: <strong className={freeStock < 0 ? 'text-red-700' : 'text-blue-700'}>{formatQtyValue(freeStock)} {unit}</strong>
                </span>
              </div>
              <div className="text-[11px] text-gray-500 font-medium">
                Showing {filteredHistory.length} of {transactionHistory.length} movements
              </div>
            </div>
          </div>
        )}
      </Modal>

      {/* Embedded Quick View Modals */}
      {quickViewSO && (
        <ProformaInvoiceView
          salesOrder={quickViewSO.order}
          items={quickViewSO.items}
          onClose={() => setQuickViewSO(null)}
        />
      )}

      {quickViewDC && (
        <DeliveryChallanView
          challan={quickViewDC.challan}
          items={quickViewDC.items}
          onClose={() => setQuickViewDC(null)}
        />
      )}

      {quickViewInvoice && (
        <InvoiceView
          invoice={quickViewInvoice.invoice}
          items={quickViewInvoice.items}
          onClose={() => setQuickViewInvoice(null)}
        />
      )}
    </>
  );
}
