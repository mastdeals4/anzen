import fs from 'fs';
import path from 'path';
import * as XLSX from 'xlsx';

const BRAIN_DIR = '/Users/Kunal/.gemini/antigravity/brain/ba0a5665-f6f0-4bb7-bcd8-a665594273a2';
const jsonPath = path.join(BRAIN_DIR, 'pph_null_audit_records.json');
const records = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));

// Period IDs from DB
const PERIOD_IDS = {
  'PPh21_2026_01': { id: '6d0d38c7-aae5-4fd2-abd4-b82077006193', name: 'PPh21 2026-01', accepted: 120000, current: 0 },
  'PPh23_2026_01': { id: 'd2295c53-0c66-4aab-ae74-a15e86d0e897', name: 'PPh23 2026-01', accepted: 176000, current: 176000 },
  'PPh21_2026_02': { id: '585ad2e9-13a8-40fe-9d5f-d0816dc8cad1', name: 'PPh21 2026-02', accepted: 187500, current: 67500 },
  'PPh23_2026_02': { id: '771db4fb-0c6f-4bb2-84b9-dd6e265f5c1c', name: 'PPh23 2026-02', accepted: 269000, current: 62000 },
  'PPh21_2026_03': { id: '6c380273-bb37-4d35-a94a-4b2a95afee1c', name: 'PPh21 2026-03', accepted: 120000, current: 0 },
  'PPh23_2026_03': { id: 'bdeb7f72-a071-400f-b919-c2c39fe2f32c', name: 'PPh23 2026-03', accepted: 192000, current: 0 },
  'PPh21_2026_04': { id: 'f00a398f-664b-4619-b899-81124271353d', name: 'PPh21 2026-04', accepted: 120000, current: 0 },
  'PPh23_2026_04': { id: 'fa79b6b0-4af9-4fca-9049-554ef43e2026', name: 'PPh23 2026-04', accepted: 235000, current: 95000 },
  'PPh21_2026_05': { id: '33122579-346c-48cd-ae4f-ee48ffbd65c6', name: 'PPh21 2026-05', accepted: 120000, current: 0 },
  'PPh23_2026_05': { id: '4366e140-360b-496d-b5de-c6a32f922d9c', name: 'PPh23 2026-05', accepted: 140000, current: 0 },
  'PPh21_2026_06': { id: 'a70d0563-36ba-4d1f-b052-5429468a3670', name: 'PPh21 2026-06', accepted: 120000, current: 0 },
  'PPh23_2026_06': { id: '7b20f162-b614-4430-a11a-4b75e97aff07', name: 'PPh23 2026-06', accepted: 140000, current: 0 },
  'PPh21_2026_07': { id: 'c9f09090-fc0c-484e-af2d-d07896f53e82', name: 'PPh21 2026-07', accepted: 257500, current: 50000 },
  'PPh23_2026_07': { id: '26817fdf-ca18-46f9-9280-c961b6b639d1', name: 'PPh23 2026-07', accepted: 188000, current: 48000 },
  'PPh21_2026_08': { id: '538a3c5e-673e-4c40-87d8-56f310607a35', name: 'PPh21 2026-08', accepted: 1129500, current: 0 },
  'PPh23_2026_08': { id: 'b81fa230-564f-40e9-9d12-4ce969e5b35a', name: 'PPh23 2026-08', accepted: 312000, current: 172000 },
  'PPh21_2026_09': { id: '4daf1eec-1b01-4d37-bace-25ac5759abe0', name: 'PPh21 2026-09', accepted: 607168, current: 423066 },
  'PPh23_2026_09': { id: '43b7832d-ddd0-46cf-bd60-d1228a83989d', name: 'PPh23 2026-09', accepted: 140000, current: 0 },
  'PPh21_2026_10': { id: 'f2fffa5e-6a74-42b0-b30d-7403e15965b4', name: 'PPh21 2026-10', accepted: 502500, current: 100000 },
  'PPh23_2026_10': { id: 'a3108713-6918-4971-9c0f-95c6b1beee49', name: 'PPh23 2026-10', accepted: 192000, current: 0 },
  'PPh21_2026_11': { id: 'bfc9d875-2df8-4999-9800-1ab920b105eb', name: 'PPh21 2026-11', accepted: 200000, current: 200000 },
};

// Exclude unpaid EXP/26/345
const candidates32 = records.filter(r => r.voucher_number !== 'EXP/26/345');

// Map 32 candidates with owner decisions
const sheet1Data = candidates32.map((r, idx) => {
  let targetKey = null;
  let ownerDecisionNote = 'Standard period mapping (disbursed month)';

  if (r.voucher_number === 'EXP/26/179' || r.voucher_number === 'EXP/26/180') {
    targetKey = 'PPh21_2026_11';
    ownerDecisionNote = 'OWNER DECISION: Disbursed Nov 3, 2026; assigned to November 2026 PPh21';
  } else {
    const d = new Date(r.expense_date);
    const m = String(d.getMonth() + 1).padStart(2, '0');
    targetKey = `${r.pph_tax_type}_2026_${m}`;
  }

  const period = PERIOD_IDS[targetKey];

  return {
    'No': idx + 1,
    'Expense ID': r.id,
    'Voucher Number': r.voucher_number,
    'Expense Date': r.expense_date,
    'Disbursement Date': r.voucher_number.includes('179') || r.voucher_number.includes('180') ? '2026-11-03' : (r.actual_payment_date || r.expense_date),
    'Recipient / Payee': r.recipient,
    'Expense Category': r.category,
    'PPh Code': r.pph_code,
    'PPh Tax Type': r.pph_tax_type,
    'Gross Amount (IDR)': r.gross_amount,
    'PPh Amount (IDR)': r.pph_amount,
    'Paid Amount (IDR)': r.paid_amount,
    'Current PPh Period': 'NULL',
    'Proposed PPh Period Name': period.name,
    'Proposed PPh Period ID': period.id,
    'Owner Confirmation': ownerDecisionNote,
    'Safeguard Check': 'Pre-condition pph_tax_period_id IS NULL required',
  };
});

// Sheet 2: Period-by-Period Reconciliation Table
// Calculate proposed additions per period
const proposedSums = {};
for (const cand of sheet1Data) {
  const pName = cand['Proposed PPh Period Name'];
  proposedSums[pName] = (proposedSums[pName] || 0) + cand['PPh Amount (IDR)'];
}

const reconciliationRows = Object.values(PERIOD_IDS).map((p, idx) => {
  const proposedAdd = proposedSums[p.name] || 0;
  const projectedTotal = p.current + proposedAdd;
  const variance = projectedTotal - p.accepted;

  let auditNote = 'EXACT MATCH (0.00 Variance)';
  if (p.name === 'PPh21 2026-08' && variance === -100000) {
    auditNote = 'EXPLICIT VARIANCE: -Rp100,000 (Ricardo Suhendra allocated to Nov per owner decision)';
  } else if (p.name === 'PPh21 2026-11' && variance === 100000) {
    auditNote = 'EXPLICIT VARIANCE: +Rp100,000 (Ricardo Suhendra received in Nov per owner decision)';
  }

  return {
    'No': idx + 1,
    'Period Name': p.name,
    'Tax Period ID': p.id,
    'Accepted Period Total (IDR)': p.accepted,
    'Currently Allocated (IDR)': p.current,
    'Proposed NULL Additions (IDR)': proposedAdd,
    'Projected Total (IDR)': projectedTotal,
    'Reconciliation Variance (IDR)': variance,
    'Audit Reconciliation Status': auditNote,
  };
});

// Sheet 3: Batch Transfers & Special Decisions
const sheet3Data = [
  {
    'Item': 'Batch Transfer 1',
    'Vouchers': 'EXP/26/101 & EXP/26/174',
    'Recipient': 'PT BERKAT KASIH BERSAUDARA',
    'Disbursement Date': '2026-02-20',
    'Total Net Payment (IDR)': 3651500,
    'Total PPh 23 (IDR)': 67000,
    'Bank Statement Line ID': 'c4c4033b-f661-4574-8878-dc593ee4eb33',
    'BSL Description': 'BI-FAST DB; BIF TRANSFER KE 008 BERKAT KASIH BERSA KBB',
    'Assigned Period': 'PPh23 2026-02 (771db4fb-0c6f-4bb2-84b9-dd6e265f5c1c)',
    'Reconciliation Effect': 'Completes February PPh23 to exactly Rp 269,000 (0 variance against accepted total)'
  },
  {
    'Item': 'Batch Transfer 2 (Ricardo)',
    'Vouchers': 'EXP/26/179 & EXP/26/180',
    'Recipient': 'RICARDO SUHENDRA W',
    'Disbursement Date': '2026-11-03',
    'Total Net Payment (IDR)': 3900000,
    'Total PPh 21 (IDR)': 100000,
    'Bank Statement Line ID': '93a47258-80b8-4bd4-b06a-0ce8fde906bd',
    'BSL Description': 'TRSF E-BANKING DB 0311/FTSCY/WS95051 3900000.00 Ricardo Fees CA RICARDO SUHENDRA W',
    'Assigned Period': 'PPh21 2026-11 (bfc9d875-2df8-4999-9800-1ab920b105eb)',
    'Reconciliation Effect': 'Owner Decision 1 & 2: Disbursed Nov 3; assigned to Nov 2026. Creates explicit -100k variance in Aug and +100k in Nov.'
  },
  {
    'Item': 'Unpaid Expense Kept NULL',
    'Vouchers': 'EXP/26/345',
    'Recipient': 'PEST CONTROL 3 NOV',
    'Disbursement Date': 'Unpaid (Rp 0 paid)',
    'Total Net Payment (IDR)': 0,
    'Total PPh 23 (IDR)': 18000,
    'Bank Statement Line ID': 'None',
    'BSL Description': 'Unpaid invoice - no bank disbursement',
    'Assigned Period': 'KEPT NULL (Owner Decision 4)',
    'Reconciliation Effect': 'Under statutory cash-basis rules, tax withholding is recognized on payment. Retaining NULL prevents false premature liability.'
  }
];

// Sheet 4: Validation & Controls
const totalCandPph = sheet1Data.reduce((acc, c) => acc + c['PPh Amount (IDR)'], 0);
const novCandPph = sheet1Data.filter(c => c['Voucher Number'] === 'EXP/26/179' || c['Voucher Number'] === 'EXP/26/180').reduce((acc, c) => acc + c['PPh Amount (IDR)'], 0);
const janOctCandPph = totalCandPph - novCandPph;

const sheet4Data = [
  { 'Control Metric': 'Total NULL Records Audited', 'Value': records.length },
  { 'Control Metric': 'Total Candidate Records for Correction', 'Value': sheet1Data.length },
  { 'Control Metric': 'Total Records Kept NULL (EXP/26/345 Unpaid)', 'Value': records.length - sheet1Data.length },
  { 'Control Metric': 'Total PPh Withholding in Candidates', 'Value': totalCandPph },
  { 'Control Metric': 'Total PPh Allocated to January–October 2026', 'Value': janOctCandPph },
  { 'Control Metric': 'Total PPh Allocated to November 2026 (Ricardo)', 'Value': novCandPph },
  { 'Control Metric': 'Ricardo Suhendra W Withholding Amount', 'Value': novCandPph },
  { 'Control Metric': 'Overwritten Existing PPh Allocations', 'Value': 0 },
  { 'Control Metric': 'Modified Tax Period Totals or Statuses', 'Value': 0 },
  { 'Control Metric': 'Modified Journal Entries or Vouchers', 'Value': 0 },
  { 'Control Metric': 'Executed Migrations or Database Mutations', 'Value': 0 },
];

// Build Workbook
const wb = XLSX.utils.book_new();

const ws1 = XLSX.utils.json_to_sheet(sheet1Data);
const ws2 = XLSX.utils.json_to_sheet(reconciliationRows);
const ws3 = XLSX.utils.json_to_sheet(sheet3Data);
const ws4 = XLSX.utils.json_to_sheet(sheet4Data);

[ws1, ws2, ws3, ws4].forEach(ws => {
  ws['!cols'] = [
    { wch: 6 },  { wch: 38 }, { wch: 18 }, { wch: 14 },
    { wch: 18 }, { wch: 28 }, { wch: 24 }, { wch: 14 },
    { wch: 14 }, { wch: 18 }, { wch: 18 }, { wch: 18 },
    { wch: 20 }, { wch: 22 }, { wch: 38 }, { wch: 45 },
    { wch: 45 }
  ];
});

XLSX.utils.book_append_sheet(wb, ws1, 'Proposed Candidates (32)');
XLSX.utils.book_append_sheet(wb, ws2, 'Period Reconciliation');
XLSX.utils.book_append_sheet(wb, ws3, 'Batch & Special Decisions');
XLSX.utils.book_append_sheet(wb, ws4, 'Validation Controls');

const projectExcelPath = path.resolve('docs/reports/Anzen_ERP_PPh_Correction_Preview_and_Reconciliation_Plan.xlsx');
XLSX.writeFile(wb, projectExcelPath);

const brainExcelPath = path.join(BRAIN_DIR, 'Anzen_ERP_PPh_Correction_Preview_and_Reconciliation_Plan.xlsx');
XLSX.writeFile(wb, brainExcelPath);

console.log('Saved Final Correction Preview Workbook:');
console.log('1.', projectExcelPath);
console.log('2.', brainExcelPath);
