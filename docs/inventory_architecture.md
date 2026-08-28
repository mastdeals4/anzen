# Inventory Version 1.0 Architecture

## Boundary

```text
Batch Creation ──post_inventory_movement(+qty)──▶ Batch Stock
Sales Order ──FEFO reservation─────────────────▶ Availability
Delivery Challan Approval ──movement(-qty)─────▶ Batch Stock
Sales Invoice ──validation only────────────────▶ Finance
Returns/Rejections/Adjustments ──signed movement▶ Batch Stock
```

Purchase Order and Purchase Invoice are outside the physical stock boundary.
Container Import contributes cost context only. GRN does not exist.

## Ownership

| Object | Owner |
|---|---|
| `products` | Product master |
| `batches` | Batch master and locked physical balance |
| `inventory_transactions` | Immutable signed physical movement history |
| `stock_reservations` | SO availability commitments |
| `delivery_challans` / items | Physical outbound source documents |
| `sales_invoices` / items | Accounting documents; DC validation only |
| `material_returns` / items | Conditional physical returns |
| `credit_notes` / items | Accounting reversal plus controlled return |
| `stock_rejections` | Controlled physical rejection |

## Enforcement layers

1. UI calls canonical RPCs.
2. RPCs validate role and document state.
3. Stock rows are locked.
4. `post_inventory_movement` validates sign, product, expiry, idempotency, and
   non-negative result.
5. Database guards reject direct stock or movement writes.
6. Certification and report objects verify the forward state.

## Report sources

- Stock Summary: `inventory_v1_stock_summary`
- Inventory Movement: `inventory_v1_movement_report`
- Batch/stock history: `inventory_transactions` plus reservation history
- Forward certification: `inventory_v1_certification_status`

See [inventory_bible.md](inventory_bible.md) for normative lifecycle rules.
