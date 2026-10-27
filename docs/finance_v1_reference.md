# Finance Version 1.0 Reference Flows

This is the frozen reference for Finance Version 1.0. Journal lines in
functional currency are the reporting source of truth. UI totals and ledgers
must consume the relevant canonical RPC/view or journal source; they must not
reimplement accounting rules.

## Journal posting rules

- Sales invoice: Dr AR, Cr revenue, Cr Output PPN, and COGS/inventory lines.
- Purchase invoice: Dr inventory/expense, Dr Input PPN, Cr AP; landed costs
  update inventory costing.
- Expense: Dr expense, Dr recoverable Input PPN when creditable, Cr AP/bank,
  and Cr withholding payable where applicable.
- Payment voucher: Dr AP, Cr bank/cash, Cr PPh payable for withholding, Dr
  bank charges, and FX gain/loss for a residual difference.
- Receipt: Dr bank/cash, Cr AR.
- Petty cash: Dr expense/asset, Cr petty cash; replenishment is Dr petty cash,
  Cr bank.
- Fund transfer: one source-owned transfer and one journal; reconciliation
  links do not create another journal.
- Tax payment: `record_tax_payment` clears the tax payable through the normal
  journal and reconciliation rails.

## Payment voucher flow

`PaymentVoucherManager` calls `save_payment_voucher_command`, which stores
invoice currency/amount, net payment amount, bank currency, exchange rate,
converted amount, bank charges, and actual bank debit. Explicit posting calls
`post_payment_voucher`. Allocations remain in `voucher_allocations`; editing,
reversal, and reconciliation preserve the document identity and audit trail.

## Receipt voucher flow

`ReceiptVoucherManager` saves through the shared receipt allocation command and
posts through `post_receipt_voucher`. The resulting Dr bank/cash and Cr AR
lines are used by customer ledgers, bank ledger, and reconciliation.

## Broker accounting flow

The broker accounting model derives reimbursement line totals from line data,
never nullable stored totals. The canonical calculation exposes broker amount,
reimbursement total, expense total, recoverable Input PPN, PPh23, and cash
payable. Broker and reimbursement suppliers receive their own journal lines,
payment postings, outstanding balances, and ledger history.

## Cross-currency flow

The exchange rate means `1 invoice-currency unit = N bank-currency units`.
USD→IDR normally has `N > 1`; IDR→USD normally has `0 < N < 1`. Same-currency
payments use rate 1. Journal debit/credit values are functional IDR, while
source amounts and rates remain on the lines. Actual bank debit includes bank
charges and is the amount matched by bank reconciliation.

## Tax engine flow

PPN Input/Output and PPh values are attributed to tax periods by the tax
period triggers and reported through the tax engine views. Recoverable Input
PPN is an asset, not expense. Withheld PPh is a liability until remitted.
Closed periods are locked; tax payments use the same journal and bank
reconciliation model as other finance transactions.

## Finance UI standards

- Display source-document currency explicitly; do not label functional IDR as
  the source amount.
- Use shared currency/date formatters and canonical RPC/view values.
- Show document breakdowns separately from canonical totals.
- Drill-downs must open the source document or journal, never reconstruct it
  from a second calculation.
- Edits and reversals must preserve audit history and never duplicate a JE.
