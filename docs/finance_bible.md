# SAPJ ERP Finance Bible

Permanent technical and accounting reference for Finance Version 1.0

Document version: 1.0  
Effective date: 31 July 2026  
Functional currency: Indonesian Rupiah (`IDR`)  
Accounting basis: double-entry accrual accounting aligned to Indonesian PSAK
and the Indonesian tax treatment implemented by the ERP

## 1. Authority and change control

This is the normative reference for all Finance development. It consolidates
the database, posting, tax, currency, broker, salary, payment, receipt,
closing, reporting, import/export, migration, and coding rules implemented in
Finance Version 1.0.

When another document conflicts with this one, use the following precedence:

1. Applied production database constraints and current function definitions.
2. This Finance Bible.
3. `docs/finance_rules.md` and `docs/finance_architecture.md`.
4. Historical audit, hardening, migration, and release reports.

Historical audit documents are evidence, not current design authority.

Any pull request that changes a rule in this document must include, in the
same change:

- the reason and accounting impact;
- the database migration;
- updates to this document;
- regression tests for journals, reports, tax, and reconciliation;
- backward-compatibility and historical-data analysis;
- approval from the Finance owner or accountant when accounting treatment
  changes.

No developer may introduce a parallel calculation or posting engine to avoid
changing the canonical implementation.

## 2. Non-negotiable Finance invariants

1. Every accounting event is represented by one source document and one
   canonical posting path.
2. Client code never creates journal lines directly.
3. Every posted journal satisfies total debit equals total credit.
4. `journal_entry_lines.debit` and `.credit` are functional-currency accounting
   amounts in IDR.
5. Source-currency amounts remain in transaction fields; reports never revalue
   functional journal lines with a UI rate.
6. Draft and reversed journals do not contribute to financial statements.
7. No duplicate active posting may exist for the same source document.
8. A reversal preserves history. It does not erase the original accounting
   event.
9. Posted documents cannot be edited in place. Cancel, reverse, or use the
   module's approved repost process.
10. Closed periods are not editable without an authorized reopen and audit
    reason.
11. Recoverable PPN is an asset, not an expense.
12. Withheld PPh is a liability until remitted.
13. Supplier, customer, staff, bank, tax, AP, AR, and aging views must reconcile
    to their source documents and active journals.
14. Bank Reconciliation links accounting documents; it does not create a
    second journal for an already-posted document.
15. Historical accounting is changed only when the correction is provable
    from source evidence and is recorded in the audit trail.
16. `SECURITY DEFINER` Finance functions must use a fixed `search_path`, perform
    an authentication/role check, and deny `anon` and `PUBLIC` execution.

## 3. Finance architecture

The Finance module has three layers of authority:

```text
Source documents and masters
    Purchase, Sales, Expense, Broker, Salary, Payment, Receipt,
    Petty Cash, Fund Transfer, Tax Payment, Bank Statement
                         |
                         v
Canonical database commands and posting functions
    validation -> allocation -> journal -> audit -> reconciliation link
                         |
                         v
Journal-native accounting and reporting
    GL -> party ledgers -> AP/AR -> Trial Balance -> P&L ->
    Balance Sheet -> tax reports -> CA reports
```

The database is the accounting authority. React components are workflow and
presentation clients. They may format values and collect input, but they may
not define independent accounting outcomes.

### 3.1 Canonical source hierarchy

| Concern | Canonical authority |
|---|---|
| Posted accounting | Active `journal_entries` and `journal_entry_lines` |
| Chart classification | `chart_of_accounts` |
| Expense payable | `calculate_finance_expense_payable(uuid)` |
| Customs Broker totals | `calculate_customs_broker_invoice(uuid)` and `vw_customs_broker_accounting` |
| Payment currency model | `save_payment_voucher_command` and `post_payment_voucher` |
| Receipt save/allocation | `save_receipt_voucher_with_allocations` |
| Invoice allocation | `voucher_allocations` and invoice balance RPCs |
| Trial Balance | `get_trial_balance` |
| Balance Sheet | `get_balance_sheet` |
| P&L | active journal lines classified by `chart_of_accounts` |
| Input/Output PPN | journal-native tax views |
| PPh payable mapping | `fn_pph_payable_account_id` and tax code |
| Bank match state | `bank_statement_lines` typed links and reconciliation status |
| Salary Advance balance | `salary_advance_applications` and Salary Advance RPCs |
| Import template columns | `src/data/finance-import-templates.json` |
| Migration state | repository files plus Supabase migration history |

## 4. Database schema

This section maps the stable Finance schema. It is an object map, not a
replacement for generated PostgreSQL schema documentation.

### 4.1 Accounting core

| Object | Purpose and key relationships |
|---|---|
| `chart_of_accounts` | Account master. Self-referencing hierarchy. Referenced by every journal line and mapped bank account. |
| `accounting_periods` | Monthly fiscal periods with `open`, `closed`, or `locked` status. |
| `journal_entries` | Journal header. Key identity is `source_module`, `reference_id`, and `reference_number`; stores posting and reversal state. |
| `journal_entry_lines` | General Ledger detail. Belongs to one journal and one account; may carry customer, supplier, batch, and tax references. |
| `audit_logs` | Immutable mutation evidence for Finance-critical actions. |

### 4.2 Payables and purchasing

| Object | Purpose and key relationships |
|---|---|
| `suppliers` | Supplier master, NPWP/PKP and payment defaults. |
| `purchase_invoices` | Supplier invoice header, currency, tax, paid and balance state. |
| `purchase_invoice_items` | Inventory/expense lines and landed-cost components. |
| `finance_expenses` | Operating, staff, utility, fixed-asset, PIB, and Customs Broker source documents. |
| `payment_vouchers` | Supplier/staff payment document and canonical currency fields. |
| `voucher_allocations` | Payment-to-purchase/expense and receipt-to-sales allocations. |
| `salary_advance_applications` | Auditable FIFO link between an advance payment, Salary expense, and settlement voucher. |

### 4.3 Receivables and sales

| Object | Purpose and key relationships |
|---|---|
| `customers` | Customer master and Indonesian regulatory identifiers. |
| `sales_invoices` | Customer invoice, PPN/Faktur, payment and delivery links. |
| `sales_invoice_items` | Product, batch, quantity, price, PPN, and COGS source. |
| `receipt_vouchers` | Customer receipt document. |
| `credit_notes` | Customer credit adjustment and source links. |

### 4.4 Cash, bank, and operational Finance

| Object | Purpose and key relationships |
|---|---|
| `bank_accounts` | Bank/cash master. `coa_id` maps each account to the GL. |
| `bank_statement_lines` | Imported statement lines and typed links to native Finance documents. |
| `bank_reconciliations` / reconciliation items | Reconciliation sessions and legacy match records. |
| `petty_cash_transactions` | Standalone Petty Cash activity and Fund Transfer child rows. |
| `petty_cash_books` / vouchers / files | Petty Cash configuration, documents, and attachments. |
| `fund_transfers` | Bank/cash transfer source document owning one journal. |
| `loans`, `loan_transactions` | Loan principal and repayment source documents. |
| `capital_contributions` | Owner capital source documents. |

### 4.5 Tax and compliance

| Object | Purpose and key relationships |
|---|---|
| `tax_codes` | PPN/PPh type, rate, withholding flag, and control-account mapping. |
| `organization_tax_settings` | NPWP/PKP and Faktur numbering settings. |
| `tax_periods` | Monthly period per tax type, due dates, filing state, close state, and snapshots. |
| `tax_payments` | Government remittance linked to period, bank, and journal. |
| `tax_payment_files` | Billing, NTPN, receipt, and transfer evidence. |
| `faktur_pajak` | Faktur identity and status for a sales invoice. |
| `faktur_pajak_files` | Official Faktur files. |
| `tax_calendar_config` | Configurable Indonesian tax due-date rules. |

### 4.6 Finance masters and controls

| Object | Purpose and key relationships |
|---|---|
| `finance_staff_master` | Staff identity used by Salary and staff expenses. |
| `finance_utility_master` | Utility provider and default supplier/GL mapping. |
| `approval_workflows` / `approval_thresholds` | Shared approval engine. |
| `finance_historical_repair_*` | Controlled repair runs, items, exceptions, and verification evidence. |
| Integrity views | `unbalanced_journal_entries`, `duplicate_postings`, `orphan_journal_lines`, `missing_petty_cash_links`, and `negative_cash_anomalies`. |

### 4.7 Currency columns

Source documents use explicit currency metadata. The key meanings are:

| Field | Meaning |
|---|---|
| `transaction_currency` | Currency in which the source event is denominated. |
| `functional_currency` | Reporting currency; always IDR for Version 1.0. |
| `exchange_rate` | Conversion rate defined by the source command. |
| `transaction_debit` / `transaction_credit` | Source-currency journal-line values. |
| `debit` / `credit` | Functional IDR journal-line values. |
| `invoice_currency` / `invoice_amount` | Currency and gross amount of invoices settled by a payment. |
| `payment_currency` / `payment_amount` | Currency and net settlement amount before bank conversion. |
| `bank_currency` | Currency of the selected bank account. |
| `converted_amount` | Net settlement converted to bank currency before charges. |
| `actual_bank_debit` | Actual cash outflow including bank charges and differences. |

## 5. Chart of Accounts and normal balances

| Range | Type | Normal balance | Principal examples |
|---|---|---|---|
| `1xxx` | Assets | Debit | Cash 1101, Petty Cash 1102, AR 1120, Inventory 1130, Input PPN 1150, Staff Advance 1160 |
| `2xxx` | Liabilities | Credit | AP 2110, Output PPN 2130, PPh21 2131, PPh23 2132, PPh22 2137, PPh4(2) 2138 |
| `3xxx` | Equity | Credit | Capital 3100, Retained Earnings 3200, Current Year Earnings 3300 |
| `4xxx` | Revenue/contra revenue | Credit | Sales 4110/4120 and return/discount contra accounts |
| `5xxx` | COGS | Debit | Material 5100, duty/freight/import costs 5200/5300 |
| `6xxx` | Operating expense | Debit | Salary 6100, rent/utilities 6200/6300, professional fees 6410 |
| `7xxx` | Other expense | Debit | Bank charges 7100, interest 7200, FX difference 7300 |

Account codes are configuration identities used by posting functions. Renaming
or repurposing a seeded code is a breaking accounting change. Add a new account
or migrate every dependent function; never silently reuse an existing code for
a different economic meaning.

## 6. Universal journal rules

### 6.1 Active accounting filter

A journal contributes to reports only when:

```text
is_posted = true
AND COALESCE(is_reversed, false) = false
```

### 6.2 Journal identity and idempotency

- `entry_number` is generated by the centralized number generator.
- `source_module` identifies the owner.
- `reference_id` points to the source record.
- The source module owns posting, cancellation, reversal, and deletion.
- A link or report may not create another journal for the same event.
- Reposting must first cancel/reverse/replace the prior active journal using
  the module's guarded database path.

### 6.3 Line rules

- `account_id` is mandatory and must reference an active CoA row.
- A normal line has either debit or credit, not both.
- Supplier/customer/staff attribution belongs on relevant lines so party
  ledgers can filter the same journal.
- Tax lines use the configured tax control account.
- Header totals must equal line sums after every posting or repost.

## 7. Journal posting rules by workflow

| Workflow | Debit | Credit |
|---|---|---|
| Sales Invoice | AR; COGS | Revenue; Output PPN; Inventory |
| Purchase Invoice | Inventory/asset/expense; recoverable Input PPN | Supplier AP |
| Ordinary outstanding Expense | Expense/asset; recoverable Input PPN | AP; PPh payable |
| Ordinary paid Expense | Expense/asset; recoverable Input PPN | Bank/cash; PPh payable |
| Payment Voucher | AP; bank charge; FX loss when applicable | Bank/cash; PPh payable; FX gain when applicable |
| Receipt Voucher | Bank/cash | AR |
| Petty Cash expense | Expense/asset | Petty Cash |
| Petty Cash replenishment | Petty Cash | Bank/cash |
| Fund Transfer | Destination bank/cash | Source bank/cash |
| Salary expense | Salary/employee expense | Staff payable or bank; PPh21 payable when withheld |
| Salary Advance | Staff Advance asset | Bank/cash |
| Salary Advance recovery | Salary/staff payable settlement | Staff Advance asset through the settlement voucher |
| Tax Payment | Tax payable | Bank |
| Capital contribution | Bank/cash | Owner capital |
| Loan receipt | Bank/cash | Loan liability |
| Loan repayment | Loan liability and interest expense as applicable | Bank/cash |

Specific functions and configured account mappings take precedence over this
summary table.

## 8. Expense and payable engine

The expense document stores source values. AP consumers use
`calculate_finance_expense_payable(expense_id)`.

For an ordinary expense:

```text
payable = amount
        + ppn_amount
        - pph_amount
        + stamp_duty_amount
        + utility bank charges, when category = utilities
```

Accounting treatment remains separate:

- expense or asset base is debited to the configured category account;
- creditable PPN is debited to Input PPN;
- PPh withheld is credited to the liability selected by `pph_code_id`;
- outstanding payment credits AP;
- immediate payment credits the selected bank/cash account.

The UI may display the canonical payable and breakdown, but must not calculate
a different AP value.

## 9. Customs Broker accounting rules

### 9.1 Canonical functions

- `broker_reimbursement_line_total(jsonb)`
- `calculate_customs_broker_invoice(uuid)`
- `vw_customs_broker_accounting`
- `post_customs_broker_canonical()`
- `calculate_finance_expense_payable(uuid)`

### 9.2 Implemented formulas

For each reimbursement line:

```text
reimbursement_line_total = COALESCE(amount, 0)
                         + COALESCE(dpp_amount, 0)
                         + COALESCE(ppn_amount, 0)

reimbursement_total = SUM(reimbursement_line_total)

broker_invoice_amount = finance_expenses.amount

expense_total = broker_invoice_amount
              + reimbursement_total
              + stamp_duty_amount

recoverable_input_ppn = header ppn_amount
                      + SUM(reimbursement ppn_amount)

pph23_withheld = finance_expenses.pph_amount

final_cash_payable = expense_total
                   + header ppn_amount
                   - pph23_withheld
```

`expense_total` already contains reimbursement-line PPN through each gross
`reimbursement_line_total`. Reimbursement PPN is therefore classified once as
Recoverable Input PPN in the journal and is not added to cash payable again.

### 9.3 Supplier separation

- The broker supplier receives the broker service debit, broker Input PPN,
  PPh23 withholding, and broker payable/payment lines.
- Each reimbursement line uses its own `supplier_id` for its expense, Input
  PPN, and payable/payment lines.
- Supplier ledgers must filter journal lines by supplier; they must not assign
  all reimbursement activity to the broker.
- Missing line supplier defaults to the broker only for backward compatibility.

### 9.4 Certified reference transaction

For `EXP/26-26/113`:

| Value | Amount |
|---|---:|
| Broker Invoice Amount | Rp 3,100,000 |
| Reimbursement Total | Rp 9,127,503 |
| Expense Total | Rp 12,227,503 |
| Recoverable Input PPN | Rp 457,695 |
| PPh23 | Rp 62,000 |
| Final Cash Payable | Rp 12,165,503 |

The reimbursement line totals are Rp 5,042,574, Rp 3,476,629,
Rp 588,300, and Rp 20,000. These values are permanent regression fixtures.

## 10. Cross-currency rules

### 10.1 Definitions

The payment exchange rate means:

```text
1 invoice-currency unit = N bank-currency units
```

Therefore:

- USD invoice to IDR bank normally uses a rate greater than 1.
- IDR invoice to USD bank normally uses a positive rate less than 1.
- Same-currency payment uses rate 1.
- Currency is never inferred from an amount or account name.

### 10.2 Payment calculations

```text
payment_amount = invoice_amount - pph_withheld
converted_amount = payment_amount * effective exchange_rate
expected_bank_debit = converted_amount
                    - withholding converted to bank currency
                    + bank_charges
fx_difference = actual_bank_debit - expected_bank_debit
```

The posting function uses stored canonical fields and posts any residual to the
configured FX difference account. It must not silently force actual cash to an
expected amount.

### 10.3 Functional reporting

- Functional reporting currency is IDR.
- Journal `debit`/`credit` are already functional IDR.
- Transaction amounts/rates are retained for audit and document display.
- Trial Balance, P&L, and Balance Sheet sum functional lines directly.
- The compatibility `p_usd_rate` report parameter must not revalue posted
  journal amounts.

### 10.4 Permanent payment regression

```text
Invoice amount:       USD 21,000
Bank:                 BCA IDR
Exchange rate:        16,990
Converted amount:     Rp 356,790,000
Bank charges:         Rp 50,000
Actual bank debit:    Rp 356,840,000
```

The payment, bank ledger, supplier ledger, allocation, and journal must retain
these meanings without overloading one field.

## 11. Payment engine

### 11.1 Canonical lifecycle

```text
PaymentVoucherManager
  -> save_payment_voucher_command
  -> save_payment_voucher_with_allocations
  -> payment_vouchers + voucher_allocations
  -> post_payment_voucher
  -> journal_entries + journal_entry_lines
  -> supplier/staff/AP state
  -> optional bank_statement_lines link
```

`save_payment_voucher_with_purpose` wraps the same command for Salary Advance
and settlement purposes. It does not create a second payment engine.

### 11.2 Required canonical fields

- Invoice currency and invoice amount
- Payment currency and payment amount
- Bank currency
- Exchange rate
- Converted amount
- Bank charge
- Actual bank debit
- Functional currency amount on the journal
- Supplier or staff identity
- Allocation rows

### 11.3 Posting behavior

- Debit AP in functional currency.
- Debit Bank Charges when present.
- Credit PPh payable when withholding applies.
- Credit the selected bank by actual bank debit.
- Post the residual difference to FX gain/loss.
- Attach supplier/staff identity to the relevant lines.
- Set `is_posted` and `journal_entry_id` only after the balanced journal exists.
- Write an audit record.

### 11.4 Edit, cancellation, reversal, and deletion

- A posted voucher is immutable until posting is cancelled through the guarded
  workflow.
- Allocation changes must recalculate invoice/expense paid and outstanding
  state.
- Unlinking Bank Reconciliation changes match/payment state only; it does not
  rewrite historical journal currency.
- Deletion must release allocations and reconciliation links and remove or
  reverse the owned journal atomically.
- Never delete and recreate a historical voucher merely to fix display data.

## 12. Receipt engine

### 12.1 Canonical lifecycle

```text
ReceiptVoucherManager
  -> save_receipt_voucher_with_allocations
  -> receipt_vouchers + voucher_allocations
  -> post_receipt_voucher
  -> Dr Bank/Cash, Cr AR
  -> customer ledger and AR state
  -> optional bank reconciliation link
```

### 12.2 Rules

- Customer is mandatory.
- Amount must be positive.
- Bank account and document currency metadata must be explicit.
- Allocations point to sales invoices/orders and may not exceed available
  invoice balance except for an approved rounding tolerance.
- Posted receipts are immutable until cancellation.
- Receipt editing replaces allocations atomically while unposted.
- Customer Ledger, AR, aging, bank ledger, and reconciliation consume the same
  voucher and allocation records.

The current receipt command is stricter than the payment model for mismatched
bank/document currency. Extending cross-currency receipts requires a canonical
database design and migration; it must not be implemented only in the UI.

## 13. Salary and Salary Advance rules

### 13.1 Salary expense

- Salary is a `finance_expenses` document with `expense_category = 'salary'`.
- `staff_id` is mandatory for staff accounting.
- Salary base is posted to the configured staff/Salary expense account.
- PPh21 withholding credits the PPh21 liability account selected through the
  tax code.
- Outstanding Salary is visible as a staff payable; payment uses the normal
  Payment Voucher engine.

### 13.2 Salary Advance

- A Salary Advance is a Payment Voucher with
  `payment_purpose = 'salary_advance'` and a `staff_id`.
- Posting debits Staff Advance (asset) and credits bank/cash.
- Status progression is `outstanding` -> `partially_settled` -> `settled`.
- Applied amount is stored on the voucher and split evidence is stored in
  `salary_advance_applications`.

### 13.3 Advance recovery

`apply_salary_advances_to_expense`:

1. locks the Salary expense and available advances;
2. selects posted advances for the same staff oldest first;
3. creates one normal Payment Voucher settlement using
   `payment_method = 'advance_adjustment'`;
4. posts through `post_payment_voucher`;
5. records exact advance-to-Salary splits;
6. refreshes advance status;
7. leaves any excess advance outstanding for a future Salary.

Repeated execution is idempotent for the same advance/Salary pair.

### 13.4 Payroll boundary

Version 1.0 records Salary, deductions, PPh21, advances, payments, and staff
ledger effects. It is not a full statutory payroll calculation engine.
Statutory gross-up, PTKP, BPJS, annualization, and employee tax certificate
logic must not be inferred from the current expense form. Adding those is a
future controlled payroll project.

## 14. Indonesian tax engine rules

### 14.1 Core tax treatment

| Tax | Accounting treatment |
|---|---|
| Recoverable Input PPN | Debit asset account 1150; never increase expense solely because it is recoverable. |
| Output PPN | Credit liability account 2130. |
| PPh21 withheld | Credit liability 2131. |
| PPh23 withheld | Credit liability 2132. |
| PPh22 | Use configured import/withholding treatment and account 1155/2137 as defined by the source workflow. |
| PPh4(2) withheld | Credit liability 2138. |
| Bea Meterai | Expense/payable according to source document and configured accounts. |

Tax rates and legal due dates can change. The configured `tax_codes` and
`tax_calendar_config` are operational parameters. A developer must not embed a
new statutory rate in a component without a reviewed tax-rule migration.

### 14.2 Journal-native tax reports

- Input PPN comes from active posted lines on account 1150.
- Output PPN comes from active posted lines on account 2130.
- PPh reports derive from the corresponding active posted control-account
  lines and period metadata.
- Source documents provide reference, supplier/customer, NPWP, Faktur, and
  description metadata; they do not override the GL amount.
- Tax payments clear the same liability accounts through the normal journal.

Canonical views include:

- `vw_input_ppn_report`
- `vw_output_ppn_report`
- `vw_ppn_net_by_period`
- `vw_pph_by_period_type`
- `vw_outstanding_tax`
- `vw_tax_period_status`
- `vw_monthly_tax_summary`

### 14.3 Period attribution and recomputation

Sales invoices, purchase invoices, Finance expenses, and payment withholding
are attributed to tax periods by database triggers. Mutations recompute the
relevant period snapshots. Companion PPh periods are created for the month.

### 14.4 Faktur Pajak

- Faktur number assignment occurs only through the Faktur RPC.
- The sequence is protected by an advisory transaction lock.
- A sales invoice has at most one active Faktur identity.
- Issue, upload, report, cancel, and attachments remain auditable.
- Missing required Faktur blocks PPN period close.

### 14.5 Tax payments and closing

Tax payment posting:

```text
Dr Tax payable
Cr Bank
```

The payment stores billing code, NTPN, government reference, payment reference,
attachments, journal link, and reconciliation status.

A tax period may close only after the close RPC verifies no required Faktur is
missing, no relevant drafts or unposted tax journals remain, no tax payment is
unreconciled, and no tax amount remains outstanding. Reopening requires admin
authority, a reason, and an audit record.

## 15. Bank Reconciliation

### 15.1 Single-source rule

`bank_statement_lines` is the imported bank statement source. It links to a
native Finance document through typed foreign keys and, where required, the
document journal. It does not own a parallel accounting document.

### 15.2 Supported operations

- link, unlink, and relink;
- partial and multiple payments;
- multiple invoice allocations;
- cross-currency bank amounts;
- expense, receipt, payment, transfer, Petty Cash, tax, loan, capital, and
  approved manual-journal sources.

### 15.3 Integrity rules

- A matched line has one valid economic owner.
- Typed target and journal references must agree.
- Unlinking recalculates document paid state.
- Linking an existing document never creates a duplicate journal.
- A journal-only bank link is disallowed except for the explicitly supported
  Payment Voucher compatibility path.
- Reconciliation cannot mutate the economic amount of an already-posted
  source document.

## 16. Report definitions

### 16.1 Common report source

Financial reports use active posted functional journal lines joined to the
Chart of Accounts. Source tables may supply names, references, maturity dates,
or allocation status, but may not redefine GL balances.

### 16.2 General Ledger and account drill-down

For each account and period:

```text
movement = SUM(debit - credit)
running balance = opening balance + cumulative movement
```

Bank Ledger is the same GL principle restricted to bank-mapped accounts and
enriched with statement links. Cash Book uses cash/Petty Cash accounts.

### 16.3 Party, Supplier, Customer, and Staff Ledgers

- Party ledgers use source documents, allocations, and journal lines carrying
  the corresponding party identifier.
- Supplier Ledger includes supplier invoices/expenses, allocated payments,
  and outstanding balances.
- Customer Ledger includes sales invoices, receipts, credit notes, and
  outstanding balances.
- Staff Ledger includes Salary/staff expenses, Salary Advances, settlements,
  and payments.
- A ledger drill-down must open the source document or its owned journal.

### 16.4 Accounts Payable and AP aging

- Purchase Invoice outstanding derives from invoice total less posted payment
  allocations.
- Expense outstanding uses `get_outstanding_expense_bills`, which calls
  `calculate_finance_expense_payable`.
- Aging buckets are based on due date relative to the report as-of date.
- Supplier and staff identity must remain distinct.

### 16.5 Accounts Receivable and AR aging

- AR outstanding is invoice total less canonical posted receipt allocations
  and approved rounding adjustments.
- Aging uses invoice due date and an explicit as-of date.
- A negative remaining amount or unexplained overpayment is an integrity
  exception, not a display convention.

### 16.6 Trial Balance logic

`get_trial_balance(start_date, end_date[, compatibility_rate])`:

1. selects active posted journals within the inclusive date range;
2. groups lines by active non-header account;
3. calculates `total_debit`, `total_credit`, and
   `balance = total_debit - total_credit`;
4. omits zero-activity accounts;
5. orders by account code.

The compatibility rate argument does not revalue functional journal lines.
The sum of Trial Balance debit must equal the sum of Trial Balance credit.

### 16.7 Profit & Loss logic

For the report period:

```text
revenue = SUM(revenue credits - revenue debits)
expense = SUM(expense debits - expense credits)
net income = revenue - expense
```

The detailed UI groups expense accounts into COGS, Operating Expenses, and
Other Expenses from `account_group`. Recoverable Input PPN, AP, cash movement,
and PPh liabilities do not belong in P&L.

### 16.8 Balance Sheet logic

`get_balance_sheet(as_of_date[, compatibility_rate])`:

1. sums active posted lines through the as-of date;
2. returns asset, liability, equity, and contra accounts;
3. derives current net income from revenue and expense accounts;
4. emits synthetic Current Year Earnings account 3300 when no posted 3300
   close entry exists;
5. reports balances using functional journal amounts.

Balance Sheet validation is:

```text
Assets = Liabilities + Equity, including Current Year Earnings
```

### 16.9 CA and tax reports

CA reports are alternate presentations of the same journals, invoices,
allocations, inventory, and bank data. They may not maintain a separate
balance. Tax reports use the journal-native tax views in section 14.

## 17. Month-end closing process

Month-end is an operational control process. Tax-period database locks are
stronger than the current general accounting-period lock, so the close owner
must perform and retain this checklist.

### 17.1 Pre-close

1. Confirm all source documents for the month are entered and approved.
2. Post purchase, sales, expense, Salary, receipt, payment, Petty Cash, fund
   transfer, tax, and manual journal documents.
3. Resolve drafts and rejected documents that should not remain open.
4. Complete bank reconciliation through month-end.
5. Reconcile supplier, customer, and staff balances to AP/AR.
6. Verify inventory and landed costs for all received/imported batches.
7. Confirm Input/Output PPN, PPh registers, Faktur, and tax payments.
8. Record approved accruals, depreciation, prepaid amortization, FX
   adjustments, and stock adjustments through source-owned or manual journals.

### 17.2 Integrity gate

Run and retain evidence that:

- no unbalanced active journal exists;
- no duplicate posting exists;
- no orphan journal line or allocation exists;
- no invalid bank/reconciliation link exists;
- Trial Balance debit equals credit;
- P&L net income agrees with Balance Sheet Current Year Earnings;
- AP/AR aging totals agree with their control accounts;
- bank and cash balances agree with reconciled statements/cash counts;
- tax reports agree with tax control accounts.

### 17.3 Close

1. Export Trial Balance, P&L, Balance Sheet, GL, AP/AR aging, bank ledger,
   tax reports, and CA reports.
2. Close each tax period through `close_tax_period` after its blockers are zero.
3. Mark the matching `accounting_periods` row closed through the authorized
   Finance close procedure.
4. Store close evidence and reviewer approval outside mutable transactional
   screens.

### 17.4 Reopen

Reopen only for a documented correction. Record who authorized it, the reason,
affected documents, before/after reports, and the new close evidence. Tax
period reopen must use `reopen_tax_period`.

## 18. Year-end closing process

Version 1.0 does not contain a dedicated automated year-end close RPC. Year-end
is therefore a controlled accountant-approved process using the existing
period, report, and manual-journal engine.

### 18.1 Year-end checklist

1. Complete all month-end steps for the final fiscal month.
2. Lock operational subledgers after final adjustments.
3. Confirm inventory valuation and physical stock reconciliation.
4. Confirm fixed assets, depreciation, impairment, accruals, prepayments,
   provisions, loans, capital, and tax balances.
5. Obtain final Trial Balance, P&L, Balance Sheet, cash flow/CA reports, and tax
   reports.
6. Confirm all twelve months and tax periods are closed or have documented
   exceptions.
7. Back up the database and retain signed year-end exports.

### 18.2 Earnings close

Before a year-end journal is posted, the accountant must approve the exact
entry. The normal concept is to transfer Current Year Earnings (`3300`) to
Retained Earnings (`3200`), with debit/credit direction determined by whether
the year produced profit or loss.

The entry must be created through `save_finance_journal`, dated on the approved
closing date, balanced, audited, and reviewed. Developers must not automate or
infer this entry without a separately approved year-end design. Once a real
3300 entry exists, Balance Sheet reporting uses it instead of synthesizing
Current Year Earnings.

### 18.3 Opening the new year

- Balance Sheet accounts carry forward through cumulative journals.
- Revenue and expense reporting starts from the new fiscal-period start date.
- Verify opening assets equal liabilities plus equity.
- Verify retained earnings agrees with approved prior-year close evidence.
- Do not copy source documents or duplicate prior-year journals.

## 19. Import and export specifications

### 19.1 Canonical import schemas

The machine-readable authority is
`src/data/finance-import-templates.json`. CSV examples are in
`public/templates/`.

| Template | Required columns |
|---|---|
| Expenses | 17 columns including broker breakdown, tax, total, and currencies |
| Payment Vouchers | 18 columns including all canonical cross-currency fields |
| Receipt Vouchers | 15 columns including invoice, receipt, bank, rate, converted, and cash fields |
| Petty Cash | 8 columns |
| Salary | 10 columns including gross, deductions, PPh21, advance adjustment, and net |
| Bank Statement | 8 columns |
| Manual Journal | 10 columns including line/account/debit/credit/currency/rate |

`npm run verify:finance-imports` must pass whenever a template or importer
changes.

### 19.2 Import rules

- Validate header names and order against the manifest.
- Parse dates explicitly; never rely on locale guessing.
- Resolve supplier, customer, staff, bank, and account by stable code/key.
- Reject unknown or ambiguous master references.
- Validate currency and exchange-rate combinations.
- Group manual-journal lines by journal identity and verify balance before
  writing.
- Use canonical save/post commands; an importer may not insert journal lines
  directly.
- Return row-level errors without partially posting an invalid document.
- Make repeated imports idempotent through stable external/reference keys.

### 19.3 Export rules

- Export current canonical fields and explicit currency labels.
- Escape spreadsheet-formula prefixes and CSV delimiters.
- Include source identity, date, reference, amount breakdown, and status.
- Financial exports use active journals and the same report date filters as the
  UI.
- PDF/print documents use the immutable company snapshot attached to the
  source document; do not substitute a current company profile for a missing
  historical snapshot.
- Dates display as `dd/MM/yyyy`; short compact contexts may use `dd/MM/yy`.

## 20. Migration policy

### 20.1 Current Version 1.0 history

At certification, local and linked migration histories contained 648 versions
each, with zero duplicate, local-only, or remote-only versions. Duplicate
timestamp source files are retained outside the active migration directory in
`supabase/migration_backlog/duplicate_timestamps/`.

### 20.2 Rules for new migrations

1. Use a new monotonic UTC timestamp; never reuse a version.
2. Never edit an already-applied migration to change production behavior.
3. Create a new corrective migration for every applied-schema change.
4. Make DDL safe on partially applied environments where practical using
   `IF EXISTS`, `IF NOT EXISTS`, and explicit object-signature checks.
5. Use `CREATE OR REPLACE` carefully: replacing a function can restore obsolete
   accounting logic.
6. Drop/recreate overloaded functions explicitly when changing return types or
   defaults.
7. Revoke `PUBLIC`/`anon` function execution and grant only intended roles.
8. Use fixed `search_path` for privileged functions.
9. End schema-changing RPC/view migrations with PostgREST schema reload when
   required.
10. Separate schema evolution from historical repair when possible.
11. Historical repair must generate before/expected/impact evidence, update
    only provably inconsistent records, and write audit evidence.
12. Test every migration in a transaction/rollback or disposable database
    before production.
13. Run migration reconciliation after adding or applying migrations.

### 20.3 Prohibited migration actions

- Blindly mark mismatches applied.
- Delete or rename an applied migration from active history.
- Replay an obsolete posting function over a newer one.
- Guess historical exchange rates, accounts, suppliers, tax treatment, or
  source identities.
- Squash the production upgrade path before a separately approved baseline
  strategy and clean-install/upgrade equivalence test.

### 20.4 Future baseline strategy

Existing production databases continue incremental migration history. A new
installation baseline may be generated only after schema, functions, triggers,
views, policies, grants, storage, and seed data are compared against the
reconciled production schema. Future migrations must be tested both from the
baseline and from a production-shaped upgrade database.

## 21. Finance coding standards

### 21.1 Database-first accounting

- Put business-critical calculations in one canonical database function or
  shared pure helper with an explicit database contract.
- Posting, authorization, locking, and audit belong in PostgreSQL RPCs/triggers.
- React may calculate a preview only when it calls the same shared helper and
  the database revalidates before saving/posting.
- Never trust a nullable persisted total when the canonical value is safely
  derivable.

### 21.2 TypeScript and UI

- Strict TypeScript must pass.
- No ESLint errors are allowed.
- Use `formatCurrency`, `resolveTransactionCurrency`, and shared date utilities.
- Display labels with unambiguous accounting meaning: Expense Total, Broker
  Invoice, Reimbursements, Recoverable PPN, PPh, and Cash Payable.
- Do not label broker amount or bank amount as generic `Amount` when multiple
  monetary meanings exist.
- Drill-down components receive canonical data or source IDs; they do not
  reconstruct accounting totals independently.

### 21.3 SQL functions

- Schema-qualify Finance objects.
- Set `search_path = public, pg_temp` or a narrower safe path.
- Authenticate and authorize at function entry.
- Lock source rows before posting/cancelling mutable financial state.
- Validate required accounts and reject missing mappings.
- Construct lines, verify balance, then mark the document posted.
- Record mutation evidence in `audit_logs`.
- Revoke `PUBLIC` and `anon`; grant exact signatures to intended roles.

### 21.4 Names and semantics

- One field has one meaning.
- Do not overload invoice amount, payment amount, bank amount, or functional
  amount.
- Use `source_module` values consistently.
- Preserve source-document identity through edits/reposts.
- Use stable codes for accounts and masters in imports and integrations.

### 21.5 Deletion and reversals

- Never issue ad hoc deletes against Finance source or journal tables.
- Use a module-owned atomic delete/reverse RPC.
- Release allocations and bank links before deleting an owned document.
- Self-verify that no orphan remains; raise an exception to roll back on any
  failed invariant.

## 22. Required regression gates

Before merging or deploying a Finance change, run at minimum:

```text
npm run typecheck
npm run lint
npm run build
npm run verify:finance-navigation
npm run verify:finance-imports
npm run verify:finance-release
node scripts/reconcile-v1-migrations.mjs
git diff --check
```

The Finance release regression must remain authenticated and transactional,
and must roll back its test records. It currently covers Salary Advance,
Salary recovery, Bank Reconciliation unlink/relink, journal balance/orphans,
Trial Balance, P&L, Balance Sheet, report contracts, Petty Cash, Customs Broker
canonical values, and anonymous privileged-function denial.

Any changed workflow needs an additional permanent test for create, edit,
approve/post, cancel/reverse, delete where allowed, allocations, reconciliation,
reports, tax, and audit trail.

## 23. Production monitoring and incident rules

Monitor these integrity views and conditions:

- unbalanced posted journals;
- duplicate active postings;
- orphan journal lines or allocations;
- missing Petty Cash links;
- invalid bank statement links;
- negative unexplained cash or stock balances;
- AP/AR overpayments and stale paid states;
- tax periods with stale/unreconciled data;
- anonymous execution grants on privileged Finance functions;
- migration history drift.

If an accounting incident occurs:

1. stop the affected posting path;
2. preserve source and journal evidence;
3. reproduce the calculation without changing production;
4. determine existing versus expected canonical values;
5. list every affected ledger, report, tax period, and reconciliation link;
6. obtain Finance approval for historical correction;
7. repair through an idempotent migration or controlled RPC;
8. rerun all regression and integrity checks;
9. update this Bible if a rule changed.

## 24. Version 1.0 known boundaries

These are explicit product boundaries, not permission to create local
workarounds:

- Functional currency is IDR.
- Full statutory payroll computation is not implemented.
- Year-end earnings close is a controlled manual-journal process.
- General accounting-period locking is not as comprehensive as tax-period
  database locking and requires operational close discipline.
- Cross-currency receipts require a separately approved canonical extension.
- Historical manual-review exceptions remain unchanged until evidence proves a
  correction.
- Performance optimization of large frontend chunks is a Version 1.1 concern;
  accounting correctness takes precedence.

## 25. Definition of done for future Finance changes

A Finance change is complete only when:

- one canonical calculation/posting path exists;
- source, journal, ledger, report, tax, reconciliation, and audit outcomes
  agree;
- no duplicate or orphan record is possible;
- security grants and RLS are correct;
- migrations are deterministic and idempotent;
- strict TypeScript, ESLint, build, Finance regression, imports, navigation,
  migration reconciliation, and diff checks pass;
- operational and historical impacts are documented;
- this Finance Bible is still accurate.
