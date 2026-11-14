import fs from 'fs';
import path from 'path';
import * as XLSX from 'xlsx';

const BRAIN_DIR = '/Users/Kunal/.gemini/antigravity/brain/ba0a5665-f6f0-4bb7-bcd8-a665594273a2';
const jsonPath = path.join(BRAIN_DIR, 'pph_null_audit_records.json');
const records = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));

// Format currency
const fmt = (n) => Number(n || 0);

// Sheet 1: NULL PPh Periods
const sheet1Data = records.map((r, idx) => ({
  'No': idx + 1,
  'Voucher Number': r.voucher_number,
  'Expense Date': r.expense_date,
  'Expense Category': r.category,
  'Recipient / Staff / Payee': r.recipient,
  'Recipient Type': r.recipient_type,
  'PPh Code': r.pph_code,
  'PPh Tax Type': r.pph_tax_type,
  'Gross Amount (IDR)': fmt(r.gross_amount),
  'DPP Amount (IDR)': fmt(r.dpp_amount),
  'PPh Rate (%)': r.pph_rate,
  'PPh Amount (IDR)': fmt(r.pph_amount),
  'Net Payable (IDR)': fmt(r.canonical_payable),
  'Paid Amount (IDR)': fmt(r.paid_amount),
  'Payment Status': r.payment_status.toUpperCase(),
  'Actual Payment Date': r.actual_payment_date || '—',
  'General Tax Period (tax_period_id)': r.gen_period_name,
  'Approval Status': r.approval_status,
  'Posting State': r.posting_state,
  'Journal Entry': r.journal_number,
  'Audit Classification': r.classification,
  'Audit Reason': r.classification_reason,
}));

// Sheet 2: Payment Evidence
const sheet2Data = records.map((r, idx) => {
  let evidenceDetail = r.payment_references;
  // Enrich for the consolidated transfers discovered
  if (r.voucher_number === 'EXP/26/101' || r.voucher_number === 'EXP/26/174') {
    evidenceDetail = 'Bank Transfer BSL: 2026-02-20 Rp3,651,500 (combined EXP/26/101 + EXP/26/174 to PT BERKAT KASIH BERSAUDARA)';
  } else if (r.voucher_number === 'EXP/26/179' || r.voucher_number === 'EXP/26/180') {
    evidenceDetail = 'Bank Transfer BSL: 2026-11-03 Rp3,900,000 (combined EXP/26/179 + EXP/26/180 to RICARDO SUHENDRA W)';
  }

  let actualPayDate = r.actual_payment_date;
  if (r.voucher_number === 'EXP/26/101' || r.voucher_number === 'EXP/26/174') actualPayDate = '2026-02-20';
  if (r.voucher_number === 'EXP/26/179' || r.voucher_number === 'EXP/26/180') actualPayDate = '2026-11-03';

  return {
    'No': idx + 1,
    'Voucher Number': r.voucher_number,
    'Recipient / Payee': r.recipient,
    'Expense Date': r.expense_date,
    'Gross Amount (IDR)': fmt(r.gross_amount),
    'PPh Amount (IDR)': fmt(r.pph_amount),
    'Paid Amount (IDR)': fmt(r.paid_amount),
    'Payment Method': r.payment_method,
    'Actual Payment Date': actualPayDate || 'Unpaid',
    'Evidence Type': r.payment_evidence_type,
    'Payment Reference Details': evidenceDetail,
    'Supported PPh Period': r.supported_period || 'None / Not Applicable (Unpaid)',
    'Requires PPh Period?': r.requires_pph_period ? 'YES (Disbursed)' : 'NO (Unpaid - Accrual only)',
  };
});

// Sheet 3: Exceptions
const exceptions = [
  {
    'Voucher Number': 'EXP/26/345',
    'Category / Recipient': 'facility_maintenance / PEST CONTROL 3 NOV',
    'Expense Date': '2026-11-03',
    'Gross (IDR)': 900000,
    'PPh (IDR)': 18000,
    'Paid (IDR)': 0,
    'Exception Type': 'Unpaid Expense (Withholding Not Yet Due)',
    'Root Cause & Details': 'Expense is approved but completely unpaid (Rp 0 paid). Under Indonesian tax law (cash basis withholding for PPh 23), withholding is recognized only upon payment disbursement. Does NOT require a historical PPh period.',
    'Recommended Action': 'Keep pph_tax_period_id as NULL until payment voucher or bank transfer is executed in November/December 2026.'
  },
  {
    'Voucher Number': 'EXP/26/101 & EXP/26/174',
    'Category / Recipient': 'facility_maintenance / PT BERKAT KASIH BERSAUDARA',
    'Expense Date': '2026-02-11',
    'Gross (IDR)': 3350000,
    'PPh (IDR)': 67000,
    'Paid (IDR)': 3651500,
    'Exception Type': 'Batch Bank Transfer (Unlinked BSL)',
    'Root Cause & Details': 'Both expenses were paid in a single consolidated BI-FAST bank transfer on 2026-02-20 of Rp 3,651,500. The BSL has matched_expense_id as NULL because it was a 2-to-1 batch disbursement.',
    'Recommended Action': 'Supports PPh23 February 2026 (tax_period_id: 771db4fb-0c6f-4bb2-84b9-dd6e265f5c1c). Link to BSL via voucher allocations.'
  },
  {
    'Voucher Number': 'EXP/26/179 & EXP/26/180',
    'Category / Recipient': 'non_permanent_employee_fee / Ricardo Suhendra W',
    'Expense Date': '2026-08-13',
    'Gross (IDR)': 4000000,
    'PPh (IDR)': 100000,
    'Paid (IDR)': 3900000,
    'Exception Type': 'Cross-Period Payment (Disbursed in November for August Work)',
    'Root Cause & Details': 'Services performed in July/August 2026. However, bank transfer of Rp 3,900,000 was executed on 2026-11-03 (November 2026). Under cash basis withholding, PPh 21 non-employee withholding is statutory in November 2026, NOT August 2026.',
    'Recommended Action': 'Supports PPh21 November 2026 (tax_period_id: bfc9d875-2df8-4999-9800-1ab920b105eb). Do NOT backdate into August 2026.'
  },
  {
    'Voucher Number': 'EXP/26/286',
    'Category / Recipient': 'professional_services / PT Harsonu',
    'Expense Date': '2026-09-30',
    'Gross (IDR)': 7000000,
    'PPh (IDR)': 140000,
    'Paid (IDR)': 6860000,
    'Exception Type': 'DPP Field Metadata Inconsistency',
    'Root Cause & Details': 'Stored pph_amount is Rp 140,000 (which is 2% of Gross Rp 7,000,000), but dpp_amount was recorded as Rp 3,500,000 (50% ratio). PPh amount is correct for standard corporate services PPh 23.',
    'Recommended Action': 'No change to PPh amount needed; update DPP metadata to Rp 7,000,000 during future cleanup.'
  },
  {
    'Voucher Number': 'EXP/26/363',
    'Category / Recipient': 'salary / Staff Salary',
    'Expense Date': '2026-10-30',
    'Gross (IDR)': 8500000,
    'PPh (IDR)': 170000,
    'Paid (IDR)': 8330000,
    'Exception Type': 'General Tax Period Month Boundary',
    'Root Cause & Details': 'Expense date is 2026-10-30, but general tax_period_id was assigned PPN 2026-11 instead of October 2026.',
    'Recommended Action': 'Supported PPh period is PPh21 October 2026 (tax_period_id: f2fffa5e-6a74-42b0-b30d-7403e15965b4).'
  },
  {
    'Voucher Number': 'All 33 NULL Records',
    'Category / Recipient': 'Global System Finding',
    'Expense Date': '2026-01-30 to 2026-11-03',
    'Gross (IDR)': 147550000,
    'PPh (IDR)': 3226102,
    'Paid (IDR)': 143424100,
    'Exception Type': 'PPN Period Stored in tax_period_id Column',
    'Root Cause & Details': 'Every single one of the 33 NULL expenses has general tax_period_id assigned to a PPN (VAT) period (e.g. PPN 2026-01 through 2026-11). The expense save/import handler historically assigned PPN tax_period_id but left pph_tax_period_id NULL.',
    'Recommended Action': 'Implement explicit pph_tax_period_id resolution during expense creation and payment disbursement.'
  }
];

// Sheet 4: Summary
// 1. By Classification
const classSummary = {};
// 2. By PPh Code
const pphSummary = {};
// 3. By Supported Tax Period
const periodSummary = {};

let totalGross = 0;
let totalPph = 0;
let totalPaid = 0;

for (const r of records) {
  totalGross += r.gross_amount;
  totalPph += r.pph_amount;
  totalPaid += r.paid_amount;

  // By class
  if (!classSummary[r.classification]) {
    classSummary[r.classification] = { count: 0, gross: 0, pph: 0, paid: 0 };
  }
  classSummary[r.classification].count++;
  classSummary[r.classification].gross += r.gross_amount;
  classSummary[r.classification].pph += r.pph_amount;
  classSummary[r.classification].paid += r.paid_amount;

  // By pph code
  const pphKey = `${r.pph_code} (${r.pph_tax_type})`;
  if (!pphSummary[pphKey]) {
    pphSummary[pphKey] = { count: 0, gross: 0, pph: 0, paid: 0 };
  }
  pphSummary[pphKey].count++;
  pphSummary[pphKey].gross += r.gross_amount;
  pphSummary[pphKey].pph += r.pph_amount;
  pphSummary[pphKey].paid += r.paid_amount;

  // By supported period
  const periodKey = r.supported_period ? r.supported_period.split(' (ID:')[0] : 'Unpaid / None';
  if (!periodSummary[periodKey]) {
    periodSummary[periodKey] = { count: 0, gross: 0, pph: 0, paid: 0 };
  }
  periodSummary[periodKey].count++;
  periodSummary[periodKey].gross += r.gross_amount;
  periodSummary[periodKey].pph += r.pph_amount;
  periodSummary[periodKey].paid += r.paid_amount;
}

const summaryData1 = Object.entries(classSummary).map(([cls, data]) => ({
  'Audit Classification': cls,
  'Record Count': data.count,
  'Gross Amount (IDR)': data.gross,
  'PPh Withholding (IDR)': data.pph,
  'Disbursed Amount (IDR)': data.paid,
  '% of Total PPh': ((data.pph / totalPph) * 100).toFixed(2) + '%'
}));

const summaryData2 = Object.entries(pphSummary).map(([code, data]) => ({
  'PPh Tax Regime / Code': code,
  'Record Count': data.count,
  'Gross Amount (IDR)': data.gross,
  'PPh Withholding (IDR)': data.pph,
  'Disbursed Amount (IDR)': data.paid,
  '% of Total PPh': ((data.pph / totalPph) * 100).toFixed(2) + '%'
}));

const summaryData3 = Object.entries(periodSummary).map(([period, data]) => ({
  'Supported Tax Period': period,
  'Record Count': data.count,
  'Gross Amount (IDR)': data.gross,
  'PPh Withholding (IDR)': data.pph,
  'Disbursed Amount (IDR)': data.paid
}));

// Build Workbook
const wb = XLSX.utils.book_new();

const ws1 = XLSX.utils.json_to_sheet(sheet1Data);
const ws2 = XLSX.utils.json_to_sheet(sheet2Data);
const ws3 = XLSX.utils.json_to_sheet(exceptions);

// Combine summary tables into Sheet 4
const ws4 = XLSX.utils.json_to_sheet([
  { 'Report Metric': 'Total Records Audited', 'Value': records.length },
  { 'Report Metric': 'Total Gross Expense Amount', 'Value': totalGross },
  { 'Report Metric': 'Total Unallocated PPh Withholding', 'Value': totalPph },
  { 'Report Metric': 'Total Disbursed Cash', 'Value': totalPaid },
]);
XLSX.utils.sheet_add_json(ws4, [{ '': '' }, { '': '=== SUMMARY BY AUDIT CLASSIFICATION ===' }], { origin: -1, skipHeader: true });
XLSX.utils.sheet_add_json(ws4, summaryData1, { origin: -1 });
XLSX.utils.sheet_add_json(ws4, [{ '': '' }, { '': '=== SUMMARY BY PPH CODE & TAX REGIME ===' }], { origin: -1, skipHeader: true });
XLSX.utils.sheet_add_json(ws4, summaryData2, { origin: -1 });
XLSX.utils.sheet_add_json(ws4, [{ '': '' }, { '': '=== SUMMARY BY SUPPORTED TAX PERIOD ===' }], { origin: -1, skipHeader: true });
XLSX.utils.sheet_add_json(ws4, summaryData3, { origin: -1 });

// Adjust column widths
[ws1, ws2, ws3, ws4].forEach(ws => {
  ws['!cols'] = [
    { wch: 6 },  { wch: 18 }, { wch: 14 }, { wch: 25 },
    { wch: 30 }, { wch: 16 }, { wch: 14 }, { wch: 14 },
    { wch: 18 }, { wch: 18 }, { wch: 14 }, { wch: 18 },
    { wch: 18 }, { wch: 18 }, { wch: 16 }, { wch: 20 },
    { wch: 25 }, { wch: 16 }, { wch: 16 }, { wch: 16 },
    { wch: 30 }, { wch: 45 }
  ];
});

XLSX.utils.book_append_sheet(wb, ws1, 'NULL PPh Periods');
XLSX.utils.book_append_sheet(wb, ws2, 'Payment Evidence');
XLSX.utils.book_append_sheet(wb, ws3, 'Exceptions');
XLSX.utils.book_append_sheet(wb, ws4, 'Summary');

// Save files
const brainExcelPath = path.join(BRAIN_DIR, 'Anzen_ERP_PPh_NULL_Period_Audit_and_Reconciliation.xlsx');
XLSX.writeFile(wb, brainExcelPath);

const projectReportDir = path.resolve('docs/reports');
if (!fs.existsSync(projectReportDir)) fs.mkdirSync(projectReportDir, { recursive: true });
const projectExcelPath = path.join(projectReportDir, 'Anzen_ERP_PPh_NULL_Period_Audit_and_Reconciliation.xlsx');
XLSX.writeFile(wb, projectExcelPath);

console.log('Successfully generated Excel report at:');
console.log('1.', brainExcelPath);
console.log('2.', projectExcelPath);

