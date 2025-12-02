import { useEffect, useState } from 'react';
import { Layout } from '../components/Layout';
import { DataTable } from '../components/DataTable';
import { Modal } from '../components/Modal';
import { DeliveryChallanView } from '../components/DeliveryChallanView';
import { useLanguage } from '../contexts/LanguageContext';
import { useAuth } from '../contexts/AuthContext';
import { useNavigation } from '../contexts/NavigationContext';
import { supabase } from '../lib/supabase';
import { Plus, Trash2, Eye, Edit, FileText, CheckCircle, XCircle } from 'lucide-react';

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
      setChallans(data || []);
    } catch (error) {
      console.error('Error loading challans:', error);
    } finally {
      setLoading(false);
    }
  };

  const generateNextChallanNumber = async () => {
    try {
      // Get financial year from settings
      const { data: settings } = await supabase
        .from('app_settings')
        .select('financial_year_start')
        .limit(1)
        .maybeSingle();

      let yearCode = new Date().getFullYear().toString().slice(-2);

      // If financial year is set, use it
      if (settings?.financial_year_start) {
        const fyYear = new Date(settings.financial_year_start).getFullYear();
        yearCode = fyYear.toString().slice(-2);
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
      return 'DO-25-0001';
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
        .select('id, batch_number, product_id, current_stock, expiry_date, packaging_details, import_date')
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
              const productBatches = batches.filter(b => b.product_id === item.product_id && b.current_stock > 0);
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
          alert('Failed to load Sales Order items. Please try again.');
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

      if (batch.packaging_details) {
        const match = batch.packaging_details.match(/(\d+)\s+(\w+)s?\s+x\s+(\d+(?:\.\d+)?)kg/i);
        if (match) {
          numberOfPacks = parseInt(match[1], 10);
          packType = match[2].toLowerCase();
          packSize = parseFloat(match[3]);
        }
      }

      newItems[index] = {
        ...newItems[index],
        batch_id: batchId,
        pack_size: packSize,
        pack_type: packType,
        number_of_packs: numberOfPacks || 1,
        quantity: packSize && numberOfPacks ? packSize * numberOfPacks : 0,
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
    setEditingChallan(challan);
    setFormData({
      challan_number: challan.challan_number,
      customer_id: challan.customer_id,
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
      alert('Please select product, batch, and enter quantity for all items before saving.');
      return;
    }

    const emptyBatches = items.filter(item => item.batch_id === '');
    if (emptyBatches.length > 0) {
      alert('Some items do not have a batch selected. Please select a batch for all items.');
      return;
    }

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

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

      let challanId: string;

      if (editingChallan) {
        const stockAdjustments: { batch_id: string; adjustment: number }[] = [];

        for (const originalItem of originalItems) {
          stockAdjustments.push({
            batch_id: originalItem.batch_id,
            adjustment: originalItem.quantity,
          });
        }

        for (const newItem of items) {
          const existingAdjustment = stockAdjustments.find(adj => adj.batch_id === newItem.batch_id);
          if (existingAdjustment) {
            existingAdjustment.adjustment -= newItem.quantity;
          } else {
            stockAdjustments.push({
              batch_id: newItem.batch_id,
              adjustment: -newItem.quantity,
            });
          }
        }

        for (const adjustment of stockAdjustments) {
          if (adjustment.adjustment !== 0) {
            const { error: batchError } = await supabase.rpc('update_batch_stock', {
              p_batch_id: adjustment.batch_id,
              p_adjustment: adjustment.adjustment,
            });

            if (batchError) {
              const { data: batchData } = await supabase
                .from('batches')
                .select('current_stock')
                .eq('id', adjustment.batch_id)
                .single();

              if (batchData) {
                const newStock = batchData.current_stock + adjustment.adjustment;
                await supabase
                  .from('batches')
                  .update({ current_stock: newStock })
                  .eq('id', adjustment.batch_id);
              }
            }
          }
        }

        const { data: updatedChallan, error: updateError } = await supabase
          .from('delivery_challans')
          .update(challanData)
          .eq('id', editingChallan.id)
          .select()
          .single();

        if (updateError) throw updateError;

        const { error: deleteItemsError } = await supabase
          .from('delivery_challan_items')
          .delete()
          .eq('challan_id', editingChallan.id);

        if (deleteItemsError) throw deleteItemsError;

        challanId = updatedChallan.id;
      } else {
        const { data: newChallan, error: challanError } = await supabase
          .from('delivery_challans')
          .insert([challanData])
          .select()
          .single();

        if (challanError) throw challanError;
        challanId = newChallan.id;

        for (const item of items) {
          if (formData.sales_order_id) {
            const { error: releaseError } = await supabase.rpc('fn_deduct_stock_and_release_reservation', {
              p_so_id: formData.sales_order_id,
              p_batch_id: item.batch_id,
              p_product_id: item.product_id,
              p_quantity: item.quantity,
              p_user_id: user.id
            });

            if (releaseError) {
              console.error('Error releasing reservation:', releaseError);
            }
          }
        }

        if (formData.sales_order_id) {
          const { data: soItems } = await supabase
            .from('sales_order_items')
            .select('id, product_id, quantity, delivered_quantity')
            .eq('sales_order_id', formData.sales_order_id);

          if (soItems) {
            let allDelivered = true;
            for (const soItem of soItems) {
              const dcItem = items.find(i => i.product_id === soItem.product_id);
              const newDeliveredQty = (soItem.delivered_quantity || 0) + (dcItem?.quantity || 0);

              await supabase
                .from('sales_order_items')
                .update({ delivered_quantity: newDeliveredQty })
                .eq('id', soItem.id);

              if (newDeliveredQty < soItem.quantity) {
                allDelivered = false;
              }
            }

            const newStatus = allDelivered ? 'delivered' : 'partially_delivered';
            await supabase
              .from('sales_orders')
              .update({
                status: newStatus,
                is_archived: allDelivered,
                archived_at: allDelivered ? new Date().toISOString() : null,
                archived_by: allDelivered ? user.id : null,
                archive_reason: allDelivered ? 'Delivery Challan created and all items delivered' : null
              })
              .eq('id', formData.sales_order_id);
          }
        }
      }

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

      if (itemsError) throw itemsError;

      setModalOpen(false);
      resetForm();
      loadChallans();
      loadBatches();
      alert(`Delivery Challan ${editingChallan ? 'updated' : 'created'} successfully!`);
    } catch (error: any) {
      console.error('Error saving challan:', error);
      const errorMessage = error?.message || 'Unknown error occurred';
      if (errorMessage.includes('batch_id')) {
        alert('Error: Invalid batch selection. Please ensure all items have a valid batch selected.');
      } else if (errorMessage.includes('foreign key')) {
        alert('Error: Invalid product or batch selection. Please check your selections.');
      } else {
        alert(`Failed to save challan: ${errorMessage}`);
      }
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Are you sure you want to delete this delivery challan? This will revert the linked Sales Order status.')) return;

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
      alert('Delivery Challan deleted successfully. Sales Order status has been reverted.');
    } catch (error) {
      console.error('Error deleting challan:', error);
      alert('Failed to delete challan. Please try again.');
    }
  };

  const handleApproveChallan = async (challanId: string) => {
    if (!confirm('Approve this Delivery Challan? It will be available for invoice creation.')) return;

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

      if (error) throw error;

      alert('Delivery Challan approved successfully!');
      loadChallans();
    } catch (error: any) {
      console.error('Error approving challan:', error.message);
      alert('Failed to approve challan');
    }
  };

  const handleRejectChallan = async () => {
    if (!challanToReject || !rejectionReason.trim()) {
      alert('Please enter a rejection reason');
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

      alert('Delivery Challan rejected');
      setShowRejectModal(false);
      setRejectionReason('');
      setChallanToReject(null);
      loadChallans();
    } catch (error: any) {
      console.error('Error rejecting challan:', error.message);
      alert('Failed to reject challan');
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
      render: (challan: DeliveryChallan) => (
        <div className="font-medium">{challan.customers?.company_name}</div>
      )
    },
    {
      key: 'challan_date',
      label: 'Date',
      render: (challan: DeliveryChallan) => new Date(challan.challan_date).toLocaleDateString()
    },
    {
      key: 'approval_status',
      label: 'Status / Approval',
      render: (challan: DeliveryChallan) => {
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
  ];

  const canManage = profile?.role === 'admin' || profile?.role === 'accounts' || profile?.role === 'sales' || profile?.role === 'warehouse';

  const stats = {
    total: challans.length,
  };

  return (
    <Layout>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
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
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Customer *
                </label>
                <select
                  value={formData.customer_id}
                  onChange={(e) => handleCustomerChange(e.target.value)}
                  className="w-full px-3 py-1.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                  required
                  disabled={!!formData.sales_order_id}
                >
                  <option value="">Select Customer</option>
                  {customers.map((customer) => (
                    <option key={customer.id} value={customer.id}>
                      {customer.company_name}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Linked Sales Order
                </label>
                <select
                  value={formData.sales_order_id}
                  onChange={(e) => handleSalesOrderChange(e.target.value)}
                  className="w-full px-3 py-1.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                  disabled={!formData.customer_id}
                >
                  <option value="">No Sales Order / Manual Entry</option>
                  {salesOrders.map((so: any) => (
                    <option key={so.id} value={so.id}>
                      {so.so_number} ({so.status})
                    </option>
                  ))}
                </select>
                {formData.customer_id && salesOrders.length === 0 && (
                  <p className="text-xs text-orange-600 mt-1">⚠ No active sales orders for this customer</p>
                )}
                {!formData.customer_id && (
                  <p className="text-xs text-gray-500 mt-1">Select a customer first</p>
                )}
              </div>
            </div>

            <div className="grid grid-cols-3 gap-3">
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

            <div className="grid grid-cols-2 gap-3">
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
                  const availableBatches = batches.filter(b => b.product_id === item.product_id);
                  const selectedBatch = batches.find(b => b.id === item.batch_id);

                  return (
                    <div key={index} className="p-3 bg-gray-50 rounded-lg space-y-2">
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className="block text-xs text-gray-600 mb-1">Product *</label>
                          <select
                            value={item.product_id}
                            onChange={(e) => {
                              const newItems = [...items];
                              newItems[index] = { ...newItems[index], product_id: e.target.value, batch_id: '' };
                              setItems(newItems);
                            }}
                            className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded focus:ring-2 focus:ring-blue-500"
                            required
                          >
                            <option value="">Select Product</option>
                            {products.map((p) => (
                              <option key={p.id} value={p.id}>{p.product_name}</option>
                            ))}
                          </select>
                        </div>

                        {item.product_id && (
                          <div className="space-y-1">
                            <div className="flex items-center justify-between">
                              <label className="block text-xs text-gray-600">Batch *</label>
                              {availableBatches.length > 0 && (
                                <button
                                  type="button"
                                  onClick={() => {
                                    const fifoBatch = getFIFOBatch(item.product_id);
                                    if (fifoBatch) {
                                      handleBatchChange(index, fifoBatch.id);
                                    }
                                  }}
                                  className="text-xs text-blue-600 hover:text-blue-700 font-medium"
                                  title="Select oldest batch (FIFO)"
                                >
                                  Use FIFO
                                </button>
                              )}
                            </div>
                            {availableBatches.length > 0 ? (
                              <select
                                value={item.batch_id}
                                onChange={(e) => handleBatchChange(index, e.target.value)}
                                className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded focus:ring-2 focus:ring-blue-500"
                                required
                              >
                                <option value="">Select Batch</option>
                                {availableBatches.map((b, idx) => {
                                  const fifoIndicator = idx === 0 ? ' 🔄 FIFO' : '';
                                  const availableStock = b.current_stock - (b.reserved_stock || 0);
                                  return (
                                    <option key={b.id} value={b.id}>
                                      {b.batch_number} (Total: {b.current_stock}kg, Available: {availableStock}kg){fifoIndicator}
                                    </option>
                                  );
                                })}
                              </select>
                            ) : (
                              <div className="w-full px-2 py-1.5 text-sm border border-red-300 rounded bg-red-50 text-red-700 flex items-center gap-2">
                                <span>⚠</span>
                                <span>No batches available for this product</span>
                              </div>
                            )}
                          </div>
                        )}
                      </div>

                      {selectedBatch && (
                        <div className="p-2 bg-blue-50 border border-blue-200 rounded text-xs space-y-1">
                          <div className="flex justify-between">
                            <span className="text-gray-600">Batch:</span>
                            <span className="font-medium">{selectedBatch.batch_number}</span>
                          </div>
                          {selectedBatch.expiry_date && (
                            <div className="flex justify-between">
                              <span className="text-gray-600">Expiry:</span>
                              <span className="font-medium">{new Date(selectedBatch.expiry_date).toLocaleDateString()}</span>
                            </div>
                          )}
                          {selectedBatch.packaging_details && (
                            <div className="flex justify-between">
                              <span className="text-gray-600">Packaging:</span>
                              <span className="font-medium">{selectedBatch.packaging_details}</span>
                            </div>
                          )}
                          <div className="flex justify-between">
                            <span className="text-gray-600">Total Stock:</span>
                            <span className="font-medium">{selectedBatch.current_stock} kg</span>
                          </div>
                          {selectedBatch.reserved_stock > 0 && (
                            <div className="flex justify-between">
                              <span className="text-gray-600">Reserved:</span>
                              <span className="font-medium text-orange-600">{selectedBatch.reserved_stock} kg</span>
                            </div>
                          )}
                          <div className="flex justify-between border-t pt-1">
                            <span className="text-gray-600 font-semibold">Available:</span>
                            <span className="font-bold text-green-600">{selectedBatch.current_stock - (selectedBatch.reserved_stock || 0)} kg</span>
                          </div>
                        </div>
                      )}

                      {item.pack_size && (
                        <div className="grid grid-cols-3 gap-2">
                          <div>
                            <label className="block text-xs text-gray-600 mb-1">No. of Packs *</label>
                            <input
                              type="number"
                              value={item.number_of_packs || ''}
                              onChange={(e) => updatePackQuantity(index, Number(e.target.value))}
                              className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded focus:ring-2 focus:ring-blue-500"
                              required
                              min="1"
                            />
                          </div>
                          <div>
                            <label className="block text-xs text-gray-600 mb-1">Pack Size</label>
                            <input
                              type="text"
                              value={`${item.pack_size} kg`}
                              className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded bg-gray-100"
                              disabled
                            />
                          </div>
                          <div>
                            <label className="block text-xs text-gray-600 mb-1">Total Qty</label>
                            <input
                              type="text"
                              value={`${item.quantity} kg`}
                              className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded bg-gray-100"
                              disabled
                            />
                          </div>
                        </div>
                      )}

                      {items.length > 1 && (
                        <div className="flex justify-end">
                          <button
                            type="button"
                            onClick={() => removeItem(index)}
                            className="text-xs text-red-600 hover:text-red-700"
                          >
                            Remove Item
                          </button>
                        </div>
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
