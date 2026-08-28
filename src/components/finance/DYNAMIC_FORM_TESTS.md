# Dynamic Expense Form — Test Trace

STEP 3, 2026-07-08. Manual trace of every category the user's brief
required, with expected field visibility, expected save behaviour, and
expected round-trip on re-open.

Rules module: `src/components/finance/categoryFieldRules.ts`
Wiring:      `src/components/finance/ExpenseManager.tsx`
Masters:     `finance_staff_master`, `finance_utility_master`
             (migration `20260708120000_finance_staff_and_utility_masters.sql`)

---

## Scenario A — Salary (`expense_category = 'salary'`)

**Expected field visibility (row 1 + 1b):**

| Field                | Visible? | Notes                                    |
| -------------------- | -------- | ---------------------------------------- |
| Staff picker         | ✓        | required, sourced from Staff Master      |
| Salary Month         | ✓        | January–December dropdown; current month by default |
| Amount               | ✓        | Prefilled from Staff Master, then freely editable |
| Supplier picker      | ✗        | hidden — staff aren't suppliers          |
| Utility picker       | ✗        | hidden                                   |
| Container            | ✗        | hidden (not import)                      |
| Broker lines         | ✗        | hidden (not import_broker)               |

Also covered: `staff_overtime`, `staff_welfare`, `travel_conveyance`.

**On save:**
- `finance_expenses.supplier_id` = **null** (staff rows leave supplier null).
- `finance_expenses.description` gets prefixed with `[<Staff.full_name> · <Month>]`
  for ledger traceability.
- `handleSubmit` blocks the save with an alert if no Staff row is picked.
- The canonical salary calculation uses the current Amount value, including
  manual overrides, without changing FIFO, tax, BPJS, or posting logic.

**On re-open (Edit):**
- The description prefix is parsed by `handleEdit()` — regex
  `^\[([^·\]]+?)(?:\s*·\s*([^\]]+))?\]\s*`.
- `selectedStaffId` is reconstructed by name lookup against `staffRoster`.
- `periodLabel` is restored.
- `formData.description` shows the CLEANED description (prefix stripped).
- If the roster is still loading at click time, a `useEffect` retries the
  lookup once the roster arrives.

## Scenario B — Utilities (`expense_category = 'utilities'`)

**Expected field visibility:**

| Field                | Visible? | Notes                                       |
| -------------------- | -------- | ------------------------------------------- |
| Utility picker       | ✓        | required, sourced from Utility Master       |
| Billing Month        | ✓        | HTML `<input type="month">`                 |
| Supplier picker      | ✗        | hidden                                      |
| Staff picker         | ✗        | hidden                                      |
| Bank Charges         | ✓        | utility-specific field (existing behaviour) |
| Broker lines         | ✗        | hidden                                      |

**On save:**
- If the picked Utility Master row has `supplier_id` linked, the frontend
  calls `handleSupplierSelect(utility.supplier_id)` and the expense flows
  through AP normally (`finance_expenses.supplier_id` filled).
- If the Utility row has no linked supplier, `finance_expenses.supplier_id`
  stays null and the provider name goes into the description prefix
  `[<Utility.provider_name> · <Billing Month>]`.
- `handleSubmit` blocks the save with an alert if no Utility row is picked.

## Scenario C — Import Broker (`expense_category = 'import_broker'`)

**Expected field visibility:**

| Field                | Visible? | Notes                                     |
| -------------------- | -------- | ----------------------------------------- |
| Supplier picker      | ✓        | broker's own supplier                     |
| Container            | ✓        | via `requiresContainer` OR is `import_broker` |
| Broker Invoice       | ✓        | header input (Row 2, labelled "Broker Invoice") |
| Header DDP           | ✓        | new independent scalar for broker rows    |
| Broker Reimbursement | ✓        | 10-column reimbursement grid (STEP 1+2)   |
| Staff picker         | ✗        | hidden                                    |
| Utility picker       | ✗        | hidden                                    |
| Salary/Billing Month | ✗        | hidden                                    |

Broker calculations are covered by BROKER_CALC_TESTS.md.

## Scenario D — Normal Purchase (any other category — `other`, `office`, etc.)

**Expected field visibility:**

| Field                | Visible? | Notes                                     |
| -------------------- | -------- | ----------------------------------------- |
| Supplier picker      | ✓        | default behaviour                         |
| Container            | ✗        | (unless category is `import`-type)        |
| Broker lines         | ✗        |                                           |
| Staff picker         | ✗        |                                           |
| Utility picker       | ✗        |                                           |
| Tax fields (PPN/PPh/Stamp) | ✓  | based on `DOCUMENT_TYPE_TAX_CONFIG`       |

---

## Edge cases handled

1. **Roster race** — if the user clicks Edit before Staff/Utility rosters
   load, the picker won't find the row by name. A follow-up `useEffect`
   watches roster state and retries the resolution once the fetch settles.
   No user-visible glitch.

2. **Category switched mid-form** — the rules recompute every render, so
   switching from Salary → Utilities → Import Broker → Normal Purchase
   swaps the pickers instantly. State for the *previous* picker is left
   untouched (deliberate — user can switch back without losing selection).

3. **Description prefix idempotency** — save prepends `[Name · Period]`
   only if `description` doesn't already start with the same tag. Editing
   an expense and re-saving without changing Staff/Utility doesn't
   double-prefix the description.

4. **Manual override of supplier_id** — if the user picks Utility Provider
   then manually clears the Supplier field, the utility's linked supplier
   is unlinked. This matches SAP B1's "user always wins" convention.

5. **Master row deletion** — deleting a Staff/Utility master row does NOT
   affect existing expenses (confirmed in the master delete confirm
   dialog copy). Only the master lookup is removed.

---

## Save persistence (unchanged from prior sprints — added for regression)

```
finance_expenses row for a Salary expense:
  expense_category   = 'salary'
  supplier_id        = null                       ← staff, not supplier
  description        = "[John Doe · 2026-07] March-cycle payroll"
  amount             = 15,000,000
  pph_code_id        = <PPh 21 UUID>
  pph_amount         = 1,500,000
  ppn_amount         = 0
  broker_items       = null

finance_expenses row for a Utility expense (linked-supplier PLN):
  expense_category   = 'utilities'
  supplier_id        = <PLN supplier UUID>        ← auto-filled from utility master
  description        = "[PLN Bandung · 2026-07] Meter reading July"
  amount             = 2,500,000
  ppn_amount         = 275,000
  bank_charges_amount = 5,000

finance_expenses row for a Utility expense (no supplier link):
  expense_category   = 'utilities'
  supplier_id        = null
  description        = "[Office Cleaning · 2026-07] Monthly service"
  amount             = 1,000,000
```

No new columns were added. Downstream reports read the stored values
verbatim (see FINANCE_AUDIT.md for the full trace).

---

_Last audit: 2026-07-08._
