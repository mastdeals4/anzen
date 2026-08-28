import { supabase } from '../lib/supabase';
import { getWarehouseDeliveryPriority } from './deliveryPriority';
export { getWarehouseDeliveryPriority } from './deliveryPriority';

export type DeliveryAlertLevel = 'due_soon' | 'overdue';

export interface SalesOrderDeliveryAlert {
  soId: string;
  soNumber: string;
  customerName: string;
  expectedDeliveryDate: string;
  level: DeliveryAlertLevel;
  daysUntilDue: number;
}

export type WarehouseDeliveryPriority = import('./deliveryPriority').DeliveryQueuePriority;

export interface WarehouseDeliveryOrder {
  soId: string;
  soNumber: string;
  customerName: string;
  expectedDeliveryDate: string;
  priority: WarehouseDeliveryPriority;
  status: 'pending' | 'partial';
  hasApprovedDc: boolean;
  deliveryChallanNumbers: string[];
  items: Array<{
    productId: string;
    productName: string;
    unit: string;
    orderedQuantity: number;
    deliveredQuantity: number;
    remainingQuantity: number;
    itemDeliveryDate: string | null;
  }>;
}

interface SalesOrderRow {
  id: string;
  so_number: string;
  expected_delivery_date: string | null;
  status: string;
  is_archived: boolean | null;
  customers?: { company_name?: string | null } | null;
}

interface DeliveryChallanRow {
  id?: string;
  sales_order_id: string | null;
}

interface SalesInvoiceRow {
  id: string;
  sales_order_id: string | null;
}

interface SalesInvoiceItemRow {
  invoice_id: string;
  delivery_challan_item_id: string | null;
}

interface DeliveryChallanItemRow {
  id: string;
  challan_id: string;
}

interface WarehouseOrderItemRow {
  product_id: string;
  quantity: number;
  delivered_quantity: number | null;
  item_delivery_date: string | null;
  products?: { product_name?: string | null; unit?: string | null } | null;
}

export function getDeliveryAlertForOrder(
  order: Pick<SalesOrderRow, 'id' | 'so_number' | 'expected_delivery_date' | 'status'> & {
    customers?: { company_name?: string | null } | null;
  },
  hasApprovedDc: boolean,
  today = new Date()
): SalesOrderDeliveryAlert | null {
  if (hasApprovedDc || !order.expected_delivery_date) return null;
  if (['closed', 'cancelled', 'rejected'].includes(order.status)) return null;

  const startOfToday = new Date(today);
  startOfToday.setHours(0, 0, 0, 0);

  const dueDate = new Date(`${order.expected_delivery_date}T00:00:00`);
  const daysUntilDue = Math.ceil((dueDate.getTime() - startOfToday.getTime()) / 86400000);

  if (daysUntilDue < 0) {
    return {
      soId: order.id,
      soNumber: order.so_number,
      customerName: order.customers?.company_name || 'Customer',
      expectedDeliveryDate: order.expected_delivery_date,
      level: 'overdue',
      daysUntilDue,
    };
  }

  if (daysUntilDue <= 3) {
    return {
      soId: order.id,
      soNumber: order.so_number,
      customerName: order.customers?.company_name || 'Customer',
      expectedDeliveryDate: order.expected_delivery_date,
      level: 'due_soon',
      daysUntilDue,
    };
  }

  return null;
}

export async function fetchApprovedDeliverySalesOrderIds(orderIds: string[]): Promise<Set<string>> {
  if (orderIds.length === 0) return new Set();

  const { data: approvedDcs, error: dcError } = await supabase
    .from('delivery_challans')
    .select('id, sales_order_id')
    .or(`sales_order_id.in.(${orderIds.join(',')}),sales_order_id.is.null`)
    .eq('approval_status', 'approved');

  if (dcError) throw dcError;

  const deliveredSoIds = new Set((approvedDcs || [])
    .map((dc: DeliveryChallanRow) => dc.sales_order_id)
    .filter(Boolean) as string[]);

  const approvedDcIds = (approvedDcs || [])
    .map((dc: DeliveryChallanRow) => dc.id)
    .filter(Boolean) as string[];

  if (approvedDcIds.length === 0) return deliveredSoIds;

  const { data: invoices, error: invoicesError } = await supabase
    .from('sales_invoices')
    .select('id, sales_order_id')
    .in('sales_order_id', orderIds);

  if (invoicesError) throw invoicesError;

  const invoiceToSo = new Map((invoices || [])
    .filter((invoice: SalesInvoiceRow) => Boolean(invoice.sales_order_id))
    .map((invoice: SalesInvoiceRow) => [invoice.id, invoice.sales_order_id!]));

  if (invoiceToSo.size === 0) return deliveredSoIds;

  const { data: invoiceItems, error: invoiceItemsError } = await supabase
    .from('sales_invoice_items')
    .select('invoice_id, delivery_challan_item_id')
    .in('invoice_id', Array.from(invoiceToSo.keys()))
    .not('delivery_challan_item_id', 'is', null);

  if (invoiceItemsError) throw invoiceItemsError;

  const dcItemIds = Array.from(new Set((invoiceItems || [])
    .map((item: SalesInvoiceItemRow) => item.delivery_challan_item_id)
    .filter(Boolean) as string[]));

  if (dcItemIds.length === 0) return deliveredSoIds;

  const { data: dcItems, error: dcItemsError } = await supabase
    .from('delivery_challan_items')
    .select('id, challan_id')
    .in('id', dcItemIds)
    .in('challan_id', approvedDcIds);

  if (dcItemsError) throw dcItemsError;

  const approvedDcItemIds = new Set((dcItems || []).map((item: DeliveryChallanItemRow) => item.id));
  (invoiceItems || []).forEach((item: SalesInvoiceItemRow) => {
    if (!item.delivery_challan_item_id || !approvedDcItemIds.has(item.delivery_challan_item_id)) return;
    const soId = invoiceToSo.get(item.invoice_id);
    if (soId) deliveredSoIds.add(soId);
  });

  return deliveredSoIds;
}

export async function fetchSalesOrderDeliveryAlerts(): Promise<SalesOrderDeliveryAlert[]> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dueSoonCutoff = new Date(today);
  dueSoonCutoff.setDate(dueSoonCutoff.getDate() + 3);

  const { data: orders, error: ordersError } = await supabase
    .from('sales_orders')
    .select('id, so_number, expected_delivery_date, status, is_archived, customers(company_name)')
    .eq('is_archived', false)
    .not('expected_delivery_date', 'is', null)
    .lte('expected_delivery_date', dueSoonCutoff.toISOString().split('T')[0])
    .not('status', 'in', '("closed","cancelled","rejected")');

  if (ordersError) throw ordersError;
  if (!orders || orders.length === 0) return [];

  const orderIds = orders.map((order) => order.id);
  const deliveredSoIds = await fetchApprovedDeliverySalesOrderIds(orderIds);

  return (orders as SalesOrderRow[])
    .map((order) => getDeliveryAlertForOrder(order, deliveredSoIds.has(order.id), today))
    .filter((alert): alert is SalesOrderDeliveryAlert => Boolean(alert));
}

/**
 * Operational delivery queue for Warehouse.  This intentionally lives beside
 * the sales delivery-alert logic so both consumers use the same exclusions,
 * approved-DC lookup, and delivery-date semantics.
 */
export async function fetchWarehouseDeliveryQueue(today = new Date()): Promise<WarehouseDeliveryOrder[]> {
  const startOfToday = new Date(today);
  startOfToday.setHours(0, 0, 0, 0);
  const nextSevenDays = new Date(startOfToday);
  nextSevenDays.setDate(nextSevenDays.getDate() + 7);

  const { data: orders, error } = await supabase
    .from('sales_orders')
    .select(`
      id, so_number, expected_delivery_date, status, is_archived, customers(company_name),
      sales_order_items(product_id, quantity, delivered_quantity, item_delivery_date, products(product_name, unit))
    `)
    .eq('is_archived', false)
    .not('expected_delivery_date', 'is', null)
    .lte('expected_delivery_date', nextSevenDays.toISOString().split('T')[0])
    .not('status', 'in', '("closed","cancelled","rejected")')
    .order('expected_delivery_date', { ascending: true });

  if (error) throw error;
  if (!orders?.length) return [];

  const orderIds = orders.map((order) => order.id);
  const approvedSoIds = await fetchApprovedDeliverySalesOrderIds(orderIds);
  const { data: approvedDcs, error: dcError } = await supabase
    .from('delivery_challans')
    .select('sales_order_id, challan_number')
    .in('sales_order_id', orderIds)
    .eq('approval_status', 'approved');
  if (dcError) throw dcError;

  const challansByOrder = new Map<string, string[]>();
  (approvedDcs || []).forEach((dc: { sales_order_id: string | null; challan_number: string | null }) => {
    if (!dc.sales_order_id) return;
    challansByOrder.set(dc.sales_order_id, [...(challansByOrder.get(dc.sales_order_id) || []), dc.challan_number || 'Approved DC']);
  });

  return (orders as Array<SalesOrderRow & { sales_order_items?: WarehouseOrderItemRow[] }>)
    .map((order) => {
      const items = (order.sales_order_items || []).map((item) => {
        const orderedQuantity = Number(item.quantity) || 0;
        const deliveredQuantity = Number(item.delivered_quantity) || 0;
        return {
          productId: item.product_id,
          productName: item.products?.product_name || 'Product',
          unit: item.products?.unit || '',
          orderedQuantity,
          deliveredQuantity,
          remainingQuantity: Math.max(0, orderedQuantity - deliveredQuantity),
          itemDeliveryDate: item.item_delivery_date,
        };
      });
      const hasRemaining = items.some((item) => item.remainingQuantity > 0);
      if (!hasRemaining || !order.expected_delivery_date) return null;

      const priority = getWarehouseDeliveryPriority(order.expected_delivery_date, startOfToday);

      return {
        soId: order.id,
        soNumber: order.so_number,
        customerName: order.customers?.company_name || 'Customer',
        expectedDeliveryDate: order.expected_delivery_date,
        priority,
        status: items.some((item) => item.deliveredQuantity > 0) ? 'partial' : 'pending',
        hasApprovedDc: approvedSoIds.has(order.id),
        deliveryChallanNumbers: challansByOrder.get(order.id) || [],
        items,
      };
    })
    .filter((order): order is WarehouseDeliveryOrder => Boolean(order));
}

export function summarizeDeliveryAlerts(alerts: SalesOrderDeliveryAlert[]) {
  return {
    dueSoon: alerts.filter((alert) => alert.level === 'due_soon'),
    overdue: alerts.filter((alert) => alert.level === 'overdue'),
  };
}
