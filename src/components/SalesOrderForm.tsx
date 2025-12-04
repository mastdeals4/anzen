import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { useLanguage } from '../contexts/LanguageContext';
import { Plus, Trash2, Upload, X, AlertCircle } from 'lucide-react';

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
  }>;
}

interface SalesOrderFormProps {
  existingOrder?: SalesOrder;
  onSuccess: () => void;
  onCancel: () => void;
}

export default function SalesOrderForm({ existingOrder, onSuccess, onCancel }: SalesOrderFormProps) {
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
  });

  const [poFile, setPoFile] = useState<File | null>(null);
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
    if (existingOrder) {
      setFormData({
        customer_id: existingOrder.customer_id,
        customer_po_number: existingOrder.customer_po_number,
        customer_po_date: existingOrder.customer_po_date,
        so_date: existingOrder.so_date,
        expected_delivery_date: existingOrder.expected_delivery_date || '',
        notes: existingOrder.notes || '',
        currency: (existingOrder as any).currency || 'IDR',
      });

      if (existingOrder.sales_order_items && existingOrder.sales_order_items.length > 0) {
        const mappedItems: OrderItem[] = existingOrder.sales_order_items.map(item => ({
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
        }));
        setItems(mappedItems);

        mappedItems.forEach(item => {
          if (item.product_id) {
            fetchStockInfo(item.product_id);
          }
        });
      }
    }
  }, [existingOrder]);

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

      const { data: reservations } = await supabase
        .from('stock_reservations')
        .select('reserved_quantity')
        .eq('product_id', productId)
        .eq('status', 'active');

      const reservedStock = reservations?.reduce((sum, r) => sum + Number(r.reserved_quantity), 0) || 0;
      const freeStock = totalStock - reservedStock;

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
      alert('At least one item is required');
      return;
    }
    console.log('Removing item at index:', index, 'Current items count:', items.length);
    const newItems = items.filter((_, i) => i !== index);
    console.log('New items count after removal:', newItems.length);
    setItems(newItems);
  };

  const uploadPoFile = async () => {
    if (!poFile) return null;

    try {
      console.log('Starting file upload:', poFile.name);
      const fileExt = poFile.name.split('.').pop();
      const fileName = `${Date.now()}_${Math.random().toString(36).substring(7)}.${fileExt}`;
      const filePath = `customer-po/${fileName}`;

      console.log('Uploading to path:', filePath);

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

      console.log('File uploaded successfully:', uploadData);

      const { data: { publicUrl } } = supabase.storage
        .from('sales-order-documents')
        .getPublicUrl(filePath);

      console.log('Public URL generated:', publicUrl);

      return publicUrl;
    } catch (error: any) {
      console.error('Error uploading file:', error);
      alert(`Failed to upload PO file: ${error.message || 'Unknown error'}`);
      throw error;
    }
  };

  const handleSubmit = async (e: React.FormEvent, submitForApproval: boolean = false) => {
    e.preventDefault();

    if (!formData.customer_id) {
      alert('Please select a customer');
      return;
    }

    if (!formData.customer_po_number.trim()) {
      alert('Please enter customer PO number');
      return;
    }

    if (items.length === 0 || items.some(item => !item.product_id || item.quantity <= 0)) {
      alert('Please add valid items to the order');
      return;
    }

    // Check if editing an approved/reserved order
    const wasApproved = existingOrder && ['approved', 'stock_reserved', 'shortage', 'pending_approval'].includes(existingOrder.status);

    if (wasApproved && existingOrder) {
      const confirmed = confirm(
        '⚠️ Warning: This order has been approved or is awaiting approval.\n\n' +
        'Editing will:\n' +
        '• Release existing stock reservations\n' +
        '• Require re-approval from admin\n' +
        '• Reset status to "Pending Approval"\n\n' +
        'Do you want to continue?'
      );

      if (!confirmed) return;
    }

    try {
      setLoading(true);

      let poFileUrl = existingOrder?.customer_po_file_url || null;
      if (poFile) {
        console.log('Uploading PO file...');
        poFileUrl = await uploadPoFile();
        console.log('PO file URL:', poFileUrl);
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
          console.log('Releasing stock reservations for order:', existingOrder.id);
          const { error: releaseError } = await supabase.rpc('fn_release_reservation_by_so_id', {
            p_so_id: existingOrder.id,
            p_released_by: user?.id
          });

          if (releaseError) {
            console.error('Error releasing reservations:', releaseError);
            // Continue anyway - we'll show a warning but allow the update
          }
        }

        // Determine new status
        let newStatus: string;
        if (wasApproved || submitForApproval) {
          newStatus = 'pending_approval'; // Always require re-approval if it was approved before
        } else {
          newStatus = 'draft';
        }

        console.log('Updating order. Items count:', items.length);

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

        // Delete old items
        const { error: deleteError } = await supabase
          .from('sales_order_items')
          .delete()
          .eq('sales_order_id', existingOrder.id);

        if (deleteError) throw deleteError;

        // Insert new items
        const itemsToInsert = items.map(item => ({
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
        }));

        console.log('Inserting items. Count:', itemsToInsert.length);

        const { data: insertedItems, error: itemsError } = await supabase
          .from('sales_order_items')
          .insert(itemsToInsert)
          .select();

        if (itemsError) throw itemsError;

        console.log('Items inserted successfully. Count:', insertedItems?.length || 0);

        // Verify all items were inserted
        if (insertedItems && insertedItems.length !== items.length) {
          console.error('WARNING: Item count mismatch!', {
            expected: items.length,
            inserted: insertedItems.length
          });
          alert(`⚠️ Warning: Expected ${items.length} items but only ${insertedItems.length} were saved. Please verify the order.`);
        }

        const statusMessage = wasApproved
          ? ' and submitted for re-approval. Stock reservations have been released.'
          : submitForApproval
            ? ' and submitted for approval'
            : '';

        alert(`Sales order updated successfully${statusMessage}!`);
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
        }));

        const { error: itemsError } = await supabase
          .from('sales_order_items')
          .insert(itemsToInsert);

        if (itemsError) throw itemsError;

        alert(`Sales order created successfully${submitForApproval ? ' and submitted for approval' : ''}!`);
      }

      onSuccess();
    } catch (error: any) {
      console.error(existingOrder ? 'Error updating sales order:' : 'Error creating sales order:', error.message);
      alert((existingOrder ? 'Failed to update sales order: ' : 'Failed to create sales order: ') + error.message);
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
    const formatted = amount.toLocaleString('id-ID', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
    return formData.currency === 'USD' ? `$ ${formatted}` : `Rp ${formatted}`;
  };

  return (
    <form className="space-y-6">
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">{t('sales.customer')} *</label>
          <select
            value={formData.customer_id}
            onChange={(e) => setFormData({ ...formData, customer_id: e.target.value })}
            className="w-full border rounded-lg px-3 py-2"
            required
          >
            <option value="">{t('common.filter')} {t('sales.customer')}</option>
            {customers.map(customer => (
              <option key={customer.id} value={customer.id}>
                {customer.company_name}
              </option>
            ))}
          </select>
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
                href={existingOrder.customer_po_file_url}
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
                  <select
                    value={item.product_id}
                    onChange={(e) => handleProductChange(index, e.target.value)}
                    className="w-full border rounded px-2 py-1 text-sm"
                    required
                  >
                    <option value="">Select Product</option>
                    {products.map(product => (
                      <option key={product.id} value={product.id}>
                        {product.product_name}
                      </option>
                    ))}
                  </select>
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
