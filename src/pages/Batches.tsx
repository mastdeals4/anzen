import { useEffect, useRef, useState } from 'react';
import { Layout } from '../components/Layout';
import { Modal } from '../components/Modal';
import { FileUpload } from '../components/FileUpload';
import { SearchableSelect } from '../components/SearchableSelect';
import { useLanguage } from '../contexts/LanguageContext';
import { useAuth } from '../contexts/AuthContext';
import { supabase } from '../lib/supabase';
import { Plus, Pencil as Edit, Trash2, AlertTriangle, Package, DollarSign, FileText, ExternalLink, Search, ChevronDown, ChevronRight, Archive, Eye, EyeOff, ExternalLink as LinkIcon } from 'lucide-react';
import { ProformaInvoiceView } from '../components/ProformaInvoiceView';
import { DeliveryChallanView } from '../components/DeliveryChallanView';
import { InvoiceView } from '../components/InvoiceView';
import { loadInvoiceDisplayItems } from '../utils/invoiceItemDisplay';
import { showToast } from '../components/ToastNotification';
import { showConfirm } from '../components/ConfirmDialog';
import { formatDate } from '../utils/dateFormat';
import { MoneyInput } from '../components/MoneyInput';
import { canSeeInventoryCosting } from '../utils/permissions';
import { resolveStorageUrlCached } from '../utils/signedUrlCache';
import { formatUnit, abbreviateUnit, formatPackagingDetails } from '../utils/unitDisplay';

interface Batch {
  id: string;
  batch_number: string;
  product_id: string;
  make_id: string | null;
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
  duty_charge_type?: 'percentage' | 'fixed' | null;
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
  product_sources?: { supplier_name: string | null; grade: string | null } | null;
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

interface PendingInward {
  invoice_id: string;
  invoice_number: string;
  item_id: string;
  product_id: string;
  make_id: string | null;
  import_container_id: string | null;
  invoice_date: string;
  currency: string;
  exchange_rate: number;
  unit: string;
  unit_price: number;
  supplier_name: string;
  product_name: string;
  quantity: number;
  received: number;
  pending: number;
  make_name: string | null;
  batch_number: string | null;
  expiry_date: string | null;
  container_ref: string | null;
}

export function Batches() {
  const { t } = useLanguage();
  const { profile } = useAuth();
  const canViewCosting = canSeeInventoryCosting(profile?.role);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [productMakes, setProductMakes] = useState<Array<{ id: string; supplier_name: string | null; grade: string | null }>>([]);
  const [importContainers, setImportContainers] = useState<ImportContainer[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [documentsModalOpen, setDocumentsModalOpen] = useState(false);
  const [transactionHistoryModal, setTransactionHistoryModal] = useState(false);
  const [selectedBatchDocs, setSelectedBatchDocs] = useState<BatchDocument[]>([]);
  const [selectedBatchId, setSelectedBatchId] = useState<string | null>(null);
  const [signedUrlCache, setSignedUrlCache] = useState<Record<string, string>>({});
  const [selectedProductForHistory, setSelectedProductForHistory] = useState<{id: string; name: string; code: string; batchId?: string; batchNumber?: string; unit?: string} | null>(null);
  const [transactionHistory, setTransactionHistory] = useState<any[]>([]);
  const [historyFilter, setHistoryFilter] = useState<'all' | 'in' | 'out' | 'reservations' | 'adjustments'>('all');
  const [historySearch, setHistorySearch] = useState('');
  const [expandedHistoryRows, setExpandedHistoryRows] = useState<Set<string>>(new Set());
  const [editingBatch, setEditingBatch] = useState<Batch | null>(null);
  const [uploadedFiles, setUploadedFiles] = useState<any[]>([]);
  const [batchSearch, setBatchSearch] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [expandedProducts, setExpandedProducts] = useState<Set<string>>(new Set());
  const [quickViewSO, setQuickViewSO] = useState<{ order: any; items: any[] } | null>(null);
  const [quickViewDC, setQuickViewDC] = useState<{ challan: any; items: any[] } | null>(null);
  const [quickViewInvoice, setQuickViewInvoice] = useState<{ invoice: any; items: any[] } | null>(null);
  const [pendingInwards, setPendingInwards] = useState<PendingInward[]>([]);
  const [pendingInwardContext, setPendingInwardContext] = useState<{ invoice_id: string; item_id: string } | null>(null);
  const [companySettings, setCompanySettings] = useState<any>(null);
  const batchOperationIdRef = useRef<string | null>(null);
  const priceFieldRef = useRef<'usd' | 'idr' | null>(null);
  const [formData, setFormData] = useState({
    batch_number: '',
    product_id: '',
    make_id: '',
    import_container_id: '',
    import_date: '',
    import_quantity: 0,
    packaging_details: '',
    import_price_usd: 0,
    import_price_idr: 0,
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
    loadCompanySettings();
    loadPendingInwards();
  }, [canViewCosting]);

  const loadPendingInwards = async () => {
    const { data, error } = await supabase.from('purchase_invoices').select('*,suppliers(company_name),purchase_invoice_items(*,products(product_name, unit))');
    if (error) {
      console.error('Error loading pending inwards:', error);
      setPendingInwards([]);
      return;
    }
    const rows = (data || []).filter((invoice: any) => invoice.receiving_approval_status === 'approved').flatMap((invoice: any) => (invoice.purchase_invoice_items || [])
      .filter((item: any) => item.item_type === 'inventory')
      .map((item: any) => ({
        invoice_id: invoice.id, invoice_number: invoice.invoice_number, item_id: item.id,
        product_id: item.product_id, make_id: item.receiving_make_id || null,
        import_container_id: item.receiving_import_container_id || null,
        invoice_date: invoice.invoice_date, currency: invoice.currency || 'IDR', exchange_rate: Number(invoice.exchange_rate) || 1,
        unit: item.products?.unit || item.unit || '', unit_price: Number(item.unit_price) || 0,
        supplier_name: invoice.suppliers?.company_name || '—',
        product_name: item.products?.product_name || item.description || '—',
        quantity: Number(item.quantity) || 0, received: 0, pending: Number(item.quantity) || 0,
        make_name: null,
        batch_number: item.receiving_batch_number || null, expiry_date: item.receiving_expiry_date || null,
        container_ref: null,
      })));
    const makeIds = Array.from(new Set(rows.map((r: PendingInward) => r.make_id).filter(Boolean))) as string[];
    const containerIds = Array.from(new Set(rows.map((r: PendingInward) => r.import_container_id).filter(Boolean))) as string[];
    const [makeResult, containerResult] = await Promise.all([
      makeIds.length ? supabase.from('product_sources').select('id,supplier_name').in('id', makeIds) : Promise.resolve({ data: [], error: null }),
      containerIds.length ? supabase.from('import_containers').select('id,container_ref').in('id', containerIds) : Promise.resolve({ data: [], error: null }),
    ]);
    const makeNames = new Map((makeResult.data || []).map((m: any) => [m.id, m.supplier_name]));
    const containerRefs = new Map((containerResult.data || []).map((c: any) => [c.id, c.container_ref]));
    rows.forEach((r: PendingInward) => {
      r.make_name = r.make_id ? makeNames.get(r.make_id) || null : null;
      r.container_ref = r.import_container_id ? containerRefs.get(r.import_container_id) || null : null;
    });
    const itemIds = rows.map((r: PendingInward) => r.item_id);
    if (itemIds.length) {
      const { data: receivedTotals, error: totalsError } = await supabase.rpc('purchase_invoice_item_received_totals', { p_item_ids: itemIds });
      if (totalsError) throw totalsError;
      const totals = (receivedTotals || []).reduce((acc: Record<string, number>, a: any) => {
        acc[a.purchase_invoice_item_id] = Number(a.received_quantity) || 0;
        return acc;
      }, {});
      rows.forEach((r: PendingInward) => {
        r.received = totals[r.item_id] || 0;
        r.pending = Math.max(0, r.quantity - r.received);
      });
    }
    setPendingInwards(rows.filter((r: PendingInward) => r.pending > 0));
  };

  const openPendingInward = async (row: PendingInward) => {
    if (!canEdit || !row.product_id) return;
    const { data: makes, error: makesError } = await supabase
      .from('product_sources')
      .select('id,supplier_name,grade')
      .eq('product_id', row.product_id)
      .order('supplier_name');
    if (makesError) {
      showToast({ type: 'error', title: 'Unable to open inward', message: makesError.message });
      return;
    }

    const product = products.find(p => p.id === row.product_id);
    setEditingBatch(null);
    setPendingInwardContext({ invoice_id: row.invoice_id, item_id: row.item_id });
    setProductMakes(makes || []);
    setUploadedFiles([]);
    setFormData({
      batch_number: row.batch_number || '',
      product_id: row.product_id,
      make_id: row.make_id || (makes?.length === 1 ? makes[0].id : ''),
      import_container_id: row.import_container_id || '',
      import_date: new Date().toISOString().split('T')[0],
      import_quantity: row.pending,
      packaging_details: '',
      import_price_usd: row.currency === 'USD' ? row.unit_price : 0,
      import_price_idr: row.currency === 'USD' ? 0 : row.unit_price,
      exchange_rate_usd_to_idr: row.currency === 'USD' ? row.exchange_rate : 0,
      duty_charges: 0,
      duty_percent: product?.duty_percent || 0,
      duty_charge_type: 'percentage',
      freight_charges: 0,
      freight_charge_type: 'fixed',
      other_charges: 0,
      other_charge_type: 'fixed',
      expiry_date: row.expiry_date || '',
      per_pack_weight: '',
      pack_type: 'bag',
    });
    setModalOpen(true);
  };

  const rejectPendingInward = async (row: PendingInward) => {
    const reason = window.prompt('Rejection reason (required):')?.trim();
    if (!reason) return;
    const { error } = await supabase.rpc('reject_purchase_invoice_inward', {
      p_purchase_invoice_id: row.invoice_id,
      p_purchase_invoice_item_id: row.item_id,
      p_reason: reason,
    });
    if (error) { showToast({ type: 'error', title: 'Reject failed', message: error.message }); return; }
    showToast({ type: 'success', title: 'Rejected', message: 'Correct and resubmit the Purchase Invoice for approval.' });
    await loadPendingInwards();
  };

  const loadCompanySettings = async () => {
    const { data } = await supabase.from('app_settings').select('*').maybeSingle();
    if (data) setCompanySettings(data);
  };

  const handleUSDChange = (usd: number) => {
    priceFieldRef.current = 'usd';
    const rate = formData.exchange_rate_usd_to_idr;
    const idr = rate > 0 ? usd * rate : formData.import_price_idr;
    setFormData(prev => ({ ...prev, import_price_usd: usd, import_price_idr: idr }));
  };

  const handleIDRChange = (idr: number) => {
    priceFieldRef.current = 'idr';
    const rate = formData.exchange_rate_usd_to_idr;
    const usd = rate > 0 ? idr / rate : formData.import_price_usd;
    setFormData(prev => ({ ...prev, import_price_idr: idr, import_price_usd: rate > 0 ? Number(usd.toFixed(4)) : usd }));
  };

  const handleExchangeRateChange = (rate: number) => {
    const activeField = priceFieldRef.current;
    if (activeField === 'idr' && rate > 0) {
      const usd = formData.import_price_idr / rate;
      setFormData(prev => ({ ...prev, exchange_rate_usd_to_idr: rate, import_price_usd: Number(usd.toFixed(4)) }));
    } else if (activeField === 'usd' && rate > 0) {
      const idr = formData.import_price_usd * rate;
      setFormData(prev => ({ ...prev, exchange_rate_usd_to_idr: rate, import_price_idr: idr }));
    } else {
      setFormData(prev => ({ ...prev, exchange_rate_usd_to_idr: rate }));
    }
  };

  const openQuickViewSO = async (soNumber: string) => {
    const { data: order } = await supabase
      .from('sales_orders')
      .select(`*, customers(company_name, address, city, phone, npwp, pharmacy_license, gst_vat_type)`)
      .eq('so_number', soNumber)
      .maybeSingle();
    if (!order) return;
    const { data: items } = await supabase
      .from('sales_order_items')
      .select(`*, products(product_name, product_code, unit)`)
      .eq('sales_order_id', order.id);
    setQuickViewSO({ order, items: items || [] });
  };

  const openQuickViewDC = async (challanNumber: string) => {
    const { data: challan } = await supabase
      .from('delivery_challans')
      .select(`*, customers(company_name, address, city, phone, npwp, pharmacy_license, gst_vat_type)`)
      .eq('challan_number', challanNumber)
      .maybeSingle();
    if (!challan) return;
    const { data: items } = await supabase
      .from('delivery_challan_items')
      .select(`*, products(product_name, product_code, unit), batches(batch_number, expiry_date, packaging_details, products(product_name, product_code, unit), product_sources!batches_make_id_fkey(supplier_name, grade))`)
      .eq('challan_id', challan.id);
    setQuickViewDC({ challan, items: items || [] });
  };

  const openQuickViewInvoice = async (invoiceNumber: string) => {
    const { data: invoice } = await supabase
      .from('sales_invoices')
      .select(`*, customers(company_name, address, city, phone, npwp, pharmacy_license, gst_vat_type)`)
      .eq('invoice_number', invoiceNumber)
      .maybeSingle();
    if (!invoice) return;
    const items = await loadInvoiceDisplayItems(supabase, invoice.id);
    setQuickViewInvoice({ invoice, items: items || [] });
  };

  const loadBatches = async () => {
    try {
      const batchColumns = canViewCosting
        ? '*'
        : `
          id,
          batch_number,
          product_id,
          make_id,
          import_date,
          import_quantity,
          current_stock,
          reserved_stock,
          packaging_details,
          expiry_date,
          is_active,
          import_container_id,
          cost_locked
        `;
      const query = supabase
        .from('batches')
        .select(`
          ${batchColumns},
          products(product_name, product_code, unit),
          product_sources!batches_make_id_fkey(supplier_name, grade),
          import_containers(container_ref),
          stock_reservations(id, reserved_quantity, status, sales_orders(so_number))
        `)
        .order('import_date', { ascending: false });

      const { data, error } = await query;

      if (error) throw error;

      const batchRows = (data ?? []) as unknown as Array<Record<string, any> & {
        id: string;
        stock_reservations?: Array<{ status: string }>;
      }>;
      const batchesWithDocCount = await Promise.all(
        batchRows.map(async (batch) => {
          const { count } = await supabase
            .from('batch_documents')
            .select('*', { count: 'exact', head: true })
            .eq('batch_id', batch.id);

          const activeReservations = (batch.stock_reservations || []).filter((r: any) => r.status === 'active');

          return { ...batch, document_count: count || 0, active_reservations: activeReservations };
        })
      );

      setBatches(batchesWithDocCount as unknown as Batch[]);
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

  const loadProductMakes = async (productId: string, autoSelectSingle = true) => {
    if (!productId) { setProductMakes([]); return; }
    const { data, error } = await supabase
      .from('product_sources')
      .select('id, supplier_name, grade')
      .eq('product_id', productId)
      .order('supplier_name');
    if (error) throw error;
    const makes = data || [];
    setProductMakes(makes);
    if (autoSelectSingle && !editingBatch && makes.length === 1) {
      setFormData(current => current.product_id === productId ? { ...current, make_id: makes[0].id } : current);
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
      if (data && data.length > 0) {
        Promise.all(
          data.map(async (doc: any) => [doc.file_url, await resolveStorageUrlCached(doc.file_url, 3600)] as [string, string])
        ).then((entries) => setSignedUrlCache((prev) => ({ ...prev, ...Object.fromEntries(entries) })));
      }
    } catch (error) {
      console.error('Error loading documents:', error);
      showToast({ type: 'error', title: 'Error', message: 'Failed to load documents' });
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (canViewCosting && formData.import_price_usd > 0 && formData.exchange_rate_usd_to_idr <= 0) {
      showToast({ type: 'error', title: 'Error', message: 'Please enter a valid exchange rate' });
      return;
    }

    try {
      if (!editingBatch && !formData.make_id) {
        showToast({ type: 'error', title: 'Make required', message: 'Create or select a Make / Manufacturer for new inventory batches.' });
        return;
      }
      // Use the IDR price directly if the user entered IDR (local purchase),
      // otherwise derive IDR from USD × exchange rate (import purchase).
      const importPriceIDR = canViewCosting
        ? (formData.import_price_idr > 0 && formData.import_price_usd <= 0
            ? formData.import_price_idr
            : formData.import_price_usd * formData.exchange_rate_usd_to_idr)
        : 0;

      // Calculate actual charge amounts based on type
      const calculateCharge = (amount: number, type: 'percentage' | 'fixed', basePrice: number) => {
        if (type === 'percentage') {
          return (basePrice * amount) / 100;
        }
        return amount;
      };

      // Percentage duty is derived from the batch's own duty percentage.
      // Fixed-duty batches retain their stored absolute charge when edited.
      const dutyChargeType = editingBatch?.duty_charge_type === 'fixed' ? 'fixed' : 'percentage';
      const calculatedDutyAmount = (importPriceIDR * formData.duty_percent) / 100;
      const dutyAmount = dutyChargeType === 'fixed' && editingBatch
        ? Number(formData.duty_charges ?? editingBatch.duty_charges ?? 0)
        : calculatedDutyAmount;
      const freightAmount = calculateCharge(formData.freight_charges, formData.freight_charge_type, importPriceIDR);
      const otherAmount = calculateCharge(formData.other_charges, formData.other_charge_type, importPriceIDR);

      const batchPayload = {
        batch_number: formData.batch_number,
        product_id: formData.product_id,
        make_id: formData.make_id || null,
        import_container_id: formData.import_container_id && formData.import_container_id.trim() !== '' ? formData.import_container_id : null,
        import_date: formData.import_date,
        import_quantity: formData.import_quantity,
        packaging_details: formData.packaging_details,
        import_price: canViewCosting ? importPriceIDR : editingBatch?.import_price || 0,
        import_price_usd: canViewCosting ? formData.import_price_usd || null : editingBatch?.import_price_usd || null,
        exchange_rate_usd_to_idr: canViewCosting ? formData.exchange_rate_usd_to_idr || null : editingBatch?.exchange_rate_usd_to_idr || null,
        duty_percent: canViewCosting ? formData.duty_percent || 0 : editingBatch?.duty_percent || 0,
        duty_charges: canViewCosting ? dutyAmount : editingBatch?.duty_charges || 0,
        duty_charge_type: dutyChargeType,
        freight_charges: canViewCosting ? freightAmount : editingBatch?.freight_charges || 0,
        freight_charge_type: canViewCosting ? formData.freight_charge_type : 'fixed',
        other_charges: canViewCosting ? otherAmount : editingBatch?.other_charges || 0,
        other_charge_type: canViewCosting ? formData.other_charge_type : 'fixed',
        expiry_date: formData.expiry_date || null,
      };
      const operationId = batchOperationIdRef.current || crypto.randomUUID();
      batchOperationIdRef.current = operationId;

      const { data: result, error } = pendingInwardContext
        ? await supabase.rpc('receive_purchase_invoice_item', {
            p_purchase_invoice_item_id: pendingInwardContext.item_id,
            p_received_quantity: formData.import_quantity,
            p_operation_id: operationId,
            p_payload: batchPayload,
          })
        : await supabase.rpc('save_batch_inventory_v1', {
            p_batch_id: editingBatch?.id || null,
            p_payload: batchPayload,
            p_operation_id: operationId,
          });

      if (error) throw error;
      if (!result?.success || !result?.batch_id) {
        throw new Error(result?.error || 'Canonical batch save failed');
      }
      const batchId = result.batch_id as string;

      await uploadFilesToBatch(batchId);

      batchOperationIdRef.current = null;
      setModalOpen(false);
      resetForm();
      await Promise.all([loadBatches(), loadPendingInwards()]);
    } catch (error: any) {
      console.error('Error saving batch:', error);
      let msg = 'Failed to save batch. Please try again.';
      if (error?.message?.includes('duplicate') || error?.code === '23505') {
        msg = 'A batch with this batch number already exists. Please use a different batch number.';
      } else if (error?.message) {
        msg = error.message;
      }
      showToast({ type: 'error', title: 'Error', message: msg });
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
      const match = batch.packaging_details.match(/(\d+)\s+(\w+)s?\s+x\s+(\d+(?:\.\d+)?)\s*([a-zA-Z]+)?/);
      if (match) {
        perPackWeight = match[3];
        packType = match[2].toLowerCase();
      }
    }

    // Product duty is only the default for a new batch. Existing batches
    // must load and preserve their own saved duty percentage.
    const selectedProduct = products.find(p => p.id === batch.product_id);
    const productDutyPercent = selectedProduct?.duty_percent || 0;
    const batchUnit = selectedProduct?.unit || (batch as any).products?.unit;
    const sanitizedPackaging = formatPackagingDetails(batch.packaging_details, batchUnit);

    setFormData({
      batch_number: batch.batch_number,
      product_id: batch.product_id,
      make_id: batch.make_id || '',
      import_container_id: batch.import_container_id || '',
      import_date: batch.import_date,
      import_quantity: batch.import_quantity,
      packaging_details: sanitizedPackaging,
      import_price_usd: batch.import_price_usd || 0,
      import_price_idr: batch.import_price || 0,
      exchange_rate_usd_to_idr: batch.exchange_rate_usd_to_idr || 0,
      duty_percent: batch.duty_percent ?? productDutyPercent,
      duty_charges: batch.duty_charges,
      duty_charge_type: batch.duty_charge_type ?? 'percentage',
      freight_charges: batch.freight_charges,
      freight_charge_type: 'fixed',
      other_charges: batch.other_charges,
      other_charge_type: 'fixed',
      expiry_date: batch.expiry_date,
      per_pack_weight: perPackWeight,
      pack_type: packType,
    });
    await loadProductMakes(batch.product_id, false);

    const { data: docs } = await supabase
      .from('batch_documents')
      .select('*')
      .eq('batch_id', batch.id);

    setUploadedFiles(docs || []);
    setModalOpen(true);
  };

  const handleDelete = async (id: string) => {
    const role = profile?.role;
    const isAdmin = role === 'admin' || role === 'accounts';
    const isWarehouse = role === 'warehouse';

    if (!isAdmin && !isWarehouse) {
      showToast({ type: 'error', title: 'Access Denied', message: 'You do not have permission to delete or archive batches.' });
      return;
    }

    const batch = batches.find(b => b.id === id);
    const batchLabel = batch?.batch_number ? `Batch ${batch.batch_number}` : 'This batch';

    try {
      // --- Common link checks (block all roles) ---

      const { data: salesItems } = await supabase
        .from('sales_invoice_items')
        .select('id, sales_invoices(invoice_number)')
        .eq('batch_id', id)
        .limit(1);

      if (salesItems && salesItems.length > 0) {
        const inv = (salesItems[0] as any).sales_invoices?.invoice_number;
        showToast({ type: 'error', title: 'Cannot Delete', message: `${batchLabel} is linked to invoice${inv ? ` ${inv}` : ''}. Delete the invoice first or contact your administrator.` });
        return;
      }

      const { data: challanItems } = await supabase
        .from('delivery_challan_items')
        .select('id')
        .eq('batch_id', id)
        .limit(1);

      if (challanItems && challanItems.length > 0) {
        showToast({ type: 'error', title: 'Cannot Delete', message: `${batchLabel} is linked to a delivery challan. Delete the challan first.` });
        return;
      }

      const { data: activeReservations } = await supabase
        .from('stock_reservations')
        .select('id, sales_orders(so_number)')
        .eq('batch_id', id)
        .eq('is_released', false)
        .limit(1);

      if (activeReservations && activeReservations.length > 0) {
        const soNum = (activeReservations[0] as any).sales_orders?.so_number;
        showToast({ type: 'error', title: 'Cannot Delete', message: `${batchLabel} has an active stock reservation${soNum ? ` for SO ${soNum}` : ''}. Release the reservation first.` });
        return;
      }

      const confirmed = await showConfirm({
        title: 'Archive Batch',
        message: `Archive ${batchLabel}? Inventory history will be preserved. A batch can only be archived after its stock and active reservations are zero.`,
        variant: 'warning',
        confirmLabel: 'Archive',
      });
      if (!confirmed) return;

      const { data: result, error: rpcError } = await supabase
        .rpc('archive_batch_inventory_v1', { p_batch_id: id });

      if (rpcError) {
        console.error('[Batch archive] RPC error:', rpcError);
        throw rpcError;
      }

      if (!result?.archived) {
        const reason = result?.reason || 'Archive blocked by policy.';
        console.error('[Batch archive] RPC returned archived=false:', reason, 'batch id:', id);
        showToast({ type: 'error', title: 'Archive Failed', message: reason });
        return;
      }

      showToast({ type: 'success', title: 'Archived', message: `${batchLabel} archived. All inventory history was preserved.` });
      await loadBatches();
    } catch (error: any) {
      console.error('[Batch delete] Unexpected error:', error);
      showToast({ type: 'error', title: 'Error', message: error?.message || 'Failed to delete batch.' });
    }
  };

  const resetForm = () => {
    batchOperationIdRef.current = null;
    setPendingInwardContext(null);
    setEditingBatch(null);
    setUploadedFiles([]);
    setProductMakes([]);
    setFormData({
      batch_number: '',
      product_id: '',
      make_id: '',
      import_container_id: '',
      import_date: '',
      import_quantity: 0,
      packaging_details: '',
      import_price_usd: 0,
      import_price_idr: 0,
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
    priceFieldRef.current = null;
  };

  const showTransactionHistory = async (productId: string, productName: string, productCode: string, batchId?: string, batchNumber?: string, unit?: string) => {
    setSelectedProductForHistory({ id: productId, name: productName, code: productCode, batchId, batchNumber, unit: unit || 'KG' });
    setHistoryFilter('all');
    setHistorySearch('');
    setExpandedHistoryRows(new Set());
    setTransactionHistoryModal(true);

    let txnQuery = supabase
      .from('inventory_v1_effective_ledger')
      .select('*')
      .or('metadata->>superseded.is.null,metadata->>superseded.neq.true')
      .order('transaction_date', { ascending: false })
      .order('created_at', { ascending: false });

    if (batchId) {
      txnQuery = txnQuery.eq('batch_id', batchId);
    } else {
      txnQuery = txnQuery.eq('product_id', productId);
    }

    const [txnResult, resResult] = await Promise.all([
      txnQuery,
      batchId
        ? supabase
            .from('stock_reservations')
            .select('id, reserved_quantity, status, reserved_at, is_released, released_at, release_reason, sales_orders(so_number, customers(company_name))')
            .eq('batch_id', batchId)
            .order('reserved_at', { ascending: false })
        : Promise.resolve({ data: [], error: null })
    ]);

    if (txnResult.error) {
      console.error('Error loading transaction history:', txnResult.error);
      showToast({ type: 'error', title: 'Error', message: 'Error loading transaction history: ' + txnResult.error.message });
      return;
    }

    const enrichedTxns = await Promise.all((txnResult.data || []).map(async (txn) => {
      let dcData = null;
      let soData = null;
      let customerData = null;
      let invoiceData = null;

      // For DC-type transactions
      if (txn.reference_number && txn.reference_number.startsWith('DO-')) {
        const { data: dc } = await supabase
          .from('delivery_challans')
          .select('challan_number, sales_order_id, customer_id, customers(company_name), sales_orders(so_number)')
          .eq('challan_number', txn.reference_number)
          .maybeSingle();
        dcData = dc;
        if (dc?.customers) customerData = dc.customers;
        if (dc?.sales_orders) soData = dc.sales_orders;
      }

      // For sale transactions via invoice — look up via reference_id (sales_invoice_item id)
      if (txn.transaction_type === 'sale' && txn.reference_type === 'sales_invoice_item' && txn.reference_id) {
        const { data: sii } = await supabase
          .from('sales_invoice_items')
          .select(`
            delivery_challan_item_id,
            invoice_id,
            sales_invoices(invoice_number, sales_order_id, customer_id, customers(company_name), sales_orders(so_number)),
            delivery_challan_items(challan_id, delivery_challans(challan_number, sales_order_id, sales_orders(so_number)))
          `)
          .eq('id', txn.reference_id)
          .maybeSingle();

        if (sii) {
          const si = sii.sales_invoices as any;
          if (si?.customers) customerData = si.customers;
          if (si?.sales_orders) soData = si.sales_orders;
          invoiceData = { invoice_number: si?.invoice_number };
          const dci = sii.delivery_challan_items as any;
          if (dci?.delivery_challans) {
            dcData = dci.delivery_challans;
            if (!soData && dci.delivery_challans.sales_orders) soData = dci.delivery_challans.sales_orders;
          }
        }
      }

      // Direct SO lookup if we have sales_order_id on the transaction
      if (!soData && txn.sales_order_id) {
        const { data: so } = await supabase
          .from('sales_orders')
          .select('so_number, customer_id, customers(company_name)')
          .eq('id', txn.sales_order_id)
          .maybeSingle();
        soData = so;
        if (so?.customers) customerData = so.customers;
      }

      return {
        ...txn,
        delivery_challans: dcData,
        sales_orders: soData,
        customer: customerData,
        invoice: invoiceData,
        _type: 'transaction' as const
      };
    }));

    const reservationEntries = (resResult.data || []).map((r: any) => ({
      id: r.id,
      _type: 'reservation' as const,
      quantity: r.reserved_quantity,
      status: r.status,
      is_released: r.is_released,
      released_at: r.released_at,
      release_reason: r.release_reason,
      created_at: r.reserved_at,
      transaction_date: r.reserved_at?.split('T')[0] || '',
      transaction_type: r.status === 'active' ? 'reserved' : 'reservation_released',
      so_number: r.sales_orders?.so_number,
      customer_name: r.sales_orders?.customers?.company_name,
    }));

    // Group repeated reservation events for the same SO on this batch
    const soReservationTimelineMap: Record<string, any[]> = {};
    reservationEntries.forEach((r: any) => {
      if (r.so_number) {
        if (!soReservationTimelineMap[r.so_number]) {
          soReservationTimelineMap[r.so_number] = [];
        }
        soReservationTimelineMap[r.so_number].push(r);
      }
    });

    // Sort chronologically (oldest first) to compute accurate running physical stock
    const chronological = [...enrichedTxns, ...reservationEntries].sort((a: any, b: any) => {
      const timeA = new Date(a.created_at || a.transaction_date).getTime();
      const timeB = new Date(b.created_at || b.transaction_date).getTime();
      if (timeA !== timeB) return timeA - timeB;
      const qtyA = parseFloat(a.quantity) || 0;
      const qtyB = parseFloat(b.quantity) || 0;
      return qtyB - qtyA;
    });

    let runningPhysicalStock = 0;
    const enrichedWithStock = chronological.map((item: any) => {
      const isPhysical = item._type === 'transaction' && item.is_effective !== false;
      const qty = parseFloat(item.quantity) || 0;
      const stockBefore = runningPhysicalStock;
      if (isPhysical) {
        runningPhysicalStock += qty;
      }
      const stockAfter = runningPhysicalStock;
      const soNum = item.so_number || item.sales_orders?.so_number;
      const soTimeline = soNum && soReservationTimelineMap[soNum] ? soReservationTimelineMap[soNum] : [];

      return {
        ...item,
        stock_before: stockBefore,
        stock_after: stockAfter,
        so_timeline: soTimeline,
      };
    });

    // Default: Newest first
    const newestFirst = enrichedWithStock.sort(
      (a: any, b: any) => new Date(b.created_at || b.transaction_date).getTime() - new Date(a.created_at || a.transaction_date).getTime()
    );

    setTransactionHistory(newestFirst);
  };

  const toggleProduct = (productId: string) => {
    setExpandedProducts(prev => {
      const next = new Set(prev);
      if (next.has(productId)) next.delete(productId);
      else next.add(productId);
      return next;
    });
  };

  const handleArchiveBatch = async (batchId: string) => {
    const confirmed = await showConfirm({
      title: 'Archive Batch',
      message: 'This batch has 0 stock. Archive it to hide from the active list?',
      confirmLabel: 'Archive',
    });
    if (!confirmed) return;
    try {
      const { data: result, error } = await supabase
        .rpc('archive_batch_inventory_v1', { p_batch_id: batchId });
      if (error) throw error;

      if (!result?.archived) {
        showToast({
          type: 'error',
          title: 'Archive Failed',
          message: result?.reason || 'Archive blocked by policy.',
        });
        return;
      }

      showToast({ type: 'success', title: 'Archived', message: 'Batch archived. Toggle "Show Archived" to view it.' });
      await loadBatches();
    } catch (error: any) {
      showToast({ type: 'error', title: 'Error', message: error?.message || 'Failed to archive batch' });
    }
  };

  const handleUnarchiveBatch = async (batchId: string) => {
    try {
      const { error } = await supabase
        .from('batches')
        .update({ is_active: true })
        .eq('id', batchId);
      if (error) throw error;
      showToast({ type: 'success', title: 'Restored', message: 'Batch restored successfully' });
      await loadBatches();
    } catch (error: any) {
      showToast({ type: 'error', title: 'Error', message: error?.message || 'Failed to restore batch' });
    }
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
    const importPriceIDR = formData.import_price_idr > 0 && formData.import_price_usd <= 0
      ? formData.import_price_idr
      : formData.import_price_usd * formData.exchange_rate_usd_to_idr;

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
    const importPriceIDR = formData.import_price_idr > 0 && formData.import_price_usd <= 0
      ? formData.import_price_idr
      : formData.import_price_usd * formData.exchange_rate_usd_to_idr;
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

  const canEdit = profile?.role === 'admin' || profile?.role === 'warehouse' || profile?.role === 'accounts';

  const modalProduct = products.find(p => p.id === formData.product_id);
  const rawModalUnit = modalProduct?.unit || (editingBatch as any)?.products?.unit;
  const modalPackUnit = abbreviateUnit(rawModalUnit);
  const modalProductDisplayUnit = formatUnit(rawModalUnit);

  return (
    <Layout>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-gray-900">Import Batches</h1>
            <p className="text-gray-600 mt-1">
              {canViewCosting ? 'Manage import batches with USD pricing and document tracking' : 'Manage import batches and document tracking'}
            </p>
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

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div className="bg-white rounded-lg shadow p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-gray-500">Active Batches</p>
                <p className="text-xl font-bold text-gray-900 mt-0.5">{batches.filter(b => b.is_active).length}</p>
              </div>
              <Package className="w-6 h-6 text-blue-600" />
            </div>
          </div>
          <div className="bg-white rounded-lg shadow p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-gray-500">Sold Out</p>
                <p className="text-xl font-bold text-orange-600 mt-0.5">{batches.filter(b => b.is_active && b.current_stock <= 0).length}</p>
              </div>
              <Archive className="w-6 h-6 text-orange-500" />
            </div>
          </div>
          <div className="bg-white rounded-lg shadow p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-gray-500">Low Stock</p>
                <p className="text-xl font-bold text-amber-600 mt-0.5">{batches.filter(b => b.is_active && isLowStock(b) && b.current_stock > 0).length}</p>
              </div>
              <AlertTriangle className="w-6 h-6 text-amber-500" />
            </div>
          </div>
          <div className="bg-white rounded-lg shadow p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-gray-500">Near Expiry</p>
                <p className="text-xl font-bold text-red-600 mt-0.5">{batches.filter(b => b.is_active && isNearExpiry(b)).length}</p>
              </div>
              <AlertTriangle className="w-6 h-6 text-red-500" />
            </div>
          </div>
        </div>

        <div className="bg-white rounded-lg shadow">
          <div className="p-3 border-b border-gray-200 flex items-center justify-between">
            <h2 className="font-semibold text-gray-900">Inward Pending</h2>
            <span className="text-xs text-gray-500">Approved Purchase Invoice receipts awaiting physical arrival</span>
          </div>
          {pendingInwards.length === 0 ? <p className="p-4 text-sm text-gray-400">No approved receipts pending inward.</p> : (
            <div className="overflow-x-auto"><table className="w-full text-sm"><thead className="bg-gray-50"><tr>
              <th className="px-3 py-2 text-left text-xs text-gray-500">Supplier / Invoice</th><th className="px-3 py-2 text-left text-xs text-gray-500">Product</th><th className="px-3 py-2 text-left text-xs text-gray-500">Make / Batch</th><th className="px-3 py-2 text-right text-xs text-gray-500">Pending</th><th className="px-3 py-2 text-right text-xs text-gray-500">Action</th>
            </tr></thead><tbody className="divide-y divide-gray-100">{pendingInwards.map(row => <tr key={row.item_id}>
              <td className="px-3 py-2">{row.supplier_name}<div className="text-xs text-gray-400">{row.invoice_number}</div></td><td className="px-3 py-2">{row.product_name}</td><td className="px-3 py-2">{row.make_name || 'Not specified'}<div className="text-xs text-gray-400">{row.batch_number || 'Batch at inward'}</div></td><td className="px-3 py-2 text-right font-semibold text-orange-700">{row.pending.toLocaleString()} {formatUnit(row.unit)}</td><td className="px-3 py-2 text-right"><button className="text-blue-600 hover:underline text-xs mr-2" onClick={() => { window.location.href = `/finance/purchase?document=${row.invoice_id}`; }}>Edit</button>{canEdit && <button className="text-green-600 hover:underline text-xs mr-2" onClick={() => void openPendingInward(row)}>Inward</button>}<button className="text-red-600 hover:underline text-xs" onClick={() => void rejectPendingInward(row)}>Reject</button></td>
            </tr>)}</tbody></table></div>
          )}
        </div>

        {/* Batches Table - Grouped by Product */}
        <div className="bg-white rounded-lg shadow">
          <div className="p-3 border-b border-gray-200 flex items-center gap-3">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input name="batch_search" aria-label="Search batches..."
                type="text"
                value={batchSearch}
                onChange={(e) => setBatchSearch(e.target.value)}
                placeholder="Search batches..."
                className="w-full pl-9 pr-4 py-1.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none text-sm"
              />
            </div>
            <button
              onClick={() => setShowArchived(!showArchived)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition ${showArchived ? 'bg-gray-700 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
            >
              {showArchived ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
              {showArchived ? 'Hide Archived' : 'Show Archived'}
            </button>
            <button
              onClick={() => {
                if (expandedProducts.size > 0) setExpandedProducts(new Set());
                else {
                  const allIds = new Set(batches.map(b => b.product_id));
                  setExpandedProducts(allIds);
                }
              }}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-gray-100 text-gray-600 hover:bg-gray-200 transition"
            >
              {expandedProducts.size > 0 ? 'Collapse All' : 'Expand All'}
            </button>
          </div>

          {loading ? (
            <div className="p-8 text-center">
              <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-blue-600 mx-auto" />
              <p className="mt-3 text-gray-500 text-sm">Loading batches...</p>
            </div>
          ) : (() => {
            const filtered = batches.filter(batch => {
              const isArchived = !batch.is_active;
              if (!showArchived && isArchived) return false;
              if (!batchSearch) return true;
              const q = batchSearch.toLowerCase();
              return (
                batch.batch_number?.toLowerCase().includes(q) ||
                batch.products?.product_name?.toLowerCase().includes(q) ||
                batch.products?.product_code?.toLowerCase().includes(q) ||
                batch.product_sources?.supplier_name?.toLowerCase().includes(q)
              );
            });

            const grouped = new Map<string, { productName: string; productCode: string; unit: string; productId: string; batches: typeof filtered }>();
            filtered.forEach(batch => {
              const key = batch.product_id;
              if (!grouped.has(key)) {
                grouped.set(key, {
                  productName: batch.products?.product_name || '',
                  productCode: batch.products?.product_code || '',
                  unit: batch.products?.unit || '',
                  productId: key,
                  batches: [],
                });
              }
              grouped.get(key)!.batches.push(batch);
            });

            const sortedGroups = Array.from(grouped.values()).sort((a, b) => {
              const aStock = a.batches.reduce((s, bt) => s + bt.current_stock, 0);
              const bStock = b.batches.reduce((s, bt) => s + bt.current_stock, 0);
              if (aStock > 0 && bStock <= 0) return -1;
              if (aStock <= 0 && bStock > 0) return 1;
              return a.productName.localeCompare(b.productName);
            });

            if (sortedGroups.length === 0) {
              return (
                <div className="px-6 py-8 text-center text-gray-400 text-sm">
                  {batchSearch ? 'No batches match your search.' : 'No batches found.'}
                </div>
              );
            }

            return (
              <div>
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 border-b border-gray-200">
                    <tr>
                      <th className="pl-3 pr-2 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider w-8"></th>
                      <th className="px-2 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Product Name</th>
                      <th className="px-2 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider w-28">Code</th>
                      <th className="px-2 py-2 text-center text-xs font-semibold text-gray-500 uppercase tracking-wider w-20">Batches</th>
                      <th className="px-2 py-2 text-center text-xs font-semibold text-gray-500 uppercase tracking-wider w-28">Sold / Res</th>
                      <th className="px-2 py-2 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider w-28 pr-3">Stock</th>
                    </tr>
                  </thead>
                </table>
                {sortedGroups.map(group => {
                  const isExpanded = expandedProducts.has(group.productId) || !!batchSearch;
                  const totalStock = group.batches.reduce((s, b) => s + b.current_stock, 0);
                  const activeBatches = group.batches.filter(b => b.is_active);
                  const totalSold = group.batches.reduce((s, b) => s + (b.import_quantity - b.current_stock), 0);
                  const totalReserved = group.batches.reduce((s, b) => s + (b.reserved_stock || 0), 0);
                  const zeroStockActive = activeBatches.filter(b => b.current_stock <= 0).length;

                  return (
                    <div key={group.productId} className="border-b border-gray-200 last:border-b-0">
                      <button
                        onClick={() => toggleProduct(group.productId)}
                        className="w-full hover:bg-gray-50 transition text-left"
                      >
                        <table className="w-full text-sm">
                          <tbody>
                            <tr>
                              <td className="pl-3 pr-2 py-2 w-8">
                                {isExpanded ? <ChevronDown className="w-4 h-4 text-gray-400" /> : <ChevronRight className="w-4 h-4 text-gray-400" />}
                              </td>
                              <td className="px-2 py-2">
                                <span className="font-semibold text-gray-900">{group.productName}</span>
                              </td>
                              <td className="px-2 py-2 w-28 text-xs text-gray-400">{group.productCode}</td>
                              <td className="px-2 py-2 w-20 text-center">
                                <span className="text-xs text-blue-700 font-medium">{activeBatches.length}</span>
                                {zeroStockActive > 0 && (
                                  <span className="text-[10px] text-orange-500 ml-1">({zeroStockActive} out)</span>
                                )}
                              </td>
                              <td className="px-2 py-2 w-28 text-center">
                                <span className="text-xs text-gray-600">{totalSold.toLocaleString()}</span>
                                {totalReserved > 0 && (
                                  <span className="text-xs text-amber-600 ml-1">/ {totalReserved.toLocaleString()}</span>
                                )}
                              </td>
                              <td className={`px-2 py-2 w-28 text-right pr-3 text-sm font-semibold ${totalStock > 0 ? 'text-gray-900' : 'text-red-500'}`}>
                                {totalStock.toLocaleString()} {formatUnit(group.unit)}
                              </td>
                            </tr>
                          </tbody>
                        </table>
                      </button>

                      {isExpanded && (
                        <div className="overflow-x-auto">
                          <table className="w-full text-xs">
                            <thead className="bg-gray-50">
                              <tr>
                                <th className="px-3 py-1.5 text-left font-semibold text-gray-500 uppercase tracking-wider">Batch #</th>
                                <th className="px-3 py-1.5 text-left font-semibold text-gray-500 uppercase tracking-wider">Make / Manufacturer</th>
                                <th className="px-3 py-1.5 text-left font-semibold text-gray-500 uppercase tracking-wider w-24">Import</th>
                                <th className="px-3 py-1.5 text-right font-semibold text-gray-500 uppercase tracking-wider w-20">Stock</th>
                                <th className="px-3 py-1.5 text-right font-semibold text-gray-500 uppercase tracking-wider w-16">Res</th>
                                <th className="px-3 py-1.5 text-right font-semibold text-gray-500 uppercase tracking-wider w-16">Free</th>
                                {canViewCosting && (
                                  <>
                                    <th className="px-3 py-1.5 text-right font-semibold text-gray-500 uppercase tracking-wider w-32">Price/unit</th>
                                    <th className="px-3 py-1.5 text-right font-semibold text-gray-500 uppercase tracking-wider w-36">Landed/unit</th>
                                  </>
                                )}
                                <th className="px-3 py-1.5 text-left font-semibold text-gray-500 uppercase tracking-wider w-24">Expiry</th>
                                <th className="px-3 py-1.5 text-center font-semibold text-gray-500 uppercase tracking-wider w-10">D</th>
                                <th className="px-3 py-1.5 text-right font-semibold text-gray-500 uppercase tracking-wider">Container</th>
                                {canEdit && <th className="px-3 py-1.5 text-center font-semibold text-gray-500 uppercase tracking-wider w-24"></th>}
                              </tr>
                            </thead>
                            <tbody>
                              {group.batches
                                .sort((a, b) => new Date(b.import_date).getTime() - new Date(a.import_date).getTime())
                                .map(batch => {
                                  const freeStock = batch.current_stock - (batch.reserved_stock || 0);
                                  const landedCostPerUnit = batch.landed_cost_per_unit || batch.import_price;
                                  const containerPerUnit = (batch.import_cost_allocated && batch.import_quantity > 0) ? batch.import_cost_allocated / batch.import_quantity : 0;
                                  const fullLandedIDR = landedCostPerUnit;
                                  const hasUSD = batch.import_price_usd && batch.exchange_rate_usd_to_idr;
                                  const isArchived = !batch.is_active;
                                  const isSoldOut = batch.current_stock <= 0 && batch.is_active;

                                  return (
                                    <tr key={batch.id} className={`border-t border-gray-100 hover:bg-gray-50 ${isArchived ? 'opacity-50 bg-gray-50' : isSoldOut ? 'bg-orange-50/30' : ''}`}>
                                      <td className="px-3 py-1.5">
                                        <button
                                          onClick={() => showTransactionHistory(batch.product_id, batch.products?.product_name || '', batch.products?.product_code || '', batch.id, batch.batch_number, batch.products?.unit || 'KG')}
                                          className="font-mono text-sm font-medium text-blue-600 hover:text-blue-800 hover:underline"
                                        >
                                          {batch.batch_number}
                                        </button>
                                        {isArchived && <span className="ml-1.5 text-[10px] text-gray-400 bg-gray-200 px-1 rounded">archived</span>}
                                      </td>
                                      <td className="px-3 py-1.5 text-gray-600">{batch.product_sources?.supplier_name || 'Not recorded'}</td>
                                      <td className="px-3 py-1.5 text-gray-500 whitespace-nowrap">{formatDate(batch.import_date)}</td>
                                      <td className="px-3 py-1.5 text-right">
                                        <span className={`font-semibold ${batch.current_stock <= 0 ? 'text-red-500' : isLowStock(batch) ? 'text-orange-600' : 'text-gray-900'}`}>
                                          {batch.current_stock.toLocaleString()}
                                        </span>
                                      </td>
                                      <td className="px-3 py-1.5 text-right">
                                        {batch.reserved_stock > 0 ? (
                                          <span className="text-amber-600 font-medium">{batch.reserved_stock.toLocaleString()}</span>
                                        ) : (
                                          <span className="text-gray-300">-</span>
                                        )}
                                      </td>
                                      <td className="px-3 py-1.5 text-right">
                                        <span className={`font-semibold ${freeStock <= 0 ? 'text-red-500' : 'text-green-600'}`}>
                                          {freeStock.toLocaleString()}
                                        </span>
                                      </td>
                                      {canViewCosting && (
                                        <>
                                          <td className="px-3 py-1.5 text-right">
                                            {hasUSD ? (
                                              <div>
                                                <span className="text-green-700 font-medium">{formatCurrency(batch.import_price_usd!, 'USD')}</span>
                                                <div className="text-[10px] text-gray-400">{formatCurrency(batch.import_price)} @ {batch.exchange_rate_usd_to_idr!.toLocaleString('id-ID')}</div>
                                              </div>
                                            ) : (
                                              <span className="text-gray-700 font-medium">{formatCurrency(batch.import_price)}</span>
                                            )}
                                          </td>
                                          <td className="px-3 py-1.5 text-right">
                                            {hasUSD ? (
                                              <div>
                                                <span className="text-blue-700 font-medium">{formatCurrency(fullLandedIDR / batch.exchange_rate_usd_to_idr!, 'USD')}</span>
                                                <div className="text-[10px] text-gray-500">{formatCurrency(fullLandedIDR)}</div>
                                                {containerPerUnit > 0 && (
                                                  <div className="text-[10px] text-gray-400">incl. ctr {formatCurrency(containerPerUnit)}/u</div>
                                                )}
                                              </div>
                                            ) : (
                                              <div>
                                                <span className="text-blue-700 font-medium">{formatCurrency(fullLandedIDR)}</span>
                                                {containerPerUnit > 0 && (
                                                  <div className="text-[10px] text-gray-400">incl. ctr {formatCurrency(containerPerUnit)}/u</div>
                                                )}
                                              </div>
                                            )}
                                          </td>
                                        </>
                                      )}
                                      <td className="px-3 py-1.5 whitespace-nowrap">
                                        <span className={isExpired(batch) ? 'text-red-600 font-semibold' : isNearExpiry(batch) ? 'text-orange-500 font-semibold' : 'text-gray-600'}>
                                          {batch.expiry_date ? formatDate(batch.expiry_date) : '—'}
                                        </span>
                                      </td>
                                      <td className="px-3 py-1.5 text-center">
                                        <button onClick={() => loadBatchDocuments(batch.id)} className="text-blue-600 hover:text-blue-800" title="Documents">
                                          <FileText className="w-3 h-3 inline" />
                                          <span className="ml-0.5">{batch.document_count || 0}</span>
                                        </button>
                                      </td>
                                      <td className="px-3 py-1.5 text-right text-gray-400 text-[10px] truncate max-w-[130px]">
                                        {batch.import_containers?.container_ref || '—'}
                                      </td>
                                      {canEdit && (
                                        <td className="px-3 py-1.5 text-center">
                                          <div className="flex items-center justify-center gap-0.5">
                                            <button onClick={() => handleEdit(batch)} className="p-1 text-blue-600 hover:bg-blue-50 rounded" title="Edit">
                                              <Edit className="w-3 h-3" />
                                            </button>
                                            {isSoldOut && (
                                              <button onClick={() => handleArchiveBatch(batch.id)} className="p-1 text-gray-500 hover:bg-gray-100 rounded" title="Archive">
                                                <Archive className="w-3 h-3" />
                                              </button>
                                            )}
                                            {isArchived && (
                                              <button onClick={() => handleUnarchiveBatch(batch.id)} className="p-1 text-green-600 hover:bg-green-50 rounded" title="Restore">
                                                <Eye className="w-3 h-3" />
                                              </button>
                                            )}
                                            <button onClick={() => handleDelete(batch.id)} className="p-1 text-red-600 hover:bg-red-50 rounded" title="Delete">
                                              <Trash2 className="w-3 h-3" />
                                            </button>
                                          </div>
                                        </td>
                                      )}
                                    </tr>
                                  );
                                })}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })()}
        </div>

        {/* Summary Section */}
        {canViewCosting && batches.length > 0 && (
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
            {/* Stock in Hand Value at Landed Cost */}
            <div className="mt-4 pt-4 border-t border-blue-200">
              <h4 className="text-sm font-bold text-gray-700 mb-3 flex items-center gap-1">
                <Package className="w-4 h-4 text-gray-500" />
                Stock in Hand Value (at Landed Cost)
              </h4>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                <div className="bg-white rounded-lg p-3 border border-blue-100">
                  <p className="text-xs text-gray-500 mb-1">Stock in Hand Value (IDR)</p>
                  <p className="text-xl font-bold text-gray-800">
                    {formatCurrency(
                      batches.reduce((sum, batch) => {
                        const landedCostPerUnit = batch.landed_cost_per_unit ?? batch.import_price;
                        return sum + (batch.current_stock * landedCostPerUnit);
                      }, 0)
                    )}
                  </p>
                </div>
                <div className="bg-white rounded-lg p-3 border border-blue-100">
                  <p className="text-xs text-gray-500 mb-1">Stock in Hand Quantity</p>
                  <p className="text-xl font-bold text-gray-800">
                    {batches.reduce((sum, batch) => sum + batch.current_stock, 0).toLocaleString()}
                  </p>
                  <p className="text-xs text-gray-400 mt-1">
                    of {batches.reduce((sum, batch) => sum + batch.import_quantity, 0).toLocaleString()} imported
                  </p>
                </div>
              </div>
              <div className="flex justify-between items-center text-sm">
                <span className="text-gray-600">Total Batches:</span>
                <span className="font-semibold text-gray-900">{batches.length}</span>
              </div>
              <div className="flex justify-between items-center text-sm mt-1">
                <span className="text-gray-600">Total Import Quantity:</span>
                <span className="font-semibold text-gray-900">
                  {batches.reduce((sum, batch) => sum + batch.import_quantity, 0).toLocaleString()}
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
          title={pendingInwardContext ? 'Approve Inward — Batch Details' : editingBatch ? 'Edit Batch' : 'Add New Batch'}
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
                  <input name="batch_number" aria-label="Batch Number"
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
                  <input name="import_date" aria-label="Import Date"
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
                  <input name="expiry_date" aria-label="Expiry Date"
                    type="date"
                    value={formData.expiry_date}
                    onChange={(e) => setFormData({ ...formData, expiry_date: e.target.value })}
                    className="w-full px-2 py-1 text-sm border border-gray-300 rounded focus:ring-1 focus:ring-blue-500"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-0.5">
                    Product *
                  </label>
                  <SearchableSelect
                    value={formData.product_id}
                    onChange={async (value) => {
                      const selectedProduct = products.find(p => p.id === value);
                      setFormData({
                        ...formData,
                        product_id: value,
                        make_id: '',
                        duty_percent: selectedProduct?.duty_percent || 0
                      });
                      await loadProductMakes(value);
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
                  <label className="block text-xs font-medium text-gray-700 mb-0.5">Make / Manufacturer {editingBatch ? '' : '*'}</label>
                  <SearchableSelect
                    value={formData.make_id}
                    onChange={(value) => setFormData({ ...formData, make_id: value })}
                    options={productMakes.map(m => ({ value: m.id, label: `${m.supplier_name || 'Unnamed make'}${m.grade ? ` (${m.grade})` : ''}` }))}
                    placeholder={productMakes.length ? 'Select Make / Manufacturer' : 'No makes recorded'}
                    className="text-sm"
                    required={!editingBatch}
                  />
                  {!productMakes.length && <p className="text-xs text-amber-600 mt-0.5">Add a Make / Manufacturer in the Product record first.</p>}
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
                    Import Quantity {modalProductDisplayUnit ? `(${modalProductDisplayUnit})` : ''} *
                  </label>
                  <input name="import_quantity" aria-label="Import Quantity"
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
                      Current Stock {modalProductDisplayUnit ? `(${modalProductDisplayUnit})` : ''}
                    </label>
                    <div className="w-full px-2 py-1 text-sm border border-gray-200 rounded bg-gray-50">
                      <span className="text-gray-700 font-medium">
                        {editingBatch.current_stock.toLocaleString()}{modalProductDisplayUnit ? ` ${modalProductDisplayUnit}` : ''}
                      </span>
                    </div>
                    <p className="text-xs text-gray-500 mt-0.5">
                      Available: {editingBatch.current_stock.toLocaleString()}{modalProductDisplayUnit ? ` ${modalProductDisplayUnit}` : ''} |
                      Sold: {(editingBatch.import_quantity - editingBatch.current_stock).toLocaleString()}{modalProductDisplayUnit ? ` ${modalProductDisplayUnit}` : ''}
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
                  <input name="per_pack_weight" aria-label="Per Pack Weight"
                    type="number"
                    step="0.001"
                    value={formData.per_pack_weight}
                    onChange={(e) => {
                      const newFormData = { ...formData, per_pack_weight: e.target.value };
                      if (formData.import_quantity && e.target.value) {
                        const perPack = parseFloat(e.target.value);
                        if (perPack) {
                          const packs = (formData.import_quantity / perPack).toFixed(0);
                          newFormData.packaging_details = `${packs} ${formData.pack_type}${parseInt(packs) !== 1 ? 's' : ''} x ${perPack}${modalPackUnit}`;
                        }
                      }
                      setFormData(newFormData);
                    }}
                    placeholder="e.g., 25"
                    className="w-full px-2 py-1 text-sm border border-gray-300 rounded focus:ring-1 focus:ring-blue-500"
                  />
                  <p className="text-xs text-gray-500 mt-0.5">{modalPackUnit ? `${modalPackUnit} per pack` : 'per pack'}</p>
                </div>

                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-0.5">
                    Pack Type
                  </label>
                  <select name="pack_type" aria-label="Pack Type"
                    value={formData.pack_type}
                    onChange={(e) => {
                      const newFormData = { ...formData, pack_type: e.target.value };
                      if (formData.import_quantity && formData.per_pack_weight) {
                        const perPack = parseFloat(formData.per_pack_weight);
                        if (perPack) {
                          const packs = (formData.import_quantity / perPack).toFixed(0);
                          newFormData.packaging_details = `${packs} ${e.target.value}${parseInt(packs) !== 1 ? 's' : ''} x ${perPack}${modalPackUnit}`;
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
                    {formatPackagingDetails(formData.packaging_details, rawModalUnit)}
                  </p>
                </div>
              )}
            </div>

            {canViewCosting && (
              <>
                <div className="border-b pb-1.5">
                  <h3 className="text-xs font-semibold text-gray-900 mb-1 flex items-center gap-1.5">
                    <DollarSign className="w-3.5 h-3.5 text-green-600" />
                    Purchase Price
                  </h3>
                  <div className="grid grid-cols-3 gap-2">
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-0.5">
                        Purchase Price (USD)
                      </label>
                      <MoneyInput
                        value={formData.import_price_usd}
                        onChange={handleUSDChange}
                        className="w-full px-2 py-1 text-sm border border-gray-300 rounded focus:ring-1 focus:ring-blue-500"
                        min="0"
                        placeholder="0.00"
                        maximumFractionDigits={4}
                      />
                    </div>

                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-0.5">
                        Purchase Price (IDR)
                      </label>
                      <MoneyInput
                        value={formData.import_price_idr}
                        onChange={handleIDRChange}
                        className="w-full px-2 py-1 text-sm border border-gray-300 rounded focus:ring-1 focus:ring-blue-500"
                        min="0"
                        placeholder="0"
                      />
                    </div>

                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-0.5">
                        Exchange Rate (IDR per USD)
                      </label>
                      <input name="exchange_rate_idr_per_usd" aria-label="Exchange Rate (IDR per USD)"
                        type="number"
                        value={formData.exchange_rate_usd_to_idr === 0 ? '' : formData.exchange_rate_usd_to_idr}
                        onChange={(e) => handleExchangeRateChange(e.target.value === '' ? 0 : Number(e.target.value))}
                        className="w-full px-2 py-1 text-sm border border-gray-300 rounded focus:ring-1 focus:ring-blue-500"
                        min="0"
                        step="0.0001"
                        placeholder="17000"
                      />
                      <p className="text-xs text-gray-500 mt-0.5">
                        1 USD = {formData.exchange_rate_usd_to_idr.toLocaleString()} IDR
                      </p>
                    </div>
                  </div>

                  {((formData.import_price_usd > 0 || formData.import_price_idr > 0) && formData.exchange_rate_usd_to_idr > 0) && (
                    <div className="mt-1 p-1.5 bg-green-50 border border-green-200 rounded">
                      <p className="text-xs text-green-800">
                        <span className="font-semibold">Purchase Price (IDR):</span>{' '}
                        {formatCurrency(formData.import_price_usd > 0 ? formData.import_price_usd * formData.exchange_rate_usd_to_idr : formData.import_price_idr)}
                      </p>
                      {formData.import_price_usd > 0 && (
                        <p className="text-xs text-green-600 mt-0.5">
                          {formatCurrency(formData.import_price_usd, 'USD')} × {formData.exchange_rate_usd_to_idr.toLocaleString()} = {formatCurrency(formData.import_price_usd * formData.exchange_rate_usd_to_idr)}
                        </p>
                      )}
                      {formData.import_price_idr > 0 && formData.import_price_usd <= 0 && (
                        <p className="text-xs text-green-600 mt-0.5">
                          {formatCurrency(formData.import_price_idr)} ÷ {formData.exchange_rate_usd_to_idr.toLocaleString()} = {formatCurrency(formData.import_price_idr / formData.exchange_rate_usd_to_idr, 'USD')}
                        </p>
                      )}
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
                          <input name="duty_form_a1" aria-label="Duty (Form A1 %)"
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
                        {formData.duty_percent > 0 && (formData.import_price_usd > 0 || formData.import_price_idr > 0) && (
                          <p className="text-xs text-gray-600 mt-0.5">
                            = {formatCurrency((formData.import_price_idr > 0 && formData.import_price_usd <= 0 ? formData.import_price_idr : formData.import_price_usd * formData.exchange_rate_usd_to_idr) * formData.duty_percent / 100)}
                          </p>
                        )}
                      </div>

                      <div>
                        <label className="block text-xs font-medium text-gray-700 mb-1">
                          Freight
                        </label>
                        <div className="flex gap-0.5">
                          {formData.freight_charge_type === 'fixed' ? (
                            <MoneyInput
                              value={formData.freight_charges}
                              onChange={(amount) => setFormData({ ...formData, freight_charges: amount })}
                              className="flex-1 px-1.5 py-1 text-xs border border-gray-300 rounded focus:ring-1 focus:ring-blue-500"
                              min="0"
                              placeholder="0"
                              maximumFractionDigits={4}
                            />
                          ) : (
                            <input name="freight_charges" aria-label="0"
                              data-non-currency="percentage"
                              type="number"
                              value={formData.freight_charges === 0 ? '' : formData.freight_charges}
                              onChange={(e) => setFormData({ ...formData, freight_charges: e.target.value === '' ? 0 : Number(e.target.value) })}
                              className="flex-1 px-1.5 py-1 text-xs border border-gray-300 rounded focus:ring-1 focus:ring-blue-500"
                              min="0"
                              step="0.01"
                              placeholder="0"
                            />
                          )}
                          <select name="freight_charge_type" aria-label="Freight Charge Type"
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
                          {formData.other_charge_type === 'fixed' ? (
                            <MoneyInput
                              value={formData.other_charges}
                              onChange={(amount) => setFormData({ ...formData, other_charges: amount })}
                              className="flex-1 px-1.5 py-1 text-xs border border-gray-300 rounded focus:ring-1 focus:ring-blue-500"
                              min="0"
                              placeholder="0"
                              maximumFractionDigits={4}
                            />
                          ) : (
                            <input name="other_charges" aria-label="0"
                              data-non-currency="percentage"
                              type="number"
                              value={formData.other_charges === 0 ? '' : formData.other_charges}
                              onChange={(e) => setFormData({ ...formData, other_charges: e.target.value === '' ? 0 : Number(e.target.value) })}
                              className="flex-1 px-1.5 py-1 text-xs border border-gray-300 rounded focus:ring-1 focus:ring-blue-500"
                              min="0"
                              step="0.01"
                              placeholder="0"
                            />
                          )}
                          <select name="other_charge_type" aria-label="Other Charge Type"
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
              </>
            )}

            {canViewCosting && (
              <div className="bg-blue-50 border border-blue-200 rounded p-2">
              <h3 className="text-xs font-semibold text-blue-900 mb-1.5">Total Cost Summary</h3>
              <div className="space-y-0.5 text-xs text-blue-800">
                <div className="flex justify-between">
                  <span>Purchase Price (per unit):</span>
                  <span className="font-medium">
                    {formatCurrency(formData.import_price_idr > 0 && formData.import_price_usd <= 0 ? formData.import_price_idr : formData.import_price_usd * formData.exchange_rate_usd_to_idr)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>Duty (Form A1):</span>
                  <span className="font-medium">
                    {formatCurrency((formData.import_price_idr > 0 && formData.import_price_usd <= 0 ? formData.import_price_idr : formData.import_price_usd * formData.exchange_rate_usd_to_idr) * formData.duty_percent / 100)}
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
                          {formData.import_price_usd > 0 && (
                            <div className="font-bold text-green-700">
                              {formatCurrency(formData.import_price_usd * formData.import_quantity, 'USD')}
                            </div>
                          )}
                          <div className="text-xs text-green-600">
                            {formatCurrency(calculateTotalCostIDR() * formData.import_quantity)}
                          </div>
                        </div>
                      </div>
                      {formData.import_price_usd > 0 && (
                        <div className="text-xs text-green-700 mt-0.5">
                          {formatCurrency(formData.import_price_usd, 'USD')} × {formData.import_quantity} = {formatCurrency(formData.import_price_usd * formData.import_quantity, 'USD')}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
              </div>
            )}

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
                {pendingInwardContext ? 'Approve Inward' : editingBatch ? 'Update Batch' : 'Add Batch'}
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
                  href={signedUrlCache[doc.file_url] || doc.file_url}
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
                      <span>{formatDate(doc.uploaded_at)}</span>
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

        {/* Stock Movements Ledger Modal */}
        <Modal
          isOpen={transactionHistoryModal}
          onClose={() => {
            setTransactionHistoryModal(false);
            setSelectedProductForHistory(null);
            setTransactionHistory([]);
            setHistoryFilter('all');
            setHistorySearch('');
            setExpandedHistoryRows(new Set());
          }}
          title="Stock Movements"
          subtitle={
            selectedProductForHistory
              ? `${selectedProductForHistory.name} · Batch ${selectedProductForHistory.batchNumber || selectedProductForHistory.code || ''}`
              : undefined
          }
          size="xl"
          maxWidth="max-w-5xl"
          maxHeight="max-h-[75vh]"
        >
          {(() => {
            const stockTxns = transactionHistory.filter((t: any) => t._type === 'transaction');
            const resTxns = transactionHistory.filter((t: any) => t._type === 'reservation');
            const activeRes = resTxns.filter((t: any) => t.status === 'active');
            const totalIn = stockTxns.filter((t: any) => parseFloat(t.quantity) > 0).reduce((s: number, t: any) => s + parseFloat(t.quantity), 0);
            const totalOut = stockTxns.filter((t: any) => parseFloat(t.quantity) < 0).reduce((s: number, t: any) => s + Math.abs(parseFloat(t.quantity)), 0);
            const totalReserved = activeRes.reduce((s: number, t: any) => s + parseFloat(t.quantity), 0);
            const currentStock = totalIn - totalOut;
            const freeStock = currentStock - totalReserved;
            const unit = selectedProductForHistory?.unit || 'KG';

            const formatQtyValue = (val: number | string) => {
              const num = typeof val === 'string' ? parseFloat(val) : val;
              if (isNaN(num)) return '0';
              return Number.isInteger(num)
                ? num.toLocaleString()
                : num.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 3 });
            };

            const getMovementCategory = (item: any): 'in' | 'out' | 'reservations' | 'adjustments' | 'other' => {
              if (item._type === 'reservation') return 'reservations';
              const type = (item.transaction_type || '').toLowerCase();
              if (type === 'adjustment') return 'adjustments';
              const qty = parseFloat(item.quantity) || 0;
              if (type === 'sales_return' || type === 'return' || qty > 0) return 'in';
              if (qty < 0) return 'out';
              return 'other';
            };

            const counts = {
              all: transactionHistory.length,
              in: transactionHistory.filter((t: any) => getMovementCategory(t) === 'in').length,
              out: transactionHistory.filter((t: any) => getMovementCategory(t) === 'out').length,
              reservations: transactionHistory.filter((t: any) => getMovementCategory(t) === 'reservations').length,
              adjustments: transactionHistory.filter((t: any) => getMovementCategory(t) === 'adjustments').length,
            };

            const filteredHistory = transactionHistory.filter((item: any) => {
              if (historyFilter !== 'all') {
                const cat = getMovementCategory(item);
                if (cat !== historyFilter) return false;
              }

              if (historySearch.trim()) {
                const query = historySearch.toLowerCase().trim();
                const refNum = (item.reference_number || '').toLowerCase();
                const soNum = (item.so_number || item.sales_orders?.so_number || '').toLowerCase();
                const dcNum = (item.delivery_challans?.challan_number || '').toLowerCase();
                const invNum = (item.invoice?.invoice_number || '').toLowerCase();
                const custName = (item.customer?.company_name || item.customer_name || '').toLowerCase();
                const notes = (item.notes || '').toLowerCase();
                const reason = (item.release_reason || '').toLowerCase();
                const typeStr = (item.transaction_type || '').toLowerCase();

                const matches = refNum.includes(query) ||
                  soNum.includes(query) ||
                  dcNum.includes(query) ||
                  invNum.includes(query) ||
                  custName.includes(query) ||
                  notes.includes(query) ||
                  reason.includes(query) ||
                  typeStr.includes(query);

                if (!matches) return false;
              }

              return true;
            });

            const toggleRow = (id: string) => {
              setExpandedHistoryRows(prev => {
                const next = new Set(prev);
                if (next.has(id)) next.delete(id);
                else next.add(id);
                return next;
              });
            };

            const renderTypeBadge = (item: any) => {
              if (item._type === 'reservation') {
                const isActive = item.status === 'active';
                return (
                  <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold tracking-wide uppercase ${
                    isActive
                      ? 'bg-amber-50 text-amber-800 border border-amber-300/70'
                      : 'bg-slate-100 text-slate-600 border border-slate-300/70'
                  }`}>
                    {isActive ? 'RESERVATION' : 'RESERVATION RELEASED'}
                  </span>
                );
              }

              const type = (item.transaction_type || '').toLowerCase();
              const qty = parseFloat(item.quantity) || 0;

              let badgeStyle = 'bg-gray-100 text-gray-700 border-gray-300';
              let label = type.replace(/_/g, ' ').toUpperCase();
              let sign = '';

              if (type === 'sales_return' || type === 'return') {
                badgeStyle = 'bg-teal-50 text-teal-800 border-teal-300';
                label = 'RETURN';
                sign = '+';
              } else if (type === 'purchase' || type === 'certified_opening' || (qty > 0 && type !== 'adjustment')) {
                badgeStyle = 'bg-emerald-50 text-emerald-800 border-emerald-300';
                label = 'INWARD';
                sign = '+';
              } else if (type === 'delivery_challan') {
                badgeStyle = 'bg-rose-50 text-rose-800 border-rose-300';
                label = 'DELIVERY';
                sign = '-';
              } else if (type === 'sale') {
                badgeStyle = 'bg-rose-50 text-rose-800 border-rose-300';
                label = 'SALE';
                sign = '-';
              } else if (type === 'adjustment') {
                badgeStyle = 'bg-purple-50 text-purple-800 border-purple-300';
                label = 'ADJUSTMENT';
                sign = qty > 0 ? '+' : qty < 0 ? '-' : '';
              }

              return (
                <div className="flex items-center gap-1">
                  <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold tracking-wide uppercase border ${badgeStyle}`}>
                    {sign && <span className="mr-0.5 font-bold">{sign}</span>}
                    {label}
                  </span>
                  {item.is_effective === false && (
                    <span className="inline-flex items-center px-1.5 py-0.2 rounded text-[9px] font-medium bg-gray-100 text-gray-500 border border-gray-300">
                      Historical
                    </span>
                  )}
                </div>
              );
            };

            return (
              <div className="flex flex-col -m-4">
                {/* 1. Top Stock Summary Cards */}
                <div className="p-4 pb-2 bg-gray-50/70 border-b border-gray-200">
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                    <div className="bg-emerald-50/90 border border-emerald-200 rounded-lg p-2.5 text-center shadow-xs">
                      <div className="text-[11px] font-bold text-emerald-700 uppercase tracking-wider">IN</div>
                      <div className="text-base font-extrabold text-emerald-900 leading-tight mt-0.5">
                        {formatQtyValue(totalIn)} <span className="text-xs font-semibold text-emerald-700">{unit}</span>
                      </div>
                    </div>
                    <div className="bg-rose-50/90 border border-rose-200 rounded-lg p-2.5 text-center shadow-xs">
                      <div className="text-[11px] font-bold text-rose-700 uppercase tracking-wider">OUT</div>
                      <div className="text-base font-extrabold text-rose-900 leading-tight mt-0.5">
                        {formatQtyValue(totalOut)} <span className="text-xs font-semibold text-rose-700">{unit}</span>
                      </div>
                    </div>
                    <div className="bg-amber-50/90 border border-amber-200 rounded-lg p-2.5 text-center shadow-xs">
                      <div className="text-[11px] font-bold text-amber-700 uppercase tracking-wider">RESERVED</div>
                      <div className="text-base font-extrabold text-amber-900 leading-tight mt-0.5">
                        {formatQtyValue(totalReserved)} <span className="text-xs font-semibold text-amber-700">{unit}</span>
                      </div>
                    </div>
                    <div className={`${freeStock < 0 ? 'bg-red-50/90 border-red-200' : 'bg-blue-50/90 border-blue-200'} border rounded-lg p-2.5 text-center shadow-xs`}>
                      <div className={`text-[11px] font-bold uppercase tracking-wider ${freeStock < 0 ? 'text-red-700' : 'text-blue-700'}`}>
                        FREE
                      </div>
                      <div className={`text-base font-extrabold leading-tight mt-0.5 ${freeStock < 0 ? 'text-red-900' : 'text-blue-900'}`}>
                        {formatQtyValue(freeStock)} <span className={`text-xs font-semibold ${freeStock < 0 ? 'text-red-700' : 'text-blue-700'}`}>{unit}</span>
                      </div>
                    </div>
                  </div>

                  {/* 2. Compact Filter Pills & Search Input */}
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mt-3">
                    <div className="flex items-center gap-1.5 overflow-x-auto pb-1 sm:pb-0">
                      {[
                        { id: 'all', label: 'All', count: counts.all },
                        { id: 'in', label: 'In', count: counts.in },
                        { id: 'out', label: 'Out', count: counts.out },
                        { id: 'reservations', label: 'Reservations', count: counts.reservations },
                        { id: 'adjustments', label: 'Adjustments', count: counts.adjustments },
                      ].map(tab => (
                        <button
                          key={tab.id}
                          onClick={() => setHistoryFilter(tab.id as any)}
                          className={`px-2.5 py-1 text-xs font-medium rounded-full transition-colors whitespace-nowrap flex items-center gap-1.5 ${
                            historyFilter === tab.id
                              ? 'bg-blue-600 text-white shadow-xs'
                              : 'bg-white text-gray-600 hover:bg-gray-100 border border-gray-200'
                          }`}
                        >
                          <span>{tab.label}</span>
                          <span className={`text-[10px] px-1.5 py-0.2 rounded-full font-semibold ${
                            historyFilter === tab.id ? 'bg-blue-700 text-white' : 'bg-gray-100 text-gray-600'
                          }`}>
                            {tab.count}
                          </span>
                        </button>
                      ))}
                    </div>

                    <div className="relative min-w-[200px] sm:w-64">
                      <Search className="w-3.5 h-3.5 text-gray-400 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                      <input
                        type="text"
                        value={historySearch}
                        onChange={(e) => setHistorySearch(e.target.value)}
                        placeholder="Search reference, SO, customer..."
                        className="w-full pl-8 pr-3 py-1 text-xs bg-white border border-gray-300 rounded-md focus:outline-none focus:ring-1 focus:ring-blue-500 shadow-xs"
                      />
                    </div>
                  </div>
                </div>

                {/* 3. Main Movements Table */}
                <div className="overflow-x-auto max-h-[calc(75vh-200px)] min-h-[180px] overflow-y-auto">
                  {filteredHistory.length > 0 ? (
                    <table className="w-full text-left text-xs border-collapse">
                      <thead className="bg-gray-100 text-gray-600 font-semibold sticky top-0 z-10 border-b border-gray-200 shadow-xs">
                        <tr>
                          <th className="py-2 px-3 whitespace-nowrap">DATE</th>
                          <th className="py-2 px-3 whitespace-nowrap">TYPE</th>
                          <th className="py-2 px-3 text-right whitespace-nowrap">QTY</th>
                          <th className="py-2 px-3 whitespace-nowrap">REFERENCE</th>
                          <th className="py-2 px-3 whitespace-nowrap">CUSTOMER / DESCRIPTION</th>
                          <th className="py-2 px-3 text-right whitespace-nowrap">STOCK</th>
                          <th className="py-2 px-2 text-center w-8"></th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {filteredHistory.map((item: any) => {
                          const isReservation = item._type === 'reservation';
                          const isEvidenceOnly = !isReservation && item.is_effective === false;
                          const qty = parseFloat(item.quantity) || 0;
                          const isActiveRes = isReservation && item.status === 'active';
                          const isReleasedRes = isReservation && item.status !== 'active';
                          const isExpanded = expandedHistoryRows.has(item.id);

                          // Visual styling for row
                          let rowBg = 'hover:bg-blue-50/30';
                          if (isActiveRes) rowBg = 'bg-amber-50/25 hover:bg-amber-50/50';
                          else if (isReleasedRes) rowBg = 'bg-slate-50/40 hover:bg-slate-50/70 text-gray-500';
                          else if (isEvidenceOnly) rowBg = 'bg-gray-50/40 hover:bg-gray-50/70 text-gray-500';

                          return (
                            <tr
                              key={item.id}
                              onClick={() => toggleRow(item.id)}
                              className={`cursor-pointer transition-colors ${rowBg} ${isExpanded ? 'bg-blue-50/40' : ''}`}
                            >
                              <td className="py-2 px-3 whitespace-nowrap text-gray-600 font-medium">
                                {formatDate(item.transaction_date || item.created_at)}
                              </td>

                              <td className="py-2 px-3 whitespace-nowrap">
                                {renderTypeBadge(item)}
                              </td>

                              <td className="py-2 px-3 text-right whitespace-nowrap font-mono">
                                {isReservation ? (
                                  isActiveRes ? (
                                    <span className="font-semibold text-amber-700">
                                      {formatQtyValue(qty)} {unit}
                                    </span>
                                  ) : (
                                    <span className="text-gray-400 font-normal">—</span>
                                  )
                                ) : qty > 0 ? (
                                  <span className="font-bold text-emerald-700">
                                    +{formatQtyValue(qty)} {unit}
                                  </span>
                                ) : qty < 0 ? (
                                  <span className="font-bold text-rose-700">
                                    -{formatQtyValue(Math.abs(qty))} {unit}
                                  </span>
                                ) : (
                                  <span className="text-gray-400 font-normal">
                                    0 {unit}
                                  </span>
                                )}
                              </td>

                              <td className="py-2 px-3 whitespace-nowrap">
                                {item.reference_number ? (
                                  item.reference_number.startsWith('DO-') ? (
                                    <button
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        openQuickViewDC(item.reference_number);
                                      }}
                                      className="font-mono font-medium text-blue-600 hover:text-blue-800 hover:underline inline-flex items-center gap-0.5"
                                    >
                                      {item.reference_number}
                                      <ExternalLink className="w-2.5 h-2.5" />
                                    </button>
                                  ) : item.reference_number.startsWith('INV-') || item.reference_number.startsWith('SAPJ-') || item.transaction_type === 'sale' ? (
                                    <button
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        openQuickViewInvoice(item.reference_number);
                                      }}
                                      className="font-mono font-medium text-blue-600 hover:text-blue-800 hover:underline inline-flex items-center gap-0.5"
                                    >
                                      {item.reference_number}
                                      <ExternalLink className="w-2.5 h-2.5" />
                                    </button>
                                  ) : item.reference_number.startsWith('SO-') ? (
                                    <button
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        openQuickViewSO(item.reference_number);
                                      }}
                                      className="font-mono font-medium text-blue-600 hover:text-blue-800 hover:underline inline-flex items-center gap-0.5"
                                    >
                                      {item.reference_number}
                                      <ExternalLink className="w-2.5 h-2.5" />
                                    </button>
                                  ) : (
                                    <span className="font-mono text-gray-700">{item.reference_number}</span>
                                  )
                                ) : item.so_number ? (
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      openQuickViewSO(item.so_number);
                                    }}
                                    className="font-mono font-medium text-blue-600 hover:text-blue-800 hover:underline inline-flex items-center gap-0.5"
                                  >
                                    {item.so_number}
                                    <ExternalLink className="w-2.5 h-2.5" />
                                  </button>
                                ) : (
                                  <span className="text-gray-400">—</span>
                                )}
                              </td>

                              <td className="py-2 px-3 max-w-[220px] truncate">
                                {isReservation ? (
                                  isReleasedRes ? (
                                    <span className="text-gray-600">
                                      <strong className="font-medium text-gray-700">{formatQtyValue(qty)} {unit} released</strong>
                                      {item.customer_name ? ` · ${item.customer_name}` : ''}
                                    </span>
                                  ) : (
                                    <span className="text-gray-800 font-medium">{item.customer_name || 'Active Reservation'}</span>
                                  )
                                ) : (
                                  <span className="text-gray-800 font-medium">
                                    {item.customer?.company_name || (item.notes && !item.notes.includes('[backfilled]') ? item.notes : 'Stock Movement')}
                                  </span>
                                )}
                              </td>

                              <td className="py-2 px-3 text-right whitespace-nowrap font-mono font-bold text-gray-900">
                                {formatQtyValue(item.stock_after)} <span className="text-[11px] font-normal text-gray-500">{unit}</span>
                              </td>

                              <td className="py-2 px-2 text-center text-gray-400">
                                {isExpanded ? (
                                  <ChevronDown className="w-4 h-4 mx-auto text-blue-600" />
                                ) : (
                                  <ChevronRight className="w-4 h-4 mx-auto hover:text-gray-600" />
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  ) : (
                    <div className="text-center py-10 text-gray-500">
                      <Package className="w-10 h-10 mx-auto mb-2 text-gray-300" />
                      <p className="text-sm font-medium">No stock movements found</p>
                      {historySearch && (
                        <p className="text-xs text-gray-400 mt-1">Try clearing your search filter</p>
                      )}
                    </div>
                  )}
                </div>

                {/* 4. Row Expansion Details Drawer (Rendered inline below selected row when expanded) */}
                {Array.from(expandedHistoryRows).map((rowId) => {
                  const item = filteredHistory.find((h: any) => h.id === rowId);
                  if (!item) return null;
                  const soNum = item.so_number || item.sales_orders?.so_number;
                  const soTimeline = item.so_timeline || [];

                  return (
                    <div key={`expanded-${item.id}`} className="bg-blue-50/30 border-t border-b border-blue-200/80 p-3.5 text-xs">
                      <div className="flex items-center justify-between pb-2 mb-2 border-b border-blue-200/50">
                        <div className="font-semibold text-gray-900 flex items-center gap-2">
                          <span>Details:</span>
                          <span className="font-mono text-gray-600 font-normal">
                            {formatDate(item.transaction_date || item.created_at)} ({new Date(item.created_at).toLocaleTimeString()})
                          </span>
                        </div>
                        <button
                          onClick={() => toggleRow(item.id)}
                          className="text-gray-400 hover:text-gray-600 text-xs"
                        >
                          Close Details
                        </button>
                      </div>

                      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                        {/* Col 1: Movement Stock Audit */}
                        <div className="bg-white p-2.5 rounded border border-gray-200 shadow-xs space-y-1">
                          <div className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1">
                            Physical Stock Impact
                          </div>
                          <div className="flex justify-between">
                            <span className="text-gray-500">Stock Before:</span>
                            <span className="font-mono font-semibold text-gray-800">{formatQtyValue(item.stock_before)} {unit}</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-gray-500">Movement Qty:</span>
                            <span className="font-mono font-semibold">
                              {item._type === 'reservation' ? (
                                <span className="text-amber-700">{formatQtyValue(item.quantity)} {unit} (Reservation)</span>
                              ) : parseFloat(item.quantity) > 0 ? (
                                <span className="text-emerald-700">+{formatQtyValue(item.quantity)} {unit}</span>
                              ) : (
                                <span className="text-rose-700">-{formatQtyValue(Math.abs(parseFloat(item.quantity)))} {unit}</span>
                              )}
                            </span>
                          </div>
                          <div className="flex justify-between pt-1 border-t border-gray-100">
                            <span className="text-gray-700 font-medium">Stock After:</span>
                            <span className="font-mono font-bold text-gray-900">{formatQtyValue(item.stock_after)} {unit}</span>
                          </div>
                        </div>

                        {/* Col 2: Document Lineage & Customer */}
                        <div className="bg-white p-2.5 rounded border border-gray-200 shadow-xs space-y-1">
                          <div className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1">
                            Document References
                          </div>
                          {(item.customer?.company_name || item.customer_name) && (
                            <div className="flex justify-between">
                              <span className="text-gray-500">Customer:</span>
                              <span className="font-medium text-gray-800 text-right">{item.customer?.company_name || item.customer_name}</span>
                            </div>
                          )}
                          {item.reference_number && (
                            <div className="flex justify-between items-center">
                              <span className="text-gray-500">Reference:</span>
                              <span className="font-mono font-medium text-gray-800">{item.reference_number}</span>
                            </div>
                          )}
                          {soNum && (
                            <div className="flex justify-between items-center">
                              <span className="text-gray-500">Sales Order:</span>
                              <button
                                onClick={() => openQuickViewSO(soNum)}
                                className="font-mono text-blue-600 hover:text-blue-800 hover:underline font-semibold inline-flex items-center gap-0.5"
                              >
                                {soNum}
                                <ExternalLink className="w-2.5 h-2.5" />
                              </button>
                            </div>
                          )}
                          {item.delivery_challans?.challan_number && (
                            <div className="flex justify-between items-center">
                              <span className="text-gray-500">Delivery Challan:</span>
                              <button
                                onClick={() => openQuickViewDC(item.delivery_challans.challan_number)}
                                className="font-mono text-blue-600 hover:text-blue-800 hover:underline font-semibold inline-flex items-center gap-0.5"
                              >
                                {item.delivery_challans.challan_number}
                                <ExternalLink className="w-2.5 h-2.5" />
                              </button>
                            </div>
                          )}
                          {item.invoice?.invoice_number && (
                            <div className="flex justify-between items-center">
                              <span className="text-gray-500">Sales Invoice:</span>
                              <button
                                onClick={() => openQuickViewInvoice(item.invoice.invoice_number)}
                                className="font-mono text-blue-600 hover:text-blue-800 hover:underline font-semibold inline-flex items-center gap-0.5"
                              >
                                {item.invoice.invoice_number}
                                <ExternalLink className="w-2.5 h-2.5" />
                              </button>
                            </div>
                          )}
                        </div>

                        {/* Col 3: Reasons & Technical Audit */}
                        <div className="bg-white p-2.5 rounded border border-gray-200 shadow-xs space-y-1">
                          <div className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1">
                            Notes & Classification
                          </div>
                          {item.release_reason && (
                            <div>
                              <span className="text-gray-500">Release Reason: </span>
                              <span className="text-gray-800 font-medium">{item.release_reason}</span>
                            </div>
                          )}
                          {item.notes && (
                            <div>
                              <span className="text-gray-500">Notes: </span>
                              <span className="text-gray-700 italic">{item.notes}</span>
                            </div>
                          )}
                          {item.is_effective === false && (
                            <div className="p-1.5 bg-amber-50 rounded border border-amber-200 text-[10px] text-amber-800 mt-1">
                              Historical evidence · Preserved for lineage · 0 effective physical stock impact
                            </div>
                          )}
                        </div>
                      </div>

                      {/* Group Repeated Reservation Events for the same SO */}
                      {soTimeline.length > 1 && (
                        <div className="mt-2.5 p-2.5 bg-amber-50/70 border border-amber-200 rounded-md">
                          <div className="font-semibold text-amber-900 text-[11px] mb-1.5 flex items-center justify-between">
                            <span>{soNum} · Reservation History</span>
                            <span className="text-[10px] font-normal text-amber-700">{soTimeline.length} events recorded</span>
                          </div>
                          <div className="space-y-1">
                            {soTimeline.map((rel: any) => (
                              <div key={rel.id} className="flex items-center justify-between text-[11px] py-0.5 border-b border-amber-100 last:border-0">
                                <div className="flex items-center gap-1.5">
                                  <span className={`w-1.5 h-1.5 rounded-full ${rel.status === 'active' ? 'bg-amber-500' : 'bg-gray-400'}`} />
                                  <span className="font-medium text-gray-800">
                                    {rel.status === 'active' ? 'Reserved' : 'Released'} {formatQtyValue(rel.quantity)} {unit}
                                  </span>
                                  {rel.release_reason && (
                                    <span className="text-gray-500 text-[10px]">({rel.release_reason})</span>
                                  )}
                                </div>
                                <span className="text-gray-400 font-mono text-[10px]">
                                  {formatDate(rel.released_at || rel.created_at)}
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}

                {/* 5. Sticky Footer: Current Stock Summary */}
                <div className="bg-gray-50 border-t border-gray-200 px-4 py-2.5 flex flex-wrap items-center justify-between text-xs text-gray-600 gap-2">
                  <div className="flex items-center gap-3">
                    <span>
                      Current Stock: <strong className="text-gray-900">{formatQtyValue(currentStock)} {unit}</strong>
                    </span>
                    <span className="text-gray-300">|</span>
                    <span>
                      Reserved: <strong className="text-amber-800">{formatQtyValue(totalReserved)} {unit}</strong>
                    </span>
                    <span className="text-gray-300">|</span>
                    <span>
                      Free: <strong className={freeStock < 0 ? 'text-red-700' : 'text-blue-700'}>{formatQtyValue(freeStock)} {unit}</strong>
                    </span>
                  </div>
                  <div className="text-[11px] text-gray-500 font-medium">
                    Showing {filteredHistory.length} of {transactionHistory.length} movements
                  </div>
                </div>
              </div>
            );
          })()}
        </Modal>
      </div>

      {quickViewSO && (
        <ProformaInvoiceView
          salesOrder={quickViewSO.order}
          items={quickViewSO.items}
          onClose={() => setQuickViewSO(null)}
        />
      )}

      {quickViewDC && (
        <DeliveryChallanView
          challan={quickViewDC.challan}
          items={quickViewDC.items}
          onClose={() => setQuickViewDC(null)}
          companyProfile={companySettings}
        />
      )}

      {quickViewInvoice && (
        <InvoiceView
          invoice={quickViewInvoice.invoice}
          items={quickViewInvoice.items}
          onClose={() => setQuickViewInvoice(null)}
        />
      )}
    </Layout>
  );
}
