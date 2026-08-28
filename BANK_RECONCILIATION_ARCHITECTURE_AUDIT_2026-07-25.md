# Final Bank Reconciliation Architecture Audit

**Audit date:** 2026-07-25

**Scope:** Current working tree, React/Supabase call sites, and ordered migration source in `supabase/migrations`.

**Mode:** Read-only architecture audit. No application code, schema, or business data was changed.
**Runtime boundary:** The workspace contains only an anonymous Supabase key. Finance reads return an empty RLS result and no authenticated test database/session or local Docker database is available. Therefore this report does not claim that test documents were created. Static payload equality is proven below; empirical row equality remains a required acceptance test in a controlled database.

## Executive conclusion

Bank Reconciliation is **not** a smart entry point into the native Finance modules today. It contains its own document creation, numbering, validation, posting orchestration, journal classification, and linking logic.

The required invariant—“the same document service/RPC/business logic as the native module”—fails as follows:

- **Record Expense:** fails completely. Bank Reconciliation inserts a four-field legacy expense payload. Native Expense Manager builds a much larger validated payload and generates a voucher number.
- **Record Receipt:** uses the same low-level numbering and posting RPCs, but duplicates header/allocation creation and changes the lifecycle by posting immediately. It does not use one shared save service.
- **Record Payment:** exposed as **Settle Bills**. It shares the payment save/post RPCs, but duplicates validation and numbering, hard-codes IDR, and posts immediately.
- **Record Contra:** no Bank Reconciliation Record action exists. Native Contra can select bank statement lines from Fund Transfer Manager.
- **Record Capital Injection / Loan:** uses `record_non_customer_bank_receipt`, a reconciliation-only journal creator. It does not call the native General Journal flow. “Director / Owner Loan” is incorrectly collapsed to ordinary loan account 2210 instead of native template account 2220.
- **Link Existing Expense / Receipt / Payment / Journal:** each has a separate direct `bank_statement_lines.update(...)` implementation. The shared `bankTransactionLinking.ts` helper is not used by Bank Reconciliation. Receipt linking permits unposted vouchers; Journal linking offers targets the database guard rejects and recreates bank-reconciliation journals instead of linking the selected journal.

There is no shared Finance document service layer. The native screens themselves orchestrate PostgREST writes and RPCs. Consequently Bank Reconciliation cannot currently delegate to a stable service contract.

## Architecture map

```text
Native Finance UI                         Bank Reconciliation UI
-----------------                         ----------------------
ExpenseManager.handleSubmit               handleRecordExpense (duplicate insert)
ReceiptVoucherManager.handleSubmit        handleRecordReceipt (duplicate save + post)
PaymentVoucherManager.handleSubmit        handleSettleBills (duplicate numbering + save + post)
FundTransferManager.handleSubmit          no corresponding Record Contra action
GeneralJournalEntry.handlePost            record_non_customer_bank_receipt (separate engine)
        |                                           |
        +---- direct table writes / RPCs ------------+
                            |
        finance_expenses / receipt_vouchers / payment_vouchers /
        fund_transfers / journal_entries / journal_entry_lines
                            |
                    bank_statement_lines links
                            |
     Journal Register / Account Ledger / Bank Ledger / Party Ledger /
     Trial Balance / Balance Sheet / P&L / Dashboard
```

The correct target is a one-way dependency:

```text
Bank Reconciliation -> shared Finance command -> document + posting
                    -> reconciliation-link command
Native Finance UI   -> same shared Finance command
```

## Action-by-action flow report

### 1. Record Expense

| Layer | Native Finance | Bank Reconciliation |
|---|---|---|
| UI component | `ExpenseManager.tsx` | `BankReconciliationEnhanced.tsx` |
| Function | `handleSubmit` | `handleRecordExpense` |
| Service/helper | `getCategoryFieldRules`, tax helpers, `linkBankTransaction`; no document service | category list only; no native save helper |
| RPC | none for save; `recalculate_expense_payment_state` after optional link | none for save; no paid-state recalculation after create |
| Source write | `finance_expenses.insert/update(expenseData + created_by + voucher_number)` | `finance_expenses.insert({expense_category, amount, expense_date, description, created_by})` |
| Journal | `trigger_auto_post_expense_accounting` -> `auto_post_expense_accounting()` | same trigger only because both happen to insert the same table |
| Voucher | client-generated `EXP/YY-YY/NNN`, MAX+1 | **NULL** |
| Link | shared `linkBankTransaction(...)` after save | direct `bank_statement_lines.update(...)` |
| Result | full native document | legacy/minimal document, immediately linked |

Guaranteed tables written are `finance_expenses`, `journal_entries`, `journal_entry_lines`, and `bank_statement_lines`; conditional expense triggers may also update import-container/tax-period state. The exact trigger population must be confirmed against deployed `pg_trigger` before release.

Native-only fields omitted by Bank Reconciliation include at least: `expense_type`, `payment_method`, `bank_account_id`, `payment_reference`, `paid_by`, `voucher_number`, `supplier_id`, `staff_id`, `invoice_number`, `due_date`, document links, batch/container/DC context, PIB fields, PPN/PPh fields, DPP/mode/rate, stamp duty, fixed-asset account, and bank charges.

This is the direct cause of missing expense vouchers. Bank Reconciliation never calls the native EXP number code and never supplies `voucher_number`. There is no database default/trigger that supplies it.

It also changes journal semantics. With omitted `payment_method`, `auto_post_expense_accounting()` selects A/P account 2110. A bank statement debit recorded as an expense can therefore post **Dr Expense / Cr A/P**, even though the reconciliation link says the bank paid it. A native paid bank expense supplies `payment_method='bank_transfer'` and the selected `bank_account_id`, producing **Dr Expense / Cr selected bank GL**.

### 2. Record Receipt

| Layer | Native Finance | Bank Reconciliation |
|---|---|---|
| UI component | `ReceiptVoucherManager.tsx` | `BankReconciliationEnhanced.tsx` |
| Function | `handleSubmit`, later `handlePostVoucher` | `handleRecordReceipt` customer branch |
| Service/helper | none | none |
| Numbering | `generate_voucher_number('RV')` | same RPC |
| Save | direct `receipt_vouchers.insert`; allocation rows inserted | duplicate direct insert; allocation rows inserted one-by-one |
| Posting | separate operator action calls `post_receipt_voucher` | calls `post_receipt_voucher` immediately |
| Link | no common receipt-link helper | direct `bank_statement_lines.update` |

Both paths reach the same posting RPC, so the resulting JE algorithm is shared: `source_module='receipt'`, `reference_id=receipt.id`, Dr selected bank/cash, Cr A/R 1120 (or `coa_account_id`). But the end-to-end workflows are not identical: native save creates an editable draft; reconciliation creates and posts in one non-atomic client sequence. A failure after header/allocation creation can leave a partial voucher.

Tables: `receipt_vouchers`, optionally `voucher_allocations`, then `journal_entries`, `journal_entry_lines`, `audit_logs`, settlement fields on sales documents via allocation triggers, and `bank_statement_lines`.

### 3. Record Payment (labelled Settle Bills)

| Layer | Native Finance | Bank Reconciliation |
|---|---|---|
| UI component | `PaymentVoucherManager.tsx` | `BankReconciliationEnhanced.tsx` |
| Function | `handleSubmit`, later `handlePostVoucher` | `handleSettleBills` |
| Save RPC | `save_payment_voucher_with_allocations` | same RPC |
| Posting RPC | later `post_payment_voucher` | immediately `post_payment_voucher` |
| Numbering | local `count + 1` for `PV/YY-YY/NNN` | copied local `count + 1` |
| Currency | form `payment_currency`, `exchange_rate`, `bank_amount`, `bank_charge`; allocation currency | hard-coded `IDR`, rate 1, no bank amount/charge; allocation currency IDR |
| Validation | payee, advance adjustment, invoice/bank currency, FX rate | a different subset: one payee, balance caps, bank-line amount tolerance |
| Link | shared `linkBankTransaction` when operator links | direct `bank_statement_lines.update` after posting |

The RPC and journal generator are shared, but the command is not. Both UI components duplicate a race-prone voucher number generator. Reconciliation will corrupt the stored currency fields whenever Settle Bills is used from a non-IDR bank statement.

Tables: `payment_vouchers`, `voucher_allocations`, affected purchase invoice/expense paid state, `journal_entries`, `journal_entry_lines`, `audit_logs`, and `bank_statement_lines`.

### 4. Record Contra

No Record Contra action or handler exists in `BankReconciliationEnhanced`. The native path is `FundTransferManager.handleSubmit` -> `create_fund_transfer_with_posting` -> insert `fund_transfers` -> `auto_post_fund_transfer_journal` -> `journal_entries` and `journal_entry_lines`. The RPC calls the atomic, advisory-locked `generate_fund_transfer_number()`.

Native Contra already accepts `from_bank_statement_line_id` and `to_bank_statement_line_id`; the fund-transfer posting trigger links those lines. Bank Reconciliation should navigate/prefill that native command, not add another implementation.

### 5. Record Capital Injection

| Layer | Native Finance | Bank Reconciliation |
|---|---|---|
| Native representation | General Journal template “Owner Contribution” | receipt type `capital` |
| Function | `GeneralJournalEntry.handlePost` | `handleRecordReceipt` -> RPC |
| Number | `generate_journal_entry_number()` | same generator inside RPC |
| Journal write | client inserts `journal_entries`, then lines | `record_non_customer_bank_receipt` atomically inserts JE and lines |
| Source identity | `source_module='manual'`; no reference | `source_module='bank_reconciliation'`, `reference_id=bank line`, `reference_number='BSL-...'` |
| Accounts | hard-coded template 111101 / 3100 but user may change | selected bank's `coa_id` / 3100 |
| Link | native manual JE cannot be directly linked under current DB guard | RPC links the bank line |

The records are intentionally different and therefore fail the required equality rule. No native Capital Injection document/service exists; `capital_contributions` is not part of either active flow.

### 6. Record Loan from Director / Owner

The mismatch is more severe:

- Native “Loan Received” template credits **2210**.
- Native “Director Loan” template credits **2220**.
- Bank Reconciliation maps both `loan` and `loan_director_owner` to RPC type `loan`.
- The RPC always credits **2210**.

Thus the Director/Owner action posts to the wrong native liability account. It also has the same source identity and currency differences described for Capital Injection.

### 7. Link Existing Expense

`handleLinkToExpense` loads the expense JE by `source_module='expenses'` and `reference_number='EXP-' + id`, directly updates the bank line with both typed and JE FKs, then calls `recalculate_expense_payment_state`.

This creates no document or journal, which is correct in principle, but it duplicates `bankTransactionLinking.linkBankTransaction`, uses a different validation set, and allows an operator-confirmed overpayment. It also does not verify bank account/currency compatibility or active/non-reversed JE state.

Tables: `bank_statement_lines`; `finance_expenses.paid_amount/pph_paid_amount` through recalculation.

### 8. Link Existing Receipt

`loadExistingReceipts` fetches all recent receipts. Its first query for `journal_entry_id IS NULL` is dead/unused. `handleLinkExistingReceipt` does not require a posted receipt and sets the line to `recorded` even when `journal_entry_id` is NULL.

This can create a reconciliation row that has a typed receipt link but no posted GL entry. It differs from Payment linking, which rejects unposted vouchers.

Tables: `bank_statement_lines` only.

### 9. Link Existing Payment

The UI label is **Supplier Payment**. Candidates must have `journal_entry_id`, must not be advance adjustments, must be unused, and—if the voucher names a bank—must match the selected bank. `handleLinkSupplierPayment` directly updates `bank_statement_lines.matched_entry_id`.

No `matched_payment_id` typed FK exists, so the JE is the link. This is the closest current action to correct delegation because it creates no accounting. It still duplicates the shared helper and does not compare stored voucher currency/net bank amount to the statement currency/amount rigorously.

### 10. Link Existing Journal

This flow is not reliable:

- Candidate loading uses total JE debit/credit and ±7 days, not the selected bank GL line and its side/amount/currency.
- It offers `source_module='manual'` JEs, but `enforce_no_journal_only_bank_link()` rejects arbitrary direct manual-JE links.
- For an existing `source_module='bank_reconciliation'` JE, the handler infers a receipt type and calls `record_non_customer_bank_receipt` for the **current** statement line. That RPC creates/reuses the current line's JE; it does not link the selected JE.
- The inference duplicates account-to-type mapping already inside the RPC and falls back to description keywords.
- For expense/receipt/fund-transfer/petty-cash JEs it reconstructs typed IDs with module-specific ad hoc logic; payment is handled as a special database-guard exception.

Tables: normally `bank_statement_lines`; the bank-reconciliation branch may create new `journal_entries` and `journal_entry_lines`.

## Native-versus-reconciliation comparison

| Action | Same save service/RPC? | Same number generator? | Same journal generator? | Same validation/posting lifecycle? | Verdict |
|---|---:|---:|---:|---:|---|
| Record Expense | No | No (null vs EXP client code) | Incidental same trigger | No | Fail |
| Record Receipt | No shared save command; same low-level RPCs | Yes | Yes | No, reconciliation auto-posts | Fail |
| Record Payment | Same save/post RPCs, duplicated orchestration | Copied unsafe client algorithm | Yes | No; hard-coded IDR and immediate post | Fail |
| Record Contra | Not implemented | N/A | N/A | N/A | Missing |
| Capital Injection | No | Same JE generator | No, separate RPC | No | Fail |
| Director/Owner Loan | No | Same JE generator | No; wrong counter-account | No | Fail |
| Link Expense | No shared link command | N/A | no new JE | Different guards | Partial |
| Link Receipt | No | N/A | no new JE | Allows unposted | Fail |
| Link Payment | No shared helper | N/A | no new JE | Mostly compatible | Partial |
| Link Journal | No | N/A | may create a different JE | DB guard conflicts with UI | Fail |

## Expense currency investigation

### Stored-field result

`finance_expenses` and its TypeScript model have **none** of the requested authoritative currency fields:

| Requested field | Expense storage |
|---|---|
| `currency_code` | absent |
| `transaction_currency` | absent |
| `functional_currency` | absent |
| `exchange_rate` | absent |
| `bank_account_currency` | not snapshotted; derived from `bank_accounts.currency` |
| `payment_currency` | absent |

`amount` is therefore an untyped numeric. Currency is guessed at render time by `getExpenseCurrency()` from `expense.bank_accounts.currency`, then from the first joined bank statement line, then `normalizeCurrency()` defaults to IDR.

### Why USD 5.00 can become Rp 5.00

The numeric value 5 survives; the currency identity does not exist on the expense. A Bank Reconciliation expense initially appears as USD only because it is joined to a USD statement line. Any edit/reopen/report path that does not load that relation—or a link that is cleared, hidden by RLS, or not returned—falls through to IDR. The formatter then renders the unchanged 5 as `Rp 5.00`.

There is no conversion involved and no exchange rate to recover the functional amount. This is a data-model loss, not a formatting-only defect.

### Lifecycle verification

| Stage | Result |
|---|---|
| Create from native | bank account can imply currency, but expense stores no currency/rate |
| Create from reconciliation | bank line has currency; expense does not; minimal insert omits bank account |
| Edit/save | form reconstructs bank account from joined statement line, but cannot load/store an authoritative transaction currency or rate |
| Reopen | currency depends on joined bank account/statement availability |
| Journal | journal lines contain only untyped debit/credit numerics |
| Reports | each report independently labels or converts those numerics |

## Capital/loan and journal currency investigation

For a USD statement credit of 4,200 into `111102 – Bank BCA USD`, the reconciliation RPC stores:

- journal debit = **4,200** on the USD bank GL;
- journal credit = **4,200** on capital 3100 or loan 2210;
- no transaction currency, functional currency, original amount, or exchange rate on the JE or its lines.

Display behavior is therefore inconsistent by design:

- Bank Reconciliation and Bank Ledger read the statement and show **USD 4,200**.
- Journal Register/Viewer force `'IDR'` and show **Rp 4,200**.
- Account Ledger uses statement rows for a linked bank account and shows **USD 4,200**, but uses raw JE lines and IDR for the capital/loan account, showing **Rp 4,200**.
- Trial Balance and Balance Sheet detect the USD bank behind a `bank_reconciliation` JE and multiply **both lines** by the user/reporting USD rate, showing the IDR equivalent.
- Dashboard uses raw active JE values without `get_journal_reporting_multiplier`, so its treatment differs from TB/P&L/BS for USD revenue/expense JEs.

Correct accounting presentation should be **both**:

- transaction/original amount: USD 4,200;
- functional posted amount: IDR 4,200 × the locked transaction-date exchange rate.

The GL debit and credit must be stored/balanced in functional IDR. Original USD amount and rate must be separate immutable fields. The current schema cannot represent that contract.

The current report-time multiplier is also not an accounting-grade substitute: it uses a mutable reporting rate and classifies an entire JE as USD if any linked source account is USD. It can revalue historical transactions each time a report is run.

## Stored-row equality matrix

The following is provable from the two payloads without creating data:

### Expense: native vs reconciliation

| Field | Native | Reconciliation |
|---|---|---|
| `voucher_number` | `EXP/YY-YY/NNN` | NULL |
| `expense_type` | category-derived | database/default/NULL |
| `payment_method` | selected | NULL |
| `bank_account_id` | selected bank | NULL |
| `paid_by` | `bank` for paid method | NULL/default |
| tax/context/payee fields | persisted | omitted |
| `approval_status` | default pending | default pending |
| JE credit account | selected bank for bank transfer | A/P 2110 because method is NULL |
| reconciliation link | optional after save | always added |

Not identical.

### Receipt: native vs reconciliation

For equivalent customer/date/bank/reference/amount/description inputs, the header payload is materially the same. Differences remain: native leaves it draft; reconciliation posts it and adds the reconciliation link. Allocation insertion is bulk native vs sequential reconciliation. The final stored rows can be equivalent except lifecycle timestamps/linkage, but no single atomic command guarantees it.

### Payment: native vs reconciliation

The same save RPC is used, but reconciliation forces `payment_currency='IDR'`, `exchange_rate=1`, `bank_amount=NULL`, `bank_charge=0`, and IDR allocations. Equality only happens for that narrow IDR/no-charge case. Posting/link state also differs.

### Capital/loan journals: native vs reconciliation

Not identical even before linkage: `source_module`, `reference_id`, `reference_number`, account selection, description, creator/poster fields, and director-loan counter-account differ.

### Required empirical acceptance test

On an authenticated disposable/test database, create one native and one reconciliation document for every supported action, capture `to_jsonb(row) - ARRAY['id','created_at','updated_at']`, capture sorted journal lines, and assert equality after removing only approved reconciliation link fields. Include IDR, USD same-currency, and cross-currency cases. This test is not optional before declaring the architecture fixed.

## Reporting audit

| Consumer | Source | Visibility | Currency behavior | Reconciliation-created result |
|---|---|---|---|---|
| Journal Register / Viewer | `journal_entries` + lines | defaults active posted/non-reversed | forces IDR on raw values | visible, but USD mislabeled |
| Journal detail viewer | raw lines | active selection | forces IDR | visible, but USD mislabeled |
| Account Ledger, bank GL | `bank_statement_lines` | all imported statement lines | bank currency | visible even without valid posting; operational, not GL |
| Account Ledger, non-bank GL | active JE lines | posted/non-reversed | IDR raw | capital/loan counter-line can show Rp 4,200 |
| Bank Ledger | statement lines; active GL only as comparison balance | all statement lines | bank currency | visible when imported; document posting is not prerequisite |
| Party Ledger | invoices/vouchers/expenses directly | does not gate vouchers on active JE | always IDR | receipt/payment can appear even if draft/unposted; capital/loan absent |
| Trial Balance | `get_trial_balance` active JE lines | posted/non-reversed | report-time USD multiplier | visible; converted at mutable reporting rate |
| Balance Sheet | `get_balance_sheet` active JE lines | posted/non-reversed | same multiplier | capital/loan visible as IDR equivalent |
| P&L | TB-derived | posted/non-reversed | same multiplier | expenses visible, including incorrectly posted pending expense JEs |
| Dashboard | `get_finance_dashboard_summary` raw active JE lines | posted/non-reversed | no journal reporting multiplier | USD revenue/expense inconsistent with P&L/TB |

Additional findings:

- `auto_post_expense_accounting()` posts on every insert/update and has no `approval_status='approved'` gate. New pending expenses—including reconciliation-created expenses—can enter the active GL before approval. Rejection triggers regeneration rather than a clear reversal contract.
- Bank Ledger and the bank branch of Account Ledger are statement-native, so a Bank Reconciliation row appears regardless of document/journal health. Their “GL closing balance” comparison is useful but does not make the statement table a GL.
- Party Ledger includes receipt and payment voucher rows without checking `is_posted` or active JE state.
- Financial report multiplier logic can double-convert a source whose JE is already stored in functional currency, because the schema does not state what the line numeric represents.

## Duplicate and legacy code to remove after shared services exist

Exact Bank Reconciliation functions/blocks that must be removed or reduced to shared-command calls:

1. `handleRecordExpense` — remove the direct `finance_expenses.insert` and local JE lookup.
2. Customer branch of `handleRecordReceipt` — remove direct RV insert, allocation loop, post RPC, and direct bank-line update.
3. `handleSettleBills` — remove local voucher numbering, duplicated payload construction, post orchestration, and direct link.
4. `handleLinkToExpense` — replace direct link/recalculation orchestration with one reconciliation-link command.
5. `handleLinkExistingReceipt` — replace with the same link command and require active posted target.
6. `handleLinkSupplierPayment` — replace with the same link command.
7. `handleLinkJournalEntry` — remove account-code/description inference and the “create instead of link” behavior.
8. `loadAvailableJournals` module-by-module typed-target reconstruction — move eligibility into a database query/RPC keyed to selected bank GL, amount, side, date, state, and currency.
9. `loadExistingReceipts` unused first query (`data`) — delete.
10. Local payment voucher number block inside `handleSettleBills` — delete in favor of an atomic database generator inside the save command.
11. `NON_CUSTOMER_RECEIPT_RPC_TYPES` and duplicate `ACCOUNT_CODE_TO_RECEIPT_TYPE` mapping — replace with one shared native journal/document command; never infer accounting type from narration.
12. Every direct `bank_statement_lines.update` used for link/unlink in this component — consolidate behind one atomic link/unlink RPC/helper.
13. `BankReconciliation.tsx` — unused legacy component; remove the whole file after confirming no external imports. It duplicates statement import, parsing, matching, and status handling.
14. Temporary `[BRE-DIAG]` batch diagnostics in `BankReconciliationEnhanced` — remove after the orphan investigation is closed.

Duplicate logic outside Bank Reconciliation that must be centralized rather than copied again:

- EXP voucher generation in `ExpenseManager.handleSubmit` (client-side, non-atomic, uses current date rather than expense date).
- PV voucher generation in `PaymentVoucherManager.generateVoucherNumber` and reconciliation `handleSettleBills` (two copies of count+1).
- Direct manual journal header/line insertion in `GeneralJournalEntry.handlePost` (non-atomic two-step write).
- Receipt header/allocation save in `ReceiptVoucherManager.handleSubmit` (non-atomic and no shared save RPC).
- Multiple direct bank-link implementations despite `bankTransactionLinking.ts` already existing.

## Root causes

1. **No Finance command/service boundary.** UI components are the business layer, so reconciliation copied their logic.
2. **Currency is not an accounting dimension in expenses or journal lines.** Numeric amount and presentation currency are separated by ad hoc joins and formatters.
3. **Functional-currency posting is undefined.** Some JEs store transaction-currency numerics and reports convert later; other sources can store IDR. The schema cannot distinguish them.
4. **Numbering is fragmented.** RV and FT have atomic database generators; Expense and Payment remain client-generated; the expense JE trigger has another custom MAX implementation.
5. **Posting lifecycle is fragmented.** Expenses auto-post through triggers, receipts/payments use explicit post RPCs, manual journals insert posted rows directly, and reconciliation chooses its own immediate-post policy.
6. **Reconciliation linkage is fragmented.** Typed FKs, `matched_entry_id`, direct updates, helpers, and a database guard encode overlapping rules.
7. **Capital and loan lack native document commands.** UI templates are not services; reconciliation filled the gap with a separate journal RPC.
8. **Reports do not share one currency contract.** Statement ledgers, raw JE viewers, report-time-converted financial statements, party projections, and dashboard totals label/convert differently.
9. **Status and accounting state are conflated.** Pending expenses can generate posted JEs; direct voucher reports can show unposted rows.

## Fix plan (no implementation performed)

### Phase 0 — lock the contracts

Define, before code changes:

- IDR as functional currency;
- transaction amount/currency, functional amount/currency, locked exchange rate and rate date;
- draft/approved/posted/reversed state transitions for every document;
- one canonical source identity and one reconciliation-link model;
- whether Capital Injection and Director Loan are dedicated documents or typed journal commands.

### Phase 1 — create shared atomic commands

Add one command per native document and make the native UI call it first:

- `save_expense(...)` including atomic EXP numbering, validation, currency snapshot, approval state, and optional bank link;
- `save_receipt_voucher_with_allocations(...)` with optional post/link flags or separate explicit commands;
- existing payment save RPC extended to own atomic PV numbering and full currency validation;
- existing `create_fund_transfer_with_posting(...)` retained as the Contra command;
- `post_typed_journal(...)` for capital/loan only if dedicated documents are not adopted;
- `link_bank_statement_line(...)` / `unlink_bank_statement_line(...)` as the only linkage mutations.

Commands must be transactionally atomic: source document, allocations, JE, lines, status, audit record, and reconciliation link either all succeed or all roll back.

### Phase 2 — migrate native modules

Move Expense, Receipt, Payment, Contra, and General Journal native screens onto those commands. Do not migrate Bank Reconciliation until parity tests prove the commands reproduce the intended native records.

### Phase 3 — introduce the currency ledger model

At minimum persist on source and JE lines:

- `transaction_currency`;
- `transaction_debit` / `transaction_credit` (or signed original amount);
- `functional_currency='IDR'`;
- functional `debit` / `credit`;
- `exchange_rate` and `exchange_rate_date`;
- bank/payment currency snapshots where legally/audit relevant.

Backfill must use documented historical evidence, not the latest reporting rate. Rows without evidence must be flagged, not guessed.

### Phase 4 — make Bank Reconciliation a router

Replace each Record UI with either:

- navigation/prefill into the native module; or
- a thin call to the exact same shared command.

Record Contra should prefill Fund Transfer Manager. Capital/loan must use the native typed journal/document command. Link actions must call only the canonical link command.

### Phase 5 — unify reporting

- Journal Register/Viewer: display functional IDR and original currency/rate side by side.
- Account Ledger: GL-backed for accounting; keep statement view explicitly operational.
- Bank Ledger: show statement currency, functional equivalent, and GL variance.
- Party Ledger: require active posted source or explicitly label drafts.
- TB/BS/P&L/Dashboard: consume stored functional amounts; eliminate transaction-by-transaction report-time multiplication.

### Phase 6 — parity and regression gates

For every action, run native vs reconciliation creation in a disposable authenticated database and compare all stored fields except permitted reconciliation linkage. Test:

- IDR and USD;
- create, edit, cancel/reopen, repost, reverse, and delete;
- concurrent number generation;
- closed accounting periods;
- posting failure rollback;
- all listed reports and drill-downs;
- director loan 2220 vs ordinary loan 2210;
- statement amount vs bank GL line amount/side/currency.

Do not delete the legacy functions until these tests pass. Once they pass, remove the duplicate code list above in one cleanup change.

## Release decision

**Not ready for implementation-by-patch or production acceptance.** The audit is complete, but the architecture requires shared command boundaries and a currency data-model decision before individual defects are fixed. Fixing only the missing expense voucher or a formatter would preserve the duplicate engines and make later reconciliation harder.

## Implementation addendum — shared-command and historical-repair phase

Implemented after the audit:

- `src/services/financeCommands.ts` is the single frontend command boundary for Expense, Receipt, Payment, Manual Journal, approval, and bank-statement linking.
- Expense Manager and Bank Reconciliation call `save_finance_expense`; approval calls `approve_finance_expense`; numbering is atomic.
- Receipt Voucher Manager and Bank Reconciliation call `save_receipt_voucher_with_allocations`, followed by native `post_receipt_voucher`.
- Payment Voucher Manager and Bank Reconciliation call `save_payment_voucher_command`, which delegates to the native allocation command and owns atomic numbering.
- General Journal and reconciliation capital/loan/income entries call `save_finance_journal`. Director/Owner Loan uses 2220; ordinary bank loan uses 2210.
- Record Contra opens a prefilled native Fund Transfer form. Reconciliation creates neither the transfer nor its journal.
- Link Existing Expense/Receipt/Payment/Journal call `link_bank_statement_line`, which checks posting state, bank GL, transaction side, and transaction amount.
- Stored transaction and functional currency metadata prevents USD from reopening as IDR. USD writes require an authoritative rate; the Journal Register shows functional IDR and original USD.
- Expense, Receipt, and Payment posting synchronizers convert new journal values to functional IDR once while preserving original transaction values.
- Reporting respects `amounts_are_functional`, preventing double conversion.

Historical repair is implemented in `supabase/migrations/20260725130000_finance_shared_commands_currency_and_historical_repair.sql`. Every automatic change is recorded before mutation; document amounts and posted debit/credit values are immutable. Deterministic repairs cover missing Expense, Receipt, and Payment voucher numbers; uniquely proven bank/currency metadata; IDR rates; source IDs; document/journal links; reconciliation links; and narration-proven Director/Owner Loan mappings. A typed `matched_payment_id` now gives Payment Vouchers the same document-to-bank traceability as the other native modules. Conflicting bank/currency metadata, missing exact payment methods, duplicate legal voucher numbers, and USD rows without an authoritative historical rate are not guessed and become exceptions.

Operational command:

```sh
FINANCE_DATABASE_URL='<service-role postgres URL>' npm run finance:repair
```

It reports the migration repair run without modifying data. Add `-- --run` only when an authorised accountant intends to execute a new audited repair run. It returns scanned, repaired, manual-review, and skipped totals; every before/after repair record; the full Exception Report; and status-aware verification for the source module, Journal Register, Journal Viewer, Account Ledger, Bank Ledger, Party Ledger, Trial Balance, Balance Sheet, Profit & Loss, Dashboard, and Bank Reconciliation. Drafts pass by remaining outside posted reports; posted records pass only when an active journal and journal lines satisfy the report inclusion contract. A deployed repair and authenticated report-by-report E2E verification require a service-role database connection; anon credentials cannot bypass Finance RLS.

### Read-only production preflight (25 July 2026)

No production row was modified during this audit. Read-only inspection found 564 Expenses, 33 Receipts, 6 Payments, 1,040 Journal Entries, 2,196 Journal Lines, 648 bank lines, and 41 Fund Transfers. Seven Expenses have a missing voucher number; three have one uniquely linked bank account and four have no bank-line evidence for currency recovery. There are four legacy `bank_reconciliation` journals (two IDR and two USD) and eight journal-only bank links (four native Payments and four non-customer bank-reconciliation journals). The four Payments can receive deterministic typed links; the non-customer journals correctly remain journal links.

Contra preflight found 18 IDR→IDR, 2 IDR→USD, and 21 USD→IDR historical transfers. The native legacy poster used the source amount as functional debit/credit. IDR-source rows can receive deterministic rate and line-currency metadata without changing GL values. USD-source rows require manual review because correcting their functional GL values would rewrite posted accounting amounts, which this repair explicitly forbids. New Contra postings now preserve each side's transaction amount/currency and post balanced functional IDR values.

### Production cleanup completion (25 July 2026)

The isolated Finance migrations were first executed inside a rollback transaction, then applied to the linked production database and recorded as `20260725130000` and `20260725140000`. Production repair run `09a0f78a-01b8-4ad6-a1e6-260b0a57b40c` scanned 2,332 Finance records.

- 907 records were fully repaired automatically.
- 351 records received deterministic repairs and were also flagged for a remaining manual decision.
- 70 additional records require manual review without an automatic mutation, for 421 distinct manual-review records in total.
- 1,004 records were explicitly clean and skipped.
- 0 records are safe to delete and recreate; each exception contains audit evidence or posted-history risk that must be retained.

The repair produced 1,280 itemised before/after mutations across 1,258 distinct records. It repaired all seven missing Expense voucher numbers, produced no duplicate Expense/Receipt/Payment/Journal numbers, added all four deterministic Payment reconciliation links, and left no orphan Journal Lines. Pre/post hashes for Expense, Receipt, Payment, Fund Transfer and bank-statement amounts, Journal header totals, and every Journal Line debit/credit are identical, proving that no posted accounting value changed.

Report verification covers the source module, Journal Register, Journal Viewer, Account Ledger, Bank Ledger, Party Ledger, Trial Balance, Balance Sheet, Profit & Loss, Dashboard, and Bank Reconciliation. Of the 1,258 automatically touched records, 925 pass every report eligibility check. The other 333 report failures are all linked to explicit exception records; there are zero undocumented verification or orphan findings.

The largest historical exception is a confirmed legacy mapping problem: 164 reconciled Expenses identify a bank account while the posted Expense journal uses Cash on Hand or another GL account. Their corresponding bank rows are also reported. The relationship is certain enough to diagnose, but silently changing a posted account would rewrite ledger history, so these rows require an accountant-authorised correcting/reclassification entry or formal reversal and reposting. The 21 USD-source legacy Contras likewise remain historical-accounting decisions because correcting their functional GL representation would alter posted accounting values.

The complete production deliverables are:

- `finance-repair-output/finance-production-cleanup-09a0f78a-01b8-4ad6-a1e6-260b0a57b40c.md`
- `finance-repair-output/finance-production-cleanup-09a0f78a-01b8-4ad6-a1e6-260b0a57b40c-exceptions.csv`
- `finance-repair-output/finance-production-cleanup-09a0f78a-01b8-4ad6-a1e6-260b0a57b40c.json`

Regenerate the report without changing production data with:

```sh
npm run finance:repair -- --linked --run-id=09a0f78a-01b8-4ad6-a1e6-260b0a57b40c
```

The production build passes. The repository-wide TypeScript check remains blocked by the existing cross-module CRM, Sales, Inventory, Dashboard, and legacy Finance type-error backlog; a changed-Finance-file-only error filter returns no errors.
