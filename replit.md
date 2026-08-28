# Anzen ERP - Pharmaceutical Raw Material Trading

## Project Overview
A comprehensive Enterprise Resource Planning (ERP) system for pharmaceutical raw material trading (PT. Shubham Anzen Pharma Jaya). Manages CRM, inventory/batches, sales orders, finance, and logistics.

## Tech Stack
- **Frontend:** React 18 with TypeScript
- **Build Tool:** Vite 5 (port 5000)
- **Backend/Database:** Supabase (PostgreSQL, Auth, Storage)
- **Styling:** Tailwind CSS
- **State Management:** React Context API
- **Key Libraries:** react-router-dom v7, lucide-react, recharts, react-quill, xlsx, jspdf, html2canvas

## Project Structure
- `src/pages/` - Top-level page components (Dashboard, Inventory, Finance, etc.)
- `src/components/` - UI components organized by module (finance/, crm/, dashboard/, commandCenter/, settings/, tasks/)
- `src/contexts/` - Global state providers (Auth, Finance, Language, Navigation)
- `src/lib/` - Supabase client (reads VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY)
- `src/utils/` - Currency formatting, date utilities, permission helpers
- `src/types/` - Shared TypeScript interfaces
- `supabase/migrations/` - SQL migration files (ordered by timestamp)
- `supabase/functions/` - Deno Edge Functions

## Development
- **Dev Server:** `npm run dev` (port 5000)
- **Build:** `npm run build` → `dist/`
- **Deployment:** Static site via `npm run build`

## Current Production State (2026-06-03)
- Finance audit completed against live production data.
- Trial Balance is balanced.
- Historical COGS repair completed with additive correction journals.
- Receipt voucher repair completed:
  - `RV/25-26/011` journal repaired in place and balanced.
  - 19 stale invoice `balance_amount` values corrected from existing receipt allocations.
  - `RV2606-0002` journal is balanced; unallocated receipt value remains unapplied/advance.
- Batch current stock is correct for the 28 reported mismatch rows; the mismatch is historical `inventory_transactions.stock_after` snapshot drift.
- Remaining blocker: apply `supabase/migrations/20260603173000_fix_sales_order_delete_trigger_overload.sql` through a direct DB migration channel, then delete `e2e-SO-TEST-1780479381949` and `e2e-customer-TEST-1780479381949`.
- Full live E2E validation is blocked until the E2E cleanup trigger blocker is removed.

## Key Architectural Rules
- All stock changes go through DB triggers/RPCs — never update `batches.current_stock` directly
- Reservations must set BOTH `status = 'released'` AND `is_released = true` or they still count as reserved
- `trg_sync_batch_reserved_stock` is the single source of truth for `batches.reserved_stock`
- Credit notes only restore stock on **approval** (trigger: `trg_credit_note_status_change`)
- Payment vouchers use `save_payment_voucher` RPC for atomic saves
- Voucher numbers use `generate_voucher_number(prefix)` with advisory locks (no race conditions)
- Documents shown via signed URLs in inline iframe modals (no `window.open`)

## Environment Secrets Required
- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`

## Modules
CRM, Products, Batches/Inventory, Sales Orders, Delivery Challans, Finance (invoices, vouchers, bank reconciliation, petty cash, journals, reports), Import Containers, Material Returns, Stock Rejections, Settings/Users, Dashboard

## Internationalization (i18n)
- All pages use `useLanguage()` hook from `src/contexts/LanguageContext.tsx` with `const { t } = useLanguage()`
- Translation strings live in `src/i18n/translations.ts` under `en` and `id` namespaces
- Sections: common, nav, auth, crm, commandCenter, dashboard, salesOrders, products, batches, finance, importRequirements, importContainers, salesTeam, deliveryChallan, tasks, settings, email, print
- Language toggle is in the top-right header; value persisted in LanguageContext
- **All pages are fully bilingual EN/ID:** CRMCommandCenter, ImportContainers, ImportRequirements, SalesTeam (completed Apr 2026)

## Mobile Responsiveness
- Layout.tsx: hamburger menu + sliding sidebar on mobile (lg:hidden toggle)
- Pages use `overflow-x-auto` wrappers on all tables
- Stat cards use `grid-cols-2 lg:grid-cols-4` responsive grids
- Form grids use `sm:grid-cols-2` / `sm:grid-cols-3` to collapse on mobile
- Page headers use `flex-col sm:flex-row` to stack on small screens
