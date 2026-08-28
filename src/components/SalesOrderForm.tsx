import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { useLanguage } from '../contexts/LanguageContext';
import { Plus, Trash2, X, FileText } from 'lucide-react';
import { SearchableSelect } from './SearchableSelect';
import { showToast } from './ToastNotification';
import { showConfirm } from './ConfirmDialog';
import { resolveStorageUrlCached } from '../utils/signedUrlCache';

interface Customer {
  id: string;
  company_name: string;
}

interface Product {
  id: string;
  product_name: string;
  product_code: string;
}

interface StockInfo {
  total_stock: number;
  reserved_stock: number;
  free_stock: number;
}

interface OrderItem {
  id?: string;
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
  quoted_usd_unit_price?: number | null;
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
  commercial_usd_to_idr_rate?: number | null;
  sales_order_items?: Array<{
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
    quoted_usd_unit_price?: number | null;
  }>;
}

interface SalesOrderFormProps {
  existingOrder?: SalesOrder;
  prefill?: {
    customer_id?: string;
    product_id?: string;
    product_name?: string;
    quantity?: number;
    unit_price?: number;
    quoted_usd_unit_price?: number | null;
    expected_delivery_date?: string;
    notes?: string;
    currency?: string;
    commercial_usd_to_idr_rate?: number | null;
    customer_po_number?: string;
    inquiry_id?: string;
  };
  onSuccess: () => void;
  onCancel: () => void;
}

export default function SalesOrderForm({ existingOrder, prefill, onSuccess, onCancel }: SalesOrderFormProps) {
  const { user } = useAuth();
  const { t } = useLanguage();
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [stockInfo, setStockInfo] = useState<Record<string, StockInfo>>({});
  const [loading, setLoading] = useState(false);

  const [formData, setFormData] = useState({
    customer_id: '',
    customer_po_number: '',
    customer_po_date: new Date().toISOString().split('T')[0],
    so_date: new Date().toISOString().split('T')[0],
    expected_delivery_date: '',
    notes: '',
    currency: 'IDR',
    commercial_usd_to_idr_rate: null as number | null,
  });

  const [poFile, setPoFile] = useState<File | null>(null);
  const [poFileSignedUrl, setPoFileSignedUrl] = useState<string | null>(null);
  const [items, setItems] = useState<OrderItem[]>([
    {
      product_id: '',
      quantity: 1,
      unit_price: 0,
      discount_percent: 0,
      discount_amount: 0,
      tax_percent: 0,
      tax_amount: 0,
      line_total: 0,
      item_delivery_date: '',
      notes: '',
    },
  ]);

  useEffect(() => {
    fetchCustomers();
    fetchProducts();
  }, []);

  useEffect(() => {
    if (existingOrder?.customer_po_file_url) {
      resolveStorageUrlCached(existingOrder.customer_po_file_url, 3600).then(setPoFileSignedUrl);
    } else {
      setPoFileSignedUrl(null);
    }
  }, [existingOrder?.customer_po_file_url]);

  useEffect(() => {
    if (existingOrder) {
      setFormData({
        customer_id: existingOrder.customer_id,
        customer_po_number: existingOrder.customer_po_number,
        customer_po_date: existingOrder.customer_po_date,
        so_date: existingOrder.so_date,
        expected_delivery_date: existingOrder.expected_delivery_date || '',
        notes: existingOrder.notes || '',
        currency: (existingOrder as any).currency || 'IDR',
        commercial_usd_to_idr_rate: existingOrder.commercial_usd_to_idr_rate ?? null,
      });

      if (existingOrder.sales_order_items && existingOrder.sales_order_items.length > 0) {
        const mappedItems: OrderItem[] = existingOrder.sales_order_items.map(item => ({
          id: item.id,
          product_id: item.product_id,
          quantity: item.quantity,
          unit_price: item.unit_price,
          discount_percent: item.discount_percent,
          discount_amount: item.discount_amount,
          tax_percent: item.tax_percent,
          tax_amount: item.tax_amount,
          line_total: item.line_total,
          item_delivery_date: item.item_delivery_date || '',
          notes: item.notes || '',
          quoted_usd_unit_price: item.quoted_usd_unit_price ?? null,
        }));
        setItems(mappedItems);

        mappedItems.forEach(item => {
          if (item.product_id) {
            fetchStockInfo(item.product_id);
          }
        });
      }
    } else if (prefill) {
      setFormData(prev => ({
        ...prev,
        customer_id: prefill.customer_id || '',
        customer_po_number: prefill.customer_po_number || '',
        expected_delivery_date: prefill.expected_delivery_date || '',
        notes: prefill.notes || '',
        currency: prefill.currency || 'IDR',
        commercial_usd_to_idr_rate: prefill.commercial_usd_to_idr_rate ?? null,
      }));
      const resolvedProductId = prefill.product_id || products.find(product => product.product_name.toLowerCase() === (prefill.product_name || '').toLowerCase())?.id;
      if (resolvedProductId) {
        const quantity = Number(prefill.quantity) || 1;
        const unitPrice = Number(prefill.unit_price) || 0;
        setItems([{ product_id: resolvedProductId, quantity, unit_price: unitPrice, discount_percent: 0, discount_amount: 0, tax_percent: 0, tax_amount: 0, line_total: quantity * unitPrice, item_delivery_date: prefill.expected_delivery_date || '', notes: '', quoted_usd_unit_price: prefill.quoted_usd_unit_price ?? null }]);
        fetchStockInfo(resolvedProductId);
      }
    }
  }, [existingOrder, prefill, products]);

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

  const fetchProducts = async () => {
    try {
      const { data, error } = await supabase
        .from('products')
        .select('id, product_name, product_code')
        .eq('is_active', true)
        .order('product_name');

      if (error) throw error;
      setProducts(data || []);
    } catch (error: any) {
      console.error('Error fetching products:', error.message);
    }
  };

  const fetchStockInfo = async (productId: string) => {
    try {
      const { data: batches, error } = await supabase
        .from('batches')
        .select('id, current_stock')
        .eq('product_id', productId);

      if (error) throw error;

      const totalStock = batches?.reduce((sum, b) => sum + Number(b.current_stock), 0) || 0;
      const { data: atp, error: atpError } = await supabase.rpc('product_available_to_promise', {
        p_product_id: productId,
        p_exclude_sales_order_item_id: null,
      });
      if (atpError) throw atpError;

      const freeStock = Number(atp || 0);
      const reservedStock = totalStock - freeStock;

      setStockInfo(prev => ({
        ...prev,
        [productId]: { total_stock: totalStock, reserved_stock: reservedStock, free_stock: freeStock }
      }));
    } catch (error: any) {
      console.error('Error fetching stock info:', error.message);
    }
  };

  const handleProductChange = (index: number, productId: string) => {
    const product = products.find(p => p.id === productId);
    if (!product) return;

    const newItems = [...items];
    newItems[index].product_id = productId;
    newItems[index].unit_price = 0;
    setItems(newItems);
    calculateLineTotal(index);
    fetchStockInfo(productId);
  };

  const calculateLineTotal = (index: number) => {
    const item = items[index];
    const subtotal = item.quantity * item.unit_price;
    const discountAmount = item.discount_percent > 0
      ? (subtotal * item.discount_percent) / 100
      : item.discount_amount;
    const afterDiscount = subtotal - discountAmount;
    const taxAmount = (afterDiscount * item.tax_percent) / 100;
    const lineTotal = afterDiscount + taxAmount;

    const newItems = [...items];
    newItems[index] = {
      ...item,
      discount_amount: discountAmount,
      tax_amount: taxAmount,
      line_total: lineTotal,
    };
    setItems(newItems);
  };

  const handleItemChange = (index: number, field: keyof OrderItem, value: any) => {
    const newItems = [...items];
    newItems[index] = { ...newItems[index], [field]: value };

    const item = newItems[index];
    const subtotal = item.quantity * item.unit_price;
    const discountAmount = item.discount_percent > 0
      ? (subtotal * item.discount_percent) / 100
      : item.discount_amount;
    const afterDiscount = subtotal - discountAmount;
    const taxAmount = (afterDiscount * item.tax_percent) / 100;
    const lineTotal = afterDiscount + taxAmount;

    newItems[index] = {
      ...item,
      discount_amount: discountAmount,
      tax_amount: taxAmount,
      line_total: lineTotal,
    };

    setItems(newItems);
  };

  const addItem = () => {
    setItems([
      ...items,
      {
        product_id: '',
        quantity: 1,
        unit_price: 0,
        discount_percent: 0,
        discount_amount: 0,
        tax_percent: 0,
        tax_amount: 0,
        line_total: 0,
        item_delivery_date: '',
        notes: '',
      },
    ]);
  };

  const removeItem = (index: number) => {
    if (items.length === 1) {
      showToast({ type: 'warning', title: 'Warning', message: 'At least one item is required' });
      return;
    }
    const newItems = items.filter((_, i) => i !== index);
    setItems(newItems);
  };

  const uploadPoFile = async () => {
    if (!poFile) return null;

    try {
      const fileExt = poFile.name.split('.').pop();
      const fileName = `${Date.now()}_${Math.random().toString(36).substring(7)}.${fileExt}`;
      const filePath = `customer-po/${fileName}`;

      const { data: uploadData, error: uploadError } = await supabase.storage
        .from('sales-order-documents')
        .upload(filePath, poFile, {
          cacheControl: '3600',
          upsert: false
        });

      if (uploadError) {
        console.error('Upload error:', uploadError);
        throw uploadError;
      }

      void uploadData;

      const { data: { publicUrl } } = supabase.storage
        .from('sales-order-documents')
        .getPublicUrl(filePath);

      return publicUrl;
    } catch (error: any) {
      console.error('Error uploading file:', error);
      showToast({ type: 'error', title: 'Error', message: `Failed to upload PO file: ${error.message || 'Unknown error'}` });
      throw error;
    }
  };

  const handleSubmit = async (e: React.FormEvent, submitForApproval: boolean = false) => {
    e.preventDefault();

    if (!formData.customer_id) {
      showToast({ type: 'error', title: 'Error', message: 'Please select a customer' });
      return;
    }

    if (!formData.customer_po_number.trim()) {
      showToast({ type: 'error', title: 'Error', message: 'Please enter customer PO number' });
      return;
    }

    if (items.length === 0 || items.some(item => !item.product_id || item.quantity <= 0)) {
      showToast({ type: 'error', title: 'Error', message: 'Please add valid items to the order' });
      return;
    }

    // Check if editing an approved/reserved order
    const wasApproved = existingOrder && [
      'approved',
      'stock_reserved',
      'shortage',
      'pending_delivery',
      'partially_delivered',
      'delivered',
      'closed',
      'rejected',
      'cancelled',
    ].includes(existingOrder.status);

    if (wasApproved && existingOrder) {
      // SO item IDs are the durable identity of reservation history. Keep an
      // already prepared DC and its source item together until it is reversed.
      const { data: activeChallan, error: challanError } = await supabase
        .from('delivery_challans')
        .select('challan_number')
        .eq('sales_order_id', existingOrder.id)
        .in('approval_status', ['pending_approval', 'approved'])
        .limit(1)
        .maybeSingle();

      if (challanError) {
        showToast({ type: 'error', title: 'Error', message: `Unable to verify linked Delivery Challans: ${challanError.message}` });
        return;
      }

      if (activeChallan) {
        showToast({
          type: 'error',
          title: 'Sales order cannot be edited',
          message: `Delivery Challan ${activeChallan.challan_number} is still pending or approved. Reject or cancel it before editing this order so its reservation history remains intact.`,
        });
        return;
      }

      const confirmed = await showConfirm({
        title: 'Confirm',
        message: 'Warning: This order has been approved or is awaiting approval.\n\nEditing will:\n- Release existing stock reservations\n- Require re-approval from admin\n- Reset status to "Pending Approval"\n\nDo you want to continue?',
        variant: 'warning',
      });

      if (!confirmed) return;

      const removedHistoricalItem = existingOrder.sales_order_items?.some(
        persisted => !items.some(item => item.id === persisted.id),
      );
      if (removedHistoricalItem) {
        showToast({
          type: 'error',
          title: 'Sales order item cannot be removed',
          message: 'An item with reservation history cannot be deleted. Adjust its quantity, or cancel/void the Sales Order to preserve the audit trail.',
        });
        return;
      }
    }

    try {
      setLoading(true);

      let poFileUrl = existingOrder?.customer_po_file_url || null;
      if (poFile) {
        poFileUrl = await uploadPoFile();
        if (!poFileUrl) {
          throw new Error('File upload returned no URL');
        }
      }

      const subtotal = items.reduce((sum, item) => sum + (item.quantity * item.unit_price - item.discount_amount), 0);
      const tax = items.reduce((sum, item) => sum + item.tax_amount, 0);
      const total = items.reduce((sum, item) => sum + item.line_total, 0);

      if (existingOrder) {
        // Release stock reservations if order was approved
        if (wasApproved) {
          const { error: releaseError } = await supabase.rpc('release_so_product_reservations_v2', {
            p_so_id: existingOrder.id,
            p_reason: 'Approved Sales Order edited and submitted for re-approval'
          });

          if (releaseError) {
            console.error('Error releasing reservations:', releaseError);
            throw new Error(`Unable to release the existing product reservation: ${releaseError.message}`);
          }
        }

        // Determine new status
        let newStatus: string;
        if (wasApproved || submitForApproval) {
          newStatus = 'pending_approval'; // Always require re-approval if it was approved before
        } else {
          newStatus = 'draft';
        }

        // Update existing order
        const { error: soError } = await supabase
          .from('sales_orders')
          .update({
            customer_id: formData.customer_id,
            customer_po_number: formData.customer_po_number,
            customer_po_date: formData.customer_po_date,
            customer_po_file_url: poFileUrl,
            so_date: formData.so_date,
            currency: formData.currency,
            commercial_usd_to_idr_rate: formData.commercial_usd_to_idr_rate || null,
            expected_delivery_date: formData.expected_delivery_date || null,
            notes: formData.notes || null,
            status: newStatus,
            subtotal_amount: subtotal,
            tax_amount: tax,
            total_amount: total,
            updated_at: new Date().toISOString(),
          })
          .eq('id', existingOrder.id);

        if (soError) throw soError;

        const itemValues = (item: OrderItem) => ({
          sales_order_id: existingOrder.id,
          product_id: item.product_id,
          quantity: item.quantity,
          unit_price: item.unit_price,
          discount_percent: item.discount_percent,
          discount_amount: item.discount_amount,
          tax_percent: item.tax_percent,
          tax_amount: item.tax_amount,
          line_total: item.line_total,
          item_delivery_date: item.item_delivery_date || null,
          notes: item.notes || null,
          quoted_usd_unit_price: item.quoted_usd_unit_price || null,
        });

        if (wasApproved) {
          for (const item of items.filter(item => item.id)) {
            const { error: itemError } = await supabase
              .from('sales_order_items')
              .update(itemValues(item))
              .eq('id', item.id!);
            if (itemError) throw itemError;
          }
          const newItems = items.filter(item => !item.id).map(itemValues);
          if (newItems.length > 0) {
            const { error: itemError } = await supabase.from('sales_order_items').insert(newItems);
            if (itemError) throw itemError;
          }
        } else {
          const { error: deleteError } = await supabase
            .from('sales_order_items')
            .delete()
            .eq('sales_order_id', existingOrder.id);
          if (deleteError) throw deleteError;

          const { data: insertedItems, error: itemsError } = await supabase
            .from('sales_order_items')
            .insert(items.map(itemValues))
            .select();
          if (itemsError) throw itemsError;
          if (insertedItems && insertedItems.length !== items.length) {
            throw new Error(`Expected ${items.length} items but only ${insertedItems.length} were saved.`);
          }
        }

        const statusMessage = wasApproved
          ? ' and submitted for re-approval. Stock reservations have been released.'
          : submitForApproval
            ? ' and submitted for approval'
            : '';

        showToast({ type: 'success', title: 'Success', message: `Sales order updated successfully${statusMessage}!` });
      } else {
        // Create new order
        const { data: soData, error: soError } = await supabase
          .from('sales_orders')
          .insert({
            so_number: '',
            customer_id: formData.customer_id,
            customer_po_number: formData.customer_po_number,
            customer_po_date: formData.customer_po_date,
            customer_po_file_url: poFileUrl,
            so_date: formData.so_date,
            currency: formData.currency,
            commercial_usd_to_idr_rate: formData.commercial_usd_to_idr_rate || null,
            expected_delivery_date: formData.expected_delivery_date || null,
            notes: formData.notes || null,
            status: submitForApproval ? 'pending_approval' : 'draft',
            subtotal_amount: subtotal,
            tax_amount: tax,
            total_amount: total,
            created_by: user?.id,
          })
          .select()
          .single();

        if (soError) throw soError;

        const itemsToInsert = items.map(item => ({
          sales_order_id: soData.id,
          product_id: item.product_id,
          quantity: item.quantity,
          unit_price: item.unit_price,
          discount_percent: item.discount_percent,
          discount_amount: item.discount_amount,
          tax_percent: item.tax_percent,
          tax_amount: item.tax_amount,
          line_total: item.line_total,
          item_delivery_date: item.item_delivery_date || null,
          notes: item.notes || null,
          quoted_usd_unit_price: item.quoted_usd_unit_price || null,
        }));

        const { error: itemsError } = await supabase
          .from('sales_order_items')
          .insert(itemsToInsert);

        if (itemsError) throw itemsError;

        if (prefill?.inquiry_id) {
          const { error: inquiryLinkError } = await supabase
            .from('crm_inquiries')
            .update({ converted_to_order: soData.id, pipeline_status: 'won' })
            .eq('id', prefill.inquiry_id);
          if (inquiryLinkError) console.warn('Sales order saved but CRM inquiry link could not be updated:', inquiryLinkError.message);
        }

        showToast({ type: 'success', title: 'Success', message: `Sales order created successfully${submitForApproval ? ' and submitted for approval' : ''}!` });
      }

      onSuccess();
    } catch (error: any) {
      console.error(existingOrder ? 'Error updating sales order:' : 'Error creating sales order:', error.message);
      showToast({ type: 'error', title: 'Error', message: (existingOrder ? 'Failed to update sales order: ' : 'Failed to create sales order: ') + error.message });
    } finally {
      setLoading(false);
    }
  };

  const getStockBadge = (productId: string, quantity: number) => {
    const stock = stockInfo[productId];
    if (!stock) return null;

    const hasEnough = stock.free_stock >= quantity;
    return (
      <div className={`text-xs ${hasEnough ? 'text-green-600' : 'text-red-600'}`}>
        {t('salesOrders.freeStock')}: {stock.free_stock} {!hasEnough && '(Insufficient!)'}
      </div>
    );
  };

  const subtotal = items.reduce((sum, item) => sum + (item.quantity * item.unit_price - item.discount_amount), 0);
  const totalTax = items.reduce((sum, item) => sum + item.tax_amount, 0);
  const grandTotal = items.reduce((sum, item) => sum + item.line_total, 0);

  const formatCurrency = (amount: number) => {
    if (formData.currency === 'USD') {
      return `$ ${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    }
    return `Rp ${amount.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };

  return (
    <form className="space-y-6">
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">{t('sales.customer')} *</label>
          <SearchableSelect
            value={formData.customer_id}
            onChange={(val) => setFormData({ ...formData, customer_id: val })}
            options={customers.map(c => ({ value: c.id, label: c.company_name }))}
            placeholder={`${t('common.filter')} ${t('sales.customer')}`}
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">{t('salesOrders.customerPoNumber')} *</label>
          <input
            type="text"
            value={formData.customer_po_number}
            onChange={(e) => setFormData({ ...formData, customer_po_number: e.target.value })}
            className="w-full border rounded-lg px-3 py-2"
            required
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">{t('salesOrders.customerPoDate')} *</label>
          <input
            type="date"
            value={formData.customer_po_date}
            onChange={(e) => setFormData({ ...formData, customer_po_date: e.target.value })}
            className="w-full border rounded-lg px-3 py-2"
            required
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">{t('salesOrders.soDate')}</label>
          <input
            type="date"
            value={formData.so_date}
            onChange={(e) => setFormData({ ...formData, so_date: e.target.value })}
            className="w-full border rounded-lg px-3 py-2"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Currency *</label>
          <select
            value={formData.currency}
            onChange={(e) => setFormData({ ...formData, currency: e.target.value })}
            className="w-full border rounded-lg px-3 py-2"
            required
          >
            <option value="IDR">IDR (Rp)</option>
            <option value="USD">USD ($)</option>
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">USD → IDR rate (historical, optional)</label>
          <input
            type="number"
            min="0"
            step="0.000001"
            value={formData.commercial_usd_to_idr_rate ?? ''}
            onChange={(e) => setFormData({ ...formData, commercial_usd_to_idr_rate: e.target.value === '' ? null : Number(e.target.value) })}
            className="w-full border rounded-lg px-3 py-2"
            placeholder={formData.currency === 'IDR' ? 'Required only when IDR derives from USD' : 'Not required for USD'}
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">{t('salesOrders.expectedDeliveryDate')}</label>
          <input
            type="date"
            value={formData.expected_delivery_date}
            onChange={(e) => setFormData({ ...formData, expected_delivery_date: e.target.value })}
            className="w-full border rounded-lg px-3 py-2"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">{t('salesOrders.uploadPo')}</label>
          {existingOrder?.customer_po_file_url && !poFile && (
            <div className="mb-2 p-2 bg-blue-50 border border-blue-200 rounded-lg flex items-center justify-between">
              <div className="flex items-center gap-2">
                <FileText className="w-4 h-4 text-blue-600" />
                <span className="text-sm text-blue-700">PO file already uploaded</span>
              </div>
              <a
                href={poFileSignedUrl || existingOrder.customer_po_file_url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-blue-600 hover:text-blue-800 underline"
              >
                View
              </a>
            </div>
          )}
          <div className="flex items-center gap-2">
            <input
              type="file"
              accept=".pdf,.jpg,.jpeg,.png"
              onChange={(e) => setPoFile(e.target.files?.[0] || null)}
              className="w-full border rounded-lg px-3 py-2"
            />
            {poFile && (
              <button
                type="button"
                onClick={() => setPoFile(null)}
                className="text-red-600 hover:text-red-800"
                title="Remove selected file"
              >
                <X className="w-5 h-5" />
              </button>
            )}
          </div>
          {poFile && (
            <p className="mt-1 text-sm text-green-600 flex items-center gap-1">
              <FileText className="w-4 h-4" />
              Ready to upload: {poFile.name}
            </p>
          )}
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">{t('salesOrders.notes')}</label>
        <textarea
          value={formData.notes}
          onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
          className="w-full border rounded-lg px-3 py-2"
          rows={2}
        />
      </div>

      <div>
        <div className="flex justify-between items-center mb-3">
          <label className="block text-sm font-medium text-gray-700">Order Items</label>
          <button
            type="button"
            onClick={addItem}
            className="flex items-center gap-1 text-blue-600 hover:text-blue-800 text-sm"
          >
            <Plus className="w-4 h-4" /> {t('sales.addItem')}
          </button>
        </div>

        <div className="space-y-3 max-h-96 overflow-y-auto">
          {items.map((item, index) => (
            <div key={index} className="border rounded-lg p-3 bg-gray-50">
              <div className="grid grid-cols-6 gap-2">
                <div className="col-span-2">
                  <label className="text-xs text-gray-600">{t('salesOrders.product')} *</label>
                  <SearchableSelect
                    value={item.product_id}
                    onChange={(value) => handleProductChange(index, value)}
                    options={products.map(product => ({
                      value: product.id,
                      label: `${product.product_name}${product.product_code ? ` (${product.product_code})` : ''}`,
                    }))}
                    placeholder="Search product..."
                    className="py-1 text-sm rounded"
                    required
                  />
                  {item.product_id && getStockBadge(item.product_id, item.quantity)}
                </div>

                <div>
                  <label className="text-xs text-gray-600">{t('sales.quantity')} *</label>
                  <input
                    type="text"
                    value={item.quantity === 0 ? '' : item.quantity}
                    onChange={(e) => {
                      const val = e.target.value;
                      if (val === '') {
                        handleItemChange(index, 'quantity', 0);
                      } else {
                        const num = parseFloat(val);
                        if (!isNaN(num)) {
                          handleItemChange(index, 'quantity', num);
                        }
                      }
                    }}
                    onBlur={(e) => {
                      if (e.target.value === '') {
                        handleItemChange(index, 'quantity', 0);
                      }
                    }}
                    className="w-full border rounded px-2 py-1 text-sm"
                    placeholder="Enter quantity"
                    required
                  />
                </div>

                <div>
                  <label className="text-xs text-gray-600">{t('sales.unitPrice')}</label>
                  <input
                    type="text"
                    value={item.unit_price === 0 ? '' : item.unit_price}
                    onChange={(e) => {
                      const val = e.target.value;
                      if (val === '') {
                        handleItemChange(index, 'unit_price', 0);
                      } else {
                        const num = parseFloat(val);
                        if (!isNaN(num)) {
                          handleItemChange(index, 'unit_price', num);
                        }
                      }
                    }}
                    onBlur={(e) => {
                      if (e.target.value === '') {
                        handleItemChange(index, 'unit_price', 0);
                      }
                    }}
                    className="w-full border rounded px-2 py-1 text-sm"
                    placeholder="Enter price"
                  />
                </div>

                <div>
                  <label className="text-xs text-gray-600">Quoted USD / unit (optional)</label>
                  <input
                    type="number"
                    min="0"
                    step="0.000001"
                    value={item.quoted_usd_unit_price ?? ''}
                    onChange={(e) => handleItemChange(index, 'quoted_usd_unit_price', e.target.value === '' ? null : Number(e.target.value))}
                    className="w-full border rounded px-2 py-1 text-sm"
                    placeholder="USD basis"
                  />
                </div>

                <div>
                  <label className="text-xs text-gray-600">{t('salesOrders.discountPercent')}</label>
                  <input
                    type="text"
                    value={item.discount_percent === 0 ? '' : item.discount_percent}
                    onChange={(e) => {
                      const val = e.target.value;
                      if (val === '') {
                        handleItemChange(index, 'discount_percent', 0);
                      } else {
                        const num = parseFloat(val);
                        if (!isNaN(num) && num >= 0 && num <= 100) {
                          handleItemChange(index, 'discount_percent', num);
                        }
                      }
                    }}
                    onBlur={(e) => {
                      if (e.target.value === '') {
                        handleItemChange(index, 'discount_percent', 0);
                      }
                    }}
                    className="w-full border rounded px-2 py-1 text-sm"
                    placeholder="0"
                  />
                </div>

                <div>
                  <label className="text-xs text-gray-600">{t('salesOrders.taxPercent')}</label>
                  <input
                    type="text"
                    value={item.tax_percent === 0 ? '' : item.tax_percent}
                    onChange={(e) => {
                      const val = e.target.value;
                      if (val === '') {
                        handleItemChange(index, 'tax_percent', 0);
                      } else {
                        const num = parseFloat(val);
                        if (!isNaN(num) && num >= 0 && num <= 100) {
                          handleItemChange(index, 'tax_percent', num);
                        }
                      }
                    }}
                    onBlur={(e) => {
                      if (e.target.value === '') {
                        handleItemChange(index, 'tax_percent', 0);
                      }
                    }}
                    className="w-full border rounded px-2 py-1 text-sm"
                    placeholder="0"
                  />
                </div>
              </div>

              <div className="grid grid-cols-6 gap-2 mt-2">
                <div className="col-span-2">
                  <label className="text-xs text-gray-600">Item Delivery Date</label>
                  <input
                    type="date"
                    value={item.item_delivery_date}
                    onChange={(e) => handleItemChange(index, 'item_delivery_date', e.target.value)}
                    className="w-full border rounded px-2 py-1 text-sm"
                  />
                </div>

                <div className="col-span-3">
                  <label className="text-xs text-gray-600">Notes</label>
                  <input
                    type="text"
                    value={item.notes}
                    onChange={(e) => handleItemChange(index, 'notes', e.target.value)}
                    className="w-full border rounded px-2 py-1 text-sm"
                  />
                </div>

                <div className="flex items-end justify-between">
                  <div>
                    <label className="text-xs text-gray-600">{t('salesOrders.lineTotal')}</label>
                    <div className="text-sm font-medium">{formatCurrency(item.line_total)}</div>
                  </div>
                  <button
                    type="button"
                    onClick={() => removeItem(index)}
                    className="text-red-600 hover:text-red-800"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="bg-gray-50 p-4 rounded-lg">
        <div className="space-y-2">
          <div className="flex justify-between text-sm">
            <span>{t('sales.subtotal')}:</span>
            <span className="font-medium">{formatCurrency(subtotal)}</span>
          </div>
          <div className="flex justify-between text-sm">
            <span>{t('sales.tax')}:</span>
            <span className="font-medium">{formatCurrency(totalTax)}</span>
          </div>
          <div className="flex justify-between text-lg font-bold border-t pt-2">
            <span>{t('salesOrders.grandTotal')}:</span>
            <span>{formatCurrency(grandTotal)}</span>
          </div>
        </div>
      </div>

      <div className="flex justify-end gap-3">
        <button
          type="button"
          onClick={onCancel}
          className="px-4 py-2 border rounded-lg hover:bg-gray-50"
          disabled={loading}
        >
          {t('common.cancel')}
        </button>
        {/* Hide Save as Draft button if editing an approved/pending order */}
        {!(existingOrder && ['approved', 'stock_reserved', 'shortage', 'pending_approval'].includes(existingOrder.status)) && (
          <button
            type="button"
            onClick={(e) => handleSubmit(e, false)}
            className="px-4 py-2 bg-gray-600 text-white rounded-lg hover:bg-gray-700"
            disabled={loading}
          >
            {loading ? t('common.loading') : t('salesOrders.saveAsDraft')}
          </button>
        )}
        <button
          type="button"
          onClick={(e) => handleSubmit(e, true)}
          className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
          disabled={loading}
        >
          {loading
            ? `${t('common.submit')}...`
            : existingOrder && ['approved', 'stock_reserved', 'shortage', 'pending_approval'].includes(existingOrder.status)
              ? 'Submit for Re-Approval'
              : t('salesOrders.submitForApproval')}
        </button>
      </div>
    </form>
  );
}
