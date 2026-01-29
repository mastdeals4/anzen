import { useEffect, useState } from 'react';
import { Layout } from '../components/Layout';
import { DataTable } from '../components/DataTable';
import { Modal } from '../components/Modal';
import { FileUpload } from '../components/FileUpload';
import { SearchableSelect } from '../components/SearchableSelect';
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
  import_price_per_unit: number | null;
  exchange_rate_usd_to_idr: number | null;
  duty_charges: number;
  duty_percent: number | null;
  freight_charges: number;
  other_charges: number;
  expiry_date: string;
  is_active: boolean;
  import_cost_allocated: number | null;
  final_landed_cost: number | null;
  landed_cost_per_unit: number | null;
  import_container_id: string | null;
  cost_locked: boolean | null;
  products?: {
    product_name: string;
    product_code: string;
    unit: string;
  };
  import_containers?: {
    container_ref: string;
  };
  document_count?: number;
}

interface Product {
  id: string;
  product_name: string;
  product_code: string;
  unit: string;
  duty_percent: number;
}

interface ImportContainer {
  id: string;
  container_ref: string;
  status: string;
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
  const [importContainers, setImportContainers] = useState<ImportContainer[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [documentsModalOpen, setDocumentsModalOpen] = useState(false);
  const [transactionHistoryModal, setTransactionHistoryModal] = useState(false);
  const [selectedBatchDocs, setSelectedBatchDocs] = useState<BatchDocument[]>([]);
  const [selectedBatchId, setSelectedBatchId] = useState<string | null>(null);
  const [selectedProductForHistory, setSelectedProductForHistory] = useState<{id: string; name: string; code: string} | null>(null);
  const [transactionHistory, setTransactionHistory] = useState<any[]>([]);
  const [editingBatch, setEditingBatch] = useState<Batch | null>(null);
  const [uploadedFiles, setUploadedFiles] = useState<any[]>([]);
  const [formData, setFormData] = useState({
    batch_number: '',
    product_id: '',
    import_container_id: '',
    import_date: '',
    import_quantity: 0,
    packaging_details: '',
    import_price_usd: 0,
    exchange_rate_usd_to_idr: 0,
    duty_charges: 0,
    duty_percent: 0,
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
    loadImportContainers();
  }, []);

  const loadBatches = async () => {
    try {
      const { data, error } = await supabase
        .from('batches')
        .select(`
          *,
          products(product_name, product_code, unit),
          import_containers(container_ref)
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
        .select('id, product_name, product_code, unit, duty_percent')
        .eq('is_active', true)
        .order('product_name');

      if (error) throw error;
      setProducts(data || []);
    } catch (error) {
      console.error('Error loading products:', error);
    }
  };

  const loadImportContainers = async () => {
    try {
      const { data, error } = await supabase
        .from('import_containers')
        .select('id, container_ref, status')
        .order('container_ref', { ascending: false });

      if (error) throw error;
      setImportContainers(data || []);
    } catch (error) {
      console.error('Error loading import containers:', error);
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

      // Calculate duty from duty_percent (Form A1)
      const dutyAmount = (importPriceIDR * formData.duty_percent) / 100;
      const freightAmount = calculateCharge(formData.freight_charges, formData.freight_charge_type, importPriceIDR);
      const otherAmount = calculateCharge(formData.other_charges, formData.other_charge_type, importPriceIDR);

      let batchId: string;

      if (editingBatch) {
        const quantityDelta = formData.import_quantity - editingBatch.import_quantity;

        const batchUpdateData = {
          batch_number: formData.batch_number,
          product_id: formData.product_id,
          import_container_id: formData.import_container_id && formData.import_container_id.trim() !== '' ? formData.import_container_id : null,
          import_date: formData.import_date,
          import_quantity: formData.import_quantity,
          packaging_details: formData.packaging_details,
          import_price: importPriceIDR,
          import_price_usd: formData.import_price_usd || null,
          exchange_rate_usd_to_idr: formData.exchange_rate_usd_to_idr || null,
          duty_percent: formData.duty_percent || 0,
          duty_charges: dutyAmount,
          duty_charge_type: 'percentage',
          freight_charges: freightAmount,
          freight_charge_type: formData.freight_charge_type,
          other_charges: otherAmount,
          other_charge_type: formData.other_charge_type,
          expiry_date: formData.expiry_date || null,
        };

        const { error } = await supabase
          .from('batches')
          .update(batchUpdateData)
          .eq('id', editingBatch.id);

        if (error) throw error;
        batchId = editingBatch.id;

        if (quantityDelta !== 0) {
          const { error: transError } = await supabase
            .from('inventory_transactions')
            .update({
              quantity: formData.import_quantity,
              notes: `Updated import quantity from ${editingBatch.import_quantity} to ${formData.import_quantity} (Delta: ${quantityDelta > 0 ? '+' : ''}${quantityDelta})`
            })
            .eq('batch_id', editingBatch.id)
            .eq('transaction_type', 'purchase');

          if (transError) {
            console.error('Error updating purchase transaction:', transError);
          }

          const { data: allTransactions } = await supabase
            .from('inventory_transactions')
            .select('quantity')
            .eq('batch_id', editingBatch.id);

          const recalculatedStock = allTransactions?.reduce((sum, t) => sum + parseFloat(t.quantity || '0'), 0) || 0;

          await supabase
            .from('batches')
            .update({ current_stock: recalculatedStock })
            .eq('id', editingBatch.id);
        }
      } else {
        // For new batches, current_stock = import_quantity
        const batchData = {
          batch_number: formData.batch_number,
          product_id: formData.product_id,
          import_container_id: formData.import_container_id && formData.import_container_id.trim() !== '' ? formData.import_container_id : null,
          import_date: formData.import_date,
          import_quantity: formData.import_quantity,
          current_stock: formData.import_quantity,
          packaging_details: formData.packaging_details,
          import_price: importPriceIDR,
          import_price_usd: formData.import_price_usd || null,
          exchange_rate_usd_to_idr: formData.exchange_rate_usd_to_idr || null,
          duty_percent: formData.duty_percent || 0,
          duty_charges: dutyAmount,
          duty_charge_type: 'percentage',
          freight_charges: freightAmount,
          freight_charge_type: formData.freight_charge_type,
          other_charges: otherAmount,
          other_charge_type: formData.other_charge_type,
          expiry_date: formData.expiry_date || null,
        };

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
    setEditingBatch(batch);

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

    // Get duty_percent from the product (Form A1) as the default
    const selectedProduct = products.find(p => p.id === batch.product_id);
    const productDutyPercent = selectedProduct?.duty_percent || 0;

    setFormData({
      batch_number: batch.batch_number,
      product_id: batch.product_id,
      import_container_id: batch.import_container_id || '',
      import_date: batch.import_date,
      import_quantity: batch.import_quantity,
      packaging_details: batch.packaging_details,
      import_price_usd: batch.import_price_usd || 0,
      exchange_rate_usd_to_idr: batch.exchange_rate_usd_to_idr || 0,
      duty_percent: productDutyPercent,
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
      import_container_id: '',
      import_date: '',
      import_quantity: 0,
      packaging_details: '',
      import_price_usd: 0,
      exchange_rate_usd_to_idr: 0,
      duty_percent: 0,
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

  const showTransactionHistory = async (productId: string, productName: string, productCode: string) => {
    setSelectedProductForHistory({ id: productId, name: productName, code: productCode });
    setTransactionHistoryModal(true);

    // Load transaction history for this product
    const { data: txns, error } = await supabase
      .from('inventory_transactions')
      .select('*')
      .eq('product_id', productId)
      .order('transaction_date', { ascending: false })
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Error loading transaction history:', error);
      alert('Error loading transaction history: ' + error.message);
      return;
    }

    // Load related data separately
    const enrichedData = await Promise.all((txns || []).map(async (txn) => {
      let dcData = null;
      let soData = null;

      // Get DC data if reference is a delivery challan
      if (txn.reference_number && txn.reference_number.startsWith('DO-')) {
        const { data: dc } = await supabase
          .from('delivery_challans')
          .select('challan_number, customer_id, customers(customer_name)')
          .eq('challan_number', txn.reference_number)
          .single();
        dcData = dc;
      }

      // Get SO data if sales_order_id exists
      if (txn.sales_order_id) {
        const { data: so } = await supabase
          .from('sales_orders')
          .select('so_number, customer_id, customers(customer_name)')
          .eq('id', txn.sales_order_id)
          .single();
        soData = so;
      }

      return {
        ...txn,
        delivery_challans: dcData,
        sales_orders: soData
      };
    }));

    setTransactionHistory(enrichedData);
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

    const dutyAmount = (importPriceIDR * formData.duty_percent) / 100;
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
      return `$ ${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    }
    return `Rp ${amount.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };

  const columns = [
    { key: 'batch_number', label: 'Batch Number' },
    {
      key: 'product',
      label: 'Product',
      render: (value: any, batch: Batch) => (
        <div>
          <button
            onClick={() => showTransactionHistory(batch.product_id, batch.products?.product_name || '', batch.products?.product_code || '')}
            className="font-medium text-blue-600 hover:text-blue-800 hover:underline text-left"
          >
            {batch.products?.product_name}
          </button>
          {batch.products?.product_code && (
            <div className="text-xs text-gray-500">{batch.products.product_code}</div>
          )}
        </div>
      )
    },
    {
      key: 'import_date',
      label: 'Import Date',
      render: (value: any, batch: Batch) => new Date(batch.import_date).toLocaleDateString()
    },
    {
      key: 'stock',
      label: 'Stock',
      render: (value: any, batch: Batch) => {
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
      render: (value: any, batch: Batch) => (
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
      key: 'landed_cost',
      label: 'Landed Cost',
      render: (value: any, batch: Batch) => {
        const hasContainer = batch.import_cost_allocated && batch.import_cost_allocated > 0;
        const landedCostPerUnit = batch.landed_cost_per_unit || batch.import_price;
        const containerPerUnit = hasContainer ? (batch.import_cost_allocated / batch.import_quantity) : 0;

        return (
          <div className="text-sm">
            {batch.import_price_usd && batch.exchange_rate_usd_to_idr ? (
              <>
                <div className="font-medium text-blue-700">
                  {formatCurrency(landedCostPerUnit / batch.exchange_rate_usd_to_idr, 'USD')}
                </div>
                <div className="text-xs text-gray-500">
                  {formatCurrency(landedCostPerUnit)}
                </div>
                {hasContainer && (
                  <div className="text-xs text-green-600">
                    +Container: {formatCurrency(containerPerUnit)}
                  </div>
                )}
                <div className="text-xs text-gray-400">
                  @ {batch.exchange_rate_usd_to_idr.toLocaleString('id-ID')}
                </div>
              </>
            ) : (
              <>
                <div className="font-medium text-blue-700">
                  {formatCurrency(landedCostPerUnit)}
                </div>
                {hasContainer && (
                  <div className="text-xs text-green-600">
                    +Container: {formatCurrency(containerPerUnit)}
                  </div>
                )}
              </>
            )}
            {batch.import_containers?.container_ref && (
              <div className="text-xs text-gray-400">
                {batch.import_containers.container_ref}
              </div>
            )}
            {batch.cost_locked && (
              <div className="text-xs text-amber-600 font-medium">🔒 Locked</div>
            )}
          </div>
        );
      }
    },
    {
      key: 'expiry_date',
      label: 'Expiry Date',
      render: (value: any, batch: Batch) => (
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
      render: (value: any, batch: Batch) => (
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
      render: (value: any, batch: Batch) => {
        const totalCostIDR = batch.import_price * batch.import_quantity;
        const totalCostUSD = batch.import_price_usd ? batch.import_price_usd * batch.import_quantity : null;

        return (
          <div className="text-sm">
            {totalCostUSD && batch.exchange_rate_usd_to_idr ? (
              <>
                <div className="font-semibold text-green-700">
                  {formatCurrency(totalCostUSD, 'USD')}
                </div>
                <div className="text-xs text-gray-500">
                  {formatCurrency(totalCostIDR)}
                </div>
              </>
            ) : (
              <div className="font-semibold">{formatCurrency(totalCostIDR)}</div>
            )}
          </div>
        );
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

        {/* Summary Section */}
        {batches.length > 0 && (
          <div className="bg-gradient-to-r from-blue-50 to-green-50 rounded-lg shadow-lg p-6 border-2 border-blue-200">
            <h3 className="text-lg font-bold text-gray-900 mb-4 flex items-center gap-2">
              <DollarSign className="w-5 h-5 text-blue-600" />
              Total Import Value Summary
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="space-y-2">
                <p className="text-sm text-gray-600 font-medium">Total Value (USD)</p>
                <p className="text-3xl font-bold text-green-700">
                  {formatCurrency(
                    batches.reduce((sum, batch) => {
                      const totalUSD = batch.import_price_usd ? batch.import_price_usd * batch.import_quantity : 0;
                      return sum + totalUSD;
                    }, 0),
                    'USD'
                  )}
                </p>
              </div>
              <div className="space-y-2">
                <p className="text-sm text-gray-600 font-medium">Total Value (IDR)</p>
                <p className="text-3xl font-bold text-blue-700">
                  {formatCurrency(
                    batches.reduce((sum, batch) => {
                      const totalIDR = batch.import_price * batch.import_quantity;
                      return sum + totalIDR;
                    }, 0)
                  )}
                </p>
              </div>
            </div>
            <div className="mt-4 pt-4 border-t border-blue-200">
              <div className="flex justify-between items-center text-sm">
                <span className="text-gray-600">Total Batches:</span>
                <span className="font-semibold text-gray-900">{batches.length}</span>
              </div>
              <div className="flex justify-between items-center text-sm mt-1">
                <span className="text-gray-600">Total Quantity:</span>
                <span className="font-semibold text-gray-900">
                  {batches.reduce((sum, batch) => sum + batch.import_quantity, 0).toLocaleString()} units
                </span>
              </div>
            </div>
          </div>
        )}

        <Modal
          isOpen={modalOpen}
          onClose={() => {
            setModalOpen(false);
            resetForm();
          }}
          title={editingBatch ? 'Edit Batch' : 'Add New Batch'}
          size="xl"
        >
          <form onSubmit={handleSubmit} className="space-y-2">
            <div className="border-b pb-1.5">
              <h3 className="text-xs font-semibold text-gray-900 mb-1.5">Basic Information</h3>
              <div className="grid grid-cols-[2fr_1fr_1fr] gap-2 mb-2">
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-0.5">
                    Batch Number *
                  </label>
                  <input
                    type="text"
                    value={formData.batch_number}
                    onChange={(e) => setFormData({ ...formData, batch_number: e.target.value })}
                    className="w-full px-2 py-1 text-sm border border-gray-300 rounded focus:ring-1 focus:ring-blue-500"
                    required
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-0.5">
                    Import Date *
                  </label>
                  <input
                    type="date"
                    value={formData.import_date}
                    onChange={(e) => setFormData({ ...formData, import_date: e.target.value })}
                    className="w-full px-2 py-1 text-sm border border-gray-300 rounded focus:ring-1 focus:ring-blue-500"
                    required
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-0.5">
                    Expiry Date
                  </label>
                  <input
                    type="date"
                    value={formData.expiry_date}
                    onChange={(e) => setFormData({ ...formData, expiry_date: e.target.value })}
                    className="w-full px-2 py-1 text-sm border border-gray-300 rounded focus:ring-1 focus:ring-blue-500"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-0.5">
                    Product *
                  </label>
                  <SearchableSelect
                    value={formData.product_id}
                    onChange={(value) => {
                      const selectedProduct = products.find(p => p.id === value);
                      setFormData({
                        ...formData,
                        product_id: value,
                        duty_percent: selectedProduct?.duty_percent || 0
                      });
                    }}
                    options={products.map(p => ({
                      value: p.id,
                      label: `${p.product_name}${p.product_code ? ` (${p.product_code})` : ''}`
                    }))}
                    placeholder="Select Product"
                    className="text-sm"
                    required
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-0.5">
                    Import Container (Optional)
                  </label>
                  <SearchableSelect
                    value={formData.import_container_id}
                    onChange={(value) => setFormData({ ...formData, import_container_id: value })}
                    options={[
                      { value: '', label: 'Select Container (Optional)' },
                      ...importContainers.map(c => ({
                        value: c.id,
                        label: `${c.container_ref} (${c.status})`
                      }))
                    ]}
                    placeholder="Select Container"
                    className="text-sm"
                  />
                  <p className="text-xs text-gray-500 mt-0.5">Link batch to import container for cost allocation</p>
                </div>
              </div>
            </div>

            <div className="border-b pb-1.5">
              <h3 className="text-xs font-semibold text-gray-900 mb-1.5">Quantity</h3>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-0.5">
                    Import Quantity *
                  </label>
                  <input
                    type="number"
                    value={formData.import_quantity === 0 ? '' : formData.import_quantity}
                    onChange={(e) => setFormData({ ...formData, import_quantity: e.target.value === '' ? 0 : Number(e.target.value) })}
                    className="w-full px-2 py-1 text-sm border border-gray-300 rounded focus:ring-1 focus:ring-blue-500"
                    required
                    min="0"
                    step="0.001"
                    placeholder="0"
                  />
                  <p className="text-xs text-gray-500 mt-0.5">Total quantity being imported</p>
                </div>

                {editingBatch && (
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-0.5">
                      Current Stock
                    </label>
                    <div className="w-full px-2 py-1 text-sm border border-gray-200 rounded bg-gray-50">
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

            <div className="border-b pb-1.5">
              <h3 className="text-xs font-semibold text-gray-900 mb-1 flex items-center gap-1.5">
                <Package className="w-3.5 h-3.5" />
                Packaging Details (Optional)
              </h3>
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-0.5">
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
                    className="w-full px-2 py-1 text-sm border border-gray-300 rounded focus:ring-1 focus:ring-blue-500"
                  />
                  <p className="text-xs text-gray-500 mt-0.5">kg per pack</p>
                </div>

                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-0.5">
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
                    className="w-full px-2 py-1 text-sm border border-gray-300 rounded focus:ring-1 focus:ring-blue-500"
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
                  <label className="block text-xs font-medium text-gray-700 mb-0.5">
                    Calculated Packs
                  </label>
                  <div className="px-2 py-1 text-sm bg-gray-50 border border-gray-200 rounded">
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
                <div className="mt-1 p-1.5 bg-blue-50 border border-blue-200 rounded">
                  <p className="text-xs text-blue-900">
                    <span className="font-semibold">Packaging: </span>
                    {formData.packaging_details}
                  </p>
                </div>
              )}
            </div>

            <div className="border-b pb-1.5">
              <h3 className="text-xs font-semibold text-gray-900 mb-1 flex items-center gap-1.5">
                <DollarSign className="w-3.5 h-3.5 text-green-600" />
                Import Pricing (USD)
              </h3>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-0.5">
                    Import Price (USD)
                  </label>
                  <input
                    type="number"
                    value={formData.import_price_usd === 0 ? '' : formData.import_price_usd}
                    onChange={(e) => setFormData({ ...formData, import_price_usd: e.target.value === '' ? 0 : Number(e.target.value) })}
                    className="w-full px-2 py-1 text-sm border border-gray-300 rounded focus:ring-1 focus:ring-blue-500"
                    min="0"
                    step="0.01"
                    placeholder="0.00"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-0.5">
                    Exchange Rate (USD to IDR)
                  </label>
                  <input
                    type="number"
                    value={formData.exchange_rate_usd_to_idr === 0 ? '' : formData.exchange_rate_usd_to_idr}
                    onChange={(e) => setFormData({ ...formData, exchange_rate_usd_to_idr: e.target.value === '' ? 0 : Number(e.target.value) })}
                    className="w-full px-2 py-1 text-sm border border-gray-300 rounded focus:ring-1 focus:ring-blue-500"
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
                <div className="mt-1 p-1.5 bg-green-50 border border-green-200 rounded">
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

            <div className="border-b pb-1.5">
              <h3 className="text-xs font-semibold text-gray-900 mb-1">Additional Charges</h3>
              <div className="space-y-3">
                <div className="grid grid-cols-[1fr_1fr_1fr] gap-2">
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">
                      Duty (Form A1 %)
                    </label>
                    <div className="flex gap-0.5">
                      <input
                        type="number"
                        value={formData.duty_percent === 0 ? '' : formData.duty_percent}
                        onChange={(e) => setFormData({ ...formData, duty_percent: e.target.value === '' ? 0 : Number(e.target.value) })}
                        className="flex-1 px-1.5 py-1 text-xs border border-gray-300 rounded focus:ring-1 focus:ring-blue-500"
                        min="0"
                        max="100"
                        step="0.01"
                        placeholder="Auto from product"
                      />
                      <div className="w-12 px-0.5 py-1 text-xs border border-gray-300 rounded bg-gray-50 flex items-center justify-center">
                        %
                      </div>
                    </div>
                    {formData.duty_percent > 0 && formData.import_price_usd > 0 && formData.exchange_rate_usd_to_idr > 0 && (
                      <p className="text-xs text-gray-600 mt-0.5">
                        = {formatCurrency((formData.import_price_usd * formData.exchange_rate_usd_to_idr * formData.duty_percent) / 100)}
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
                  <span>Import Price (per unit):</span>
                  <span className="font-medium">
                    {formatCurrency(formData.import_price_usd * formData.exchange_rate_usd_to_idr)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>Duty (Form A1):</span>
                  <span className="font-medium">
                    {formatCurrency((formData.import_price_usd * formData.exchange_rate_usd_to_idr * formData.duty_percent) / 100)}
                    {formData.duty_percent > 0 && (
                      <span className="text-xs ml-1">({formData.duty_percent}%)</span>
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
                <div className="border-t border-blue-300 pt-1.5 mt-1.5 space-y-1">
                  <div className="flex justify-between">
                    <span className="font-bold">Total Cost (IDR):</span>
                    <span className="font-bold text-sm">{formatCurrency(calculateTotalCostIDR())}</span>
                  </div>
                  {formData.import_quantity > 0 && (
                    <div className="bg-green-50 border border-green-200 rounded px-2 py-1.5 mt-2">
                      <div className="flex justify-between items-center">
                        <span className="font-bold text-green-900">Total Batch Cost:</span>
                        <div className="text-right">
                          <div className="font-bold text-green-700">
                            {formatCurrency(formData.import_price_usd * formData.import_quantity, 'USD')}
                          </div>
                          <div className="text-xs text-green-600">
                            {formatCurrency((formData.import_price_usd * formData.exchange_rate_usd_to_idr) * formData.import_quantity)}
                          </div>
                        </div>
                      </div>
                      <div className="text-xs text-green-700 mt-0.5">
                        {formatCurrency(formData.import_price_usd, 'USD')} × {formData.import_quantity} = {formatCurrency(formData.import_price_usd * formData.import_quantity, 'USD')}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div className="border-t pt-1.5">
              <h3 className="text-xs font-semibold text-gray-900 mb-1 flex items-center gap-1.5">
                <FileText className="w-3.5 h-3.5" />
                Import Documents
              </h3>
              <FileUpload
                batchId={editingBatch?.id}
                existingFiles={uploadedFiles}
                onFilesChange={setUploadedFiles}
              />
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t">
              <button
                type="button"
                onClick={() => {
                  setModalOpen(false);
                  resetForm();
                }}
                className="px-3 py-1 text-sm border border-gray-300 rounded hover:bg-gray-50 transition"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-3 py-1 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 transition"
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

        {/* Transaction History Modal */}
        <Modal
          isOpen={transactionHistoryModal}
          onClose={() => {
            setTransactionHistoryModal(false);
            setSelectedProductForHistory(null);
            setTransactionHistory([]);
          }}
          title={`Transaction History - ${selectedProductForHistory?.name || ''} (${selectedProductForHistory?.code || ''})`}
        >
          <div className="space-y-3 max-h-[600px] overflow-y-auto">
            {transactionHistory.length > 0 ? (
              <div className="space-y-2">
                {transactionHistory.map((txn, idx) => (
                  <div
                    key={txn.id}
                    className={`p-3 rounded-lg border-l-4 ${
                      parseFloat(txn.quantity) > 0
                        ? 'bg-green-50 border-green-500'
                        : 'bg-red-50 border-red-500'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-1">
                          <span className={`font-semibold ${
                            parseFloat(txn.quantity) > 0 ? 'text-green-700' : 'text-red-700'
                          }`}>
                            {parseFloat(txn.quantity) > 0 ? '+' : ''}{parseFloat(txn.quantity).toFixed(3)}
                          </span>
                          <span className="text-xs px-2 py-0.5 rounded bg-gray-200 text-gray-700 uppercase">
                            {txn.transaction_type.replace('_', ' ')}
                          </span>
                        </div>
                        <div className="text-sm text-gray-600 space-y-0.5">
                          <div><strong>Date:</strong> {new Date(txn.transaction_date).toLocaleDateString()}</div>
                          {txn.reference_number && (
                            <div><strong>Reference:</strong> {txn.reference_number}</div>
                          )}
                          {txn.reference_type === 'delivery_challan' && txn.delivery_challans && (
                            <div className="text-xs text-blue-600">
                              DC: {txn.delivery_challans.challan_number}
                              {txn.delivery_challans.customers && (
                                <span className="ml-1">→ {txn.delivery_challans.customers.customer_name}</span>
                              )}
                            </div>
                          )}
                          {txn.sales_order_id && txn.sales_orders && (
                            <div className="text-xs text-blue-600">
                              SO: {txn.sales_orders.so_number}
                              {txn.sales_orders.customers && (
                                <span className="ml-1">→ {txn.sales_orders.customers.customer_name}</span>
                              )}
                            </div>
                          )}
                          {txn.notes && (
                            <div className="text-xs text-gray-500 italic">{txn.notes}</div>
                          )}
                        </div>
                      </div>
                      <div className="text-right text-xs text-gray-400">
                        {new Date(txn.created_at).toLocaleString()}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-center py-8 text-gray-500">
                <Package className="w-12 h-12 mx-auto mb-3 text-gray-300" />
                <p>No transactions found for this product</p>
              </div>
            )}
          </div>
        </Modal>
      </div>
    </Layout>
  );
}
