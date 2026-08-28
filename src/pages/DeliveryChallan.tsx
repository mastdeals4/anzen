import { useEffect, useRef, useState } from 'react';
import { Layout } from '../components/Layout';
import { DataTable } from '../components/DataTable';
import { Modal } from '../components/Modal';
import { DeliveryChallanView } from '../components/DeliveryChallanView';
import { InvoiceView } from '../components/InvoiceView';
import { ProformaInvoiceView } from '../components/ProformaInvoiceView';
import { SearchableSelect } from '../components/SearchableSelect';
import { useLanguage } from '../contexts/LanguageContext';
import { useAuth } from '../contexts/AuthContext';
import { useNavigation } from '../contexts/NavigationContext';
import { useFinance } from '../contexts/FinanceContext';
import { supabase } from '../lib/supabase';
import { Plus, Trash2, Eye, Pencil as Edit, FileText, CheckCircle, XCircle } from 'lucide-react';
import { showToast } from '../components/ToastNotification';
import { showConfirm } from '../components/ConfirmDialog';
import { formatDate } from '../utils/dateFormat';
import { fetchLinkedDocumentsBundle, LinkedDocRef } from '../utils/linkedDocuments';
import { LinkedDocsCell } from '../components/LinkedDocsCell';
import { loadInvoiceDisplayItems } from '../utils/invoiceItemDisplay';

interface DeliveryChallan {
  id: string;
  challan_number: string;
  customer_id: string;
  challan_date: string;
  delivery_address: string;
  vehicle_number: string | null;
  driver_name: string | null;
  notes: string | null;
  approval_status: 'pending_approval' | 'approved' | 'rejected';
  status?: string;
  sales_order_id?: string | null;
  invoicing_status?: 'not_invoiced' | 'partially_invoiced' | 'fully_invoiced';
  total_items?: number;
  invoiced_items?: number;
  /** Quantity still available to invoice, supplied by dc_invoicing_summary. */
  total_remaining_quantity?: number | null;
  linked_invoices?: string[];
  product_names?: string;
  sales_orders?: {
    so_number: string;
    so_date?: string;
  } | null;
  customers?: {
    company_name: string;
    address: string;
    city: string;
    phone: string;
    pbf_license: string;
  };
}

interface ChallanItem {
  id?: string;
  sales_order_item_id?: string | null;
  product_id: string;
  batch_id: string;
  quantity: number;
  pack_size: number | null;
  pack_type: string | null;
  number_of_packs: number | null;
  products?: {
    product_name: string;
    product_code: string;
    unit: string;
  };
  batches?: {
    batch_number: string;
    expiry_date: string | null;
    current_stock: number;
    packaging_details: string | null;
  };
}

interface Customer {
  id: string;
  company_name: string;
  address: string;
  city: string;
}

interface Product {
  id: string;
  product_name: string;
  product_code: string;
  unit: string;
}

interface SalesOrderItemSource {
  id: string;
  product_id: string;
  quantity: number;
  delivered_quantity: number;
  unit_price: number;
  products?: { product_name: string; unit: string } | null;
}

interface Batch {
  id: string;
  batch_number: string;
  product_id: string;
  current_stock: number;
  reserved_stock: number;
  expiry_date: string | null;
  packaging_details: string | null;
  import_date: string | null;
}

const isExpired = (expiryDate: string | null): boolean => {
  if (!expiryDate) return false;
  return new Date(expiryDate) < new Date();
};

export function DeliveryChallan() {
  const { profile } = useAuth();
  const { navigationData, clearNavigationData, setCurrentPage, setNavigationData } = useNavigation();
  const { dateRange } = useFinance();
  const [challans, setChallans] = useState<DeliveryChallan[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [viewModalOpen, setViewModalOpen] = useState(false);
  const [selectedChallan, setSelectedChallan] = useState<DeliveryChallan | null>(null);
  const [challanItems, setChallanItems] = useState<ChallanItem[]>([]);
  const [editingChallan, setEditingChallan] = useState<DeliveryChallan | null>(null);
  const [originalItems, setOriginalItems] = useState<ChallanItem[]>([]);
  const [showRejectModal, setShowRejectModal] = useState(false);
  const [rejectionReason, setRejectionReason] = useState('');
  const [challanToReject, setChallanToReject] = useState<string | null>(null);
  const [formData, setFormData] = useState({
    challan_number: '',
    customer_id: '',
    sales_order_id: '',
    challan_date: new Date().toISOString().split('T')[0],
    delivery_address: '',
    vehicle_number: '',
    driver_name: '',
    notes: '',
  });

  const [salesOrders, setSalesOrders] = useState<any[]>([]);
  const approvalOperationIdsRef = useRef<Record<string, string>>({});
  const [soReservations, setSoReservations] = useState<Map<string, number>>(new Map());
  const [soReservationLoadState, setSoReservationLoadState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [linkedInvoicePreview, setLinkedInvoicePreview] = useState<any | null>(null);
  const [linkedInvoiceItems, setLinkedInvoiceItems] = useState<any[]>([]);
  const [linkedSOPreview, setLinkedSOPreview] = useState<any | null>(null);
  const [salesOrderItemSources, setSalesOrderItemSources] = useState<SalesOrderItemSource[]>([]);
  const [items, setItems] = useState<Omit<ChallanItem, 'id'>[]>([{
    product_id: '',
    batch_id: '',
    quantity: 0,
    pack_size: null,
    pack_type: null,
    number_of_packs: null,
  }]);

  useEffect(() => {
    loadChallans();
    loadCustomers();
    loadProducts();
    loadBatches();
  }, [dateRange.startDate, dateRange.endDate]);

  const loadSalesOrders = async (customerId?: string) => {
    try {
      let query = supabase
        .from('sales_orders')
        .select(`
          id,
          so_number,
          customer_id,
          status,
          customers(company_name),
          sales_order_items(products(product_name))
        `)
        .in('status', ['approved', 'stock_reserved', 'shortage', 'pending_delivery', 'partially_delivered'])
        .eq('is_archived', false)
        .order('so_date', { ascending: false });

      if (customerId) {
        query = query.eq('customer_id', customerId);
      }

      const { data, error } = await query;

      if (error) throw error;
      setSalesOrders(data || []);
    } catch (error) {
      console.error('Error loading sales orders:', error);
    }
  };

  const loadChallans = async () => {
    try {
      const { data, error } = await supabase
        .from('delivery_challans')
        .select('*, customers(company_name, address, city, phone, pbf_license), sales_orders(so_number, so_date)')
        .gte('challan_date', dateRange.startDate)
        .lte('challan_date', dateRange.endDate)
        .order('challan_date', { ascending: false });

      if (error) throw error;

      const { data: invoicingData, error: invError } = await supabase
        .from('dc_invoicing_summary')
        .select('*');

      if (invError) {
        console.error('Error loading invoicing status:', invError);
      }

      const invStatusMap = new Map();
      (invoicingData || []).forEach((inv: any) => {
        invStatusMap.set(inv.challan_id, {
          status: inv.dc_status,
          total_items: inv.total_items,
          not_invoiced_items: inv.not_invoiced_items,
          partially_invoiced_items: inv.partially_invoiced_items,
          fully_invoiced_items: inv.fully_invoiced_items,
          total_remaining_quantity: inv.total_remaining_quantity,
          linked_invoices: inv.linked_invoice_numbers || []
        });
      });

      const challansWithStatus = (data || []).map(challan => {
        const invStatus = invStatusMap.get(challan.id);
        return {
          ...challan,
          invoicing_status: invStatus?.status || 'not_invoiced',
          total_items: invStatus?.total_items || 0,
          invoiced_items: (invStatus?.fully_invoiced_items || 0) + (invStatus?.partially_invoiced_items || 0),
          total_remaining_quantity: invStatus?.total_remaining_quantity ?? null,
          linked_invoices: invStatus?.linked_invoices || []
        };
      });


      const bundle = await fetchLinkedDocumentsBundle();
      const enrichedBase = challansWithStatus.map((c: any) => {
        const l = bundle.dcMap.get(c.id);
        return {
          ...c,
          linked_so_number: l?.sos?.[0]?.number || c.sales_orders?.so_number || null,
          linked_invoices: (l?.invs || []).map((i) => i.number)
        };
      });

      // Fetch product names for all challans so search by product name works
      const challanIds = enrichedBase.map((c: any) => c.id);
      const productNamesMap = new Map<string, string>();
      if (challanIds.length > 0) {
        const { data: itemsData } = await supabase
          .from('delivery_challan_items')
          .select('challan_id, products(product_name)')
          .in('challan_id', challanIds);
        (itemsData || []).forEach((item: any) => {
          const existing = productNamesMap.get(item.challan_id) || '';
          const name = item.products?.product_name || '';
          if (name && !existing.includes(name)) {
            productNamesMap.set(item.challan_id, existing ? `${existing}, ${name}` : name);
          }
        });
      }

      const enriched = enrichedBase.map((c: any) => ({
        ...c,
        product_names: productNamesMap.get(c.id) || ''
      }));

      setChallans(enriched);

    } catch (error) {
      console.error('Error loading challans:', error);
    } finally {
      setLoading(false);
    }
  };

  const openChallanPreview = async (challan: DeliveryChallan) => {
    const items = await loadChallanItems(challan.id);
    setSelectedChallan(challan);
    setChallanItems(items);
    setViewModalOpen(true);
  };

  useEffect(() => {
    const requestedId = navigationData?.challanId;
    if (typeof requestedId !== 'string') return;
    const openRequested = async () => {
      const inList = challans.find(challan => challan.id === requestedId);
      if (inList) {
        await openChallanPreview(inList);
      } else {
        const { data } = await supabase
          .from('delivery_challans')
          .select('*, customers(company_name, address, city, phone, pbf_license), sales_orders(so_number, so_date)')
          .eq('id', requestedId)
          .maybeSingle();
        if (data) await openChallanPreview(data as DeliveryChallan);
      }
      clearNavigationData();
    };
    void openRequested();
  }, [navigationData, challans, clearNavigationData]);

  const openSalesOrderPreview = async (soId: string) => {
    if (!soId) return;
    const { data } = await supabase
      .from('sales_orders')
      .select('*, customers(*), sales_order_items(*, products(id, product_name, product_code, unit))')
      .eq('id', soId)
      .maybeSingle();
    if (data) setLinkedSOPreview(data);
  };

  const openInvoicePreview = async (invoiceNumber: string) => {
    const { data: invoice } = await supabase
      .from('sales_invoices')
      .select('*, customers(company_name, address, city, phone, npwp, pharmacy_license, gst_vat_type)')
      .eq('invoice_number', invoiceNumber)
      .maybeSingle();
    if (!invoice) return;
    const items = await loadInvoiceDisplayItems(supabase, invoice.id);
    setLinkedInvoicePreview(invoice);
    setLinkedInvoiceItems(items || []);
  };

  const generateNextChallanNumber = async () => {
    try {
      // Get current financial year automatically
      const { data: yearCode, error: fyError } = await supabase
        .rpc('get_current_financial_year');

      if (fyError) {
        console.error('Error getting financial year:', fyError);
        const fallbackYear = new Date().getFullYear().toString().slice(-2);
        return `DO-${fallbackYear}-0001`;
      }

      const prefix = 'DO';

      // Get all challan numbers with this prefix and year to find the highest number
      const { data: allChallans } = await supabase
        .from('delivery_challans')
        .select('challan_number')
        .or(`challan_number.like.DO-${yearCode}%,challan_number.like.DC-${yearCode}%`);

      let nextNumber = 1;

      if (allChallans && allChallans.length > 0) {
        // Extract all numbers and find the maximum
        const numbers = allChallans
          .map(challan => {
            const match = challan.challan_number.match(/(\d+)$/);
            return match ? parseInt(match[1], 10) : 0;
          })
          .filter(num => !isNaN(num));

        if (numbers.length > 0) {
          const maxNumber = Math.max(...numbers);
          nextNumber = maxNumber + 1;
        }
      }

      const paddedNumber = String(nextNumber).padStart(4, '0');
      return `${prefix}-${yearCode}-${paddedNumber}`;
    } catch (error) {
      console.error('Error generating challan number:', error);
      const fallbackYear = new Date().getFullYear().toString().slice(-2);
      return `DO-${fallbackYear}-0001`;
    }
  };

  const loadCustomers = async () => {
    try {
      const { data, error } = await supabase
        .from('customers')
        .select('id, company_name, address, city')
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
        .select('id, product_name, product_code, unit')
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
      const { data, error } = await supabase
        .from('batches')
        .select('id, batch_number, product_id, current_stock, reserved_stock, expiry_date, packaging_details, import_date')
        .eq('is_active', true)
        .gt('current_stock', 0)
        .order('import_date', { ascending: true });

      if (error) throw error;
      setBatches(data || []);
    } catch (error) {
      console.error('Error loading batches:', error);
    }
  };

  const loadChallanItems = async (challanId: string) => {
    try {
      const { data, error } = await supabase
        .from('delivery_challan_items')
        .select('*, products(product_name, product_code, unit), batches(batch_number, expiry_date, packaging_details, current_stock)')
        .eq('challan_id', challanId);

      if (error) throw error;
      return data || [];
    } catch (error) {
      console.error('Error loading challan items:', error);
      return [];
    }
  };

  const getFIFOBatch = (productId: string) => {
    const productBatches = batches
      .filter(b => b.product_id === productId && !isExpired(b.expiry_date) && getAvailableStock(b) > 0)
      .sort((a, b) => {
        const dateA = new Date(a.import_date!).getTime();
        const dateB = new Date(b.import_date!).getTime();
        return dateA - dateB;
      });
    return productBatches[0] || null;
  };

  const handleCustomerChange = (customerId: string) => {
    const customer = customers.find(c => c.id === customerId);
    if (customer) {
      setFormData({
        ...formData,
        customer_id: customerId,
        sales_order_id: '',
        delivery_address: `${customer.address}, ${customer.city}`,
      });
      loadSalesOrders(customerId);
    }
  };

  const getAvailableStock = (batch: Batch) => {
    return batch.current_stock;
  };

  const handleSalesOrderChange = async (soId: string, sourceOrder?: { id: string; customer_id: string }) => {
    setFormData(prev => ({ ...prev, sales_order_id: soId, customer_id: sourceOrder?.customer_id || prev.customer_id }));

    if (soId) {
      setSoReservations(new Map());
      setSoReservationLoadState('loading');
      const so = sourceOrder || salesOrders.find(s => s.id === soId);
      if (so) {
        setFormData(prev => ({ ...prev, customer_id: so.customer_id }));

        try {
          const [soItemsResult, reservationsResult] = await Promise.all([
            supabase
              .from('sales_order_items')
              .select(`id, product_id, quantity, delivered_quantity, unit_price, products(product_name, unit)`)
              .eq('sales_order_id', soId),
            supabase
              .from('so_product_reservation_status')
              .select('sales_order_item_id, reserved_quantity')
              .eq('sales_order_id', soId)
          ]);

          if (soItemsResult.error) throw soItemsResult.error;
          if (reservationsResult.error) throw reservationsResult.error;

          const resMap = new Map<string, number>();
          (reservationsResult.data || []).forEach((r: any) => {
            resMap.set(r.sales_order_item_id, parseFloat(r.reserved_quantity));
          });
          setSoReservations(resMap);
          setSoReservationLoadState('ready');

          const soItems = soItemsResult.data;
          const normalizedSoItems = (soItems || []).map((item: any) => ({
            ...item,
            products: Array.isArray(item.products) ? (item.products[0] || null) : item.products,
          })) as SalesOrderItemSource[];
          setSalesOrderItemSources(normalizedSoItems);
          if (soItems && soItems.length > 0) {
            const newItems = soItems.map(item => {
              const productBatches = batches
                .filter(b => {
                  return b.product_id === item.product_id && b.current_stock > 0 && !isExpired(b.expiry_date);
                })
                .sort((a, b) => {
                  const ea = a.expiry_date ? new Date(a.expiry_date).getTime() : Number.MAX_SAFE_INTEGER;
                  const eb = b.expiry_date ? new Date(b.expiry_date).getTime() : Number.MAX_SAFE_INTEGER;
                  return ea - eb || new Date(a.import_date!).getTime() - new Date(b.import_date!).getTime();
                });
              const fifoBatch = productBatches[0] || null;

              if (!fifoBatch) {
                return {
                  sales_order_item_id: item.id,
                  product_id: item.product_id,
                  batch_id: '',
                  quantity: parseFloat(String(item.quantity)) || 0,
                  pack_size: null,
                  pack_type: null,
                  number_of_packs: null,
                };
              }

              let packSize = null;
              let packType = null;
              let numberOfPacks = null;

              if (fifoBatch.packaging_details) {
                const match = fifoBatch.packaging_details.match(/(\d+)\s+(\w+)s?\s+x\s+(\d+(?:\.\d+)?)kg/i);
                if (match) {
                  numberOfPacks = parseInt(match[1], 10);
                  packType = match[2].toLowerCase();
                  packSize = parseFloat(match[3]);
                }
              }

              return {
                sales_order_item_id: item.id,
                product_id: item.product_id,
                batch_id: fifoBatch.id,
                quantity: parseFloat(String(item.quantity)) || 0,
                pack_size: packSize,
                pack_type: packType,
                number_of_packs: numberOfPacks || 1,
              };
            });
            setItems(newItems);
          }
        } catch (error) {
          console.error('Error loading SO items:', error);
          setSoReservations(new Map());
          setSoReservationLoadState('error');
          showToast({ type: 'error', title: 'Error', message: 'Failed to load Sales Order reservation data. Delivery Challan quantities cannot be validated; please try again.' });
        }
      } else {
        setSoReservationLoadState('error');
      }
    } else {
      setSoReservations(new Map());
      setSoReservationLoadState('idle');
      setSalesOrderItemSources([]);
      setItems([{
        product_id: '',
        batch_id: '',
        quantity: 0,
        pack_size: null,
        pack_type: null,
        number_of_packs: null,
      }]);
    }
  };

  useEffect(() => {
    const requestedSoId = navigationData?.createDeliveryChallanFromSO;
    if (typeof requestedSoId !== 'string' || !batches.length || !customers.length) return;
    let cancelled = false;
    const openPrefilledChallan = async () => {
      const { data: so, error } = await supabase
        .from('sales_orders')
        .select('id,customer_id')
        .eq('id', requestedSoId)
        .maybeSingle();
      if (cancelled) return;
      if (error || !so) {
        console.error('Unable to load Sales Order for Delivery Challan:', error);
        showToast({ type: 'error', title: 'Delivery Challan', message: 'The Sales Order could not be loaded.' });
        clearNavigationData();
        return;
      }
      resetForm();
      setModalOpen(true);
      // Load the customer-scoped choices for the form, then hydrate the SO
      // lines/reservations directly by ID. This avoids falling back to the DC
      // list when the SO is outside the currently loaded list.
      void loadSalesOrders(so.customer_id);
      await handleSalesOrderChange(requestedSoId, so);
      if (!cancelled) clearNavigationData();
    };
    void openPrefilledChallan();
    return () => { cancelled = true; };
  }, [navigationData, batches, customers, clearNavigationData]);

  const handleBatchChange = (index: number, batchId: string) => {
    const batch = batches.find(b => b.id === batchId);
    if (batch) {
      const newItems = [...items];

      let packSize = null;
      let packType = null;
      let numberOfPacks = null;

      // Extract packaging details from batch
      if (batch.packaging_details) {
        const match = batch.packaging_details.match(/(\d+)\s+(\w+)s?\s+x\s+(\d+(?:\.\d+)?)kg/i);
        if (match) {
          packType = match[2].toLowerCase();
          packSize = parseFloat(match[3]);

          const availableStock = getAvailableStock(batch);

          if (packSize && packSize > 0) {
            // Calculate how many full packs can fit in available stock
            const maxPacks = Math.floor(availableStock / packSize);

            // Default to 1 pack if available, otherwise 0 (will trigger validation)
            numberOfPacks = maxPacks >= 1 ? 1 : 0;
          } else {
            numberOfPacks = 1;
          }
        }
      }

      const quantity = packSize && numberOfPacks ? packSize * numberOfPacks : 0;

      newItems[index] = {
        ...newItems[index],
        batch_id: batchId,
        pack_size: packSize,
        pack_type: packType,
        number_of_packs: numberOfPacks || 1,
        quantity: quantity,
      };
      setItems(newItems);
    }
  };

  const updatePackQuantity = (index: number, packs: number) => {
    const newItems = [...items];
    const item = newItems[index];
    if (item.pack_size) {
      newItems[index] = {
        ...item,
        number_of_packs: packs,
        quantity: item.pack_size * packs,
      };
      setItems(newItems);
    }
  };

  const addItem = () => {
    setItems([...items, {
      product_id: '',
      batch_id: '',
      quantity: 0,
      pack_size: null,
      pack_type: null,
      number_of_packs: null,
    }]);
  };

  const removeItem = (index: number) => {
    if (items.length > 1) {
      setItems(items.filter((_, i) => i !== index));
    }
  };

  const handleEdit = async (challan: DeliveryChallan) => {
    // Load full challan with sales_order_id
    const { data: fullChallan } = await supabase
      .from('delivery_challans')
      .select('*')
      .eq('id', challan.id)
      .single();

    setEditingChallan(challan);
    setFormData({
      challan_number: challan.challan_number,
      customer_id: challan.customer_id,
      sales_order_id: fullChallan?.sales_order_id || '',
      challan_date: challan.challan_date,
      delivery_address: challan.delivery_address,
      vehicle_number: challan.vehicle_number || '',
      driver_name: challan.driver_name || '',
      notes: challan.notes || '',
    });

    const loadedItems = await loadChallanItems(challan.id);
    setOriginalItems(loadedItems);

    if (loadedItems.length > 0) {
      setItems(loadedItems.map(item => ({
        product_id: item.product_id,
        sales_order_item_id: item.sales_order_item_id || null,
        batch_id: item.batch_id,
        quantity: parseFloat(String(item.quantity)) || 0,
        pack_size: item.pack_size ? parseFloat(String(item.pack_size)) : null,
        pack_type: item.pack_type,
        number_of_packs: item.number_of_packs ? parseInt(String(item.number_of_packs), 10) : null,
      })));
    }

    setModalOpen(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (items.length === 0) {
      showToast({ type: 'error', title: 'Error', message: 'Please add at least one item to the Delivery Challan.' });
      return;
    }

    const invalidItems = items.filter(item => !item.product_id || !item.batch_id || item.quantity <= 0);
    if (invalidItems.length > 0) {
      showToast({ type: 'error', title: 'Error', message: 'Please select product, batch, and enter quantity for all items before saving.' });
      return;
    }

    const emptyBatches = items.filter(item => !item.batch_id || item.batch_id === '');
    if (emptyBatches.length > 0) {
      showToast({ type: 'error', title: 'Error', message: 'Some items do not have a batch selected. Please select a batch for all items.' });
      return;
    }

    const emptyProducts = items.filter(item => !item.product_id || item.product_id === '');
    if (emptyProducts.length > 0) {
      showToast({ type: 'error', title: 'Error', message: 'Some items do not have a product selected. Please select a product for all items.' });
      return;
    }

    const batchUsage = new Map<string, number>();
    for (const item of items) {
      const currentUsage = batchUsage.get(item.batch_id) || 0;
      batchUsage.set(item.batch_id, currentUsage + item.quantity);
    }

    for (const [batchId, totalQuantity] of batchUsage.entries()) {
      const batch = batches.find(b => b.id === batchId);
      if (batch) {
        let availableStock = getAvailableStock(batch);

        if (editingChallan) {
          const originalQtyInThisBatch = originalItems
            .filter(oi => oi.batch_id === batchId)
            .reduce((sum, oi) => sum + oi.quantity, 0);
          availableStock += originalQtyInThisBatch;
        }

        if (totalQuantity > availableStock) {
          const product = products.find(p => p.id === items.find(i => i.batch_id === batchId)?.product_id);
          const unit = product?.unit || 'kg';
          showToast({ type: 'error', title: 'Error', message: `Insufficient available stock for batch ${batch.batch_number}!\n\nProduct: ${product?.product_name || 'Unknown'}\nBatch: ${batch.batch_number}\nAvailable: ${availableStock} ${unit}\nTotal Requested (across all items): ${totalQuantity} ${unit}\n\nYou are using this batch in multiple items. Please reduce quantities or select different batches.` });
          return;
        }
      }
    }

    if (!editingChallan && !formData.sales_order_id) {
      showToast({ type: 'error', title: 'Error', message: 'Sales Order is required to create a Delivery Challan.' });
      return;
    }

    if (formData.sales_order_id) {
      const { data: sourceOrder, error: sourceError } = await supabase
        .from('sales_orders')
        .select('id, customer_id, status')
        .eq('id', formData.sales_order_id)
        .maybeSingle();
      if (sourceError || !sourceOrder) {
        showToast({ type: 'error', title: 'Delivery Challan', message: 'The selected Sales Order no longer exists.' });
        return;
      }
      if (sourceOrder.customer_id !== formData.customer_id) {
        showToast({ type: 'error', title: 'Delivery Challan', message: 'Customer does not match the selected Sales Order.' });
        return;
      }
      const { data: sourceItems, error: sourceItemsError } = await supabase
        .from('sales_order_items')
        .select('id, product_id, quantity, delivered_quantity')
        .eq('sales_order_id', formData.sales_order_id);
      if (sourceItemsError) throw sourceItemsError;
      const sourceMap = new Map((sourceItems || []).map((row: any) => [row.id, row]));
      for (const item of items) {
        if (!item.sales_order_item_id || !sourceMap.has(item.sales_order_item_id)) {
          showToast({ type: 'error', title: 'Delivery Challan', message: 'Every item must come from the selected Sales Order.' });
          return;
        }
        const source = sourceMap.get(item.sales_order_item_id) as any;
        if (source.product_id !== item.product_id) {
          showToast({ type: 'error', title: 'Delivery Challan', message: 'A selected product does not match its Sales Order item.' });
          return;
        }
        if (item.quantity <= 0 || item.quantity > Number(source.quantity) - Number(source.delivered_quantity || 0) + 0.0001) {
          showToast({ type: 'error', title: 'Delivery Challan', message: `Quantity for ${item.product_id} exceeds the remaining Sales Order quantity.` });
          return;
        }
      }

      // SO reservations are product-level. Batch is independently selected
      // here and validated as physical stock at DC approval.
      const { data: activeReservations, error: reservationError } = await supabase
        .from('so_product_reservations')
        .select('sales_order_item_id, reserved_quantity')
        .eq('sales_order_id', formData.sales_order_id)
        .eq('status', 'active');
      if (reservationError) throw reservationError;
      const mismatch = items.some(item => {
        const reserved = (activeReservations || [])
          .filter((r: any) => r.sales_order_item_id === item.sales_order_item_id)
          .reduce((sum: number, r: any) => sum + Number(r.reserved_quantity), 0);
        return reserved + 0.0001 < Number(item.quantity);
      });
      if (mismatch) {
        showToast({ type: 'error', title: 'Delivery Challan', message: 'Delivery quantity exceeds the remaining Sales Order product reservation.' });
        return;
      }
    }

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      let challanId: string;

      if (editingChallan) {
        // When editing, DO NOT update challan_number (it's unique and shouldn't change)
        const updateData = {
          customer_id: formData.customer_id,
          sales_order_id: formData.sales_order_id || null,
          challan_date: formData.challan_date,
          delivery_address: formData.delivery_address,
          vehicle_number: formData.vehicle_number || null,
          driver_name: formData.driver_name || null,
          notes: formData.notes || null,
          // Don't reset approval_status when editing
          // Don't update created_by when editing
        };

        const { data: updatedChallan, error: updateError } = await supabase
          .from('delivery_challans')
          .update(updateData)
          .eq('id', editingChallan.id)
          .select()
          .single();

        if (updateError) throw updateError;

        // Approved allocations are immutable. Corrections must use the
        // canonical rejection/cancellation reversal and a replacement DC.
        const itemsForRpc = items.map(item => ({
          product_id: item.product_id,
          batch_id: item.batch_id,
          sales_order_item_id: item.sales_order_item_id || null,
          quantity: item.quantity,
          pack_size: item.pack_size,
          pack_type: item.pack_type,
          number_of_packs: item.number_of_packs,
        }));

        if (editingChallan.approval_status === 'approved') {
          throw new Error('Approved Delivery Challans cannot be edited. Reject/cancel the DC to reverse its allocation, then create a corrected DC.');
        } else {
          const { data: rpcResult, error: rpcError } = await supabase.rpc('edit_delivery_challan', {
            p_challan_id: editingChallan.id,
            p_new_items: itemsForRpc
          });
          if (rpcError) {
            console.error('RPC Error:', rpcError);
            throw new Error(`Failed to update DC: ${rpcError.message}`);
          }
          if (!rpcResult?.success) {
            console.error('RPC Result Error:', rpcResult?.error);
            throw new Error(rpcResult?.error || 'Failed to update DC items');
          }
        }

        challanId = updatedChallan.id;
      } else {
        // When creating new, include all fields including challan_number
        const challanData = {
          challan_number: formData.challan_number,
          customer_id: formData.customer_id,
          sales_order_id: formData.sales_order_id || null,
          challan_date: formData.challan_date,
          delivery_address: formData.delivery_address,
          vehicle_number: formData.vehicle_number || null,
          driver_name: formData.driver_name || null,
          notes: formData.notes || null,
          approval_status: 'pending_approval',
          created_by: user.id,
        };

        const { data: newChallan, error: challanError } = await supabase
          .from('delivery_challans')
          .insert([challanData])
          .select()
          .single();

        if (challanError) throw challanError;
        challanId = newChallan.id;
      }

      if (!editingChallan) {
        const challanItemsData = items.map(item => ({
          challan_id: challanId,
            product_id: item.product_id,
            batch_id: item.batch_id,
            sales_order_item_id: item.sales_order_item_id || null,
          quantity: parseFloat(String(item.quantity)),
          pack_size: item.pack_size ? parseFloat(String(item.pack_size)) : null,
          pack_type: item.pack_type,
          number_of_packs: item.number_of_packs ? parseInt(String(item.number_of_packs), 10) : null,
        }));

        if (challanItemsData.length === 0) {
          await supabase.from('delivery_challans').delete().eq('id', challanId);
          throw new Error('No items to save. Please add at least one item.');
        }

        const { data: insertedItems, error: itemsError } = await supabase
          .from('delivery_challan_items')
          .insert(challanItemsData)
          .select('id');

        if (itemsError) {
          await supabase.from('delivery_challans').delete().eq('id', challanId);
          throw itemsError;
        }

        if (!insertedItems || insertedItems.length === 0) {
          await supabase.from('delivery_challans').delete().eq('id', challanId);
          throw new Error('Items failed to save. The Delivery Challan was not created. Please try again.');
        }

      }

      // Pending DCs are not deliveries. The approval trigger recomputes the SO
      // only after reservation consumption, batch allocation, and physical
      // stock movement succeed in the same database transaction.

      setModalOpen(false);
      resetForm();
      loadChallans();
      loadBatches();
      showToast({ type: 'success', title: 'Success', message: `Delivery Challan ${editingChallan ? 'updated' : 'created'} successfully!` });
    } catch (error: any) {
      console.error('Error saving challan:', error);
      console.error('Full error object:', JSON.stringify(error, null, 2));
      const errorMessage = error?.message || error?.error_description || error?.msg || 'Unknown error occurred';

      if (errorMessage.toLowerCase().includes('insufficient stock')) {
        showToast({ type: 'error', title: 'Error', message: `Cannot save: ${errorMessage}\n\nPlease reduce quantities or select different batches with more stock.` });
      } else if (errorMessage.includes('batch_id')) {
        showToast({ type: 'error', title: 'Error', message: `Error: Invalid batch selection.\n\n${errorMessage}\n\nPlease ensure all items have a valid batch selected.` });
      } else if (errorMessage.includes('foreign key')) {
        showToast({ type: 'error', title: 'Error', message: `Error: Invalid product or batch selection.\n\n${errorMessage}\n\nPlease check your selections.` });
      } else {
        showToast({ type: 'error', title: 'Error', message: `Failed to save challan:\n\n${errorMessage}` });
      }
    }
  };

  const handleDelete = async (id: string) => {
    if (!await showConfirm({ title: 'Confirm', message: 'Are you sure you want to delete this delivery challan? This will revert the linked Sales Order status.', variant: 'danger', confirmLabel: 'Delete' })) return;

    try {
      const { data: dcData } = await supabase
        .from('delivery_challans')
        .select('sales_order_id, id')
        .eq('id', id)
        .single();

      const { error } = await supabase
        .from('delivery_challans')
        .delete()
        .eq('id', id);

      if (error) throw error;

      if (dcData?.sales_order_id) {
        await supabase
          .from('sales_orders')
          .update({
            status: 'pending_delivery',
            is_archived: false,
            archived_at: null,
            archived_by: null,
            archive_reason: null
          })
          .eq('id', dcData.sales_order_id);
      }

      loadChallans();
      showToast({ type: 'success', title: 'Success', message: 'Delivery Challan deleted successfully. Sales Order status has been reverted.' });
    } catch (error) {
      console.error('Error deleting challan:', error);
      showToast({ type: 'error', title: 'Error', message: 'Failed to delete challan. Please try again.' });
    }
  };

  const handleApproveChallan = async (challanId: string) => {
    if (!await showConfirm({ title: 'Confirm', message: 'Approve this Delivery Challan? Stock will be deducted and it will be available for invoice creation.', variant: 'warning' })) return;

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');
      const operationId = approvalOperationIdsRef.current[challanId] || crypto.randomUUID();
      approvalOperationIdsRef.current[challanId] = operationId;

      const { error } = await supabase
        .from('delivery_challans')
        .update({
          approval_status: 'approved',
          approval_operation_id: operationId,
          approved_by: user.id,
          approved_at: new Date().toISOString()
        })
        .eq('id', challanId);

      if (error) {
        console.error('Approval error:', error);
        const errorMsg = error.message || error.hint || 'Unknown error';
        throw new Error(errorMsg);
      }

      showToast({ type: 'success', title: 'Success', message: 'Delivery Challan approved successfully!' });
      delete approvalOperationIdsRef.current[challanId];
      loadChallans();

      // Notify warehouse staff (non-blocking)
      supabase.functions.invoke('send-app-notifications', {
        body: { type: 'dc_approved', data: { dc_id: challanId } }
      }).catch(() => {});
    } catch (error: any) {
      console.error('Error approving challan:', error);
      const errorMessage = error?.message || 'Unknown error';

      if (errorMessage.toLowerCase().includes('insufficient stock')) {
        showToast({ type: 'error', title: 'Error', message: `Cannot approve - Insufficient Stock!\n\n${errorMessage}\n\nPlease edit the DC and reduce quantities or select different batches.` });
      } else {
        showToast({ type: 'error', title: 'Error', message: `Failed to approve challan:\n\n${errorMessage}` });
      }
    }
  };

  const handleRejectChallan = async () => {
    if (!challanToReject || !rejectionReason.trim()) {
      showToast({ type: 'error', title: 'Error', message: 'Please enter a rejection reason' });
      return;
    }

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const { error } = await supabase
        .from('delivery_challans')
        .update({
          approval_status: 'rejected',
          rejected_by: user.id,
          rejected_at: new Date().toISOString(),
          rejection_reason: rejectionReason
        })
        .eq('id', challanToReject);

      if (error) throw error;

      showToast({ type: 'success', title: 'Success', message: 'Delivery Challan rejected' });
      setShowRejectModal(false);
      setRejectionReason('');
      setChallanToReject(null);
      loadChallans();
    } catch (error: any) {
      console.error('Error rejecting challan:', error.message);
      showToast({ type: 'error', title: 'Error', message: 'Failed to reject challan' });
    }
  };

  const resetForm = () => {
    setEditingChallan(null);
    setOriginalItems([]);
    setSalesOrderItemSources([]);
    setFormData({
      challan_number: '',
      customer_id: '',
      sales_order_id: '',
      challan_date: new Date().toISOString().split('T')[0],
      delivery_address: '',
      vehicle_number: '',
      driver_name: '',
      notes: '',
    });
    setItems([{
      product_id: '',
      batch_id: '',
      quantity: 0,
      pack_size: null,
      pack_type: null,
      number_of_packs: null,
    }]);
  };

  const columns = [
    {
      key: 'challan_number',
      label: 'DO Number',
      render: (value: any, _challan: DeliveryChallan) => (
        <span className="text-xs font-medium text-gray-700 tracking-wide">{value}</span>
      )
    },
    {
      key: 'customer',
      label: 'Customer',
      render: (value: any, challan: DeliveryChallan) => (
        <div className="font-medium">{challan.customers?.company_name}</div>
      )
    },
    {
      key: 'challan_date',
      label: 'Date',
      render: (value: any, challan: DeliveryChallan) => formatDate(challan.challan_date)
    },
    {
      key: 'approval_status',
      label: 'Status / Approval',
      render: (value: any, challan: DeliveryChallan) => {
        const statusColors = {
          pending_approval: 'bg-yellow-100 text-yellow-800',
          approved: 'bg-green-100 text-green-800',
          rejected: 'bg-red-100 text-red-800'
        };
        const statusLabels = {
          pending_approval: 'Pending Approval',
          approved: 'Approved',
          rejected: 'Rejected'
        };
        return (
          <div className="flex items-center justify-center gap-2">
            <span className={`px-1.5 py-0.5 rounded-full text-[11px] leading-tight font-medium ${statusColors[challan.approval_status]}`}>
              {statusLabels[challan.approval_status]}
            </span>
            {challan.approval_status === 'pending_approval' && profile?.role === 'admin' && (
              <div className="flex items-center gap-1 ml-2">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleApproveChallan(challan.id);
                  }}
                  className="p-1 bg-green-100 hover:bg-green-200 rounded-lg transition-colors"
                  title="Approve Delivery Challan"
                >
                  <CheckCircle className="w-4 h-4 text-green-600" />
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setChallanToReject(challan.id);
                    setShowRejectModal(true);
                  }}
                  className="p-1 bg-red-100 hover:bg-red-200 rounded-lg transition-colors"
                  title="Reject Delivery Challan"
                >
                  <XCircle className="w-4 h-4 text-red-600" />
                </button>
              </div>
            )}
            {challan.approval_status === 'approved' && (
              <span title="Approved">
                <CheckCircle className="w-4 h-4 text-green-600 ml-1" />
              </span>
            )}
            {challan.approval_status === 'rejected' && (
              <span title="Rejected">
                <XCircle className="w-4 h-4 text-red-600 ml-1" />
              </span>
            )}
          </div>
        );
      }
    },
    {
      key: 'so_dc_link',
      label: 'Linked Docs',
      thClassName: 'min-w-[130px]',
      tdClassName: 'min-w-[130px]',
      render: (_value: any, challan: DeliveryChallan) => (
        <LinkedDocsCell
          sos={(challan as any).linked_so_number ? [{ id: challan.sales_order_id || '', number: (challan as any).linked_so_number, type: 'so' }] : []}
          dcs={[]}
          invs={((challan as any).linked_invoices || []).map((n: string, i: number) => ({ id: `${challan.id}-${i}`, number: n, type: 'inv' as const }))}
          show={{ dc: false }}
          onClick={(doc: LinkedDocRef) => {
            if (doc.type === 'so') openSalesOrderPreview(doc.id);
            if (doc.type === 'inv') openInvoicePreview(doc.number);
          }}
        />
      )
    },
    {
      key: 'invoicing_status',
      label: 'Invoicing Status',
      render: (value: any, challan: DeliveryChallan) => {
        const statusColors = {
          not_invoiced: 'bg-gray-100 text-gray-700',
          partially_invoiced: 'bg-yellow-100 text-yellow-700',
          fully_invoiced: 'bg-blue-100 text-blue-700'
        };
        const statusLabels = {
          not_invoiced: 'Not Invoiced',
          partially_invoiced: 'Partially Invoiced',
          fully_invoiced: 'Fully Invoiced'
        };
        const status = challan.invoicing_status || 'not_invoiced';
        return (
          <div className="space-y-1">
            <span className={`inline-block px-1.5 py-0.5 rounded-full text-[11px] leading-tight font-medium ${statusColors[status]}`}>
              {statusLabels[status]}
            </span>
            {(challan.total_items ?? 0) > 0 && status !== 'fully_invoiced' && (
              <div className="text-xs text-gray-500">
                {challan.invoiced_items || 0}/{challan.total_items} items invoiced
              </div>
            )}
            {challan.linked_invoices && challan.linked_invoices.length > 0 && (
              <div className="text-xs text-blue-600 font-medium">
                {challan.linked_invoices.join(', ')}
              </div>
            )}
          </div>
        );
      }
    },
  ];

  const canManage = profile?.role === 'admin' || profile?.role === 'accounts' || profile?.role === 'sales' || profile?.role === 'warehouse';

  const stats = {
    total: challans.length,
  };

  return (
    <Layout>
      <div className="space-y-6">
        <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold text-gray-900">Delivery Challan (Surat Jalan)</h1>
            <p className="text-gray-600 mt-1">Manage delivery orders and dispatch records</p>
          </div>
          {canManage && (
            <button
              onClick={async () => {
                resetForm();
                const nextChallanNumber = await generateNextChallanNumber();
                setFormData(prev => ({ ...prev, challan_number: nextChallanNumber }));
                setModalOpen(true);
              }}
              className="flex items-center gap-2 bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 transition"
            >
              <Plus className="w-5 h-5" />
              New Delivery Challan
            </button>
          )}
        </div>

        <>
        <div className="bg-white rounded-lg shadow p-3">
          <p className="text-sm text-gray-600">Total Delivery Challans</p>
          <p className="text-2xl font-bold text-gray-900 mt-1">{stats.total}</p>
        </div>

        <DataTable
          columns={columns}
          data={challans}
          loading={loading}
          compact
          tableClassName="w-full min-w-[1050px]"
          actions={(challan) => (
            <div className="flex items-center gap-2">
              <button
                onClick={async () => {
                  await openChallanPreview(challan);
                }}
                className="p-1 text-blue-600 hover:bg-blue-50 rounded"
                title="View Challan"
              >
                <Eye className="w-4 h-4" />
              </button>
              {canManage && (
                <>
                  {challan.approval_status === 'approved' &&
                    // The summary view is the source of truth for invoiceable quantity.
                    // Keep the status fallback for older/temporarily unavailable view rows.
                    (challan.total_remaining_quantity == null
                      ? challan.invoicing_status !== 'fully_invoiced'
                      : Number(challan.total_remaining_quantity) > 0) && <button
                    onClick={async () => {
                      const items = await loadChallanItems(challan.id);
                      setNavigationData({
                        sourceType: 'delivery_challan',
                        customerId: challan.customer_id,
                        challanNumber: challan.challan_number,
                        challanId: challan.id,
                        items: items
                      });
                      setCurrentPage('sales');
                    }}
                    className="p-1 text-purple-600 hover:bg-purple-50 rounded"
                    title="Create Invoice"
                  >
                    <FileText className="w-4 h-4" />
                  </button>}
                  {/* Approved DCs are immutable; use the canonical reversal path. */}
                  {challan.approval_status !== 'approved' && (
                    <>
                      <button
                        onClick={() => handleEdit(challan)}
                        className="p-1 text-indigo-600 hover:bg-indigo-50 rounded"
                        title="Edit Challan"
                      >
                        <Edit className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => handleDelete(challan.id)}
                        className="p-1 text-red-600 hover:bg-red-50 rounded"
                        title="Delete Challan"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </>
                  )}
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
          title={editingChallan ? `Edit DC - ${formData.challan_number}` : `Create DC - ${formData.challan_number}`}
          size="xl"
        >
          <form onSubmit={handleSubmit} className="space-y-3">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Customer *
                </label>
                <SearchableSelect
                  value={formData.customer_id}
                  onChange={handleCustomerChange}
                  options={customers.map(c => ({ value: c.id, label: c.company_name }))}
                  placeholder="Select Customer"
                  required
                  disabled={!!formData.sales_order_id}
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Sales Order {!editingChallan && <span className="text-red-500">*</span>}
                </label>
                <SearchableSelect
                  value={formData.sales_order_id}
                  onChange={handleSalesOrderChange}
                  options={salesOrders.map((so: any) => {
                    const productNames = [...new Set(
                      (so.sales_order_items || [])
                        .map((i: any) => i.products?.product_name)
                        .filter(Boolean)
                    )].join(', ');
                    const statusLabel = so.status === 'partially_delivered' ? 'partial' : so.status.replace('_', ' ');
                    return {
                      value: so.id,
                      label: productNames
                        ? `${so.so_number} — ${productNames} (${statusLabel})`
                        : `${so.so_number} (${statusLabel})`
                    };
                  })}
                  placeholder={formData.customer_id ? 'Select Sales Order' : 'Select a customer first'}
                  disabled={!formData.customer_id}
                />
                {!formData.customer_id && (
                  <p className="text-xs text-gray-500 mt-1">Select a customer first to see available Sales Orders</p>
                )}
                {formData.customer_id && salesOrders.length === 0 && (
                  <p className="text-xs text-red-600 mt-1 font-medium">
                    No active Sales Orders for this customer. Please create a Sales Order first before creating a Delivery Challan.
                  </p>
                )}
                {formData.customer_id && salesOrders.length > 0 && !formData.sales_order_id && !editingChallan && (
                  <p className="text-xs text-amber-600 mt-1">
                    Please create or select a Sales Order before creating Delivery Challan
                  </p>
                )}
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Vehicle Number
                </label>
                <input
                  type="text"
                  value={formData.vehicle_number}
                  onChange={(e) => setFormData({ ...formData, vehicle_number: e.target.value })}
                  className="w-full px-3 py-1.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                  placeholder="B 1234 XYZ"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Driver Name
                </label>
                <input
                  type="text"
                  value={formData.driver_name}
                  onChange={(e) => setFormData({ ...formData, driver_name: e.target.value })}
                  className="w-full px-3 py-1.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                  placeholder="Driver name"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Date *
                </label>
                <input
                  type="date"
                  value={formData.challan_date}
                  onChange={(e) => setFormData({ ...formData, challan_date: e.target.value })}
                  className="w-full px-3 py-1.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                  required
                />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Delivery Address *
                </label>
                <textarea
                  value={formData.delivery_address}
                  onChange={(e) => setFormData({ ...formData, delivery_address: e.target.value })}
                  className="w-full px-3 py-1.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                  rows={2}
                  required
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Notes
                </label>
                <textarea
                  value={formData.notes}
                  onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                  className="w-full px-3 py-1.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                  rows={2}
                  placeholder="Additional notes..."
                />
              </div>
            </div>

            <div className="border-t pt-3 mt-3">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-sm font-semibold text-gray-700">Items to Dispatch</h3>
                {(editingChallan?.approval_status !== 'approved' || profile?.role === 'admin') && (
                  <button
                    type="button"
                    onClick={addItem}
                    className="text-sm px-3 py-1 bg-blue-50 text-blue-600 hover:bg-blue-100 rounded-lg font-medium transition-colors"
                  >
                    + Add Item
                  </button>
                )}
              </div>

              {formData.sales_order_id && salesOrderItemSources.length > 0 && (
                <div className="mb-3 rounded border border-blue-200 bg-blue-50 p-2 text-xs text-blue-900">
                  <div className="font-semibold mb-1">Sales Order source and remaining quantities</div>
                  <div className="space-y-1">
                    {salesOrderItemSources.map(source => (
                      <div key={source.id} className="flex justify-between gap-3">
                        <span>{source.products?.product_name || source.product_id}</span>
                        <span>
                          Ordered {source.quantity} · Delivered {source.delivered_quantity || 0} · Reserved{' '}
                          {soReservationLoadState === 'loading'
                            ? 'Loading…'
                            : soReservationLoadState === 'error'
                              ? 'Unavailable (reservation query failed)'
                              : (soReservations.get(source.id) ?? 0)}{' '}
                          · Remaining {Math.max(0, Number(source.quantity) - Number(source.delivered_quantity || 0))} {source.products?.unit || ''}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {editingChallan?.approval_status === 'approved' && (
                <div className="mb-3 px-3 py-2 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-700 flex items-center gap-2">
                  <span className="text-amber-500">!</span>
                  Approved Delivery Challans are immutable. Reject/cancel this DC to reverse its allocation, then create a corrected DC.
                </div>
              )}

              <div className="space-y-2">
                {items.map((item, index) => {
                  const batchUsageInForm = new Map<string, number>();
                  items.forEach((formItem, formIndex) => {
                    if (formIndex !== index && formItem.batch_id) {
                      const currentUsage = batchUsageInForm.get(formItem.batch_id) || 0;
                      batchUsageInForm.set(formItem.batch_id, currentUsage + formItem.quantity);
                    }
                  });

                  const availableBatches = batches.filter(b => {
                    const baseAvailable = getAvailableStock(b);
                    const usedInOtherItems = batchUsageInForm.get(b.id) || 0;
                    return b.product_id === item.product_id && (baseAvailable - usedInOtherItems) > 0;
                  });
                  const selectedBatch = batches.find(b => b.id === item.batch_id);

                  return (
                    <div key={index} className="relative p-2 bg-gray-50 rounded border border-gray-200">
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-2 mb-2">
                        <div>
                          <label className="block text-xs text-gray-600 mb-0.5">Product *</label>
                          <SearchableSelect
                            value={item.product_id}
                            onChange={(value) => {
                              const newItems = [...items];
                              newItems[index] = { ...newItems[index], product_id: value, batch_id: '' };
                              setItems(newItems);
                            }}
                            options={products.map(p => ({ value: p.id, label: p.product_name }))}
                            placeholder="Select Product"
                            className="text-xs"
                            required
                          />
                        </div>

                        <div>
                          <div className="flex items-center justify-between mb-0.5">
                            <label className="block text-xs text-gray-600">Batch *</label>
                            {item.product_id && availableBatches.length > 0 && (
                              <button
                                type="button"
                                onClick={() => {
                                  const fifoBatch = getFIFOBatch(item.product_id);
                                  if (fifoBatch) {
                                    handleBatchChange(index, fifoBatch.id);
                                  }
                                }}
                                className="text-[10px] text-blue-600 hover:text-blue-700 font-medium"
                                title="Select oldest batch (FIFO)"
                              >
                                Use FIFO
                              </button>
                            )}
                          </div>
                          {!item.product_id ? (
                            <div className="w-full px-2 py-1 text-xs border border-gray-300 rounded bg-gray-100 text-gray-400">
                              Select product first
                            </div>
                          ) : availableBatches.length > 0 ? (
                            <SearchableSelect
                              value={item.batch_id}
                              onChange={(value) => handleBatchChange(index, value)}
                              options={availableBatches.map((b, idx) => {
                                const fifoIndicator = idx === 0 ? ' 🔄' : '';
                                const baseAvailable = getAvailableStock(b);
                                const usedInOtherItems = batchUsageInForm.get(b.id) || 0;
                                const actualAvailable = baseAvailable - usedInOtherItems;
                                return {
                                  value: b.id,
                                  label: `${b.batch_number} (Avl: ${actualAvailable}kg)${fifoIndicator}`
                                };
                              })}
                              placeholder="Select Batch"
                              className="text-xs"
                              required
                            />
                          ) : (
                            <div className="w-full px-2 py-1 text-xs border border-red-300 rounded bg-red-50 text-red-700 flex items-center gap-1">
                              <span>⚠</span>
                              <span>No stock available</span>
                            </div>
                          )}
                        </div>
                      </div>

                      {selectedBatch && (
                        <div className="mb-2">
                          <div className="overflow-x-auto">
                          <table className="w-full text-[10px] border border-gray-300">
                            <thead className="bg-gray-200">
                              <tr>
                                <th className="px-1 py-0.5 text-left border-r border-gray-300">Batch</th>
                                <th className="px-1 py-0.5 text-left border-r border-gray-300">Expiry</th>
                                <th className="px-1 py-0.5 text-left border-r border-gray-300">Packaging</th>
                                <th className="px-1 py-0.5 text-right border-r border-gray-300">Total</th>
                                <th className="px-1 py-0.5 text-right font-semibold">Available</th>
                              </tr>
                            </thead>
                            <tbody>
                              <tr className="bg-white">
                                <td className="px-1 py-0.5 border-r border-gray-300">{selectedBatch.batch_number}</td>
                                <td className="px-1 py-0.5 border-r border-gray-300">
                                  {selectedBatch.expiry_date ? new Date(selectedBatch.expiry_date).toLocaleDateString('en-GB', {day: '2-digit', month: '2-digit', year: '2-digit'}) : '-'}
                                </td>
                                <td className="px-1 py-0.5 border-r border-gray-300">{selectedBatch.packaging_details || '-'}</td>
                                <td className="px-1 py-0.5 text-right border-r border-gray-300">{selectedBatch.current_stock}kg</td>
                                <td className="px-1 py-0.5 text-right font-bold text-green-600">
                                  {(() => {
                                    const baseAvailable = getAvailableStock(selectedBatch);
                                    const usedInOtherItems = batchUsageInForm.get(selectedBatch.id) || 0;
                                    return baseAvailable - usedInOtherItems;
                                  })()}kg
                                </td>
                              </tr>
                            </tbody>
                          </table>
                          </div>
                        </div>
                      )}

                      {item.pack_size && (
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                          <div>
                            <label className="block text-xs text-gray-600 mb-0.5">No. of Packs *</label>
                            <input
                              type="number"
                              value={item.number_of_packs || ''}
                              onChange={(e) => updatePackQuantity(index, Number(e.target.value))}
                              className="w-full px-2 py-1 text-xs border border-gray-300 rounded focus:ring-1 focus:ring-blue-500"
                              required
                              min="1"
                            />
                          </div>
                          <div>
                            <label className="block text-xs text-gray-600 mb-0.5">Pack Size</label>
                            <input
                              type="text"
                              value={`${item.pack_size} kg`}
                              className="w-full px-2 py-1 text-xs border border-gray-300 rounded bg-gray-100"
                              disabled
                            />
                          </div>
                          <div>
                            <label className="block text-xs text-gray-600 mb-0.5">Total Qty (Kg)</label>
                            <input
                              type="text"
                              value={`${item.quantity} kg`}
                              className="w-full px-2 py-1 text-xs border border-gray-300 rounded bg-gray-100"
                              disabled
                            />
                          </div>
                        </div>
                      )}

                      {items.length > 1 && (
                        <button
                          type="button"
                          onClick={() => removeItem(index)}
                          className="absolute top-1 right-1 text-xs text-red-600 hover:text-red-800 bg-white px-2 py-0.5 rounded border border-red-300 shadow-sm"
                        >
                          Remove
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="flex justify-end gap-3 pt-3 border-t mt-3">
              <button
                type="button"
                onClick={() => {
                  setModalOpen(false);
                  resetForm();
                }}
                className="px-5 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors font-medium"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-5 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-medium shadow-sm"
              >
                {editingChallan ? 'Update Challan' : 'Create Challan'}
              </button>
            </div>
          </form>
        </Modal>

        {viewModalOpen && selectedChallan && (
          <DeliveryChallanView
            challan={selectedChallan as any}
            items={challanItems as any}
            onClose={() => setViewModalOpen(false)}
            companyProfile={(selectedChallan as any).company_snapshot ?? undefined}
          />
        )}
        {linkedSOPreview && (
          <ProformaInvoiceView
            salesOrder={linkedSOPreview}
            items={linkedSOPreview.sales_order_items || []}
            onClose={() => setLinkedSOPreview(null)}
            companyProfile={linkedSOPreview.company_snapshot ?? undefined}
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
            companyProfile={linkedInvoicePreview.company_snapshot ?? undefined}
          />
        )}

        {showRejectModal && (
          <Modal
            isOpen={showRejectModal}
            onClose={() => {
              setShowRejectModal(false);
              setRejectionReason('');
              setChallanToReject(null);
            }}
            title="Reject Delivery Challan"
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
                  placeholder="Enter reason for rejecting this delivery challan..."
                />
              </div>
              <div className="flex gap-2 justify-end">
                <button
                  onClick={() => {
                    setShowRejectModal(false);
                    setRejectionReason('');
                    setChallanToReject(null);
                  }}
                  className="px-4 py-2 border rounded-lg hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  onClick={handleRejectChallan}
                  className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700"
                  disabled={!rejectionReason.trim()}
                >
                  Reject Challan
                </button>
              </div>
            </div>
          </Modal>
        )}
        </>
      </div>
    </Layout>
  );
}
