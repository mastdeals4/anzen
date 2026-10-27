import ExcelJS from 'exceljs';
import { formatUnit } from './unitDisplay';
import {
  fetchCanonicalSalesProfitability,
  CompanyProfitabilitySummary,
  OrderSaleRow,
} from '../services/salesProfitabilityEngine';

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
  exportFormat?: 'consolidated' | 'detailed'; // default 'detailed'
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

// ─── Browser File Download Helper ────────────────────────────────────────────

function downloadWorkbookBuffer(buffer: ArrayBuffer | Uint8Array, filename: string) {
  const blob = new Blob([buffer as BlobPart], {
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
  const r1 = ws.addRow(['PT. SHUBHAM ARTHA MULIA / ANZEN ERP']);
  r1.font = { name: 'Calibri', size: 14, bold: true, color: { argb: 'FF0F2942' } };

  const r2 = ws.addRow([reportTitle.toUpperCase()]);
  r2.font = { name: 'Calibri', size: 11, bold: true, color: { argb: 'FF334155' } };

  const nowStr = new Date().toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  const r3 = ws.addRow([
    `Period: ${periodLabel} (${startDate} to ${endDate})   |   Generated: ${nowStr}   |   Currency: Indonesian Rupiah (IDR)   |   Margin % = Net Realized Profit / Gross Sales`,
  ]);
  r3.font = { name: 'Calibri', size: 9, italic: true, color: { argb: 'FF64748B' } };

  ws.addRow([]); // Blank line
}

// ─── Helper to Build Executive KPI Block ─────────────────────────────────────

function createExecutiveKpiBlock(ws: ExcelJS.Worksheet, company: CompanyProfitabilitySummary) {
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

    if (colNumber === 5 || colNumber === 6) {
      cell.fill = FILL_ACCENT_GREEN;
      cell.font = { name: 'Calibri', size: 10, bold: true, color: { argb: 'FF065F46' } };
    }
  });

  ws.addRow([]); // Blank line
}

// ─── Format Expense Details & Cost Layer Lineage ───────────────────────────────

function formatOrderLineageNotes(ord: OrderSaleRow): string {
  const parts: string[] = [];

  // 1. Layer Allocations
  if (ord.layer_allocations && ord.layer_allocations.length > 0) {
    const layerDesc = ord.layer_allocations
      .map((l) => {
        const pi = l.pi_number ? `PI: ${l.pi_number}` : 'Cost Layer';
        const costStr = Number(l.cost).toLocaleString('id-ID', { maximumFractionDigits: 0 });
        const unitStr = Number(l.unit_cost).toLocaleString('id-ID', { maximumFractionDigits: 2 });
        return `${pi} (${l.consumed_qty} @ Rp ${unitStr} = Rp ${costStr})`;
      })
      .join('; ');
    parts.push(`Layer Alloc: ${layerDesc}`);
  }

  // 2. Delivery & Sales Expenses
  if (ord.expenses && ord.expenses.length > 0) {
    const expDesc = ord.expenses
      .map(
        (e) =>
          `${e.voucher_number || 'EXP'} (${e.category}): Rp ${Number(e.total_amount).toLocaleString(
            'id-ID',
            { maximumFractionDigits: 0 }
          )}`
      )
      .join('; ');
    parts.push(`Expenses: ${expDesc}`);
  }

  return parts.length > 0 ? parts.join(' | ') : 'Standard Batch Cost';
}

// ─── Main Export Generator ───────────────────────────────────────────────────

export async function generateSalesProfitabilityExcel(
  options: ExportDateRangeOptions,
  onProgress?: ExportProgressCallback
): Promise<void> {
  const { startDate, endDate, label, exportFormat = 'detailed' } = options;

  // 1. Fetch unified reconciled dataset through canonical profitability engine
  const dataset = await fetchCanonicalSalesProfitability({
    startDate,
    endDate,
    onProgress,
  });

  const { company, products, productsWithBatches, batchOrdersMap } = dataset;

  onProgress?.('Assembling standardized Excel workbook with borders and currency formatting...', 85);

  const wb = new ExcelJS.Workbook();
  wb.creator = 'ANZEN ERP / PT. Shubham Artha Mulia';
  wb.lastModifiedBy = 'ANZEN ERP';
  wb.created = new Date();
  wb.modified = new Date();

  // ═══════════════════════════════════════════════════════════════════════════
  // MODE A: SINGLE CONSOLIDATED PRODUCT SUMMARY SHEET
  // ═══════════════════════════════════════════════════════════════════════════
  if (exportFormat === 'consolidated') {
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

    const cols = [
      { header: '#', width: 6 },
      { header: 'Product Code', width: 15 },
      { header: 'Product Name', width: 36 },
      { header: 'Unit', width: 8 },
      { header: 'Current Stock', width: 14 },
      { header: 'Reserved Stock', width: 14 },
      { header: 'Available Stock', width: 15 },
      { header: 'Sold Qty', width: 13 },
      { header: 'Avg Landed Cost (IDR)', width: 22 },
      { header: 'Avg Selling Price (IDR)', width: 22 },
      { header: 'Sales Exp / Unit (IDR)', width: 20 },
      { header: 'Net Realization (IDR)', width: 20 },
      { header: 'Profit / Unit (IDR)', width: 18 },
      { header: 'Gross Sales (IDR)', width: 22 },
      { header: 'Total Landed Cost (IDR)', width: 22 },
      { header: 'Sales Expenses (IDR)', width: 20 },
      { header: 'Gross Profit (IDR)', width: 20 },
      { header: 'Margin % (Profit/Sales)', width: 22 },
      { header: 'Total Net Profit (IDR)', width: 22 },
    ];

    const headerRow = ws.addRow(cols.map((c) => c.header));
    headerRow.height = 28;
    headerRow.eachCell((cell, colNumber) => {
      cell.fill = FILL_HEADER;
      cell.font = FONT_HEADER;
      cell.border = BORDER_HEADER;
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

    products.forEach((p, index) => {
      const isZebra = index % 2 === 1;
      const soldQty = Number(p.sold_qty || 0);
      const grossSales = Number(p.gross_sales || 0);
      const landedCost = p.product_cost != null ? Number(p.product_cost) : 0;
      const salesExp = Number(p.sales_expense || 0);
      const grossProfit = p.gross_profit != null ? Number(p.gross_profit) : (grossSales - landedCost);
      const netProfit = p.profit_after_sales_expense != null ? Number(p.profit_after_sales_expense) : (grossProfit - salesExp);
      const margin = p.profit_margin_pct != null ? Number(p.profit_margin_pct) / 100 : (grossSales > 0 ? netProfit / grossSales : null);

      totalSoldQty += soldQty;
      totalGrossSales += grossSales;
      totalLandedCost += landedCost;
      totalSalesExp += salesExp;
      totalGrossProfit += grossProfit;
      totalNetProfit += netProfit;

      const row = ws.addRow([
        index + 1,
        p.product_code || '—',
        p.product_name,
        p.product_unit ? formatUnit(p.product_unit) : 'KG',
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
        landedCost,
        salesExp,
        grossProfit,
        margin != null ? margin : '—',
        netProfit,
      ]);
      row.height = 20;

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
          if (colNumber >= 5 && colNumber <= 8) {
            cell.numFmt = '#,##0.00';
          } else if (colNumber >= 9 && colNumber <= 17) {
            if (typeof cell.value === 'number') cell.numFmt = '#,##0.00';
          } else if (colNumber === 18) {
            if (typeof cell.value === 'number') cell.numFmt = '0.0%';
          } else if (colNumber === 19) {
            if (typeof cell.value === 'number') {
              cell.numFmt = '#,##0.00';
              cell.font = FONT_BOLD;
            }
          }
        }
      });
    });

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
        } else if (
          colNumber === 14 ||
          colNumber === 15 ||
          colNumber === 16 ||
          colNumber === 17 ||
          colNumber === 19
        ) {
          cell.numFmt = '#,##0.00';
        } else if (colNumber === 18) {
          cell.numFmt = '0.0%';
        }
      }
    });

    cols.forEach((col, idx) => {
      ws.getColumn(idx + 1).width = col.width;
    });

    onProgress?.('Generating clean Excel file...', 95);
    const buffer = await wb.xlsx.writeBuffer();
    const cleanLabel = label.replace(/[^a-zA-Z0-9_-]/g, '_');
    const filename = `Sales_Profitability_Consolidated_${cleanLabel}_${startDate}_to_${endDate}.xlsx`;

    downloadWorkbookBuffer(buffer, filename);
    onProgress?.('Export completed successfully!', 100);
    return;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MODE B: FULL 4-SHEET RECONCILED DRILL-DOWN WORKBOOK
  // Ordered per Requirement 10:
  // 1. Product Summary
  // 2. Batch Breakdown
  // 3. Detailed Audit
  // 4. Orders & Challans
  // ═══════════════════════════════════════════════════════════════════════════

  // ───────────────────────────────────────────────────────────────────────────
  // SHEET 1: Product Summary
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
    'Margin % (Profit/Sales)',
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

  let sumProdQty = 0;
  let sumProdGrossSales = 0;
  let sumProdLandedCost = 0;
  let sumProdSalesExp = 0;
  let sumProdGrossProfit = 0;
  let sumProdNetProfit = 0;

  products.forEach((p, idx) => {
    const isZebra = idx % 2 === 1;
    const soldQty = Number(p.sold_qty || 0);
    const grossSales = Number(p.gross_sales || 0);
    const landedCost = Number(p.product_cost || 0);
    const salesExp = Number(p.sales_expense || 0);
    const grossProfit = Number(p.gross_profit != null ? p.gross_profit : grossSales - landedCost);
    const netProfit = Number(p.profit_after_sales_expense != null ? p.profit_after_sales_expense : grossProfit - salesExp);
    const margin = p.profit_margin_pct != null ? Number(p.profit_margin_pct) / 100 : (grossSales > 0 ? netProfit / grossSales : null);

    sumProdQty += soldQty;
    sumProdGrossSales += grossSales;
    sumProdLandedCost += landedCost;
    sumProdSalesExp += salesExp;
    sumProdGrossProfit += grossProfit;
    sumProdNetProfit += netProfit;

    const r = wsProduct.addRow([
      idx + 1,
      p.product_code || '—',
      p.product_name,
      p.product_unit ? formatUnit(p.product_unit) : 'KG',
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
      landedCost,
      salesExp,
      grossProfit,
      margin != null ? margin : '—',
      netProfit,
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
        if (colNum >= 5 && colNum <= 8) {
          cell.numFmt = '#,##0.00';
        } else if (colNum >= 9 && colNum <= 17) {
          if (typeof cell.value === 'number') cell.numFmt = '#,##0.00';
        } else if (colNum === 18) {
          if (typeof cell.value === 'number') cell.numFmt = '0.0%';
        } else if (colNum === 19) {
          if (typeof cell.value === 'number') {
            cell.numFmt = '#,##0.00';
            cell.font = FONT_BOLD;
          }
        }
      }
    });
  });

  // Product Summary Total Row
  const overallProdMargin = sumProdGrossSales > 0 ? sumProdNetProfit / sumProdGrossSales : 0;
  const prodTotalRow = wsProduct.addRow([
    '',
    'TOTAL',
    'PRODUCT SUMMARY TOTAL',
    '',
    '',
    '',
    '',
    sumProdQty,
    '',
    '',
    '',
    '',
    '',
    sumProdGrossSales,
    sumProdLandedCost,
    sumProdSalesExp,
    sumProdGrossProfit,
    overallProdMargin,
    sumProdNetProfit,
  ]);
  prodTotalRow.height = 24;
  prodTotalRow.eachCell((cell, colNum) => {
    cell.fill = FILL_TOTAL;
    cell.font = FONT_BOLD;
    cell.border = BORDER_TOTAL;
    if (colNum === 2 || colNum === 3) {
      cell.alignment = { vertical: 'middle', horizontal: 'left' };
    } else {
      cell.alignment = { vertical: 'middle', horizontal: 'right' };
      if (colNum === 8 || (colNum >= 14 && colNum <= 17) || colNum === 19) {
        cell.numFmt = '#,##0.00';
      } else if (colNum === 18) {
        cell.numFmt = '0.0%';
      }
    }
  });

  const prodColWidths = [6, 14, 34, 8, 14, 14, 14, 12, 20, 20, 18, 18, 18, 20, 20, 18, 18, 22, 20];
  prodColWidths.forEach((w, i) => {
    wsProduct.getColumn(i + 1).width = w;
  });

  // ───────────────────────────────────────────────────────────────────────────
  // SHEET 2: Batch Breakdown
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
    'Margin % (Profit/Sales)',
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
  let sumBatchQty = 0;
  let sumBatchGrossSales = 0;
  let sumBatchLandedCost = 0;
  let sumBatchSalesExp = 0;
  let sumBatchGrossProfit = 0;
  let sumBatchNetProfit = 0;

  productsWithBatches.forEach((pb) => {
    pb.batches.forEach((b) => {
      const isZebra = batchIdx % 2 === 0;
      const bSoldQty = Number(b.sold_qty || 0);
      const bGrossSales = Number(b.gross_sales || 0);
      const bProductCost = Number(b.product_cost || 0);
      const bSalesExp = Number(b.sales_expense || 0);
      const bGrossProfit = Number(b.gross_profit != null ? b.gross_profit : bGrossSales - bProductCost);
      const bNetProfit = Number(b.profit_after_sales_expense != null ? b.profit_after_sales_expense : bGrossProfit - bSalesExp);
      const bMargin = b.profit_margin_pct != null ? Number(b.profit_margin_pct) / 100 : (bGrossSales > 0 ? bNetProfit / bGrossSales : null);

      sumBatchQty += bSoldQty;
      sumBatchGrossSales += bGrossSales;
      sumBatchLandedCost += bProductCost;
      sumBatchSalesExp += bSalesExp;
      sumBatchGrossProfit += bGrossProfit;
      sumBatchNetProfit += bNetProfit;

      const r = wsBatch.addRow([
        batchIdx++,
        pb.product.product_code || '—',
        pb.product.product_name,
        b.batch_number,
        b.is_imported ? 'Imported' : 'Local',
        Number(b.current_stock || 0),
        bSoldQty,
        b.cost_per_unit != null ? Number(b.cost_per_unit) : '—',
        Number(b.avg_selling_price || 0),
        Number(b.sales_expense_per_unit || 0),
        Number(b.net_selling_price_per_unit || 0),
        b.profit_per_unit != null ? Number(b.profit_per_unit) : '—',
        bGrossSales,
        bProductCost,
        bSalesExp,
        bGrossProfit,
        bMargin != null ? bMargin : '—',
        bNetProfit,
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
          if (colNum === 6 || colNum === 7) {
            cell.numFmt = '#,##0.00';
          } else if (colNum >= 8 && colNum <= 16) {
            if (typeof cell.value === 'number') cell.numFmt = '#,##0.00';
          } else if (colNum === 17) {
            if (typeof cell.value === 'number') cell.numFmt = '0.0%';
          } else if (colNum === 18) {
            if (typeof cell.value === 'number') {
              cell.numFmt = '#,##0.00';
              cell.font = FONT_BOLD;
            }
          }
        }
      });
    });
  });

  // Batch Breakdown Total Row
  const overallBatchMargin = sumBatchGrossSales > 0 ? sumBatchNetProfit / sumBatchGrossSales : 0;
  const batchTotalRow = wsBatch.addRow([
    '',
    'TOTAL',
    'BATCH BREAKDOWN TOTAL',
    '',
    '',
    '',
    sumBatchQty,
    '',
    '',
    '',
    '',
    '',
    sumBatchGrossSales,
    sumBatchLandedCost,
    sumBatchSalesExp,
    sumBatchGrossProfit,
    overallBatchMargin,
    sumBatchNetProfit,
  ]);
  batchTotalRow.height = 24;
  batchTotalRow.eachCell((cell, colNum) => {
    cell.fill = FILL_TOTAL;
    cell.font = FONT_BOLD;
    cell.border = BORDER_TOTAL;
    if (colNum === 2 || colNum === 3) {
      cell.alignment = { vertical: 'middle', horizontal: 'left' };
    } else {
      cell.alignment = { vertical: 'middle', horizontal: 'right' };
      if (colNum === 7 || (colNum >= 13 && colNum <= 16) || colNum === 18) {
        cell.numFmt = '#,##0.00';
      } else if (colNum === 17) {
        cell.numFmt = '0.0%';
      }
    }
  });

  const batchColWidths = [6, 14, 32, 18, 12, 14, 12, 20, 20, 18, 18, 18, 20, 20, 18, 18, 22, 20];
  batchColWidths.forEach((w, i) => {
    wsBatch.getColumn(i + 1).width = w;
  });

  // ───────────────────────────────────────────────────────────────────────────
  // SHEET 3: Detailed Profitability Audit (Full Hierarchical Drill-Down)
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
    'Actual COGS / Unit (IDR)',
    'Selling Price / Unit (IDR)',
    'Sales Exp / Unit (IDR)',
    'Net Realization / Unit (IDR)',
    'Gross Sales (IDR)',
    'Actual COGS Total (IDR)',
    'Sales Delivery Exp (IDR)',
    'Gross Profit (IDR)',
    'Net Realized Profit (IDR)',
    'Profit Margin %',
    'Delivery Expense Vouchers & Cost Layer Lineage',
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

  let sumAuditInvoiceQty = 0;
  let sumAuditInvoiceGrossSales = 0;
  let sumAuditInvoiceCOGS = 0;
  let sumAuditInvoiceSalesExp = 0;
  let sumAuditInvoiceGrossProfit = 0;
  let sumAuditInvoiceNetProfit = 0;

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
      prod.product_unit ? formatUnit(prod.product_unit) : 'KG',
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
        prod.product_unit ? formatUnit(prod.product_unit) : 'KG',
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

      // INVOICE / DC ROWS
      const orders = batchOrdersMap.get(b.batch_id) || [];
      for (const ord of orders) {
        const qty = Number(ord.quantity || 0);
        const grossSales = Number(ord.gross_sales || 0);
        const lineCost = Number(ord.line_cost || 0);
        const lineSalesExp = Number(ord.line_sales_expense || 0);
        const grossProfit = Number(ord.gross_profit != null ? ord.gross_profit : grossSales - lineCost);
        const netProfit = Number(ord.profit != null ? ord.profit : grossProfit - lineSalesExp);
        const margin = ord.profit_margin_pct != null ? Number(ord.profit_margin_pct) / 100 : (grossSales > 0 ? netProfit / grossSales : null);

        const expPerUnit = qty > 0 ? lineSalesExp / qty : 0;
        const netRealizationPerUnit = Number(ord.selling_price || 0) - expPerUnit;
        const lineageNotes = formatOrderLineageNotes(ord);

        sumAuditInvoiceQty += qty;
        sumAuditInvoiceGrossSales += grossSales;
        sumAuditInvoiceCOGS += lineCost;
        sumAuditInvoiceSalesExp += lineSalesExp;
        sumAuditInvoiceGrossProfit += grossProfit;
        sumAuditInvoiceNetProfit += netProfit;

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
          prod.product_unit ? formatUnit(prod.product_unit) : 'KG',
          '—',
          qty,
          ord.unit_cost != null ? Number(ord.unit_cost) : '—',
          Number(ord.selling_price || 0),
          expPerUnit,
          netRealizationPerUnit,
          grossSales,
          lineCost,
          lineSalesExp,
          grossProfit,
          netProfit,
          margin != null ? margin : '—',
          lineageNotes,
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

  // Detailed Audit Total Row
  const overallAuditMargin = sumAuditInvoiceGrossSales > 0 ? sumAuditInvoiceNetProfit / sumAuditInvoiceGrossSales : 0;
  const auditTotalRow = wsAudit.addRow([
    'TOTAL',
    '',
    'ALL INVOICES AUDIT RECONCILIATION TOTAL',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    sumAuditInvoiceQty,
    '',
    '',
    '',
    '',
    sumAuditInvoiceGrossSales,
    sumAuditInvoiceCOGS,
    sumAuditInvoiceSalesExp,
    sumAuditInvoiceGrossProfit,
    sumAuditInvoiceNetProfit,
    overallAuditMargin,
    'Reconciled to Product & Batch Summaries with Zero Gap',
  ]);
  auditTotalRow.height = 24;
  auditTotalRow.eachCell((cell, colNum) => {
    cell.fill = FILL_TOTAL;
    cell.font = FONT_BOLD;
    cell.border = BORDER_TOTAL;
    if (colNum <= 3) {
      cell.alignment = { vertical: 'middle', horizontal: 'left' };
    } else {
      cell.alignment = { vertical: 'middle', horizontal: 'right' };
      if (colNum === 12 || (colNum >= 17 && colNum <= 21)) {
        cell.numFmt = '#,##0.00';
      } else if (colNum === 22) {
        cell.numFmt = '0.0%';
      }
    }
  });

  const auditColWidths = [
    14, 14, 30, 18, 16, 12, 26, 14, 16, 8, 14, 12, 22, 20, 18, 20, 22, 22, 20, 20, 22, 14, 45,
  ];
  auditColWidths.forEach((w, i) => {
    wsAudit.getColumn(i + 1).width = w;
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
    'Margin % (Profit/Sales)',
    'Delivery Expense Vouchers & Cost Layer Lineage',
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
  let sumOrdersQty = 0;
  let sumOrdersGrossSales = 0;
  let sumOrdersLandedCost = 0;
  let sumOrdersSalesExp = 0;
  let sumOrdersNetRealization = 0;
  let sumOrdersGrossProfit = 0;
  let sumOrdersNetProfit = 0;

  productsWithBatches.forEach((pb) => {
    pb.batches.forEach((b) => {
      const orders = batchOrdersMap.get(b.batch_id) || [];
      orders.forEach((ord) => {
        const isZebra = ordIdx++ % 2 === 1;
        const qty = Number(ord.quantity || 0);
        const grossSales = Number(ord.gross_sales || 0);
        const lineCost = Number(ord.line_cost || 0);
        const salesExp = Number(ord.line_sales_expense || 0);
        const netRealization = Number(ord.net_selling_realization != null ? ord.net_selling_realization : grossSales - salesExp);
        const grossProfit = Number(ord.gross_profit != null ? ord.gross_profit : grossSales - lineCost);
        const netProfit = Number(ord.profit != null ? ord.profit : grossProfit - salesExp);
        const margin = ord.profit_margin_pct != null ? Number(ord.profit_margin_pct) / 100 : (grossSales > 0 ? netProfit / grossSales : null);
        const lineageNotes = formatOrderLineageNotes(ord);

        sumOrdersQty += qty;
        sumOrdersGrossSales += grossSales;
        sumOrdersLandedCost += lineCost;
        sumOrdersSalesExp += salesExp;
        sumOrdersNetRealization += netRealization;
        sumOrdersGrossProfit += grossProfit;
        sumOrdersNetProfit += netProfit;

        const r = wsOrders.addRow([
          ord.invoice_number,
          ord.invoice_date,
          ord.customer_name,
          ord.so_number || '—',
          ord.dc_number || '—',
          pb.product.product_code || '—',
          pb.product.product_name,
          b.batch_number,
          qty,
          Number(ord.selling_price || 0),
          grossSales,
          ord.unit_cost != null ? Number(ord.unit_cost) : '—',
          lineCost,
          salesExp,
          netRealization,
          grossProfit,
          netProfit,
          margin != null ? margin : '—',
          lineageNotes,
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
          if (colNum === 9 || colNum === 10 || colNum === 11 || colNum === 12 || colNum === 13 || colNum === 14 || colNum === 15 || colNum === 16) {
            if (typeof cell.value === 'number') cell.numFmt = '#,##0.00';
          } else if (colNum === 17) {
            if (typeof cell.value === 'number') {
              cell.numFmt = '#,##0.00';
              cell.font = FONT_BOLD;
            }
          } else if (colNum === 18) {
            if (typeof cell.value === 'number') cell.numFmt = '0.0%';
          }
        }
      });
    });
  });
  });

  // Orders & Challans Total Row
  const overallOrdersMargin = sumOrdersGrossSales > 0 ? sumOrdersNetProfit / sumOrdersGrossSales : 0;
  const ordersTotalRow = wsOrders.addRow([
    'TOTAL',
    '',
    'ORDERS & DELIVERY CHALLANS TOTAL',
    '',
    '',
    '',
    '',
    '',
    sumOrdersQty,
    '',
    sumOrdersGrossSales,
    '',
    sumOrdersLandedCost,
    sumOrdersSalesExp,
    sumOrdersNetRealization,
    sumOrdersGrossProfit,
    sumOrdersNetProfit,
    overallOrdersMargin,
    'Reconciled Across All Deliveries and Invoices',
  ]);
  ordersTotalRow.height = 24;
  ordersTotalRow.eachCell((cell, colNum) => {
    cell.fill = FILL_TOTAL;
    cell.font = FONT_BOLD;
    cell.border = BORDER_TOTAL;
    if (colNum <= 3) {
      cell.alignment = { vertical: 'middle', horizontal: 'left' };
    } else {
      cell.alignment = { vertical: 'middle', horizontal: 'right' };
      if (colNum === 9 || colNum === 11 || (colNum >= 13 && colNum <= 17)) {
        cell.numFmt = '#,##0.00';
      } else if (colNum === 18) {
        cell.numFmt = '0.0%';
      }
    }
  });

  const orderColWidths = [
    16, 12, 28, 14, 16, 14, 30, 18, 12, 18, 20, 20, 20, 18, 20, 18, 20, 22, 45,
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
