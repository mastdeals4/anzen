import { useEffect, useState } from 'react';
import { Layout } from '../components/Layout';
import { DataTable } from '../components/DataTable';
import { Modal } from '../components/Modal';
import { InvoiceView } from '../components/InvoiceView';
import { useLanguage } from '../contexts/LanguageContext';
import { useAuth } from '../contexts/AuthContext';
import { useNavigation } from '../contexts/NavigationContext';
import { supabase } from '../lib/supabase';
import { Plus, Edit, Trash2, FileText, Eye } from 'lucide-react';

interface SalesInvoice {
  id: string;
  invoice_number: string;
  customer_id: string;
  invoice_date: string;
  due_date: string;
  subtotal: number;
  tax_amount: number;
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
  customers?: {
    company_name: string;
    gst_vat_type: string;
  };
}

interface InvoiceItem {
  id?: string;
  product_id: string;
  batch_id: string | null;
  quantity: number;
  unit_price: number;
  tax_rate: number;
  total: number;
  products?: {
    product_name: string;
    product_code: string;
  };
  batches?: {
    batch_number: string;
  } | null;
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
  const { navigationData, clearNavigationData } = useNavigation();
  const [invoices, setInvoices] = useState<SalesInvoice[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [pendingChallans, setPendingChallans] = useState<DeliveryChallan[]>([]);
  const [selectedChallanId, setSelectedChallanId] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [viewModalOpen, setViewModalOpen] = useState(false);
  const [editingInvoice, setEditingInvoice] = useState<SalesInvoice | null>(null);
  const [selectedInvoice, setSelectedInvoice] = useState<SalesInvoice | null>(null);
  const [invoiceItems, setInvoiceItems] = useState<InvoiceItem[]>([]);
  const [formData, setFormData] = useState({
    invoice_number: '',
    customer_id: '',
    invoice_date: new Date().toISOString().split('T')[0],
    payment_terms: '30',
    discount: 0,
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
  }, []);

  useEffect(() => {
    if (navigationData?.sourceType === 'delivery_challan') {
      handleDeliveryChallanData(navigationData);
      clearNavigationData();
    }
  }, [navigationData]);

  const loadInvoices = async () => {
    try {
      const { data, error } = await supabase
        .from('sales_invoices')
        .select('*, customers(company_name, address, city, phone, npwp, pharmacy_license, gst_vat_type)')
        .order('invoice_date', { ascending: false });

      if (error) throw error;

      // Calculate paid amount and balance for each invoice
      const invoicesWithPayments = await Promise.all((data || []).map(async (inv) => {
        const { data: paidData } = await supabase
          .rpc('get_invoice_paid_amount', { p_invoice_id: inv.id });

        const paidAmount = paidData || 0;
        const balance = inv.total_amount - paidAmount;

        return {
          ...inv,
          paid_amount: paidAmount,
          balance_amount: balance
        };
      }));

      setInvoices(invoicesWithPayments);
    } catch (error) {
      console.error('Error loading invoices:', error);
    } finally {
      setLoading(false);
    }
  };

  const generateNextInvoiceNumber = async () => {
    try {
      // Get settings for invoice prefix
      const { data: settings } = await supabase
        .from('app_settings')
        .select('invoice_prefix, invoice_start_number')
        .maybeSingle();

      const prefix = settings?.invoice_prefix || 'SAPJ';
      const startNumber = settings?.invoice_start_number || 1;

      // Get all invoice numbers with this prefix to find the highest number
      const { data: allInvoices } = await supabase
        .from('sales_invoices')
        .select('invoice_number')
        .like('invoice_number', `${prefix}%`);

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
      return `${prefix}-${paddedNumber}`;
    } catch (error) {
      console.error('Error generating invoice number:', error);
      return 'SAPJ-001';
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
        alert('Error: Selected delivery challan not found. Please refresh and try again.');
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
        alert('This delivery challan has no items. Please add items manually.');
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
        alert('Could not load items from delivery challan. Please add items manually.');
        return;
      }

      setItems(invoiceItems);
    } catch (error: any) {
      console.error('Error loading challan items:', error);
      alert(`Failed to load delivery challan items: ${error.message || 'Unknown error'}. Please try again or add items manually.`);
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
      const { data, error } = await supabase
        .from('sales_invoice_items')
        .select('*, products(product_name, product_code, unit), batches(batch_number, expiry_date)')
        .eq('invoice_id', invoiceId);

      if (error) throw error;
      setInvoiceItems(data || []);
      return data || [];
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
    const total = subtotal + taxAmount - formData.discount;
    return { subtotal, taxAmount, total };
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const totals = calculateTotals();

      // Calculate due date based on payment terms
      const invoiceDate = new Date(formData.invoice_date);
      let dueDate = new Date(invoiceDate);
      let paymentTermsDays = 30;

      if (formData.payment_terms === 'advance' || formData.payment_terms === '50-50') {
        paymentTermsDays = 0;
      } else {
        paymentTermsDays = parseInt(formData.payment_terms);
        if (!isNaN(paymentTermsDays)) {
          dueDate.setDate(dueDate.getDate() + paymentTermsDays);
        }
      }

      let invoice;

      if (editingInvoice) {
        // Delete old items - the database trigger will automatically restore stock
        const { error: deleteItemsError } = await supabase
          .from('sales_invoice_items')
          .delete()
          .eq('invoice_id', editingInvoice.id);

        if (deleteItemsError) throw deleteItemsError;

        const { data: updatedInvoice, error: updateError } = await supabase
          .from('sales_invoices')
          .update({
            invoice_number: formData.invoice_number,
            customer_id: formData.customer_id,
            invoice_date: formData.invoice_date,
            due_date: dueDate.toISOString().split('T')[0],
            discount_amount: formData.discount,
            delivery_challan_number: formData.delivery_challan_number || null,
            po_number: formData.po_number || null,
            payment_terms_days: paymentTermsDays,
            notes: formData.notes || null,
            subtotal: totals.subtotal,
            tax_amount: totals.taxAmount,
            total_amount: totals.total,
            linked_challan_ids: selectedChallanId ? [selectedChallanId] : null,
          })
          .eq('id', editingInvoice.id)
          .select()
          .single();

        if (updateError) throw updateError;
        invoice = updatedInvoice;
      } else {
        const { data: newInvoice, error: invoiceError } = await supabase
          .from('sales_invoices')
          .insert([{
            invoice_number: formData.invoice_number,
            customer_id: formData.customer_id,
            invoice_date: formData.invoice_date,
            due_date: dueDate.toISOString().split('T')[0],
            discount_amount: formData.discount,
            delivery_challan_number: formData.delivery_challan_number || null,
            po_number: formData.po_number || null,
            payment_terms_days: paymentTermsDays,
            notes: formData.notes || null,
            subtotal: totals.subtotal,
            tax_amount: totals.taxAmount,
            total_amount: totals.total,
            payment_status: 'pending',
            created_by: user.id,
            linked_challan_ids: selectedChallanId ? [selectedChallanId] : null,
          }])
          .select()
          .single();

        if (invoiceError) throw invoiceError;
        invoice = newInvoice;
      }

      const invoiceItemsData = items.map(item => ({
        invoice_id: invoice.id,
        product_id: item.product_id,
        batch_id: item.batch_id,
        quantity: item.quantity,
        unit_price: item.unit_price,
        tax_rate: item.tax_rate,
      }));

      const { error: itemsError } = await supabase
        .from('sales_invoice_items')
        .insert(invoiceItemsData);

      if (itemsError) throw itemsError;

      // Stock deduction and inventory transactions are handled automatically by database trigger

      await loadInvoices();
      await loadBatches();
      setModalOpen(false);
      resetForm();
    } catch (error: any) {
      console.error('Error saving invoice:', error);
      alert(`Failed to save invoice: ${error.message || 'Unknown error'}. Please check console for details.`);
    }
  };

  const handleView = async (invoice: SalesInvoice) => {
    setSelectedInvoice(invoice);
    const items = await loadInvoiceItems(invoice.id);
    setViewModalOpen(true);
  };

  const handleEdit = async (invoice: SalesInvoice) => {
    setEditingInvoice(invoice);
    setFormData({
      invoice_number: invoice.invoice_number,
      customer_id: invoice.customer_id,
      invoice_date: invoice.invoice_date,
      payment_terms: String(invoice.payment_terms_days || 30),
      discount: invoice.discount_amount,
      delivery_challan_number: invoice.delivery_challan_number || '',
      po_number: invoice.po_number || '',
      notes: invoice.notes || '',
    });

    const loadedItems = await loadInvoiceItems(invoice.id);

    if (loadedItems.length > 0) {
      setItems(loadedItems.map(item => ({
        product_id: item.product_id,
        batch_id: item.batch_id,
        quantity: item.quantity,
        unit_price: item.unit_price,
        tax_rate: item.tax_rate,
        total: item.total,
      })));
    }

    setModalOpen(true);
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Are you sure you want to delete this invoice?')) return;

    try {
      const { error } = await supabase
        .from('sales_invoices')
        .delete()
        .eq('id', id);

      if (error) throw error;
      loadInvoices();
    } catch (error) {
      console.error('Error deleting invoice:', error);
      alert('Failed to delete invoice. Please try again.');
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
      alert('Failed to update payment status.');
    }
  };

  const resetForm = () => {
    setEditingInvoice(null);
    setSelectedChallanId('');
    setPendingChallans([]);
    setFormData({
      invoice_number: '',
      customer_id: '',
      invoice_date: new Date().toISOString().split('T')[0],
      payment_terms: '30',
      discount: 0,
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
    { key: 'invoice_number', label: 'Invoice #' },
    {
      key: 'customer',
      label: 'Customer',
      render: (inv: SalesInvoice) => (
        <div className="font-medium">{inv.customers?.company_name}</div>
      )
    },
    {
      key: 'invoice_date',
      label: 'Date',
      render: (inv: SalesInvoice) => new Date(inv.invoice_date).toLocaleDateString()
    },
    {
      key: 'total_amount',
      label: 'Total Amount',
      render: (inv: SalesInvoice) => (
        <span className="font-medium">Rp {inv.total_amount.toLocaleString('id-ID')}</span>
      )
    },
    {
      key: 'paid_amount',
      label: 'Paid Amount',
      render: (inv: SalesInvoice) => (
        <span className="text-green-600 font-medium">
          Rp {(inv.paid_amount || 0).toLocaleString('id-ID')}
        </span>
      )
    },
    {
      key: 'balance_amount',
      label: 'Balance',
      render: (inv: SalesInvoice) => (
        <span className={`font-medium ${
          (inv.balance_amount || 0) === 0 ? 'text-gray-400' : 'text-orange-600'
        }`}>
          Rp {(inv.balance_amount || 0).toLocaleString('id-ID')}
        </span>
      )
    },
    {
      key: 'payment_status',
      label: 'Payment Status',
      render: (inv: SalesInvoice) => (
        <span className={`inline-block px-2 py-1 rounded-full text-xs font-medium ${
          inv.payment_status === 'paid' ? 'bg-green-100 text-green-800' :
          inv.payment_status === 'partial' ? 'bg-yellow-100 text-yellow-800' :
          'bg-red-100 text-red-800'
        }`}>
          {inv.payment_status === 'pending' ? 'Unpaid' :
           inv.payment_status === 'partial' ? 'Partially Paid' : 'Paid'}
        </span>
      )
    },
  ];

  const canManage = profile?.role === 'admin' || profile?.role === 'accounts' || profile?.role === 'sales';

  const stats = {
    total: invoices.length,
    totalRevenue: invoices.reduce((sum, inv) => sum + inv.total_amount, 0),
    pending: invoices.filter(inv => inv.payment_status === 'pending').length,
    paid: invoices.filter(inv => inv.payment_status === 'paid').length,
  };

  return (
    <Layout>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-gray-900">Sales Invoices</h1>
            <p className="text-gray-600 mt-1">Manage sales invoices and track payments</p>
          </div>
          {canManage && (
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
              Create Invoice
            </button>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div className="bg-white rounded-lg shadow p-6">
            <p className="text-sm text-gray-600">Total Invoices</p>
            <p className="text-2xl font-bold text-gray-900 mt-1">{stats.total}</p>
          </div>
          <div className="bg-blue-50 rounded-lg shadow p-6">
            <p className="text-sm text-blue-600">Total Revenue</p>
            <p className="text-2xl font-bold text-blue-600 mt-1">Rp {stats.totalRevenue.toLocaleString('id-ID')}</p>
          </div>
          <div className="bg-red-50 rounded-lg shadow p-6">
            <p className="text-sm text-red-600">Pending Payment</p>
            <p className="text-2xl font-bold text-red-600 mt-1">{stats.pending}</p>
          </div>
          <div className="bg-green-50 rounded-lg shadow p-6">
            <p className="text-sm text-green-600">Paid</p>
            <p className="text-2xl font-bold text-green-600 mt-1">{stats.paid}</p>
          </div>
        </div>

        <DataTable
          columns={columns}
          data={invoices}
          loading={loading}
          actions={canManage ? (invoice) => (
            <div className="flex items-center gap-2">
              <button
                onClick={() => handleView(invoice)}
                className="p-1 text-blue-600 hover:bg-blue-50 rounded"
                title="View Invoice"
              >
                <Eye className="w-4 h-4" />
              </button>
              <button
                onClick={() => handleEdit(invoice)}
                className="p-1 text-green-600 hover:bg-green-50 rounded"
                title="Edit Invoice"
              >
                <Edit className="w-4 h-4" />
              </button>
              <button
                onClick={() => handleDelete(invoice.id)}
                className="p-1 text-red-600 hover:bg-red-50 rounded"
                title="Delete Invoice"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          ) : undefined}
        />

        <Modal
          isOpen={modalOpen}
          onClose={() => {
            setModalOpen(false);
            resetForm();
          }}
          title={editingInvoice ? "Edit Sales Invoice" : "Create Sales Invoice"}
          size="xl"
        >
          <form onSubmit={handleSubmit} className="space-y-6">
            <div className="bg-gray-50 p-4 rounded-lg border border-gray-200">
              <h4 className="text-sm font-semibold text-gray-900 mb-4">Invoice Details</h4>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Invoice Number *
                  </label>
                  <input
                    type="text"
                    value={formData.invoice_number}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg bg-gray-100 cursor-not-allowed"
                    required
                    placeholder="INV-001"
                    readOnly
                    disabled
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Invoice Date *
                  </label>
                  <input
                    type="date"
                    value={formData.invoice_date}
                    onChange={(e) => setFormData({ ...formData, invoice_date: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                    required
                  />
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-6">
              <div className="border-r border-gray-200 pr-6">
                <h4 className="text-sm font-semibold text-gray-900 mb-4">Customer Information</h4>
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Customer *
                    </label>
                    <select
                      value={formData.customer_id}
                      onChange={(e) => {
                        const customerId = e.target.value;
                        setFormData({ ...formData, customer_id: customerId });
                        setSelectedChallanId('');
                        setPendingChallans([]);
                        if (customerId) {
                          loadPendingChallans(customerId);
                        }
                      }}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                      required
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
                      Select Delivery Challan (Optional)
                    </label>
                    <select
                      value={selectedChallanId}
                      onChange={(e) => handleChallanSelect(e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                      disabled={!formData.customer_id}
                    >
                      <option value="">No Delivery Challan / Manual Entry</option>
                      {pendingChallans.map((challan) => (
                        <option key={challan.id} value={challan.id}>
                          {challan.challan_number} - {new Date(challan.challan_date).toLocaleDateString()}
                        </option>
                      ))}
                    </select>
                    {formData.customer_id && pendingChallans.length === 0 && (
                      <p className="text-xs text-gray-500 mt-1">No pending delivery challans for this customer</p>
                    )}
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Notes
                    </label>
                    <textarea
                      value={formData.notes}
                      onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                      rows={3}
                      placeholder="Additional notes for invoice"
                    />
                  </div>
                </div>
              </div>

              <div className="pl-6">
                <h4 className="text-sm font-semibold text-gray-900 mb-4">Payment Terms</h4>
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Payment Terms *
                    </label>
                    <select
                      value={formData.payment_terms}
                      onChange={(e) => setFormData({ ...formData, payment_terms: e.target.value })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
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

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      PO Number
                    </label>
                    <input
                      type="text"
                      value={formData.po_number}
                      onChange={(e) => setFormData({ ...formData, po_number: e.target.value })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                      placeholder="Customer PO Number"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Discount (Rp)
                    </label>
                    <input
                      type="number"
                      value={formData.discount === 0 ? '' : formData.discount}
                      onChange={(e) => setFormData({ ...formData, discount: e.target.value === '' ? 0 : Number(e.target.value) })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                      min="0"
                      placeholder="0"
                    />
                  </div>
                </div>
              </div>
            </div>

            <div className="border-t pt-6">
              <div className="flex items-center justify-between mb-4">
                <h4 className="text-sm font-semibold text-gray-900">Line Items</h4>
                <button
                  type="button"
                  onClick={addItem}
                  className="text-sm text-blue-600 hover:text-blue-700 font-medium"
                >
                  + Add Item
                </button>
              </div>

              <div className="space-y-3">
                {items.map((item, index) => {
                  const availableBatches = batches.filter(b => b.product_id === item.product_id);
                  const costPerUnit = getBatchCostPerUnit(item.batch_id);
                  const margin = calculateMargin(item.unit_price, costPerUnit);
                  const suggestedPrice = getSuggestedPrice(item.batch_id);

                  return (
                    <div key={index} className="p-3 bg-gray-50 rounded-lg space-y-2">
                      <div className="grid grid-cols-12 gap-2 items-end">
                        <div className="col-span-3">
                          <label className="block text-xs text-gray-600 mb-1">Product *</label>
                          <select
                            value={item.product_id}
                            onChange={(e) => updateItemTotal(index, { ...item, product_id: e.target.value, batch_id: null })}
                            className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded focus:ring-2 focus:ring-blue-500"
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
                            disabled={!item.product_id || selectedChallanId !== ''}
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
                          min="1"
                          placeholder="1"
                        />
                      </div>

                      <div className="col-span-2">
                        <label className="block text-xs text-gray-600 mb-1">Unit Price *</label>
                        <input
                          type="number"
                          value={item.unit_price === 0 ? '' : item.unit_price}
                          onChange={(e) => updateItemTotal(index, { ...item, unit_price: e.target.value === '' ? 0 : Number(e.target.value) })}
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

                      {item.batch_id && costPerUnit > 0 && (
                        <div className="flex items-center gap-4 text-xs p-2 bg-white rounded border border-gray-200">
                          <div className="flex items-center gap-2">
                            <span className="text-gray-600">Cost/Unit:</span>
                            <span className="font-semibold text-gray-900">Rp {costPerUnit.toLocaleString('id-ID', { maximumFractionDigits: 0 })}</span>
                          </div>
                          <div className="h-4 w-px bg-gray-300" />
                          <div className="flex items-center gap-2">
                            <span className="text-gray-600">Suggested Price (25%):</span>
                            <span className="font-semibold text-blue-600">Rp {suggestedPrice.toLocaleString('id-ID')}</span>
                          </div>
                          <div className="h-4 w-px bg-gray-300" />
                          <div className="flex items-center gap-2">
                            <span className="text-gray-600">Current Margin:</span>
                            <span className={`font-semibold ${
                              margin >= 20 ? 'text-green-600' :
                              margin >= 10 ? 'text-yellow-600' :
                              'text-red-600'
                            }`}>
                              {margin.toFixed(1)}%
                            </span>
                          </div>
                          <div className="h-4 w-px bg-gray-300" />
                          <div className="flex items-center gap-2">
                            <span className="text-gray-600">Profit/Unit:</span>
                            <span className={`font-semibold ${
                              item.unit_price > costPerUnit ? 'text-green-600' : 'text-red-600'
                            }`}>
                              Rp {(item.unit_price - costPerUnit).toLocaleString('id-ID', { maximumFractionDigits: 0 })}
                            </span>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              <div className="mt-4 p-4 bg-blue-50 rounded-lg">
                <div className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span>Subtotal:</span>
                    <span className="font-medium">Rp {calculateTotals().subtotal.toLocaleString('id-ID')}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Tax:</span>
                    <span className="font-medium">Rp {calculateTotals().taxAmount.toLocaleString('id-ID')}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Discount:</span>
                    <span className="font-medium">-Rp {formData.discount.toLocaleString('id-ID')}</span>
                  </div>
                  <div className="flex justify-between text-base font-bold border-t pt-2">
                    <span>Total:</span>
                    <span className="text-blue-600">Rp {calculateTotals().total.toLocaleString('id-ID')}</span>
                  </div>
                </div>
              </div>
            </div>

            <div className="flex justify-end gap-3 pt-6 border-t">
              <button
                type="button"
                onClick={() => {
                  setModalOpen(false);
                  resetForm();
                }}
                className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 transition"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition"
              >
                Create Invoice
              </button>
            </div>
          </form>
        </Modal>

        {viewModalOpen && selectedInvoice && (
          <InvoiceView
            invoice={selectedInvoice}
            items={invoiceItems}
            onClose={() => {
              setViewModalOpen(false);
              setSelectedInvoice(null);
              setInvoiceItems([]);
            }}
          />
        )}
      </div>
    </Layout>
  );
}
