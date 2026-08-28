# SAPJ Final Reports and Accounting Logic Audit

Read-only audit of the report layer and current accounting data. Scope tested:
2025-01-01 through 2026-07-31, plus current/latest data where relevant.

**Production writes: zero.** No journals, allocations, bank statements, USD
history, August records, or source documents were changed.

## Executive conclusion

The Trial Balance and journal-native Balance Sheet are internally balanced and
exclude reversed journals correctly. P&L classifications are consistent with
the journal data. The principal report defects are:

1. USD reporting RPCs ignore the supplied USD rate and aggregate raw `debit` /
   `credit` values even when USD transaction fields are the authoritative units.
2. Bank Ledger is statement-native but resolves document references through
   legacy `matched_*` fields rather than canonical `bank_statement_allocations`.
3. Payables RPC filters on `payment_method IS NULL`, so a bank-transfer expense
   with an evidenced partial payment can disappear despite positive outstanding
   AP (EXP/26-26/034 is the confirmed example).

No historical repair is recommended from this audit.

## 1. Trial Balance

The live `get_trial_balance` RPC filters `is_posted = true` and
`is_reversed = false`, includes only active non-header COAs, and uses the
requested date range. Direct SQL using the same predicates matched the RPC.

| Period | Rows | Debits | Credits | Difference |
|---|---:|---:|---:|---:|
| 2025 full year | 30 | Rp5,633,448,546.00 | Rp5,633,448,546.00 | Rp0.00 |
| 2026 Jan–Jul | 40 | Rp16,887,494,368.03 | Rp16,887,494,368.03 | Rp0.00 |
| Current/latest tested | 42 | Rp23,313,346,748.16 | Rp23,313,346,748.16 | Rp0.00 |

Correction/reversal chains are not double-counted because the original rows
are excluded by `is_reversed`; active historical-repair replacements remain
included exactly once. Inactive/header COAs are excluded as intended.

**Caveat:** `get_trial_balance(p_usd_rate)` accepts a rate but does not use it.
It sums functional `debit`/`credit` directly, so USD-account rows with mixed
functional/transaction representations remain semantically contaminated even
though the debit/credit totals balance.

## 2. Balance Sheet

`get_balance_sheet` uses the same posted/non-reversed predicate and adds Current
Year Earnings once when COA 3300 is absent. Direct SQL matched the RPC rows.
The tested 2026-07-31 balances include:

| Account | Signed balance |
|---|---:|
| 111101 IDR bank | Rp469,729,087.94 |
| 111102 USD bank (raw functional ledger) | Rp656,781,819.00 |
| Staff Advances 1160 | Rp0.00 |
| PPN Input 1150 | Rp658,145,488.75 |
| Accounts Payable 2110 | Rp1,849,876,134.60 credit-normal |
| PPh 23 Payable 2132 | Rp42,000.00 credit-normal |
| Current Year Earnings 3300 | Rp2,830,929,063.00 credit-normal |

The report balances mechanically from posted journals. It does not, however,
solve the USD unit problem: `p_usd_rate` is unused and raw functional values
remain in the 111102 balance.

## 3. Profit & Loss

P&L uses the Trial Balance output and correctly classifies revenue, COGS,
operating expenses, and other expenses. Direct Jan–Jul 2026 account checks
show:

- Salaries & Wages 6100: Rp203,024,500 net expense (salary correction does not
  duplicate the Rp2,500,000 expense).
- Bank Charges 7100: Rp2,202,120 total expense, including Rp63,000 for the 21
  Telkom repairs.
- PPh 23 is liability account 2132, not an expense.
- PPN Input 1150 is an asset/recoverable tax account, not an expense.
- Partial payments affect paid/AP state, not expense recognition.
- Salary advance account 1160 nets to zero after the advance application.

No P&L calculation bug was found beyond the shared USD-unit caveat inherited
from the Trial Balance RPC.

## 4. Bank Ledger

The Bank Ledger component intentionally presents statement-native movement and
separately computes an active GL closing balance. It excludes reversed journals
for the GL comparison. For USD it prefers `transaction_debit`/
`transaction_credit`, falling back to functional amounts when those are null.
That fallback is necessary for resilience but can display mixed units for the
historical contaminated rows.

Confirmed logic issue: bank-line display/reference resolution uses
`matched_expense_id`, `matched_receipt_id`, `matched_payment_id`, and
`matched_entry_id`; it does not load canonical allocations to establish
ownership. This can show stale or missing document references even when
`bank_statement_allocations` is authoritative.

The 21 Telkom rows are represented correctly in the journal layer: service
expense plus Rp3,000 account-7100 charge equals the actual bank debit, with one
canonical allocation per bank line.

## 5. AP / Payables

Direct payable calculation is correct:

| Voucher | Payable | Paid | Outstanding |
|---|---:|---:|---:|
| EXP/26-26/034 | Rp6,860,000 | Rp6,820,000 | **Rp40,000** |
| EXP/26-26/124 | Rp2,500,000 | Rp2,000,000 | Rp500,000 advance-clearing chain |

The `get_outstanding_expense_bills` RPC returned no rows for these vouchers
because it filters `finance_expenses.payment_method IS NULL`. Both rows retain
`payment_method = 'bank_transfer'`, even though EXP/26-26/034 has Rp40,000
outstanding AP. This is a confirmed report bug: outstanding AP must be based on
canonical payable minus paid/application state, not solely payment method.

## 6. Tax reports

PPh withholding remains represented in liability accounts and source expense
fields; payment state is separate. EXP/26-26/034 has PPh 23 Rp140,000 withheld
and unpaid, so it must remain payable. PPN recoverable remains in account 1150.
Tax-payment journals are separate remittance events and are not inferred from
supplier payment state.

The tax UI/register queries source expenses, tax periods, voucher allocations,
and tax payments rather than treating a paid expense as a remitted tax. No new
tax-report calculation defect was confirmed in this pass.

## 7. Bank Charges

Account 7100 contains the 21 repaired Telkom charges (Rp63,000 total) and
other existing bank-charge postings. The repaired accounting is:

`supplier/service amount + Rp3,000 bank charge = actual bank debit`

The current posting architecture already has a standard Bank Charges account
and `bank_charges_amount` field. Future utility/expense posting includes a
separate debit to 7100 and does not increase supplier AP. No redesign is
recommended.

## 8. Future USD/FX logic

The current fund-transfer posting function stores functional IDR journal
amounts separately from transaction-currency amounts, records the FX rate,
resolves bank-account COA/currency, validates positive amounts/rates, and only
creates allocations when a statement line is supplied. This is the correct
future direction.

Historical USD contamination remains outside this audit and requires source
evidence. The remaining report-level fix is to ensure Trial Balance/Balance
Sheet consumers use explicit currency conversion rules rather than silently
aggregating raw functional and transaction representations.

## 9. Report discrepancy matrix

| Report | Database truth | Report value/behavior | Match? | Bug | Required fix |
|---|---|---|---|---|---|
| Trial Balance | Posted, non-reversed journals balance in all tested periods | Same totals and filters | Yes (numeric) | USD rate parameter unused | Make currency basis explicit; do not mix units |
| Balance Sheet | Same posted journal basis; 3300 earnings once | Same rows and mechanical balance | Yes (numeric) | USD rate parameter unused | Currency-aware presentation/source policy |
| P&L | Expense/revenue account balances | Same Trial Balance-derived values | Yes | Inherits USD-unit caveat | Resolve currency basis upstream |
| Bank Ledger | Statement movement + active GL movement | Statement-native rows; GL side excludes reversals | Partial | Legacy `matched_*` references; USD fallback units | Resolve references from canonical allocations |
| AP/Payables | EXP/26-26/034 has Rp40,000 AP | Voucher absent from outstanding list | **No** | `payment_method IS NULL` gate | Filter by payable-minus-paid/application balance |
| Tax | PPh withheld is liability until remitted | Source/tax-payment separation preserved | Yes | None confirmed | Keep current separation |
| Bank Charges | 21 × Rp3,000 in 7100 and bank debit | Journal layer matches | Yes | None for future posting | Keep existing pattern |

## 10. Confirmed application bugs and minimal fixes

1. **Payables visibility:** remove the payment-method-only exclusion from the
   outstanding-expense-bills report; use canonical payable and paid/application
   balances.
2. **Canonical bank references:** Bank Ledger should resolve source documents
   from `bank_statement_allocations` first, using legacy `matched_*` fields only
   as compatibility metadata.
3. **Currency reporting clarity:** Trial Balance and Balance Sheet must either
   convert USD transaction fields using an evidenced rate or clearly label raw
   functional ledger values; the current rate parameter being ignored is
   misleading.

No production code or data was changed in this audit.

## 11. Correct and protected — do not touch

- All 23 completed historical repairs and their reversal/correction chains.
- Canonical allocation logic and reconciliation UI fixes already deployed.
- 20-Feb-2026 Rp3,651,500 split allocation.
- USD historical journals pending evidence.
- August 2026.
- Existing Bank Charges account and Telkom charge treatment.

## 12. Remaining external-evidence items

- Historical USD 111102 transfers/capital contributions and mixed statement
  legs.
- Opening/closing and overlapping statement populations.
- Unjournaled or allocation-metadata-gap statement rows.
- Any AP line whose source document/payment evidence conflicts with stored
  metadata.

## Validation

- `npm run typecheck` — pass
- `npm run build` — pass (existing chunk-size warnings only)
- `npm run lint -- --quiet` — pass
- `git diff --check` — pass
## Implementation follow-up (2026-08-25)

The three report/application defects identified by the read-only audit were
fixed in repository code only (no production database writes):

- `get_outstanding_expense_bills` now derives residual AP from payable minus
  canonical paid/application state and no longer excludes rows by
  `payment_method`. This exposes partial bank-transfer bills such as
  EXP/26-26/034 with its Rp40,000 balance.
- Bank Ledger now loads `bank_statement_allocations`, resolves every source
  document, displays allocation amounts (including split allocations), and
  uses legacy `matched_*` references only when no canonical allocation exists.
- Financial reports explicitly label their values as functional IDR. The USD
  rate is shown as a reference only; mixed historical USD/IDR values are never
  silently combined or presented as USD.

Regression coverage was added in
`tests/report-accounting-bug-regressions.test.mjs`. Historical journals,
allocations, bank statements, USD history, completed repairs, and August data
were not modified.
