# SAPJ ERP Inventory Bible — Version 1.0

Status: **Normative and frozen**
Effective date: 1 August 2026

This is the permanent technical reference for SAPJ Inventory Version 1.0.
Future changes must preserve these rules unless a separately approved ERP
version changes the business architecture.

## 1. Final business architecture

```text
Purchase Order                 commercial only
Purchase Invoice               Finance only
Container Import               cost context only
Batch Creation                 ONLY physical stock IN
Sales Order                    reservation only
Reservation Release            availability only
Delivery Challan Approval      ONLY normal physical stock OUT
Sales Invoice                  accounting only
Material Return / Credit Note  controlled stock return
Stock Rejection                controlled stock OUT
Stock Adjustment               controlled signed correction
```

SAPJ Version 1.0 has no GRN. Do not introduce one. Purchase Orders and
Purchase Invoices never change physical quantity. Sales Invoices never change
physical quantity.

## 2. Canonical source of truth

Physical quantity is stored on `batches.current_stock` and can only be changed
by `post_inventory_movement(...)`. Every accepted change appends one immutable
row to `inventory_transactions` in the same locked database transaction.

`inventory_transactions.operation_id` is the idempotency key. It has a unique
partial index. Retrying the same operation must not create another movement or
change stock twice.

Frontend code must never:

- insert, update, or delete `inventory_transactions`;
- insert a batch with a non-zero `current_stock`;
- update `batches.current_stock`;
- delete inventory history;
- calculate a different physical movement from the backend.

Database guards enforce these boundaries.

## 3. Signed movement model

| Event | `transaction_type` | Sign | Reference type |
|---|---|---:|---|
| Batch Creation | `purchase` | positive | `batch_creation` |
| Batch quantity correction | `adjustment` | signed | `batch_edit` |
| Delivery Challan approval | `delivery_challan` | negative | `delivery_challan` |
| DC edit/cancel reversal | `adjustment` | positive | DC reversal reference |
| Material Return | `return` | positive | `material_return` |
| Material Return reversal | `adjustment` | negative | `material_return_reversal` |
| Credit Note return | `return` | positive | `credit_note` |
| Credit Note reversal | `adjustment` | negative | `credit_note_reversal` |
| Stock Rejection | `rejection` | negative | `stock_rejection` |
| Stock Rejection reversal | `adjustment` | positive | `stock_rejection_reversal` |
| Manual Stock Adjustment | `adjustment` | signed | `stock_adjustment` |

Reservations are not physical movements and do not belong in the physical
movement ledger.

## 4. Canonical database commands

| Command | Responsibility |
|---|---|
| `save_batch_inventory_v1` | Batch create/edit plus creation/correction movement |
| `adjust_batch_stock_atomic` | Signed manual Stock Adjustment only |
| `approve_sales_order_inventory_v1` | Approve SO and run canonical FEFO reservation |
| `fn_reserve_stock_for_so_v2` | Locked FEFO reservation |
| `fn_release_reservation_by_so_id` | Full history-preserving release |
| `fn_release_partial_reservation` | Partial history-preserving release |
| `inventory_v1_consume_reservation` | Enforce DC batch against SO FEFO reservation |
| `post_inventory_movement` | The only physical stock writer |
| `admin_edit_approved_delivery_challan` | Reverse current DC version and repost |
| `archive_batch_inventory_v1` | Archive zero-stock, unreserved batch |
| `inventory_v1_certification_status` | Forward-integrity certification |
| `inventory_v1_movement_report` | Canonical Inventory Movement report |

`delete_batch_safe` is retained only for backward compatibility and now
archives through the canonical policy. It never deletes inventory history.

## 5. Batch lifecycle

### Create

`save_batch_inventory_v1(NULL, payload, operation_id)` inserts the batch with
zero stock, then posts exactly one positive `purchase` movement equal to
`import_quantity`.

### Edit

Descriptive and cost fields may change. A quantity change appends a signed
`adjustment` equal to:

```text
new import_quantity - old import_quantity
```

The edit fails atomically if the resulting stock would be negative. Existing
movement rows are never rewritten.

### Archive/delete

A batch can be archived only when:

- `current_stock = 0`; and
- no active reservation exists.

Any batch with movement history cannot be physically deleted. Products with
batch or movement history must be deactivated, not deleted.

## 6. Sales Order and FEFO

Sales Order approval reserves stock but does not change physical stock.

FEFO order is:

1. non-null expiry before null expiry;
2. earliest expiry;
3. import date;
4. creation timestamp;
5. batch ID.

Expired batches (`expiry_date <= current_date`) are never reserved or
delivered.

Reservation rows are immutable history. Release changes status to `released`
and records actor, time, and reason. `batches.reserved_stock` remains a derived
cache synchronized from active reservation rows.

## 7. Delivery Challan

Approval is the only normal physical stock OUT event.

For an SO-linked DC:

- every item must be covered by an active reservation for the same SO,
  product, and FEFO-selected batch;
- approval consumes that reservation;
- one negative canonical movement is posted per DC item;
- SO delivered quantities are recomputed from approved DC documents.

Approved DC edit:

1. rejects historical ambiguous DCs;
2. rejects DCs already used by Sales Invoice items;
3. posts reversals for the current DC item version;
4. preserves old movement rows;
5. replaces document items;
6. recomputes and recreates FEFO reservations;
7. consumes the revised reservations;
8. posts the revised DC movements.

Approved DC rejection/cancellation posts reversal movements, recomputes the SO,
and recreates outstanding FEFO reservations. A reversed DC cannot be
re-approved. A DC with canonical history cannot be deleted.

## 8. Sales Invoice

Sales Invoice is accounting-only.

Every Sales Invoice item must reference an item from an approved Delivery
Challan. Product and batch must match, and cumulative invoice quantity cannot
exceed the approved DC item quantity.

Sales Invoice create, edit, delete, reverse, or restore must create zero
physical inventory movement.

## 9. Returns, Credit Notes, and Rejections

Only approved/restocked Material Return lines with disposition `restock`
increase stock. Reversal appends the exact opposite movement.

Approved Credit Note items increase stock. Revoking approval appends the exact
opposite movement. Credit Note journal reversal runs after the document status
update to avoid FK self-modification while preserving Finance posting rules.

Approved/disposed Stock Rejections reduce stock. Revocation restores stock
through an opposite movement.

Approved source items cannot be edited or deleted. Reverse the source first.

## 10. Reports

`inventory_v1_stock_summary` is the backend source for:

- physical stock;
- reserved stock;
- available stock;
- shortage;
- active/expired batch counts;
- nearest usable expiry.

`inventory_v1_movement_report(from, to)` is the backend source for CA Inventory
Movement. It counts:

- canonical Version 1.0 signed movements after enforcement; and
- verified historical legacy movement conventions before enforcement.

Rows explicitly marked `metadata.superseded = true` are excluded from effective
report balances but remain in the audit ledger.

## 11. Historical data policy

Historical stock is never repaired by inference alone.

Classifications:

- `VERIFIED`
- `LEGACY VERIFIED`
- `REPAIR REQUIRED`
- `MANUAL REVIEW`

Only mathematically provable duplicate metadata may be repaired
automatically. Quantity, documents, and accounting history require explicit
documentary evidence and a separate approved plan.

As of 1 August 2026, three batches remain manual review and are intentionally
unchanged:

- `4001/1101/25/A-3147`
- `B108/2026`
- `B109/2026`

## 12. Security

All Inventory mutation RPCs are `SECURITY DEFINER`, set an explicit
`search_path`, validate authenticated roles, and deny anonymous execution.

Allowed operational roles are limited by command and include combinations of:

- `admin`
- `accounts`
- `manager`
- `warehouse`
- `sales` only where the existing document workflow requires it

Trigger-only functions are also not executable by `anon`.

## 13. Regression and release gates

Required commands:

```text
npm run test:inventory-v1 -- --linked
npm run verify:finance-release
npm run typecheck
npm run lint -- --quiet
npm run build
```

`test:inventory-v1` creates authenticated transactional fixtures and always
rolls them back. It covers Batch, FEFO, reservation release, DC approval/edit/
reversal, Sales Invoice zero movement, Material Return, Credit Note, Stock
Rejection, Stock Adjustment, idempotency, archive, report reconciliation, and
database certification.

Inventory cannot be certified unless:

- local and remote migrations match;
- duplicate migration versions are zero;
- `inventory_v1_certification_status().certified = true`;
- the Inventory and Finance rollback regressions pass;
- anonymous Inventory `SECURITY DEFINER` execution count is zero;
- only genuinely ambiguous historical records remain manual review.

## 14. Coding standards

- Extend these commands; do not create parallel stock writers.
- Use operation IDs for every retryable physical action.
- Lock source documents and batches in database commands.
- Reject invalid state; never silently clamp negative stock.
- Reverse and repost; never update or delete historical movements.
- Put report calculations in backend functions/views.
- Add rollback regression coverage with every lifecycle change.
- Use forward-only, idempotent migrations.
- Update this Bible and release notes when contracts change.
