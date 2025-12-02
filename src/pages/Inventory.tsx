import { useEffect, useState } from 'react';
import { Layout } from '../components/Layout';
import { DataTable } from '../components/DataTable';
import { Modal } from '../components/Modal';
import { useLanguage } from '../contexts/LanguageContext';
import { useAuth } from '../contexts/AuthContext';
import { supabase } from '../lib/supabase';
import { Plus, TrendingUp, TrendingDown, RefreshCw } from 'lucide-react';

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

export function Inventory() {
  const { t } = useLanguage();
  const { profile } = useAuth();
  const [transactions, setTransactions] = useState<InventoryTransaction[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [formData, setFormData] = useState({
    transaction_type: 'adjustment' as 'purchase' | 'sale' | 'adjustment',
    product_id: '',
    batch_id: '',
    quantity: 0,
    reference_number: '',
    notes: '',
    transaction_date: new Date().toISOString().split('T')[0],
  });

  useEffect(() => {
    loadTransactions();
    loadProducts();
    loadBatches();
  }, []);

  const loadTransactions = async () => {
    try {
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
    } catch (error) {
      console.error('Error loading transactions:', error);
    } finally {
      setLoading(false);
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
      const { data, error } = await supabase
        .from('batches')
        .select('id, batch_number, product_id, current_stock')
        .eq('is_active', true)
        .gt('current_stock', 0)
        .order('import_date', { ascending: false });

      if (error) throw error;
      setBatches(data || []);
    } catch (error) {
      console.error('Error loading batches:', error);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const { error: txError } = await supabase
        .from('inventory_transactions')
        .insert([{
          ...formData,
          batch_id: formData.batch_id || null,
          reference_number: formData.reference_number || null,
          notes: formData.notes || null,
          created_by: user.id,
        }]);

      if (txError) throw txError;

      if (formData.batch_id) {
        const batch = batches.find(b => b.id === formData.batch_id);
        if (batch) {
          let newStock = batch.current_stock;
          if (formData.transaction_type === 'purchase' || formData.transaction_type === 'adjustment') {
            newStock += formData.quantity;
          } else if (formData.transaction_type === 'sale') {
            newStock -= formData.quantity;
          }

          const { error: batchError } = await supabase
            .from('batches')
            .update({ current_stock: newStock })
            .eq('id', formData.batch_id);

          if (batchError) throw batchError;
        }
      }

      setModalOpen(false);
      resetForm();
      loadTransactions();
      loadBatches();
    } catch (error) {
      console.error('Error saving transaction:', error);
      alert('Failed to save transaction. Please try again.');
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
  };

  const availableBatches = batches.filter(b => b.product_id === formData.product_id);

  const columns = [
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
    {
      key: 'created_by',
      label: 'Created By',
      render: (tx: InventoryTransaction) => tx.user_profiles?.full_name || (tx.transaction_type === 'purchase' ? 'System' : 'Unknown')
    },
  ];

  const canManage = profile?.role === 'admin' || profile?.role === 'warehouse';

  const summaryStats = {
    totalTransactions: transactions.length,
    purchases: transactions.filter(t => t.transaction_type === 'purchase').length,
    sales: transactions.filter(t => t.transaction_type === 'sale').length,
    adjustments: transactions.filter(t => t.transaction_type === 'adjustment').length,
  };

  return (
    <Layout>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-gray-900">Inventory Transactions</h1>
            <p className="text-gray-600 mt-1">Track all stock movements and adjustments</p>
          </div>
          {canManage && (
            <button
              onClick={() => {
                resetForm();
                setModalOpen(true);
              }}
              className="flex items-center gap-2 bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 transition"
            >
              <Plus className="w-5 h-5" />
              Add Transaction
            </button>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div className="bg-white rounded-lg shadow p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-gray-600">Total Transactions</p>
                <p className="text-2xl font-bold text-gray-900 mt-1">{summaryStats.totalTransactions}</p>
              </div>
              <RefreshCw className="w-8 h-8 text-blue-600" />
            </div>
          </div>

          <div className="bg-green-50 rounded-lg shadow p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-green-600">Purchases</p>
                <p className="text-2xl font-bold text-green-600 mt-1">{summaryStats.purchases}</p>
              </div>
              <TrendingUp className="w-8 h-8 text-green-600" />
            </div>
          </div>

          <div className="bg-red-50 rounded-lg shadow p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-red-600">Sales</p>
                <p className="text-2xl font-bold text-red-600 mt-1">{summaryStats.sales}</p>
              </div>
              <TrendingDown className="w-8 h-8 text-red-600" />
            </div>
          </div>

          <div className="bg-blue-50 rounded-lg shadow p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-blue-600">Adjustments</p>
                <p className="text-2xl font-bold text-blue-600 mt-1">{summaryStats.adjustments}</p>
              </div>
              <RefreshCw className="w-8 h-8 text-blue-600" />
            </div>
          </div>
        </div>

        <DataTable
          columns={columns}
          data={transactions}
          loading={loading}
        />

        <Modal
          isOpen={modalOpen}
          onClose={() => {
            setModalOpen(false);
            resetForm();
          }}
          title="Add Inventory Transaction"
        >
          <form onSubmit={handleSubmit} className="space-y-4">
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
                placeholder="Additional notes about this transaction"
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
        </Modal>
      </div>
    </Layout>
  );
}
