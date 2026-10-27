# Codebase Issue Backlog (Targeted Tasks)

## Release Blockers as of 2026-06-03

1. Apply `supabase/migrations/20260603173000_fix_sales_order_delete_trigger_overload.sql`.
2. Delete remaining E2E records:
   - `e2e-SO-TEST-1780479381949`
   - `e2e-customer-TEST-1780479381949`
3. Run the full SO -> approve -> DC -> invoice -> receipt voucher E2E validation after cleanup is safe.
4. Optional metadata repair: recompute historical `inventory_transactions.stock_before/stock_after` snapshots for the 28 known drift rows. Do not change current stock; validated current stock is correct.

Completed production finance items:

- Finance audit completed.
- Trial Balance balanced.
- Historical COGS repair completed.
- Receipt voucher repair completed for `RV/25-26/011`.
- Nineteen stale invoice balance values repaired.

## 1) Typo Fix Task
**Issue found:** In `src/utils/dateFormat.ts`, the helper function is named `capitalise`. The project predominantly uses U.S. English spelling in code and UI text (e.g., `color`, `organization` patterns elsewhere), so this can be treated as a naming typo/inconsistency.

**Task:** Rename `capitalise` to `capitalize` and update all local references in `src/utils/numberToWords.ts`.

**Why this matters:** Improves naming consistency and discoverability for contributors expecting standard JavaScript-style naming.

---

## 2) Bug Fix Task
**Issue found:** `getFinancialYear` claims to return `"YY-YY"` but currently returns only a single two-digit year suffix (e.g., `"26"`). This can generate incorrect voucher/year grouping if other code expects fiscal ranges.

**Task:** Implement actual fiscal-year logic (April start) and return range format (e.g., `"25-26"` for dates from 2025-04-01 to 2026-03-31), then validate all call sites that consume the returned value.

**Why this matters:** Prevents incorrect numbering/grouping and mismatched fiscal reporting behaviors.

---

## 3) Comment/Documentation Discrepancy Task
**Issue found:** The `getFinancialYear` docblock is internally contradictory:
- It first says: "FY starts April 1"
- Then says: "Financial year follows the calendar year (Jan–Dec)"

This conflicts with itself and with expected accounting behavior.

**Task:** Update the doc comment to one clear definition (preferably April–March as stated first), include two concrete examples, and keep it aligned with implementation.

**Why this matters:** Reduces future regression risk caused by misleading inline documentation.

---

## 4) Test Improvement Task
**Issue found:** The repo has no focused unit tests for `src/utils/dateFormat.ts` behavior (especially edge cases around invalid dates and fiscal-year boundaries).

**Task:** Add utility tests (Vitest or existing test framework) covering:
- `formatDate` invalid/null input handling
- `toInputFormat` conversion from both `DD/MM/YYYY` and ISO strings
- `getFinancialYear` boundary dates around March 31 / April 1

**Why this matters:** Captures current expectations and prevents silent regressions in core formatting utilities used across modules.
