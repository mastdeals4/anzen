# Broker Calculation Engine — Written Test Trace

Manual regression trace, 2026-07-08. Every scenario the user can trigger
in the Import Broker expense form, with expected inputs → expected state
transitions → expected Total Payable.

**Golden formula (single source of truth in ExpenseManager.tsx):**

```
Total Payable
  = Broker Invoice                (formData.amount)
  + Header DDP                    (formData.dpp_amount)
  + Σ Line.Amount                 (broker_items[i].amount)
  + Σ Line.DDP                    (broker_items[i].dpp_amount)
  + Σ Line.PPN Amount             (broker_items[i].ppn_amount)
  + Broker PPN                    (formData.ppn_amount)
  − Broker PPh                    (formData.pph_amount)
  + Broker Stamp Duty             (formData.stamp_duty_amount)
```

Every column is an independent input. No auto-rollup, no cross-contamination.

Per-line PPN auto-mode: `PPN Amount = round(DDP × PPN%)` when the user edits
DDP or PPN%. Editing PPN Amount directly flips the row to Manual and the
value is not overwritten until DDP or PPN% is edited again.

Legend for state changes:  H = header formData; L = broker line; P = Payable.

---

## Scenario 1 — Bare broker invoice, no lines

**Inputs:**
- Broker Invoice = 1,000,000
- Header DDP = 0
- Broker PPN = 110,000
- Broker PPh = 0
- Broker Stamp = 0
- No reimbursement lines

**Expected:**
- H.amount = 1,000,000; H.ppn_amount = 110,000
- Σ line.* = 0
- **Payable = 1,000,000 + 0 + 0 + 0 + 110,000 − 0 + 0 = 1,110,000** ✓

## Scenario 2 — Broker invoice + one auto-mode line (11% PKP)

**Inputs:**
- Broker Invoice = 1,000,000; Broker PPN = 110,000
- Line 1: Supplier PT Freight (PKP), Amount = 500,000, DDP = 500,000, PPN% = 11
- User does NOT touch PPN Amount

**Expected line state after typing:**
- L1.amount = 500,000
- L1.dpp_amount = 500,000
- L1.ppn_rate = 11
- L1.ppn_amount = round(500,000 × 11 / 100) = **55,000** (auto-computed)
- L1.ppn_treatment = 'excluded' (Auto badge)
- Line Total (display) = 500,000 + 500,000 + 55,000 = **1,055,000**

**Expected Payable:**
- Payable = 1,000,000 + 0 + 500,000 + 500,000 + 55,000 + 110,000 − 0 + 0
- **= 2,165,000** ✓

**Header untouched:** H.amount still 1,000,000. H.ppn_amount still 110,000.

## Scenario 3 — Editing PPN% on Line 1

Continuing from Scenario 2, user edits Line 1 PPN% from 11 → 12.

**Expected:**
- L1.ppn_rate = 12
- L1.ppn_amount = round(500,000 × 12 / 100) = **60,000** (auto-recomputed)
- L1.ppn_treatment stays 'excluded' (Auto)
- Header untouched
- Payable delta = +5,000 → **2,170,000**

## Scenario 4 — Editing PPN Amount directly on Line 1 (Manual flip)

Continuing from Scenario 3, user types PPN Amount = 60,001 (rounding
adjustment for the Faktur Pajak).

**Expected:**
- L1.ppn_amount = 60,001 (Manual)
- L1.ppn_treatment = 'included' (Manual badge M appears)
- L1.dpp_amount unchanged (500,000)
- L1.ppn_rate unchanged (12)
- Header untouched
- Payable delta = +1 → **2,170,001**

## Scenario 5 — Re-editing DDP on Line 1 (Manual → Auto)

Continuing from Scenario 4, user edits Line 1 DDP from 500,000 → 550,000.

**Expected:**
- L1.dpp_amount = 550,000
- L1.ppn_rate = 12 (unchanged)
- L1.ppn_treatment flips BACK to 'excluded' (Auto)
- L1.ppn_amount = round(550,000 × 12 / 100) = **66,000** (auto-recomputed,
  overriding the previous manual 60,001)
- Header untouched
- Line Total (display) = 500,000 + 550,000 + 66,000 = 1,116,000
- Payable = 1,000,000 + 0 + 500,000 + 550,000 + 66,000 + 110,000 = **2,226,000**

## Scenario 6 — Adding a second line does NOT touch Line 1

Continuing from Scenario 5, user clicks Add Line, enters:
- Line 2: Amount = 300,000, DDP = 300,000, PPN% = 11
  → L2.ppn_amount = 33,000 (auto)

**Expected:**
- Line 1 unchanged (Amount 500,000, DDP 550,000, PPN Amt 66,000)
- Line 2 added; no other state touched
- Header untouched
- Σ Line.Amount = 500,000 + 300,000 = 800,000
- Σ Line.DDP    = 550,000 + 300,000 = 850,000
- Σ Line.PPN    = 66,000 + 33,000 = 99,000
- Payable = 1,000,000 + 0 + 800,000 + 850,000 + 99,000 + 110,000 = **2,859,000**

## Scenario 7 — Removing Line 1 does NOT touch Line 2 or header

User clicks the trash icon on Line 1.

**Expected:**
- brokerItems = [Line 2]
- Header untouched (formData.amount / ppn_amount / pph_amount / stamp all
  the same as before removal)
- Payable delta = − (500,000 + 550,000 + 66,000) = −1,116,000 → **1,743,000**

## Scenario 8 — Editing Broker Invoice does NOT touch lines

User changes Broker Invoice from 1,000,000 → 1,200,000.

**Expected:**
- H.amount = 1,200,000
- H.ppn_amount unchanged (still 110,000 for broker; PPh code None)
- All lines unchanged
- Payable delta = +200,000 → **1,943,000**

## Scenario 9 — Adding Header DDP

User types Header DDP = 50,000.

**Expected:**
- H.dpp_amount = 50,000
- All lines unchanged
- Payable delta = +50,000 → **1,993,000**

## Scenario 10 — Header PPh withholding

User picks PPh 23 code (rate 2%).

**Expected:**
- H.pph_code_id = <PPh 23 id>
- H.pph_amount = round(1,200,000 × 2 / 100) = **24,000** (auto)
- All lines unchanged
- Payable delta = −24,000 → **1,969,000**

Note: Header PPh is anchored to Header amount only. Reimbursement line
amounts do NOT contribute to the PPh calculation.

## Scenario 11 — Stamp Duty

User enters Broker Stamp = 10,000.

**Expected:**
- H.stamp_duty_amount = 10,000
- Payable delta = +10,000 → **1,979,000**

## Scenario 12 — Money input "0" bug

Every money field on the form should behave as:
- Empty field ⇒ display "" (not "0")
- Type "5" ⇒ display "5" (not "05")
- Cursor stays after the last typed digit through re-format

Verified by MoneyInput.tsx `showEmpty = hideZero && numeric === 0`
(no `!focused` clause — always empty when zero).

---

## Save persistence — what hits the database

For Scenario 5+6+8+9+10+11 (Broker Invoice = 1,200,000, Header DDP = 50,000,
two lines, PPh 23 at 2%, Stamp 10,000):

```
finance_expenses row (fault-tolerant save skips columns not deployed yet):
  amount             = 1,200,000
  supplier_id        = <parent broker supplier>
  expense_category   = 'import_broker'
  ppn_amount         = 110,000          ← header PPN only
  ppn_calc_mode      = 'standard'       ← unless user picked another mode
  dpp_amount         = 50,000           ← header DDP addend
  ppn_rate           = 11
  pph_amount         = 24,000
  pph_code_id        = <PPh 23 UUID>
  stamp_duty_amount  = 10,000
  broker_items       = [
    {
      supplier_id: <Freight supplier>,
      invoice_number: "…",
      tax_invoice_number: "…",
      invoice_date: "2026-07-08",
      amount: 500,000,
      dpp_amount: 550,000,
      ppn_rate: 12,
      ppn_amount: 66,000,
      ppn_treatment: 'excluded'      ← 'excluded' = Auto, 'included' = Manual
    },
    {
      supplier_id: <Second supplier>,
      amount: 300,000,
      dpp_amount: 300,000,
      ppn_rate: 11,
      ppn_amount: 33,000,
      ppn_treatment: 'excluded'
    }
  ]
```

Downstream `vw_input_ppn_report` reads header `ppn_amount` for Branch 3
and broker line `ppn_amount` for Branch 5 as before. The read-back view
migration from 2026-07-07 already prefers per-line `dpp_amount` when
present. No regression.

---

## Assumptions removed vs previous implementations

1. Old broker `updateLine` used to `setFormData({ amount: sumAmt, ppn_amount: sumPpn })`
   — **removed** in the 2026-07-07 refactor. Verified by grep.
2. Old "Items must equal Invoice Amount" save-time alert
   — **removed** in the 2026-07-07 refactor.
3. Old auto-seed of DDP = Amount when the user typed Amount
   — **removed** in this commit. DDP is now fully independent; the user
   must type it explicitly.
4. Old "Amount already includes PPN" heuristic in Line Total display
   — **removed** in this commit. Line Total is always `Amount + DDP + PPN`.
5. Old fallback that used `computeBrokerLinePpn(amount, treatment)` when
   the user set Amount but not DDP/rate — **retained** only for legacy rows
   loaded from the database that predate the DDP column; new rows never
   trigger it because they always have `dpp_amount` and `ppn_rate` set.

---

## Manual mode flag — schema note

The `ppn_treatment` enum is used as a per-line Manual flag:
- `'excluded'` → row in **Auto** mode (PPN Amount recomputes on DDP/% edit)
- `'included'` → row in **Manual** mode (PPN Amount is user-typed; not overwritten)
- `'none'`     → legacy (no PPN); still supported for read-back

This avoids a schema change. The visible column PPN Amount tint changes:
- Blue = Auto mode.
- Amber with "M" badge = Manual mode.

_Last audit: 2026-07-08 by Claude Opus 4.7 (1M context)._
