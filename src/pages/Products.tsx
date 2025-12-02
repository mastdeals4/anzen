import { useEffect, useState } from 'react';
import { Layout } from '../components/Layout';
import { DataTable } from '../components/DataTable';
import { Modal } from '../components/Modal';
import { useLanguage } from '../contexts/LanguageContext';
import { useAuth } from '../contexts/AuthContext';
import { supabase } from '../lib/supabase';
import { Plus, Edit, Trash2 } from 'lucide-react';

interface Product {
  id: string;
  product_name: string;
  product_code: string | null;
  hsn_code: string;
  category: string;
  unit: string;
  packaging_type: string;
  default_supplier: string;
  description: string;
  min_stock_level: number | null;
  total_quantity: number | null;
  per_pack_weight: number | null;
  pack_type: string | null;
  calculated_packs: number | null;
  is_active: boolean;
  created_at: string;
}

export function Products() {
  const { t } = useLanguage();
  const { profile } = useAuth();
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [formData, setFormData] = useState({
    product_name: '',
    hsn_code: '',
    category: 'api',
    unit: 'kg',
    packaging_type: '',
    default_supplier: '',
    description: '',
    min_stock_level: '',
  });

  useEffect(() => {
    loadProducts();
  }, []);


  const loadProducts = async () => {
    try {
      const { data, error } = await supabase
        .from('products')
        .select('*')
        .eq('is_active', true)
        .order('created_at', { ascending: false });

      if (error) throw error;
      setProducts(data || []);
    } catch (error) {
      console.error('Error loading products:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    try {
      const minStock = parseFloat(formData.min_stock_level) || null;

      const dataToSave = {
        product_name: formData.product_name,
        product_code: null,
        hsn_code: formData.hsn_code,
        category: formData.category,
        unit: formData.unit,
        packaging_type: formData.packaging_type,
        default_supplier: formData.default_supplier,
        description: formData.description,
        min_stock_level: minStock,
      };

      if (editingProduct) {
        const { error } = await supabase
          .from('products')
          .update(dataToSave)
          .eq('id', editingProduct.id);

        if (error) throw error;
      } else {
        const { error } = await supabase
          .from('products')
          .insert([{ ...dataToSave, created_by: profile?.id }]);

        if (error) throw error;
      }

      setModalOpen(false);
      resetForm();
      loadProducts();
    } catch (error) {
      console.error('Error saving product:', error);
      alert('Failed to save product');
    }
  };

  const handleEdit = (product: Product) => {
    setEditingProduct(product);
    setFormData({
      product_name: product.product_name,
      hsn_code: product.hsn_code,
      category: product.category,
      unit: product.unit,
      packaging_type: product.packaging_type,
      default_supplier: product.default_supplier,
      description: product.description,
      min_stock_level: product.min_stock_level?.toString() || '',
    });
    setModalOpen(true);
  };

  const handleDelete = async (product: Product) => {
    try {
      const { data: salesItems } = await supabase
        .from('sales_invoice_items')
        .select('id')
        .eq('product_id', product.id)
        .limit(1);

      if (salesItems && salesItems.length > 0) {
        alert('Cannot delete this product. It has been used in sales invoices. Please use the "Deactivate" option instead or contact your administrator.');
        return;
      }

      const { data: challanItems } = await supabase
        .from('delivery_challan_items')
        .select('id')
        .eq('product_id', product.id)
        .limit(1);

      if (challanItems && challanItems.length > 0) {
        alert('Cannot delete this product. It has been used in delivery challans. Please use the "Deactivate" option instead.');
        return;
      }

      const { data: batches } = await supabase
        .from('batches')
        .select('id, batch_number')
        .eq('product_id', product.id);

      if (batches && batches.length > 0) {
        const confirmDelete = confirm(
          `This product has ${batches.length} batch(es). Deleting this product will permanently remove:\n` +
          `- ${batches.length} batches\n` +
          `- All related inventory transactions\n` +
          `- All related documents\n\n` +
          `Are you absolutely sure you want to continue?`
        );
        
        if (!confirmDelete) return;
      } else {
        if (!confirm('Are you sure you want to delete this product?')) return;
      }

      if (batches && batches.length > 0) {
        for (const batch of batches) {
          await supabase.from('batch_documents').delete().eq('batch_id', batch.id);
          await supabase.from('inventory_transactions').delete().eq('batch_id', batch.id);
          await supabase.from('finance_expenses').delete().eq('batch_id', batch.id);
        }

        await supabase.from('batches').delete().eq('product_id', product.id);
      }

      await supabase.from('inventory_transactions').delete().eq('product_id', product.id);
      await supabase.from('product_files').delete().eq('product_id', product.id);

      const { error } = await supabase
        .from('products')
        .delete()
        .eq('id', product.id);

      if (error) throw error;

      alert('Product deleted successfully');
      await loadProducts();
    } catch (error: any) {
      console.error('Error deleting product:', error);
      const errorMessage = error?.message || 'Unknown error occurred';
      alert(`Failed to delete product: ${errorMessage}\n\nIf this product is in use, consider deactivating it instead.`);
    }
  };

  const resetForm = () => {
    setEditingProduct(null);
    setFormData({
      product_name: '',
      hsn_code: '',
      category: 'api',
      unit: 'kg',
      packaging_type: '',
      default_supplier: '',
      description: '',
      min_stock_level: '',
    });
  };

  const columns = [
    { key: 'product_name', label: 'Product Name' },
    { key: 'hsn_code', label: 'HSN Code' },
    {
      key: 'category',
      label: 'Category',
      render: (product: Product) => (
        <span className="capitalize">{product.category}</span>
      ),
    },
    {
      key: 'unit',
      label: 'Unit',
      render: (product: Product) => (
        <span className="capitalize">{product.unit}</span>
      ),
    },
    {
      key: 'min_stock',
      label: 'Min Stock Level',
      render: (product: Product) => (
        <span>{product.min_stock_level ? `${product.min_stock_level} ${product.unit}` : '-'}</span>
      ),
    },
  ];

  return (
    <Layout>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-gray-900">Products</h1>
            <p className="text-gray-600 mt-1">Manage your product catalog with packaging details</p>
          </div>
          <button
            onClick={() => {
              resetForm();
              setModalOpen(true);
            }}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition"
          >
            <Plus className="w-5 h-5" />
            Add Product
          </button>
        </div>

        <DataTable
          data={products}
          columns={columns}
          loading={loading}
          actions={(product) => (
            <div className="flex items-center gap-2">
              <button
                onClick={() => handleEdit(product)}
                className="p-1 text-blue-600 hover:bg-blue-50 rounded transition"
              >
                <Edit className="w-4 h-4" />
              </button>
              <button
                onClick={() => handleDelete(product)}
                className="p-1 text-red-600 hover:bg-red-50 rounded transition"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          )}
        />
      </div>

      <Modal
        isOpen={modalOpen}
        onClose={() => {
          setModalOpen(false);
          resetForm();
        }}
        title={editingProduct ? 'Edit Product' : 'Add Product'}
      >
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Product Name *
              </label>
              <input
                type="text"
                required
                value={formData.product_name}
                onChange={(e) =>
                  setFormData({ ...formData, product_name: e.target.value })
                }
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                HSN Code
              </label>
              <input
                type="text"
                value={formData.hsn_code}
                onChange={(e) =>
                  setFormData({ ...formData, hsn_code: e.target.value })
                }
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Category *
              </label>
              <select
                required
                value={formData.category}
                onChange={(e) =>
                  setFormData({ ...formData, category: e.target.value })
                }
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none"
              >
                <option value="api">API</option>
                <option value="excipient">Excipient</option>
                <option value="solvent">Solvent</option>
                <option value="other">Other</option>
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Unit *
              </label>
              <select
                required
                value={formData.unit}
                onChange={(e) =>
                  setFormData({ ...formData, unit: e.target.value })
                }
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none"
              >
                <option value="kg">Kilogram</option>
                <option value="litre">Litre</option>
                <option value="ton">Ton</option>
                <option value="piece">Piece</option>
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Minimum Stock Level
              </label>
              <input
                type="number"
                step="0.001"
                value={formData.min_stock_level}
                onChange={(e) =>
                  setFormData({ ...formData, min_stock_level: e.target.value })
                }
                placeholder="e.g., 100"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none"
              />
              <p className="text-xs text-gray-500 mt-1">Alert when stock falls below this level (in {formData.unit})</p>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Default Supplier
            </label>
            <input
              type="text"
              value={formData.default_supplier}
              onChange={(e) =>
                setFormData({ ...formData, default_supplier: e.target.value })
              }
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Description
            </label>
            <textarea
              value={formData.description}
              onChange={(e) =>
                setFormData({ ...formData, description: e.target.value })
              }
              rows={3}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none"
            />
          </div>

          <div className="flex justify-end gap-3 pt-4 border-t">
            <button
              type="button"
              onClick={() => {
                setModalOpen(false);
                resetForm();
              }}
              className="px-4 py-2 text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 transition"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition"
            >
              Save
            </button>
          </div>
        </form>
      </Modal>
    </Layout>
  );
}
