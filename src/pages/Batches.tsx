import { useEffect, useState } from 'react';
import { Layout } from '../components/Layout';
import { DataTable } from '../components/DataTable';
import { Modal } from '../components/Modal';
import { FileUpload } from '../components/FileUpload';
import { useLanguage } from '../contexts/LanguageContext';
import { useAuth } from '../contexts/AuthContext';
import { supabase } from '../lib/supabase';
import { Plus, Edit, Trash2, AlertTriangle, Package, DollarSign, FileText, ExternalLink } from 'lucide-react';

interface Batch {
  id: string;
  batch_number: string;
  product_id: string;
  import_date: string;
  import_quantity: number;
  current_stock: number;
  reserved_stock: number;
  packaging_details: string;
  import_price: number;
  import_price_usd: number | null;
  exchange_rate_usd_to_idr: number | null;
  duty_charges: number;
  freight_charges: number;
  other_charges: number;
  expiry_date: string;
  is_active: boolean;
  products?: {
    product_name: string;
    product_code: string;
    unit: string;
  };
  document_count?: number;
}

interface Product {
  id: string;
  product_name: string;
  product_code: string;
  unit: string;
}


interface BatchDocument {
  id: string;
  file_url: string;
  file_name: string;
  file_type: string;
  file_size: number;
  uploaded_at: string;
}

export function Batches() {
  const { t } = useLanguage();
  const { profile } = useAuth();
  const [batches, setBatches] = useState<Batch[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [documentsModalOpen, setDocumentsModalOpen] = useState(false);
  const [selectedBatchDocs, setSelectedBatchDocs] = useState<BatchDocument[]>([]);
  const [selectedBatchId, setSelectedBatchId] = useState<string | null>(null);
  const [editingBatch, setEditingBatch] = useState<Batch | null>(null);
  const [uploadedFiles, setUploadedFiles] = useState<any[]>([]);
  const [formData, setFormData] = useState({
    batch_number: '',
    product_id: '',
    import_date: '',
    import_quantity: 0,
    packaging_details: '',
    import_price_usd: 0,
    exchange_rate_usd_to_idr: 0,
    duty_charges: 0,
    duty_charge_type: 'fixed' as 'percentage' | 'fixed',
    freight_charges: 0,
    freight_charge_type: 'fixed' as 'percentage' | 'fixed',
    other_charges: 0,
    other_charge_type: 'fixed' as 'percentage' | 'fixed',
    expiry_date: '',
    per_pack_weight: '',
    pack_type: 'bag',
  });

  useEffect(() => {
    loadBatches();
    loadProducts();
  }, []);

  const loadBatches = async () => {
    try {
      const { data, error } = await supabase
        .from('batches')
        .select(`
          *,
          products(product_name, product_code, unit)
        `)
        .order('import_date', { ascending: false });

      if (error) throw error;

      const batchesWithDocCount = await Promise.all(
        (data || []).map(async (batch) => {
          const { count } = await supabase
            .from('batch_documents')
            .select('*', { count: 'exact', head: true })
            .eq('batch_id', batch.id);

          return { ...batch, document_count: count || 0 };
        })
      );

      setBatches(batchesWithDocCount);
    } catch (error) {
      console.error('Error loading batches:', error);
    } finally {
      setLoading(false);
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


  const loadBatchDocuments = async (batchId: string) => {
    try {
      const { data, error } = await supabase
        .from('batch_documents')
        .select('*')
        .eq('batch_id', batchId)
        .order('uploaded_at', { ascending: false });

      if (error) throw error;
      setSelectedBatchDocs(data || []);
      setSelectedBatchId(batchId);
      setDocumentsModalOpen(true);
    } catch (error) {
      console.error('Error loading documents:', error);
      alert('Failed to load documents');
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (formData.import_price_usd > 0 && formData.exchange_rate_usd_to_idr <= 0) {
      alert('Please enter a valid exchange rate');
      return;
    }

    try {
      // Calculate actual sold quantity from sales_invoice_items table
      let soldQuantity = 0;
      if (editingBatch) {
        const { data: salesData, error: salesError } = await supabase
          .from('sales_invoice_items')
          .select('quantity')
          .eq('batch_id', editingBatch.id);

        if (salesError) throw salesError;

        soldQuantity = salesData?.reduce((sum, item) => sum + parseFloat(item.quantity || 0), 0) || 0;

        // Validate that new import quantity is not less than sold quantity
        if (formData.import_quantity < soldQuantity) {
          alert(`Cannot reduce import quantity to ${formData.import_quantity}. You have already sold ${soldQuantity} units from this batch.`);
          return;
        }
      }

      const importPriceIDR = formData.import_price_usd * formData.exchange_rate_usd_to_idr;

      // Calculate actual charge amounts based on type
      const calculateCharge = (amount: number, type: 'percentage' | 'fixed', basePrice: number) => {
        if (type === 'percentage') {
          return (basePrice * amount) / 100;
        }
        return amount;
      };

      const dutyAmount = calculateCharge(formData.duty_charges, formData.duty_charge_type, importPriceIDR);
      const freightAmount = calculateCharge(formData.freight_charges, formData.freight_charge_type, importPriceIDR);
      const otherAmount = calculateCharge(formData.other_charges, formData.other_charge_type, importPriceIDR);

      // Calculate correct current stock
      // For new batches: current_stock = import_quantity (nothing sold yet)
      // For existing batches: current_stock = import_quantity - actual_sold_quantity
      const finalCurrentStock = formData.import_quantity - soldQuantity;

      const batchData = {
        batch_number: formData.batch_number,
        product_id: formData.product_id,
        import_date: formData.import_date,
        import_quantity: formData.import_quantity,
        current_stock: finalCurrentStock,
        packaging_details: formData.packaging_details,
        import_price: importPriceIDR,
        import_price_usd: formData.import_price_usd || null,
        exchange_rate_usd_to_idr: formData.exchange_rate_usd_to_idr || null,
        duty_charges: dutyAmount,
        duty_charge_type: formData.duty_charge_type,
        freight_charges: freightAmount,
        freight_charge_type: formData.freight_charge_type,
        other_charges: otherAmount,
        other_charge_type: formData.other_charge_type,
        expiry_date: formData.expiry_date || null,
      };

      let batchId: string;

      if (editingBatch) {
        const { error } = await supabase
          .from('batches')
          .update(batchData)
          .eq('id', editingBatch.id);

        if (error) throw error;
        batchId = editingBatch.id;
      } else {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) throw new Error('Not authenticated');

        const { data, error } = await supabase
          .from('batches')
          .insert([{ ...batchData, is_active: true, created_by: user.id }])
          .select()
          .single();

        if (error) throw error;
        batchId = data.id;
      }

      await uploadFilesToBatch(batchId);

      setModalOpen(false);
      resetForm();
      loadBatches();
    } catch (error) {
      console.error('Error saving batch:', error);
      alert('Failed to save batch. Please try again.');
    }
  };

  const uploadFilesToBatch = async (batchId: string) => {
    const filesToUpload = uploadedFiles.filter(f => f.file && !f.id);

    for (const fileData of filesToUpload) {
      try {
        const fileName = `${Date.now()}_${fileData.file.name}`;
        const filePath = `${batchId}/${fileName}`;

        const { error: uploadError } = await supabase.storage
          .from('batch-documents')
          .upload(filePath, fileData.file);

        if (uploadError) throw uploadError;

        const { data: { publicUrl } } = supabase.storage
          .from('batch-documents')
          .getPublicUrl(filePath);

        const { error: dbError } = await supabase
          .from('batch_documents')
          .insert([{
            batch_id: batchId,
            file_url: publicUrl,
            file_name: fileData.file.name,
            file_type: fileData.file_type,
            file_size: fileData.file_size,
          }]);

        if (dbError) throw dbError;
      } catch (error) {
        console.error('Error uploading file:', error);
      }
    }
  };

  const handleEdit = async (batch: Batch) => {
    // Calculate actual sold quantity from sales records
    const { data: salesData } = await supabase
      .from('sales_invoice_items')
      .select('quantity')
      .eq('batch_id', batch.id);

    const actualSoldQuantity = salesData?.reduce((sum, item) => sum + parseFloat(item.quantity || 0), 0) || 0;

    // Update the batch object with correct current_stock based on actual sales
    const correctedBatch = {
      ...batch,
      current_stock: batch.import_quantity - actualSoldQuantity
    };

    setEditingBatch(correctedBatch);

    // Parse packaging details to extract per_pack_weight and pack_type
    let perPackWeight = '';
    let packType = 'bag';
    if (batch.packaging_details) {
      const match = batch.packaging_details.match(/(\d+)\s+(\w+)s?\s+x\s+(\d+(?:\.\d+)?)kg/);
      if (match) {
        perPackWeight = match[3];
        packType = match[2].toLowerCase();
      }
    }

    setFormData({
      batch_number: batch.batch_number,
      product_id: batch.product_id,
      import_date: batch.import_date,
      import_quantity: batch.import_quantity,
      packaging_details: batch.packaging_details,
      import_price_usd: batch.import_price_usd || 0,
      exchange_rate_usd_to_idr: batch.exchange_rate_usd_to_idr || 0,
      duty_charges: batch.duty_charges,
      duty_charge_type: 'fixed',
      freight_charges: batch.freight_charges,
      freight_charge_type: 'fixed',
      other_charges: batch.other_charges,
      other_charge_type: 'fixed',
      expiry_date: batch.expiry_date,
      per_pack_weight: perPackWeight,
      pack_type: packType,
    });

    const { data: docs } = await supabase
      .from('batch_documents')
      .select('*')
      .eq('batch_id', batch.id);

    setUploadedFiles(docs || []);
    setModalOpen(true);
  };

  const handleDelete = async (id: string) => {
    try {
      const { data: salesItems } = await supabase
        .from('sales_invoice_items')
        .select('id, sales_invoices(invoice_number)')
        .eq('batch_id', id)
        .limit(1);

      if (salesItems && salesItems.length > 0) {
        alert('Cannot delete this batch. It has been used in sales invoices. Please delete the related invoices first or contact your administrator.');
        return;
      }

      const { data: challanItems } = await supabase
        .from('delivery_challan_items')
        .select('id')
        .eq('batch_id', id)
        .limit(1);

      if (challanItems && challanItems.length > 0) {
        alert('Cannot delete this batch. It has been used in delivery challans. Please delete the related delivery challans first.');
        return;
      }

      if (!confirm('Are you sure you want to delete this batch? This will permanently remove all related data.')) return;

      const { error: docsError } = await supabase
        .from('batch_documents')
        .delete()
        .eq('batch_id', id);

      if (docsError) throw docsError;

      const { error: txError } = await supabase
        .from('inventory_transactions')
        .delete()
        .eq('batch_id', id);

      if (txError) throw txError;

      const { error: expensesError } = await supabase
        .from('finance_expenses')
        .delete()
        .eq('batch_id', id);

      if (expensesError) throw expensesError;

      const { error } = await supabase
        .from('batches')
        .delete()
        .eq('id', id);

      if (error) throw error;

      alert('Batch deleted successfully');
      await loadBatches();
    } catch (error: any) {
      console.error('Error deleting batch:', error);
      const errorMessage = error?.message || 'Unknown error occurred';
      alert(`Failed to delete batch: ${errorMessage}`);
    }
  };

  const resetForm = () => {
    setEditingBatch(null);
    setUploadedFiles([]);
    setFormData({
      batch_number: '',
      product_id: '',
      import_date: '',
      import_quantity: 0,
      packaging_details: '',
      import_price_usd: 0,
      exchange_rate_usd_to_idr: 0,
      duty_charges: 0,
      duty_charge_type: 'fixed',
      freight_charges: 0,
      freight_charge_type: 'fixed',
      other_charges: 0,
      other_charge_type: 'fixed',
      expiry_date: '',
      per_pack_weight: '',
      pack_type: 'bag',
    });
  };

  const isLowStock = (batch: Batch) => batch.current_stock < batch.import_quantity * 0.2;
  const isExpired = (batch: Batch) => {
    if (!batch.expiry_date) return false;
    return new Date(batch.expiry_date) < new Date();
  };
  const isNearExpiry = (batch: Batch) => {
    if (!batch.expiry_date) return false;
    const thirtyDaysFromNow = new Date();
    thirtyDaysFromNow.setDate(thirtyDaysFromNow.getDate() + 30);
    return new Date(batch.expiry_date) <= thirtyDaysFromNow && !isExpired(batch);
  };

  const calculateTotalCostIDR = () => {
    const importPriceIDR = formData.import_price_usd * formData.exchange_rate_usd_to_idr;

    const calculateCharge = (amount: number, type: 'percentage' | 'fixed') => {
      if (type === 'percentage') {
        return (importPriceIDR * amount) / 100;
      }
      return amount;
    };

    const dutyAmount = calculateCharge(formData.duty_charges, formData.duty_charge_type);
    const freightAmount = calculateCharge(formData.freight_charges, formData.freight_charge_type);
    const otherAmount = calculateCharge(formData.other_charges, formData.other_charge_type);

    return importPriceIDR + dutyAmount + freightAmount + otherAmount;
  };

  const getChargeAmount = (amount: number, type: 'percentage' | 'fixed') => {
    const importPriceIDR = formData.import_price_usd * formData.exchange_rate_usd_to_idr;
    if (type === 'percentage') {
      return (importPriceIDR * amount) / 100;
    }
    return amount;
  };

  const formatCurrency = (amount: number, currency: 'USD' | 'IDR' = 'IDR') => {
    if (currency === 'USD') {
      return `$${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    }
    return `Rp ${amount.toLocaleString('id-ID', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
  };

  const columns = [
    { key: 'batch_number', label: 'Batch Number' },
    {
      key: 'product',
      label: 'Product',
      render: (batch: Batch) => (
        <div>
          <div className="font-medium">{batch.products?.product_name}</div>
          <div className="text-xs text-gray-500">{batch.products?.product_code}</div>
        </div>
      )
    },
    {
      key: 'import_date',
      label: 'Import Date',
      render: (batch: Batch) => new Date(batch.import_date).toLocaleDateString()
    },
    {
      key: 'stock',
      label: 'Stock',
      render: (batch: Batch) => {
        const freeStock = batch.current_stock - (batch.reserved_stock || 0);
        return (
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <span className={isLowStock(batch) ? 'text-orange-600 font-semibold' : 'font-medium'}>
                {batch.current_stock} {batch.products?.unit}
              </span>
              {isLowStock(batch) && (
                <AlertTriangle className="w-4 h-4 text-orange-600" />
              )}
            </div>
            {batch.reserved_stock > 0 && (
              <div className="text-xs space-y-0.5">
                <div className="text-amber-600">
                  Reserved: {batch.reserved_stock} {batch.products?.unit}
                </div>
                <div className="text-green-600">
                  Free: {freeStock} {batch.products?.unit}
                </div>
              </div>
            )}
          </div>
        );
      }
    },
    {
      key: 'pricing',
      label: 'Import Price',
      render: (batch: Batch) => (
        <div className="text-sm">
          {batch.import_price_usd && batch.exchange_rate_usd_to_idr ? (
            <>
              <div className="font-medium text-green-700">
                {formatCurrency(batch.import_price_usd, 'USD')}
              </div>
              <div className="text-xs text-gray-500">
                {formatCurrency(batch.import_price)}
              </div>
              <div className="text-xs text-gray-400">
                @ {batch.exchange_rate_usd_to_idr.toLocaleString()}
              </div>
            </>
          ) : (
            <div className="text-gray-500">{formatCurrency(batch.import_price)}</div>
          )}
        </div>
      )
    },
    {
      key: 'expiry_date',
      label: 'Expiry Date',
      render: (batch: Batch) => (
        <span className={
          isExpired(batch) ? 'text-red-700 font-semibold' :
          isNearExpiry(batch) ? 'text-orange-600 font-semibold' : ''
        }>
          {batch.expiry_date ? new Date(batch.expiry_date).toLocaleDateString() : 'N/A'}
        </span>
      )
    },
    {
      key: 'documents',
      label: 'Docs',
      render: (batch: Batch) => (
        <button
          onClick={() => loadBatchDocuments(batch.id)}
          className="flex items-center gap-1 px-2 py-1 bg-blue-50 text-blue-600 rounded hover:bg-blue-100 transition"
        >
          <FileText className="w-4 h-4" />
          <span className="text-sm font-medium">{batch.document_count || 0}</span>
        </button>
      )
    },
    {
      key: 'total_cost',
      label: 'Total Cost',
      render: (batch: Batch) => {
        const total = batch.import_price + batch.duty_charges + batch.freight_charges + batch.other_charges;
        return <span className="font-medium">{formatCurrency(total)}</span>;
      }
    },
  ];

  const canEdit = profile?.role === 'admin' || profile?.role === 'warehouse' || profile?.role === 'accounts';

  return (
    <Layout>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-gray-900">Import Batches</h1>
            <p className="text-gray-600 mt-1">Manage import batches with USD pricing and document tracking</p>
          </div>
          {canEdit && (
            <button
              onClick={() => {
                resetForm();
                setModalOpen(true);
              }}
              className="flex items-center gap-2 bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 transition"
            >
              <Plus className="w-5 h-5" />
              Add Batch
            </button>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="bg-white rounded-lg shadow p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-gray-600">Total Batches</p>
                <p className="text-2xl font-bold text-gray-900 mt-1">{batches.length}</p>
              </div>
              <Package className="w-8 h-8 text-blue-600" />
            </div>
          </div>

          <div className="bg-orange-50 rounded-lg shadow p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-orange-600">Low Stock</p>
                <p className="text-2xl font-bold text-orange-600 mt-1">
                  {batches.filter(isLowStock).length}
                </p>
              </div>
              <AlertTriangle className="w-8 h-8 text-orange-600" />
            </div>
          </div>

          <div className="bg-red-50 rounded-lg shadow p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-red-600">Near Expiry</p>
                <p className="text-2xl font-bold text-red-600 mt-1">
                  {batches.filter(isNearExpiry).length}
                </p>
              </div>
              <AlertTriangle className="w-8 h-8 text-red-600" />
            </div>
          </div>
        </div>

        <DataTable
          columns={columns}
          data={batches}
          loading={loading}
          actions={canEdit ? (batch) => (
            <div className="flex items-center gap-2">
              <button
                onClick={() => handleEdit(batch)}
                className="p-1 text-blue-600 hover:bg-blue-50 rounded"
              >
                <Edit className="w-4 h-4" />
              </button>
              <button
                onClick={() => handleDelete(batch.id)}
                className="p-1 text-red-600 hover:bg-red-50 rounded"
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
          title={editingBatch ? 'Edit Batch' : 'Add New Batch'}
        >
          <form onSubmit={handleSubmit} className="space-y-3">
            <div className="border-b pb-2">
              <h3 className="text-sm font-semibold text-gray-900 mb-2">Basic Information</h3>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">
                    Batch Number *
                  </label>
                  <input
                    type="text"
                    value={formData.batch_number}
                    onChange={(e) => setFormData({ ...formData, batch_number: e.target.value })}
                    className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded focus:ring-1 focus:ring-blue-500"
                    required
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">
                    Product *
                  </label>
                  <select
                    value={formData.product_id}
                    onChange={(e) => setFormData({ ...formData, product_id: e.target.value })}
                    className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded focus:ring-1 focus:ring-blue-500"
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

                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">
                    Import Date *
                  </label>
                  <input
                    type="date"
                    value={formData.import_date}
                    onChange={(e) => setFormData({ ...formData, import_date: e.target.value })}
                    className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded focus:ring-1 focus:ring-blue-500"
                    required
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">
                    Expiry Date
                  </label>
                  <input
                    type="date"
                    value={formData.expiry_date}
                    onChange={(e) => setFormData({ ...formData, expiry_date: e.target.value })}
                    className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded focus:ring-1 focus:ring-blue-500"
                  />
                </div>
              </div>
            </div>

            <div className="border-b pb-2">
              <h3 className="text-sm font-semibold text-gray-900 mb-2">Quantity</h3>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">
                    Import Quantity *
                  </label>
                  <input
                    type="number"
                    value={formData.import_quantity === 0 ? '' : formData.import_quantity}
                    onChange={(e) => setFormData({ ...formData, import_quantity: e.target.value === '' ? 0 : Number(e.target.value) })}
                    className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded focus:ring-1 focus:ring-blue-500"
                    required
                    min="0"
                    step="0.001"
                    placeholder="0"
                  />
                  <p className="text-xs text-gray-500 mt-0.5">Total quantity being imported</p>
                </div>

                {editingBatch && (
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">
                      Current Stock
                    </label>
                    <div className="w-full px-2 py-1.5 text-sm border border-gray-200 rounded bg-gray-50">
                      <span className="text-gray-700 font-medium">{editingBatch.current_stock.toLocaleString()}</span>
                    </div>
                    <p className="text-xs text-gray-500 mt-0.5">
                      Available: {editingBatch.current_stock.toLocaleString()} |
                      Sold: {(editingBatch.import_quantity - editingBatch.current_stock).toLocaleString()}
                    </p>
                  </div>
                )}
              </div>
            </div>

            <div className="border-b pb-2">
              <h3 className="text-sm font-semibold text-gray-900 mb-2 flex items-center gap-2">
                <Package className="w-4 h-4" />
                Packaging Details (Optional)
              </h3>
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">
                    Per Pack Weight
                  </label>
                  <input
                    type="number"
                    step="0.001"
                    value={formData.per_pack_weight}
                    onChange={(e) => {
                      const newFormData = { ...formData, per_pack_weight: e.target.value };
                      if (formData.import_quantity && e.target.value) {
                        const perPack = parseFloat(e.target.value);
                        if (perPack) {
                          const packs = (formData.import_quantity / perPack).toFixed(0);
                          newFormData.packaging_details = `${packs} ${formData.pack_type}${parseInt(packs) !== 1 ? 's' : ''} x ${perPack}kg`;
                        }
                      }
                      setFormData(newFormData);
                    }}
                    placeholder="e.g., 25"
                    className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded focus:ring-1 focus:ring-blue-500"
                  />
                  <p className="text-xs text-gray-500 mt-0.5">kg per pack</p>
                </div>

                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">
                    Pack Type
                  </label>
                  <select
                    value={formData.pack_type}
                    onChange={(e) => {
                      const newFormData = { ...formData, pack_type: e.target.value };
                      if (formData.import_quantity && formData.per_pack_weight) {
                        const perPack = parseFloat(formData.per_pack_weight);
                        if (perPack) {
                          const packs = (formData.import_quantity / perPack).toFixed(0);
                          newFormData.packaging_details = `${packs} ${e.target.value}${parseInt(packs) !== 1 ? 's' : ''} x ${perPack}kg`;
                        }
                      }
                      setFormData(newFormData);
                    }}
                    className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded focus:ring-1 focus:ring-blue-500"
                  >
                    <option value="bag">Bag</option>
                    <option value="drum">Drum</option>
                    <option value="tin">Tin</option>
                    <option value="box">Box</option>
                    <option value="carton">Carton</option>
                    <option value="pallet">Pallet</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">
                    Calculated Packs
                  </label>
                  <div className="px-2 py-1.5 text-sm bg-gray-50 border border-gray-200 rounded">
                    <span className="text-gray-700 font-medium">
                      {formData.import_quantity && formData.per_pack_weight
                        ? Math.ceil(formData.import_quantity / parseFloat(formData.per_pack_weight))
                        : '-'}
                    </span>
                  </div>
                  <p className="text-xs text-gray-500 mt-0.5">Total packs</p>
                </div>
              </div>

              {formData.packaging_details && (
                <div className="mt-1.5 p-2 bg-blue-50 border border-blue-200 rounded">
                  <p className="text-xs text-blue-900">
                    <span className="font-semibold">Packaging: </span>
                    {formData.packaging_details}
                  </p>
                </div>
              )}
            </div>

            <div className="border-b pb-2">
              <h3 className="text-sm font-semibold text-gray-900 mb-2 flex items-center gap-2">
                <DollarSign className="w-4 h-4 text-green-600" />
                Import Pricing (USD)
              </h3>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">
                    Import Price (USD)
                  </label>
                  <input
                    type="number"
                    value={formData.import_price_usd === 0 ? '' : formData.import_price_usd}
                    onChange={(e) => setFormData({ ...formData, import_price_usd: e.target.value === '' ? 0 : Number(e.target.value) })}
                    className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded focus:ring-1 focus:ring-blue-500"
                    min="0"
                    step="0.01"
                    placeholder="0.00"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">
                    Exchange Rate (USD to IDR)
                  </label>
                  <input
                    type="number"
                    value={formData.exchange_rate_usd_to_idr === 0 ? '' : formData.exchange_rate_usd_to_idr}
                    onChange={(e) => setFormData({ ...formData, exchange_rate_usd_to_idr: e.target.value === '' ? 0 : Number(e.target.value) })}
                    className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded focus:ring-1 focus:ring-blue-500"
                    min="0"
                    step="0.0001"
                    placeholder="15000"
                  />
                  <p className="text-xs text-gray-500 mt-0.5">
                    1 USD = {formData.exchange_rate_usd_to_idr.toLocaleString()} IDR
                  </p>
                </div>
              </div>

              {formData.import_price_usd > 0 && formData.exchange_rate_usd_to_idr > 0 && (
                <div className="mt-2 p-2 bg-green-50 border border-green-200 rounded">
                  <p className="text-xs text-green-800">
                    <span className="font-semibold">Calculated Import Price (IDR):</span>{' '}
                    {formatCurrency(formData.import_price_usd * formData.exchange_rate_usd_to_idr)}
                  </p>
                  <p className="text-xs text-green-600 mt-0.5">
                    {formatCurrency(formData.import_price_usd, 'USD')} × {formData.exchange_rate_usd_to_idr.toLocaleString()} = {formatCurrency(formData.import_price_usd * formData.exchange_rate_usd_to_idr)}
                  </p>
                </div>
              )}
            </div>

            <div className="border-b pb-3">
              <h3 className="text-sm font-semibold text-gray-900 mb-2">Additional Charges</h3>
              <div className="space-y-3">
                <div className="grid grid-cols-[1fr_1fr_1fr] gap-2">
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">
                      Duty
                    </label>
                    <div className="flex gap-0.5">
                      <input
                        type="number"
                        value={formData.duty_charges === 0 ? '' : formData.duty_charges}
                        onChange={(e) => setFormData({ ...formData, duty_charges: e.target.value === '' ? 0 : Number(e.target.value) })}
                        className="flex-1 px-1.5 py-1 text-xs border border-gray-300 rounded focus:ring-1 focus:ring-blue-500"
                        min="0"
                        step="0.01"
                        placeholder="0"
                      />
                      <select
                        value={formData.duty_charge_type}
                        onChange={(e) => setFormData({ ...formData, duty_charge_type: e.target.value as 'percentage' | 'fixed' })}
                        className="w-12 px-0.5 py-1 text-xs border border-gray-300 rounded focus:ring-1 focus:ring-blue-500 bg-white"
                      >
                        <option value="percentage">%</option>
                        <option value="fixed">Rp</option>
                      </select>
                    </div>
                    {formData.duty_charges > 0 && (
                      <p className="text-xs text-gray-600 mt-0.5">
                        = {formatCurrency(getChargeAmount(formData.duty_charges, formData.duty_charge_type))}
                      </p>
                    )}
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">
                      Freight
                    </label>
                    <div className="flex gap-0.5">
                      <input
                        type="number"
                        value={formData.freight_charges === 0 ? '' : formData.freight_charges}
                        onChange={(e) => setFormData({ ...formData, freight_charges: e.target.value === '' ? 0 : Number(e.target.value) })}
                        className="flex-1 px-1.5 py-1 text-xs border border-gray-300 rounded focus:ring-1 focus:ring-blue-500"
                        min="0"
                        step="0.01"
                        placeholder="0"
                      />
                      <select
                        value={formData.freight_charge_type}
                        onChange={(e) => setFormData({ ...formData, freight_charge_type: e.target.value as 'percentage' | 'fixed' })}
                        className="w-12 px-0.5 py-1 text-xs border border-gray-300 rounded focus:ring-1 focus:ring-blue-500 bg-white"
                      >
                        <option value="percentage">%</option>
                        <option value="fixed">Rp</option>
                      </select>
                    </div>
                    {formData.freight_charges > 0 && (
                      <p className="text-xs text-gray-600 mt-0.5">
                        = {formatCurrency(getChargeAmount(formData.freight_charges, formData.freight_charge_type))}
                      </p>
                    )}
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">
                      Other
                    </label>
                    <div className="flex gap-0.5">
                      <input
                        type="number"
                        value={formData.other_charges === 0 ? '' : formData.other_charges}
                        onChange={(e) => setFormData({ ...formData, other_charges: e.target.value === '' ? 0 : Number(e.target.value) })}
                        className="flex-1 px-1.5 py-1 text-xs border border-gray-300 rounded focus:ring-1 focus:ring-blue-500"
                        min="0"
                        step="0.01"
                        placeholder="0"
                      />
                      <select
                        value={formData.other_charge_type}
                        onChange={(e) => setFormData({ ...formData, other_charge_type: e.target.value as 'percentage' | 'fixed' })}
                        className="w-12 px-0.5 py-1 text-xs border border-gray-300 rounded focus:ring-1 focus:ring-blue-500 bg-white"
                      >
                        <option value="percentage">%</option>
                        <option value="fixed">Rp</option>
                      </select>
                    </div>
                    {formData.other_charges > 0 && (
                      <p className="text-xs text-gray-600 mt-0.5">
                        = {formatCurrency(getChargeAmount(formData.other_charges, formData.other_charge_type))}
                      </p>
                    )}
                  </div>
                </div>
              </div>
            </div>

            <div className="bg-blue-50 border border-blue-200 rounded p-2">
              <h3 className="text-xs font-semibold text-blue-900 mb-1.5">Total Cost Summary</h3>
              <div className="space-y-0.5 text-xs text-blue-800">
                <div className="flex justify-between">
                  <span>Import Price (IDR):</span>
                  <span className="font-medium">
                    {formatCurrency(formData.import_price_usd * formData.exchange_rate_usd_to_idr)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>Duty Charges:</span>
                  <span className="font-medium">
                    {formatCurrency(getChargeAmount(formData.duty_charges, formData.duty_charge_type))}
                    {formData.duty_charge_type === 'percentage' && formData.duty_charges > 0 && (
                      <span className="text-xs ml-1">({formData.duty_charges}%)</span>
                    )}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>Freight Charges:</span>
                  <span className="font-medium">
                    {formatCurrency(getChargeAmount(formData.freight_charges, formData.freight_charge_type))}
                    {formData.freight_charge_type === 'percentage' && formData.freight_charges > 0 && (
                      <span className="text-xs ml-1">({formData.freight_charges}%)</span>
                    )}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>Other Charges:</span>
                  <span className="font-medium">
                    {formatCurrency(getChargeAmount(formData.other_charges, formData.other_charge_type))}
                    {formData.other_charge_type === 'percentage' && formData.other_charges > 0 && (
                      <span className="text-xs ml-1">({formData.other_charges}%)</span>
                    )}
                  </span>
                </div>
                <div className="border-t border-blue-300 pt-1.5 mt-1.5 flex justify-between">
                  <span className="font-bold">Total Cost (IDR):</span>
                  <span className="font-bold text-sm">{formatCurrency(calculateTotalCostIDR())}</span>
                </div>
              </div>
            </div>

            <div className="border-t pt-2">
              <h3 className="text-sm font-semibold text-gray-900 mb-2 flex items-center gap-2">
                <FileText className="w-4 h-4" />
                Import Documents
              </h3>
              <FileUpload
                batchId={editingBatch?.id}
                existingFiles={uploadedFiles}
                onFilesChange={setUploadedFiles}
              />
            </div>

            <div className="flex justify-end gap-2 pt-3 border-t">
              <button
                type="button"
                onClick={() => {
                  setModalOpen(false);
                  resetForm();
                }}
                className="px-3 py-1.5 text-sm border border-gray-300 rounded hover:bg-gray-50 transition"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 transition"
              >
                {editingBatch ? 'Update Batch' : 'Add Batch'}
              </button>
            </div>
          </form>
        </Modal>

        <Modal
          isOpen={documentsModalOpen}
          onClose={() => {
            setDocumentsModalOpen(false);
            setSelectedBatchDocs([]);
            setSelectedBatchId(null);
          }}
          title="Batch Documents"
        >
          <div className="space-y-3">
            {selectedBatchDocs.length > 0 ? (
              selectedBatchDocs.map((doc) => (
                <a
                  key={doc.id}
                  href={doc.file_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg border border-gray-200 hover:bg-blue-50 hover:border-blue-300 transition"
                >
                  <FileText className="w-5 h-5 text-blue-600 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">{doc.file_name}</p>
                    <div className="flex items-center gap-2 text-xs text-gray-500 mt-1">
                      <span className="capitalize">{doc.file_type.replace('_', ' ')}</span>
                      <span>•</span>
                      <span>{(doc.file_size / 1024).toFixed(1)} KB</span>
                      <span>•</span>
                      <span>{new Date(doc.uploaded_at).toLocaleDateString()}</span>
                    </div>
                  </div>
                  <ExternalLink className="w-4 h-4 text-gray-400 flex-shrink-0" />
                </a>
              ))
            ) : (
              <div className="text-center py-8 text-gray-500">
                <FileText className="w-12 h-12 mx-auto mb-3 text-gray-300" />
                <p>No documents uploaded for this batch</p>
              </div>
            )}
          </div>
        </Modal>
      </div>
    </Layout>
  );
}
