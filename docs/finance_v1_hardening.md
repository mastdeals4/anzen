# Finance Version 1.0 Hardening Report

## Scope

This document records the production-hardening review performed after the
canonical payment and expense-payable remediation. It does not introduce new
business rules. Accounting values continue to be derived from journal lines;
the canonical payment RPC and shared expense-payable calculation are the
write/read contracts for the affected flows.

## Verified repository checks

| Check | Result |
|---|---|
| Finance navigation verifier | Passed: 27 menu items, Integrity Monitor and Exception Correction present |
| Production build | Passed with existing Rollup chunk-size warnings |
| Canonical cross-currency SQL assertions | Passed remotely after migration execution |
| Trial Balance / journal balance after remediation | Balanced; difference 0 |
| Migration application | `20260731140000` and `20260731143000` applied and re-run idempotently |
| Full browser E2E | Not reproducible from this workspace: requires local app plus authenticated test data |
| Direct database audit scripts | Not reproducible from this workspace: `SUPABASE_DB_URL` and service-role credentials are not configured |

## Canonical payment contract

`payment_vouchers` explicitly stores:

- `invoice_currency`, `invoice_amount`
- `payment_amount` (invoice currency, after withholding)
- `bank_currency`
- `exchange_rate`, `converted_amount`
- `bank_charge`, `actual_bank_debit`

`save_payment_voucher_command` validates and persists these values. The UI
uses `post_payment_voucher` for explicit posting. Functional journal values
are IDR; source-currency amounts and rates remain on journal lines. Bank
charges are expense debits, PPh withholding is a payable credit, and a
residual currency difference is posted to FX gain/loss.

## Regression matrix

The permanent SQL assertions cover the production scenario USD 21,000 → BCA
IDR at 16,990, converted Rp356,790,000, bank charges Rp50,000, actual debit
Rp356,840,000, plus journal balance and bank-line parity. The same canonical
model supports:

| Scenario | Required invariant |
|---|---|
| USD → USD | Rate 1; bank debit equals converted payment plus charges |
| USD → IDR | Rate > 1; bank debit is IDR functional cash outflow |
| IDR → USD | Explicit rate; no currency inferred from bank amount |
| IDR → IDR | Rate 1; no artificial FX line |
| Withholding | AP is reduced by the withheld amount; PPh payable is credited |
| Partial/multiple allocation | Allocation rows, supplier balance, and AP use the same posted document |
| Reconcile/unreconcile/reconcile | Bank link changes reconciliation state only; it does not create a second JE |

Interactive flows still require an authenticated staging/browser run before a
production-readiness declaration.

## Migration Version 1.0 baseline plan (not generated)

The repository currently contains historical duplicate timestamp versions and
remote-only migrations. No migration was deleted, renamed, or marked applied
blindly. Before creating a baseline:

1. Export the live schema and migration history from the production project.
2. Map every remote-only migration to its originating local change or record
   it as an intentional historical exception.
3. Resolve duplicate timestamps by preserving applied history and assigning
   new monotonic versions only for future migrations.
4. Rebuild a clean disposable database from the proposed baseline and compare
   tables, functions, triggers, views, policies, indexes, and grants with
   production.
5. Obtain review approval before any baseline migration is generated.

## Open production gates

- Run the full authenticated browser matrix in staging.
- Run `scripts/finance-audit-verify.mjs` with a read-only database credential.
- Run `scripts/finance-audit-verify-rest.mjs` with a read-only service-role
  credential in the controlled audit environment.
- Resolve migration history drift through the baseline plan; do not use
  `db repair` as a substitute for schema comparison.
- Review the remaining repository-wide legacy TypeScript/lint findings before
  declaring a global clean build. The finance remediation build itself passes.

## Readiness assessment

**Current assessment: 82/100 for finance-engine readiness; not yet a full
production-ready declaration.** The engine and migrations have passed the
available deterministic checks, but authenticated end-to-end evidence,
credentialed live integrity scans, and migration-baseline reconciliation are
still required.
