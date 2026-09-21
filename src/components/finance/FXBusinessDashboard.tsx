import { useState, useEffect, useMemo } from 'react';
import { supabase } from '../../lib/supabase';
import { 
  DollarSign, TrendingUp, TrendingDown, ArrowRight, ArrowUpRight, ArrowDownLeft, 
  Calendar, Download, Search, AlertCircle, RefreshCw, Filter, Eye, Layers, 
  CheckCircle2, Clock, X, ExternalLink, HelpCircle
} from 'lucide-react';
import * as XLSX from 'xlsx';
import { sanitizeExportRows } from '../../utils/csvSafe';

interface FXBusinessDashboardProps {
  onSwitchToAccountingReport?: () => void;
  onViewSalesOrder?: (orderId: string) => void;
  onViewInvoice?: (invoiceId: string) => void;
  onViewPayment?: (paymentId: string) => void;
}

export interface CommercialFxTransaction {
  id: string; // unique key (so_item_id or allocation_id)
  so_id: string;
  so_number: string;
  so_date: string;
  sale_currency: 'USD' | 'IDR';
  customer_id: string | null;
  customer_name: string;
  product_id: string;
  product_name: string;
  product_unit: string;
  so_quantity: number;
  so_currency: string;
  so_rate: number | null; // Sales Order Rate (commercial_usd_to_idr_rate)
  usd_sales_amount: number | null; // null for IDR sales orders!
  idr_sales_value: number; // actual IDR value
  idr_commercial_equivalent: number | null; // USD SO amount * so_rate (for USD orders)
  actual_invoiced_idr: number | null; // actual IDR invoiced
  si_id: string | null;
  si_number: string | null;
  si_date: string | null;
  batch_id: string | null;
  batch_number: string | null;
  pi_id: string | null;
  pi_number: string | null;
  pi_date: string | null;
  supplier_id: string | null;
  supplier_name: string;
  import_rate: number | null; // Import / Purchase Rate (purchase_invoices.exchange_rate)
  pi_currency: string;
  pi_total_usd: number;
  pi_paid_usd: number;
  pi_unpaid_usd: number;
  matched_usd_cost: number;
  // Payment allocations
  pv_id: string | null;
  pv_number: string | null;
  pv_date: string | null;
  payment_rate: number | null; // Supplier Payment Rate (payment_vouchers.exchange_rate > 1)
  usd_settled: number;
  idr_supplier_payment: number;
  // Calculations
  rate_diff_so_payment: number | null; // SO Rate - Supplier Payment Rate
  fx_impact_so_payment: number | null; // usd_settled * (SO Rate - Supplier Payment Rate)
  commercial_spread: number | null; // SO Rate - Import Rate
  commercial_spread_value: number | null; // usd_sales_amount * commercial_spread
  // Status
  settlement_status: 'Complete' | 'Missing SO Rate' | 'Pending Payment' | 'Unmatched' | 'IDR Sale';
  is_multiple_payments: boolean;
  all_payments?: {
    pv_id: string;
    pv_number: string;
    pv_date: string;
    rate: number;
    usd_amount: number;
    idr_paid: number;
    impact: number | null;
    is_real_fx: boolean;
  }[];
}

const fmt = (n: number | null | undefined) => {
  if (n === null || n === undefined || isNaN(n)) return '—';
  return n.toLocaleString('id-ID', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
};

const fmt2 = (n: number | null | undefined) => {
  if (n === null || n === undefined || isNaN(n)) return '—';
  return n.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

const fmtUsd = (n: number | null | undefined) => {
  if (n === null || n === undefined || isNaN(n)) return '—';
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

const fmtDate = (iso: string | null | undefined) => {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' });
};

export function FXBusinessDashboard({
  onSwitchToAccountingReport,
  onViewSalesOrder,
  onViewInvoice,
  onViewPayment,
}: FXBusinessDashboardProps) {
  const [dateRange, setDateRange] = useState({
    startDate: '2025-11-29',
    endDate: new Date().toISOString().split('T')[0],
  });
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [currencyFilter, setCurrencyFilter] = useState<'all' | 'USD' | 'IDR'>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | 'complete' | 'missing_so_rate' | 'pending_payment' | 'unmatched' | 'idr_sale'>('all');
  const [customerFilter, setCustomerFilter] = useState<string>('all');
  const [supplierFilter, setSupplierFilter] = useState<string>('all');
  const [productFilter, setProductFilter] = useState<string>('all');

  const [transactions, setTransactions] = useState<CommercialFxTransaction[]>([]);
  const [selectedTx, setSelectedTx] = useState<CommercialFxTransaction | null>(null);

  const loadData = async () => {
    setLoading(true);
    try {
      // 1. Fetch Sales Orders with items & customer
      const { data: soData, error: soErr } = await supabase
        .from('sales_orders')
        .select(`
          id, so_number, so_date, currency, commercial_usd_to_idr_rate, total_amount, subtotal_amount,
          customers(id, company_name),
          sales_order_items(
            id, product_id, quantity, unit_price, quoted_usd_unit_price, line_total,
            products(id, product_name, product_code, unit)
          )
        `)
        .order('so_date', { ascending: false });

      if (soErr) throw soErr;

      // 2. Fetch Sales Invoices & items to map batch_id and actual invoiced IDR
      const { data: siData, error: siErr } = await supabase
        .from('sales_invoices')
        .select(`
          id, invoice_number, invoice_date, sales_order_id, total_amount, subtotal,
          sales_invoice_items(
            id, product_id, batch_id, quantity, unit_price, line_total
          )
        `);

      if (siErr) throw siErr;

      // 3. Fetch Batches to find linked purchase_invoices
      const { data: batchData, error: bErr } = await supabase
        .from('batches')
        .select('id, batch_number, import_quantity, import_price_usd, purchase_invoice_id');

      if (bErr) throw bErr;

      // 4. Fetch Purchase Invoices with suppliers
      const { data: piData, error: piErr } = await supabase
        .from('purchase_invoices')
        .select(`
          id, invoice_number, invoice_date, currency, exchange_rate, total_amount, paid_amount, balance_amount,
          suppliers(id, company_name)
        `);

      if (piErr) throw piErr;

      // 5. Fetch Payment Voucher Allocations & Payment Vouchers
      const { data: vaData, error: vaErr } = await supabase
        .from('voucher_allocations')
        .select(`
          id, purchase_invoice_id, payment_voucher_id, allocated_amount, allocated_currency,
          payment_vouchers(
            id, voucher_number, voucher_date, payment_currency, exchange_rate, amount,
            bank_accounts(bank_name, account_name, account_number, currency)
          )
        `);

      if (vaErr) throw vaErr;

      // Build Fast Lookup Maps
      const batchMap = new Map<string, any>((batchData || []).map(b => [b.id, b]));
      const piMap = new Map<string, any>((piData || []).map(p => [p.id, p]));

      // Map SO ID -> array of invoice items
      const soInvoicesMap = new Map<string, any[]>();
      for (const si of siData || []) {
        if (!si.sales_order_id) continue;
        const list = soInvoicesMap.get(si.sales_order_id) || [];
        for (const item of si.sales_invoice_items || []) {
          list.push({
            si_id: si.id,
            si_number: si.invoice_number,
            si_date: si.invoice_date,
            product_id: item.product_id,
            batch_id: item.batch_id,
            quantity: Number(item.quantity || 0),
            line_total: Number(item.line_total || 0),
          });
        }
        soInvoicesMap.set(si.sales_order_id, list);
      }

      // Map PI ID -> array of voucher allocations
      const piAllocationsMap = new Map<string, any[]>();
      for (const va of vaData || []) {
        if (!va.purchase_invoice_id || !va.payment_vouchers) continue;
        const list = piAllocationsMap.get(va.purchase_invoice_id) || [];
        list.push({
          va_id: va.id,
          pv: va.payment_vouchers,
          allocated_usd: Number(va.allocated_amount || 0),
          allocated_currency: va.allocated_currency || 'USD',
        });
        piAllocationsMap.set(va.purchase_invoice_id, list);
      }

      // Build Transaction Trace Rows
      const txRows: CommercialFxTransaction[] = [];

      for (const so of soData || []) {
        const customerObj: any = Array.isArray(so.customers) ? so.customers[0] : so.customers;
        const customerName = customerObj?.company_name || 'Direct Customer';
        const rawCurrency = (so.currency || 'IDR').toUpperCase();
        const saleCurrency: 'USD' | 'IDR' = rawCurrency === 'USD' ? 'USD' : 'IDR';
        const isUsdSale = saleCurrency === 'USD';
        const soRate = so.commercial_usd_to_idr_rate ? Number(so.commercial_usd_to_idr_rate) : null;
        const linkedInvoices = soInvoicesMap.get(so.id) || [];

        for (const soi of so.sales_order_items || []) {
          const productObj: any = Array.isArray(soi.products) ? soi.products[0] : soi.products;
          const productName = productObj?.product_name || 'Inventory Product';
          const productUnit = productObj?.unit || 'kg';
          const soQty = Number(soi.quantity || 0);

          // Find linked batch & sales invoice
          const matchingInvs = linkedInvoices.filter(i => i.product_id === soi.product_id);
          const matchedInvoice = matchingInvs.length > 0 ? matchingInvs[0] : null;
          const matchedBatchId = matchedInvoice?.batch_id || null;
          const matchedBatch = matchedBatchId ? batchMap.get(matchedBatchId) : null;
          const batchNumber = matchedBatch?.batch_number || null;
          const actualInvoicedIdr = matchedInvoice ? Number(matchedInvoice.line_total || 0) : null;

          // Find Purchase Invoice
          const piId = matchedBatch?.purchase_invoice_id || null;
          const pi = piId ? piMap.get(piId) : null;
          const supplierObj: any = pi ? (Array.isArray(pi.suppliers) ? pi.suppliers[0] : pi.suppliers) : null;
          const supplierName = supplierObj?.company_name || (!pi ? 'Unmatched Supplier' : 'Direct Supplier');
          const importRate = pi ? (pi.currency === 'IDR' ? 1 : Number(pi.exchange_rate || 0)) : null;

          const piTotalUsd = pi ? Number(pi.total_amount || 0) : 0;
          const piPaidUsd = pi ? Number(pi.paid_amount || 0) : 0;
          const piUnpaidUsd = pi ? Number(pi.balance_amount || 0) : 0;
          const batchUnitCostUsd = matchedBatch?.import_price_usd ? Number(matchedBatch.import_price_usd) : 0;

          // Inclusion rule:
          // Include genuine USD sales orders OR sales orders with commercial FX quotation rate or quoted USD price
          const isFxRelevant = isUsdSale || (soRate !== null && soRate > 0) || Boolean(soi.quoted_usd_unit_price);
          if (!isFxRelevant) continue;

          if (!isUsdSale) {
            // ==================================================
            // 1. IDR SALES ORDER (e.g. SO-2026-0077, SO-2026-0078)
            // ==================================================
            // - SO currency = IDR
            // - SO amount is already IDR
            // - DO NOT derive/display "USD Sales" (usd_sales_amount = null)
            // - DO NOT calculate SO -> Payment FX Impact (fx_impact_so_payment = null)
            // - Do not attach supplier payment FX to customer commercial FX calculation
            const idrSalesValue = Number(soi.line_total || soi.unit_price * soQty || 0);

            txRows.push({
              id: `${soi.id}-idr`,
              so_id: so.id,
              so_number: so.so_number,
              so_date: so.so_date,
              sale_currency: 'IDR',
              customer_id: customerObj?.id || null,
              customer_name: customerName,
              product_id: soi.product_id,
              product_name: productName,
              product_unit: productUnit,
              so_quantity: soQty,
              so_currency: 'IDR',
              so_rate: soRate, // Shown as reference rate if entered
              usd_sales_amount: null, // NEVER derive fake USD sales!
              idr_sales_value: idrSalesValue,
              idr_commercial_equivalent: null,
              actual_invoiced_idr: actualInvoicedIdr,
              si_id: matchedInvoice?.si_id || null,
              si_number: matchedInvoice?.si_number || null,
              si_date: matchedInvoice?.si_date || null,
              batch_id: matchedBatchId,
              batch_number: batchNumber,
              pi_id: piId,
              pi_number: pi?.invoice_number || null,
              pi_date: pi?.invoice_date || null,
              supplier_id: supplierObj?.id || null,
              supplier_name: supplierName,
              import_rate: importRate,
              pi_currency: pi?.currency || 'USD',
              pi_total_usd: piTotalUsd,
              pi_paid_usd: piPaidUsd,
              pi_unpaid_usd: piUnpaidUsd,
              matched_usd_cost: 0,
              pv_id: null,
              pv_number: null,
              pv_date: null,
              payment_rate: null,
              usd_settled: 0,
              idr_supplier_payment: 0,
              rate_diff_so_payment: null,
              fx_impact_so_payment: null, // N/A
              commercial_spread: null, // N/A
              commercial_spread_value: null, // N/A
              settlement_status: 'IDR Sale',
              is_multiple_payments: false,
              all_payments: [],
            });
          } else {
            // ==================================================
            // 2. GENUINE USD SALES ORDER (e.g. SO-2026-0001, etc.)
            // ==================================================
            // - SO currency = USD
            // - SO amount remains USD
            // - commercial_usd_to_idr_rate is the commercial quotation rate
            // - Commercial IDR equivalent = USD SO amount * SO rate
            // - Actual IDR invoiced is from linked sales invoice
            const usdSalesAmount = Number(soi.line_total || soi.unit_price * soQty || 0);
            const idrCommercialEquivalent = (soRate && soRate > 0) ? usdSalesAmount * soRate : null;
            const idrSalesValue = idrCommercialEquivalent ?? (actualInvoicedIdr || 0);
            const matchedUsdCost = batchUnitCostUsd > 0 ? batchUnitCostUsd * soQty : usdSalesAmount;

            const commSpread = (soRate !== null && importRate !== null && importRate > 1) ? soRate - importRate : null;
            const commSpreadVal = (commSpread !== null && usdSalesAmount > 0) ? usdSalesAmount * commSpread : null;

            // Find Payment Vouchers allocated to this Purchase Invoice
            const allocations = piId ? (piAllocationsMap.get(piId) || []) : [];

            if (allocations.length === 0) {
              let status: 'Complete' | 'Missing SO Rate' | 'Pending Payment' | 'Unmatched';
              if (!pi && !matchedBatchId) {
                status = 'Unmatched';
              } else if (!soRate) {
                status = 'Missing SO Rate';
              } else {
                status = 'Pending Payment';
              }

              txRows.push({
                id: `${soi.id}-unpaid`,
                so_id: so.id,
                so_number: so.so_number,
                so_date: so.so_date,
                sale_currency: 'USD',
                customer_id: customerObj?.id || null,
                customer_name: customerName,
                product_id: soi.product_id,
                product_name: productName,
                product_unit: productUnit,
                so_quantity: soQty,
                so_currency: 'USD',
                so_rate: soRate,
                usd_sales_amount: usdSalesAmount,
                idr_sales_value: idrSalesValue,
                idr_commercial_equivalent: idrCommercialEquivalent,
                actual_invoiced_idr: actualInvoicedIdr,
                si_id: matchedInvoice?.si_id || null,
                si_number: matchedInvoice?.si_number || null,
                si_date: matchedInvoice?.si_date || null,
                batch_id: matchedBatchId,
                batch_number: batchNumber,
                pi_id: piId,
                pi_number: pi?.invoice_number || null,
                pi_date: pi?.invoice_date || null,
                supplier_id: supplierObj?.id || null,
                supplier_name: supplierName,
                import_rate: importRate,
                pi_currency: pi?.currency || 'USD',
                pi_total_usd: piTotalUsd,
                pi_paid_usd: piPaidUsd,
                pi_unpaid_usd: piUnpaidUsd,
                matched_usd_cost: matchedUsdCost,
                pv_id: null,
                pv_number: null,
                pv_date: null,
                payment_rate: null,
                usd_settled: 0,
                idr_supplier_payment: 0,
                rate_diff_so_payment: null,
                fx_impact_so_payment: null,
                commercial_spread: commSpread,
                commercial_spread_value: commSpreadVal,
                settlement_status: status,
                is_multiple_payments: false,
                all_payments: [],
              });
            } else {
              // Build all payments summary
              const allPaymentsList = allocations.map(a => {
                const pvRate = Number(a.pv.exchange_rate || 1);
                const usdAmt = Number(a.allocated_usd || 0);
                const isRealFx = pvRate > 1;
                const canCalc = isRealFx && soRate !== null && soRate > 0;
                const rateDiff = canCalc ? soRate - pvRate : null;
                const impact = canCalc ? usdAmt * (soRate - pvRate) : null;
                return {
                  pv_id: a.pv.id,
                  pv_number: a.pv.voucher_number,
                  pv_date: a.pv.voucher_date,
                  rate: pvRate,
                  usd_amount: usdAmt,
                  idr_paid: isRealFx ? usdAmt * pvRate : 0,
                  impact: impact,
                  is_real_fx: isRealFx,
                };
              });

              allocations.forEach((alloc, idx) => {
                const pv = alloc.pv;
                const rawPvRate = Number(pv.exchange_rate || 1);
                const isRealFx = rawPvRate > 1;
                const usdSettled = Number(alloc.allocated_usd || 0);
                const idrPaid = isRealFx ? usdSettled * rawPvRate : 0;
                const effectivePvRate = isRealFx ? rawPvRate : null;

                const canCalc = isRealFx && soRate !== null && soRate > 0 && usdSettled > 0;
                const rateDiff = canCalc ? soRate - rawPvRate : null;
                const impact = canCalc ? usdSettled * (soRate - rawPvRate) : null;

                let status: 'Complete' | 'Missing SO Rate' | 'Pending Payment' | 'Unmatched';
                if (!soRate) {
                  status = 'Missing SO Rate';
                } else {
                  status = 'Complete';
                }

                txRows.push({
                  id: `${soi.id}-${alloc.va_id || idx}`,
                  so_id: so.id,
                  so_number: so.so_number,
                  so_date: so.so_date,
                  sale_currency: 'USD',
                  customer_id: customerObj?.id || null,
                  customer_name: customerName,
                  product_id: soi.product_id,
                  product_name: productName,
                  product_unit: productUnit,
                  so_quantity: soQty,
                  so_currency: 'USD',
                  so_rate: soRate,
                  usd_sales_amount: usdSalesAmount,
                  idr_sales_value: idrSalesValue,
                  idr_commercial_equivalent: idrCommercialEquivalent,
                  actual_invoiced_idr: actualInvoicedIdr,
                  si_id: matchedInvoice?.si_id || null,
                  si_number: matchedInvoice?.si_number || null,
                  si_date: matchedInvoice?.si_date || null,
                  batch_id: matchedBatchId,
                  batch_number: batchNumber,
                  pi_id: piId,
                  pi_number: pi?.invoice_number || null,
                  pi_date: pi?.invoice_date || null,
                  supplier_id: supplierObj?.id || null,
                  supplier_name: supplierName,
                  import_rate: importRate,
                  pi_currency: pi?.currency || 'USD',
                  pi_total_usd: piTotalUsd,
                  pi_paid_usd: piPaidUsd,
                  pi_unpaid_usd: piUnpaidUsd,
                  matched_usd_cost: matchedUsdCost,
                  pv_id: pv.id,
                  pv_number: pv.voucher_number,
                  pv_date: pv.voucher_date,
                  payment_rate: effectivePvRate,
                  usd_settled: usdSettled,
                  idr_supplier_payment: idrPaid,
                  rate_diff_so_payment: rateDiff,
                  fx_impact_so_payment: impact,
                  commercial_spread: commSpread,
                  commercial_spread_value: commSpreadVal,
                  settlement_status: status,
                  is_multiple_payments: allocations.length > 1,
                  all_payments: allPaymentsList,
                });
              });
            }
          }
        }
      }

      // Sort by SO Date descending
      txRows.sort((a, b) => new Date(b.so_date).getTime() - new Date(a.so_date).getTime());
      setTransactions(txRows);
    } catch (err: any) {
      console.error('Failed to load FX Business Dashboard data:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  // Filter Options
  const customersList = useMemo(() => {
    const set = new Set<string>();
    transactions.forEach(t => { if (t.customer_name) set.add(t.customer_name); });
    return Array.from(set).sort();
  }, [transactions]);

  const suppliersList = useMemo(() => {
    const set = new Set<string>();
    transactions.forEach(t => { if (t.supplier_name && t.supplier_name !== 'Unmatched Supplier') set.add(t.supplier_name); });
    return Array.from(set).sort();
  }, [transactions]);

  const productsList = useMemo(() => {
    const set = new Set<string>();
    transactions.forEach(t => { if (t.product_name) set.add(t.product_name); });
    return Array.from(set).sort();
  }, [transactions]);

  // Filtered Rows
  const filteredTransactions = useMemo(() => {
    return transactions.filter(t => {
      // Date filter (based on SO Date)
      if (t.so_date < dateRange.startDate || t.so_date > dateRange.endDate) return false;

      // Currency filter
      if (currencyFilter !== 'all' && t.sale_currency !== currencyFilter) return false;

      // Status filter
      if (statusFilter === 'complete' && t.settlement_status !== 'Complete') return false;
      if (statusFilter === 'missing_so_rate' && t.settlement_status !== 'Missing SO Rate') return false;
      if (statusFilter === 'pending_payment' && t.settlement_status !== 'Pending Payment') return false;
      if (statusFilter === 'unmatched' && t.settlement_status !== 'Unmatched') return false;
      if (statusFilter === 'idr_sale' && t.settlement_status !== 'IDR Sale') return false;

      // Dropdown filters
      if (customerFilter !== 'all' && t.customer_name !== customerFilter) return false;
      if (supplierFilter !== 'all' && t.supplier_name !== supplierFilter) return false;
      if (productFilter !== 'all' && t.product_name !== productFilter) return false;

      // Text search
      if (searchTerm.trim()) {
        const q = searchTerm.toLowerCase();
        const match =
          t.so_number.toLowerCase().includes(q) ||
          t.customer_name.toLowerCase().includes(q) ||
          t.product_name.toLowerCase().includes(q) ||
          (t.si_number && t.si_number.toLowerCase().includes(q)) ||
          (t.pi_number && t.pi_number.toLowerCase().includes(q)) ||
          t.supplier_name.toLowerCase().includes(q) ||
          (t.pv_number && t.pv_number.toLowerCase().includes(q)) ||
          (t.batch_number && t.batch_number.toLowerCase().includes(q));
        if (!match) return false;
      }

      return true;
    });
  }, [transactions, dateRange, currencyFilter, statusFilter, customerFilter, supplierFilter, productFilter, searchTerm]);

  // Top KPIs
  const kpis = useMemo(() => {
    let totalUsdSold = 0;
    let totalUsdPaid = 0;
    let totalFxImpact = 0;
    let hasValidImpact = false;
    let weightedImportRateSum = 0;
    let importWeight = 0;
    let weightedSoRateSum = 0;
    let soWeight = 0;
    let totalIdrSettlementValue = 0;
    let totalUsdActuallySettled = 0;
    let totalUnpaidUsd = 0;
    let missingSoRateCount = 0;
    let completedCount = 0;

    // Track unique SO items to avoid double-counting sales when multiple payments exist
    const seenSoItems = new Set<string>();

    filteredTransactions.forEach(t => {
      const soItemKey = `${t.so_id}-${t.product_id}`;
      if (!seenSoItems.has(soItemKey)) {
        seenSoItems.add(soItemKey);

        // ONLY genuine USD sales orders contribute to USD Sold & Avg SO Rate!
        if (t.sale_currency === 'USD') {
          if (t.usd_sales_amount !== null && t.usd_sales_amount > 0) {
            totalUsdSold += t.usd_sales_amount;
          }
          if (t.so_rate && t.so_rate > 0 && t.usd_sales_amount) {
            weightedSoRateSum += t.so_rate * t.usd_sales_amount;
            soWeight += t.usd_sales_amount;
          } else {
            missingSoRateCount++;
          }
        }
      }

      if (t.settlement_status === 'Complete') {
        completedCount++;
      }

      // Only genuine USD transactions with actual import rate > 1
      if (t.sale_currency === 'USD' && t.import_rate && t.import_rate > 1) {
        const weight = t.usd_settled > 0 ? t.usd_settled : (t.usd_sales_amount || 1);
        weightedImportRateSum += t.import_rate * weight;
        importWeight += weight;
      }

      // Payment Rate KPI Rules:
      // EXCLUDE:
      // - IDR payment with exchange_rate = 1
      // - USD payment from USD bank with exchange_rate = 1
      // - domestic IDR transactions
      // - transactions where customer SO currency = IDR
      // INCLUDE ONLY actual FX settlements (payment_rate > 1) for USD sales orders:
      if (t.sale_currency === 'USD' && t.payment_rate && t.payment_rate > 1 && t.usd_settled > 0) {
        totalUsdPaid += t.usd_settled;
        totalIdrSettlementValue += t.usd_settled * t.payment_rate;
        totalUsdActuallySettled += t.usd_settled;
      }

      // SO -> Payment FX Impact:
      // Only for USD sales orders where both SO rate and Payment rate are valid
      if (t.sale_currency === 'USD' && t.fx_impact_so_payment !== null) {
        totalFxImpact += t.fx_impact_so_payment;
        hasValidImpact = true;
      }

      if (t.sale_currency === 'USD' && t.pi_unpaid_usd > 0) {
        totalUnpaidUsd += t.pi_unpaid_usd;
      }
    });

    const avgImportRate = importWeight > 0 ? weightedImportRateSum / importWeight : 0;
    const avgSoRate = soWeight > 0 ? weightedSoRateSum / soWeight : 0;
    // Weighted effective rate: Total IDR settlement value / Total USD actually settled
    const avgPvRate = totalUsdActuallySettled > 0 ? totalIdrSettlementValue / totalUsdActuallySettled : 0;

    return {
      totalUsdSold,
      totalUsdPaid,
      avgImportRate,
      avgSoRate,
      avgPvRate,
      totalFxImpact,
      hasValidImpact,
      totalUnpaidUsd,
      missingSoRateCount,
      completedCount,
    };
  }, [filteredTransactions]);

  // Export to Excel
  const handleExportExcel = () => {
    const exportData = filteredTransactions.map(t => ({
      'SO Number': t.so_number,
      'SO Date': t.so_date,
      'Sale Currency': t.sale_currency,
      'Customer': t.customer_name,
      'Product': t.product_name,
      'Quantity': `${t.so_quantity} ${t.product_unit}`,
      'Original SO USD': t.sale_currency === 'USD' ? (t.usd_sales_amount !== null ? t.usd_sales_amount : '—') : '—',
      'SO Rate (Commercial)': t.so_rate || '—',
      'Commercial IDR Equivalent': t.idr_commercial_equivalent !== null ? t.idr_commercial_equivalent : '—',
      'Actual IDR Invoiced': t.actual_invoiced_idr !== null ? t.actual_invoiced_idr : '—',
      'SO Value (IDR)': t.idr_sales_value,
      'Sales Invoice': t.si_number || '—',
      'Batch Number': t.batch_number || '—',
      'Supplier': t.supplier_name,
      'Supplier Invoice': t.pi_number || '—',
      'PI Date': t.pi_date || '—',
      'Import Rate': t.import_rate || '—',
      'Payment Voucher': t.pv_number || 'Pending',
      'Payment Date': t.pv_date || '—',
      'Supplier Payment Rate': t.payment_rate || '—',
      'USD Settled': t.usd_settled > 0 ? t.usd_settled : '—',
      'IDR Supplier Payment': t.idr_supplier_payment > 0 ? t.idr_supplier_payment : '—',
      'SO -> Payment Rate Difference': t.rate_diff_so_payment !== null ? t.rate_diff_so_payment : '—',
      'SO -> Payment FX Impact (IDR)': t.sale_currency === 'IDR' ? 'N/A' : (t.fx_impact_so_payment !== null ? t.fx_impact_so_payment : 'Pending'),
      'Settlement Status': t.settlement_status,
    }));

    const sanitized = sanitizeExportRows(exportData);
    const ws = XLSX.utils.json_to_sheet(sanitized);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'FX Business Analysis');
    XLSX.writeFile(wb, `FX_Business_Dashboard_${new Date().toISOString().split('T')[0]}.xlsx`);
  };

  return (
    <div className="space-y-6">
      {/* Top View Mode Switcher */}
      <div className="flex items-center justify-between bg-white border border-slate-200 rounded-2xl p-2.5 shadow-sm">
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="px-4 py-2 bg-blue-600 text-white rounded-xl text-xs font-bold shadow-sm flex items-center gap-2"
          >
            <TrendingUp className="w-3.5 h-3.5" />
            Commercial FX
          </button>
          {onSwitchToAccountingReport && (
            <button
              type="button"
              onClick={onSwitchToAccountingReport}
              className="px-4 py-2 text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded-xl text-xs font-semibold transition-all flex items-center gap-2"
            >
              <Layers className="w-3.5 h-3.5 text-indigo-500" />
              Accounting FX
            </button>
          )}
        </div>
        <div className="text-xs text-slate-500 font-medium hidden sm:flex items-center gap-2">
          <span className="text-blue-600 font-bold">Commercial View:</span>
          <span>Customer Sale Currency → Quotation Rate → Supplier Settlement</span>
        </div>
      </div>

      {/* Top Action & Navigation Banner */}
      <div className="bg-gradient-to-r from-slate-900 via-indigo-950 to-blue-900 rounded-2xl p-6 text-white shadow-xl flex flex-col md:flex-row md:items-center justify-between gap-6">
        <div>
          <div className="flex items-center gap-3">
            <span className="px-3 py-1 bg-blue-500/20 text-blue-300 border border-blue-400/30 rounded-full text-xs font-semibold uppercase tracking-wider">
              Management Commercial FX
            </span>
            <span className="text-xs text-slate-300 flex items-center gap-1">
              <Clock className="w-3.5 h-3.5" /> Customer FX Contracts & Realized Settlements
            </span>
          </div>
          <h1 className="text-2xl md:text-3xl font-bold mt-2 tracking-tight">
            FX Business Dashboard
          </h1>
          <p className="text-slate-300 text-sm mt-1 max-w-2xl leading-relaxed">
            Strictly separates <span className="text-blue-300 font-semibold">USD Sales Orders</span> (quoted in USD, invoiced in IDR) from <span className="text-amber-300 font-semibold">IDR Sales Orders</span>. Traces commercial quotation rates against actual IDR↔USD settlement conversions.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {onSwitchToAccountingReport && (
            <button
              onClick={onSwitchToAccountingReport}
              className="px-4 py-2.5 bg-slate-800/80 hover:bg-slate-700/90 text-slate-200 border border-slate-600 rounded-xl text-xs font-medium transition-all shadow-sm flex items-center gap-2"
              title="Open the official GL Accounting FX Report with journal references"
            >
              <Layers className="w-4 h-4 text-indigo-400" />
              Accounting FX Report
            </button>
          )}

          <button
            onClick={handleExportExcel}
            className="px-4 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-xs font-semibold transition-all shadow-md flex items-center gap-2"
          >
            <Download className="w-4 h-4" />
            Export to Excel
          </button>

          <button
            onClick={loadData}
            className="p-2.5 bg-slate-800/80 hover:bg-slate-700 text-slate-300 border border-slate-600 rounded-xl transition-all shadow-sm"
            title="Refresh Data"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* 7 Key Business Questions Summary Panel */}
      <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm">
        <h3 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-3 flex items-center gap-2">
          <HelpCircle className="w-4 h-4 text-blue-600" />
          Management Executive Answers
        </h3>
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-4 text-sm">
          <div className="p-3 bg-slate-50 border border-slate-100 rounded-xl">
            <span className="text-xs text-slate-500 block">1. Avg Import Rate</span>
            <span className="font-bold text-slate-900 text-base mt-0.5 block">
              {kpis.avgImportRate > 0 ? `Rp ${fmt(kpis.avgImportRate)}` : '—'}
            </span>
          </div>
          <div className="p-3 bg-blue-50/50 border border-blue-100 rounded-xl">
            <span className="text-xs text-blue-700 block">2. Avg SO Rate</span>
            <span className="font-bold text-blue-900 text-base mt-0.5 block">
              {kpis.avgSoRate > 0 ? (
                `Rp ${fmt(kpis.avgSoRate)}`
              ) : (
                <span className="text-amber-600 text-xs font-medium">Missing ({kpis.missingSoRateCount})</span>
              )}
            </span>
          </div>
          <div className="p-3 bg-emerald-50/50 border border-emerald-100 rounded-xl">
            <span className="text-xs text-emerald-700 block">3. Avg Paid Rate</span>
            <span className="font-bold text-emerald-900 text-base mt-0.5 block">
              {kpis.avgPvRate > 0 ? `Rp ${fmt(kpis.avgPvRate)}` : '—'}
            </span>
          </div>
          <div className="p-3 bg-indigo-50/50 border border-indigo-100 rounded-xl">
            <span className="text-xs text-indigo-700 block">4. Rate Diff</span>
            <span className="font-bold text-base mt-0.5 block">
              {kpis.avgSoRate > 0 && kpis.avgPvRate > 0 ? (
                <span className={kpis.avgSoRate - kpis.avgPvRate >= 0 ? 'text-emerald-600' : 'text-rose-600'}>
                  {kpis.avgSoRate - kpis.avgPvRate >= 0 ? '+' : ''}{fmt(kpis.avgSoRate - kpis.avgPvRate)}
                </span>
              ) : (
                <span className="text-slate-400 text-xs font-normal">Pending SO Rate</span>
              )}
            </span>
          </div>
          <div className="p-3 bg-amber-50/50 border border-amber-100 rounded-xl">
            <span className="text-xs text-amber-700 block">5. FX Impact</span>
            <span className="font-bold text-base mt-0.5 block">
              {kpis.hasValidImpact ? (
                <span className={kpis.totalFxImpact >= 0 ? 'text-emerald-600' : 'text-rose-600'}>
                  Rp {fmt(kpis.totalFxImpact)}
                </span>
              ) : (
                <span className="text-slate-400 text-xs font-normal">Pending data</span>
              )}
            </span>
          </div>
          <div className="p-3 bg-slate-50 border border-slate-100 rounded-xl">
            <span className="text-xs text-slate-500 block">6. Settled USD</span>
            <span className="font-bold text-slate-900 text-base mt-0.5 block">
              {fmtUsd(kpis.totalUsdPaid)}
            </span>
          </div>
          <div className="p-3 bg-rose-50/40 border border-rose-100 rounded-xl">
            <span className="text-xs text-rose-700 block">7. Unpaid USD</span>
            <span className="font-bold text-rose-900 text-base mt-0.5 block">
              {fmtUsd(kpis.totalUnpaidUsd)}
            </span>
          </div>
        </div>
      </div>

      {/* Top 6 KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-4">
        <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm flex flex-col justify-between">
          <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Total USD Sold</span>
          <div className="mt-2">
            <div className="text-2xl font-black text-slate-900">{fmtUsd(kpis.totalUsdSold)}</div>
            <span className="text-[11px] text-slate-400">Genuine USD orders only</span>
          </div>
        </div>

        <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm flex flex-col justify-between">
          <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Total USD Paid</span>
          <div className="mt-2">
            <div className="text-2xl font-black text-slate-900">{fmtUsd(kpis.totalUsdPaid)}</div>
            <span className="text-[11px] text-emerald-600 font-medium">FX settled to suppliers</span>
          </div>
        </div>

        <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm flex flex-col justify-between">
          <span className="text-xs font-semibold text-amber-600 uppercase tracking-wide">Avg Import Rate</span>
          <div className="mt-2">
            <div className="text-2xl font-black text-slate-900">Rp {fmt(kpis.avgImportRate)}</div>
            <span className="text-[11px] text-slate-400">Weighted purchase rate</span>
          </div>
        </div>

        <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm flex flex-col justify-between">
          <span className="text-xs font-semibold text-blue-600 uppercase tracking-wide">Avg Sales Order Rate</span>
          <div className="mt-2">
            <div className="text-2xl font-black text-blue-900">
              {kpis.avgSoRate > 0 ? `Rp ${fmt(kpis.avgSoRate)}` : '—'}
            </div>
            <span className="text-[11px] text-slate-400">
              {kpis.missingSoRateCount > 0 ? `${kpis.missingSoRateCount} pending rate` : 'Quotation rate'}
            </span>
          </div>
        </div>

        <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm flex flex-col justify-between">
          <span className="text-xs font-semibold text-emerald-600 uppercase tracking-wide">Avg Payment Rate</span>
          <div className="mt-2">
            <div className="text-2xl font-black text-emerald-900">
              {kpis.avgPvRate > 0 ? `Rp ${fmt(kpis.avgPvRate)}` : '—'}
            </div>
            <span className="text-[11px] text-slate-400">Weighted FX conversion</span>
          </div>
        </div>

        {/* MOST IMPORTANT KPI: TOTAL SO -> PAYMENT FX IMPACT */}
        <div className={`p-5 rounded-2xl border shadow-sm flex flex-col justify-between ${
          !kpis.hasValidImpact
            ? 'bg-slate-50 border-slate-200 text-slate-900'
            : kpis.totalFxImpact >= 0 
            ? 'bg-emerald-50/80 border-emerald-300 text-emerald-950' 
            : 'bg-rose-50/80 border-rose-300 text-rose-950'
        }`}>
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold uppercase tracking-wide">SO → Payment FX Impact</span>
            {kpis.hasValidImpact ? (
              kpis.totalFxImpact >= 0 ? (
                <span className="px-2 py-0.5 bg-emerald-200/80 text-emerald-800 rounded text-[10px] font-extrabold uppercase">Favorable</span>
              ) : (
                <span className="px-2 py-0.5 bg-rose-200/80 text-rose-800 rounded text-[10px] font-extrabold uppercase">Unfavorable</span>
              )
            ) : (
              <span className="px-2 py-0.5 bg-slate-200 text-slate-700 rounded text-[10px] font-medium uppercase">Pending</span>
            )}
          </div>
          <div className="mt-2">
            <div className={`text-2xl font-black tracking-tight ${
              !kpis.hasValidImpact ? 'text-slate-400 text-lg font-semibold' : kpis.totalFxImpact >= 0 ? 'text-emerald-700' : 'text-rose-700'
            }`}>
              {kpis.hasValidImpact ? (
                `${kpis.totalFxImpact >= 0 ? '+' : ''}Rp ${fmt(kpis.totalFxImpact)}`
              ) : (
                'Pending SO Rate'
              )}
            </div>
            <span className="text-[11px] opacity-80 block mt-0.5">
              {kpis.hasValidImpact ? (
                kpis.totalFxImpact >= 0 ? 'Margin preserved/gained' : 'Margin eroded at settlement'
              ) : (
                'Requires USD SO quote rate'
              )}
            </span>
          </div>
        </div>
      </div>

      {/* Filter Bar */}
      <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <Filter className="w-4 h-4 text-slate-500" />
            <span className="text-xs font-bold text-slate-700 uppercase tracking-wider">Scope & Currency Filter</span>
            
            {/* Currency Selector */}
            <div className="flex items-center bg-slate-100 p-1 rounded-xl gap-1">
              <button
                onClick={() => setCurrencyFilter('all')}
                className={`px-3 py-1 rounded-lg text-xs font-bold transition-all ${
                  currencyFilter === 'all'
                    ? 'bg-white text-slate-900 shadow-sm'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                All Scope ({transactions.length})
              </button>
              <button
                onClick={() => setCurrencyFilter('USD')}
                className={`px-3 py-1 rounded-lg text-xs font-bold transition-all flex items-center gap-1.5 ${
                  currencyFilter === 'USD'
                    ? 'bg-blue-600 text-white shadow-sm'
                    : 'text-blue-700 hover:bg-blue-50'
                }`}
              >
                <span className="w-2 h-2 rounded-full bg-blue-300"></span>
                USD Sales Orders ({transactions.filter(t => t.sale_currency === 'USD').length})
              </button>
              <button
                onClick={() => setCurrencyFilter('IDR')}
                className={`px-3 py-1 rounded-lg text-xs font-bold transition-all flex items-center gap-1.5 ${
                  currencyFilter === 'IDR'
                    ? 'bg-slate-800 text-white shadow-sm'
                    : 'text-slate-700 hover:bg-slate-200'
                }`}
              >
                <span className="w-2 h-2 rounded-full bg-slate-400"></span>
                IDR Sales Orders ({transactions.filter(t => t.sale_currency === 'IDR').length})
              </button>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* Status Pills */}
            {([
              { id: 'all', label: 'All Statuses' },
              { id: 'complete', label: 'Complete' },
              { id: 'missing_so_rate', label: 'Missing SO Rate' },
              { id: 'pending_payment', label: 'Pending Payment' },
              { id: 'unmatched', label: 'Unmatched' },
              { id: 'idr_sale', label: 'IDR Orders' },
            ] as const).map(st => (
              <button
                key={st.id}
                onClick={() => setStatusFilter(st.id)}
                className={`px-2.5 py-1.5 rounded-lg text-xs font-semibold capitalize transition-all ${
                  statusFilter === st.id
                    ? 'bg-slate-900 text-white shadow-sm'
                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                }`}
              >
                {st.label}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3 pt-2">
          {/* Search Box */}
          <div className="relative">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              placeholder="Search SO, customer, PI, PV..."
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
              className="w-full pl-9 pr-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-xl focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          {/* Customer Dropdown */}
          <select
            value={customerFilter}
            onChange={e => setCustomerFilter(e.target.value)}
            className="px-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-xl focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="all">All Customers ({customersList.length})</option>
            {customersList.map(c => <option key={c} value={c}>{c}</option>)}
          </select>

          {/* Supplier Dropdown */}
          <select
            value={supplierFilter}
            onChange={e => setSupplierFilter(e.target.value)}
            className="px-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-xl focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="all">All Suppliers ({suppliersList.length})</option>
            {suppliersList.map(s => <option key={s} value={s}>{s}</option>)}
          </select>

          {/* Product Dropdown */}
          <select
            value={productFilter}
            onChange={e => setProductFilter(e.target.value)}
            className="px-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-xl focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="all">All Products ({productsList.length})</option>
            {productsList.map(p => <option key={p} value={p}>{p}</option>)}
          </select>

          {/* Date Range */}
          <div className="flex items-center gap-1.5">
            <input
              type="date"
              value={dateRange.startDate}
              onChange={e => setDateRange(d => ({ ...d, startDate: e.target.value }))}
              className="w-1/2 px-2 py-2 text-xs bg-slate-50 border border-slate-200 rounded-xl focus:bg-white focus:outline-none"
            />
            <span className="text-slate-400 text-xs">to</span>
            <input
              type="date"
              value={dateRange.endDate}
              onChange={e => setDateRange(d => ({ ...d, endDate: e.target.value }))}
              className="w-1/2 px-2 py-2 text-xs bg-slate-50 border border-slate-200 rounded-xl focus:bg-white focus:outline-none"
            />
          </div>
        </div>
      </div>

      {/* Transaction Table */}
      <div className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <h2 className="text-base font-bold text-slate-900">Commercial FX Transactions</h2>
            <span className="px-2.5 py-0.5 bg-slate-100 text-slate-700 text-xs rounded-full font-semibold">
              {filteredTransactions.length} records
            </span>
          </div>
          <span className="text-xs text-slate-400">
            Click any row to open the complete SO → Purchase → Payment drilldown
          </span>
        </div>

        {loading ? (
          <div className="p-16 text-center text-slate-400 text-sm flex flex-col items-center gap-3">
            <RefreshCw className="w-8 h-8 animate-spin text-blue-500" />
            Loading and tracing FX transactions...
          </div>
        ) : filteredTransactions.length === 0 ? (
          <div className="p-16 text-center text-slate-400 text-sm">
            No transactions matched the selected filters.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs border-collapse">
              <thead>
                <tr className="bg-slate-50/80 text-slate-600 border-b border-slate-200 uppercase tracking-wider font-semibold text-[11px]">
                  <th className="py-3 px-4">Sales Order</th>
                  <th className="py-3 px-4">Customer & Product</th>
                  <th className="py-3 px-4 text-center">Sale Currency</th>
                  <th className="py-3 px-4 text-right">USD SO Value</th>
                  <th className="py-3 px-4 text-right">SO Rate</th>
                  <th className="py-3 px-4 text-right">Commercial IDR Equiv.</th>
                  <th className="py-3 px-4 text-right">Actual IDR Invoiced</th>
                  <th className="py-3 px-4">Supplier & PI</th>
                  <th className="py-3 px-4 text-right">Import Rate</th>
                  <th className="py-3 px-4">Payment Voucher</th>
                  <th className="py-3 px-4 text-right">Payment Rate</th>
                  <th className="py-3 px-4 text-right">USD Settled</th>
                  <th className="py-3 px-4 text-right font-bold text-slate-900">SO → Payment FX Impact</th>
                  <th className="py-3 px-4 text-center">Status</th>
                  <th className="py-3 px-3 text-center">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredTransactions.map(tx => {
                  const isPositive = (tx.fx_impact_so_payment || 0) >= 0;
                  const isIdr = tx.sale_currency === 'IDR';

                  return (
                    <tr 
                      key={tx.id}
                      onClick={() => setSelectedTx(tx)}
                      className="hover:bg-blue-50/40 cursor-pointer transition-colors group"
                    >
                      {/* Sales Order */}
                      <td className="py-3.5 px-4 whitespace-nowrap">
                        <span className="font-bold text-slate-900 group-hover:text-blue-600 transition-colors">
                          {tx.so_number}
                        </span>
                        <div className="text-[11px] text-slate-400">{fmtDate(tx.so_date)}</div>
                        {tx.si_number && (
                          <span className="inline-block mt-1 text-[10px] px-1.5 py-0.5 bg-slate-100 text-slate-600 rounded">
                            Inv: {tx.si_number}
                          </span>
                        )}
                      </td>

                      {/* Customer & Product */}
                      <td className="py-3.5 px-4 max-w-[180px]">
                        <div className="font-semibold text-slate-900 truncate" title={tx.customer_name}>
                          {tx.customer_name}
                        </div>
                        <div className="text-slate-500 truncate mt-0.5" title={tx.product_name}>
                          {tx.product_name}
                        </div>
                        <span className="text-[10px] text-slate-400">
                          {fmt(tx.so_quantity)} {tx.product_unit}
                        </span>
                      </td>

                      {/* Sale Currency */}
                      <td className="py-3.5 px-4 text-center whitespace-nowrap">
                        {isIdr ? (
                          <span className="px-2 py-0.5 bg-slate-100 text-slate-700 border border-slate-200 rounded font-bold text-[10px] uppercase tracking-wide">
                            IDR
                          </span>
                        ) : (
                          <span className="px-2 py-0.5 bg-blue-100 text-blue-800 border border-blue-200 rounded font-bold text-[10px] uppercase tracking-wide">
                            USD
                          </span>
                        )}
                      </td>

                      {/* USD SO Value */}
                      <td className="py-3.5 px-4 text-right whitespace-nowrap">
                        {isIdr ? (
                          <div>
                            <span className="text-slate-400 font-normal">—</span>
                            <div className="text-[11px] font-semibold text-slate-800">
                              Rp {fmt(tx.idr_sales_value)}
                            </div>
                          </div>
                        ) : (
                          <div>
                            <span className="font-bold text-blue-900">{fmtUsd(tx.usd_sales_amount)}</span>
                            <div className="text-[10px] text-slate-400">USD Deal</div>
                          </div>
                        )}
                      </td>

                      {/* Sales Order Commercial Rate */}
                      <td className="py-3.5 px-4 text-right whitespace-nowrap">
                        {isIdr ? (
                          tx.so_rate ? (
                            <div>
                              <span className="text-slate-700 font-medium">Rp {fmt(tx.so_rate)}</span>
                              <div className="text-[10px] text-slate-400">Quotation Ref</div>
                            </div>
                          ) : (
                            <span className="text-slate-400">—</span>
                          )
                        ) : (
                          tx.so_rate ? (
                            <span className="px-2 py-0.5 bg-blue-50 text-blue-700 font-bold rounded border border-blue-200/60">
                              Rp {fmt(tx.so_rate)}
                            </span>
                          ) : (
                            <span className="px-2 py-0.5 bg-amber-50 text-amber-700 font-bold rounded border border-amber-200 text-xs">
                              Missing SO Rate
                            </span>
                          )
                        )}
                      </td>

                      {/* Commercial IDR Equivalent */}
                      <td className="py-3.5 px-4 text-right whitespace-nowrap">
                        {isIdr ? (
                          <span className="text-slate-400">—</span>
                        ) : (
                          tx.idr_commercial_equivalent !== null ? (
                            <div>
                              <span className="font-semibold text-slate-900">
                                Rp {fmt(tx.idr_commercial_equivalent)}
                              </span>
                              <div className="text-[10px] text-slate-400">USD × SO Rate</div>
                            </div>
                          ) : (
                            <span className="text-slate-400 italic">Missing Rate</span>
                          )
                        )}
                      </td>

                      {/* Actual IDR Invoiced */}
                      <td className="py-3.5 px-4 text-right whitespace-nowrap">
                        {tx.actual_invoiced_idr !== null ? (
                          <div>
                            <span className="font-semibold text-slate-800">
                              Rp {fmt(tx.actual_invoiced_idr)}
                            </span>
                            {tx.si_number && (
                              <div className="text-[10px] text-slate-400">{tx.si_number}</div>
                            )}
                          </div>
                        ) : (
                          <span className="text-slate-400 italic">Uninvoiced</span>
                        )}
                      </td>

                      {/* Supplier & PI */}
                      <td className="py-3.5 px-4 max-w-[170px]">
                        <div className="font-semibold text-slate-800 truncate" title={tx.supplier_name}>
                          {tx.supplier_name}
                        </div>
                        {tx.pi_number ? (
                          <div className="text-slate-500 text-[11px]">
                            {tx.pi_number} ({fmtDate(tx.pi_date)})
                          </div>
                        ) : (
                          <div className="text-slate-400 text-[11px]">Unlinked PI</div>
                        )}
                        {tx.batch_number && (
                          <span className="text-[10px] text-slate-400 block mt-0.5">
                            Batch: {tx.batch_number}
                          </span>
                        )}
                      </td>

                      {/* Import Rate */}
                      <td className="py-3.5 px-4 text-right whitespace-nowrap">
                        {tx.import_rate && tx.import_rate > 1 ? (
                          <div>
                            <span className="font-bold text-amber-800">
                              Rp {fmt(tx.import_rate)}
                            </span>
                            {!isIdr && tx.commercial_spread !== null && (
                              <div className="text-[10px] text-slate-400 mt-0.5">
                                Spread: {tx.commercial_spread >= 0 ? '+' : ''}{fmt(tx.commercial_spread)}
                              </div>
                            )}
                          </div>
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </td>

                      {/* Payment Voucher */}
                      <td className="py-3.5 px-4 whitespace-nowrap">
                        {isIdr ? (
                          <span className="text-slate-400 italic">N/A (IDR Sale)</span>
                        ) : tx.pv_number ? (
                          <div>
                            <span className="font-bold text-slate-800">{tx.pv_number}</span>
                            <div className="text-[11px] text-slate-400">{fmtDate(tx.pv_date)}</div>
                            {tx.is_multiple_payments && (
                              <span className="inline-block mt-0.5 px-1.5 py-0.2 bg-indigo-50 text-indigo-700 rounded text-[10px] font-medium">
                                Multi-payment
                              </span>
                            )}
                          </div>
                        ) : (
                          <span className="text-slate-400 italic">Pending</span>
                        )}
                      </td>

                      {/* Payment Rate */}
                      <td className="py-3.5 px-4 text-right whitespace-nowrap">
                        {isIdr ? (
                          <span className="text-slate-400">—</span>
                        ) : tx.payment_rate ? (
                          <span className="font-bold text-emerald-800">
                            Rp {fmt(tx.payment_rate)}
                          </span>
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </td>

                      {/* USD Settled */}
                      <td className="py-3.5 px-4 text-right font-medium whitespace-nowrap">
                        {isIdr ? (
                          <span className="text-slate-400">—</span>
                        ) : tx.usd_settled > 0 ? (
                          <div>
                            <span className="text-slate-900">{fmtUsd(tx.usd_settled)}</span>
                            {tx.idr_supplier_payment > 0 && (
                              <div className="text-[10px] text-slate-400">
                                Rp {fmt(tx.idr_supplier_payment)}
                              </div>
                            )}
                          </div>
                        ) : (
                          <span className="text-slate-400">$0.00</span>
                        )}
                      </td>

                      {/* SO -> Payment FX Impact */}
                      <td className="py-3.5 px-4 text-right whitespace-nowrap">
                        {isIdr ? (
                          <span className="px-2 py-0.5 bg-slate-100 text-slate-500 rounded text-xs font-semibold">
                            N/A
                          </span>
                        ) : tx.fx_impact_so_payment !== null ? (
                          <span className={`px-2.5 py-1 rounded-lg font-bold border text-xs ${
                            isPositive 
                              ? 'bg-emerald-50 text-emerald-700 border-emerald-200' 
                              : 'bg-rose-50 text-rose-700 border-rose-200'
                          }`}>
                            {isPositive ? '+' : ''}Rp {fmt(tx.fx_impact_so_payment)}
                          </span>
                        ) : (
                          <span className="text-slate-400 italic text-xs">Pending data</span>
                        )}
                      </td>

                      {/* Status */}
                      <td className="py-3.5 px-4 text-center whitespace-nowrap">
                        {tx.settlement_status === 'IDR Sale' && (
                          <span className="inline-flex items-center gap-1 px-2.5 py-1 bg-slate-100 text-slate-700 rounded-full text-[11px] font-semibold">
                            <CheckCircle2 className="w-3 h-3 text-slate-500" /> IDR Order
                          </span>
                        )}
                        {tx.settlement_status === 'Complete' && (
                          <span className="inline-flex items-center gap-1 px-2.5 py-1 bg-emerald-100 text-emerald-800 rounded-full text-[11px] font-bold">
                            <CheckCircle2 className="w-3 h-3" /> Complete
                          </span>
                        )}
                        {tx.settlement_status === 'Missing SO Rate' && (
                          <span className="inline-flex items-center gap-1 px-2.5 py-1 bg-amber-100 text-amber-800 rounded-full text-[11px] font-bold">
                            <AlertCircle className="w-3 h-3 text-amber-600" /> Missing SO Rate
                          </span>
                        )}
                        {tx.settlement_status === 'Pending Payment' && (
                          <span className="inline-flex items-center gap-1 px-2.5 py-1 bg-blue-100 text-blue-800 rounded-full text-[11px] font-medium">
                            <Clock className="w-3 h-3" /> Pending Payment
                          </span>
                        )}
                        {tx.settlement_status === 'Unmatched' && (
                          <span className="inline-flex items-center gap-1 px-2.5 py-1 bg-slate-100 text-slate-700 rounded-full text-[11px] font-medium">
                            <AlertCircle className="w-3 h-3" /> Unmatched
                          </span>
                        )}
                      </td>

                      {/* Action */}
                      <td className="py-3.5 px-3 text-center">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedTx(tx);
                          }}
                          className="p-1.5 hover:bg-blue-100 text-blue-600 rounded-lg transition-colors"
                          title="View Drilldown Trace"
                        >
                          <Eye className="w-4 h-4" />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Drill-down Trace Drawer / Modal */}
      {selectedTx && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white w-full max-w-4xl rounded-2xl shadow-2xl border border-slate-200 overflow-hidden flex flex-col max-h-[90vh]">
            {/* Modal Header */}
            <div className="px-6 py-5 bg-gradient-to-r from-slate-900 to-indigo-950 text-white flex items-center justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase border ${
                    selectedTx.sale_currency === 'USD'
                      ? 'bg-blue-500/30 text-blue-300 border-blue-400/40'
                      : 'bg-slate-700 text-slate-200 border-slate-600'
                  }`}>
                    {selectedTx.sale_currency === 'USD' ? 'USD Commercial FX Trace' : 'IDR Order Commercial Trace'}
                  </span>
                  <span className="text-xs text-slate-300">
                    {selectedTx.product_name}
                  </span>
                </div>
                <h3 className="text-xl font-bold mt-1">
                  Trace: {selectedTx.so_number} ({selectedTx.sale_currency}) → {selectedTx.pi_number || 'Unlinked PI'} → {selectedTx.pv_number || 'Pending Settlement'}
                </h3>
              </div>
              <button
                onClick={() => setSelectedTx(null)}
                className="p-2 hover:bg-white/10 rounded-xl transition-colors text-slate-300 hover:text-white"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Modal Body */}
            <div className="p-6 overflow-y-auto space-y-6">
              {/* IDR Order Notice Banner */}
              {selectedTx.sale_currency === 'IDR' ? (
                <div className="bg-slate-50 border border-slate-200 rounded-xl p-5 space-y-3">
                  <div className="flex items-center gap-2 text-slate-900 font-bold text-sm">
                    <CheckCircle2 className="w-5 h-5 text-blue-600 flex-shrink-0" />
                    Domestic IDR Customer Sale — Commercial FX Impact is N/A
                  </div>
                  <p className="text-xs text-slate-600 leading-relaxed">
                    This order (<strong>{selectedTx.so_number}</strong>) was quoted, agreed, and invoiced in domestic Indonesian Rupiah (<strong>Rp {fmt(selectedTx.idr_sales_value)}</strong>).
                    Therefore, the customer commercial transaction bears zero USD FX exposure.
                    Any supplier import FX from upstream purchase invoices is tracked separately in the supplier purchase accounting flow.
                  </p>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-2">
                    <div className="bg-white p-3 rounded-lg border border-slate-200">
                      <span className="text-[11px] text-slate-500 block">Sale Currency</span>
                      <span className="text-sm font-bold text-slate-900 mt-0.5 block">IDR</span>
                    </div>
                    <div className="bg-white p-3 rounded-lg border border-slate-200">
                      <span className="text-[11px] text-slate-500 block">Actual IDR SO Value</span>
                      <span className="text-sm font-bold text-slate-900 mt-0.5 block">Rp {fmt(selectedTx.idr_sales_value)}</span>
                    </div>
                    <div className="bg-white p-3 rounded-lg border border-slate-200">
                      <span className="text-[11px] text-slate-500 block">SO → Payment FX Impact</span>
                      <span className="text-sm font-bold text-slate-500 mt-0.5 block">N/A</span>
                    </div>
                  </div>
                </div>
              ) : (
                <>
                  {/* Visual 3-Stage Rate Progression Card (For genuine USD orders) */}
                  <div className="bg-slate-50 border border-slate-200 rounded-xl p-5">
                    <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-4">
                      The Three Rates Progression (USD Customer Order)
                    </h4>

                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4 relative">
                      {/* Step 1: Import Rate */}
                      <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm relative">
                        <span className="text-[11px] font-semibold text-amber-700 uppercase tracking-wider block">
                          A. Import / Purchase Rate
                        </span>
                        <div className="text-2xl font-black text-slate-900 mt-1">
                          {selectedTx.import_rate && selectedTx.import_rate > 1 ? `Rp ${fmt(selectedTx.import_rate)}` : '—'}
                        </div>
                        <div className="text-xs text-slate-500 mt-2 space-y-0.5">
                          <div>PI: <span className="font-semibold text-slate-700">{selectedTx.pi_number || '—'}</span></div>
                          <div>Supplier: <span className="font-semibold text-slate-700">{selectedTx.supplier_name}</span></div>
                        </div>
                      </div>

                      {/* Step 2: Sales Order Rate */}
                      <div className="bg-blue-50/50 p-4 rounded-xl border border-blue-200 shadow-sm relative">
                        <span className="text-[11px] font-semibold text-blue-700 uppercase tracking-wider block">
                          B. Sales Order Rate
                        </span>
                        <div className="text-2xl font-black text-blue-950 mt-1">
                          {selectedTx.so_rate ? (
                            `Rp ${fmt(selectedTx.so_rate)}`
                          ) : (
                            <span className="text-amber-600 text-lg font-bold">Missing SO Rate</span>
                          )}
                        </div>
                        <div className="text-xs text-slate-600 mt-2 space-y-0.5">
                          <div>SO: <span className="font-semibold text-slate-800">{selectedTx.so_number}</span></div>
                          <div>Customer: <span className="font-semibold text-slate-800">{selectedTx.customer_name}</span></div>
                        </div>
                      </div>

                      {/* Step 3: Supplier Payment Rate */}
                      <div className="bg-emerald-50/50 p-4 rounded-xl border border-emerald-200 shadow-sm relative">
                        <span className="text-[11px] font-semibold text-emerald-700 uppercase tracking-wider block">
                          C. Supplier Payment Rate
                        </span>
                        <div className="text-2xl font-black text-emerald-950 mt-1">
                          {selectedTx.payment_rate ? `Rp ${fmt(selectedTx.payment_rate)}` : 'Pending'}
                        </div>
                        <div className="text-xs text-slate-600 mt-2 space-y-0.5">
                          <div>Voucher: <span className="font-semibold text-slate-800">{selectedTx.pv_number || 'Unpaid'}</span></div>
                          <div>Settled: <span className="font-semibold text-slate-800">{fmtUsd(selectedTx.usd_settled)}</span></div>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Arithmetic Breakdown Card */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {/* 1. Commercial Pricing Spread */}
                    <div className="p-4 bg-amber-50/60 border border-amber-200 rounded-xl space-y-2">
                      <span className="text-xs font-bold text-amber-800 uppercase tracking-wider">
                        1. Commercial Rate Spread (Pricing Margin)
                      </span>
                      <div className="text-xs text-slate-600 space-y-1 mt-1">
                        <div>Formula: <code className="bg-white px-1.5 py-0.5 rounded border">Sales Order Rate - Import Rate</code></div>
                        <div className="font-semibold text-slate-800">
                          {selectedTx.so_rate && selectedTx.import_rate && selectedTx.import_rate > 1 ? (
                            `Rp ${fmt(selectedTx.so_rate)} - Rp ${fmt(selectedTx.import_rate)} = Rp ${fmt(selectedTx.so_rate - selectedTx.import_rate)} / USD`
                          ) : (
                            <span className="text-slate-400 italic">Requires both SO Rate and Import Rate</span>
                          )}
                        </div>
                        <div className="text-sm font-bold text-amber-900 pt-1">
                          Spread Value: {selectedTx.commercial_spread_value !== null ? `Rp ${fmt(selectedTx.commercial_spread_value)}` : '—'}
                        </div>
                        <p className="text-[11px] text-amber-700 pt-1">
                          Commercial pricing spread established at sales order creation against initial import reference.
                        </p>
                      </div>
                    </div>

                    {/* 2. Realized Settlement Impact */}
                    <div className={`p-4 rounded-xl border space-y-2 ${
                      selectedTx.fx_impact_so_payment !== null && selectedTx.fx_impact_so_payment >= 0 
                        ? 'bg-emerald-50/70 border-emerald-200' 
                        : selectedTx.fx_impact_so_payment !== null 
                        ? 'bg-rose-50/70 border-rose-200'
                        : 'bg-slate-50 border-slate-200'
                    }`}>
                      <span className="text-xs font-bold uppercase tracking-wider text-slate-800">
                        2. SO → Payment FX Impact (Settlement Margin)
                      </span>
                      <div className="text-xs text-slate-600 space-y-1 mt-1">
                        <div>Formula: <code className="bg-white px-1.5 py-0.5 rounded border">USD Settled × (SO Rate - Payment Rate)</code></div>
                        <div className="font-semibold text-slate-800">
                          {selectedTx.so_rate && selectedTx.payment_rate ? (
                            `${fmtUsd(selectedTx.usd_settled)} × (Rp ${fmt(selectedTx.so_rate)} - Rp ${fmt(selectedTx.payment_rate)})`
                          ) : (
                            <span className="text-slate-400 italic">Requires both valid SO Rate and Supplier Payment</span>
                          )}
                        </div>
                        <div className={`text-base font-black pt-1 ${
                          selectedTx.fx_impact_so_payment !== null
                            ? selectedTx.fx_impact_so_payment >= 0 ? 'text-emerald-700' : 'text-rose-700'
                            : 'text-slate-400'
                        }`}>
                          {selectedTx.fx_impact_so_payment !== null
                            ? `${selectedTx.fx_impact_so_payment >= 0 ? '+' : ''}Rp ${fmt(selectedTx.fx_impact_so_payment)}`
                            : 'Pending data'}
                        </div>
                        <p className="text-[11px] text-slate-600 pt-1">
                          {selectedTx.fx_impact_so_payment !== null ? (
                            selectedTx.fx_impact_so_payment >= 0 
                              ? 'Favorable: The supplier settlement rate was lower than the rate quoted to the customer, preserving/increasing profit margin.'
                              : 'Unfavorable: The supplier settlement rate was higher than the rate quoted to the customer, eroding commercial margin.'
                          ) : (
                            'Cannot calculate FX impact until commercial sales order rate is specified and supplier payment is settled.'
                          )}
                        </p>
                      </div>
                    </div>
                  </div>

                  {/* Multiple Payments Breakdown (if applicable) */}
                  {selectedTx.is_multiple_payments && selectedTx.all_payments && selectedTx.all_payments.length > 1 && (
                    <div className="bg-white border border-indigo-200 rounded-xl p-4 shadow-sm">
                      <h4 className="text-xs font-bold text-indigo-900 uppercase tracking-wider mb-2">
                        Multi-Payment Voucher Allocations ({selectedTx.all_payments.length} Payments)
                      </h4>
                      <table className="w-full text-xs text-left">
                        <thead>
                          <tr className="border-b text-slate-500 font-semibold">
                            <th className="py-2">Voucher</th>
                            <th className="py-2">Date</th>
                            <th className="py-2 text-right">Payment Rate</th>
                            <th className="py-2 text-right">USD Amount</th>
                            <th className="py-2 text-right">IDR Paid</th>
                            <th className="py-2 text-right">Payment FX Impact</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {selectedTx.all_payments.map((p, idx) => (
                            <tr key={idx} className="hover:bg-slate-50">
                              <td className="py-2 font-bold text-slate-800">{p.pv_number}</td>
                              <td className="py-2 text-slate-500">{fmtDate(p.pv_date)}</td>
                              <td className="py-2 text-right font-semibold text-emerald-800">
                                {p.is_real_fx ? `Rp ${fmt(p.rate)}` : '1.00 (Same Currency)'}
                              </td>
                              <td className="py-2 text-right font-medium">{fmtUsd(p.usd_amount)}</td>
                              <td className="py-2 text-right text-slate-600">
                                {p.is_real_fx ? `Rp ${fmt(p.idr_paid)}` : '—'}
                              </td>
                              <td className="py-2 text-right font-bold">
                                {p.impact !== null ? (
                                  <span className={p.impact >= 0 ? 'text-emerald-600' : 'text-rose-600'}>
                                    {p.impact >= 0 ? '+' : ''}Rp {fmt(p.impact)}
                                  </span>
                                ) : '—'}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </>
              )}

              {/* Detailed Traced Documents Grid */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
                {/* SO Box */}
                <div className="p-4 bg-slate-50 border border-slate-200 rounded-xl space-y-1.5">
                  <div className="flex items-center justify-between font-bold text-slate-800 border-b pb-1.5">
                    <span>Sales Order Details</span>
                    {onViewSalesOrder && (
                      <button onClick={() => onViewSalesOrder(selectedTx.so_id)} className="text-blue-600 hover:underline flex items-center gap-0.5">
                        Open <ExternalLink className="w-3 h-3" />
                      </button>
                    )}
                  </div>
                  <div>SO Number: <span className="font-semibold text-slate-800">{selectedTx.so_number}</span></div>
                  <div>SO Date: <span className="text-slate-700">{fmtDate(selectedTx.so_date)}</span></div>
                  <div>Customer: <span className="text-slate-700">{selectedTx.customer_name}</span></div>
                  <div>Sale Currency: <span className="font-bold text-slate-900">{selectedTx.sale_currency}</span></div>
                  <div>Product Qty: <span className="text-slate-700">{fmt(selectedTx.so_quantity)} {selectedTx.product_unit}</span></div>
                  {selectedTx.sale_currency === 'USD' ? (
                    <>
                      <div>Original SO USD: <span className="font-bold text-blue-900">{fmtUsd(selectedTx.usd_sales_amount)}</span></div>
                      <div>Commercial IDR: <span className="text-slate-700">{selectedTx.idr_commercial_equivalent ? `Rp ${fmt(selectedTx.idr_commercial_equivalent)}` : 'Missing Rate'}</span></div>
                      <div>Invoiced IDR: <span className="text-slate-700">{selectedTx.actual_invoiced_idr ? `Rp ${fmt(selectedTx.actual_invoiced_idr)}` : '—'}</span></div>
                    </>
                  ) : (
                    <div>Actual IDR Value: <span className="font-bold text-slate-900">Rp {fmt(selectedTx.idr_sales_value)}</span></div>
                  )}
                </div>

                {/* Purchase Invoice Box */}
                <div className="p-4 bg-slate-50 border border-slate-200 rounded-xl space-y-1.5">
                  <div className="flex items-center justify-between font-bold text-slate-800 border-b pb-1.5">
                    <span>Purchase Invoice Details</span>
                    {selectedTx.pi_id && onViewInvoice && (
                      <button onClick={() => onViewInvoice(selectedTx.pi_id!)} className="text-blue-600 hover:underline flex items-center gap-0.5">
                        Open <ExternalLink className="w-3 h-3" />
                      </button>
                    )}
                  </div>
                  <div>Supplier: <span className="font-semibold text-slate-800">{selectedTx.supplier_name}</span></div>
                  <div>Invoice #: <span className="text-slate-700">{selectedTx.pi_number || '—'}</span></div>
                  <div>Invoice Date: <span className="text-slate-700">{fmtDate(selectedTx.pi_date)}</span></div>
                  <div>Batch: <span className="text-slate-700">{selectedTx.batch_number || '—'}</span></div>
                  <div>Import Rate: <span className="font-bold text-amber-800">{selectedTx.import_rate && selectedTx.import_rate > 1 ? `Rp ${fmt(selectedTx.import_rate)}` : '—'}</span></div>
                  <div>PI Total USD: <span className="text-slate-700">{fmtUsd(selectedTx.pi_total_usd)}</span></div>
                </div>

                {/* Payment Voucher Box */}
                <div className="p-4 bg-slate-50 border border-slate-200 rounded-xl space-y-1.5">
                  <div className="flex items-center justify-between font-bold text-slate-800 border-b pb-1.5">
                    <span>Payment Voucher Details</span>
                    {selectedTx.pv_id && onViewPayment && (
                      <button onClick={() => onViewPayment(selectedTx.pv_id!)} className="text-blue-600 hover:underline flex items-center gap-0.5">
                        Open <ExternalLink className="w-3 h-3" />
                      </button>
                    )}
                  </div>
                  {selectedTx.sale_currency === 'IDR' ? (
                    <div className="text-slate-500 italic py-2">
                      Supplier payment vouchers are tracked separately in the purchase accounting flow and not linked to customer IDR sales.
                    </div>
                  ) : (
                    <>
                      <div>Voucher #: <span className="font-semibold text-slate-800">{selectedTx.pv_number || 'Not Paid'}</span></div>
                      <div>Voucher Date: <span className="text-slate-700">{fmtDate(selectedTx.pv_date)}</span></div>
                      <div>Payment Rate: <span className="font-bold text-emerald-800">{selectedTx.payment_rate ? `Rp ${fmt(selectedTx.payment_rate)}` : '—'}</span></div>
                      <div>USD Settled: <span className="font-bold text-slate-900">{fmtUsd(selectedTx.usd_settled)}</span></div>
                      <div>IDR Paid: <span className="text-slate-700">Rp {fmt(selectedTx.idr_supplier_payment)}</span></div>
                      <div>Status: <span className="font-semibold text-slate-800">{selectedTx.settlement_status}</span></div>
                    </>
                  )}
                </div>
              </div>
            </div>

            {/* Modal Footer */}
            <div className="px-6 py-4 bg-slate-50 border-t border-slate-200 flex items-center justify-end">
              <button
                onClick={() => setSelectedTx(null)}
                className="px-5 py-2 bg-slate-800 hover:bg-slate-700 text-white rounded-xl text-xs font-semibold transition-all shadow-sm"
              >
                Close Trace
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

