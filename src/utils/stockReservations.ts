import { supabase } from '../lib/supabase';

export interface CanonicalReservationItem {
  id: string;
  source: 'product_level' | 'legacy_batch';
  productId: string;
  salesOrderId: string;
  salesOrderItemId?: string;
  soNumber: string | null;
  customerName: string | null;
  soDate: string | null;
  soStatus: string | null;
  batchId: string | null;
  batchNumber: string | null;
  reservedQuantity: number;
  orderedQuantity: number | null;
  deliveredQuantity: number | null;
  shortageQuantity: number;
  status: 'active' | 'released' | 'consumed';
  isReleased: boolean;
  isMigrated: boolean;
  createdAt: string;
  closedAt: string | null;
  closeReason: string | null;
}

export interface ProductStockAuditSummary {
  productId: string;
  totalPhysicalStock: number;
  usablePhysicalStock: number;
  productReservedStock: number;
  legacyReservedStock: number;
  totalReservedStock: number;
  batchAllocatedStock: number;
  availableToPromise: number;
  unfulfilledDemand: number;
  activeReservationCount: number;
  reservations: CanonicalReservationItem[];
  batchSummaries?: Record<string, BatchStockAuditSummary>;
}

export interface BatchStockAuditSummary {
  batchId: string;
  batchNumber: string;
  productId: string;
  batchPhysicalStock: number;
  batchAllocatedStock: number;
  productReservedStock: number;
  productAvailableToPromise: number;
  effectiveFreeStock: number;
  unfulfilledDemand: number;
  isProductLevelCommitment: boolean;
  isExpired: boolean;
}

export interface CalculateStockMetricsInput {
  batches: Array<{
    id: string;
    product_id?: string;
    batch_number?: string;
    current_stock: number;
    reserved_stock?: number;
    expiry_date?: string | null;
    is_active?: boolean;
  }>;
  productReservations: Array<
    | CanonicalReservationItem
    | {
        id: string;
        product_id?: string;
        sales_order_id?: string;
        sales_order_item_id?: string;
        so_number?: string | null;
        customer_name?: string | null;
        so_date?: string | null;
        so_status?: string | null;
        reserved_quantity?: number;
        reservedQuantity?: number;
        ordered_quantity?: number | null;
        orderedQuantity?: number | null;
        delivered_quantity?: number | null;
        deliveredQuantity?: number | null;
        shortage_quantity?: number;
        shortageQuantity?: number;
        status: string;
        legacy_reservation_ids?: string[] | null;
        legacyReservationIds?: string[] | null;
        created_at?: string;
        closed_at?: string | null;
        close_reason?: string | null;
      }
  >;
  legacyReservations?: Array<
    | CanonicalReservationItem
    | {
        id: string;
        product_id?: string;
        batch_id?: string | null;
        batchId?: string | null;
        batch_number?: string | null;
        batchNumber?: string | null;
        sales_order_id?: string;
        salesOrderId?: string;
        sales_order_item_id?: string;
        salesOrderItemId?: string;
        so_number?: string | null;
        soNumber?: string | null;
        customer_name?: string | null;
        customerName?: string | null;
        reserved_quantity?: number;
        reservedQuantity?: number;
        status: string;
        is_released?: boolean;
        isReleased?: boolean;
        created_at?: string;
        released_at?: string | null;
        release_reason?: string | null;
      }
  >;
  importRequirements?: Array<{
    product_id?: string;
    shortage_quantity: number;
    status: string;
  }>;
  excludeSalesOrderItemId?: string | null;
  asOfDate?: string;
}

export interface StockMetricsResult {
  totalPhysicalStock: number;
  usablePhysicalStock: number;
  productReservedStock: number;
  legacyReservedStock: number;
  totalReservedStock: number;
  availableToPromise: number;
  unfulfilledDemand: number;
  activeProductReservationCount: number;
  activeLegacyReservationCount: number;
  batchSummaries: Record<string, BatchStockAuditSummary>;
}

/**
 * Pure, deterministic calculation of stock, reservations, ATP, and shortages.
 * Conforms 100% to PostgreSQL function:
 *   public.product_available_to_promise(p_product_id, p_exclude_sales_order_item_id)
 * and view:
 *   public.inventory_v1_stock_summary
 */
export function calculateStockMetrics(input: CalculateStockMetricsInput): StockMetricsResult {
  const asOf = input.asOfDate || new Date().toISOString().split('T')[0];

  const getReserved = (r: any) => Number(r.reservedQuantity ?? r.reserved_quantity ?? 0);
  const getOrdered = (r: any) => r.orderedQuantity != null ? Number(r.orderedQuantity) : (r.ordered_quantity != null ? Number(r.ordered_quantity) : null);
  const getDelivered = (r: any) => Number(r.deliveredQuantity ?? r.delivered_quantity ?? 0);
  const getShortage = (r: any) => r.shortageQuantity != null ? Number(r.shortageQuantity) : (r.shortage_quantity != null ? Number(r.shortage_quantity) : null);
  const getSoItemId = (r: any) => r.salesOrderItemId ?? r.sales_order_item_id;
  const getIsReleased = (r: any) => Boolean(r.isReleased ?? r.is_released);
  const getLegacyIds = (r: any) => r.legacyReservationIds ?? r.legacy_reservation_ids;

  // 1. Gather all migrated legacy IDs to prevent double counting
  const migratedLegacyIds = new Set<string>();
  (input.productReservations || []).forEach(r => {
    const ids = getLegacyIds(r);
    if (Array.isArray(ids)) {
      ids.forEach(id => migratedLegacyIds.add(id));
    }
  });

  // 2. Active Batches & Usable Physical Stock
  const activeBatches = (input.batches || []).filter(b => b.is_active !== false);
  const totalPhysicalStock = activeBatches.reduce((sum, b) => sum + (Number(b.current_stock) || 0), 0);
  const usablePhysicalStock = activeBatches
    .filter(b => !b.expiry_date || b.expiry_date > asOf)
    .reduce((sum, b) => sum + (Number(b.current_stock) || 0), 0);

  // 3. Active Product-Level Reservations (excluding current order item if requested)
  const activeProductReservations = (input.productReservations || []).filter(r => {
    if (r.status !== 'active') return false;
    const soItemId = getSoItemId(r);
    if (input.excludeSalesOrderItemId && soItemId === input.excludeSalesOrderItemId) {
      return false;
    }
    return getReserved(r) > 0;
  });

  const productReservedStock = activeProductReservations.reduce(
    (sum, r) => sum + getReserved(r),
    0
  );

  // 4. Active Legacy Batch Reservations (excluding already migrated rows and excluded SO item)
  const activeLegacyReservations = (input.legacyReservations || []).filter(sr => {
    if (sr.status !== 'active' || getIsReleased(sr)) return false;
    if (migratedLegacyIds.has(sr.id)) return false;
    const soItemId = getSoItemId(sr);
    if (input.excludeSalesOrderItemId && soItemId === input.excludeSalesOrderItemId) {
      return false;
    }
    return getReserved(sr) > 0;
  });

  const legacyReservedStock = activeLegacyReservations.reduce(
    (sum, sr) => sum + getReserved(sr),
    0
  );

  const totalReservedStock = productReservedStock + legacyReservedStock;
  const availableToPromise = Math.max(0, usablePhysicalStock - totalReservedStock);

  // 5. Shortages and Unfulfilled Demand
  const reservationShortage = activeProductReservations.reduce((sum, r) => {
    const explicitShortage = getShortage(r);
    if (explicitShortage != null) {
      return sum + explicitShortage;
    }
    const ordered = getOrdered(r) ?? 0;
    const delivered = getDelivered(r);
    const reserved = getReserved(r);
    return sum + (ordered > 0 ? Math.max(0, ordered - delivered - reserved) : 0);
  }, 0);

  const importShortage = (input.importRequirements || [])
    .filter(ir => ['pending', 'ordered'].includes(ir.status))
    .reduce((sum, ir) => sum + (Number(ir.shortage_quantity) || 0), 0);

  const unfulfilledDemand = Math.max(reservationShortage, importShortage);

  // 6. Per-batch breakdown
  const batchSummaries: Record<string, BatchStockAuditSummary> = {};
  activeBatches.forEach(b => {
    const batchPhysical = Number(b.current_stock) || 0;
    // Batch allocated is either b.reserved_stock or unmigrated legacy reservation for this batch
    const batchLegacyAllocated = activeLegacyReservations
      .filter(lr => (lr as any).batchId === b.id || (lr as any).batch_id === b.id)
      .reduce((sum, lr) => sum + getReserved(lr), 0);
    const batchAllocatedStock = Math.max(Number(b.reserved_stock) || 0, batchLegacyAllocated);

    const isExpired = Boolean(b.expiry_date && b.expiry_date <= asOf);
    // Effective free stock: batch physical stock minus batch-locked allocations,
    // strictly capped by the product-level available to promise!
    const effectiveFreeStock = isExpired
      ? 0
      : Math.max(0, Math.min(batchPhysical - batchAllocatedStock, availableToPromise));

    batchSummaries[b.id] = {
      batchId: b.id,
      batchNumber: b.batch_number || '',
      productId: b.product_id || '',
      batchPhysicalStock: batchPhysical,
      batchAllocatedStock,
      productReservedStock: totalReservedStock,
      productAvailableToPromise: availableToPromise,
      effectiveFreeStock,
      unfulfilledDemand,
      isProductLevelCommitment: batchAllocatedStock === 0 && totalReservedStock > 0,
      isExpired,
    };
  });

  return {
    totalPhysicalStock,
    usablePhysicalStock,
    productReservedStock,
    legacyReservedStock,
    totalReservedStock,
    availableToPromise,
    unfulfilledDemand,
    activeProductReservationCount: activeProductReservations.length,
    activeLegacyReservationCount: activeLegacyReservations.length,
    batchSummaries,
  };
}

/**
 * Fetch and reconcile product-level commitments and legacy batch reservations from Supabase.
 * Strictly adheres to canonical product_available_to_promise() logic.
 */
export async function fetchCanonicalStockReservations(
  productId: string,
  excludeSalesOrderItemId?: string
): Promise<{
  activeReservations: CanonicalReservationItem[];
  allReservations: CanonicalReservationItem[];
  totalReserved: number;
  unfulfilledDemand: number;
}> {
  // 1. Fetch so_product_reservations
  const { data: soProdResData, error: soProdErr } = await supabase
    .from('so_product_reservations')
    .select(`
      id, sales_order_id, sales_order_item_id, product_id, reserved_quantity, status, created_at, closed_at, close_reason, legacy_reservation_ids,
      sales_orders(id, so_number, status, so_date, customers(company_name)),
      sales_order_items(id, quantity, delivered_quantity)
    `)
    .eq('product_id', productId)
    .order('created_at', { ascending: false });

  if (soProdErr) {
    console.error('Error fetching so_product_reservations:', soProdErr);
  }

  // 2. Fetch legacy stock_reservations
  const { data: legacyResData, error: legacyErr } = await supabase
    .from('stock_reservations')
    .select(`
      id, batch_id, product_id, reserved_quantity, status, reserved_at, is_released, released_at, release_reason,
      batches(batch_number),
      sales_orders(id, so_number, status, so_date, customers(company_name))
    `)
    .eq('product_id', productId)
    .order('reserved_at', { ascending: false });

  if (legacyErr) {
    console.error('Error fetching legacy stock_reservations:', legacyErr);
  }

  // Collect all legacy reservation IDs that have been migrated to prevent double-counting
  const migratedLegacyIds = new Set<string>();
  (soProdResData || []).forEach((r: any) => {
    if (Array.isArray(r.legacy_reservation_ids)) {
      r.legacy_reservation_ids.forEach((id: string) => migratedLegacyIds.add(id));
    }
  });

  const canonicalItems: CanonicalReservationItem[] = [];

  // Map product-level reservations
  (soProdResData || []).forEach((r: any) => {
    const ordered = r.sales_order_items ? parseFloat(r.sales_order_items.quantity) || 0 : null;
    const delivered = r.sales_order_items ? parseFloat(r.sales_order_items.delivered_quantity) || 0 : 0;
    const reserved = parseFloat(r.reserved_quantity) || 0;
    // Shortage / unfulfilled demand exists if order demand exceeds (delivered + reserved)
    const shortage = ordered !== null && r.status === 'active'
      ? Math.max(0, ordered - delivered - reserved)
      : 0;

    canonicalItems.push({
      id: r.id,
      source: 'product_level',
      productId: r.product_id,
      salesOrderId: r.sales_order_id,
      salesOrderItemId: r.sales_order_item_id,
      soNumber: r.sales_orders?.so_number || null,
      customerName: r.sales_orders?.customers?.company_name || null,
      soDate: r.sales_orders?.so_date || null,
      soStatus: r.sales_orders?.status || null,
      batchId: null, // Product-level reservations are not batch-locked
      batchNumber: null,
      reservedQuantity: reserved,
      orderedQuantity: ordered,
      deliveredQuantity: delivered,
      shortageQuantity: shortage,
      status: r.status as 'active' | 'released' | 'consumed',
      isReleased: r.status === 'released',
      isMigrated: false,
      createdAt: r.created_at,
      closedAt: r.closed_at,
      closeReason: r.close_reason,
    });
  });

  // Map legacy reservations (preserve history, flag migrated ones)
  (legacyResData || []).forEach((sr: any) => {
    const isMigrated = migratedLegacyIds.has(sr.id);
    const reserved = parseFloat(sr.reserved_quantity) || 0;
    const isActive = sr.status === 'active' && !sr.is_released;

    canonicalItems.push({
      id: sr.id,
      source: 'legacy_batch',
      productId: sr.product_id || productId,
      salesOrderId: sr.sales_orders?.id || sr.sales_order_id,
      soNumber: sr.sales_orders?.so_number || null,
      customerName: sr.sales_orders?.customers?.company_name || null,
      soDate: sr.sales_orders?.so_date || null,
      soStatus: sr.sales_orders?.status || null,
      batchId: sr.batch_id || null,
      batchNumber: sr.batches?.batch_number || null,
      reservedQuantity: reserved,
      orderedQuantity: null,
      deliveredQuantity: null,
      shortageQuantity: 0,
      status: isActive && !isMigrated ? 'active' : 'released',
      isReleased: sr.is_released || sr.status === 'released' || isMigrated,
      isMigrated,
      createdAt: sr.reserved_at || sr.created_at,
      closedAt: sr.released_at,
      closeReason: isMigrated ? 'Migrated to product reservation' : sr.release_reason,
    });
  });

  // Active reservations:
  // 1. All active product-level reservations
  // 2. Plus active legacy batch reservations that have NOT been migrated to so_product_reservations
  // 3. Excluding excludeSalesOrderItemId if provided
  const activeReservations = canonicalItems.filter(item => {
    if (excludeSalesOrderItemId && item.salesOrderItemId === excludeSalesOrderItemId) {
      return false;
    }
    if (item.source === 'product_level') {
      return item.status === 'active' && item.reservedQuantity > 0;
    }
    // Legacy batch reservation: only count if active, not released, and not already migrated
    return item.status === 'active' && !item.isReleased && !item.isMigrated && item.reservedQuantity > 0;
  });

  const totalReserved = activeReservations.reduce((sum, r) => sum + r.reservedQuantity, 0);

  // Unfulfilled demand across active reservations
  const unfulfilledDemand = activeReservations.reduce((sum, r) => sum + r.shortageQuantity, 0);

  return {
    activeReservations,
    allReservations: canonicalItems,
    totalReserved,
    unfulfilledDemand,
  };
}

/**
 * Reconcile full stock availability for a product matching canonical ATP logic.
 */
export async function fetchProductStockAuditSummary(
  productId: string,
  excludeSalesOrderItemId?: string
): Promise<ProductStockAuditSummary> {
  const [batchesRes, reservationsRes, shortageRes] = await Promise.all([
    supabase
      .from('batches')
      .select('id, batch_number, current_stock, reserved_stock, expiry_date, is_active, product_id')
      .eq('product_id', productId)
      .eq('is_active', true),
    fetchCanonicalStockReservations(productId, excludeSalesOrderItemId),
    supabase
      .from('import_requirements')
      .select('shortage_quantity, status')
      .eq('product_id', productId)
      .in('status', ['pending', 'ordered']),
  ]);

  const batches = (batchesRes.data || []).map((b: any) => ({
    id: b.id,
    product_id: b.product_id,
    batch_number: b.batch_number,
    current_stock: Number(b.current_stock) || 0,
    reserved_stock: Number(b.reserved_stock) || 0,
    expiry_date: b.expiry_date,
    is_active: b.is_active,
  }));

  const metrics = calculateStockMetrics({
    batches,
    productReservations: reservationsRes.allReservations.filter(r => r.source === 'product_level'),
    legacyReservations: reservationsRes.allReservations.filter(r => r.source === 'legacy_batch'),
    importRequirements: shortageRes.data || [],
    excludeSalesOrderItemId,
  });

  return {
    productId,
    totalPhysicalStock: metrics.totalPhysicalStock,
    usablePhysicalStock: metrics.usablePhysicalStock,
    productReservedStock: metrics.productReservedStock,
    legacyReservedStock: metrics.legacyReservedStock,
    totalReservedStock: metrics.totalReservedStock,
    batchAllocatedStock: 0,
    availableToPromise: metrics.availableToPromise,
    unfulfilledDemand: metrics.unfulfilledDemand,
    activeReservationCount: reservationsRes.activeReservations.length,
    reservations: reservationsRes.allReservations,
    batchSummaries: metrics.batchSummaries,
  };
}
