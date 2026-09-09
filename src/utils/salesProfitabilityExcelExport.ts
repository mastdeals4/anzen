import ExcelJS from 'exceljs';
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
  exportFormat?: 'consolidated' | 'detailed'; // default 'consolidated'
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

// ─── Styling Constants ────────────────────────────────────────────────────────

const BORDER_THIN: Partial<ExcelJS.Borders> = {
  top: { style: 'thin', color: { argb: 'FFE2E8F0' } },
  left: { style: 'thin', color: { argb: 'FFE2E8F0' } },
  bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } },
  right: { style: 'thin', color: { argb: 'FFE2E8F0' } },
};

const BORDER_HEADER: Partial<ExcelJS.Borders> = {
  top: { style: 'thin', color: { argb: 'FF0F172A' } },
  left: { style: 'thin', color: { argb: 'FF334155' } },
  bottom: { style: 'medium', color: { argb: 'FF0F172A' } },
  right: { style: 'thin', color: { argb: 'FF334155' } },
};

const BORDER_TOTAL: Partial<ExcelJS.Borders> = {
  top: { style: 'thin', color: { argb: 'FF94A3B8' } },
  left: { style: 'thin', color: { argb: 'FFE2E8F0' } },
  bottom: { style: 'double', color: { argb: 'FF0F172A' } },
  right: { style: 'thin', color: { argb: 'FFE2E8F0' } },
};

const FILL_HEADER: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FF0F2942' }, // Deep slate navy
};

const FILL_SUBHEADER: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FF1E3A8A' }, // Deep blue
};

const FILL_ZEBRA: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FFF8FAFC' }, // Subtle cool gray
};

const FILL_TOTAL: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FFF1F5F9' }, // Light gray
};

const FILL_ACCENT_GREEN: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FFECFDF5' }, // Soft green
};

const FONT_HEADER: Partial<ExcelJS.Font> = {
  name: 'Calibri',
  size: 10,
  bold: true,
  color: { argb: 'FFFFFFFF' },
};

const FONT_DATA: Partial<ExcelJS.Font> = {
  name: 'Calibri',
  size: 10,
  color: { argb: 'FF1E293B' },
};

const FONT_BOLD: Partial<ExcelJS.Font> = {
  name: 'Calibri',
  size: 10,
  bold: true,
  color: { argb: 'FF0F172A' },
};

// ─── Concurrency Pool Helper ─────────────────────────────────────────────────

async function asyncPool<T, R>(
  poolLimit: number,
  array: T[],
  iteratorFn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
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

// ─── Browser File Download Helper ────────────────────────────────────────────

function downloadWorkbookBuffer(buffer: ArrayBuffer | Uint8Array, filename: string) {
  const blob = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  window.URL.revokeObjectURL(url);
}

// ─── Helper to Style Header Banner ───────────────────────────────────────────

function createReportHeaderBanner(
  ws: ExcelJS.Worksheet,
  reportTitle: string,
  periodLabel: string,
  startDate: string,
  endDate: string
) {
  // Title row 1: Company
  const r1 = ws.addRow(['PT. SHUBHAM ARTHA MULIA / ANZEN ERP']);
  r1.font = { name: 'Calibri', size: 14, bold: true, color: { argb: 'FF0F2942' } };

  // Title row 2: Report
  const r2 = ws.addRow([reportTitle.toUpperCase()]);
  r2.font = { name: 'Calibri', size: 11, bold: true, color: { argb: 'FF334155' } };

  // Title row 3: Metadata
  const nowStr = new Date().toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  const r3 = ws.addRow([
    `Period: ${periodLabel} (${startDate} to ${endDate})   |   Generated: ${nowStr}   |   Currency: Indonesian Rupiah (IDR)`,
  ]);
  r3.font = { name: 'Calibri', size: 9, italic: true, color: { argb: 'FF64748B' } };

  ws.addRow([]); // Blank line
}

// ─── Helper to Build Executive KPI Block ─────────────────────────────────────

function createExecutiveKpiBlock(ws: ExcelJS.Worksheet, company: any) {
  const kpiTitleRow = ws.addRow(['EXECUTIVE KPI SUMMARY']);
  kpiTitleRow.font = { name: 'Calibri', size: 10, bold: true, color: { argb: 'FF475569' } };

  const headers = [
    'Gross Sales (IDR)',
    'Product Landed Cost (IDR)',
    'Sales Delivery Expenses (IDR)',
    'Gross Profit (IDR)',
    'Net Realized Profit (IDR)',
    'Profit Margin %',
    'Total Units Sold',
    'Total Invoices',
  ];

  const headerRow = ws.addRow(headers);
  headerRow.height = 22;
  headerRow.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } };
    cell.font = { name: 'Calibri', size: 9, bold: true, color: { argb: 'FF334155' } };
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
    cell.border = BORDER_THIN;
  });

  const grossSales = Number(company?.gross_sales || 0);
  const prodCost = Number(company?.product_cost || 0);
  const salesExp = Number(company?.sales_expenses || 0);
  const grossProfit = Number(company?.gross_profit || 0);
  const netProfit = Number(company?.profit_after_sales_expenses || 0);
  const marginPct = company?.profit_margin_pct != null ? Number(company.profit_margin_pct) / 100 : 0;
  const qtySold = Number(company?.total_qty_sold || 0);
  const orderCount = Number(company?.order_count || 0);

  const valuesRow = ws.addRow([
    grossSales,
    prodCost,
    salesExp,
    grossProfit,
    netProfit,
    marginPct,
    qtySold,
    orderCount,
  ]);
  valuesRow.height = 24;

  // Format KPI values
  valuesRow.getCell(1).numFmt = '#,##0.00';
  valuesRow.getCell(2).numFmt = '#,##0.00';
  valuesRow.getCell(3).numFmt = '#,##0.00';
  valuesRow.getCell(4).numFmt = '#,##0.00';
  valuesRow.getCell(5).numFmt = '#,##0.00';
  valuesRow.getCell(6).numFmt = '0.0%';
  valuesRow.getCell(7).numFmt = '#,##0.00';
  valuesRow.getCell(8).numFmt = '#,##0';

  valuesRow.eachCell((cell, colNumber) => {
    cell.font = { name: 'Calibri', size: 10, bold: true, color: { argb: 'FF0F172A' } };
    cell.alignment = { vertical: 'middle', horizontal: 'right' };
    cell.border = BORDER_THIN;

    // Highlight Net Realized Profit and Margin in green
    if (colNumber === 5 || colNumber === 6) {
      cell.fill = FILL_ACCENT_GREEN;
      cell.font = { name: 'Calibri', size: 10, bold: true, color: { argb: 'FF065F46' } };
    }
  });

  ws.addRow([]); // Blank line
}

// ─── Main Export Generator ───────────────────────────────────────────────────

export async function generateSalesProfitabilityExcel(
  options: ExportDateRangeOptions,
  onProgress?: ExportProgressCallback
): Promise<void> {
  const { startDate, endDate, label, exportFormat = 'consolidated' } = options;

  onProgress?.('Fetching company summary and product stock metrics...', 15);

  // 1. Fetch Profitability Summary & Canonical Stock
  const [{ data: summaryRes, error: summaryErr }, { data: stockData, error: stockErr }] =
    await Promise.all([
      supabase.rpc('get_sales_profitability_summary', {
        p_start_date: startDate,
        p_end_date: endDate,
      }),
      supabase
        .from('inventory_v1_stock_summary')
        .select('product_id, total_current_stock, reserved_stock, available_quantity'),
    ]);

  if (summaryErr) {
    throw new Error(`Failed to load sales profitability summary: ${summaryErr.message}`);
  }
  if (stockErr) {
    console.warn('Could not load inventory_v1_stock_summary:', stockErr);
  }

  const stockMap = new Map<string, { current: number; reserved: number; available: number }>();
  (stockData || []).forEach((row: any) => {
    stockMap.set(row.product_id, {
      current: Number(row.total_current_stock ?? 0),
      reserved: Number(row.reserved_stock ?? 0),
      available: Number(row.available_quantity ?? 0),
    });
  });

  const company = (summaryRes as any)?.company || {};
  let products = ((summaryRes as any)?.products || []) as RawProductRow[];

  // Merge canonical stock
  products = products.map((p) => {
    const canonical = stockMap.get(p.product_id);
    return {
      ...p,
      current_stock: canonical ? canonical.current : Number(p.current_stock || 0),
      reserved_stock: canonical ? canonical.reserved : 0,
      available_stock: canonical ? canonical.available : Number(p.current_stock || 0),
    };
  });

  // Create ExcelJS Workbook
  const wb = new ExcelJS.Workbook();
  wb.creator = 'ANZEN ERP / PT. Shubham Artha Mulia';
  wb.lastModifiedBy = 'ANZEN ERP';
  wb.created = new Date();
  wb.modified = new Date();

  // ═══════════════════════════════════════════════════════════════════════════
  // MODE A: CONSOLIDATED SUMMARY (SINGLE BEAUTIFUL SHEET)
  // ═══════════════════════════════════════════════════════════════════════════
  if (exportFormat === 'consolidated') {
    onProgress?.('Formatting consolidated product report...', 60);

    const ws = wb.addWorksheet('Product Profitability', {
      views: [{ state: 'frozen', ySplit: 8, showGridLines: true }],
    });

    createReportHeaderBanner(
      ws,
      'Sales Profitability Report — Consolidated Product Summary',
      label,
      startDate,
      endDate
    );
    createExecutiveKpiBlock(ws, company);

    // Columns configuration
    const cols = [
      { header: '#', key: 'idx', width: 6 },
      { header: 'Product Code', key: 'product_code', width: 15 },
      { header: 'Product Name', key: 'product_name', width: 36 },
      { header: 'Unit', key: 'unit', width: 8 },
      { header: 'Current Stock', key: 'current_stock', width: 14 },
      { header: 'Reserved Stock', key: 'reserved_stock', width: 14 },
      { header: 'Available Stock', key: 'available_stock', width: 15 },
      { header: 'Sold Qty', key: 'sold_qty', width: 13 },
      { header: 'Avg Landed Cost (IDR)', key: 'avg_landed_cost', width: 22 },
      { header: 'Avg Selling Price (IDR)', key: 'avg_selling_price', width: 22 },
      { header: 'Sales Exp / Unit (IDR)', key: 'sales_expense_per_unit', width: 20 },
      { header: 'Net Realization (IDR)', key: 'net_selling_price_per_unit', width: 20 },
      { header: 'Profit / Unit (IDR)', key: 'profit_per_unit', width: 18 },
      { header: 'Gross Sales (IDR)', key: 'gross_sales', width: 22 },
      { header: 'Total Landed Cost (IDR)', key: 'product_cost', width: 22 },
      { header: 'Sales Expenses (IDR)', key: 'sales_expense', width: 20 },
      { header: 'Gross Profit (IDR)', key: 'gross_profit', width: 20 },
      { header: 'Margin %', key: 'profit_margin_pct', width: 12 },
      { header: 'Total Net Profit (IDR)', key: 'profit_after_sales_expense', width: 22 },
    ];

    const tableHeaders = cols.map((c) => c.header);
    const headerRow = ws.addRow(tableHeaders);
    headerRow.height = 28;

    headerRow.eachCell((cell, colNumber) => {
      cell.fill = FILL_HEADER;
      cell.font = FONT_HEADER;
      cell.border = BORDER_HEADER;
      // Alignments
      if (colNumber === 1 || colNumber === 2 || colNumber === 4) {
        cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
      } else if (colNumber === 3) {
        cell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
      } else {
        cell.alignment = { vertical: 'middle', horizontal: 'right', wrapText: true };
      }
    });

    let totalSoldQty = 0;
    let totalGrossSales = 0;
    let totalLandedCost = 0;
    let totalSalesExp = 0;
    let totalGrossProfit = 0;
    let totalNetProfit = 0;

    // Data rows
    products.forEach((p, index) => {
      const isZebra = index % 2 === 1;
      const soldQty = Number(p.sold_qty || 0);
      const grossSales = Number(p.gross_sales || 0);
      const landedCost = p.product_cost != null ? Number(p.product_cost) : null;
      const salesExp = Number(p.sales_expense || 0);
      const grossProfit = p.gross_profit != null ? Number(p.gross_profit) : null;
      const netProfit = p.profit_after_sales_expense != null ? Number(p.profit_after_sales_expense) : null;
      const margin = p.profit_margin_pct != null ? Number(p.profit_margin_pct) / 100 : null;

      totalSoldQty += soldQty;
      totalGrossSales += grossSales;
      if (landedCost != null) totalLandedCost += landedCost;
      totalSalesExp += salesExp;
      if (grossProfit != null) totalGrossProfit += grossProfit;
      if (netProfit != null) totalNetProfit += netProfit;

      const row = ws.addRow([
        index + 1,
        p.product_code || '—',
        p.product_name,
        p.product_unit || 'kg',
        Number(p.current_stock || 0),
        Number(p.reserved_stock || 0),
        Number(p.available_stock || 0),
        soldQty,
        p.avg_landed_cost != null ? Number(p.avg_landed_cost) : '—',
        Number(p.avg_selling_price || 0),
        Number(p.sales_expense_per_unit || 0),
        Number(p.net_selling_price_per_unit || 0),
        p.profit_per_unit != null ? Number(p.profit_per_unit) : '—',
        grossSales,
        landedCost != null ? landedCost : '—',
        salesExp,
        grossProfit != null ? grossProfit : '—',
        margin != null ? margin : '—',
        netProfit != null ? netProfit : '—',
      ]);
      row.height = 20;

      // Cell styling & number formats
      row.eachCell((cell, colNumber) => {
        cell.border = BORDER_THIN;
        cell.font = FONT_DATA;
        if (isZebra) cell.fill = FILL_ZEBRA;

        if (colNumber === 1 || colNumber === 2 || colNumber === 4) {
          cell.alignment = { vertical: 'middle', horizontal: 'center' };
        } else if (colNumber === 3) {
          cell.alignment = { vertical: 'middle', horizontal: 'left' };
        } else {
          cell.alignment = { vertical: 'middle', horizontal: 'right' };
          // Number formatting
          if (colNumber >= 5 && colNumber <= 8) {
            cell.numFmt = '#,##0.00';
          } else if (colNumber >= 9 && colNumber <= 17) {
            if (typeof cell.value === 'number') {
              cell.numFmt = '#,##0.00';
            }
          } else if (colNumber === 18) {
            if (typeof cell.value === 'number') {
              cell.numFmt = '0.0%';
            }
          } else if (colNumber === 19) {
            if (typeof cell.value === 'number') {
              cell.numFmt = '#,##0.00';
              cell.font = FONT_BOLD;
            }
          }
        }
      });
    });

    // Summary / Total Row
    const overallMargin = totalGrossSales > 0 ? totalNetProfit / totalGrossSales : 0;
    const totalRow = ws.addRow([
      '',
      'TOTAL',
      'COMPANY CONSOLIDATED SUMMARY',
      '',
      '',
      '',
      '',
      totalSoldQty,
      '',
      '',
      '',
      '',
      '',
      totalGrossSales,
      totalLandedCost,
      totalSalesExp,
      totalGrossProfit,
      overallMargin,
      totalNetProfit,
    ]);
    totalRow.height = 24;

    totalRow.eachCell((cell, colNumber) => {
      cell.fill = FILL_TOTAL;
      cell.font = FONT_BOLD;
      cell.border = BORDER_TOTAL;

      if (colNumber === 2 || colNumber === 3) {
        cell.alignment = { vertical: 'middle', horizontal: 'left' };
      } else {
        cell.alignment = { vertical: 'middle', horizontal: 'right' };
        if (colNumber === 8) {
          cell.numFmt = '#,##0.00';
        } else if (colNumber === 14 || colNumber === 15 || colNumber === 16 || colNumber === 17 || colNumber === 19) {
          cell.numFmt = '#,##0.00';
        } else if (colNumber === 18) {
          cell.numFmt = '0.0%';
        }
      }
    });

    // Apply column widths
    cols.forEach((col, idx) => {
      ws.getColumn(idx + 1).width = col.width;
    });

    onProgress?.('Generating clean Excel file...', 90);
    const buffer = await wb.xlsx.writeBuffer();
    const cleanLabel = label.replace(/[^a-zA-Z0-9_-]/g, '_');
    const filename = `Sales_Profitability_Consolidated_${cleanLabel}_${startDate}_to_${endDate}.xlsx`;

    downloadWorkbookBuffer(buffer, filename);
    onProgress?.('Export completed successfully!', 100);
    return;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MODE B: FULL DETAILED DRILL-DOWN (4 DEDICATED SHEETS)
  // ═══════════════════════════════════════════════════════════════════════════
  onProgress?.('Fetching batch details for all products...', 25);

  // 2. Fetch batches for each product concurrently (pool limit 6)
  interface ProductWithBatches {
    product: RawProductRow;
    batches: RawBatchRow[];
  }

  let batchesCompleted = 0;
  const productsWithBatches: ProductWithBatches[] = await asyncPool(
    6,
    products,
    async (prod) => {
      try {
        const { data: bData, error: bErr } = await supabase.rpc(
          'get_sales_profitability_product_batches',
          {
            p_product_id: prod.product_id,
            p_start_date: startDate,
            p_end_date: endDate,
          }
        );
        batchesCompleted++;
        const pct = 25 + Math.round((batchesCompleted / (products.length || 1)) * 25);
        onProgress?.(`Fetching batch details (${batchesCompleted}/${products.length})...`, pct);

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
  productsWithBatches.forEach((pb) => {
    pb.batches.forEach((b) => {
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
        const { data: oData, error: oErr } = await supabase.rpc(
          'get_sales_profitability_batch_orders',
          {
            p_batch_id: task.batch.batch_id,
            p_start_date: startDate,
            p_end_date: endDate,
          }
        );
        ordersCompleted++;
        const pct = 50 + Math.round((ordersCompleted / (batchTasks.length || 1)) * 30);
        onProgress?.(
          `Fetching delivery & invoice details (${ordersCompleted}/${batchTasks.length})...`,
          pct
        );

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

  // Organize by batch_id -> orders
  const batchOrdersMap = new Map<string, RawOrderRow[]>();
  batchesWithOrders.forEach((bwo) => {
    batchOrdersMap.set(bwo.batch.batch_id, bwo.orders);
  });

  onProgress?.('Assembling multi-sheet Excel workbook with report formatting...', 85);

  // ───────────────────────────────────────────────────────────────────────────
  // SHEET 1: Detailed Profitability Audit (Full Hierarchical Drill-Down)
  // ───────────────────────────────────────────────────────────────────────────
  const wsAudit = wb.addWorksheet('Detailed Audit', {
    views: [{ state: 'frozen', ySplit: 8, showGridLines: true }],
  });

  createReportHeaderBanner(
    wsAudit,
    'Sales Profitability Audit Report (Full Drill-Down)',
    label,
    startDate,
    endDate
  );
  createExecutiveKpiBlock(wsAudit, company);

  const auditHeaders = [
    'Hierarchy Level',
    'Product Code',
    'Product Name / Description',
    'Batch Number',
    'Invoice Number',
    'Invoice Date',
    'Customer Name',
    'Sales Order #',
    'Delivery Challan #',
    'Unit',
    'Current Stock',
    'Sold Qty',
    'Landed Cost / Unit (IDR)',
    'Selling Price / Unit (IDR)',
    'Sales Exp / Unit (IDR)',
    'Net Realization / Unit (IDR)',
    'Gross Sales (IDR)',
    'Landed Cost / COGS (IDR)',
    'Sales Delivery Exp (IDR)',
    'Gross Profit (IDR)',
    'Net Realized Profit (IDR)',
    'Profit Margin %',
    'Delivery Expense Vouchers & Notes',
  ];

  const auditHeaderRow = wsAudit.addRow(auditHeaders);
  auditHeaderRow.height = 28;
  auditHeaderRow.eachCell((cell, colNum) => {
    cell.fill = FILL_HEADER;
    cell.font = FONT_HEADER;
    cell.border = BORDER_HEADER;
    if (colNum <= 2 || (colNum >= 4 && colNum <= 10)) {
      cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    } else if (colNum === 3 || colNum === 7 || colNum === 23) {
      cell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
    } else {
      cell.alignment = { vertical: 'middle', horizontal: 'right', wrapText: true };
    }
  });

  // Populate hierarchical rows
  for (const pb of productsWithBatches) {
    const prod = pb.product;

    // PRODUCT SUMMARY ROW
    const prodRow = wsAudit.addRow([
      'PRODUCT',
      prod.product_code || '—',
      prod.product_name,
      'ALL BATCHES',
      '—',
      '—',
      '—',
      '—',
      '—',
      prod.product_unit || 'kg',
      Number(prod.current_stock || 0),
      Number(prod.sold_qty || 0),
      prod.avg_landed_cost != null ? Number(prod.avg_landed_cost) : '—',
      Number(prod.avg_selling_price || 0),
      Number(prod.sales_expense_per_unit || 0),
      Number(prod.net_selling_price_per_unit || 0),
      Number(prod.gross_sales || 0),
      prod.product_cost != null ? Number(prod.product_cost) : '—',
      Number(prod.sales_expense || 0),
      prod.gross_profit != null ? Number(prod.gross_profit) : '—',
      prod.profit_after_sales_expense != null ? Number(prod.profit_after_sales_expense) : '—',
      prod.profit_margin_pct != null ? Number(prod.profit_margin_pct) / 100 : '—',
      '',
    ]);
    prodRow.height = 22;
    prodRow.eachCell((cell, colNum) => {
      cell.fill = FILL_TOTAL;
      cell.font = FONT_BOLD;
      cell.border = BORDER_THIN;
      if (colNum <= 2 || (colNum >= 4 && colNum <= 10)) {
        cell.alignment = { vertical: 'middle', horizontal: 'center' };
      } else if (colNum === 3 || colNum === 7 || colNum === 23) {
        cell.alignment = { vertical: 'middle', horizontal: 'left' };
      } else {
        cell.alignment = { vertical: 'middle', horizontal: 'right' };
        if (typeof cell.value === 'number') {
          cell.numFmt = colNum === 22 ? '0.0%' : '#,##0.00';
        }
      }
    });

    // BATCH ROWS
    for (const b of pb.batches) {
      const batchRow = wsAudit.addRow([
        'BATCH',
        prod.product_code || '—',
        prod.product_name,
        b.batch_number,
        '—',
        '—',
        '—',
        '—',
        '—',
        prod.product_unit || 'kg',
        Number(b.current_stock || 0),
        Number(b.sold_qty || 0),
        b.cost_per_unit != null ? Number(b.cost_per_unit) : '—',
        Number(b.avg_selling_price || 0),
        Number(b.sales_expense_per_unit || 0),
        Number(b.net_selling_price_per_unit || 0),
        Number(b.gross_sales || 0),
        b.product_cost != null ? Number(b.product_cost) : '—',
        Number(b.sales_expense || 0),
        b.gross_profit != null ? Number(b.gross_profit) : '—',
        b.profit_after_sales_expense != null ? Number(b.profit_after_sales_expense) : '—',
        b.profit_margin_pct != null ? Number(b.profit_margin_pct) / 100 : '—',
        b.is_imported ? 'Imported Batch' : 'Local Batch',
      ]);
      batchRow.height = 20;
      batchRow.eachCell((cell, colNum) => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } };
        cell.font = { name: 'Calibri', size: 9.5, bold: true, color: { argb: 'FF1E3A8A' } };
        cell.border = BORDER_THIN;
        if (colNum <= 2 || (colNum >= 4 && colNum <= 10)) {
          cell.alignment = { vertical: 'middle', horizontal: 'center' };
        } else if (colNum === 3 || colNum === 7 || colNum === 23) {
          cell.alignment = { vertical: 'middle', horizontal: 'left' };
        } else {
          cell.alignment = { vertical: 'middle', horizontal: 'right' };
          if (typeof cell.value === 'number') {
            cell.numFmt = colNum === 22 ? '0.0%' : '#,##0.00';
          }
        }
      });

      // ORDER ROWS
      const orders = batchOrdersMap.get(b.batch_id) || [];
      for (const ord of orders) {
        const expenseVouchers = (ord.expenses || [])
          .map(
            (e) =>
              `${e.voucher_number || 'EXP'} (${e.category}): Rp ${Number(e.total_amount).toLocaleString(
                'id-ID'
              )}`
          )
          .join('; ');

        const ordRow = wsAudit.addRow([
          'INVOICE/DC',
          prod.product_code || '—',
          prod.product_name,
          b.batch_number,
          ord.invoice_number,
          ord.invoice_date,
          ord.customer_name,
          ord.so_number || '—',
          ord.dc_number || '—',
          prod.product_unit || 'kg',
          '—',
          Number(ord.quantity || 0),
          ord.unit_cost != null ? Number(ord.unit_cost) : '—',
          Number(ord.selling_price || 0),
          Number(ord.line_sales_expense || 0) / Number(ord.quantity || 1),
          Number(ord.net_selling_realization || 0),
          Number(ord.gross_sales || 0),
          ord.line_cost != null ? Number(ord.line_cost) : '—',
          Number(ord.line_sales_expense || 0),
          ord.gross_profit != null ? Number(ord.gross_profit) : '—',
          ord.profit != null ? Number(ord.profit) : '—',
          ord.profit_margin_pct != null ? Number(ord.profit_margin_pct) / 100 : '—',
          expenseVouchers || 'None',
        ]);
        ordRow.height = 19;
        ordRow.eachCell((cell, colNum) => {
          cell.font = FONT_DATA;
          cell.border = BORDER_THIN;
          if (colNum <= 2 || (colNum >= 4 && colNum <= 10)) {
            cell.alignment = { vertical: 'middle', horizontal: 'center' };
          } else if (colNum === 3 || colNum === 7 || colNum === 23) {
            cell.alignment = { vertical: 'middle', horizontal: 'left' };
          } else {
            cell.alignment = { vertical: 'middle', horizontal: 'right' };
            if (typeof cell.value === 'number') {
              cell.numFmt = colNum === 22 ? '0.0%' : '#,##0.00';
            }
          }
        });
      }
    }
  }

  // Auto-fit audit columns
  const auditColWidths = [
    12, 14, 30, 18, 16, 12, 26, 14, 16, 8, 14, 12, 18, 18, 18, 18, 20, 20, 18, 18, 20, 12, 35,
  ];
  auditColWidths.forEach((w, i) => {
    wsAudit.getColumn(i + 1).width = w;
  });

  // ───────────────────────────────────────────────────────────────────────────
  // SHEET 2: Product Summary
  // ───────────────────────────────────────────────────────────────────────────
  const wsProduct = wb.addWorksheet('Product Summary', {
    views: [{ state: 'frozen', ySplit: 8, showGridLines: true }],
  });

  createReportHeaderBanner(
    wsProduct,
    'Sales Profitability — Product Summary',
    label,
    startDate,
    endDate
  );
  createExecutiveKpiBlock(wsProduct, company);

  const prodSummaryHeaders = [
    '#',
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
    'Net Realization (IDR)',
    'Profit / Unit (IDR)',
    'Gross Sales (IDR)',
    'Total Landed Cost (IDR)',
    'Sales Expenses (IDR)',
    'Gross Profit (IDR)',
    'Margin %',
    'Total Net Profit (IDR)',
  ];

  const prodHeaderRow = wsProduct.addRow(prodSummaryHeaders);
  prodHeaderRow.height = 28;
  prodHeaderRow.eachCell((cell, colNum) => {
    cell.fill = FILL_SUBHEADER;
    cell.font = FONT_HEADER;
    cell.border = BORDER_HEADER;
    if (colNum === 1 || colNum === 2 || colNum === 4) {
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
    } else if (colNum === 3) {
      cell.alignment = { vertical: 'middle', horizontal: 'left' };
    } else {
      cell.alignment = { vertical: 'middle', horizontal: 'right' };
    }
  });

  products.forEach((p, idx) => {
    const isZebra = idx % 2 === 1;
    const r = wsProduct.addRow([
      idx + 1,
      p.product_code || '—',
      p.product_name,
      p.product_unit || 'kg',
      Number(p.current_stock || 0),
      Number(p.reserved_stock || 0),
      Number(p.available_stock || 0),
      Number(p.sold_qty || 0),
      p.avg_landed_cost != null ? Number(p.avg_landed_cost) : '—',
      Number(p.avg_selling_price || 0),
      Number(p.sales_expense_per_unit || 0),
      Number(p.net_selling_price_per_unit || 0),
      p.profit_per_unit != null ? Number(p.profit_per_unit) : '—',
      Number(p.gross_sales || 0),
      p.product_cost != null ? Number(p.product_cost) : '—',
      Number(p.sales_expense || 0),
      p.gross_profit != null ? Number(p.gross_profit) : '—',
      p.profit_margin_pct != null ? Number(p.profit_margin_pct) / 100 : '—',
      p.profit_after_sales_expense != null ? Number(p.profit_after_sales_expense) : '—',
    ]);
    r.height = 20;
    r.eachCell((cell, colNum) => {
      cell.border = BORDER_THIN;
      cell.font = FONT_DATA;
      if (isZebra) cell.fill = FILL_ZEBRA;
      if (colNum === 1 || colNum === 2 || colNum === 4) {
        cell.alignment = { vertical: 'middle', horizontal: 'center' };
      } else if (colNum === 3) {
        cell.alignment = { vertical: 'middle', horizontal: 'left' };
      } else {
        cell.alignment = { vertical: 'middle', horizontal: 'right' };
        if (typeof cell.value === 'number') {
          cell.numFmt = colNum === 18 ? '0.0%' : '#,##0.00';
          if (colNum === 19) cell.font = FONT_BOLD;
        }
      }
    });
  });

  const prodColWidths = [6, 14, 34, 8, 14, 14, 14, 12, 20, 20, 18, 18, 18, 20, 20, 18, 18, 12, 20];
  prodColWidths.forEach((w, i) => {
    wsProduct.getColumn(i + 1).width = w;
  });

  // ───────────────────────────────────────────────────────────────────────────
  // SHEET 3: Batch Breakdown
  // ───────────────────────────────────────────────────────────────────────────
  const wsBatch = wb.addWorksheet('Batch Breakdown', {
    views: [{ state: 'frozen', ySplit: 8, showGridLines: true }],
  });

  createReportHeaderBanner(
    wsBatch,
    'Sales Profitability — Granular Batch Breakdown',
    label,
    startDate,
    endDate
  );
  createExecutiveKpiBlock(wsBatch, company);

  const batchHeaders = [
    '#',
    'Product Code',
    'Product Name',
    'Batch Number',
    'Batch Type',
    'Current Stock',
    'Sold Qty',
    'Batch Unit Cost (IDR)',
    'Avg Selling Price (IDR)',
    'Sales Exp / Unit (IDR)',
    'Net Realization (IDR)',
    'Profit / Unit (IDR)',
    'Gross Sales (IDR)',
    'Total Landed Cost (IDR)',
    'Sales Expenses (IDR)',
    'Gross Profit (IDR)',
    'Margin %',
    'Net Profit (IDR)',
  ];

  const batchHeaderRow = wsBatch.addRow(batchHeaders);
  batchHeaderRow.height = 28;
  batchHeaderRow.eachCell((cell, colNum) => {
    cell.fill = FILL_HEADER;
    cell.font = FONT_HEADER;
    cell.border = BORDER_HEADER;
    if (colNum <= 2 || colNum === 4 || colNum === 5) {
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
    } else if (colNum === 3) {
      cell.alignment = { vertical: 'middle', horizontal: 'left' };
    } else {
      cell.alignment = { vertical: 'middle', horizontal: 'right' };
    }
  });

  let batchIdx = 1;
  productsWithBatches.forEach((pb) => {
    pb.batches.forEach((b) => {
      const isZebra = batchIdx % 2 === 0;
      const r = wsBatch.addRow([
        batchIdx++,
        pb.product.product_code || '—',
        pb.product.product_name,
        b.batch_number,
        b.is_imported ? 'Imported' : 'Local',
        Number(b.current_stock || 0),
        Number(b.sold_qty || 0),
        b.cost_per_unit != null ? Number(b.cost_per_unit) : '—',
        Number(b.avg_selling_price || 0),
        Number(b.sales_expense_per_unit || 0),
        Number(b.net_selling_price_per_unit || 0),
        b.profit_per_unit != null ? Number(b.profit_per_unit) : '—',
        Number(b.gross_sales || 0),
        b.product_cost != null ? Number(b.product_cost) : '—',
        Number(b.sales_expense || 0),
        b.gross_profit != null ? Number(b.gross_profit) : '—',
        b.profit_margin_pct != null ? Number(b.profit_margin_pct) / 100 : '—',
        b.profit_after_sales_expense != null ? Number(b.profit_after_sales_expense) : '—',
      ]);
      r.height = 20;
      r.eachCell((cell, colNum) => {
        cell.border = BORDER_THIN;
        cell.font = FONT_DATA;
        if (isZebra) cell.fill = FILL_ZEBRA;
        if (colNum <= 2 || colNum === 4 || colNum === 5) {
          cell.alignment = { vertical: 'middle', horizontal: 'center' };
        } else if (colNum === 3) {
          cell.alignment = { vertical: 'middle', horizontal: 'left' };
        } else {
          cell.alignment = { vertical: 'middle', horizontal: 'right' };
          if (typeof cell.value === 'number') {
            cell.numFmt = colNum === 17 ? '0.0%' : '#,##0.00';
            if (colNum === 18) cell.font = FONT_BOLD;
          }
        }
      });
    });
  });

  const batchColWidths = [6, 14, 32, 18, 12, 14, 12, 20, 20, 18, 18, 18, 20, 20, 18, 18, 12, 20];
  batchColWidths.forEach((w, i) => {
    wsBatch.getColumn(i + 1).width = w;
  });

  // ───────────────────────────────────────────────────────────────────────────
  // SHEET 4: Orders & Delivery Challans
  // ───────────────────────────────────────────────────────────────────────────
  const wsOrders = wb.addWorksheet('Orders & Challans', {
    views: [{ state: 'frozen', ySplit: 8, showGridLines: true }],
  });

  createReportHeaderBanner(
    wsOrders,
    'Sales Profitability — Invoices, Delivery Challans & Expenses',
    label,
    startDate,
    endDate
  );
  createExecutiveKpiBlock(wsOrders, company);

  const orderHeaders = [
    'Invoice #',
    'Invoice Date',
    'Customer Name',
    'SO #',
    'DC #',
    'Product Code',
    'Product Name',
    'Batch Number',
    'Qty Sold',
    'Unit Price (IDR)',
    'Gross Sales (IDR)',
    'Unit Cost (IDR)',
    'Total Landed Cost (IDR)',
    'Delivery & Sales Exp (IDR)',
    'Net Realization (IDR)',
    'Gross Profit (IDR)',
    'Net Profit (IDR)',
    'Margin %',
    'Delivery Expense Vouchers & Notes',
  ];

  const orderHeaderRow = wsOrders.addRow(orderHeaders);
  orderHeaderRow.height = 28;
  orderHeaderRow.eachCell((cell, colNum) => {
    cell.fill = FILL_SUBHEADER;
    cell.font = FONT_HEADER;
    cell.border = BORDER_HEADER;
    if (colNum <= 2 || (colNum >= 4 && colNum <= 6) || colNum === 8) {
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
    } else if (colNum === 3 || colNum === 7 || colNum === 19) {
      cell.alignment = { vertical: 'middle', horizontal: 'left' };
    } else {
      cell.alignment = { vertical: 'middle', horizontal: 'right' };
    }
  });

  let ordIdx = 0;
  batchesWithOrders.forEach((bwo) => {
    bwo.orders.forEach((ord) => {
      const isZebra = ordIdx++ % 2 === 1;
      const expenseDetails = (ord.expenses || [])
        .map(
          (e) =>
            `${e.voucher_number || 'EXP'} (${e.category}): Rp ${Number(e.total_amount).toLocaleString(
              'id-ID'
            )}`
        )
        .join('; ');

      const r = wsOrders.addRow([
        ord.invoice_number,
        ord.invoice_date,
        ord.customer_name,
        ord.so_number || '—',
        ord.dc_number || '—',
        bwo.product.product_code || '—',
        bwo.product.product_name,
        bwo.batch.batch_number,
        Number(ord.quantity || 0),
        Number(ord.selling_price || 0),
        Number(ord.gross_sales || 0),
        ord.unit_cost != null ? Number(ord.unit_cost) : '—',
        ord.line_cost != null ? Number(ord.line_cost) : '—',
        Number(ord.line_sales_expense || 0),
        Number(ord.net_selling_realization || 0),
        ord.gross_profit != null ? Number(ord.gross_profit) : '—',
        ord.profit != null ? Number(ord.profit) : '—',
        ord.profit_margin_pct != null ? Number(ord.profit_margin_pct) / 100 : '—',
        expenseDetails || 'None',
      ]);
      r.height = 20;
      r.eachCell((cell, colNum) => {
        cell.border = BORDER_THIN;
        cell.font = FONT_DATA;
        if (isZebra) cell.fill = FILL_ZEBRA;
        if (colNum <= 2 || (colNum >= 4 && colNum <= 6) || colNum === 8) {
          cell.alignment = { vertical: 'middle', horizontal: 'center' };
        } else if (colNum === 3 || colNum === 7 || colNum === 19) {
          cell.alignment = { vertical: 'middle', horizontal: 'left' };
        } else {
          cell.alignment = { vertical: 'middle', horizontal: 'right' };
          if (typeof cell.value === 'number') {
            cell.numFmt = colNum === 18 ? '0.0%' : '#,##0.00';
            if (colNum === 17) cell.font = FONT_BOLD;
          }
        }
      });
    });
  });

  const orderColWidths = [
    16, 12, 28, 14, 16, 14, 30, 18, 12, 18, 20, 18, 20, 18, 18, 18, 20, 12, 35,
  ];
  orderColWidths.forEach((w, i) => {
    wsOrders.getColumn(i + 1).width = w;
  });

  onProgress?.('Finalizing workbook and downloading...', 96);

  const buffer = await wb.xlsx.writeBuffer();
  const cleanLabel = label.replace(/[^a-zA-Z0-9_-]/g, '_');
  const filename = `Sales_Profitability_Full_Drilldown_${cleanLabel}_${startDate}_to_${endDate}.xlsx`;

  downloadWorkbookBuffer(buffer, filename);
  onProgress?.('Export completed successfully!', 100);
}
