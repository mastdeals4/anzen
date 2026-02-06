import { useEffect, useState } from 'react';
import { Layout } from '../components/Layout';
import { DataTable } from '../components/DataTable';
import { Modal } from '../components/Modal';
import { DeliveryChallanView } from '../components/DeliveryChallanView';
import { SearchableSelect } from '../components/SearchableSelect';
import { useLanguage } from '../contexts/LanguageContext';
import { useAuth } from '../contexts/AuthContext';
import { useNavigation } from '../contexts/NavigationContext';
import { supabase } from '../lib/supabase';
import { Plus, Trash2, Eye, Edit, FileText, CheckCircle, XCircle } from 'lucide-react';
import { showToast } from '../components/ToastNotification';
import { showConfirm } from '../components/ConfirmDialog';

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
  invoicing_status?: 'not_invoiced' | 'partially_invoiced' | 'fully_invoiced';
  total_items?: number;
  invoiced_items?: number;
  linked_invoices?: string[];
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
  const { setCurrentPage, setNavigationData } = useNavigation();
  const [challans, setChallans] = useState<DeliveryChallan[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [viewModalOpen, setViewModalOpen] = useState(false);
  const [selectedChallan, setSelectedChallan] = useState<DeliveryChallan | null>(null);
  const [challanItems, setChallanItems] = useState<ChallanItem[]>([]);
  const [companySettings, setCompanySettings] = useState<any>(null);
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
    loadCompanySettings();
  }, []);

  const loadSalesOrders = async (customerId?: string) => {
    try {
      let query = supabase
        .from('sales_orders')
        .select(`
          id,
          so_number,
          customer_id,
          status,
          customers(company_name)
        `)
        .in('status', ['approved', 'stock_reserved', 'shortage', 'pending_delivery'])
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

  const loadCompanySettings = async () => {
    try {
      const { data, error } = await supabase
        .from('app_settings')
        .select('*')
        .limit(1)
        .maybeSingle();

      if (error) throw error;
      setCompanySettings(data);
    } catch (error) {
      console.error('Error loading company settings:', error);
    }
  };

  const loadChallans = async () => {
    try {
      const { data, error } = await supabase
        .from('delivery_challans')
        .select('*, customers(company_name, address, city, phone, pbf_license)')
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
          linked_invoices: inv.linked_invoice_numbers || []
        });
      });

      const challansWithStatus = (data || []).map(challan => {
        const invStatus = invStatusMap.get(challan.id);
        return {
          ...challan,
          invoicing_status: invStatus?.status || 'not_invoiced',
          total_items: invStatus?.total_items || 0,
          invoiced_items: invStatus?.fully_invoiced_items + invStatus?.partially_invoiced_items || 0,
          linked_invoices: invStatus?.linked_invoices || []
        };
      });

      setChallans(challansWithStatus);
    } catch (error) {
      console.error('Error loading challans:', error);
    } finally {
      setLoading(false);
    }
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
      .filter(b => b.product_id === productId && !isExpired(b.expiry_date))
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

  const handleSalesOrderChange = async (soId: string) => {
    setFormData({ ...formData, sales_order_id: soId });

    if (soId) {
      const so = salesOrders.find(s => s.id === soId);
      if (so) {
        setFormData(prev => ({ ...prev, customer_id: so.customer_id }));

        try {
          const { data: soItems, error } = await supabase
            .from('sales_order_items')
            .select(`
              id,
              product_id,
              quantity,
              products(product_name)
            `)
            .eq('sales_order_id', soId);

          if (error) throw error;

          if (soItems && soItems.length > 0) {
            const newItems = soItems.map(item => {
              const productBatches = batches.filter(b => b.product_id === item.product_id && (b.current_stock - (b.reserved_stock || 0)) > 0);
              const fifoBatch = productBatches.length > 0 ? productBatches[0] : null;

              if (!fifoBatch) {
                return {
                  product_id: item.product_id,
                  batch_id: '',
                  quantity: item.quantity,
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
                product_id: item.product_id,
                batch_id: fifoBatch.id,
                quantity: item.quantity,
                pack_size: packSize,
                pack_type: packType,
                number_of_packs: numberOfPacks || 1,
              };
            });
            setItems(newItems);
          }
        } catch (error) {
          console.error('Error loading SO items:', error);
          showToast({ type: 'error', title: 'Error', message: 'Failed to load Sales Order items. Please try again.' });
        }
      }
    } else {
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

          // SMART DEFAULTS: Calculate number of packs based on AVAILABLE stock
          const availableStock = batch.current_stock - (batch.reserved_stock || 0);

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
        batch_id: item.batch_id,
        quantity: item.quantity,
        pack_size: item.pack_size,
        pack_type: item.pack_type,
        number_of_packs: item.number_of_packs,
      })));
    }

    setModalOpen(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

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
        let availableStock = batch.current_stock - (batch.reserved_stock || 0);

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

        const itemsForRpc = items.map(item => ({
          product_id: item.product_id,
          batch_id: item.batch_id,
          quantity: item.quantity,
          pack_size: item.pack_size,
          pack_type: item.pack_type,
          number_of_packs: item.number_of_packs,
        }));

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
          quantity: item.quantity,
          pack_size: item.pack_size,
          pack_type: item.pack_type,
          number_of_packs: item.number_of_packs,
        }));

        const { error: itemsError } = await supabase
          .from('delivery_challan_items')
          .insert(challanItemsData);

        if (itemsError) {
          await supabase.from('delivery_challans').delete().eq('id', challanId);
          throw itemsError;
        }
      }

      // HARDENING FIX #3: Atomic delivered_quantity update
      // Prevents race conditions from concurrent DC creation
      if (!editingChallan && formData.sales_order_id) {
        const dcItemsForRpc = items.map(item => ({
          product_id: item.product_id,
          quantity: item.quantity,
        }));

        const { error: soUpdateError } = await supabase
          .rpc('update_so_delivered_quantity_atomic', {
            p_sales_order_id: formData.sales_order_id,
            p_dc_items: dcItemsForRpc,
          });

        if (soUpdateError) throw soUpdateError;

        // Archive SO if fully delivered (status was updated by RPC)
        const { data: updatedSO } = await supabase
          .from('sales_orders')
          .select('status')
          .eq('id', formData.sales_order_id)
          .single();

        if (updatedSO?.status === 'delivered') {
          await supabase
            .from('sales_orders')
            .update({
              is_archived: true,
              archived_at: new Date().toISOString(),
              archived_by: user.id,
              archive_reason: 'Delivery Challan created and all items delivered'
            })
            .eq('id', formData.sales_order_id);
        }
      }

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

      const { error } = await supabase
        .from('delivery_challans')
        .update({
          approval_status: 'approved',
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
      loadChallans();
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
    { key: 'challan_number', label: 'DO Number' },
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
      render: (value: any, challan: DeliveryChallan) => new Date(challan.challan_date).toLocaleDateString()
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
            <span className={`px-2 py-1 rounded-full text-xs font-medium ${statusColors[challan.approval_status]}`}>
              {statusLabels[challan.approval_status]}
            </span>
            {challan.approval_status === 'pending_approval' && profile?.role === 'admin' && (
              <div className="flex items-center gap-1 ml-2">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleApproveChallan(challan.id);
                  }}
                  className="p-2 bg-green-100 hover:bg-green-200 rounded-lg transition-colors"
                  title="Approve Delivery Challan"
                >
                  <CheckCircle className="w-6 h-6 text-green-600" />
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setChallanToReject(challan.id);
                    setShowRejectModal(true);
                  }}
                  className="p-2 bg-red-100 hover:bg-red-200 rounded-lg transition-colors"
                  title="Reject Delivery Challan"
                >
                  <XCircle className="w-6 h-6 text-red-600" />
                </button>
              </div>
            )}
            {challan.approval_status === 'approved' && (
              <CheckCircle className="w-5 h-5 text-green-600 ml-2" title="Approved" />
            )}
            {challan.approval_status === 'rejected' && (
              <XCircle className="w-5 h-5 text-red-600 ml-2" title="Rejected" />
            )}
          </div>
        );
      }
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
            <span className={`inline-block px-2 py-1 rounded-full text-xs font-medium ${statusColors[status]}`}>
              {statusLabels[status]}
            </span>
            {challan.total_items > 0 && (
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
              Create Delivery Challan
            </button>
          )}
        </div>

        <div className="bg-white rounded-lg shadow p-6">
          <p className="text-sm text-gray-600">Total Delivery Challans</p>
          <p className="text-2xl font-bold text-gray-900 mt-1">{stats.total}</p>
        </div>

        <DataTable
          columns={columns}
          data={challans}
          loading={loading}
          actions={(challan) => (
            <div className="flex items-center gap-2">
              <button
                onClick={async () => {
                  const items = await loadChallanItems(challan.id);
                  setSelectedChallan(challan);
                  setChallanItems(items);
                  setViewModalOpen(true);
                }}
                className="p-1 text-blue-600 hover:bg-blue-50 rounded"
                title="View Challan"
              >
                <Eye className="w-4 h-4" />
              </button>
              {canManage && (
                <>
                  <button
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
                    title="Create Invoice from DO"
                  >
                    <FileText className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => handleEdit(challan)}
                    className="p-1 text-green-600 hover:bg-green-50 rounded"
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
                  Linked Sales Order
                </label>
                <SearchableSelect
                  value={formData.sales_order_id}
                  onChange={handleSalesOrderChange}
                  options={[
                    { value: '', label: 'No Sales Order / Manual Entry' },
                    ...salesOrders.map((so: any) => ({
                      value: so.id,
                      label: `${so.so_number} (${so.status})`
                    }))
                  ]}
                  placeholder="Select Sales Order"
                  disabled={!formData.customer_id}
                />
                {formData.customer_id && salesOrders.length === 0 && (
                  <p className="text-xs text-orange-600 mt-1">⚠ No active sales orders for this customer</p>
                )}
                {!formData.customer_id && (
                  <p className="text-xs text-gray-500 mt-1">Select a customer first</p>
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
                <button
                  type="button"
                  onClick={addItem}
                  className="text-sm px-3 py-1 bg-blue-50 text-blue-600 hover:bg-blue-100 rounded-lg font-medium transition-colors"
                >
                  + Add Item
                </button>
              </div>

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
                    const baseAvailable = b.current_stock - (b.reserved_stock || 0);
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
                                const baseAvailable = b.current_stock - (b.reserved_stock || 0);
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
                                    const baseAvailable = selectedBatch.current_stock - (selectedBatch.reserved_stock || 0);
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
            challan={selectedChallan}
            items={challanItems}
            onClose={() => setViewModalOpen(false)}
            companySettings={companySettings}
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
      </div>
    </Layout>
  );
}
