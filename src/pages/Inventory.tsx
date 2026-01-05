import { useEffect, useState } from 'react';
import { Layout } from '../components/Layout';
import { DataTable } from '../components/DataTable';
import { Modal } from '../components/Modal';
import { useLanguage } from '../contexts/LanguageContext';
import { useAuth } from '../contexts/AuthContext';
import { supabase } from '../lib/supabase';
import { Plus, TrendingUp, TrendingDown, RefreshCw, RotateCcw, AlertTriangle, Package, CheckCircle, XCircle, Upload } from 'lucide-react';
import MaterialReturns from './MaterialReturns';
import StockRejections from './StockRejections';

type TabType = 'transactions' | 'returns' | 'rejections';

interface InventoryTransaction {
  id: string;
  transaction_type: 'purchase' | 'sale' | 'adjustment';
  product_id: string;
  batch_id: string | null;
  quantity: number;
  reference_number: string | null;
  notes: string | null;
  transaction_date: string;
  created_by: string;
  products?: {
    product_name: string;
    product_code: string;
  };
  batches?: {
    batch_number: string;
  } | null;
  user_profiles?: {
    full_name: string;
  };
}

interface MaterialReturn {
  id: string;
  return_number: string;
  return_date: string;
  return_type: string;
  return_reason: string;
  status: string;
  financial_impact: number;
  credit_note_issued: boolean;
  restocked: boolean;
  customer: {
    company_name: string;
  };
}

interface StockRejection {
  id: string;
  rejection_number: string;
  rejection_date: string;
  quantity_rejected: number;
  rejection_reason: string;
  status: string;
  financial_loss: number;
  disposition: string;
  product: {
    product_name: string;
    product_code: string;
  };
  batch: {
    batch_number: string;
  };
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
}

interface Customer {
  id: string;
  company_name: string;
}

export function Inventory() {
  const { t } = useLanguage();
  const { profile } = useAuth();
  const [activeTab, setActiveTab] = useState<TabType>('transactions');
  const [transactions, setTransactions] = useState<InventoryTransaction[]>([]);
  const [returns, setReturns] = useState<MaterialReturn[]>([]);
  const [rejections, setRejections] = useState<StockRejection[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [modalType, setModalType] = useState<'transaction' | 'return' | 'rejection'>('transaction');

  const [formData, setFormData] = useState({
    transaction_type: 'adjustment' as 'purchase' | 'sale' | 'adjustment',
    product_id: '',
    batch_id: '',
    quantity: 0,
    reference_number: '',
    notes: '',
    transaction_date: new Date().toISOString().split('T')[0],
  });

  const [returnFormData, setReturnFormData] = useState({
    customer_id: '',
    return_date: new Date().toISOString().split('T')[0],
    return_type: 'quality_issue',
    return_reason: '',
    notes: '',
  });

  const [rejectionFormData, setRejectionFormData] = useState({
    product_id: '',
    batch_id: '',
    rejection_date: new Date().toISOString().split('T')[0],
    quantity_rejected: 0,
    rejection_reason: 'quality_failed',
    rejection_details: '',
    unit_cost: 0,
  });

  useEffect(() => {
    loadData();
  }, [activeTab]);

  const loadData = async () => {
    setLoading(true);
    setError(null);
    try {
      await loadProducts();
      await loadBatches();
      await loadCustomers();

      if (activeTab === 'transactions') {
        await loadTransactions();
      } else if (activeTab === 'returns') {
        await loadReturns();
      } else if (activeTab === 'rejections') {
        await loadRejections();
      }
    } catch (err) {
      setError('Failed to load inventory data. Please try again.');
    }
    setLoading(false);
  };

  const loadTransactions = async () => {
    const { data, error } = await supabase
      .from('inventory_transactions')
      .select(`
        *,
        products(product_name, product_code),
        batches(batch_number),
        user_profiles(full_name)
      `)
      .order('transaction_date', { ascending: false })
      .order('created_at', { ascending: false });

    if (error) throw error;
    setTransactions(data || []);
  };

  const loadReturns = async () => {
    const { data, error } = await supabase
      .from('material_returns')
      .select(`
        *,
        customer:customers(company_name)
      `)
      .order('return_date', { ascending: false });

    if (error) throw error;
    setReturns(data || []);
  };

  const loadRejections = async () => {
    const { data, error } = await supabase
      .from('stock_rejections')
      .select(`
        *,
        product:products(product_name, product_code),
        batch:batches(batch_number)
      `)
      .order('rejection_date', { ascending: false });

    if (error) throw error;
    setRejections(data || []);
  };

  const loadProducts = async () => {
    const { data, error } = await supabase
      .from('products')
      .select('id, product_name, product_code')
      .eq('is_active', true)
      .order('product_name');

    if (error) throw error;
    setProducts(data || []);
  };

  const loadBatches = async () => {
    const { data, error } = await supabase
      .from('batches')
      .select('id, batch_number, product_id, current_stock')
      .eq('is_active', true)
      .gt('current_stock', 0)
      .order('import_date', { ascending: false });

    if (error) throw error;
    setBatches(data || []);
  };

  const loadCustomers = async () => {
    const { data, error } = await supabase
      .from('customers')
      .select('id, company_name')
      .eq('is_active', true)
      .order('company_name');

    if (error) throw error;
    setCustomers(data || []);
  };

  const handleTransactionSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      // HARDENING FIX #2: Use atomic DB-side stock adjustment
      // Prevents race conditions in concurrent updates
      if (formData.batch_id) {
        let quantityChange = formData.quantity;
        if (formData.transaction_type === 'sale') {
          quantityChange = -quantityChange;
        }
        // For 'purchase' and 'adjustment', quantity is already positive

        const { error: adjustError } = await supabase
          .rpc('adjust_batch_stock_atomic', {
            p_batch_id: formData.batch_id,
            p_quantity_change: quantityChange,
            p_transaction_type: formData.transaction_type,
            p_reference_id: null,
            p_notes: formData.notes || null,
            p_created_by: user.id,
          });

        if (adjustError) throw adjustError;
      } else {
        // No batch selected - just create transaction record
        const { error: txError } = await supabase
          .from('inventory_transactions')
          .insert([{
            ...formData,
            batch_id: null,
            reference_number: formData.reference_number || null,
            notes: formData.notes || null,
            created_by: user.id,
          }]);

        if (txError) throw txError;
      }

      setModalOpen(false);
      resetForm();
      loadData();
      alert('Transaction added successfully');
    } catch (error) {
      console.error('Error saving transaction:', error);
      alert('Failed to save transaction. Please try again.');
    }
  };

  const handleReturnSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const { error } = await supabase
        .from('material_returns')
        .insert([{
          ...returnFormData,
          created_by: user.id,
        }]);

      if (error) throw error;

      setModalOpen(false);
      resetForm();
      loadData();
      alert('Material return created successfully. Awaiting approval.');
    } catch (error) {
      console.error('Error creating return:', error);
      alert('Failed to create return. Please try again.');
    }
  };

  const handleRejectionSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const { error } = await supabase
        .from('stock_rejections')
        .insert([{
          ...rejectionFormData,
          created_by: user.id,
        }]);

      if (error) throw error;

      setModalOpen(false);
      resetForm();
      loadData();
      alert('Stock rejection created successfully. Awaiting approval.');
    } catch (error) {
      console.error('Error creating rejection:', error);
      alert('Failed to create rejection. Please try again.');
    }
  };

  const resetForm = () => {
    setFormData({
      transaction_type: 'adjustment',
      product_id: '',
      batch_id: '',
      quantity: 0,
      reference_number: '',
      notes: '',
      transaction_date: new Date().toISOString().split('T')[0],
    });
    setReturnFormData({
      customer_id: '',
      return_date: new Date().toISOString().split('T')[0],
      return_type: 'quality_issue',
      return_reason: '',
      notes: '',
    });
    setRejectionFormData({
      product_id: '',
      batch_id: '',
      rejection_date: new Date().toISOString().split('T')[0],
      quantity_rejected: 0,
      rejection_reason: 'quality_failed',
      rejection_details: '',
      unit_cost: 0,
    });
  };

  const canManage = profile?.role === 'admin' || profile?.role === 'warehouse' || profile?.role === 'manager';

  const transactionColumns = [
    {
      key: 'transaction_date',
      label: 'Date',
      render: (tx: InventoryTransaction) => new Date(tx.transaction_date).toLocaleDateString()
    },
    {
      key: 'transaction_type',
      label: 'Type',
      render: (tx: InventoryTransaction) => (
        <span className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium ${
          tx.transaction_type === 'purchase' ? 'bg-green-100 text-green-800' :
          tx.transaction_type === 'sale' ? 'bg-red-100 text-red-800' :
          'bg-blue-100 text-blue-800'
        }`}>
          {tx.transaction_type === 'purchase' && <TrendingUp className="w-3 h-3" />}
          {tx.transaction_type === 'sale' && <TrendingDown className="w-3 h-3" />}
          {tx.transaction_type === 'adjustment' && <RefreshCw className="w-3 h-3" />}
          {tx.transaction_type.charAt(0).toUpperCase() + tx.transaction_type.slice(1)}
        </span>
      )
    },
    {
      key: 'product',
      label: 'Product',
      render: (tx: InventoryTransaction) => (
        <div>
          <div className="font-medium">{tx.products?.product_name}</div>
          <div className="text-xs text-gray-500">{tx.products?.product_code}</div>
        </div>
      )
    },
    {
      key: 'batch_number',
      label: 'Batch',
      render: (tx: InventoryTransaction) => tx.batches?.batch_number || 'N/A'
    },
    {
      key: 'quantity',
      label: 'Quantity',
      render: (tx: InventoryTransaction) => (
        <span className={`font-semibold ${
          tx.transaction_type === 'purchase' ? 'text-green-600' :
          tx.transaction_type === 'sale' ? 'text-red-600' :
          'text-blue-600'
        }`}>
          {tx.transaction_type === 'purchase' ? '+' : tx.transaction_type === 'sale' ? '-' : ''}
          {tx.quantity}
        </span>
      )
    },
    {
      key: 'reference_number',
      label: 'Reference',
      render: (tx: InventoryTransaction) => tx.reference_number || (tx.transaction_type === 'purchase' ? 'Batch Import' : '-')
    },
  ];

  const returnColumns = [
    {
      key: 'return_number',
      label: 'Return #',
      render: (ret: MaterialReturn) => ret.return_number || 'Pending'
    },
    {
      key: 'return_date',
      label: 'Date',
      render: (ret: MaterialReturn) => new Date(ret.return_date).toLocaleDateString()
    },
    {
      key: 'customer',
      label: 'Customer',
      render: (ret: MaterialReturn) => ret.customer?.company_name || 'N/A'
    },
    {
      key: 'return_type',
      label: 'Type',
      render: (ret: MaterialReturn) => (
        <span className="px-2 py-1 rounded-full text-xs font-medium bg-orange-100 text-orange-800">
          {ret.return_type.replace('_', ' ').toUpperCase()}
        </span>
      )
    },
    {
      key: 'financial_impact',
      label: 'Amount',
      render: (ret: MaterialReturn) => `$${ret.financial_impact.toFixed(2)}`
    },
    {
      key: 'status',
      label: 'Status',
      render: (ret: MaterialReturn) => (
        <span className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium ${
          ret.status === 'approved' ? 'bg-green-100 text-green-800' :
          ret.status === 'rejected' ? 'bg-red-100 text-red-800' :
          'bg-yellow-100 text-yellow-800'
        }`}>
          {ret.status === 'approved' && <CheckCircle className="w-3 h-3" />}
          {ret.status === 'rejected' && <XCircle className="w-3 h-3" />}
          {ret.status.replace('_', ' ').toUpperCase()}
        </span>
      )
    },
    {
      key: 'restocked',
      label: 'Restocked',
      render: (ret: MaterialReturn) => ret.restocked ? 'Yes' : 'No'
    },
  ];

  const rejectionColumns = [
    {
      key: 'rejection_number',
      label: 'Rejection #',
      render: (rej: StockRejection) => rej.rejection_number || 'Pending'
    },
    {
      key: 'rejection_date',
      label: 'Date',
      render: (rej: StockRejection) => new Date(rej.rejection_date).toLocaleDateString()
    },
    {
      key: 'product',
      label: 'Product',
      render: (rej: StockRejection) => (
        <div>
          <div className="font-medium">{rej.product?.product_name}</div>
          <div className="text-xs text-gray-500">{rej.product?.product_code}</div>
        </div>
      )
    },
    {
      key: 'batch',
      label: 'Batch',
      render: (rej: StockRejection) => rej.batch?.batch_number || 'N/A'
    },
    {
      key: 'quantity_rejected',
      label: 'Qty',
      render: (rej: StockRejection) => rej.quantity_rejected
    },
    {
      key: 'rejection_reason',
      label: 'Reason',
      render: (rej: StockRejection) => (
        <span className="px-2 py-1 rounded-full text-xs font-medium bg-red-100 text-red-800">
          {rej.rejection_reason.replace('_', ' ').toUpperCase()}
        </span>
      )
    },
    {
      key: 'financial_loss',
      label: 'Loss',
      render: (rej: StockRejection) => `$${rej.financial_loss.toFixed(2)}`
    },
    {
      key: 'status',
      label: 'Status',
      render: (rej: StockRejection) => (
        <span className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium ${
          rej.status === 'approved' ? 'bg-green-100 text-green-800' :
          rej.status === 'rejected' ? 'bg-red-100 text-red-800' :
          'bg-yellow-100 text-yellow-800'
        }`}>
          {rej.status === 'approved' && <CheckCircle className="w-3 h-3" />}
          {rej.status === 'rejected' && <XCircle className="w-3 h-3" />}
          {rej.status.replace('_', ' ').toUpperCase()}
        </span>
      )
    },
  ];

  const availableBatches = batches.filter(b =>
    activeTab === 'transactions' ? b.product_id === formData.product_id :
    activeTab === 'rejections' ? b.product_id === rejectionFormData.product_id : false
  );

  return (
    <Layout>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-gray-900">Inventory Management</h1>
            <p className="text-gray-600 mt-1">Track transactions, returns, and rejections</p>
          </div>
          {canManage && activeTab === 'transactions' && (
            <button
              onClick={() => {
                resetForm();
                setModalType('transaction');
                setModalOpen(true);
              }}
              className="flex items-center gap-2 bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 transition"
            >
              <Plus className="w-5 h-5" />
              Add Transaction
            </button>
          )}
        </div>

        <div className="border-b border-gray-200">
          <nav className="flex gap-8">
            <button
              onClick={() => setActiveTab('transactions')}
              className={`flex items-center gap-2 pb-4 border-b-2 transition ${
                activeTab === 'transactions'
                  ? 'border-blue-600 text-blue-600 font-medium'
                  : 'border-transparent text-gray-600 hover:text-gray-900'
              }`}
            >
              <Package className="w-5 h-5" />
              Transactions
            </button>
            <button
              onClick={() => setActiveTab('returns')}
              className={`flex items-center gap-2 pb-4 border-b-2 transition ${
                activeTab === 'returns'
                  ? 'border-blue-600 text-blue-600 font-medium'
                  : 'border-transparent text-gray-600 hover:text-gray-900'
              }`}
            >
              <RotateCcw className="w-5 h-5" />
              Material Returns
            </button>
            <button
              onClick={() => setActiveTab('rejections')}
              className={`flex items-center gap-2 pb-4 border-b-2 transition ${
                activeTab === 'rejections'
                  ? 'border-blue-600 text-blue-600 font-medium'
                  : 'border-transparent text-gray-600 hover:text-gray-900'
              }`}
            >
              <AlertTriangle className="w-5 h-5" />
              Stock Rejections
            </button>
          </nav>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-4 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-5 h-5 text-red-500" />
              <p className="text-red-700">{error}</p>
            </div>
            <button
              onClick={loadData}
              className="px-3 py-1 bg-red-600 text-white rounded-lg hover:bg-red-700 transition text-sm"
            >
              Retry
            </button>
          </div>
        )}

        {activeTab === 'transactions' && (
          <DataTable columns={transactionColumns} data={transactions} loading={loading} />
        )}

        {activeTab === 'returns' && (
          <MaterialReturns />
        )}

        {activeTab === 'rejections' && (
          <StockRejections />
        )}

        <Modal
          isOpen={modalOpen}
          onClose={() => {
            setModalOpen(false);
            resetForm();
          }}
          title={
            modalType === 'transaction' ? 'Add Inventory Transaction' :
            modalType === 'return' ? 'Create Material Return' :
            'Report Stock Rejection'
          }
        >
          {modalType === 'transaction' && (
            <form onSubmit={handleTransactionSubmit} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Transaction Type *
                </label>
                <select
                  value={formData.transaction_type}
                  onChange={(e) => setFormData({ ...formData, transaction_type: e.target.value as any })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                  required
                >
                  <option value="purchase">Purchase</option>
                  <option value="sale">Sale</option>
                  <option value="adjustment">Adjustment</option>
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Product *
                </label>
                <select
                  value={formData.product_id}
                  onChange={(e) => setFormData({ ...formData, product_id: e.target.value, batch_id: '' })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                  required
                >
                  <option value="">Select Product</option>
                  {products.map((product) => (
                    <option key={product.id} value={product.id}>
                      {product.product_name} ({product.product_code})
                    </option>
                  ))}
                </select>
              </div>

              {formData.product_id && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Batch (Optional)
                  </label>
                  <select
                    value={formData.batch_id}
                    onChange={(e) => setFormData({ ...formData, batch_id: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="">Select Batch</option>
                    {availableBatches.map((batch) => (
                      <option key={batch.id} value={batch.id}>
                        {batch.batch_number} (Stock: {batch.current_stock})
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Quantity *
                  </label>
                  <input
                    type="number"
                    value={formData.quantity}
                    onChange={(e) => setFormData({ ...formData, quantity: Number(e.target.value) })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                    required
                    min="1"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Transaction Date *
                  </label>
                  <input
                    type="date"
                    value={formData.transaction_date}
                    onChange={(e) => setFormData({ ...formData, transaction_date: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                    required
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Reference Number
                </label>
                <input
                  type="text"
                  value={formData.reference_number}
                  onChange={(e) => setFormData({ ...formData, reference_number: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                  placeholder="e.g., SAPJ-001, PO-002"
                />
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
                />
              </div>

              <div className="flex justify-end gap-3 pt-4">
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
                  Add Transaction
                </button>
              </div>
            </form>
          )}

          {modalType === 'return' && (
            <form onSubmit={handleReturnSubmit} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Customer *
                </label>
                <select
                  value={returnFormData.customer_id}
                  onChange={(e) => setReturnFormData({ ...returnFormData, customer_id: e.target.value })}
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
                  Return Type *
                </label>
                <select
                  value={returnFormData.return_type}
                  onChange={(e) => setReturnFormData({ ...returnFormData, return_type: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                  required
                >
                  <option value="quality_issue">Quality Issue</option>
                  <option value="wrong_product">Wrong Product</option>
                  <option value="excess_quantity">Excess Quantity</option>
                  <option value="damaged">Damaged</option>
                  <option value="expired">Expired</option>
                  <option value="other">Other</option>
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Return Date *
                </label>
                <input
                  type="date"
                  value={returnFormData.return_date}
                  onChange={(e) => setReturnFormData({ ...returnFormData, return_date: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                  required
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Return Reason *
                </label>
                <textarea
                  value={returnFormData.return_reason}
                  onChange={(e) => setReturnFormData({ ...returnFormData, return_reason: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                  rows={3}
                  required
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Additional Notes
                </label>
                <textarea
                  value={returnFormData.notes}
                  onChange={(e) => setReturnFormData({ ...returnFormData, notes: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                  rows={2}
                />
              </div>

              <div className="flex justify-end gap-3 pt-4">
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
                  Create Return
                </button>
              </div>
            </form>
          )}

          {modalType === 'rejection' && (
            <form onSubmit={handleRejectionSubmit} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Product *
                </label>
                <select
                  value={rejectionFormData.product_id}
                  onChange={(e) => setRejectionFormData({ ...rejectionFormData, product_id: e.target.value, batch_id: '' })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                  required
                >
                  <option value="">Select Product</option>
                  {products.map((product) => (
                    <option key={product.id} value={product.id}>
                      {product.product_name} ({product.product_code})
                    </option>
                  ))}
                </select>
              </div>

              {rejectionFormData.product_id && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Batch *
                  </label>
                  <select
                    value={rejectionFormData.batch_id}
                    onChange={(e) => setRejectionFormData({ ...rejectionFormData, batch_id: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                    required
                  >
                    <option value="">Select Batch</option>
                    {availableBatches.map((batch) => (
                      <option key={batch.id} value={batch.id}>
                        {batch.batch_number} (Stock: {batch.current_stock})
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Rejection Reason *
                </label>
                <select
                  value={rejectionFormData.rejection_reason}
                  onChange={(e) => setRejectionFormData({ ...rejectionFormData, rejection_reason: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                  required
                >
                  <option value="quality_failed">Quality Failed</option>
                  <option value="expired">Expired</option>
                  <option value="damaged">Damaged</option>
                  <option value="contaminated">Contaminated</option>
                  <option value="other">Other</option>
                </select>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Quantity Rejected *
                  </label>
                  <input
                    type="number"
                    value={rejectionFormData.quantity_rejected}
                    onChange={(e) => setRejectionFormData({ ...rejectionFormData, quantity_rejected: Number(e.target.value) })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                    required
                    min="1"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Unit Cost *
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    value={rejectionFormData.unit_cost}
                    onChange={(e) => setRejectionFormData({ ...rejectionFormData, unit_cost: Number(e.target.value) })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                    required
                    min="0"
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Rejection Date *
                </label>
                <input
                  type="date"
                  value={rejectionFormData.rejection_date}
                  onChange={(e) => setRejectionFormData({ ...rejectionFormData, rejection_date: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                  required
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Detailed Description *
                </label>
                <textarea
                  value={rejectionFormData.rejection_details}
                  onChange={(e) => setRejectionFormData({ ...rejectionFormData, rejection_details: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                  rows={3}
                  required
                />
              </div>

              <div className="flex justify-end gap-3 pt-4">
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
                  Report Rejection
                </button>
              </div>
            </form>
          )}
        </Modal>
      </div>
    </Layout>
  );
}
