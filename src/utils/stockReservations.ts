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
  batchAllocatedStock: number;
  availableToPromise: number;
  unfulfilledDemand: number;
  activeReservationCount: number;
  reservations: CanonicalReservationItem[];
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
}

/**
 * Fetch and reconcile product-level commitments and legacy batch reservations.
 * Strictly adheres to canonical product_available_to_promise() logic:
 *   usable_batches - active_so_product_reservations - active_unmigrated_stock_reservations
 */
export async function fetchCanonicalStockReservations(
  productId: string
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
  const activeReservations = canonicalItems.filter(item => {
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
  productId: string
): Promise<ProductStockAuditSummary> {
  const [batchesRes, reservationsRes, shortageRes] = await Promise.all([
    supabase
      .from('batches')
      .select('id, batch_number, current_stock, expiry_date, is_active')
      .eq('product_id', productId)
      .eq('is_active', true),
    fetchCanonicalStockReservations(productId),
    supabase
      .from('import_requirements')
      .select('shortage_quantity')
      .eq('product_id', productId)
      .in('status', ['pending', 'ordered']),
  ]);

  const batches = batchesRes.data || [];
  const now = new Date().toISOString().split('T')[0];

  const totalPhysicalStock = batches.reduce((sum, b) => sum + (parseFloat(b.current_stock) || 0), 0);
  const usablePhysicalStock = batches
    .filter(b => !b.expiry_date || b.expiry_date > now)
    .reduce((sum, b) => sum + (parseFloat(b.current_stock) || 0), 0);

  const productReservedStock = reservationsRes.totalReserved;
  const availableToPromise = Math.max(0, usablePhysicalStock - productReservedStock);

  // Unfulfilled demand: max of calculated reservation shortages or pending import requirements
  const importShortage = (shortageRes.data || []).reduce(
    (sum, ir) => sum + (parseFloat(ir.shortage_quantity) || 0),
    0
  );
  const unfulfilledDemand = Math.max(reservationsRes.unfulfilledDemand, importShortage);

  return {
    productId,
    totalPhysicalStock,
    usablePhysicalStock,
    productReservedStock,
    batchAllocatedStock: 0,
    availableToPromise,
    unfulfilledDemand,
    activeReservationCount: reservationsRes.activeReservations.length,
    reservations: reservationsRes.allReservations,
  };
}

