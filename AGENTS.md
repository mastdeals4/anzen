# SAPJ ERP Developer & Agent Verification Contract

This repository is configured for rapid, token-efficient agentic development with low overhead.
Follow these architectural guidelines and verification rules when working on SAPJ.

---

## 1. Core Principles

1. **Inspect First**: Always inspect existing schemas, types, APIs, and UI components before writing new code.
2. **Reuse Existing Architecture**: Do not introduce duplicate utilities, state stores, styling abstractions, or testing frameworks.
3. **No Unrelated Refactoring**: Do not reformat untouched files or modify working components merely for stylistic cleanup.
4. **Preserve Business Logic**: Never modify financial calculations, GL posting models, currency rounding, tax engines (PPh 21/22/23/Final), inventory reservations, or database constraints unless explicitly instructed.
5. **No Hallucinated Success**: Never claim completion of any change without running the appropriate verification command and verifying the actual output.

---

## 2. Standardized Verification Commands

| Command | Purpose | When to Use |
| :--- | :--- | :--- |
| `npm run lint` | ESLint with caching | Code style / TS / React checks |
| `npm run typecheck` | Fast incremental TypeScript check | Type safety verification across `src/` |
| `npm run test:targeted` | Changed-test / keyword regression runner | Localized component, utility, or schema edits |
| `npm run test` | Full regression test suite (`node:test`) | Pre-release, broad cross-module changes |
| `npm run verify` | Typecheck + Lint + Targeted Tests + Build | High-risk changes before committing/pushing |
| `npm run verify:ui` | Playwright smoke & layout verification | UI routing, responsive layout, auth flows |

---

## 3. Tiered Verification Workflow (Token & Time Efficiency)

Avoid running full verification (`npm run verify` or `npm run test`) after small localized edits. Use the cheapest check that proves correctness:

### A. Localized UI / Component Changes
- Check types: `npm run typecheck` (completes in ~3-4s via incremental cache)
- Targeted test: `npm run test:targeted -- <component_keyword>` (e.g., `npm run test:targeted -- stock`)
- Targeted file lint: `npx eslint src/path/to/Component.tsx`
- If testing visual interaction or routing: `npm run verify:ui`

### B. Localized Backend / Utility / Logic Changes
- Check types: `npm run typecheck`
- Targeted test: `npm run test:targeted -- <domain_keyword>` (e.g., `npm run test:targeted -- expense`)

### C. Database / Migration / Cross-Cutting Changes
- Check types: `npm run typecheck`
- Targeted tests for all affected modules: `npm run test:targeted -- <module>`
- Production build: `npm run build`
- Run full verification when scope warrants: `npm run verify`

---

## 4. Lint & Historical Debt Policy

- Standard ESLint config enforces TypeScript hygiene, unused variables, React Hooks invariants, and safe exports.
- **Pre-existing Lint Debt**: Historical lint errors (e.g. `prefer-const` in legacy files or `@typescript-eslint/ban-ts-comment` in adapters) must be reported separately. Do not perform sweeping refactors on working application code to fix pre-existing debt.

---

## 5. Playwright & E2E Testing Guidelines

- UI tests reside in `e2e/` and test critical user journeys (Auth, Public Calculator, Viewport Responsiveness, Route Protection).
- Normal test runs are lightweight (`headless: true`, minimal console noise).
- Traces, videos, and screenshots are retained **only on failure** to conserve disk and memory.
- Default dev server port for UI verification is `5173`. Avoid port `5000` (reserved by macOS ControlCenter AirPlay Receiver).
