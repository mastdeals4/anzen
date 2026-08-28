# Finance Version 1.0 Release Notes and Production Checklist

## Included

- Canonical Customs Broker expense/payable calculations.
- Canonical payment currency fields and cross-currency posting.
- Bidirectional exchange-rate validation for USD↔IDR.
- Bank charges, withholding, FX adjustment, supplier/AP ledger integration.
- Integrity assertions for journal balance and bank-side payment parity.
- Finance architecture, flow, tax, and migration reconciliation references.

## Production checklist

### Database and accounting

- [ ] Migration reconciliation approved and recorded.
- [ ] New migration applied to staging and production.
- [ ] Trial Balance, P&L, and Balance Sheet reconcile.
- [ ] No orphan journal lines, allocations, or duplicate postings.
- [ ] Foreign keys, RLS policies, indexes, views, triggers, and RPC signatures
      match the approved schema export.

### Security and operations

- [ ] RLS verified for every finance table and storage bucket.
- [ ] SECURITY DEFINER RPCs enforce role checks and fixed search paths.
- [ ] Edge functions deployed at the intended commit and secrets verified.
- [ ] Scheduled jobs and notification checks are present and monitored.
- [ ] Production backups are enabled; restore test completed in an isolated
      project.
- [ ] Deployment and rollback runbooks have been rehearsed.

### Validation

- [ ] Authenticated staging E2E covers purchases, expenses, broker, sales,
      payments, receipts, petty cash, transfers, salary, tax, and bank rec.
- [ ] Cross-currency matrix covers USD→USD, USD→IDR, IDR→USD, and IDR→IDR.
- [ ] Tax reports, CA reports, ledgers, AP/AR, aging, and cash book reconcile.
- [ ] Performance is measured on production-sized journal and ledger data.

## Release risks

The release is not certified for production yet because migration history is
drifted, the latest bidirectional-rate migration is not remotely applied, and
authenticated/live database validation could not run in this workspace.

## Scores

| Area | Score | Basis |
|---|---:|---|
| Architecture | 88/100 | Canonical journal and payment/payable contracts documented |
| Accounting integrity | 90/100 | Deterministic balance checks passed; live re-run gate remains |
| Tax compliance | 84/100 | Tax engine and locks documented; full tax-period certification pending |
| Performance | 72/100 | Build passes; production-sized benchmark not run |
| Maintainability | 80/100 | Shared paths documented; migration drift remains |
| Deployment readiness | 68/100 | Build is reproducible, but migration and live-validation gates remain |

## Version 1.1 candidates

- Clean migration baseline after approved schema comparison.
- Broader automated staging fixtures for every finance workflow.
- Production-sized ledger/report performance benchmarks.
- Further cleanup of unrelated repository-wide TypeScript/lint debt.
