// ============================================================================
// Central application identity & release configuration.
// ============================================================================
// Single source of truth for everything shown on Settings → About (and any
// future place that needs product identity). Nothing here is duplicated from
// the database: customer/company identity ALWAYS comes from company_profiles
// at runtime — this file only describes the PRODUCT.
//
// Deploying this ERP for another company requires zero code changes on the
// About page: set VITE_APP_NAME (optional) and maintain the Company Profile.
// ============================================================================

export const APP_INFO = {
  /** Product name — overridable per deployment via VITE_APP_NAME. */
  name: (import.meta.env.VITE_APP_NAME as string | undefined) || 'SAPJ Pharma ERP',
  tagline: 'Enterprise Resource Planning System',
  /** Current release. Bump here (only here) on each release. */
  version: 'v1.4.0',
  /** Stamped by Vite at build time — never hand-edited. */
  buildDate: __BUILD_DATE__,
  status: 'Production',
  environment: 'Cloud ERP (Bolt + Supabase)',
  technology: 'React + TypeScript + Supabase',
  database: 'PostgreSQL (Supabase)',
  license: 'Custom Enterprise License',
  /** Default country shown when the Company Profile has no address country. */
  defaultCountry: 'Indonesia',
} as const;

export interface VersionEntry {
  version: string;
  date: string; // ISO
  title: string;
  summary: string;
}

/** Release timeline, newest first. The first entry is the current release. */
export const VERSION_HISTORY: VersionEntry[] = [
  {
    version: 'v1.4.0',
    date: '2026-08-10',
    title: 'Finance & Tax Compliance Consolidation',
    summary: 'Certified Finance workflows consolidated with master-driven expense categories, canonical COA posting, strict bank settlement reconciliation, and source-authoritative PPN/PPh registers and payments.',
  },
  {
    version: 'v1.3.1',
    date: '2026-08-01',
    title: 'ERP Production Certification',
    summary: 'Finance Version 1.0 and Inventory Version 1.0 certified for controlled daily production use with deterministic migrations and authenticated regression coverage.',
  },
  {
    version: 'v1.3.0',
    date: '2026-07-14',
    title: 'Company Profile Versioning',
    summary: 'Versioned company identity with immutable document snapshots; PPN Summary & Register; Faktur Pajak issuance from Company Profile.',
  },
  {
    version: 'v1.2.0',
    date: '2026-07-13',
    title: 'Tax Compliance Centre',
    summary: 'PPN/PPh tax periods engine, Faktur Pajak register, tax payments with journal integration, period close controls.',
  },
  {
    version: 'v1.1.0',
    date: '2026-07-02',
    title: 'Finance & Accounting',
    summary: 'Double-entry accounting engine, AP/AR, expenses, payment vouchers, bank reconciliation, financial audit reports.',
  },
  {
    version: 'v1.0.0',
    date: '2026-06-25',
    title: 'Initial Production Release',
    summary: 'Inventory with batch traceability, sales & purchasing, CRM/sourcing, printable business documents.',
  },
];

export interface ComplianceItem {
  label: string;
  detail: string;
}

/** Capabilities that exist in the system today — shown as the audit checklist. */
export const COMPLIANCE_ITEMS: ComplianceItem[] = [
  { label: 'Audit Trail Enabled', detail: 'State-changing operations write to audit_logs' },
  { label: 'Role Based Access Control', detail: 'Admin / Accounts / Sales / Warehouse roles' },
  { label: 'Double Entry Accounting', detail: 'Balanced journal entries on every financial document' },
  { label: 'Indonesian Tax Compliance', detail: 'PPN, PPh 21/22/23/4(2), Faktur Pajak, e-filing calendar' },
  { label: 'Document Versioning', detail: 'Company profile snapshots retained on supported business documents' },
  { label: 'Database Backups', detail: 'Managed PostgreSQL backups + in-app backup download' },
  { label: 'Electronic Document Storage', detail: 'Invoices, fakturs and attachments in cloud storage' },
  { label: 'User Activity Logging', detail: 'Author and timestamp captured on records' },
  { label: 'Row Level Security', detail: 'Postgres RLS enforced on application tables' },
  { label: 'Inventory Batch Traceability', detail: 'Batch-level stock movements end to end' },
  { label: 'Bank Reconciliation', detail: 'Statement lines matched to journals and vouchers' },
  { label: 'Financial Audit Reports', detail: 'Trial balance, ledgers, ageing, financial statements and tax reports' },
];

/**
 * Statistics that cannot be read live from the browser (no client access to
 * pg_catalog). Maintained per release alongside VERSION_HISTORY; live values
 * (users, tables, functions, buckets) are fetched at runtime and override
 * these when available.
 */
export const STATIC_STATS = {
  modules: 9,          // Dashboard, Inventory, Sales, Purchasing, CRM, Sourcing, Finance, Reports, Settings
  databaseTables: 90,
  databaseFunctions: 120,
  securityPolicies: 250,
  storageBuckets: 8,
  reports: 14,
  // TaxReportsPanel defines the nine current report tabs. This remains a
  // fallback because the About page must render before authenticated data loads.
  taxReports: 9,
} as const;
