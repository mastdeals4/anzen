import * as XLSX from 'xlsx';
import { supabase } from '../lib/supabase';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ExportProgressCallback {
  (step: string, percent: number): void;
}

export interface ExportDateRangeOptions {
  mode: 'this_year' | 'specific_month' | 'custom' | 'current_screen';
  year: number;
  month?: number; // 1-12
  startDate: string; // YYYY-MM-DD
  endDate: string;   // YYYY-MM-DD
  label: string;
}

interface RawProductRow {
  product_id: string;
  product_name: string;
  product_code: string;
  product_unit: string;
  current_stock: number;
  reserved_stock?: number;
  available_stock?: number;
  sold_qty: number;
  gross_sales: number;
  product_cost: number | null;
  sales_expense: number;
  gross_profit: number | null;
  profit_after_sales_expense: number | null;
  avg_landed_cost: number | null;
  avg_selling_price: number;
  sales_expense_per_unit: number;
  net_selling_price_per_unit: number;
  profit_per_unit: number | null;
  profit_margin_pct: number | null;
  costed_lines: number;
  total_lines: number;
  has_unreported_cost: boolean;
}

interface RawBatchRow {
  batch_id: string;
  batch_number: string;
  current_stock: number;
  sold_qty: number;
  cost_per_unit: number | null;
  gross_sales: number;
  product_cost: number | null;
  sales_expense: number;
  gross_profit: number | null;
  profit_after_sales_expense: number | null;
  avg_selling_price: number;
  sales_expense_per_unit: number;
  net_selling_price_per_unit: number;
  profit_per_unit: number | null;
  profit_margin_pct: number | null;
  is_imported: boolean;
}

interface RawOrderRow {
  line_id: string;
  invoice_id: string;
  invoice_number: string;
  invoice_date: string;
  customer_id: string;
  customer_name: string;
  sales_order_id: string | null;
  so_number: string | null;
  dc_id: string | null;
  dc_number: string | null;
  quantity: number;
  selling_price: number;
  gross_sales: number;
  unit_cost: number | null;
  line_cost: number | null;
  line_sales_expense: number;
  net_selling_realization: number;
  gross_profit: number | null;
  profit: number | null;
  profit_margin_pct: number | null;
  expenses?: Array<{
    id: string;
    voucher_number: string;
    category: string;
    total_amount: number;
    description: string;
    expense_date: string;
  }>;
}

// ─── Concurrency Helper ──────────────────────────────────────────────────────

async function asyncPool<T, R>(poolLimit: number, array: T[], iteratorFn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const ret: Promise<R>[] = [];
  const executing: Promise<any>[] = [];
  for (let i = 0; i < array.length; i++) {
    const item = array[i];
    const p = Promise.resolve().then(() => iteratorFn(item, i));
    ret.push(p);

    if (poolLimit <= array.length) {
      const e: Promise<any> = p.then(() => executing.splice(executing.indexOf(e), 1));
      executing.push(e);
      if (executing.length >= poolLimit) {
        await Promise.race(executing);
      }
    }
  }
  return Promise.all(ret);
}

// ─── Main Export Engine ──────────────────────────────────────────────────────

export async function generateSalesProfitabilityExcel(
  options: ExportDateRangeOptions,
  onProgress?: ExportProgressCallback
): Promise<void> {
  const { startDate, endDate, label } = options;

  onProgress?.('Fetching sales profitability summary & canonical stock...', 10);

  // 1. Fetch Summary & Canonical Stock simultaneously
  const [{ data: summaryRes, error: summaryErr }, { data: stockData, error: stockErr }] = await Promise.all([
    supabase.rpc('get_sales_profitability_summary', {
      p_start_date: startDate,
      p_end_date: endDate,
    }),
    supabase
      .from('inventory_v1_stock_summary')
      .select('product_id, total_current_stock, reserved_stock, available_quantity'),
  ]);

  if (summaryErr) {
    throw new Error(`Failed to load profitability summary: ${summaryErr.message}`);
  }
  if (stockErr) {
    console.warn('Could not load inventory_v1_stock_summary for export:', stockErr);
  }

  const stockMap = new Map<string, { current: number; reserved: number; available: number }>();
  (stockData || []).forEach((row: any) => {
    stockMap.set(row.product_id, {
      current: Number(row.total_current_stock ?? 0),
      reserved: Number(row.reserved_stock ?? 0),
      available: Number(row.available_quantity ?? 0),
    });
  });

  const company = summaryRes?.company || {
    gross_sales: 0,
    product_cost: 0,
    sales_expenses: 0,
    unallocated_sales_expenses: 0,
    gross_profit: 0,
    profit_after_sales_expenses: 0,
    profit_margin_pct: 0,
    total_qty_sold: 0,
    order_count: 0,
    product_count: 0,
  };

  const rawProducts: RawProductRow[] = (summaryRes?.products || []).map((p: any) => {
    const canonical = stockMap.get(p.product_id);
    return {
      ...p,
      current_stock: canonical ? canonical.current : Number(p.current_stock || 0),
      reserved_stock: canonical ? canonical.reserved : 0,
      available_stock: canonical ? canonical.available : Number(p.current_stock || 0),
    };
  });

  onProgress?.(`Found ${rawProducts.length} products. Fetching batch breakdown...`, 25);

  // 2. Fetch Batches for each product concurrently (pool limit 6)
  interface ProductWithBatches {
    product: RawProductRow;
    batches: RawBatchRow[];
  }

  let batchesCompleted = 0;
  const productsWithBatches: ProductWithBatches[] = await asyncPool(
    6,
    rawProducts,
    async (prod, idx) => {
      try {
        const { data: bData, error: bErr } = await supabase.rpc('get_sales_profitability_product_batches', {
          p_product_id: prod.product_id,
          p_start_date: startDate,
          p_end_date: endDate,
        });
        batchesCompleted++;
        const pct = 25 + Math.round((batchesCompleted / rawProducts.length) * 25);
        onProgress?.(`Fetching batches (${batchesCompleted}/${rawProducts.length})...`, pct);

        if (bErr) throw bErr;
        return {
          product: prod,
          batches: (bData?.batches || []) as RawBatchRow[],
        };
      } catch (err) {
        console.error(`Error loading batches for ${prod.product_code}:`, err);
        return {
          product: prod,
          batches: [],
        };
      }
    }
  );

  // 3. Collect all batches that need order & delivery challan lines
  interface BatchTask {
    product: RawProductRow;
    batch: RawBatchRow;
  }
  const batchTasks: BatchTask[] = [];
  productsWithBatches.forEach(pb => {
    pb.batches.forEach(b => {
      batchTasks.push({ product: pb.product, batch: b });
    });
  });

  onProgress?.(`Fetching orders and delivery challans for ${batchTasks.length} batches...`, 50);

  // 4. Fetch order details for each batch concurrently (pool limit 6)
  interface BatchWithOrders {
    product: RawProductRow;
    batch: RawBatchRow;
    orders: RawOrderRow[];
  }

  let ordersCompleted = 0;
  const batchesWithOrders: BatchWithOrders[] = await asyncPool(
    6,
    batchTasks,
    async (task) => {
      try {
        const { data: oData, error: oErr } = await supabase.rpc('get_sales_profitability_batch_orders', {
          p_batch_id: task.batch.batch_id,
          p_start_date: startDate,
          p_end_date: endDate,
        });
        ordersCompleted++;
        const pct = 50 + Math.round((ordersCompleted / (batchTasks.length || 1)) * 30);
        onProgress?.(`Fetching delivery & invoice details (${ordersCompleted}/${batchTasks.length})...`, pct);

        if (oErr) throw oErr;
        return {
          product: task.product,
          batch: task.batch,
          orders: (oData?.orders || []) as RawOrderRow[],
        };
      } catch (err) {
        console.error(`Error loading orders for batch ${task.batch.batch_number}:`, err);
        return {
          product: task.product,
          batch: task.batch,
          orders: [],
        };
      }
    }
  );

  // Organize by product_id -> batch_id -> orders
  const batchOrdersMap = new Map<string, RawOrderRow[]>();
  batchesWithOrders.forEach(bwo => {
    batchOrdersMap.set(bwo.batch.batch_id, bwo.orders);
  });

  onProgress?.('Assembling multi-sheet Excel workbook...', 85);

  // ───────────────────────────────────────────────────────────────────────────
  // BUILD WORKBOOK
  // ───────────────────────────────────────────────────────────────────────────
  const wb = XLSX.utils.book_new();

  // ═══════════════════════════════════════════════════════════════════════════
  // SHEET 1: Detailed Profitability Audit (Full Hierarchical Drill-Down)
  // ═══════════════════════════════════════════════════════════════════════════
  const sheet1Data: any[][] = [];

  // Header banner
  sheet1Data.push(['PT. SHUBHAM ARTHA MULIA / ANZEN ERP']);
  sheet1Data.push(['COMPREHENSIVE SALES PROFITABILITY AUDIT REPORT (FULL DRILL-DOWN)']);
  sheet1Data.push([`Period: ${label} (${startDate} to ${endDate})`]);
  sheet1Data.push([`Generated On: ${new Date().toLocaleString('en-GB')} | Currency: IDR (Rp)`]);
  sheet1Data.push([]); // blank

  // Executive Summary KPI block
  sheet1Data.push(['EXECUTIVE SUMMARY KPI']);
  sheet1Data.push(['Gross Sales (IDR)', 'Product Landed Cost (IDR)', 'Sales Delivery Expenses (IDR)', 'Gross Profit (IDR)', 'Net Realized Profit (IDR)', 'Profit Margin %', 'Total Qty Sold', 'Total Orders']);
  sheet1Data.push([
    company.gross_sales ?? 0,
    company.product_cost ?? 0,
    company.sales_expenses ?? 0,
    company.gross_profit ?? 0,
    company.profit_after_sales_expenses ?? 0,
    company.profit_margin_pct != null ? `${Number(company.profit_margin_pct).toFixed(2)}%` : '—',
    company.total_qty_sold ?? 0,
    company.order_count ?? 0,
  ]);
  sheet1Data.push([]); // blank

  // Detailed Table Headers
  const tableHeaderRow = [
    'Hierarchy Level',
    'Product Code',
    'Product Name / Item Description',
    'Batch Number',
    'Batch Type',
    'Invoice Number',
    'Invoice Date',
    'Customer Name',
    'Sales Order #',
    'Delivery Challan #',
    'Unit',
    'Current Stock',
    'Reserved Stock',
    'Available Stock',
    'Qty Sold',
    'Avg Landed Cost / Unit',
    'Selling Price / Unit',
    'Sales Exp / Unit',
    'Net Realization / Unit',
    'Gross Sales (IDR)',
    'Total Landed Cost / COGS (IDR)',
    'Sales Delivery Exp (IDR)',
    'Gross Profit (IDR)',
    'Net Realized Profit (IDR)',
    'Profit Margin %',
    'COGS Method / Expense Vouchers',
  ];
  sheet1Data.push(tableHeaderRow);

  // Rows population
  let grandTotalSoldQty = 0;
  let grandTotalGrossSales = 0;
  let grandTotalCOGS = 0;
  let grandTotalSalesExp = 0;
  let grandTotalGrossProfit = 0;
  let grandTotalNetProfit = 0;

  for (const pb of productsWithBatches) {
    const prod = pb.product;

    // PRODUCT ROW
    sheet1Data.push([
      'PRODUCT',
      prod.product_code,
      prod.product_name,
      '', // Batch
      '', // Batch Type
      '', // Invoice
      '', // Date
      '', // Customer
      '', // SO
      '', // DC
      prod.product_unit || 'kg',
      prod.current_stock ?? 0,
      prod.reserved_stock ?? 0,
      prod.available_stock ?? 0,
      prod.sold_qty ?? 0,
      prod.avg_landed_cost != null ? prod.avg_landed_cost : 'Cost unavailable',
      prod.avg_selling_price ?? 0,
      prod.sales_expense_per_unit ?? 0,
      prod.net_selling_price_per_unit ?? 0,
      prod.gross_sales ?? 0,
      prod.product_cost != null ? prod.product_cost : 'Cost unavailable',
      prod.sales_expense ?? 0,
      prod.gross_profit != null ? prod.gross_profit : '—',
      prod.profit_after_sales_expense != null ? prod.profit_after_sales_expense : '—',
      prod.profit_margin_pct != null ? `${Number(prod.profit_margin_pct).toFixed(2)}%` : 'Cost unavailable',
      prod.has_unreported_cost ? 'Contains uncosted lines' : 'Fully costed',
    ]);

    grandTotalSoldQty += Number(prod.sold_qty || 0);
    grandTotalGrossSales += Number(prod.gross_sales || 0);
    if (prod.product_cost != null) grandTotalCOGS += Number(prod.product_cost);
    grandTotalSalesExp += Number(prod.sales_expense || 0);
    if (prod.gross_profit != null) grandTotalGrossProfit += Number(prod.gross_profit);
    if (prod.profit_after_sales_expense != null) grandTotalNetProfit += Number(prod.profit_after_sales_expense);

    // BATCH ROWS
    for (const batch of pb.batches) {
      sheet1Data.push([
        '  BATCH',
        prod.product_code,
        prod.product_name,
        batch.batch_number,
        batch.is_imported ? 'Import' : 'Local',
        '', // Invoice
        '', // Date
        '', // Customer
        '', // SO
        '', // DC
        prod.product_unit || 'kg',
        batch.current_stock ?? 0,
        '', // Batch reserved (canonical at product)
        '', // Batch available
        batch.sold_qty ?? 0,
        batch.cost_per_unit != null ? batch.cost_per_unit : 'Cost unavailable',
        batch.avg_selling_price ?? 0,
        batch.sales_expense_per_unit ?? 0,
        batch.net_selling_price_per_unit ?? 0,
        batch.gross_sales ?? 0,
        batch.product_cost != null ? batch.product_cost : 'Cost unavailable',
        batch.sales_expense ?? 0,
        batch.gross_profit != null ? batch.gross_profit : '—',
        batch.profit_after_sales_expense != null ? batch.profit_after_sales_expense : '—',
        batch.profit_margin_pct != null ? `${Number(batch.profit_margin_pct).toFixed(2)}%` : 'Cost unavailable',
        '',
      ]);

      // ORDER / DC DRILL-DOWN ROWS
      const orders = batchOrdersMap.get(batch.batch_id) || [];
      for (const ord of orders) {
        const expenseDetails = (ord.expenses || [])
          .map(e => `${e.voucher_number || 'EXP'} (${e.category}): Rp ${Number(e.total_amount).toLocaleString('id-ID')}`)
          .join('; ');

        sheet1Data.push([
          '    ORDER LINE',
          prod.product_code,
          prod.product_name,
          batch.batch_number,
          batch.is_imported ? 'Import' : 'Local',
          ord.invoice_number,
          ord.invoice_date,
          ord.customer_name,
          ord.so_number || '—',
          ord.dc_number || '—',
          prod.product_unit || 'kg',
          '', // Current
          '', // Reserved
          '', // Available
          ord.quantity ?? 0,
          ord.unit_cost != null ? ord.unit_cost : 'Cost unavailable',
          ord.selling_price ?? 0,
          ord.quantity > 0 ? (ord.line_sales_expense || 0) / ord.quantity : 0,
          ord.quantity > 0 ? (ord.net_selling_realization || 0) / ord.quantity : 0,
          ord.gross_sales ?? 0,
          ord.line_cost != null ? ord.line_cost : 'Cost unavailable',
          ord.line_sales_expense ?? 0,
          ord.gross_profit != null ? ord.gross_profit : '—',
          ord.profit != null ? ord.profit : '—',
          ord.profit_margin_pct != null ? `${Number(ord.profit_margin_pct).toFixed(2)}%` : 'Cost unavailable',
          expenseDetails || 'No delivery expense allocated',
        ]);
      }
    }
  }

  // Grand Total Summary Row
  sheet1Data.push([]); // blank
  sheet1Data.push([
    'GRAND TOTAL',
    '',
    `Total Products: ${productsWithBatches.length}`,
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    grandTotalSoldQty,
    '',
    '',
    '',
    '',
    grandTotalGrossSales,
    grandTotalCOGS,
    grandTotalSalesExp,
    grandTotalGrossProfit,
    grandTotalNetProfit,
    grandTotalGrossSales > 0 ? `${((grandTotalNetProfit / grandTotalGrossSales) * 100).toFixed(2)}%` : '0%',
    `Unallocated expenses: Rp ${Number(company.unallocated_sales_expenses || 0).toLocaleString('id-ID')}`,
  ]);

  const wsDetailed = XLSX.utils.aoa_to_sheet(sheet1Data);

  // Column width definitions
  wsDetailed['!cols'] = [
    { wch: 16 }, // Level
    { wch: 14 }, // Code
    { wch: 34 }, // Name
    { wch: 18 }, // Batch
    { wch: 12 }, // Type
    { wch: 16 }, // Invoice
    { wch: 13 }, // Date
    { wch: 30 }, // Customer
    { wch: 16 }, // SO #
    { wch: 16 }, // DC #
    { wch: 8 },  // Unit
    { wch: 14 }, // Current Stock
    { wch: 14 }, // Reserved
    { wch: 14 }, // Available
    { wch: 12 }, // Sold Qty
    { wch: 20 }, // Avg Landed Cost
    { wch: 18 }, // Selling Price
    { wch: 16 }, // Sales Exp / Unit
    { wch: 20 }, // Net Realization / Unit
    { wch: 20 }, // Gross Sales
    { wch: 22 }, // Total Landed Cost
    { wch: 18 }, // Sales Exp
    { wch: 18 }, // Gross Profit
    { wch: 20 }, // Net Profit
    { wch: 15 }, // Margin %
    { wch: 40 }, // Details
  ];

  XLSX.utils.book_append_sheet(wb, wsDetailed, 'Detailed Profitability Audit');

  // ═══════════════════════════════════════════════════════════════════════════
  // SHEET 2: Product Summary
  // ═══════════════════════════════════════════════════════════════════════════
  const sheet2Data: any[][] = [];
  sheet2Data.push(['PRODUCT SUMMARY PROFITABILITY REPORT']);
  sheet2Data.push([`Period: ${label} (${startDate} to ${endDate})`]);
  sheet2Data.push([]);
  sheet2Data.push([
    'Product Code',
    'Product Name',
    'Unit',
    'Current Stock',
    'Reserved Stock',
    'Available Stock',
    'Sold Qty',
    'Avg Landed Cost (IDR)',
    'Avg Selling Price (IDR)',
    'Sales Exp / Unit (IDR)',
    'Net Realization / Unit (IDR)',
    'Gross Sales (IDR)',
    'Product Landed Cost (IDR)',
    'Sales Expenses (IDR)',
    'Gross Profit (IDR)',
    'Net Realized Profit (IDR)',
    'Profit Margin %',
    'Cost Status',
  ]);

  for (const pb of productsWithBatches) {
    const p = pb.product;
    sheet2Data.push([
      p.product_code,
      p.product_name,
      p.product_unit || 'kg',
      p.current_stock ?? 0,
      p.reserved_stock ?? 0,
      p.available_stock ?? 0,
      p.sold_qty ?? 0,
      p.avg_landed_cost != null ? p.avg_landed_cost : 'Cost unavailable',
      p.avg_selling_price ?? 0,
      p.sales_expense_per_unit ?? 0,
      p.net_selling_price_per_unit ?? 0,
      p.gross_sales ?? 0,
      p.product_cost != null ? p.product_cost : 'Cost unavailable',
      p.sales_expense ?? 0,
      p.gross_profit != null ? p.gross_profit : '—',
      p.profit_after_sales_expense != null ? p.profit_after_sales_expense : '—',
      p.profit_margin_pct != null ? `${Number(p.profit_margin_pct).toFixed(2)}%` : 'Cost unavailable',
      p.has_unreported_cost ? 'Uncosted lines present' : 'Fully costed',
    ]);
  }

  // Summary Row
  sheet2Data.push([]);
  sheet2Data.push([
    'TOTAL',
    `Total Products: ${productsWithBatches.length}`,
    '',
    '',
    '',
    '',
    grandTotalSoldQty,
    '',
    '',
    '',
    '',
    grandTotalGrossSales,
    grandTotalCOGS,
    grandTotalSalesExp,
    grandTotalGrossProfit,
    grandTotalNetProfit,
    grandTotalGrossSales > 0 ? `${((grandTotalNetProfit / grandTotalGrossSales) * 100).toFixed(2)}%` : '0%',
    '',
  ]);

  const wsProd = XLSX.utils.aoa_to_sheet(sheet2Data);
  wsProd['!cols'] = [
    { wch: 14 },
    { wch: 34 },
    { wch: 8 },
    { wch: 14 },
    { wch: 14 },
    { wch: 14 },
    { wch: 12 },
    { wch: 20 },
    { wch: 20 },
    { wch: 18 },
    { wch: 22 },
    { wch: 20 },
    { wch: 22 },
    { wch: 18 },
    { wch: 18 },
    { wch: 20 },
    { wch: 15 },
    { wch: 20 },
  ];
  XLSX.utils.book_append_sheet(wb, wsProd, 'Product Summary');

  // ═══════════════════════════════════════════════════════════════════════════
  // SHEET 3: Batch Summary
  // ═══════════════════════════════════════════════════════════════════════════
  const sheet3Data: any[][] = [];
  sheet3Data.push(['BATCH LEVEL PROFITABILITY REPORT']);
  sheet3Data.push([`Period: ${label} (${startDate} to ${endDate})`]);
  sheet3Data.push([]);
  sheet3Data.push([
    'Product Code',
    'Product Name',
    'Batch Number',
    'Batch Type',
    'Current Stock',
    'Sold Qty',
    'Unit Landed Cost (IDR)',
    'Avg Selling Price (IDR)',
    'Sales Exp / Unit (IDR)',
    'Net Realization / Unit (IDR)',
    'Gross Sales (IDR)',
    'Batch Landed Cost / COGS (IDR)',
    'Sales Expenses (IDR)',
    'Gross Profit (IDR)',
    'Net Realized Profit (IDR)',
    'Profit Margin %',
  ]);

  for (const pb of productsWithBatches) {
    for (const b of pb.batches) {
      sheet3Data.push([
        pb.product.product_code,
        pb.product.product_name,
        b.batch_number,
        b.is_imported ? 'Import' : 'Local',
        b.current_stock ?? 0,
        b.sold_qty ?? 0,
        b.cost_per_unit != null ? b.cost_per_unit : 'Cost unavailable',
        b.avg_selling_price ?? 0,
        b.sales_expense_per_unit ?? 0,
        b.net_selling_price_per_unit ?? 0,
        b.gross_sales ?? 0,
        b.product_cost != null ? b.product_cost : 'Cost unavailable',
        b.sales_expense ?? 0,
        b.gross_profit != null ? b.gross_profit : '—',
        b.profit_after_sales_expense != null ? b.profit_after_sales_expense : '—',
        b.profit_margin_pct != null ? `${Number(b.profit_margin_pct).toFixed(2)}%` : 'Cost unavailable',
      ]);
    }
  }

  const wsBatch = XLSX.utils.aoa_to_sheet(sheet3Data);
  wsBatch['!cols'] = [
    { wch: 14 },
    { wch: 34 },
    { wch: 18 },
    { wch: 12 },
    { wch: 14 },
    { wch: 12 },
    { wch: 20 },
    { wch: 20 },
    { wch: 18 },
    { wch: 22 },
    { wch: 20 },
    { wch: 24 },
    { wch: 18 },
    { wch: 18 },
    { wch: 20 },
    { wch: 15 },
  ];
  XLSX.utils.book_append_sheet(wb, wsBatch, 'Batch Summary');

  // ═══════════════════════════════════════════════════════════════════════════
  // SHEET 4: Orders & Delivery Challans (Flat Register)
  // ═══════════════════════════════════════════════════════════════════════════
  const sheet4Data: any[][] = [];
  sheet4Data.push(['SALES ORDERS & DELIVERY CHALLANS TRANSACTION REGISTER']);
  sheet4Data.push([`Period: ${label} (${startDate} to ${endDate})`]);
  sheet4Data.push([]);
  sheet4Data.push([
    'Invoice Number',
    'Invoice Date',
    'Customer Name',
    'Sales Order #',
    'Delivery Challan #',
    'Product Code',
    'Product Name',
    'Batch Number',
    'Qty',
    'Selling Price / Unit (IDR)',
    'Gross Sales (IDR)',
    'Unit Landed Cost (IDR)',
    'Total Landed Cost / COGS (IDR)',
    'Delivery & Sales Exp (IDR)',
    'Net Realization (IDR)',
    'Gross Profit (IDR)',
    'Net Profit (IDR)',
    'Profit Margin %',
    'Delivery Expense Vouchers & Notes',
  ]);

  for (const bwo of batchesWithOrders) {
    for (const ord of bwo.orders) {
      const expenseDetails = (ord.expenses || [])
        .map(e => `${e.voucher_number || 'EXP'} (${e.category}): Rp ${Number(e.total_amount).toLocaleString('id-ID')}`)
        .join('; ');

      sheet4Data.push([
        ord.invoice_number,
        ord.invoice_date,
        ord.customer_name,
        ord.so_number || '—',
        ord.dc_number || '—',
        bwo.product.product_code,
        bwo.product.product_name,
        bwo.batch.batch_number,
        ord.quantity ?? 0,
        ord.selling_price ?? 0,
        ord.gross_sales ?? 0,
        ord.unit_cost != null ? ord.unit_cost : 'Cost unavailable',
        ord.line_cost != null ? ord.line_cost : 'Cost unavailable',
        ord.line_sales_expense ?? 0,
        ord.net_selling_realization ?? 0,
        ord.gross_profit != null ? ord.gross_profit : '—',
        ord.profit != null ? ord.profit : '—',
        ord.profit_margin_pct != null ? `${Number(ord.profit_margin_pct).toFixed(2)}%` : 'Cost unavailable',
        expenseDetails || 'None',
      ]);
    }
  }

  const wsOrders = XLSX.utils.aoa_to_sheet(sheet4Data);
  wsOrders['!cols'] = [
    { wch: 16 },
    { wch: 13 },
    { wch: 30 },
    { wch: 16 },
    { wch: 16 },
    { wch: 14 },
    { wch: 32 },
    { wch: 18 },
    { wch: 10 },
    { wch: 18 },
    { wch: 20 },
    { wch: 20 },
    { wch: 22 },
    { wch: 20 },
    { wch: 20 },
    { wch: 18 },
    { wch: 20 },
    { wch: 15 },
    { wch: 45 },
  ];
  XLSX.utils.book_append_sheet(wb, wsOrders, 'Orders & Delivery Challans');

  onProgress?.('Finalizing and downloading Excel file...', 98);

  // Generate filename
  const cleanLabel = label.replace(/[^a-zA-Z0-9_-]/g, '_');
  const filename = `Sales_Profitability_Report_${cleanLabel}_${startDate}_to_${endDate}.xlsx`;

  XLSX.writeFile(wb, filename);

  onProgress?.('Export completed successfully!', 100);
}
