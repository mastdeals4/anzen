import { useEffect, useState } from 'react';
import { Layout } from '../components/Layout';
import { DataTable } from '../components/DataTable';
import { Modal } from '../components/Modal';
import { useLanguage } from '../contexts/LanguageContext';
import { useAuth } from '../contexts/AuthContext';
import { supabase } from '../lib/supabase';
import { Plus, Edit, Trash2, FileText, ExternalLink, Upload, X } from 'lucide-react';

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
  total_quantity: number | null;
  per_pack_weight: number | null;
  pack_type: string | null;
  calculated_packs: number | null;
  is_active: boolean;
  created_at: string;
  document_count?: number;
}

interface ProductDocument {
  id: string;
  file_url: string;
  file_name: string;
  document_type: string;
  file_size: number;
  uploaded_at: string;
}

export function Products() {
  const { t } = useLanguage();
  const { profile } = useAuth();
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [documentsModalOpen, setDocumentsModalOpen] = useState(false);
  const [uploadModalOpen, setUploadModalOpen] = useState(false);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [selectedProductDocs, setSelectedProductDocs] = useState<ProductDocument[]>([]);
  const [selectedProductId, setSelectedProductId] = useState<string | null>(null);
  const [selectedProductName, setSelectedProductName] = useState<string>('');
  const [uploadingFiles, setUploadingFiles] = useState<any[]>([]);
  const [formUploadingFiles, setFormUploadingFiles] = useState<any[]>([]);
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

      const productsWithDocCount = await Promise.all(
        (data || []).map(async (product) => {
          const { count } = await supabase
            .from('product_documents')
            .select('*', { count: 'exact', head: true })
            .eq('product_id', product.id);

          return { ...product, document_count: count || 0 };
        })
      );

      setProducts(productsWithDocCount);
    } catch (error) {
      console.error('Error loading products:', error);
    } finally {
      setLoading(false);
    }
  };

  const loadProductDocuments = async (productId: string, productName: string) => {
    try {
      const { data, error } = await supabase
        .from('product_documents')
        .select('*')
        .eq('product_id', productId)
        .order('uploaded_at', { ascending: false });

      if (error) throw error;
      setSelectedProductDocs(data || []);
      setSelectedProductId(productId);
      setSelectedProductName(productName);
      setDocumentsModalOpen(true);
    } catch (error) {
      console.error('Error loading documents:', error);
      alert('Failed to load documents');
    }
  };

  const handleUploadFiles = async () => {
    if (!selectedProductId || uploadingFiles.length === 0) {
      alert('Please select files to upload');
      return;
    }

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      let successCount = 0;

      for (const fileData of uploadingFiles) {
        try {
          const fileName = `${Date.now()}_${fileData.file.name}`;
          const filePath = `${selectedProductId}/${fileName}`;

          console.log('Uploading file:', fileName, 'Type:', fileData.document_type);

          const { error: uploadError } = await supabase.storage
            .from('product-documents')
            .upload(filePath, fileData.file);

          if (uploadError) {
            console.error('Storage upload error:', uploadError);
            throw uploadError;
          }

          const { data: { publicUrl } } = supabase.storage
            .from('product-documents')
            .getPublicUrl(filePath);

          console.log('File uploaded, inserting DB record...');

          const { error: dbError } = await supabase
            .from('product_documents')
            .insert([{
              product_id: selectedProductId,
              file_url: publicUrl,
              file_name: fileData.file.name,
              document_type: fileData.document_type || 'other',
              file_size: fileData.file.size,
              uploaded_by: user.id,
            }]);

          if (dbError) {
            console.error('Database insert error:', dbError);
            throw dbError;
          }

          successCount++;
        } catch (fileError: any) {
          console.error(`Failed to upload ${fileData.file.name}:`, fileError);
          alert(`Failed to upload ${fileData.file.name}: ${fileError.message}`);
        }
      }

      setUploadModalOpen(false);
      setUploadingFiles([]);

      if (successCount > 0) {
        await loadProductDocuments(selectedProductId, selectedProductName);
        await loadProducts();
        alert(`Successfully uploaded ${successCount} document(s)`);
      }
    } catch (error: any) {
      console.error('Error uploading files:', error);
      alert('Failed to upload documents: ' + error.message);
    }
  };

  const handleDeleteDocument = async (docId: string) => {
    if (!confirm('Are you sure you want to delete this document?')) return;

    try {
      const { error } = await supabase
        .from('product_documents')
        .delete()
        .eq('id', docId);

      if (error) throw error;

      alert('Document deleted successfully');
      if (selectedProductId) {
        loadProductDocuments(selectedProductId, selectedProductName);
        loadProducts();
      }
    } catch (error: any) {
      console.error('Error deleting document:', error);
      alert('Failed to delete document: ' + error.message);
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
        duty_a1: formData.duty_a1 || null,
      };

      let productId: string;

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

      // Upload documents if any
      if (formUploadingFiles.length > 0) {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) throw new Error('Not authenticated');

        for (const fileData of formUploadingFiles) {
          try {
            const fileName = `${Date.now()}_${fileData.file.name}`;
            const filePath = `${productId}/${fileName}`;

            console.log('Uploading document:', fileName, 'Type:', fileData.document_type);

            const { error: uploadError } = await supabase.storage
              .from('product-documents')
              .upload(filePath, fileData.file);

            if (uploadError) {
              console.error('Storage error:', uploadError);
              throw uploadError;
            }

            const { data: { publicUrl } } = supabase.storage
              .from('product-documents')
              .getPublicUrl(filePath);

            console.log('Inserting DB record for:', fileData.file.name);

            const { error: dbError } = await supabase
              .from('product_documents')
              .insert([{
                product_id: productId,
                file_url: publicUrl,
                file_name: fileData.file.name,
                document_type: fileData.document_type || 'other',
                file_size: fileData.file.size,
                uploaded_by: user.id,
              }]);

            if (dbError) {
              console.error('DB error:', dbError);
              throw dbError;
            }

            console.log('Successfully uploaded:', fileData.file.name);
          } catch (docError: any) {
            console.error(`Failed to upload document ${fileData.file.name}:`, docError);
            alert(`Warning: Failed to upload ${fileData.file.name}: ${docError.message}`);
          }
        }
      }

      setModalOpen(false);
      resetForm();
      loadProducts();

      const successMessage = editingProduct
        ? 'Product updated successfully'
        : formUploadingFiles.length > 0
          ? `Product created successfully with ${formUploadingFiles.length} document(s)`
          : 'Product created successfully';
      alert(successMessage);
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
      duty_a1: product.duty_a1 || '',
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
    setFormUploadingFiles([]);
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
      key: 'duty_a1',
      label: 'Duty - A1',
      render: (product: Product) => (
        <span className="text-sm text-gray-700">{product.duty_a1 || '-'}</span>
      ),
    },
    {
      key: 'min_stock',
      label: 'Min Stock Level',
      render: (product: Product) => (
        <span>{product.min_stock_level ? `${product.min_stock_level} ${product.unit}` : '-'}</span>
      ),
    },
    {
      key: 'documents',
      label: 'Docs',
      render: (product: Product) => (
        <button
          onClick={() => loadProductDocuments(product.id, product.product_name)}
          className="flex items-center gap-1 px-2 py-1 bg-blue-50 text-blue-600 rounded hover:bg-blue-100 transition"
        >
          <FileText className="w-4 h-4" />
          <span className="text-sm font-medium">{product.document_count || 0}</span>
        </button>
      )
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
                Duty - A1
              </label>
              <input
                type="text"
                value={formData.duty_a1}
                onChange={(e) =>
                  setFormData({ ...formData, duty_a1: e.target.value })
                }
                placeholder="e.g., 10% + Social Welfare Surcharge"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none"
              />
              <p className="text-xs text-gray-500 mt-1">Import duty rate or information</p>
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
                <optgroup label="Weight">
                  <option value="mg">Milligram (mg)</option>
                  <option value="g">Gram (g)</option>
                  <option value="kg">Kilogram (kg)</option>
                  <option value="ton">Ton</option>
                </optgroup>
                <optgroup label="Volume">
                  <option value="ml">Millilitre (ml)</option>
                  <option value="litre">Litre</option>
                </optgroup>
                <optgroup label="Count/Package">
                  <option value="piece">Piece</option>
                  <option value="bottle">Bottle</option>
                  <option value="box">Box</option>
                  <option value="pack">Pack</option>
                </optgroup>
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

          <div className="border-t pt-4">
            <label className="block text-sm font-medium text-gray-700 mb-2">
              <FileText className="w-4 h-4 inline mr-1" />
              Product Documents (COA, MSDS, Specifications)
            </label>
            <div className="p-4 bg-blue-50 border border-blue-200 rounded-lg mb-3">
              <p className="text-xs text-blue-800">
                Upload reference documents for this product (applies to all batches):
              </p>
              <ul className="mt-1 text-xs text-blue-700 space-y-0.5 ml-4 list-disc">
                <li><strong>COA:</strong> Certificate of Analysis template</li>
                <li><strong>MSDS:</strong> Material Safety Data Sheet</li>
                <li><strong>TDS:</strong> Technical Data Sheet</li>
                <li><strong>Specification:</strong> Product specifications</li>
              </ul>
            </div>

            {formUploadingFiles.length > 0 && (
              <div className="mb-3 space-y-2">
                <p className="text-xs text-gray-600 font-medium">Files to Upload:</p>
                {formUploadingFiles.map((file, index) => (
                  <div key={index} className="flex items-center gap-3 p-3 bg-gray-50 border border-gray-200 rounded-lg">
                    <FileText className="w-5 h-5 text-gray-600 flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-900 truncate">{file.file.name}</p>
                      <p className="text-xs text-gray-500">{(file.file.size / 1024).toFixed(1)} KB</p>
                    </div>
                    <select
                      value={file.document_type}
                      onChange={(e) => {
                        const newFiles = [...formUploadingFiles];
                        newFiles[index].document_type = e.target.value;
                        setFormUploadingFiles(newFiles);
                      }}
                      className="px-2 py-1 text-sm border border-gray-300 rounded"
                    >
                      <option value="coa">COA (Certificate of Analysis)</option>
                      <option value="msds">MSDS (Material Safety Data Sheet)</option>
                      <option value="tds">TDS (Technical Data Sheet)</option>
                      <option value="specification">Product Specification</option>
                      <option value="regulatory">Regulatory Documents</option>
                      <option value="test_certificate">Test Certificate</option>
                      <option value="stability_study">Stability Study</option>
                      <option value="gmp_certificate">GMP Certificate</option>
                      <option value="dmf">DMF (Drug Master File)</option>
                      <option value="other">Other</option>
                    </select>
                    <button
                      type="button"
                      onClick={() => setFormUploadingFiles(formUploadingFiles.filter((_, i) => i !== index))}
                      className="p-1 text-red-600 hover:bg-red-50 rounded"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div
              onClick={() => document.getElementById('product-file-input')?.click()}
              className="border-2 border-dashed border-gray-300 rounded-lg p-6 text-center cursor-pointer hover:border-blue-400 transition"
            >
              <Upload className="w-10 h-10 mx-auto mb-2 text-gray-400" />
              <p className="text-sm text-gray-600">
                <span className="font-medium text-blue-600">Click to upload</span> or drag files
              </p>
              <p className="text-xs text-gray-500 mt-1">
                PDF, DOCX, XLSX, PNG, JPG (max 10MB per file)
              </p>
              <input
                id="product-file-input"
                type="file"
                multiple
                accept=".pdf,.doc,.docx,.xls,.xlsx,.png,.jpg,.jpeg"
                onChange={(e) => {
                  const files = e.target.files;
                  if (!files) return;

                  const newFiles = Array.from(files).map((file) => ({
                    file,
                    document_type: 'coa',
                  }));
                  setFormUploadingFiles([...formUploadingFiles, ...newFiles]);
                  e.target.value = '';
                }}
                className="hidden"
              />
            </div>
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

      <Modal
        isOpen={documentsModalOpen}
        onClose={() => {
          setDocumentsModalOpen(false);
          setSelectedProductDocs([]);
          setSelectedProductId(null);
          setSelectedProductName('');
        }}
        title={`Product Documents - ${selectedProductName}`}
      >
        <div className="space-y-3">
          <div className="flex justify-between items-center">
            <p className="text-sm text-gray-600">
              Product-level documents (COA, MSDS, Specifications, etc.)
            </p>
            <button
              onClick={() => {
                setUploadingFiles([]);
                setUploadModalOpen(true);
              }}
              className="flex items-center gap-2 px-3 py-1.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm"
            >
              <Upload className="w-4 h-4" />
              Upload
            </button>
          </div>

          {selectedProductDocs.length > 0 ? (
            selectedProductDocs.map((doc) => (
              <div
                key={doc.id}
                className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg border border-gray-200 hover:bg-blue-50 hover:border-blue-300 transition"
              >
                <FileText className="w-5 h-5 text-blue-600 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-900 truncate">{doc.file_name}</p>
                  <div className="flex items-center gap-2 text-xs text-gray-500 mt-1">
                    <span className="capitalize">{doc.document_type.replace('_', ' ')}</span>
                    <span>•</span>
                    <span>{(doc.file_size / 1024).toFixed(1)} KB</span>
                    <span>•</span>
                    <span>{new Date(doc.uploaded_at).toLocaleDateString()}</span>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <a
                    href={doc.file_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="p-1.5 text-blue-600 hover:bg-blue-100 rounded"
                  >
                    <ExternalLink className="w-4 h-4" />
                  </a>
                  <button
                    onClick={() => handleDeleteDocument(doc.id)}
                    className="p-1.5 text-red-600 hover:bg-red-100 rounded"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            ))
          ) : (
            <div className="text-center py-8 text-gray-500">
              <FileText className="w-12 h-12 mx-auto mb-3 text-gray-300" />
              <p>No documents uploaded for this product</p>
              <p className="text-xs mt-1">Click "Upload" to add COA, MSDS, or other documents</p>
            </div>
          )}
        </div>
      </Modal>

      <Modal
        isOpen={uploadModalOpen}
        onClose={() => {
          setUploadModalOpen(false);
          setUploadingFiles([]);
        }}
        title="Upload Product Documents"
        maxWidth="max-w-2xl"
      >
        <div className="space-y-4">
          <div className="p-4 bg-blue-50 border border-blue-200 rounded-lg">
            <p className="text-sm text-blue-900">
              <strong>Product-level documents</strong> are reference documents needed to sell APIs:
            </p>
            <ul className="mt-2 text-xs text-blue-800 space-y-1 ml-4 list-disc">
              <li><strong>COA:</strong> Certificate of Analysis (template/reference)</li>
              <li><strong>MSDS:</strong> Material Safety Data Sheet</li>
              <li><strong>TDS:</strong> Technical Data Sheet</li>
              <li><strong>Specification:</strong> Product specifications</li>
              <li><strong>Regulatory:</strong> Regulatory documents (DMF, CEP, etc.)</li>
              <li><strong>Test Certificate:</strong> Testing and quality certificates</li>
              <li><strong>GMP Certificate:</strong> Good Manufacturing Practice certificate</li>
              <li><strong>Stability Study:</strong> Stability study reports</li>
            </ul>
          </div>

          {uploadingFiles.map((file, index) => (
            <div key={index} className="flex items-center gap-3 p-3 bg-gray-50 border border-gray-200 rounded-lg">
              <FileText className="w-5 h-5 text-gray-600 flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-900 truncate">{file.file.name}</p>
                <p className="text-xs text-gray-500">{(file.file.size / 1024).toFixed(1)} KB</p>
              </div>
              <select
                value={file.document_type}
                onChange={(e) => {
                  const newFiles = [...uploadingFiles];
                  newFiles[index].document_type = e.target.value;
                  setUploadingFiles(newFiles);
                }}
                className="px-2 py-1 text-sm border border-gray-300 rounded"
              >
                <option value="coa">COA (Certificate of Analysis)</option>
                <option value="msds">MSDS (Material Safety Data Sheet)</option>
                <option value="tds">TDS (Technical Data Sheet)</option>
                <option value="specification">Product Specification</option>
                <option value="regulatory">Regulatory Documents</option>
                <option value="test_certificate">Test Certificate</option>
                <option value="stability_study">Stability Study</option>
                <option value="gmp_certificate">GMP Certificate</option>
                <option value="dmf">DMF (Drug Master File)</option>
                <option value="other">Other</option>
              </select>
              <button
                onClick={() => setUploadingFiles(uploadingFiles.filter((_, i) => i !== index))}
                className="p-1 text-red-600 hover:bg-red-50 rounded"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          ))}

          <div
            onClick={() => document.getElementById('product-upload-input')?.click()}
            className="border-2 border-dashed border-gray-300 rounded-lg p-6 text-center cursor-pointer hover:border-blue-400 transition"
          >
            <Upload className="w-10 h-10 mx-auto mb-2 text-gray-400" />
            <p className="text-sm text-gray-600">
              <span className="font-medium text-blue-600">Click to upload</span> documents
            </p>
            <p className="text-xs text-gray-500 mt-1">
              PDF, DOCX, XLSX, PNG, JPG (max 10MB per file)
            </p>
            <input
              id="product-upload-input"
              type="file"
              multiple
              accept=".pdf,.doc,.docx,.xls,.xlsx,.png,.jpg,.jpeg"
              onChange={(e) => {
                const files = e.target.files;
                if (!files) return;

                const newFiles = Array.from(files).map((file) => ({
                  file,
                  document_type: 'coa',
                }));
                setUploadingFiles([...uploadingFiles, ...newFiles]);
                e.target.value = '';
              }}
              className="hidden"
            />
          </div>

          <div className="flex justify-end gap-3 pt-4 border-t">
            <button
              onClick={() => {
                setUploadModalOpen(false);
                setUploadingFiles([]);
              }}
              className="px-4 py-2 text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200"
            >
              Cancel
            </button>
            <button
              onClick={handleUploadFiles}
              disabled={uploadingFiles.length === 0}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Upload {uploadingFiles.length} {uploadingFiles.length === 1 ? 'Document' : 'Documents'}
            </button>
          </div>
        </div>
      </Modal>
    </Layout>
  );
}
