/**
 * The printable invoice model is deliberately hydrated with explicit queries.
 *
 * PostgREST embedded relations are convenient for lists, but an invoice is a
 * legal document: its product and batch data must not disappear because an
 * embedded relation is unavailable or changes shape.  Keep the invoice-item
 * record authoritative, then attach the display-only records by their IDs.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export interface InvoiceDisplayItem {
  id: string;
  product_id: string;
  batch_id: string | null;
  quantity: number;
  unit_price: number;
  tax_rate: number;
  tax_amount?: number;
  line_total?: number;
  total?: number;
  delivery_challan_item_id: string | null;
  challan_id: string | null;
  dc_number?: string;
  products?: { product_name: string; product_code: string; unit: string };
  batches?: { batch_number: string; expiry_date: string | null } | null;
}

interface InvoiceItemRow {
  id: string;
  invoice_id: string;
  product_id: string;
  batch_id: string | null;
  quantity: number;
  unit_price: number;
  tax_rate: number;
  tax_amount: number | null;
  line_total: number | null;
  delivery_challan_item_id: string | null;
}

interface ProductRow {
  id: string;
  product_name: string;
  product_code: string;
  unit: string;
}

interface BatchRow {
  id: string;
  batch_number: string;
  expiry_date: string | null;
}

interface DcItemRow {
  id: string;
  challan_id: string;
}

interface ChallanRow {
  id: string;
  challan_number: string;
}

function rowsOf<T>(data: T[] | null | undefined): T[] {
  return data ?? [];
}

export async function loadInvoiceDisplayItems(
  client: SupabaseClient,
  invoiceId: string,
): Promise<InvoiceDisplayItem[]> {
  const { data: invoiceItemData, error: invoiceItemsError } = await client
    .from('sales_invoice_items')
    .select('id, invoice_id, product_id, batch_id, quantity, unit_price, tax_rate, tax_amount, line_total, delivery_challan_item_id')
    .eq('invoice_id', invoiceId);

  if (invoiceItemsError) throw invoiceItemsError;
  const invoiceItems = rowsOf(invoiceItemData as InvoiceItemRow[] | null);
  if (!invoiceItems.length) return [];

  const productIds = [...new Set(invoiceItems.map(item => item.product_id).filter(Boolean))];
  const batchIds = [...new Set(invoiceItems.map(item => item.batch_id).filter((id): id is string => Boolean(id)))];
  const dcItemIds = [...new Set(invoiceItems.map(item => item.delivery_challan_item_id).filter((id): id is string => Boolean(id)))];

  const emptyProducts: ProductRow[] = [];
  const emptyBatches: BatchRow[] = [];
  const emptyDcItems: DcItemRow[] = [];

  const [productsResult, batchesResult, dcItemsResult] = await Promise.all([
    productIds.length
      ? client.from('products').select('id, product_name, product_code, unit').in('id', productIds)
      : Promise.resolve({ data: emptyProducts, error: null }),
    batchIds.length
      ? client.from('batches').select('id, batch_number, expiry_date').in('id', batchIds)
      : Promise.resolve({ data: emptyBatches, error: null }),
    dcItemIds.length
      ? client.from('delivery_challan_items').select('id, challan_id').in('id', dcItemIds)
      : Promise.resolve({ data: emptyDcItems, error: null }),
  ]);

  if (productsResult.error) throw productsResult.error;
  if (batchesResult.error) throw batchesResult.error;
  if (dcItemsResult.error) throw dcItemsResult.error;

  const products = rowsOf(productsResult.data as ProductRow[] | null);
  const batches = rowsOf(batchesResult.data as BatchRow[] | null);
  const dcItems = rowsOf(dcItemsResult.data as DcItemRow[] | null);

  const challanIds = [...new Set(dcItems.map(item => item.challan_id).filter(Boolean))];
  const challansResult = challanIds.length
    ? await client.from('delivery_challans').select('id, challan_number').in('id', challanIds)
    : { data: [] as ChallanRow[], error: null };
  if (challansResult.error) throw challansResult.error;
  const challans = rowsOf(challansResult.data as ChallanRow[] | null);

  const productsById = new Map(products.map(product => [product.id, product]));
  const batchesById = new Map(batches.map(batch => [batch.id, batch]));
  const dcItemsById = new Map(dcItems.map(item => [item.id, item]));
  const challansById = new Map(challans.map(challan => [challan.id, challan]));

  return invoiceItems.map(item => {
    const dcItem = item.delivery_challan_item_id ? dcItemsById.get(item.delivery_challan_item_id) : undefined;
    const challan = dcItem ? challansById.get(dcItem.challan_id) : undefined;
    return {
      id: item.id,
      product_id: item.product_id,
      batch_id: item.batch_id,
      quantity: Number(item.quantity),
      unit_price: Number(item.unit_price),
      tax_rate: Number(item.tax_rate),
      tax_amount: item.tax_amount == null ? undefined : Number(item.tax_amount),
      line_total: item.line_total == null ? undefined : Number(item.line_total),
      delivery_challan_item_id: item.delivery_challan_item_id ?? null,
      challan_id: dcItem?.challan_id ?? null,
      dc_number: challan?.challan_number,
      products: productsById.get(item.product_id),
      batches: item.batch_id ? batchesById.get(item.batch_id) ?? null : null,
    };
  });
}
