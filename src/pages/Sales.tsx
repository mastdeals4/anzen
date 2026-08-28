import { useEffect, useState } from 'react';
import { Layout } from '../components/Layout';
import { DataTable } from '../components/DataTable';
import { Modal } from '../components/Modal';
import { InvoiceView } from '../components/InvoiceView';
import { DeliveryChallanView } from '../components/DeliveryChallanView';
import { ProformaInvoiceView } from '../components/ProformaInvoiceView';
import { DCMultiSelect } from '../components/DCMultiSelect';
import { SearchableSelect } from '../components/SearchableSelect';
import { useLanguage } from '../contexts/LanguageContext';
import { useAuth } from '../contexts/AuthContext';
import { useNavigation } from '../contexts/NavigationContext';
import { useFinance } from '../contexts/FinanceContext';
import { supabase } from '../lib/supabase';
import { Plus, Pencil as Edit, Trash2, FileText, Eye, FileX } from 'lucide-react';
import { showToast } from '../components/ToastNotification';
import { showConfirm } from '../components/ConfirmDialog';
import { formatDate } from '../utils/dateFormat';
import { fetchLinkedDocumentsBundle, LinkedDocRef } from '../utils/linkedDocuments';
import { LinkedDocsCell } from '../components/LinkedDocsCell';
import { MoneyInput } from '../components/MoneyInput';
import { loadInvoiceDisplayItems } from '../utils/invoiceItemDisplay';

interface SalesInvoice {
  id: string;
  invoice_number: string;
  customer_id: string;
  sales_order_id?: string | null;
  invoice_date: string;
  due_date: string;
  subtotal: number;
  tax_amount: number;
  stamp_duty_amount: number;
  discount_amount: number;
  total_amount: number;
  payment_status: 'pending' | 'partial' | 'paid';
  delivery_challan_number: string | null;
  po_number: string | null;
  payment_terms_days: number | null;
  notes: string | null;
  linked_challan_ids?: string[] | null;
  paid_amount?: number;
  balance_amount?: number;
  product_names?: string;
  item_count?: number;
  item_integrity_status?: 'ok' | 'missing_product_rows';
  customers?: {
    company_name: string;
    gst_vat_type: string;
  };
  sales_order?: {
    so_number: string;
    order_date: string;
  } | null;
  linked_challans?: Array<{
    id: string;
    challan_number: string;
    challan_date: string;
  }>;
}

interface SOItemOption {
  product_id: string;
  product_name: string;
  unit_price: number;
}

interface SalesOrderOption {
  id: string;
  so_number: string;
  total_amount: number;
  advance_payment_amount: number;
  advance_payment_status: string;
  status: string;
  items?: SOItemOption[];
}

interface InvoiceItem {
  id?: string;
  product_id: string;
  batch_id: string | null;
  quantity: number;
  unit_price: number;
  tax_rate: number;
  total: number;
  delivery_challan_item_id?: string | null;
  challan_id?: string | null;
  dc_number?: string;
  max_quantity?: number;
  products?: {
    product_name: string;
    product_code: string;
  };
  batches?: {
    batch_number: string;
  } | null;
}

interface DCItem {
  dc_item_id: string;
  product_id: string;
  product_name: string;
  batch_id: string;
  batch_number: string;
  unit: string;
  pack_size: number;
  pack_type: string;
  number_of_packs: number;
  original_quantity: number;
  remaining_quantity: number;
  purchase_price: number;
  selling_price: number;
  mrp: number;
  is_from_editing: boolean;
}

interface DCWithItems {
  challan_id: string;
  challan_number: string;
  challan_date: string;
  dc_status: string;
  items: DCItem[];
}

interface SelectedDCItem {
  dcItemId: string;
  dcNumber: string;
  selected: boolean;
  quantity: number;
}

interface Customer {
  id: string;
  company_name: string;
  gst_vat_type: string;
}

interface Product {
  id: string;
  product_name: string;
  product_code: string;
}

interface Batch {
  id: string;
  batch_number: string;
  product_id: string;
  current_stock: number;
  import_price: number;
  duty_charges: number;
  freight_charges: number;
  other_charges: number;
}

interface DeliveryChallan {
  id: string;
  challan_number: string;
  challan_date: string;
  delivery_address: string;
  vehicle_number: string | null;
  notes: string | null;
}

interface ChallanItem {
  product_id: string;
  batch_id: string;
  quantity: number;
  products?: {
    product_name: string;
    product_code: string;
  };
  batches?: {
    batch_number: string;
  };
}

export function Sales() {
  const { t } = useLanguage();
  const { profile } = useAuth();
  const { navigationData, clearNavigationData, setCurrentPage } = useNavigation();
  const { dateRange } = useFinance();
  const [invoices, setInvoices] = useState<SalesInvoice[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [pendingChallans, setPendingChallans] = useState<DeliveryChallan[]>([]);
  const [pendingDCOptions, setPendingDCOptions] = useState<Array<{ challan_id: string; challan_number: string; challan_date: string; item_count: number; product_names?: string }>>([]);
  const [customerSalesOrders, setCustomerSalesOrders] = useState<SalesOrderOption[]>([]);
  const [selectedSOId, setSelectedSOId] = useState<string>('');
  const [soAutoLinked, setSoAutoLinked] = useState(false);
  const [selectedDCIds, setSelectedDCIds] = useState<string[]>([]);
  const [selectedChallanId, setSelectedChallanId] = useState<string>('');
  const [pendingDCsWithItems, setPendingDCsWithItems] = useState<DCWithItems[]>([]);
  const [selectedDCItems, setSelectedDCItems] = useState<Map<string, SelectedDCItem>>(new Map());
  const [expandedDCs, setExpandedDCs] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [viewModalOpen, setViewModalOpen] = useState(false);
  const [editingInvoice, setEditingInvoice] = useState<SalesInvoice | null>(null);
  const [selectedInvoice, setSelectedInvoice] = useState<SalesInvoice | null>(null);
  const [selectedFlyChallan, setSelectedFlyChallan] = useState<any | null>(null);
  const [linkedSOPreview, setLinkedSOPreview] = useState<any | null>(null);
  const [selectedFlyChallanItems, setSelectedFlyChallanItems] = useState<any[]>([]);
  const [invoiceItems, setInvoiceItems] = useState<InvoiceItem[]>([]);
  const [formData, setFormData] = useState({
    invoice_number: '',
    customer_id: '',
    invoice_date: new Date().toISOString().split('T')[0],
    payment_terms: '30',
    discount: 0,
    stamp_duty_amount: 0,
    delivery_challan_number: '',
    po_number: '',
    notes: '',
  });
  const [items, setItems] = useState<InvoiceItem[]>([{
    product_id: '',
    batch_id: null,
    quantity: 1,
    unit_price: 0,
    tax_rate: 11,
    total: 0,
  }]);

  useEffect(() => {
    loadInvoices();
    loadCustomers();
    loadProducts();
    loadBatches();
  }, [dateRange.startDate, dateRange.endDate]);

  useEffect(() => {
    if (navigationData?.sourceType === 'delivery_challan') {
      handleDeliveryChallanData(navigationData);
      clearNavigationData();
    }
  }, [navigationData]);

  useEffect(() => {
    if (selectedDCIds.length > 0 && formData.customer_id && !editingInvoice) {
      void loadItemsFromSelectedDCs(selectedDCIds);
    }
  }, [selectedDCIds]);

  const loadItemsFromSelectedDCs = async (challanIds: string[]) => {
    try {
      const { data, error } = await supabase
        .from('pending_dc_items_by_customer')
        .select('*')
        .eq('customer_id', formData.customer_id)
        .in('challan_id', challanIds);

      if (error) throw error;

      // Check if selected DCs are linked to a Sales Order
      const { data: dcData } = await supabase
        .from('delivery_challans')
        .select('id, sales_order_id')
        .in('id', challanIds)
        .not('sales_order_id', 'is', null);

      // Find a common SO from the DCs
      const soIds = Array.from(new Set((dcData || []).map((d: any) => d.sales_order_id).filter(Boolean)));
      const soItemPriceMap: Record<string, number> = {};

      if (soIds.length === 1) {
        // All DCs link to the same SO — auto-link it
        const linkedSoId = soIds[0];
        setSelectedSOId(linkedSoId);
        setSoAutoLinked(true);

        // Load SO items to get agreed prices
        const { data: soItems } = await supabase
          .from('sales_order_items')
          .select('product_id, unit_price')
          .eq('sales_order_id', linkedSoId);

        (soItems || []).forEach((si: any) => {
          soItemPriceMap[si.product_id] = si.unit_price;
        });
      } else if (soIds.length === 0 && selectedSOId) {
        // DCs have no SO link — keep existing manual SO selection but don't auto-set
        setSoAutoLinked(false);
        const { data: soItems } = await supabase
          .from('sales_order_items')
          .select('product_id, unit_price')
          .eq('sales_order_id', selectedSOId);
        (soItems || []).forEach((si: any) => {
          soItemPriceMap[si.product_id] = si.unit_price;
        });
      } else {
        setSoAutoLinked(false);
      }

      const dcItems = (data || []).map((item: any) => {
        // Use SO price if available for this product, else fall back to DC selling_price
        const soPrice = soItemPriceMap[item.product_id];
        const unitPrice = soPrice !== undefined ? soPrice : (item.selling_price || item.unit_price || 0);

        return {
          product_id: item.product_id,
          batch_id: item.batch_id,
          quantity: item.remaining_quantity,
          unit_price: unitPrice,
          tax_rate: 11,
          total: 0,
          delivery_challan_item_id: item.dc_item_id,
          challan_id: item.challan_id,
          dc_number: item.challan_number,
          max_quantity: item.remaining_quantity,
        };
      });

      if (dcItems.length > 0) {
        setItems(previous => {
          const existingDcItemIds = new Set(previous.map(item => item.delivery_challan_item_id).filter(Boolean));
          const additions = dcItems
            .filter(item => !existingDcItemIds.has(item.delivery_challan_item_id))
            .map(item => ({ ...item, total: calculateItemTotal(item) }));
          const retained = previous.filter(item => item.product_id || item.delivery_challan_item_id);
          return additions.length > 0 ? [...retained, ...additions] : retained;
        });
      }
    } catch (error) {
      console.error('Error loading DC items:', error);
    }
  };

  const handleDCMultiSelectChange = async (nextIds: string[]) => {
    const currentIds = new Set(selectedDCIds);
    const nextIdSet = new Set(nextIds);
    const removedIds = selectedDCIds.filter(id => !nextIdSet.has(id));
    const protectedIds = new Set(items.map(item => item.challan_id).filter((id): id is string => Boolean(id)));

    // Existing invoice lines are accounting/source records. Keep their DC link
    // immutable during edit instead of silently deleting source lines.
    if (editingInvoice && removedIds.some(id => protectedIds.has(id))) {
      const restoredIds = [...new Set([...nextIds, ...removedIds.filter(id => protectedIds.has(id))])];
      setSelectedDCIds(restoredIds);
      showToast({ type: 'info', title: 'Delivery Challan retained', message: 'A Delivery Challan with existing invoice lines cannot be removed while editing.' });
      return;
    }

    if (!editingInvoice && removedIds.length > 0) {
      setItems(previous => previous.filter(item => !item.challan_id || !removedIds.includes(item.challan_id)));
    }

    setSelectedDCIds(nextIds);
    const addedIds = nextIds.filter(id => !currentIds.has(id));
    if (addedIds.length > 0 && formData.customer_id) {
      await loadItemsFromSelectedDCs(addedIds);
    }
  };

  const loadInvoices = async () => {
    try {
      const { data, error } = await supabase
        .from('sales_invoices')
        .select('*, customers(company_name, address, city, phone, npwp, pharmacy_license, gst_vat_type)')
        .gte('invoice_date', dateRange.startDate)
        .lte('invoice_date', dateRange.endDate)
        .order('invoice_date', { ascending: false });

      if (error) throw error;

      // Calculate paid amount and balance for each invoice (bulk aggregation
      // replicates get_invoice_paid_amount = voucher_allocations(receipt) + invoice_rounding_adjustments).
      const invoiceIdsForPaid = (data || []).map((inv) => inv.id);
      const paidById = new Map<string, number>();
      if (invoiceIdsForPaid.length > 0) {
        const [{ data: allocs }, { data: adjs }] = await Promise.all([
          supabase
            .from('voucher_allocations')
            .select('sales_invoice_id, allocated_amount')
            .in('sales_invoice_id', invoiceIdsForPaid)
            .eq('voucher_type', 'receipt'),
          supabase
            .from('invoice_rounding_adjustments')
            .select('sales_invoice_id, adjustment_amount')
            .in('sales_invoice_id', invoiceIdsForPaid),
        ]);
        for (const a of allocs || []) {
          paidById.set(
            a.sales_invoice_id,
            (paidById.get(a.sales_invoice_id) || 0) + Number(a.allocated_amount || 0),
          );
        }
        for (const a of adjs || []) {
          paidById.set(
            a.sales_invoice_id,
            (paidById.get(a.sales_invoice_id) || 0) + Number(a.adjustment_amount || 0),
          );
        }
      }
      const invoicesWithPayments = (data || []).map((inv) => {
        const paidAmount = paidById.get(inv.id) || 0;
        const balance = inv.total_amount - paidAmount;
        return { ...inv, paid_amount: paidAmount, balance_amount: balance };
      });

      const itemCounts = new Map<string, number>();
      if (invoiceIdsForPaid.length > 0) {
        const { data: itemRows } = await supabase
          .from('sales_invoice_items')
          .select('invoice_id')
          .in('invoice_id', invoiceIdsForPaid);
        (itemRows || []).forEach((row: any) => itemCounts.set(row.invoice_id, (itemCounts.get(row.invoice_id) || 0) + 1));
      }


      const bundle = await fetchLinkedDocumentsBundle();
      const invoicesWithLinked = invoicesWithPayments.map((inv: any) => {
        const links = bundle.invMap.get(inv.id);
        return {
          ...inv,
          item_count: itemCounts.get(inv.id) || 0,
          item_integrity_status: Number(inv.total_amount || 0) > 0 && !(itemCounts.get(inv.id) || 0)
            ? 'missing_product_rows'
            : 'ok',
          sales_order: links?.sos?.[0] ? { so_number: links.sos[0].number } : null,
          linked_challans: (links?.dcs || []).map((d) => ({ id: d.id, challan_number: d.number }))
        };
      });

      // perf: render list immediately without the sales_invoice_items+products
      // join. Product-name search hydrates in the background so search UX is
      // preserved without blocking initial render.
      const invoicesWithProducts = invoicesWithLinked.map((inv: any) => ({
        ...inv,
        product_names: '',
      }));
      setInvoices(invoicesWithProducts);

      const invoiceIds = invoicesWithLinked.map((inv: any) => inv.id);
      if (invoiceIds.length > 0) {
        // Fire-and-forget: hydrate product_names for search after list is shown.
        (async () => {
          try {
            const { data: itemsData } = await supabase
              .from('sales_invoice_items')
              .select('invoice_id, products(product_name)')
              .in('invoice_id', invoiceIds);
            if (!itemsData) return;
            const productNamesMap = new Map<string, string>();
            (itemsData as any[]).forEach((item) => {
              const existing = productNamesMap.get(item.invoice_id) || '';
              const name = item.products?.product_name || '';
              if (name && !existing.includes(name)) {
                productNamesMap.set(item.invoice_id, existing ? `${existing}, ${name}` : name);
              }
            });
            setInvoices((prev) =>
              prev.map((inv: any) => ({
                ...inv,
                product_names: productNamesMap.get(inv.id) || inv.product_names || '',
              })),
            );
          } catch (err) {
            console.error('Error hydrating product names:', err);
          }
        })();
      }

    } catch (error) {
      console.error('Error loading invoices:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleFlyChallanClick = async (challanId: string) => {
    const [{ data: challan }, { data: challanItems }] = await Promise.all([
      supabase.from('delivery_challans').select('*, customers(company_name, address, city, phone, pbf_license)').eq('id', challanId).maybeSingle(),
      supabase.from('delivery_challan_items').select('*, products(product_name, product_code, unit), batches(batch_number, expiry_date, packaging_details)').eq('challan_id', challanId)
    ]);
    if (challan) {
      setSelectedFlyChallan(challan);
      setSelectedFlyChallanItems(challanItems || []);
    }
  };


  const openLinkedSalesOrderView = async (soId: string) => {
    if (!soId) return;
    const { data } = await supabase
      .from('sales_orders')
      .select('*, customers(*), sales_order_items(*, products(id, product_name, product_code, unit))')
      .eq('id', soId)
      .maybeSingle();
    if (data) setLinkedSOPreview(data);
  };

  const generateNextInvoiceNumber = async () => {
    try {
      // Get settings for invoice prefix
      const { data: settings } = await supabase
        .from('app_settings')
        .select('invoice_prefix, invoice_start_number')
        .limit(1)
        .maybeSingle();

      const startNumber = settings?.invoice_start_number || 1;

      // Get current financial year automatically
      const { data: yearCode, error: fyError } = await supabase
        .rpc('get_current_financial_year');

      if (fyError) {
        console.error('Error getting financial year:', fyError);
        const fallbackYear = new Date().getFullYear().toString().slice(-2);
        return `SAPJ-${fallbackYear}-001`;
      }

      // Strip year suffix from prefix if someone saved it with year already embedded (e.g. "SAPJ-26" -> "SAPJ")
      const rawPrefix = settings?.invoice_prefix || 'SAPJ';
      const prefix = rawPrefix.replace(new RegExp(`-${yearCode}$`), '');

      // Get all invoice numbers with this prefix and year to find the highest number
      const { data: allInvoices } = await supabase
        .from('sales_invoices')
        .select('invoice_number')
        .like('invoice_number', `${prefix}-${yearCode}%`);

      let nextNumber = startNumber;

      if (allInvoices && allInvoices.length > 0) {
        // Extract all numbers and find the maximum
        const numbers = allInvoices
          .map(inv => {
            const match = inv.invoice_number.match(/(\d+)$/);
            return match ? parseInt(match[1], 10) : 0;
          })
          .filter(num => !isNaN(num));

        if (numbers.length > 0) {
          const maxNumber = Math.max(...numbers);
          nextNumber = maxNumber + 1;
        }
      }

      // Format with leading zeros (minimum 3 digits)
      const paddedNumber = String(nextNumber).padStart(3, '0');
      return `${prefix}-${yearCode}-${paddedNumber}`;
    } catch (error) {
      console.error('Error generating invoice number:', error);
      const fallbackYear = new Date().getFullYear().toString().slice(-2);
      return `SAPJ-${fallbackYear}-001`;
    }
  };

  const loadCustomers = async () => {
    try {
      const { data, error } = await supabase
        .from('customers')
        .select('id, company_name, gst_vat_type')
        .eq('is_active', true)
        .order('company_name');

      if (error) throw error;
      setCustomers(data || []);
    } catch (error) {
      console.error('Error loading customers:', error);
    }
  };

  const loadProducts = async () => {
    try {
      const { data, error } = await supabase
        .from('products')
        .select('id, product_name, product_code')
        .eq('is_active', true)
        .order('product_name');

      if (error) throw error;
      setProducts(data || []);
    } catch (error) {
      console.error('Error loading products:', error);
    }
  };

  const loadBatches = async () => {
    try {
      // Load ALL batches for reference (including 0 stock for delivery challan invoices)
      const { data, error } = await supabase
        .from('batches')
        .select('id, batch_number, product_id, current_stock, import_price, duty_charges, freight_charges, other_charges, import_quantity, import_date, expiry_date')
        .eq('is_active', true)
        .order('import_date', { ascending: true });

      if (error) throw error;
      setBatches(data || []);
    } catch (error) {
      console.error('Error loading batches:', error);
    }
  };

  const loadPendingChallans = async (customerId: string) => {
    try {
      const { data: allChallans, error: challansError } = await supabase
        .from('delivery_challans')
        .select('id, challan_number, challan_date, delivery_address, vehicle_number, notes')
        .eq('customer_id', customerId)
        .order('challan_date', { ascending: false });

      if (challansError) throw challansError;

      const { data: invoicedChallans, error: invoicesError } = await supabase
        .from('sales_invoices')
        .select('linked_challan_ids')
        .not('linked_challan_ids', 'is', null);

      if (invoicesError) throw invoicesError;

      const linkedChallanIds = new Set<string>();
      invoicedChallans?.forEach(inv => {
        inv.linked_challan_ids?.forEach((id: string) => linkedChallanIds.add(id));
      });

      const pending = allChallans?.filter(ch => !linkedChallanIds.has(ch.id)) || [];
      setPendingChallans(pending);
    } catch (error) {
      console.error('Error loading pending challans:', error);
      setPendingChallans([]);
    }
  };

  const loadCustomerSalesOrders = async (customerId: string) => {
    try {
      const { data, error } = await supabase
        .from('sales_orders')
        .select(`
          id, so_number, total_amount, advance_payment_amount, advance_payment_status, status,
          sales_order_items(product_id, unit_price, products(product_name))
        `)
        .eq('customer_id', customerId)
        .eq('is_archived', false)
        .in('status', ['approved', 'stock_reserved', 'shortage', 'pending_delivery', 'partially_delivered', 'delivered'])
        .order('created_at', { ascending: false });

      if (error) throw error;

      const soOptions: SalesOrderOption[] = (data || []).map((so: any) => ({
        id: so.id,
        so_number: so.so_number,
        total_amount: so.total_amount,
        advance_payment_amount: so.advance_payment_amount,
        advance_payment_status: so.advance_payment_status,
        status: so.status,
        items: (so.sales_order_items || []).map((item: any) => ({
          product_id: item.product_id,
          product_name: item.products?.product_name || 'Unknown',
          unit_price: item.unit_price || 0,
        })),
      }));

      setCustomerSalesOrders(soOptions);
    } catch (error) {
      console.error('Error loading customer sales orders:', error);
      setCustomerSalesOrders([]);
    }
  };

  const loadPendingDCOptions = async (customerId: string) => {
    try {
      const { data, error } = await supabase
        .from('dc_invoicing_summary')
        .select('challan_id, challan_number, challan_date, total_quantity, total_remaining_quantity')
        .eq('customer_id', customerId)
        .gt('total_remaining_quantity', 0)
        .order('challan_date', { ascending: false });

      if (error) throw error;

      // Fetch product names for each DC
      const challanIds = (data || []).map(dc => dc.challan_id);
      const productNameMap: Record<string, string> = {};
      if (challanIds.length > 0) {
        const { data: items } = await supabase
          .from('delivery_challan_items')
          .select('challan_id, products(product_name)')
          .in('challan_id', challanIds);
        if (items) {
          const grouped: Record<string, Set<string>> = {};
          items.forEach((item: any) => {
            if (!grouped[item.challan_id]) grouped[item.challan_id] = new Set();
            if (item.products?.product_name) grouped[item.challan_id].add(item.products.product_name);
          });
          Object.entries(grouped).forEach(([id, names]) => {
            productNameMap[id] = [...names].join(', ');
          });
        }
      }

      const options = (data || []).map(dc => ({
        challan_id: dc.challan_id,
        challan_number: dc.challan_number,
        challan_date: dc.challan_date,
        item_count: dc.total_remaining_quantity,
        product_names: productNameMap[dc.challan_id] || '',
      }));

      setPendingDCOptions(options);
    } catch (error) {
      console.error('Error loading pending DC options:', error);
      setPendingDCOptions([]);
    }
  };

  const ensureLinkedDCOptionsVisible = async (linkedDCIds: string[]) => {
    if (!linkedDCIds || linkedDCIds.length === 0) return;

    try {
      const missingIds = linkedDCIds.filter(id => !pendingDCOptions.some(opt => opt.challan_id === id));
      if (missingIds.length === 0) return;

      const { data, error } = await supabase
        .from('delivery_challans')
        .select('id, challan_number, challan_date')
        .in('id', missingIds)
        .order('challan_date', { ascending: false });

      if (error) throw error;

      const linkedOptions = (data || []).map(dc => ({
        challan_id: dc.id,
        challan_number: dc.challan_number,
        challan_date: dc.challan_date,
        item_count: 0
      }));

      if (linkedOptions.length > 0) {
        setPendingDCOptions(prev => {
          const existingIds = new Set(prev.map(opt => opt.challan_id));
          const toAdd = linkedOptions.filter(opt => !existingIds.has(opt.challan_id));
          return toAdd.length > 0 ? [...prev, ...toAdd] : prev;
        });
      }
    } catch (error) {
      console.error('Error ensuring linked DC options are visible:', error);
    }
  };

  const loadPendingDCItems = async (customerId: string, excludeInvoiceId?: string) => {
    try {
      const { data, error } = await supabase
        .rpc('get_pending_dc_items_for_customer', {
          p_customer_id: customerId,
          p_exclude_invoice_id: excludeInvoiceId || null
        });

      if (error) throw error;

      const dcsWithItems: DCWithItems[] = (data || []).map((dc: any) => ({
        challan_id: dc.challan_id,
        challan_number: dc.challan_number,
        challan_date: dc.challan_date,
        dc_status: dc.dc_status,
        items: dc.items || []
      }));

      setPendingDCsWithItems(dcsWithItems);

      if (excludeInvoiceId && dcsWithItems.length > 0) {
        const newSelectedItems = new Map<string, SelectedDCItem>();
        const newExpandedDCs = new Set<string>();

        dcsWithItems.forEach(dc => {
          dc.items.forEach(item => {
            if (item.is_from_editing) {
              newSelectedItems.set(item.dc_item_id, {
                dcItemId: item.dc_item_id,
                dcNumber: dc.challan_number,
                selected: true,
                quantity: item.remaining_quantity
              });
              newExpandedDCs.add(dc.challan_id);
            }
          });
        });

        setSelectedDCItems(newSelectedItems);
        setExpandedDCs(newExpandedDCs);
      }
    } catch (error) {
      console.error('Error loading pending DC items:', error);
      setPendingDCsWithItems([]);
    }
  };

  const handleDCItemToggle = (dcItem: DCItem, dcNumber: string, checked: boolean) => {
    const newSelectedItems = new Map(selectedDCItems);

    if (checked) {
      newSelectedItems.set(dcItem.dc_item_id, {
        dcItemId: dcItem.dc_item_id,
        dcNumber: dcNumber,
        selected: true,
        quantity: dcItem.remaining_quantity
      });
    } else {
      newSelectedItems.delete(dcItem.dc_item_id);
    }

    setSelectedDCItems(newSelectedItems);
    syncItemsFromDCSelection(newSelectedItems);
  };

  const handleDCExpandToggle = (dcId: string) => {
    const newExpanded = new Set(expandedDCs);
    if (newExpanded.has(dcId)) {
      newExpanded.delete(dcId);
    } else {
      newExpanded.add(dcId);
    }
    setExpandedDCs(newExpanded);
  };

  const handleDCSelectAll = (dcId: string, dcItems: DCItem[], dcNumber: string, checked: boolean) => {
    const newSelectedItems = new Map(selectedDCItems);

    if (checked) {
      dcItems.forEach(item => {
        newSelectedItems.set(item.dc_item_id, {
          dcItemId: item.dc_item_id,
          dcNumber: dcNumber,
          selected: true,
          quantity: item.remaining_quantity
        });
      });
      const newExpanded = new Set(expandedDCs);
      newExpanded.add(dcId);
      setExpandedDCs(newExpanded);
    } else {
      dcItems.forEach(item => {
        newSelectedItems.delete(item.dc_item_id);
      });
    }

    setSelectedDCItems(newSelectedItems);
    syncItemsFromDCSelection(newSelectedItems);
  };

  const syncItemsFromDCSelection = (selectedDCMap: Map<string, SelectedDCItem>) => {
    const dcItems: InvoiceItem[] = [];

    pendingDCsWithItems.forEach(dc => {
      dc.items.forEach(dcItem => {
        const selected = selectedDCMap.get(dcItem.dc_item_id);
        if (selected) {
          dcItems.push({
            product_id: dcItem.product_id,
            batch_id: dcItem.batch_id,
            quantity: dcItem.remaining_quantity,
            unit_price: dcItem.selling_price,
            tax_rate: 11,
            total: dcItem.remaining_quantity * dcItem.selling_price * 1.11,
            delivery_challan_item_id: dcItem.dc_item_id,
            dc_number: dc.challan_number,
            max_quantity: dcItem.remaining_quantity
          });
        }
      });
    });

    const manualItems = items.filter(item => !item.delivery_challan_item_id);
    setItems([...dcItems, ...manualItems]);
  };

  const addManualItem = () => {
    setItems([...items, {
      product_id: '',
      batch_id: null,
      quantity: 1,
      unit_price: 0,
      tax_rate: 11,
      total: 0,
      delivery_challan_item_id: null
    }]);
  };

  const handleChallanSelect = async (challanId: string) => {
    if (!challanId) {
      setSelectedChallanId('');
      setItems([{
        product_id: '',
        batch_id: null,
        quantity: 1,
        unit_price: 0,
        tax_rate: 11,
        total: 0,
      }]);
      return;
    }

    setSelectedChallanId(challanId);

    try {
      const selectedChallan = pendingChallans.find(ch => ch.id === challanId);
      if (!selectedChallan) {
        console.error('Selected challan not found in pending challans list');
        showToast({ type: 'error', title: 'Error', message: 'Selected delivery challan not found. Please refresh and try again.' });
        return;
      }

      setFormData(prev => ({
        ...prev,
        delivery_challan_number: selectedChallan.challan_number,
      }));

      const { data: challanItems, error } = await supabase
        .from('delivery_challan_items')
        .select('product_id, batch_id, quantity, products(product_name, product_code), batches(batch_number, import_price, duty_charges, freight_charges, other_charges, import_quantity)')
        .eq('challan_id', challanId);

      if (error) {
        console.error('Database error loading challan items:', error);
        throw error;
      }

      if (!challanItems || challanItems.length === 0) {
        console.warn('No items found for this delivery challan');
        showToast({ type: 'info', title: 'Info', message: 'This delivery challan has no items. Please add items manually.' });
        return;
      }

      const invoiceItems: InvoiceItem[] = [];

      for (const item of challanItems) {
        if (!item.product_id) {
          console.warn('Skipping item with missing product_id');
          continue;
        }

        let unitPrice = 0;

        if (item.batch_id) {
          const batch = batches.find(b => b.id === item.batch_id);
          if (batch) {
            const costPerUnit = (batch.import_price + batch.duty_charges + batch.freight_charges + batch.other_charges) / (batch as any).import_quantity;
            unitPrice = Math.round(costPerUnit * 1.25);
          } else {
            console.warn(`Batch ${item.batch_id} not found in loaded batches`);
          }
        }

        invoiceItems.push({
          product_id: item.product_id,
          batch_id: item.batch_id,
          quantity: item.quantity,
          unit_price: unitPrice,
          tax_rate: 11,
          total: item.quantity * unitPrice * 1.11,
        });
      }

      if (invoiceItems.length === 0) {
        showToast({ type: 'error', title: 'Error', message: 'Could not load items from delivery challan. Please add items manually.' });
        return;
      }

      setItems(invoiceItems);
    } catch (error: any) {
      console.error('Error loading challan items:', error);
      showToast({ type: 'error', title: 'Error', message: `Failed to load delivery challan items: ${error.message || 'Unknown error'}. Please try again or add items manually.` });
    }
  };

  const getFIFOBatch = (productId: string) => {
    const now = new Date();
    const productBatches = batches
      .filter(b => {
        if (b.product_id !== productId) return false;
        if (!(b as any).expiry_date) return true;
        return new Date((b as any).expiry_date) > now;
      })
      .sort((a, b) => {
        const dateA = new Date((a as any).import_date).getTime();
        const dateB = new Date((b as any).import_date).getTime();
        return dateA - dateB;
      });
    return productBatches[0] || null;
  };

  const handleDeliveryChallanData = async (data: any) => {
    const nextInvoiceNumber = await generateNextInvoiceNumber();

    setFormData({
      invoice_number: nextInvoiceNumber,
      customer_id: data.customerId,
      invoice_date: new Date().toISOString().split('T')[0],
      payment_terms: '30',
      discount: 0,
      stamp_duty_amount: 0,
      delivery_challan_number: data.challanNumber,
      po_number: '',
      notes: `Created from Delivery Challan: ${data.challanNumber}`,
    });

    if (data.customerId) {
      await loadPendingChallans(data.customerId);
    }

    const mappedItems: InvoiceItem[] = data.items.map((item: any) => {
      const batch = batches.find(b => b.id === item.batch_id);
      const costPerUnit = batch ? (batch.import_price + batch.duty_charges + batch.freight_charges + batch.other_charges) / (batch as any).import_quantity : 0;
      const suggestedPrice = costPerUnit * 1.25;

      return {
        product_id: item.product_id,
        batch_id: item.batch_id,
        quantity: item.quantity,
        unit_price: Math.round(suggestedPrice),
        tax_rate: 11,
        total: 0,
        delivery_challan_item_id: item.id || null, // Link to DC item
      };
    });

    setItems(mappedItems.map(item => ({
      ...item,
      total: calculateItemTotal(item)
    })));

    setModalOpen(true);
  };

  const loadInvoiceItems = async (invoiceId: string) => {
    try {
      const itemsWithDCInfo = await loadInvoiceDisplayItems(supabase, invoiceId);
      const mappedItems: InvoiceItem[] = itemsWithDCInfo.map(item => ({
        id: item.id,
        product_id: item.product_id,
        batch_id: item.batch_id,
        quantity: item.quantity,
        unit_price: item.unit_price,
        tax_rate: item.tax_rate,
        total: item.line_total ?? item.total ?? item.quantity * item.unit_price * (1 + item.tax_rate / 100),
        delivery_challan_item_id: item.delivery_challan_item_id,
        challan_id: item.challan_id,
        dc_number: item.dc_number,
        products: item.products,
        batches: item.batches,
      }));

      setInvoiceItems(mappedItems);
      return mappedItems;
    } catch (error) {
      console.error('Error loading invoice items:', error);
      return [];
    }
  };

  const calculateItemTotal = (item: InvoiceItem) => {
    const subtotal = item.quantity * item.unit_price;
    const tax = subtotal * (item.tax_rate / 100);
    return subtotal + tax;
  };

  const getBatchCostPerUnit = (batchId: string | null): number => {
    if (!batchId) return 0;
    const batch = batches.find(b => b.id === batchId) as any;
    if (!batch || !batch.import_quantity) return 0;
    const totalCost = batch.import_price + batch.duty_charges + batch.freight_charges + batch.other_charges;
    return totalCost / batch.import_quantity;
  };

  const calculateMargin = (unitPrice: number, costPerUnit: number): number => {
    if (costPerUnit === 0) return 0;
    return ((unitPrice - costPerUnit) / unitPrice) * 100;
  };

  const getSuggestedPrice = (batchId: string | null, markup: number = 25): number => {
    const cost = getBatchCostPerUnit(batchId);
    return Math.round(cost * (1 + markup / 100));
  };

  const updateItemTotal = (index: number, updatedItem: InvoiceItem) => {
    const total = calculateItemTotal(updatedItem);
    const newItems = [...items];
    newItems[index] = { ...updatedItem, total };
    setItems(newItems);
  };

  const addItem = () => {
    setItems([...items, {
      product_id: '',
      batch_id: null,
      quantity: 1,
      unit_price: 0,
      tax_rate: 11,
      total: 0,
    }]);
  };

  const removeItem = (index: number) => {
    if (items.length > 1) {
      setItems(items.filter((_, i) => i !== index));
    }
  };

  const calculateTotals = () => {
    const subtotal = items.reduce((sum, item) => sum + (item.quantity * item.unit_price), 0);
    const taxAmount = items.reduce((sum, item) => {
      const itemSubtotal = item.quantity * item.unit_price;
      return sum + (itemSubtotal * (item.tax_rate / 100));
    }, 0);
    const stampDuty = formData.stamp_duty_amount || 0;
    const total = subtotal + taxAmount - formData.discount + stampDuty;
    return { subtotal, taxAmount, stampDuty, total };
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      // Validate that invoice has at least one item with a product selected
      const validItems = items.filter(item => item.product_id && item.product_id.trim() !== '');
      if (validItems.length === 0) {
        showToast({ type: 'error', title: 'Error', message: 'Invoice cannot be saved because its product table is empty. Select an approved Delivery Challan item or add a product line.' });
        return;
      }

      const totals = calculateTotals();

      // Calculate due date based on payment terms
      const invoiceDate = new Date(formData.invoice_date);
      const dueDate = new Date(invoiceDate);
      let paymentTermsDays = 30;

      if (formData.payment_terms === 'advance' || formData.payment_terms === '50-50') {
        paymentTermsDays = 0;
      } else {
        paymentTermsDays = parseInt(formData.payment_terms);
        if (!isNaN(paymentTermsDays)) {
          dueDate.setDate(dueDate.getDate() + paymentTermsDays);
        }
      }

      let invoice: any;

      if (editingInvoice) {
        // HARDENING FIX #1: Use atomic RPC to prevent race conditions
        // All operations (delete + update + insert) happen in single transaction

        // Deduplicate items before sending (in case of UI state issues)
        const itemsMap = new Map();
        items
          .filter(item => item.product_id && item.product_id.trim() !== '')
          .forEach(item => {
            const key = `${item.product_id}-${item.batch_id}-${item.delivery_challan_item_id || 'manual'}`;
            if (!itemsMap.has(key)) {
              itemsMap.set(key, {
                product_id: item.product_id,
                batch_id: item.batch_id,
                quantity: item.quantity,
                unit_price: item.unit_price,
                tax_rate: item.tax_rate,
                total_amount: item.total,
                delivery_challan_item_id: item.delivery_challan_item_id || null,
                max_quantity: item.max_quantity || null,
              });
            }
          });

        const validItems = Array.from(itemsMap.values());

        const { data: invoiceId, error: rpcError } = await supabase
          .rpc('update_sales_invoice_atomic', {
            p_invoice_id: editingInvoice.id,
            p_invoice_updates: {
              invoice_date: formData.invoice_date,
              due_date: dueDate.toISOString().split('T')[0],
              customer_id: formData.customer_id,
              subtotal: totals.subtotal,
              tax_amount: totals.taxAmount,
              stamp_duty_amount: totals.stampDuty,
              linked_challan_ids: selectedDCIds.length > 0 ? selectedDCIds : null,
              total_amount: totals.total,
              discount_amount: formData.discount,
              po_number: formData.po_number || null,
              payment_terms_days: paymentTermsDays,
              notes: formData.notes || null,
            },
            p_new_items: validItems,
          });

        if (rpcError) throw rpcError;

        // Fetch updated invoice for return
        const { data: updatedInvoice, error: fetchError } = await supabase
          .from('sales_invoices')
          .select()
          .eq('id', editingInvoice.id)
          .single();

        if (fetchError) throw fetchError;
        invoice = updatedInvoice;
      } else {
        // Check if invoice number already exists and regenerate if needed
        let invoiceNumber = formData.invoice_number;
        const { data: existingInvoice } = await supabase
          .from('sales_invoices')
          .select('invoice_number')
          .eq('invoice_number', invoiceNumber)
          .maybeSingle();

        if (existingInvoice) {
          // Invoice number already exists, generate a new one
          invoiceNumber = await generateNextInvoiceNumber();
          setFormData(prev => ({ ...prev, invoice_number: invoiceNumber }));
        }

        // Filter and map only valid items (with product_id)
        const invoiceItemsData = items
          .filter(item => item.product_id && item.product_id.trim() !== '')
          .map(item => ({
            invoice_id: invoice.id,
            product_id: item.product_id,
            batch_id: item.batch_id,
            quantity: item.quantity,
            unit_price: item.unit_price,
            tax_rate: item.tax_rate,
            delivery_challan_item_id: item.delivery_challan_item_id || null,
          }));

        if (invoiceItemsData.length === 0) throw new Error('Invoice product rows were empty; no invoice was created.');

        // New invoices are created in one database transaction. The RPC
        // derives totals from the persisted source lines and rolls back the
        // header, items, journal, and links if any validation fails.
        const { data: newInvoiceId, error: invoiceError } = await supabase.rpc('create_sales_invoice_atomic', {
          p_invoice: {
            invoice_number: invoiceNumber,
            customer_id: formData.customer_id,
            sales_order_id: selectedSOId || null,
            invoice_date: formData.invoice_date,
            due_date: dueDate.toISOString().split('T')[0],
            discount_amount: formData.discount,
            po_number: formData.po_number || null,
            payment_terms_days: paymentTermsDays,
            notes: formData.notes || null,
            subtotal: totals.subtotal,
            tax_amount: totals.taxAmount,
            stamp_duty_amount: totals.stampDuty,
            total_amount: totals.total,
            created_by: user.id,
            linked_challan_ids: selectedDCIds.length > 0 ? selectedDCIds : null,
          },
          p_items: invoiceItemsData,
        });
        if (invoiceError) throw invoiceError;
        const { data: newInvoice, error: fetchInvoiceError } = await supabase.from('sales_invoices').select().eq('id', newInvoiceId).single();
        if (fetchInvoiceError) throw fetchInvoiceError;
        invoice = newInvoice;
      }

      // Stock deduction and inventory transactions are handled automatically by database trigger

      await loadInvoices();
      await loadBatches();

      // Notify warehouse staff on new invoice (non-blocking)
      if (!editingInvoice && invoice?.id) {
        supabase.functions.invoke('send-app-notifications', {
          body: { type: 'invoice_created', data: { invoice_id: invoice.id } }
        }).catch(() => {});
      }

      setModalOpen(false);
      resetForm();
    } catch (error: any) {
      console.error('Error saving invoice:', error);
      showToast({ type: 'error', title: 'Error', message: `Failed to save invoice: ${error.message || 'Unknown error'}. Please check console for details.` });
    }
  };

  const handleView = async (invoice: SalesInvoice) => {
    setSelectedInvoice(invoice);
    const items = await loadInvoiceItems(invoice.id);
    setViewModalOpen(true);
  };

  useEffect(() => {
    if (navigationData?.sourceType !== 'sales_invoice' || !navigationData.invoiceId) return;
    const openSourceInvoice = async () => {
      const { data, error } = await supabase
        .from('sales_invoices')
        .select('*, customers(company_name)')
        .eq('id', String(navigationData.invoiceId))
        .maybeSingle();
      if (error) {
        console.error('Error opening journal source sales invoice:', error);
      } else if (data) {
        await handleView(data as SalesInvoice);
      }
      clearNavigationData();
    };
    void openSourceInvoice();
  }, [navigationData, clearNavigationData]);

  const handleEdit = async (invoice: SalesInvoice) => {
    setEditingInvoice(invoice);
    setFormData({
      invoice_number: invoice.invoice_number,
      customer_id: invoice.customer_id,
      invoice_date: invoice.invoice_date,
      payment_terms: String(invoice.payment_terms_days || 30),
      discount: invoice.discount_amount,
      stamp_duty_amount: Number(invoice.stamp_duty_amount) || 0,
      delivery_challan_number: invoice.delivery_challan_number || '',
      po_number: invoice.po_number || '',
      notes: invoice.notes || '',
    });

    const loadedItems = await loadInvoiceItems(invoice.id);

    if (loadedItems.length > 0) {
      setItems(loadedItems.map(item => {
        const mappedItem = {
          product_id: item.product_id,
          batch_id: item.batch_id,
          quantity: item.quantity,
          unit_price: item.unit_price,
          tax_rate: item.tax_rate,
          total: 0,
          delivery_challan_item_id: item.delivery_challan_item_id,
          challan_id: item.challan_id,
          dc_number: item.dc_number,
        };
        return {
          ...mappedItem,
          total: calculateItemTotal(mappedItem)
        };
      }));
    }

    await loadPendingDCOptions(invoice.customer_id);

    const linkedDCIds = [...new Set([
      ...loadedItems.map((item: any) => item.challan_id).filter(Boolean),
      ...(invoice.linked_challan_ids ?? []),
    ])] as string[];
    setSelectedDCIds(linkedDCIds);
    await ensureLinkedDCOptionsVisible(linkedDCIds);

    setModalOpen(true);
  };

  const handleDelete = async (id: string) => {
    if (!await showConfirm({ title: 'Confirm', message: 'Are you sure you want to delete this invoice?', variant: 'danger', confirmLabel: 'Delete' })) return;

    try {
      const { error } = await supabase
        .from('sales_invoices')
        .delete()
        .eq('id', id);

      if (error) throw error;
      loadInvoices();
    } catch (error) {
      console.error('Error deleting invoice:', error);
      showToast({ type: 'error', title: 'Error', message: 'Failed to delete invoice. Please try again.' });
    }
  };

  const updatePaymentStatus = async (invoice: SalesInvoice, newStatus: SalesInvoice['payment_status']) => {
    try {
      const { error } = await supabase
        .from('sales_invoices')
        .update({ payment_status: newStatus })
        .eq('id', invoice.id);

      if (error) throw error;
      loadInvoices();
    } catch (error) {
      console.error('Error updating payment status:', error);
      showToast({ type: 'error', title: 'Error', message: 'Failed to update payment status.' });
    }
  };

  const resetForm = () => {
    setEditingInvoice(null);
    setSelectedChallanId('');
    setPendingChallans([]);
    setPendingDCOptions([]);
    setSelectedDCIds([]);
    setSelectedSOId('');
    setSoAutoLinked(false);
    setCustomerSalesOrders([]);
    setFormData({
      invoice_number: '',
      customer_id: '',
      invoice_date: new Date().toISOString().split('T')[0],
      payment_terms: '30',
      discount: 0,
      stamp_duty_amount: 0,
      delivery_challan_number: '',
      po_number: '',
      notes: '',
    });
    setItems([{
      product_id: '',
      batch_id: null,
      quantity: 1,
      unit_price: 0,
      tax_rate: 11,
      total: 0,
    }]);
  };

  const columns = [
    {
      key: 'invoice_date',
      label: t('common.date'),
      render: (value: any, inv: SalesInvoice) => formatDate(inv.invoice_date)
    },
    {
      key: 'invoice_number',
      label: t('sales.invoiceNumber'),
      render: (value: any, inv: SalesInvoice) => (
        <div>
          <div>{inv.invoice_number}</div>
          {inv.item_integrity_status === 'missing_product_rows' && (
            <div className="text-[10px] font-semibold text-red-700">Missing product rows</div>
          )}
        </div>
      )
    },
    {
      key: 'customer',
      label: t('sales.customer'),
      render: (value: any, inv: SalesInvoice) => (
        <div className="font-medium">{inv.customers?.company_name}</div>
      )
    },
    {
      key: 'total_amount',
      label: t('common.total'),
      render: (value: any, inv: SalesInvoice) => (
        <span className="font-medium text-sm">Rp {inv.total_amount.toLocaleString('id-ID', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}</span>
      )
    },
    {
      key: 'payment_status',
      label: t('sales.paymentStatus'),
      render: (value: any, inv: SalesInvoice) => (
        <span className={`inline-block px-1.5 py-0.5 rounded-full text-[11px] leading-tight font-medium ${
          inv.payment_status === 'paid' ? 'bg-green-100 text-green-800' :
          inv.payment_status === 'partial' ? 'bg-yellow-100 text-yellow-800' :
          'bg-red-100 text-red-800'
        }`}>
          {inv.payment_status === 'pending' ? t('common.unpaid') :
           inv.payment_status === 'partial' ? t('common.partial') : t('common.paid')}
        </span>
      )
    },
    {
      key: 'balance_amount',
      label: t('sales.balance'),
      render: (value: any, inv: SalesInvoice) => (
        <span className={`font-medium ${
          (inv.balance_amount || 0) === 0 ? 'text-gray-400' : 'text-orange-600'
        }`}>
          Rp {(inv.balance_amount || 0).toLocaleString('id-ID', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
        </span>
      )
    },
    {
      key: 'so_dc_link',
      label: 'Linked Docs',
      thClassName: 'min-w-[150px]',
      tdClassName: 'min-w-[150px]',
      render: (_value: any, inv: SalesInvoice) => (
        <LinkedDocsCell
          sos={inv.sales_order?.so_number ? [{ id: inv.sales_order_id || '', number: inv.sales_order.so_number, type: 'so' }] : []}
          dcs={(inv.linked_challans || []).map((dc) => ({ id: dc.id, number: dc.challan_number, type: 'dc' as const }))}
          invs={[]}
          show={{ inv: false }}
          onClick={(doc: LinkedDocRef) => {
            if (doc.type === 'dc') handleFlyChallanClick(doc.id);
            if (doc.type === 'so') openLinkedSalesOrderView(doc.id);
          }}
        />
      )
    },
    {
      key: 'due_date',
      label: 'Due Date',
      thClassName: 'min-w-[120px]',
      render: (value: any, inv: SalesInvoice) => {
        if (!inv.due_date || inv.payment_status === 'paid') {
          return <span className="text-gray-400">—</span>;
        }
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const due = new Date(inv.due_date);
        due.setHours(0, 0, 0, 0);
        const daysUntilDue = Math.ceil((due.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
        const isUrgent = daysUntilDue <= 7;
        const isOverdue = daysUntilDue < 0;
        return (
          <span className={`font-medium ${
            isOverdue ? 'text-red-700' :
            isUrgent ? 'text-red-500' :
            'text-gray-700'
          }`}>
            {formatDate(inv.due_date)}
            {isOverdue && <span className="ml-1 text-[11px] bg-red-100 text-red-700 px-1 py-0.5 rounded">Overdue</span>}
            {!isOverdue && isUrgent && <span className="ml-1 text-[11px] bg-red-50 text-red-500 px-1 py-0.5 rounded">{daysUntilDue}d left</span>}
          </span>
        );
      }
    },
  ];

  const canManage = profile?.role === 'admin' || profile?.role === 'accounts' || profile?.role === 'sales' || profile?.role === 'warehouse';

  const isAdmin = profile?.role === 'admin';

  const stats = {
    total: invoices.length,
    totalRevenue: invoices.reduce((sum, inv) => sum + inv.total_amount, 0),
    pending: invoices.filter(inv => inv.payment_status === 'pending').length,
    pendingValue: invoices.filter(inv => inv.payment_status === 'pending').reduce((sum, inv) => sum + (inv.balance_amount || 0), 0),
    paid: invoices.filter(inv => inv.payment_status === 'paid').length,
    paidValue: invoices.filter(inv => inv.payment_status === 'paid').reduce((sum, inv) => sum + inv.total_amount, 0),
  };

  return (
    <Layout>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-gray-900">{t('sales.title')}</h1>
            <p className="text-gray-600 mt-1">{t('sales.invoices')}</p>
          </div>
          {canManage && (
            <div className="flex gap-3">
              <button
                onClick={async () => {
                  resetForm();
                  const nextInvoiceNumber = await generateNextInvoiceNumber();
                  setFormData(prev => ({ ...prev, invoice_number: nextInvoiceNumber }));
                  setModalOpen(true);
                }}
                className="flex items-center gap-2 bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 transition"
              >
                <Plus className="w-5 h-5" />
                {t('sales.createInvoice')}
              </button>
              <button
                onClick={() => {
                  setCurrentPage('credit-notes');
                }}
                className="flex items-center gap-2 bg-red-600 text-white px-4 py-2 rounded-lg hover:bg-red-700 transition"
              >
                <FileX className="w-5 h-5" />
                {t('nav.creditNotes')}
              </button>
            </div>
          )}
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div className="bg-white rounded-lg shadow px-3 py-2 border border-gray-100">
            <p className="text-xs text-gray-500 uppercase tracking-wide">{t('sales.invoices')}</p>
            <p className="text-xl font-bold text-gray-900 mt-0.5">{stats.total}</p>
          </div>
          {isAdmin && (
            <div className="bg-blue-50 rounded-lg shadow px-3 py-2 border border-blue-100">
              <p className="text-xs text-blue-500 uppercase tracking-wide">{t('common.total')} Revenue</p>
              <p className="text-base font-bold text-blue-700 mt-0.5 leading-tight">
                Rp {stats.totalRevenue.toLocaleString('id-ID', { maximumFractionDigits: 0 })}
              </p>
            </div>
          )}
          <div className="bg-red-50 rounded-lg shadow px-3 py-2 border border-red-100">
            <p className="text-xs text-red-500 uppercase tracking-wide">{t('common.pending')}</p>
            <p className="text-xl font-bold text-red-600 mt-0.5">{stats.pending}</p>
            <p className="text-xs text-red-400 mt-0.5 leading-tight">
              Rp {stats.pendingValue.toLocaleString('id-ID', { maximumFractionDigits: 0 })}
            </p>
          </div>
          <div className="bg-green-50 rounded-lg shadow px-3 py-2 border border-green-100">
            <p className="text-xs text-green-500 uppercase tracking-wide">{t('common.paid')}</p>
            <p className="text-xl font-bold text-green-600 mt-0.5">{stats.paid}</p>
            <p className="text-xs text-green-400 mt-0.5 leading-tight">
              Rp {stats.paidValue.toLocaleString('id-ID', { maximumFractionDigits: 0 })}
            </p>
          </div>
        </div>

        <DataTable
          columns={columns}
          data={invoices}
          loading={loading}
          compact
          tableClassName="w-full min-w-[1200px]"
          actions={(invoice) => (
            <div className="flex items-center gap-2">
              <button
                onClick={() => handleView(invoice)}
                className="p-1 text-blue-600 hover:bg-blue-50 rounded"
                title={t('common.view')}
              >
                <Eye className="w-4 h-4" />
              </button>
              {canManage && (
                <>
                  <button
                    onClick={() => handleEdit(invoice)}
                    className="p-1 text-indigo-600 hover:bg-indigo-50 rounded"
                    title={t('common.edit')}
                  >
                    <Edit className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => handleDelete(invoice.id)}
                    className="p-1 text-red-600 hover:bg-red-50 rounded"
                    title={t('common.delete')}
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </>
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
          title={editingInvoice ? t('sales.editInvoice') : t('sales.createInvoice')}
          size="xl"
        >
          <form onSubmit={handleSubmit} className="space-y-3">
            <div className="space-y-2">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">{t('sales.invoiceNumber')} *</label>
                  <input
                    type="text"
                    value={formData.invoice_number}
                    className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded bg-gray-100"
                    required
                    readOnly
                    disabled
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Invoice Date *</label>
                  <input
                    type="date"
                    value={formData.invoice_date}
                    onChange={(e) => setFormData({ ...formData, invoice_date: e.target.value })}
                    className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded focus:ring-1 focus:ring-blue-500"
                    required
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Payment Terms *</label>
                  <select
                    value={formData.payment_terms}
                    onChange={(e) => setFormData({ ...formData, payment_terms: e.target.value })}
                    className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded focus:ring-1 focus:ring-blue-500"
                    required
                  >
                    <option value="0">Immediate</option>
                    <option value="15">15 Days</option>
                    <option value="30">30 Days</option>
                    <option value="45">45 Days</option>
                    <option value="60">60 Days</option>
                    <option value="advance">Advance</option>
                    <option value="50-50">50% Adv & 50% on Delivery</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Customer *</label>
                  <SearchableSelect
                    value={formData.customer_id}
                    onChange={(customerId) => {
                      setFormData({ ...formData, customer_id: customerId });
                      setSelectedChallanId('');
                      setPendingChallans([]);
                      setSelectedDCIds([]);
                      setSelectedSOId('');
                      setSoAutoLinked(false);
                      setCustomerSalesOrders([]);
                      setItems([{
                        product_id: '',
                        batch_id: null,
                        quantity: 1,
                        unit_price: 0,
                        tax_rate: 11,
                        total: 0,
                      }]);
                      if (customerId) {
                        loadPendingDCOptions(customerId);
                        loadCustomerSalesOrders(customerId);
                      } else {
                        setPendingDCOptions([]);
                        setCustomerSalesOrders([]);
                      }
                    }}
                    options={customers.map(c => ({ value: c.id, label: c.company_name }))}
                    placeholder="Select Customer"
                    className="text-sm"
                    required
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Delivery Challans</label>
                  <DCMultiSelect
                    options={pendingDCOptions}
                    selectedDCIds={selectedDCIds}
                    onChange={(ids) => {
                      if (ids.length === 0) {
                        setSoAutoLinked(false);
                        setSelectedSOId('');
                      }
                      void handleDCMultiSelectChange(ids);
                    }}
                    placeholder="Select DCs"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">PO Number</label>
                  <input
                    type="text"
                    value={formData.po_number}
                    onChange={(e) => setFormData({ ...formData, po_number: e.target.value })}
                    className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded focus:ring-1 focus:ring-blue-500"
                    placeholder="Customer PO Number"
                  />
                </div>
              </div>

              {customerSalesOrders.length > 0 && !editingInvoice && (
                <div className={`p-3 rounded-lg border-2 ${soAutoLinked ? 'bg-green-50 border-green-300' : 'bg-blue-50 border-blue-200'}`}>
                  <label className={`block text-sm font-bold mb-2 ${soAutoLinked ? 'text-green-900' : 'text-blue-900'}`}>
                    Link to Sales Order {soAutoLinked ? '(auto-linked from DC)' : '(for advance payment tracking)'}
                  </label>
                  {soAutoLinked ? (
                    <div className="flex items-center justify-between">
                      <div>
                        {(() => {
                          const so = customerSalesOrders.find(s => s.id === selectedSOId);
                          return so ? (
                            <div>
                              <p className="text-sm font-semibold text-green-800">{so.so_number}</p>
                              {so.items && so.items.length > 0 && (
                                <p className="text-xs text-green-700 mt-0.5">
                                  Products: {so.items.map(i => i.product_name).join(', ')}
                                </p>
                              )}
                              {so.advance_payment_amount > 0 && (
                                <p className="text-xs text-green-700 mt-0.5">
                                  Advance: Rp {so.advance_payment_amount.toLocaleString('id-ID')}
                                </p>
                              )}
                            </div>
                          ) : null;
                        })()}
                      </div>
                      <button
                        type="button"
                        onClick={() => { setSelectedSOId(''); setSoAutoLinked(false); }}
                        className="text-xs text-green-700 underline hover:text-green-900"
                      >
                        Change
                      </button>
                    </div>
                  ) : (
                    <select
                      value={selectedSOId}
                      onChange={(e) => setSelectedSOId(e.target.value)}
                      className="w-full px-3 py-2 text-sm border-2 border-blue-300 rounded-lg focus:ring-2 focus:ring-blue-500 bg-white font-medium"
                    >
                      <option value="">-- Select Sales Order (if this invoice is from an SO) --</option>
                      {customerSalesOrders.map(so => {
                        const productNames = so.items && so.items.length > 0
                          ? so.items.map(i => i.product_name).join(', ')
                          : `Rp ${so.total_amount.toLocaleString('id-ID')}`;
                        const advanceLabel = so.advance_payment_amount > 0
                          ? ` | Advance: Rp ${so.advance_payment_amount.toLocaleString('id-ID')}`
                          : '';
                        return (
                          <option key={so.id} value={so.id}>
                            {so.so_number} — {productNames}{advanceLabel}
                          </option>
                        );
                      })}
                    </select>
                  )}
                  {selectedSOId && !soAutoLinked && (() => {
                    const so = customerSalesOrders.find(s => s.id === selectedSOId);
                    if (so && so.advance_payment_amount > 0) {
                      return (
                        <div className="mt-2 p-2 bg-green-100 border border-green-300 rounded">
                          <p className="text-sm font-bold text-green-800">
                            Advance Payment: Rp {so.advance_payment_amount.toLocaleString('id-ID')} will be automatically applied to this invoice
                          </p>
                          <p className="text-xs text-green-700 mt-1">
                            The invoice payment status will be updated automatically after saving.
                          </p>
                        </div>
                      );
                    }
                    if (selectedSOId) {
                      return (
                        <p className="text-xs text-blue-600 mt-2">
                          This SO has no advance payment recorded.
                        </p>
                      );
                    }
                    return null;
                  })()}
                  {customerSalesOrders.some(so => so.advance_payment_amount > 0) && !selectedSOId && !soAutoLinked && (
                    <div className="mt-2 p-2 bg-amber-50 border border-amber-300 rounded">
                      <p className="text-xs font-medium text-amber-800">
                        This customer has Sales Orders with advance payments. Select the correct SO above to apply advance payment to this invoice.
                      </p>
                    </div>
                  )}
                </div>
              )}

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Notes</label>
                  <input
                    type="text"
                    value={formData.notes}
                    onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                    className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded focus:ring-1 focus:ring-blue-500"
                    placeholder="Additional notes"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Discount (Rp)</label>
                  <MoneyInput
                    value={formData.discount}
                    onChange={(amount) => setFormData({ ...formData, discount: amount })}
                    className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded focus:ring-1 focus:ring-blue-500"
                    min="0"
                    placeholder="0"
                  />
                </div>
              </div>
            </div>

            <div className="border-t pt-3">
              <div className="flex items-center justify-between mb-2">
                <h4 className="text-xs font-semibold text-gray-900">Line Items</h4>
                <button
                  type="button"
                  onClick={addManualItem}
                  className="text-xs text-blue-600 hover:text-blue-700 font-medium"
                >
                  + Add Manual Item
                </button>
              </div>

              <div className="space-y-1.5">
                {items.map((item, index) => {
                  const availableBatches = batches.filter(b => b.product_id === item.product_id);
                  const costPerUnit = getBatchCostPerUnit(item.batch_id);
                  const margin = calculateMargin(item.unit_price, costPerUnit);
                  const suggestedPrice = getSuggestedPrice(item.batch_id);

                  const isFromDC = !!item.delivery_challan_item_id;

                  return (
                    <div key={index} className="p-2 bg-gray-50 rounded space-y-1 border-l-2" style={{ borderLeftColor: isFromDC ? '#3b82f6' : '#10b981' }}>
                      <div className="flex items-center justify-between mb-1">
                        <div className="flex items-center gap-2">
                          {isFromDC ? (
                            <span className="px-1.5 py-0.5 text-[10px] font-medium bg-blue-100 text-blue-700 rounded">
                              From DC: {item.dc_number}
                            </span>
                          ) : (
                            <span className="px-1.5 py-0.5 text-[10px] font-medium bg-green-100 text-green-700 rounded">
                              Manual Item
                            </span>
                          )}
                          {isFromDC && item.max_quantity && (
                            <span className="text-[10px] text-gray-500">
                              Max: {item.max_quantity} units
                            </span>
                          )}
                        </div>
                        {!isFromDC && items.length > 1 && (
                          <button
                            type="button"
                            onClick={() => removeItem(index)}
                            className="text-red-600 hover:text-red-700"
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        )}
                      </div>
                      <div className="overflow-x-auto">
                      <div className="grid grid-cols-12 gap-2 items-end min-w-[700px]">
                        <div className="col-span-3">
                          <label className="block text-xs text-gray-600 mb-1">Product *</label>
                          <select
                            value={item.product_id}
                            onChange={(e) => updateItemTotal(index, { ...item, product_id: e.target.value, batch_id: null })}
                            className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded focus:ring-2 focus:ring-blue-500"
                            disabled={isFromDC}
                            required
                          >
                            <option value="">Select Product</option>
                            {products.map((p) => (
                              <option key={p.id} value={p.id}>{p.product_name}</option>
                            ))}
                          </select>
                        </div>

                        <div className="col-span-2">
                          <label className="block text-xs text-gray-600 mb-1">Batch</label>
                          <select
                            value={item.batch_id || ''}
                            onChange={(e) => {
                              const batchId = e.target.value || null;
                              const suggested = getSuggestedPrice(batchId);
                              updateItemTotal(index, { ...item, batch_id: batchId, unit_price: suggested });
                            }}
                            className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded focus:ring-2 focus:ring-blue-500"
                            disabled={!item.product_id || selectedChallanId !== '' || isFromDC}
                          >
                            <option value="">Select Batch</option>
                            {/* Show only batches with stock > 0 for manual selection */}
                            {availableBatches.filter(b => b.current_stock > 0).map((b) => (
                              <option key={b.id} value={b.id}>{b.batch_number} ({b.current_stock} stock)</option>
                            ))}
                            {/* Show selected batch even if stock is 0 (from delivery challan) */}
                            {item.batch_id && availableBatches.find(b => b.id === item.batch_id && b.current_stock === 0) && (
                              <option key={item.batch_id} value={item.batch_id}>
                                {availableBatches.find(b => b.id === item.batch_id)?.batch_number} (from challan)
                              </option>
                            )}
                          </select>
                        </div>

                      <div className="col-span-2">
                        <label className="block text-xs text-gray-600 mb-1">Quantity *</label>
                        <input
                          type="number"
                          value={item.quantity === 0 ? '' : item.quantity}
                          onChange={(e) => updateItemTotal(index, { ...item, quantity: e.target.value === '' ? 1 : Number(e.target.value) })}
                          className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded focus:ring-2 focus:ring-blue-500"
                          required
                          min="0.001"
                          step="0.001"
                          placeholder="0.25"
                        />
                      </div>

                      <div className="col-span-2">
                        <label className="block text-xs text-gray-600 mb-1">Unit Price *</label>
                        <MoneyInput
                          value={item.unit_price}
                          onChange={(amount) => updateItemTotal(index, { ...item, unit_price: amount })}
                          className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded focus:ring-2 focus:ring-blue-500"
                          required
                          min="0"
                          placeholder="0"
                        />
                      </div>

                      <div className="col-span-1">
                        <label className="block text-xs text-gray-600 mb-1">Tax %</label>
                        <input
                          type="number"
                          value={item.tax_rate === 0 ? '' : item.tax_rate}
                          onChange={(e) => updateItemTotal(index, { ...item, tax_rate: e.target.value === '' ? 0 : Number(e.target.value) })}
                          className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded focus:ring-2 focus:ring-blue-500"
                          min="0"
                          placeholder="11"
                        />
                      </div>

                      <div className="col-span-2 flex items-end gap-2">
                        <div className="flex-1">
                          <label className="block text-xs text-gray-600 mb-1">Total</label>
                          <input
                            type="text"
                            value={(item.total || 0).toFixed(2)}
                            className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded bg-gray-100"
                            disabled
                          />
                        </div>
                        {items.length > 1 && (
                          <button
                            type="button"
                            onClick={() => removeItem(index)}
                            className="p-1.5 text-red-600 hover:bg-red-50 rounded"
                            title="Remove Item"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        )}
                      </div>
                      </div>
                      </div>

                      {item.batch_id && costPerUnit > 0 && (
                        <div className="flex items-center gap-2 text-[10px] px-2 py-1 bg-white rounded border border-gray-200">
                          <div className="flex items-center gap-1">
                            <span className="text-gray-600">Cost/Unit:</span>
                            <span className="font-semibold text-gray-900">Rp {costPerUnit.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                          </div>
                          <div className="h-3 w-px bg-gray-300" />
                          <div className="flex items-center gap-1">
                            <span className="text-gray-600">Suggested Price (25%):</span>
                            <span className="font-semibold text-blue-600">Rp {suggestedPrice.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                          </div>
                          <div className="h-3 w-px bg-gray-300" />
                          <div className="flex items-center gap-1">
                            <span className="text-gray-600">Margin <span className="text-xs italic">(Provisional)</span>:</span>
                            <span className={`font-semibold ${
                              margin >= 20 ? 'text-green-600' :
                              margin >= 10 ? 'text-yellow-600' :
                              'text-red-600'
                            }`}>
                              {margin.toFixed(1)}%
                            </span>
                          </div>
                          <div className="h-3 w-px bg-gray-300" />
                          <div className="flex items-center gap-1">
                            <span className="text-gray-600">Profit/Unit <span className="text-xs italic">(Provisional)</span>:</span>
                            <span className={`font-semibold ${
                              item.unit_price > costPerUnit ? 'text-green-600' : 'text-red-600'
                            }`}>
                              Rp {(item.unit_price - costPerUnit).toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                            </span>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              <div className="mt-2 p-2 bg-blue-50 rounded">
                <div className="space-y-1 text-xs">
                  <div className="flex justify-between">
                    <span>Subtotal:</span>
                    <span className="font-medium">Rp {calculateTotals().subtotal.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Tax:</span>
                    <span className="font-medium">Rp {calculateTotals().taxAmount.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Discount:</span>
                    <span className="font-medium">-Rp {formData.discount.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span>Bea Meterai:</span>
                    <MoneyInput
                      min="0"
                      value={formData.stamp_duty_amount}
                      onChange={(amount) => setFormData(prev => ({ ...prev, stamp_duty_amount: amount }))}
                      placeholder="0"
                      className="w-28 text-right px-1.5 py-0.5 text-xs border border-gray-300 rounded focus:ring-1 focus:ring-blue-500"
                    />
                  </div>
                  <div className="flex justify-between text-sm font-bold border-t pt-1">
                    <span>Total:</span>
                    <span className="text-blue-600">Rp {calculateTotals().total.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                  </div>
                </div>
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-3 border-t">
              <button
                type="button"
                onClick={() => {
                  setModalOpen(false);
                  resetForm();
                }}
                className="px-3 py-1.5 text-sm border border-gray-300 rounded hover:bg-gray-50 transition"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 transition"
              >
                {editingInvoice ? 'Update Invoice' : 'Create Invoice'}
              </button>
            </div>
          </form>
      </Modal>

      {linkedSOPreview && (
        <ProformaInvoiceView
          salesOrder={linkedSOPreview}
          items={linkedSOPreview.sales_order_items || []}
          onClose={() => setLinkedSOPreview(null)}
          companyProfile={(linkedSOPreview as any).company_snapshot ?? undefined}
        />
      )}

      {selectedFlyChallan && (
        <DeliveryChallanView
          challan={selectedFlyChallan}
          items={selectedFlyChallanItems}
          onClose={() => {
            setSelectedFlyChallan(null);
            setSelectedFlyChallanItems([]);
          }}
          companyProfile={(selectedFlyChallan as any).company_snapshot ?? undefined}
        />
      )}

        {viewModalOpen && selectedInvoice && (
          <InvoiceView
            invoice={selectedInvoice as any}
            items={invoiceItems as any}
            onClose={() => {
              setViewModalOpen(false);
              setSelectedInvoice(null);
              setInvoiceItems([]);
            }}
            companyProfile={(selectedInvoice as any).company_snapshot ?? undefined}
          />
        )}
      </div>
    </Layout>
  );
}
