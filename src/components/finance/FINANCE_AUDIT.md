# Finance Calculation Audit — 2026-07-08

Read-only trace of every calculation from user input → journal entry →
supplier ledger → tax report → trial balance. Written as a source-of-truth
document so future edits do not silently break invariants.

Scope: broker / reimbursement / DPP / PPN / PPh header engine, and the
verification that reports read the STORED values (never recompute).

---

## 1. Broker Invoice vs Reimbursement Lines — independence guarantee

**Rule (per 2026-07-08 spec):** The broker's own invoice is one thing.
The reimbursement lines are separate sub-supplier invoices. Editing a
reimbursement line MUST NEVER modify header fields, and vice versa.

**Where this is enforced in code:**

- `ExpenseManager.tsx :: updateLine()` — the reimbursement-line onChange
  handler. It only mutates the `brokerItems` state via `setBrokerItems`.
  It does NOT call `setFormData` for `amount`, `ppn_amount`, `pph_amount`,
  or `stamp_duty_amount`. Confirmed by grep.
- `ExpenseManager.tsx :: removeLine()` — same. Only removes from
  `brokerItems`; never touches parent state.
- The pre-save validation "Σ line.amount must equal formData.amount" that
  used to block saves has been REMOVED.

**Persisted result:**

- `finance_expenses.amount`         = broker's own charge (independent)
- `finance_expenses.ppn_amount`     = broker's own PPN (independent)
- `finance_expenses.pph_amount`     = broker's own PPh (independent)
- `finance_expenses.stamp_duty_amount` = broker's own stamp (independent)
- `finance_expenses.broker_items` (JSONB) = array of reimbursement lines,
  each carrying its own supplier_id, amount, dpp_amount, ppn_rate, ppn_amount

---

## 2. Reimbursement line calculation engine (DPP / PPN % / PPN Amount / Total)

**Fields on each broker line:**

| Field         | Type    | Meaning                                                    |
| ------------- | ------- | ---------------------------------------------------------- |
| supplier_id   | uuid?   | Sub-supplier (forwarder / port / trucking)                 |
| invoice_number| text?   | Sub-supplier invoice number                                |
| invoice_date  | date?   | Sub-supplier invoice date (optional)                       |
| amount        | numeric | Line gross total (what the sub-supplier billed)            |
| dpp_amount    | numeric?| Dasar Pengenaan Pajak (taxable base). NULL for legacy rows.|
| ppn_rate      | numeric?| PPN rate as % (0 / 11 / 12 / custom). NULL for legacy.      |
| ppn_amount    | numeric | PPN amount. Auto = round(dpp × rate / 100). Editable.      |
| ppn_treatment | enum?   | Legacy: 'none' | 'excluded' | 'included'. NEW rows: null.  |

**Auto-mode rule** (implemented in `updateLine`):

```
IF the caller patched dpp_amount OR ppn_rate
   AND did NOT patch ppn_amount explicitly
THEN ppn_amount := round(dpp_amount × ppn_rate / 100)
```

**Manual-mode rule:**

```
IF the caller patched ppn_amount explicitly
THEN store that value verbatim — do not recompute.
```

**Legacy fallback** (rows without dpp_amount / ppn_rate):

```
IF neither dpp_amount nor ppn_rate is set on the line
   AND the caller patched amount but not ppn_amount
THEN ppn_amount := computeBrokerLinePpn(amount, ppn_treatment)
```

This keeps pre-refactor broker rows loading and balancing exactly as before.

**Total per line** (visible in the reimbursement grid):

```
lineTotal :=
   IF dpp_amount is set     THEN amount             (amount already includes PPN)
   ELSE IF treatment=included THEN amount            (legacy behaviour)
   ELSE                        amount + ppn_amount   (legacy excluded)
```

The distinction matters because SAP-style Indonesian forwarder invoices
carry DPP and PPN as separate columns but the `amount` field is the invoice
gross. Legacy rows without DPP still use the "excluded" formula for
back-compat.

---

## 3. Header PPN / PPh / Stamp engine

**Rule:** Header taxes are independent of reimbursement lines. Editing a
line NEVER touches these fields.

**Where written:**

- Only the header form controls in `ExpenseManager.tsx` (Invoice Amount,
  PPN row with mode selector, PPh row with code selector, Stamp Duty
  input) call `setFormData` for these keys. Reimbursement-line handlers
  do not.

**PPN header calculation modes:**

- `standard` — auto = amount × 11% when supplier is PKP. User-editable.
- `dpp_nilai_lain` — user enters DPP, PPN = round(DPP × rate / 100).
- `manual` — never auto-recomputed.

**PPh header auto-recalc** (implemented on Invoice Amount onChange):

```
IF pph_code_id is set (user picked a PPh code)
THEN pph_amount := round(amount × code.rate / 100)
ELSE pph_amount stays as user-edited.
```

The PPh code auto-anchoring on document-total change matches SAP B1.
Users who need to break this simply set PPh code to None first.

---

## 4. Total Payable formula (single source of truth)

```
Total Payable
  = Broker Invoice Amount               ← finance_expenses.amount
  + Reimbursement Total (Σ line.amount)
  + Total PPN
        (= header.ppn_amount + Σ line.ppn_amount)
  − PPh Withheld                        ← finance_expenses.pph_amount
  + Stamp Duty                          ← finance_expenses.stamp_duty_amount
```

Displayed in the payment summary strip inside the Expense form and in
the Expense Details popup. No other screen re-derives this — the payable
number for A/P purposes is `finance_expenses.amount` (parent broker
invoice) plus any settled allocations captured on `voucher_allocations`.
The reimbursement lines are shown but not summed into a separate A/P
line — they're a documentation breakdown for the tax report.

---

## 5. Save persistence — what goes to the database

`ExpenseManager.tsx` save payload (lines ~1010–1050):

| Column                    | Source                        | Guard                       |
| ------------------------- | ----------------------------- | --------------------------- |
| expense_category          | formData.expense_category     | always                      |
| amount                    | formData.amount               | always                      |
| supplier_id               | formData.supplier_id          | always (null for staff)     |
| broker_items              | brokerItems array (JSONB)     | broker category only        |
| ppn_amount                | formData.ppn_amount           | persistHeaderTax            |
| ppn_calc_mode             | formData.ppn_calc_mode        | persistHeaderTax            |
| dpp_amount                | formData.dpp_amount           | persistHeaderTax + DPP mode |
| ppn_rate                  | formData.ppn_rate             | persistHeaderTax            |
| pph_amount                | formData.pph_amount           | persistHeaderTax            |
| pph_code_id               | formData.pph_code_id          | persistHeaderTax            |
| stamp_duty_amount         | formData.stamp_duty_amount    | persistHeaderTax            |
| bank_charges_amount       | formData.bank_charges_amount  | utilities only              |

`persistHeaderTax = !isPib && (!isImportCategory || isBrokerInvoice)`.
Broker invoices behave like any other supplier invoice at the header
level — the old "force-zero" workaround from the roll-up era is gone.

Fault-tolerant save is retained: unknown columns (e.g. deployment lag)
are stripped and the insert/update retries.

---

## 6. Downstream regression — no calculation is re-derived anywhere

Verified by grep across the repo:

- **auto_post_expense_accounting trigger** (`supabase/migrations/…`) —
  reads `NEW.ppn_amount`, `NEW.pph_amount`, `NEW.stamp_duty_amount`,
  `NEW.bank_charges_amount`, `NEW.amount`. Never re-derives them.
- **vw_input_ppn_report** — reads `fe.ppn_amount`, `fe.dpp_amount`, and
  broker_items JSONB fields verbatim. Branch 5 prefers explicit line
  `dpp_amount` (2026-07-07 migration) and falls back to derived DPP for
  legacy rows.
- **Party Ledger / Supplier Ledger / AP** — key off
  `finance_expenses.supplier_id` (parent). Never touches broker_items.
- **Bank Reconciliation** — matches on `bank_statement_lines.matched_expense_id`
  and reads `finance_expenses.paid_amount` / `pph_paid_amount`. Doesn't
  recompute.
- **Trial Balance / P&L / Balance Sheet** — sourced from
  `journal_entry_lines` (posted by the trigger above). Reads GL account
  balances. Never touches `finance_expenses` directly.
- **Tax Reports** (TaxReports.tsx) — consumes `vw_input_ppn_report`,
  `vw_monthly_tax_summary`, and expense VAT/PPh registers with joins on
  the parent `supplier_id`.

Reports never see anything different because we changed the input form.
The stored `finance_expenses` columns are the sole source of truth for
every downstream artifact.

---

## 7. MoneyInput invariants

- Value `0` displays as empty (placeholder-only).
- Typing digits into a zero field replaces the value (no leading zero).
- Cursor position is preserved through re-format via digit-count-before-caret.
- Indonesian locale: `1.250.000` (dot thousands), optional comma decimal.
- Uses `type="text"` + `inputMode="numeric"` — mobile still gets numeric keypad.
- Never emits a NaN — parseId returns 0 on unparseable input.

Applied to every finance money field: Invoice Amount, PPN, DPP, PPh,
Stamp Duty, Bank Charges, PIB breakdown, broker line Amount + PPN.

---

## 8. Category-driven form (2026-07-08)

Rules module: `categoryFieldRules.ts`.

| Category                   | Shows                                              |
| -------------------------- | -------------------------------------------------- |
| salary / staff_overtime / staff_welfare / travel_conveyance | Staff picker + Salary Month |
| utilities                  | Utility picker + Billing Month + Bank Charges       |
| import_broker              | Supplier + Container + Reimbursement lines          |
| all others                 | Supplier (default)                                  |

Staff/Utility rows carry the master-record name as a prefix on the saved
description (`[Name · Period]`) so the ledger reads naturally without
introducing a new column.

---

## 9. Open items — deferred to next sprint

These require further design decisions and are NOT shipped in this pass:

- **Travel Master** — the brief mentioned "Employee / Trip / Advance /
  Settlement". Currently travel_conveyance is bucketed as a Staff
  category. A dedicated Trip Advance / Settlement workflow needs its
  own tables (trip_advance, trip_settlement) and posting logic.
- **Broker Line Tax Invoice Number / Date** columns — optional fields
  the brief requested for the reimbursement grid. The BrokerItem type
  already carries `invoice_number` and `invoice_date` — I've documented
  this but the UI grid currently exposes only Invoice #. Wiring
  invoice_date into the grid is a follow-up.
- **UI density beyond current pass** — the SAP-B1 layout system (SapForm
  / SapRow / SapField) is in the tree at `SapLayout.tsx` but not yet
  wired to the Expense form. That's a separate visual redesign sprint.

---

_Last audit: 2026-07-08._
