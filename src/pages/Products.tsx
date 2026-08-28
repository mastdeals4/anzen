import { useEffect, useState } from 'react';
import { Layout } from '../components/Layout';
import { DataTable } from '../components/DataTable';
import { Modal } from '../components/Modal';
import { useLanguage } from '../contexts/LanguageContext';
import { useAuth } from '../contexts/AuthContext';
import { supabase } from '../lib/supabase';
import { Plus, Pencil as Edit, Trash2, Upload, X, ExternalLink, Download, FileText, Eye } from 'lucide-react';
import { showToast } from '../components/ToastNotification';
import { showConfirm } from '../components/ConfirmDialog';
import { resolveStorageUrlCached } from '../utils/signedUrlCache';

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
  duty_a1: string | null;
  duty_percent?: number | null;
  current_stock?: number | string | null;
  is_active: boolean;
}

interface ProductSource {
  id?: string;
  source_name: string;
  grade: string;
  files: File[];
  existing_docs?: SourceDocument[];
}

interface SourceDocument {
  id: string;
  doc_type: string;
  original_filename: string;
  file_url: string;
  file_size: number;
}

export function Products() {
  const { t } = useLanguage();
  const { profile } = useAuth();
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [viewModalOpen, setViewModalOpen] = useState(false);
  const [viewingProduct, setViewingProduct] = useState<Product | null>(null);
  const [viewingSources, setViewingSources] = useState<any[]>([]);
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
    duty_a1: '',
  });

  const [duplicateError, setDuplicateError] = useState<string | null>(null);

  // Inline document viewer state
  const [showDocModal, setShowDocModal] = useState(false);
  const [docViewName, setDocViewName] = useState('');
  const [docViewUrl, setDocViewUrl] = useState<string | null>(null);
  const [docBlobUrl, setDocBlobUrl] = useState<string | null>(null);
  const [docLoading, setDocLoading] = useState(false);

  const [sources, setSources] = useState<ProductSource[]>([{
    source_name: '',
    grade: 'BP',
    files: []
  }]);

  useEffect(() => {
    loadProducts();
  }, []);

  const loadProducts = async () => {
    try {
      setLoading(true);
      const [{ data, error }, { data: stockData, error: stockError }] = await Promise.all([
        supabase
        .from('products')
        .select('*')
        .eq('is_active', true)
        .order('product_name'),
        supabase
          .from('inventory_v1_stock_summary')
          .select('product_id, total_current_stock')
      ]);

      if (error) throw error;
      if (stockError) throw stockError;
      const stockByProduct = new Map((stockData || []).map((row: any) => [row.product_id, Number(row.total_current_stock ?? 0)]));
      const normalize = (v: any): string => {
        if (v === null || v === undefined) return '';
        if (typeof v === 'string') return v;
        if (typeof v === 'object') return v.name ?? v.category_name ?? v.label ?? v.unit_name ?? v.short_name ?? '';
        return String(v);
      };
      setProducts((data || []).map((product: any) => ({
        ...product,
        category: normalize(product.category),
        unit: normalize(product.unit),
        current_stock: stockByProduct.get(product.id) ?? 0,
      })));
    } catch (error) {
      console.error('Error loading products:', error);
    } finally {
      setLoading(false);
    }
  };

  const loadProductSources = async (productId: string) => {
    try {
      const { data: sourcesData, error } = await supabase
        .from('product_sources')
        .select(`
          id,
          supplier_name,
          grade,
          country,
          remarks,
          created_at
        `)
        .eq('product_id', productId)
        .order('created_at', { ascending: false });

      if (error) throw error;

      const sourcesWithDocs = await Promise.all(
        (sourcesData || []).map(async (source) => {
          const { data: docs } = await supabase
            .from('product_source_documents')
            .select('*')
            .eq('source_id', source.id);

          return {
            ...source,
            documents: docs || []
          };
        })
      );

      // Also load product documents (legacy/default)
      const { data: productDocs } = await supabase
        .from('product_documents')
        .select('*')
        .eq('product_id', productId);

      // If there are product documents, add them as a "Default" source
      if (productDocs && productDocs.length > 0) {
        const defaultSource = {
          id: 'default',
          supplier_name: 'Product Documents',
          grade: '-',
          country: null,
          remarks: 'General product documents',
          created_at: new Date().toISOString(),
          documents: productDocs.map(doc => ({
            id: doc.id,
            doc_type: doc.document_type,
            original_filename: doc.file_name,
            file_url: doc.file_url,
            file_size: doc.file_size
          }))
        };
        setViewingSources([defaultSource, ...sourcesWithDocs]);
      } else {
        setViewingSources(sourcesWithDocs);
      }
    } catch (error) {
      console.error('Error loading sources:', error);
    }
  };

  const handleViewProduct = async (product: Product) => {
    setViewingProduct(product);
    await loadProductSources(product.id);
    setViewModalOpen(true);
  };

  const addSourceRow = () => {
    setSources([...sources, { source_name: '', grade: 'BP', files: [] }]);
  };

  const removeSourceRow = (index: number) => {
    if (sources.length > 1) {
      setSources(sources.filter((_, i) => i !== index));
    }
  };

  const updateSource = (index: number, field: keyof ProductSource, value: any) => {
    const updated = [...sources];
    updated[index] = { ...updated[index], [field]: value };
    setSources(updated);
  };

  const handleFileSelect = (index: number, files: FileList | null) => {
    if (!files) return;
    const updated = [...sources];
    updated[index].files = [...updated[index].files, ...Array.from(files)];
    setSources(updated);
  };

  const removeFile = (sourceIndex: number, fileIndex: number) => {
    const updated = [...sources];
    updated[sourceIndex].files = updated[sourceIndex].files.filter((_, i) => i !== fileIndex);
    setSources(updated);
  };

  const handleEdit = async (product: Product) => {
    setEditingProduct(product);
    const cat = product.category || 'api';
    const unt = product.unit || 'kg';
    setFormData({
      product_name: product.product_name,
      hsn_code: product.hsn_code,
      category: cat,
      unit: unt,
      packaging_type: product.packaging_type || '',
      default_supplier: product.default_supplier || '',
      description: product.description || '',
      min_stock_level: product.min_stock_level?.toString() || '',
      duty_a1: product.duty_a1 || '',
    });

    // Load existing sources
    const { data: existingSources } = await supabase
      .from('product_sources')
      .select(`
        id,
        supplier_name,
        grade
      `)
      .eq('product_id', product.id);

    if (existingSources && existingSources.length > 0) {
      const sourcesWithDocs = await Promise.all(
        existingSources.map(async (source) => {
          const { data: docs } = await supabase
            .from('product_source_documents')
            .select('*')
            .eq('source_id', source.id);

          return {
            id: source.id,
            source_name: source.supplier_name || '',
            grade: source.grade || 'BP',
            files: [],
            existing_docs: docs || []
          };
        })
      );
      setSources(sourcesWithDocs);
    } else {
      setSources([{ source_name: '', grade: 'BP', files: [] }]);
    }

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
        showToast({ type: 'error', title: 'Error', message: 'Cannot delete this product. It has been used in sales invoices. Please use the "Deactivate" option instead or contact your administrator.' });
        return;
      }

      const { data: salesOrderItems } = await supabase
        .from('sales_order_items')
        .select('id')
        .eq('product_id', product.id)
        .limit(1);

      if (salesOrderItems && salesOrderItems.length > 0) {
        showToast({ type: 'error', title: 'Error', message: 'Cannot delete this product. It has been used in sales orders. Please deactivate it instead.' });
        return;
      }

      const { data: challanItems } = await supabase
        .from('delivery_challan_items')
        .select('id')
        .eq('product_id', product.id)
        .limit(1);

      if (challanItems && challanItems.length > 0) {
        showToast({ type: 'error', title: 'Error', message: 'Cannot delete this product. It has been used in delivery challans. Please use the "Deactivate" option instead.' });
        return;
      }

      const { data: poItems } = await supabase
        .from('purchase_order_items')
        .select('id')
        .eq('product_id', product.id)
        .limit(1);

      if (poItems && poItems.length > 0) {
        showToast({ type: 'error', title: 'Error', message: 'Cannot delete this product. It has been used in purchase orders. Please use the "Deactivate" option instead.' });
        return;
      }

      const { data: batches } = await supabase
        .from('batches')
        .select('id, batch_number')
        .eq('product_id', product.id);

      if (batches && batches.length > 0) {
        showToast({
          type: 'error',
          title: 'Cannot Delete',
          message: `This product has ${batches.length} batch(es) with inventory history. Deactivate the product instead.`,
        });
        return;
      }

      const { count: movementCount } = await supabase
        .from('inventory_transactions')
        .select('id', { count: 'exact', head: true })
        .eq('product_id', product.id);

      if ((movementCount || 0) > 0) {
        showToast({
          type: 'error',
          title: 'Cannot Delete',
          message: 'This product has inventory history. Deactivate the product instead.',
        });
        return;
      }

      if (!await showConfirm({ title: 'Confirm', message: 'Are you sure you want to delete this unused product?', variant: 'danger', confirmLabel: 'Delete' })) return;

      await supabase.from('product_files').delete().eq('product_id', product.id);

      const { error } = await supabase
        .from('products')
        .delete()
        .eq('id', product.id);

      if (error) throw error;

      showToast({ type: 'success', title: 'Success', message: 'Product deleted successfully' });
      await loadProducts();
    } catch (error: any) {
      console.error('Error deleting product:', error);
      const errorMessage = error?.message || 'Unknown error occurred';
      showToast({ type: 'error', title: 'Error', message: `Failed to delete product: ${errorMessage}\n\nIf this product is in use, consider deactivating it instead.` });
    }
  };

  const resetForm = () => {
    setEditingProduct(null);
    setDuplicateError(null);
    setFormData({
      product_name: '',
      hsn_code: '',
      category: 'api',
      unit: 'kg',
      packaging_type: '',
      default_supplier: '',
      description: '',
      min_stock_level: '',
      duty_a1: '',
    });
    setSources([{ source_name: '', grade: 'BP', files: [] }]);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    try {
      const minStock = parseFloat(formData.min_stock_level) || null;

      const dataToSave = {
        product_name: formData.product_name,
        hsn_code: formData.hsn_code,
        category: formData.category,
        unit: formData.unit,
        packaging_type: formData.packaging_type,
        default_supplier: formData.default_supplier,
        description: formData.description,
        min_stock_level: minStock,
        duty_a1: formData.duty_a1 || null,
        duty_percent: formData.duty_a1 === '' ? 0 : (parseFloat(formData.duty_a1) || 0),
      };

      let productId: string;

      const { data: duplicates } = await supabase
        .from('products')
        .select('id, product_code, product_name, hsn_code')
        .ilike('product_name', formData.product_name.trim())
        .eq('is_active', true);

      const existingDuplicate = (duplicates || []).find(d =>
        d.product_name.toLowerCase() === formData.product_name.trim().toLowerCase() &&
        d.hsn_code === formData.hsn_code.trim() &&
        d.id !== editingProduct?.id
      );

      if (existingDuplicate) {
        const msg = `A product named "${formData.product_name}" with HSN code "${formData.hsn_code}" already exists (${existingDuplicate.product_code || 'existing product'}). Please use a different name or HSN code.`;
        setDuplicateError(msg);
        showToast({ type: 'error', title: 'Duplicate Product', message: msg });
        return;
      }

      setDuplicateError(null);

      if (editingProduct) {
        const { error } = await supabase
          .from('products')
          .update(dataToSave)
          .eq('id', editingProduct.id);

        if (error) throw error;
        productId = editingProduct.id;
      } else {
        const { data, error } = await supabase
          .from('products')
          .insert([{ ...dataToSave, created_by: profile?.id }])
          .select()
          .single();

        if (error) throw error;
        productId = data.id;
      }

      // Save sources
      for (const source of sources) {
        if (!source.source_name.trim()) continue;

        let sourceId: string;

        if (source.id) {
          // Update existing source
          const { error } = await supabase
            .from('product_sources')
            .update({
              supplier_name: source.source_name,
              grade: source.grade
            })
            .eq('id', source.id);

          if (error) throw error;
          sourceId = source.id;
        } else {
          // Create new source
          const { data: newSource, error } = await supabase
            .from('product_sources')
            .insert([{
              product_id: productId,
              supplier_name: source.source_name,
              grade: source.grade,
              created_by: profile?.id
            }])
            .select()
            .single();

          if (error) throw error;
          sourceId = newSource.id;
        }

        // Upload files for this source
        for (const file of source.files) {
          const fileExt = file.name.split('.').pop();
          const fileName = `${productId}/${sourceId}/${Date.now()}.${fileExt}`;

          const { error: uploadError } = await supabase.storage
            .from('product-source-documents')
            .upload(fileName, file);

          if (uploadError) {
            console.error('Upload error:', uploadError);
            continue;
          }

          const { data: urlData } = supabase.storage
            .from('product-source-documents')
            .getPublicUrl(fileName);

          await supabase
            .from('product_source_documents')
            .insert([{
              source_id: sourceId,
              doc_type: 'Other',
              file_url: urlData.publicUrl,
              original_filename: file.name,
              file_size: file.size,
              uploaded_by: profile?.id
            }]);
        }
      }

      showToast({ type: 'success', title: 'Success', message: editingProduct ? 'Product updated successfully' : 'Product added successfully' });
      setModalOpen(false);
      resetForm();
      await loadProducts();
    } catch (error: any) {
      console.error('Error saving product:', error);
      showToast({ type: 'error', title: 'Error', message: 'Failed to save product: ' + error.message });
    }
  };

  const getSignedUrl = (fileUrl: string): Promise<string> =>
    resolveStorageUrlCached(fileUrl, 3600);

  const viewDocument = async (fileUrl: string, filename = 'Document') => {
    setShowDocModal(true);
    setDocViewName(filename);
    setDocViewUrl(fileUrl);
    setDocBlobUrl(null);
    setDocLoading(true);
    try {
      const signedUrl = await getSignedUrl(fileUrl);
      const response = await fetch(signedUrl);
      if (!response.ok) {
        setDocBlobUrl(null);
        return;
      }
      const blob = await response.blob();
      setDocBlobUrl(URL.createObjectURL(blob));
    } catch {
      setDocBlobUrl(null);
    } finally {
      setDocLoading(false);
    }
  };

  const downloadDocument = async (fileUrl: string, filename: string) => {
    try {
      const signedUrl = await getSignedUrl(fileUrl);
      const response = await fetch(signedUrl);
      if (!response.ok) {
        showToast({ type: 'error', title: 'Download Failed', message: 'File not found or bucket not accessible.' });
        return;
      }
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (error) {
      console.error('Error downloading:', error);
      showToast({ type: 'error', title: 'Error', message: 'Failed to download file' });
    }
  };

  const deleteDocument = async (docId: string, sourceId: string) => {
    if (!await showConfirm({ title: 'Confirm', message: 'Delete this document?', variant: 'danger', confirmLabel: 'Delete' })) return;

    try {
      const { error } = await supabase
        .from('product_source_documents')
        .delete()
        .eq('id', docId);

      if (error) throw error;

      showToast({ type: 'success', title: 'Success', message: 'Document deleted' });
      if (viewingProduct) {
        await loadProductSources(viewingProduct.id);
      }
    } catch (error: any) {
      console.error('Error deleting document:', error);
      showToast({ type: 'error', title: 'Error', message: 'Failed to delete: ' + error.message });
    }
  };

  const displayValue = (value: unknown, objectKeys: string[] = []): string => {
    if (value === null || value === undefined || value === '') return '-';
    if (typeof value === 'string' || typeof value === 'number') return String(value);
    if (typeof value === 'object') {
      const record = value as Record<string, unknown>;
      const property = objectKeys.find(key => typeof record[key] === 'string' || typeof record[key] === 'number');
      return property ? String(record[property]) : '-';
    }
    return '-';
  };

  const columns = [
    {
      key: 'product_name',
      label: t('products.productName'),
      render: (value: string, row: Product) => (
        <button
          onClick={() => handleViewProduct(row)}
          className="text-blue-600 hover:text-blue-800 font-medium text-left"
        >
          {value || '-'}
        </button>
      )
    },
    { key: 'hsn_code', label: t('products.hsnCode') },
    { key: 'category', label: t('products.category'), render: (value: unknown, _row: Product) => displayValue(value, ['name', 'category_name', 'label']) },
    { key: 'unit', label: t('products.unit'), render: (value: unknown, _row: Product) => displayValue(value, ['name', 'unit_name', 'label', 'short_name']) },
    {
      key: 'current_stock',
      label: t('products.currentStock'),
      render: (value: unknown, _row: Product) => {
        const numeric = Number(value ?? 0);
        return Number.isFinite(numeric) ? numeric.toFixed(2) : '0.00';
      }
    },
    { key: 'duty_a1', label: t('products.dutyA1') }
  ];

  return (
    <Layout>
      <div className="space-y-6">
        <div className="flex justify-between items-center">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">{t('products.title')}</h1>
            <p className="text-gray-600">Manage your product catalog with packaging details</p>
          </div>
          <button
            onClick={() => {
              resetForm();
              setModalOpen(true);
            }}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition"
          >
            <Plus className="w-4 h-4" />
            {t('products.addProduct')}
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

      {/* Add/Edit Product Modal */}
      <Modal
        isOpen={modalOpen}
        onClose={() => {
          setModalOpen(false);
          resetForm();
        }}
        title={editingProduct ? t('products.editProduct') : t('products.addProduct')}
        maxWidth="max-w-4xl"
      >
        <form onSubmit={handleSubmit} className="space-y-6">
          {/* Product Details */}
          <div className="bg-gray-50 p-4 rounded-lg space-y-4">
            <h3 className="font-semibold text-gray-900">Product Details</h3>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {t('products.productName')} *
                </label>
                <input
                  type="text"
                  required
                  value={formData.product_name}
                  onChange={(e) => { setFormData({ ...formData, product_name: e.target.value }); setDuplicateError(null); }}
                  className={`w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 ${duplicateError ? 'border-red-500' : ''}`}
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {t('products.hsnCode')} *
                </label>
                <input
                  type="text"
                  required
                  value={formData.hsn_code}
                  onChange={(e) => { setFormData({ ...formData, hsn_code: e.target.value }); setDuplicateError(null); }}
                  className={`w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 ${duplicateError ? 'border-red-500' : ''}`}
                />
              </div>
            </div>

            {duplicateError && (
              <div className="flex items-start gap-2 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
                <span className="font-semibold shrink-0">Already exists:</span>
                <span>{duplicateError}</span>
              </div>
            )}

            <div className="grid grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">{t('products.category')} *</label>
                <select
                  required
                  value={formData.category}
                  onChange={(e) => setFormData({ ...formData, category: e.target.value })}
                  className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500"
                >
                  <option value="api">API</option>
                  <option value="excipient">Excipients</option>
                  <option value="solvent">Solvent</option>
                  <option value="other">Other</option>
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">{t('products.unit')} *</label>
                <select
                  required
                  value={formData.unit}
                  onChange={(e) => setFormData({ ...formData, unit: e.target.value })}
                  className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500"
                >
                  <option value="kg">KG</option>
                  <option value="litre">Liter</option>
                  <option value="piece">Piece</option>
                  <option value="g">Gram</option>
                  <option value="mg">Milligram</option>
                  <option value="ton">Ton</option>
                  <option value="ml">Millilitre</option>
                  <option value="bottle">Bottle</option>
                  <option value="pack">Pack</option>
                  <option value="box">Box</option>
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {t('products.minStockLevel')}
                </label>
                <input
                  type="number"
                  step="0.01"
                  value={formData.min_stock_level}
                  onChange={(e) => setFormData({ ...formData, min_stock_level: e.target.value })}
                  className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {t('products.packagingType')}
                </label>
                <input
                  type="text"
                  value={formData.packaging_type}
                  onChange={(e) => setFormData({ ...formData, packaging_type: e.target.value })}
                  placeholder="e.g., 25kg drum"
                  className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {t('products.dutyA1')} (%)
                </label>
                <input
                  type="text"
                  value={formData.duty_a1}
                  onChange={(e) => setFormData({ ...formData, duty_a1: e.target.value })}
                  placeholder="e.g., 5.0"
                  className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
              <textarea
                value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                rows={2}
                className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>

          {/* Sources Section */}
          <div className="bg-blue-50 p-4 rounded-lg space-y-4">
            <div className="flex justify-between items-center">
              <h3 className="font-semibold text-gray-900">Sources</h3>
              <button
                type="button"
                onClick={addSourceRow}
                className="flex items-center gap-1 px-3 py-1 text-sm bg-blue-600 text-white rounded hover:bg-blue-700"
              >
                <Plus className="w-3 h-3" />
                Add Source
              </button>
            </div>

            {sources.map((source, index) => (
              <div key={index} className="bg-white p-4 rounded-lg border border-blue-200 space-y-3">
                <div className="flex justify-between items-start">
                  <div className="flex-1 grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Source Name
                      </label>
                      <input
                        type="text"
                        value={source.source_name}
                        onChange={(e) => updateSource(index, 'source_name', e.target.value)}
                        placeholder="e.g., Everest Organics"
                        className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500"
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Grade</label>
                      <select
                        value={source.grade}
                        onChange={(e) => updateSource(index, 'grade', e.target.value)}
                        className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500"
                      >
                        <option value="BP">BP (British Pharmacopoeia)</option>
                        <option value="USP">USP (United States Pharmacopeia)</option>
                        <option value="EP">EP (European Pharmacopoeia)</option>
                        <option value="IP">IP (Indian Pharmacopoeia)</option>
                        <option value="Tech">Tech Grade</option>
                        <option value="Food Grade">Food Grade</option>
                        <option value="Industrial">Industrial</option>
                        <option value="Other">Other</option>
                      </select>
                    </div>
                  </div>

                  {sources.length > 1 && (
                    <button
                      type="button"
                      onClick={() => removeSourceRow(index)}
                      className="ml-2 p-1 text-red-600 hover:bg-red-50 rounded"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  )}
                </div>

                {/* File Upload */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Upload Documents
                  </label>
                  <div className="flex items-center gap-2">
                    <label className="flex items-center gap-2 px-3 py-2 bg-gray-50 border border-gray-300 rounded-lg cursor-pointer hover:bg-gray-100">
                      <Upload className="w-4 h-4 text-gray-600" />
                      <span className="text-sm text-gray-600">Choose Files</span>
                      <input
                        type="file"
                        multiple
                        onChange={(e) => handleFileSelect(index, e.target.files)}
                        className="hidden"
                        accept=".pdf,.doc,.docx,.jpg,.jpeg,.png"
                      />
                    </label>
                    <span className="text-xs text-gray-500">
                      PDF, DOC, JPG (Max 10MB each)
                    </span>
                  </div>

                  {/* Show selected files */}
                  {source.files.length > 0 && (
                    <div className="mt-2 space-y-1">
                      {source.files.map((file, fileIndex) => (
                        <div
                          key={fileIndex}
                          className="flex items-center justify-between px-3 py-2 bg-gray-50 rounded text-sm"
                        >
                          <span className="text-gray-700">{file.name}</span>
                          <button
                            type="button"
                            onClick={() => removeFile(index, fileIndex)}
                            className="text-red-600 hover:text-red-800"
                          >
                            <X className="w-4 h-4" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Show existing documents */}
                  {source.existing_docs && source.existing_docs.length > 0 && (
                    <div className="mt-2 space-y-1">
                      <p className="text-xs font-medium text-gray-600">Existing Documents:</p>
                      {source.existing_docs.map((doc) => (
                        <div
                          key={doc.id}
                          className="flex items-center justify-between px-3 py-2 bg-green-50 rounded text-sm"
                        >
                          <span className="text-gray-700">{doc.original_filename}</span>
                          <span className="text-xs text-gray-500">
                            {(doc.file_size / 1024).toFixed(1)} KB
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>

          <div className="flex justify-end gap-3 pt-4 border-t">
            <button
              type="button"
              onClick={() => {
                setModalOpen(false);
                resetForm();
              }}
              className="px-4 py-2 text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
            >
              {editingProduct ? 'Update Product' : 'Add Product'}
            </button>
          </div>
        </form>
      </Modal>

      {/* View Product Modal - Compact */}
      <Modal
        isOpen={viewModalOpen}
        onClose={() => {
          setViewModalOpen(false);
          setViewingProduct(null);
          setViewingSources([]);
        }}
        title={viewingProduct?.product_name || 'Product Details'}
        maxWidth="max-w-5xl"
      >
        {viewingProduct && (
          <div className="space-y-6">
            {/* Compact Product Details */}
            <div className="grid grid-cols-4 gap-4 p-4 bg-gray-50 rounded-lg">
              <div>
                <p className="text-xs text-gray-500">HSN Code</p>
                <p className="font-medium">{viewingProduct.hsn_code}</p>
              </div>
              <div>
                <p className="text-xs text-gray-500">Category</p>
                <p className="font-medium">{(() => {
                  return displayValue(viewingProduct.category).toUpperCase();
                })()}</p>
              </div>
              <div>
                <p className="text-xs text-gray-500">Unit</p>
                <p className="font-medium">{(() => {
                  return displayValue(viewingProduct.unit).toUpperCase();
                })()}</p>
              </div>
              <div>
                <p className="text-xs text-gray-500">Current Stock</p>
                <p className="font-medium">{(() => {
                  const n = Number(viewingProduct.current_stock ?? 0);
                  return Number.isFinite(n) ? n.toFixed(2) : '0.00';
                })()}</p>
              </div>
            </div>

            {/* Sources Table */}
            <div>
              <h3 className="text-lg font-semibold mb-3">Sources & Documents</h3>

              {viewingSources.length === 0 ? (
                <div className="text-center py-8 text-gray-500">
                  No sources added yet. Edit the product to add sources.
                </div>
              ) : (
                <div className="border rounded-lg overflow-hidden">
                  <table className="w-full">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                          Source Name
                        </th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                          Grade
                        </th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                          Documents
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-200">
                      {viewingSources.map((source) => (
                        <tr key={source.id} className="hover:bg-gray-50">
                          <td className="px-4 py-3 font-medium">{source.supplier_name}</td>
                          <td className="px-4 py-3">{source.grade}</td>
                          <td className="px-4 py-3">
                            {source.documents.length === 0 ? (
                              <span className="text-gray-400 text-sm">No documents</span>
                            ) : (
                              <div className="space-y-1">
                                {source.documents.map((doc: SourceDocument) => (
                                  <div
                                    key={doc.id}
                                    className="flex items-center gap-2 text-sm"
                                  >
                                    <span className="flex-1 text-gray-700 truncate text-xs">{doc.original_filename}</span>
                                    <div className="flex items-center gap-1 flex-shrink-0">
                                      <button
                                        onClick={() => viewDocument(doc.file_url, doc.original_filename)}
                                        className="p-1 text-blue-600 hover:bg-blue-50 rounded"
                                        title="View"
                                      >
                                        <Eye className="w-3.5 h-3.5" />
                                      </button>
                                      <button
                                        onClick={() => downloadDocument(doc.file_url, doc.original_filename)}
                                        className="p-1 text-green-600 hover:bg-green-50 rounded"
                                        title="Download"
                                      >
                                        <Download className="w-3.5 h-3.5" />
                                      </button>
                                      <button
                                        onClick={() => deleteDocument(doc.id, source.id)}
                                        className="p-1 text-red-600 hover:bg-red-50 rounded"
                                        title="Delete"
                                      >
                                        <Trash2 className="w-3.5 h-3.5" />
                                      </button>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}
      </Modal>

      {/* Inline Document Viewer Modal */}
      {showDocModal && (
        <Modal
          isOpen={showDocModal}
          onClose={() => {
            setShowDocModal(false);
            setDocViewUrl(null);
            setDocViewName('');
            if (docBlobUrl) { URL.revokeObjectURL(docBlobUrl); setDocBlobUrl(null); }
          }}
          title={docViewName || 'Document'}
          size="xl"
        >
          <div className="flex flex-col gap-2" style={{ height: '75vh' }}>
            <div className="flex justify-end gap-2">
              {docViewUrl && (
                <button
                  onClick={() => downloadDocument(docViewUrl, docViewName)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs text-green-700 border border-green-200 rounded-lg hover:bg-green-50 transition"
                >
                  <Download className="w-3.5 h-3.5" />
                  Download
                </button>
              )}
            </div>
            {docLoading && (
              <div className="flex-1 flex items-center justify-center bg-gray-50 rounded-lg border border-gray-200">
                <div className="text-center text-gray-500">
                  <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-2" />
                  <p className="text-sm">Loading document...</p>
                </div>
              </div>
            )}
            {!docLoading && docBlobUrl && (
              <iframe
                src={docBlobUrl}
                className="flex-1 w-full rounded-lg border border-gray-200"
                title={docViewName}
              />
            )}
            {!docLoading && !docBlobUrl && (
              <div className="flex-1 flex items-center justify-center bg-gray-50 rounded-lg border border-gray-200">
                <div className="text-center text-gray-500 px-6">
                  <FileText className="w-10 h-10 mx-auto mb-3 text-gray-400" />
                  <p className="text-sm font-medium mb-2">Document cannot be previewed</p>
                  <p className="text-xs text-gray-400 mb-5">The file may have been moved or the storage bucket is not accessible.</p>
                  {docViewUrl && (
                    <button
                      onClick={() => downloadDocument(docViewUrl, docViewName)}
                      className="inline-flex items-center gap-1.5 px-4 py-2 bg-green-600 text-white text-sm rounded-lg hover:bg-green-700 transition"
                    >
                      <Download className="w-4 h-4" />
                      Try Download
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        </Modal>
      )}
    </Layout>
  );
}
