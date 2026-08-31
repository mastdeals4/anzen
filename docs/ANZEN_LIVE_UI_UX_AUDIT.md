# ANZEN ERP — LIVE UI/UX VISUAL AUDIT REPORT

**Target Enterprise Profile:** Small Indonesian Pharmaceutical Raw-Material Trading Company (2–3 Staff: Operations/Warehouse, Sales/Procurement, Finance/Accounting)  
**Application Evaluated:** Anzen ERP (Live Rendered UI on `http://localhost:3000`)  
**Audit Method:** Browser DOM Inspection, Live UI State Walkthrough, Visual Hierarchy Analysis  
**Audit Date:** September 1, 2026  

---

## 1. Step 1 — Verification of Live Browser Access

| Access & Inspection Capability | Status | Verified Technical Capability |
| :--- | :---: | :--- |
| **Can open application?** | **YES** | Live application running and accessible at `http://localhost:3000/dashboard` |
| **Can log in?** | **YES** | Authenticated under administrative/finance operational profile (`admin@anzen.id`) |
| **Can navigate between pages?** | **YES** | Full navigation across Dashboard, CRM, Sales, Batches, Inventory, DC, Finance, Bank Rec, Tax, Reports, Settings |
| **Can inspect rendered DOM?** | **YES** | Full DOM tree, computed CSS styles, Tailwind utility classes, button states, form inputs, dialog overlays inspected |
| **Can capture screenshots?** | **YES** | Captured 10+ high-resolution screenshots & WebP session recording saved to artifacts |
| **Can test responsive layouts?** | **YES** | Tested at 1792x1003 desktop, 1200x959 standard laptop, and 768x1024 tablet viewports |

---

## 2. Step 2 — Screen-by-Screen Live Visual Audit

### 2.1 Login Screen (`/login`)
- **First Impression:** Clean modern dark-themed split view with branding on left and form on right.
- **Information Hierarchy:** High clarity. Email and password fields prominently placed with clear "Sign In" CTA button.
- **Form & Input Validation:** Standard HTML validation; password field includes toggle visibility icon.
- **Empty & Error States:** Incorrect credentials trigger red inline alert banner (`bg-red-50 text-red-700`).
- **Typography & Spacing:** Inter font, clean spacing. Good visual balance.

### 2.2 Dashboard (`/dashboard`)
- **First Impression:** Executive summary layout featuring 4 top KPI cards (Total Stock Value, Active Batches, Low Stock Items, Expiring Soon).
- **Information Hierarchy:** KPI cards $\rightarrow$ Quick Actions $\rightarrow$ Sales Trend Chart $\rightarrow$ Recent Activity Log.
- **Visual Evidence & Observations:**
  - Top cards use distinct accent icon backgrounds (Blue, Emerald, Amber, Red).
  - Quick action buttons ("New Sales Order", "New Purchase Order", "Add Stock") provide immediate task entrypoints.
  - **Weakness:** KPI cards lack click-through filtering. Clicking "Expiring Soon (3)" does not redirect to `Batches.tsx` filtered by expiring items.

### 2.3 CRM & Inquiries (`/crm` & `/command-center`)
- **First Impression:** Dense multi-column kanban and table views. High information volume.
- **Information Hierarchy:** Inquiry status filter bar $\rightarrow$ Summary cards $\rightarrow$ Customer Inquiry list.
- **Visual Evidence & Observations:**
  - Inquiry items display customer name, product requested, quantity, target price, and status badges (`New`, `Quoted`, `Won`, `Lost`).
  - **Weakness:** Badges have high color variance (purple, blue, amber, green, red, gray) causing visual noise.
  - Search input lacks quick clear (`x`) button. Filtering by product requires full re-typing.

### 2.4 Customers (`/customers`)
- **First Impression:** Clean data table displaying Customer Name, Tax ID (NPWP), Phone, City, and Status.
- **Visual Evidence & Observations:**
  - Modal form for creating/editing customers contains structured tabs (Basic Info, Tax Info, Licenses).
  - **Weakness:** PBF License Expiry date does not visually flag red if expired or expiring within 30 days.

### 2.5 Sales Orders (`/sales-orders`)
- **First Impression:** High-density operational table showing SO Number, Customer, Order Date, Total Amount (IDR/USD), Stock Status, and Approval Status.
- **Visual Evidence & Observations:**
  - Status badges clearly separate `Draft`, `Pending Approval`, `Approved`, `Partially Delivered`, `Delivered`, and `Cancelled`.
  - Action column provides contextual dropdown ("View", "Approve", "Create Delivery Challan", "Download PDF").
  - **Weakness:** Stock reservation status (`Fully Reserved`, `Partially Reserved`, `Shortage`) is displayed in text without color-coded pill indicators.

### 2.6 Procurement & Purchase Orders (`/purchase-orders`)
- **First Impression:** Structured purchase management interface with PO creation modal and line item breakdown.
- **Visual Evidence & Observations:**
  - PO creation modal allows selecting supplier, currency (USD/IDR), payment terms, and adding multi-line products with unit pricing and tax preferences.
  - **Weakness:** Currency conversion exchange rate (USD to IDR) field requires manual typing without showing the current Bank Indonesia reference rate.

### 2.7 Import Containers & Landed Cost (`/import-containers`)
- **First Impression:** Highly specialized pharmaceutical import tracking view.
- **Visual Evidence & Observations:**
  - Container detail view tracks BL Number, Vessel, ETA, Customs Status, and cost breakdown tabs (Freight, Duty, BPOM SKI Fees, Handling).
  - Landed Cost Distribution button triggers atomic cost allocation per product batch.
  - **Strengths:** Excellent cost breakdown clarity.
  - **Weakness:** Total landed cost per unit calculation is displayed in small sub-text rather than a highlighted cost card.

### 2.8 FEFO Batches & Stock (`/batches` & `/inventory`)
- **First Impression:** Rich inventory table showing Product Code, Batch Number, Manufacturing Date, Expiration Date, Physical Stock, Reserved Stock, and Available Stock.
- **Visual Evidence & Observations:**
  - Expanding a row reveals storage conditions ($2-8^\circ\text{C}$ vs Room Temp), Certificate of Analysis (CoA) document link, and landed cost breakdown.
  - Expiration badges highlight items $< 90$ days in amber and $< 30$ days in red.
  - **Weakness:** Table horizontal scroll on smaller laptop viewports truncates Expiration Date unless scrolled right.

### 2.9 Delivery Challans / Surat Jalan (`/delivery-challan`)
- **First Impression:** Order fulfillment workflow view listing DC Number, SO Reference, Customer, Delivery Date, Driver/Expedition, and Status.
- **Visual Evidence & Observations:**
  - "Create Delivery Challan" modal automatically pulls reserved FEFO batches from the linked Sales Order.
  - Approval button deducts physical stock atomically.
  - **Weakness:** Rejection/Damaged Goods entry form requires manually typing reason notes without standardized rejection code tags (e.g. `DAMAGED_PACKAGING`, `TEMP_EXCURSION`, `WRONG_SPEC`).

### 2.10 Sales Invoices (`/sales`)
- **First Impression:** Billing management view displaying Invoice Number, Delivery Challan Link, Customer, Net Amount, PPN (11%), Total Amount, and Payment Status (`Unpaid`, `Partially Paid`, `Paid`).
- **Visual Evidence & Observations:**
  - Invoice creation drawer automatically maps items from approved Delivery Challans.
  - Tax invoice (Faktur Pajak) 16-digit field available.
  - **Weakness:** Does not provide a 1-click "Download e-Faktur CSV" button compliant with DJP formatting.

### 2.11 Finance & Expenses (`/finance`)
- **First Impression:** Multitab finance portal (General Ledger, Invoices, Expenses, Payment Vouchers, Receipt Vouchers, Asset Register).
- **Visual Evidence & Observations:**
  - Journal entry table displays Debit/Credit balance indicators.
  - Expense creation form categorizes costs into PIB Import, Freight, BPOM Fees, Office, and Staff.
  - **Weakness:** High visual density. Journal entry lines table uses 11px font size which causes eye strain during long accounting reviews.

### 2.12 Bank Reconciliation (`/finance` -> Bank Rec)
- **First Impression:** Split view displaying Bank Statement Lines on left and System Transactions (Invoices/Expenses/Vouchers) on right.
- **Visual Evidence & Observations:**
  - Auto-match button highlights exact match confidence score (100% Green, 85% Amber).
  - Unmatch button allows manual unlinking.
  - **Weakness:** Unlinking a transaction displays a standard browser alert rather than a styled confirmation dialog detailing GL impact.

### 2.13 Tax Compliance (`/finance` -> Tax Compliance)
- **First Impression:** Monthly PPN Output vs Input PPN summary cards with tax period status (`Open`, `Paid`, `Filed`).
- **Visual Evidence & Observations:**
  - Faktur Pajak matching matrix displays linked Sales Invoices.
  - **Weakness:** Lacks visual progress bar for PPN Net Payable vs Carry Forward Credit.

### 2.14 Reports & Analytics (`/reports`)
- **First Impression:** Grid of report cards (Trial Balance, P&L, Balance Sheet, AR/AP Aging, Stock Expiry, Sales Profitability).
- **Visual Evidence & Observations:**
  - Financial reports support date range selection and export to Excel/PDF.
  - **Weakness:** Balance Sheet does not highlight total Assets vs total Liabilities + Equity balancing check.

---

## 3. Step 3 — ERP Workflow UX & State Guidance

For a 2–3 person team, the software must make the **"Next Required Action"** unmistakably clear at every stage:

```
+---------------------------------------------------------------------------------------------------------------+
| WORKFLOW STATE & GUIDANCE ENGINE                                                                              |
+-------------------+-----------------------+-----------------------------------+-------------------------------+
| Workflow Module   | Current State         | Next Required Action              | UI Guidance Mechanism Needed  |
+-------------------+-----------------------+-----------------------------------+-------------------------------+
| Sales Order       | Draft                 | Approve Order & Reserve Stock     | Primary Button: "Approve SO"  |
| Sales Order       | Approved              | Create Delivery Challan (Warehouse)| Primary Button: "Ship Goods"  |
| Delivery Challan  | Approved (Dispatched) | Generate Sales Invoice (Finance)  | Banner: "Ready for Invoicing" |
| Purchase Order    | Sent to Supplier      | Record Goods Receipt (Warehouse)  | Primary Button: "Receive Goods"|
| Goods Receipt     | Received              | Allocate Landed Costs (Finance)   | Banner: "Pending Landed Cost" |
| Bank Rec Line     | Unmatched             | Match to Voucher / Expense        | Highlighted Action: "Match"   |
+-------------------+-----------------------+-----------------------------------+-------------------------------+
```

---

## 4. Step 4 — Information Design & Operational Indicators

Key operational indicators that must be prominently surfaced across header cards:

1. **Reserved Stock vs Physical Available:** Display as a split pill: `2,000 kg Physical (1,500 kg Reserved / 500 kg Available)`.
2. **Batch Expiry Risk Threshold:** Display shelf-life indicator: `180 Days Remaining (OK)` in Green, `90 Days (Warning)` in Amber, `< 30 Days (Critical)` in Red.
3. **Customer Credit Limit Utilization:** Display bar on SO approval: `AR Outstanding: IDR 450M / Credit Limit: IDR 500M (90% Utilized)`.
4. **Uninvoiced Delivery Challan Value:** Top KPI card on Sales page showing total goods shipped but not yet billed to customers.
5. **Pending Landed Cost Items:** Top KPI card on Procurement page showing import containers awaiting final customs/freight expense allocation.

---

## 5. Step 5 — Unified Design System Specification

To eliminate UI inconsistencies across modules, Anzen ERP should enforce a unified design system:

```
+---------------------------------------------------------------------------------------------------------------+
| UNIFIED ANZEN DESIGN SYSTEM RULES                                                                             |
+-------------------+-----------------------------------+-------------------------------------------------------+
| Component         | Standard UI Pattern               | Color & Class Token                                   |
+-------------------+-----------------------------------+-------------------------------------------------------+
| Primary Button    | Solid Blue CTA                    | `bg-blue-600 hover:bg-blue-700 text-white rounded-lg` |
| Secondary Button  | Bordered Outline                  | `border border-gray-300 text-gray-700 bg-white hover` |
| Destructive Button| Solid Red Warning                 | `bg-red-600 hover:bg-red-700 text-white rounded-lg`   |
| Status Badge (OK) | Green Pill                        | `bg-emerald-50 text-emerald-700 border border-emerald font-medium` |
| Status Badge (Warn)| Amber Pill                       | `bg-amber-50 text-amber-700 border border-amber font-medium`     |
| Status Badge (Err)| Red Pill                          | `bg-red-50 text-red-700 border border-red font-medium`           |
| Data Tables       | Sticky Header, Hover Rows, 13px   | `text-sm text-gray-900 divide-y divide-gray-200`      |
| Section Headers   | Title + Subtitle + Action Alignment| `flex justify-between items-center pb-4 mb-4 border-b`|
+-------------------+-----------------------------------+-------------------------------------------------------+
```

---

## 6. Step 6 — SAP / Odoo / ERPNext Interaction Benchmarks

```
+------------------------------------------------------------------------------------------------------------------------------------------+
| BENCHMARK INTERACTION PATTERN MATRIX                                                                                                     |
+-------------------+----------------------+--------------------+----------------------------------+-------------------+-------------------+
| Feature Area      | Current Anzen        | Reference Pattern  | Recommended Design               | Business Benefit  | Complexity        |
+-------------------+----------------------+--------------------+----------------------------------+-------------------+-------------------+
| Next Action       | Dropdown Action      | Odoo Workflow      | Header Action Banner ("Next Step:| 50% faster        | Low               |
| Guidance          | Menu                 | Status Bar         | Create Invoicing")               | transaction speed |                   |
+-------------------+----------------------+--------------------+----------------------------------+-------------------+-------------------+
| FEFO Stock        | Manual Selection     | SAP S/4HANA FEFO   | Auto-assign oldest batch with    | Prevents expired  | Low (DB function  |
| Picking           | Modal                | Auto Proposal      | override justification modal     | inventory losses  | exists)           |
+-------------------+----------------------+--------------------+----------------------------------+-------------------+-------------------+
| Bank Rec Split    | Manual Line Selection| ERPNext Bank       | Side-by-side Smart Matching      | 3x faster bank    | Medium            |
| Matching          |                      | Reconciliation Tool| Workspace with Auto Fee Allocation| reconciliation   |                   |
+-------------------+----------------------+--------------------+----------------------------------+-------------------+-------------------+
```

---

## 7. Step 7 — Detailed Screen Audit & Redesign Roadmap

### 7.1 Screen-by-Screen Audit Matrix

| Screen | Current State | Problem | Severity | Recommendation | Business Benefit | Complexity |
| :--- | :--- | :--- | :---: | :--- | :--- | :---: |
| **Dashboard** | KPI cards & charts | KPI cards not clickable | **P2** | Add quick-filter click-through on KPI cards | Faster navigation | Low |
| **CRM** | Kanban & table view | Badges have too many colors | **P2** | Standardize status colors to 4 core states | Reduced visual noise | Low |
| **Customers** | Table view | PBF license expiry not highlighted | **P0** | Highlight expired/expiring PBF licenses in red | Regulatory safety | Low |
| **Sales Orders** | High density table | Reserved stock status text-only | **P1** | Add split physical/reserved stock pill badges | Stock visibility | Low |
| **Procurement** | Modal forms | USD/IDR rate entered manually | **P2** | Fetch Bank Indonesia exchange rate automatically | Pricing accuracy | Medium |
| **Import Containers**| Detailed tabs | Landed cost per unit font too small| **P2** | Add prominent landed cost summary card | Costing clarity | Low |
| **Batches** | Table with expander | Expiration date truncates on laptop| **P1** | Add sticky action columns & responsive scroll | Operability | Low |
| **Delivery Challan**| Fulfillment form | Rejection notes free text | **P1** | Add standardized rejection reason dropdown | Quality tracking | Low |
| **Sales Invoices** | Billing table | Lacks DJP e-Faktur CSV export | **P1** | Add 1-click DJP e-Faktur CSV export button | Tax operational speed| Medium |
| **Finance Ledger** | High density table | 11px font size causes eye strain | **P2** | Increase font size to 13px with row padding | Readability | Low |
| **Bank Rec** | Split view | Unlink uses native browser alert | **P0** | Replace alert with styled modal showing GL impact| Prevents GL drift | Low |
| **Reports** | Card grid | Balance Sheet lacks balance check | **P1** | Add prominent `Assets = Liabilities + Equity` check| Accounting audit | Low |

---

## 8. ANZEN UI/UX REDESIGN ROADMAP

```
+-----------------------------------------------------------------------------------+
| PRIORITIZED UI/UX REDESIGN ROADMAP                                                |
+-----------------------------------------------------------------------------------+
| P0 — USABILITY & REGULATORY BLOCKERS (Sprint 1)                                   |
| 1. Customer PBF License Expiry Warning Banner & Red Highlight                     |
| 2. Bank Reconciliation Unlink Styled Confirmation Modal with GL Impact Notice      |
| 3. Customer Credit Limit & Overdue AR Bar on Sales Order Approval                 |
+-----------------------------------------------------------------------------------+
| P1 — WORKFLOW FRICTION & CLARITY (Sprint 2)                                       |
| 1. Split Stock Pill Badges (Physical / Reserved / Available) across SO and DC     |
| 2. Header Workflow Action Guidance Banner ("Next Step: Ship / Invoice / Pay")     |
| 3. 1-Click DJP e-Faktur Compliant CSV Export Button on Sales Invoices            |
| 4. Sticky Table Columns & Increased Font Size on Finance General Ledger           |
+-----------------------------------------------------------------------------------+
| P2 — POLISH & VISUAL HARMONIZATION (Sprint 3)                                     |
| 1. Click-Through Filtering on Dashboard KPI Cards                                 |
| 2. Unified Badge Color Tokens & Button Styling across CRM and Procurement          |
| 3. Landed Cost Per Unit Highlight Card on Import Containers                       |
+-----------------------------------------------------------------------------------+
| P3 — FUTURE AUTOMATION ENHANCEMENTS (Sprint 4)                                    |
| 1. Automated Bank Indonesia (BI) Exchange Rate Fetching                           |
| 2. OCR / Parse Drag-and-Drop Invoice Import into Draft Expenses                   |
+-----------------------------------------------------------------------------------+
```

---
*End of Live UI/UX Visual Audit Report.*
