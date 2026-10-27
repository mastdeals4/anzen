import fs from 'fs';

const rows = JSON.parse(fs.readFileSync('/tmp/final_transaction_report.json', 'utf8'));

let md = `# INVENTORY VALUATION FORENSIC AUDIT & DECISION REPORT
**Follow-up to Forensic Audit | Date: 21 September 2026**

---

## EXECUTIVE SUMMARY & AUDIT POSITION

- **FIFO Ending Inventory Valuation**: \`Rp 2,227,083,468.30\`
- **GL 1130 Net Inventory Asset**: \`Rp 2,154,121,959.50\`
- **Proven Net Discrepancy**: \`Rp 72,961,508.80\`
- **Historical COGS Alignment**: **100% IDENTICAL** (FIFO COGS = GL COGS).
- **Core Finding**: The discrepancy is **100% confined to the Inventory-Additions / Capitalization basis**. Historical sales depletion, quantities, and COGS formulas are perfectly synchronized.

\`\`\`
                                  THE VARIANCE DECOMPOSITION
+ Landed Costs in Cost Layers (Costing Engine)        : Rp  184,612,416.80
- Landed Costs Capitalized in GL 1130 (Accounting)    : Rp  111,650,902.00
- Purchase Invoice IDR Rounding Difference            : Rp            6.00
--------------------------------------------------------------------------
= EXACT UNRECONCILED VARIANCE                         : Rp   72,961,508.80
\`\`\`

---

## 1. INVESTIGATION OF LANDED-COST CLASSIFICATION

The costing engine calculates container landed cost using:
\`\`\`sql
AND COALESCE(fe.include_in_landed_cost, true) = true
\`\`\`

### A. Breakdown of the Costing Pool (\`Rp 184,613,296.00\`)
1. **Explicit \`TRUE\` (\`Rp 53,296,239.00\`)**: 7 vouchers where the toggle was set to \`true\`.
   - \`Rp 15,723,502.00\` capitalized in GL 1130 (\`EXP/26/177\` broker clearance).
   - \`Rp 37,572,737.00\` expensed in GL 5300 (\`EXP/26/102\`, \`EXP/26/103\`, \`EXP/26/178\`, \`EXP/25/292\`, \`EXP/26/196\`, \`EXP/26/197\`).
2. **NULL Defaulted to \`TRUE\` (\`Rp 120,263,153.00\`)**: 14 vouchers where \`include_in_landed_cost IS NULL\` was silently defaulted to \`true\`.
   - \`Rp 10,100,400.00\` capitalized in GL 1130 (\`EXP/26-26/050\` DO charges).
   - \`Rp 106,812,753.00\` expensed in GL 5300 (Freight & Forwarding).
   - \`Rp 3,350,000.00\` expensed in GL 6900 (Coolie Unloading).
3. **Container Header \`other_import_costs\` (\`Rp 10,063,904.00\`)**: 3 legacy container header estimates with **no vouchers or GL entries**.
4. **Petty Cash Transactions (\`Rp 990,000.00\`)**: 3 petty cash vouchers with \`include_in_landed_cost IS NULL\` defaulted to \`true\`.

### B. Analysis of NULL Records
- **Genuinely intended as Landed Cost (\`Rp 115,813,153.00\`)**:
  All 7 third-party forwarding and clearing invoices (\`EXP/25/288\`, \`EXP/26-26/113\`, \`EXP/26-26/115\`, \`EXP/26-26/050\`, \`EXP/26-26/139\`, \`EXP/26/202\`, \`EXP/26/205\`) are directly attributable to bringing goods to the warehouse under **PSAK 14 / IAS 2**. One was already capitalized into GL 1130 by the accountant (\`EXP/26-26/050\`).
- **Ordinary Operating Expenses / Period Costs (\`Rp 4,450,000.00\` + \`Rp 990,000.00\` petty cash)**:
  Coolie unloading labor (\`kuli\`) was consistently expensed to GL 6900/5300 by bookkeeping. SME accounting practices typically treat casual dock/warehouse day labor as period operating expenses.
- **Ambiguity**:
  The divergence between GL 5300 (Freight In expense) and FIFO inventory capitalization for freight/clearance requires owner/accountant policy alignment.
- **Implementation Defect**:
  Defaulting \`NULL\` to \`true\` in the costing engine while posting to P&L accounts (5300/6900) in GL created an automatic balance sheet mismatch.

---

## 2. INVESTIGATION OF CATEGORY MISMATCH: \`customs_duty_bm\` vs \`pib_import\`

- **The Function**: \`is_capitalizable_landed_cost_category(p_category)\` only whitelists:
  \`'duty_customs', 'duty', 'duty_import', 'freight_import', 'freight', 'clearing_forwarding', 'container_handling', 'loading_import', 'port_charges', 'transport_import', 'import_broker', 'other_import'\`.
- **The Defect**:
  1. All 10 PIB vouchers in \`finance_expenses\` use category \`'pib_import'\`.
  2. \`'pib_import'\` is missing from the whitelist.
  3. The costing engine sums \`fe.amount\`, failing to parse the tax breakdown fields (\`pib_bm_amount\`, \`pib_ppn_amount\`, \`pib_pph_amount\`).
- **The Accounting Reality**:
  The GL posting trigger (\`repair_auto_post_expense_payment_resolution.sql\`) successfully parsed \`pib_bm_amount\` and capitalized **\`Rp 85,827,000.00\`** into **GL 1130** across 4 containers (\`EXP/25/234\`, \`EXP/26/077\`, \`EXP/26/221\`, \`EXP/26-26/141\`).
- **Conclusion**:
  This is a **Confirmed Software Bug** in the costing engine. The GL handled duty capitalization correctly, but the costing engine omitted Bea Masuk completely.

---

## 3. THE CLEAN VALUATION BRIDGE

| Cost Component | Transaction Amount | FIFO Cost Layers | GL 1130 (Inventory Asset) | GL 5300 / 6900 (P&L Expense) | Net Variance (FIFO vs GL 1130) |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Purchase Invoices (CIF Goods Cost)** | Rp 2,042,471,051.50 | Rp 2,042,471,051.50 | Rp 2,042,471,057.50 | Rp 0.00 | **-Rp 6.00** (Rounding) |
| **Customs Duty (Bea Masuk / PIB)** | Rp 85,827,000.00 | **Rp 0.00 (Bug - Omitted)** | **Rp 85,827,000.00** | Rp 0.00 | **-Rp 85,827,000.00** |
| **Synchronized Broker Clearance** | Rp 25,823,902.00 | Rp 25,823,902.00 | Rp 25,823,902.00 | Rp 0.00 | **Rp 0.00** |
| **Freight & Forwarding in GL 5300** | Rp 122,205,653.00 | **Rp 122,205,653.00 (Included)** | **Rp 0.00 (Expensed)** | Rp 122,205,653.00 | **+Rp 122,205,653.00** |
| **Coolie Unloading in GL 6900/5300** | Rp 5,530,000.00 | **Rp 5,530,000.00 (Included)** | **Rp 0.00 (Expensed)** | Rp 5,530,000.00 | **+Rp 5,530,000.00** |
| **Petty Cash Unloading & Handling** | Rp 990,000.00 | **Rp 990,000.00 (Included)** | **Rp 0.00 (Expensed)** | Rp 990,000.00 | **+Rp 990,000.00** |
| **Container Header Estimates** | Rp 10,063,904.00 | **Rp 10,063,904.00 (Included)** | **Rp 0.00 (No voucher)** | Rp 0.00 | **+Rp 10,063,904.00** |
| *Allocation Rounding Delta* | -Rp 879.20 | -Rp 879.20 | Rp 0.00 | Rp 0.00 | **-Rp 879.20** |
| **TOTALS** | **Rp 2,292,910,631.30** | **Rp 2,227,083,468.30** | **Rp 2,154,121,959.50** | **Rp 128,725,653.00** | **+Rp 72,961,508.80** |

---

## 4. INVESTIGATION OF HEADER \`other_import_costs\` (\`Rp 10,063,904.00\`)

| Container Ref | Header Amount | Created Date | Accounting Voucher Found? | Real Origin / Evidence |
| :--- | :--- | :--- | :--- | :--- |
| **1st  Air Shipment** | Rp 2,443,001.00 | 2026-01-06 | None | Manual estimate superseded by \`EXP/26/102\` broker invoice. Stale unbacked header field. |
| **1st 20MT FCL NOV 25** | Rp 6,659,943.00 | 2025-12-26 | None | Preliminary port charge plug. Final clearance entered under \`EXP/25/288\`. Stale unbacked header field. |
| **2nd Air shipment** | Rp 960,960.00 | 2026-02-11 | None | Preliminary estimate. Actual settlement entered under \`EXP/26/103\`. Stale unbacked header field. |

- **Verdict**: All 3 header amounts are **stale pre-accounting estimates**. They do not correspond to any active payable, unpaid invoice, or bank debit.

---

## 5. DUTY AND TAX SEGREGATION AUDIT

- **Customs Duty (Bea Masuk)**: \`Rp 85,827,000.00\` (4 PIB vouchers). Fully capitalizable into inventory cost under PSAK 14 / IAS 2.
- **Recoverable Input VAT (PPN Masukan / Account 1150)**: \`Rp 535,082,109.00\` (10 containers). Correctly segregated as a tax asset; properly excluded from FIFO layers.
- **Advance Corporate Tax (PPh 22 Import / Account 1155)**: \`Rp 157,678,672.00\` (10 containers). Correctly segregated as a prepaid tax asset; properly excluded from FIFO layers.
- **Freight & Brokerage**: \`Rp 122,205,653.00\` in GL 5300.
- **Port & Loading**: \`Rp 6,520,000.00\` in GL 6900/5300 (including petty cash).

---

## 6. TRANSACTION-LEVEL CLASSIFICATION REPORT (ALL 81 TRANSACTIONS)

| Voucher | Date | Supplier / Payee | Container | Category | Amount (IDR) | GL Acct | In FIFO? | Current Treatment | Proposed Classification | System Change? | Owner Decision? |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
`;

for (const r of rows) {
  const gl = r.gl_accounts || '-';
  const inFifo = r.included_in_fifo ? 'YES' : 'NO';
  const amt = Number(r.amount).toLocaleString('id-ID');
  md += `| ${r.voucher} | ${r.date} | ${r.supplier.replace(/\|/g, '-')} | ${r.container.replace(/\|/g, '-')} | ${r.category} | ${amt} | ${gl} | ${inFifo} | ${r.current_treatment.replace(/\|/g, '-')} | ${r.proposed_classification.replace(/\|/g, '-')} | ${r.system_change_required.replace(/\|/g, '-')} | ${r.owner_decision_required.replace(/\|/g, '-')} |\n`;
}

md += `
---

## 7. FINAL CONCLUSIONS & REQUIRED ACTIONS

### A. CONFIRMED SOFTWARE BUGS
1. **Omission of Customs Duty (\`pib_bm_amount\`) from Costing Pool**:
   - **Amount**: \`Rp 85,827,000.00\` across 4 containers (\`1st 20MT FCL NOV 25\`, \`2nd FCL 20MT - FEB26\`, \`E0000085/2627 - Jul26 MIx\`, \`E0000120/2627 - Jul26 Everest Corn Starch\`).
   - **Mechanism**: \`calculate_container_landed_cost_pool\` failed to recognize \`pib_import\` and lacked extraction for \`pib_bm_amount\`.
2. **Inclusion of Unbacked Header Estimates**:
   - **Amount**: \`Rp 10,063,904.00\` across 3 legacy containers (\`1st Air Shipment\`: 2.44M, \`1st 20MT FCL NOV 25\`: 6.66M, \`2nd Air shipment\`: 0.96M).
   - **Mechanism**: Header field \`other_import_costs\` added directly without voucher verification.
3. **Unsafe \`COALESCE(include_in_landed_cost, true)\` Default**:
   - **Amount**: \`Rp 120,263,153.00\` in expenses + \`Rp 990,000.00\` in petty cash.
   - **Mechanism**: Forced P&L expenses into FIFO inventory layers whenever the toggle was NULL.

### B. CONFIRMED ACCOUNTING TREATMENT
1. **Customs Duty Capitalization**: \`Rp 85,827,000.00\` in GL 1130 is 100% legally and standardly compliant with PSAK 14 / IAS 2.
2. **Tax Segregation**: \`Rp 535,082,109.00\` of PPN (1150) and \`Rp 157,678,672.00\` of PPh 22 (1155) are correctly segregated.
3. **Synchronized Broker Charges**: \`Rp 25,823,902.00\` (\`EXP/26-26/050\` and \`EXP/26/177\`) is capitalized in both GL 1130 and FIFO layers.

### C. ITEMS REQUIRING OWNER / ACCOUNTANT POLICY DECISION
1. **Capitalization Policy for Freight & Forwarding Clearance (\`Rp 122,205,653.00\`)**:
   - *Option 1 (Full Capitalization / PSAK 14 benchmark)*: Reclassify GL 5300 to GL 1130 so GL matches FIFO costing.
   - *Option 2 (Period Expensing / Historical Bookkeeping)*: Keep GL 5300 as P&L expense and exclude freight/brokerage from FIFO cost layers.
2. **Handling & Unloading Coolie Wages (\`Rp 5,530,000.00\` expenses + \`Rp 990,000.00\` petty cash)**:
   - Decide whether warehouse unloading labor is capitalized into inventory or expensed to GL 6900/5300.

### D. HISTORICAL DATA CURRENTLY UNRESOLVED
1. **Header \`other_import_costs\` (\`Rp 10,063,904.00\`)**:
   - Requires formal sign-off from management to confirm that no unvouched payables exist and authorize setting these 3 header values to \`0.00\` in the costing engine.
2. **Purchase Invoice IDR Rounding Difference (\`Rp 6.00\`)**:
   - Minor currency conversion rounding between PI header and lines across USD invoices.
`;

const artifactPath = '/Users/Kunal/.gemini/antigravity-ide/brain/73556c95-1acf-43fd-9f69-2089a61e6410/inventory_valuation_decision_report.md';
fs.writeFileSync(artifactPath, md);
console.log('Successfully wrote decision report artifact to:', artifactPath);
