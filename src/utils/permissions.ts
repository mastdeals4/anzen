import type { UserRole } from '../lib/supabase';

export interface ModulePermission {
  module: string;
  label: string;
  can_access: boolean;
}

/**
 * Module catalogue with the clean Pricing labels matching the sidebar:
 *   Pricing Overview · Sourcing Outbox · Pricing Worksheet · Price History
 *
 * The older internal IDs (price-requests, pricing-desk, pricing-parser-review)
 * are kept as routes for admin/debug but marked `advanced: true` so the
 * permission UI can hide them from normal day-to-day permission editing.
 */
export const ALL_MODULES = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'products', label: 'Products' },
  { id: 'batches', label: 'Batches' },
  { id: 'stock', label: 'Stock' },
  { id: 'customers', label: 'Customers' },
  { id: 'sales-orders', label: 'Sales Orders' },
  { id: 'delivery-challan', label: 'Delivery Challan' },
  { id: 'sales', label: 'Sales Invoices' },
  { id: 'purchase-orders', label: 'Purchase Orders' },
  { id: 'import-requirements', label: 'Import Requirements' },
  { id: 'import-containers', label: 'Import Containers' },
  { id: 'finance', label: 'Finance' },
  { id: 'price-calculator', label: 'Price Calculator' },
  { id: 'crm', label: 'CRM' },
  { id: 'command-center', label: 'Command Center' },
  { id: 'tasks', label: 'Tasks' },
  { id: 'inventory', label: 'Inventory Adjustments' },
  { id: 'reports', label: 'Reports' },

  // Pricing — clean labels surfaced in sidebar + permission UI
  { id: 'pricing-dashboard',     label: 'Pricing Overview' },
  { id: 'sourcing-outbox',       label: 'Sourcing Outbox' },
  { id: 'pricing-worksheet',     label: 'Pricing Worksheet' },
  { id: 'pricing-ledger',        label: 'Price History' },

  // Pricing — advanced / debug (hidden from normal permission grid)
  { id: 'price-requests',        label: 'Advanced: Price Requests',  advanced: true },
  { id: 'pricing-desk',          label: 'Advanced: Pricing Desk',    advanced: true },
  { id: 'pricing-parser-review', label: 'Advanced: Parser Review',   advanced: true },

  { id: 'settings', label: 'Settings' },
] as const;

export type ModuleId = typeof ALL_MODULES[number]['id'];

/**
 * Default per-role module access. These should match the live business rules:
 *   admin   — everything
 *   manager — full Pricing group (incl. advanced) for oversight
 *   sales   — CRM + Pricing Overview only (no Sourcing Outbox, no Pricing Worksheet,
 *             no Price History, no advanced pricing)
 *   warehouse / accounts / auditor_ca — no pricing modules at all
 */
const ROLE_DEFAULT_MODULES: Record<UserRole, ModuleId[]> = {
  admin: ALL_MODULES.map(m => m.id) as ModuleId[],

  manager: [
    'dashboard', 'products', 'batches', 'stock', 'customers',
    'sales-orders', 'delivery-challan', 'sales', 'purchase-orders',
    'import-requirements', 'import-containers', 'finance', 'price-calculator',
    'crm', 'command-center', 'tasks', 'inventory', 'reports',
    'pricing-dashboard', 'sourcing-outbox', 'pricing-worksheet', 'pricing-ledger',
    // Advanced pricing intentionally NOT given by default to manager either —
    // can be enabled per-user from the permission grid if needed.
  ],

  accounts: [
    'dashboard', 'batches', 'stock', 'customers', 'sales-orders',
    'delivery-challan', 'sales', 'purchase-orders', 'import-containers',
    'finance', 'tasks', 'settings',
  ],

  sales: [
    'dashboard', 'products', 'stock', 'customers', 'sales-orders',
    'delivery-challan', 'sales', 'purchase-orders', 'import-requirements',
    'price-calculator', 'crm', 'command-center', 'tasks', 'settings',
    // Pricing for sales = Pricing Overview only.
    // No Sourcing Outbox. No Pricing Worksheet. No Price History.
    'pricing-dashboard',
  ],

  warehouse: [
    'dashboard', 'products', 'batches', 'stock', 'customers', 'sales-orders',
    'delivery-challan', 'sales', 'purchase-orders', 'import-containers',
    'tasks', 'inventory', 'settings',
  ],

  auditor_ca: ['dashboard', 'sales', 'purchase-orders', 'finance'],
};

export function getDefaultModulesForRole(role: UserRole): ModuleId[] {
  return ROLE_DEFAULT_MODULES[role] ?? [];
}

export function buildPermissionsFromRole(role: UserRole): Record<ModuleId, boolean> {
  const defaults = getDefaultModulesForRole(role);
  const result = {} as Record<ModuleId, boolean>;
  for (const mod of ALL_MODULES) {
    result[mod.id] = defaults.includes(mod.id);
  }
  return result;
}

export function resolveAccessibleModules(
  role: UserRole,
  dbPermissions: { module: string; can_access: boolean }[] | null
): Set<string> {
  if (role === 'admin') {
    return new Set(ALL_MODULES.map(m => m.id));
  }

  if (!dbPermissions || dbPermissions.length === 0) {
    return new Set(getDefaultModulesForRole(role));
  }

  const accessible = new Set<string>();
  for (const p of dbPermissions) {
    if (p.can_access) {
      accessible.add(p.module);
    }
  }
  return accessible;
}

/**
 * Pricing role helpers — used by the UI to decide what sensitive pricing
 * fields (P.Price, source price, USD landed cost) to render.
 */
export function canSeeInternalPricing(role: UserRole | string | null | undefined): boolean {
  return role === 'admin' || role === 'manager';
}

export function canSeeInventoryCosting(role: UserRole | string | null | undefined): boolean {
  return role === 'admin' || role === 'accounts' || role === 'manager';
}

export function canSeeFinalQuote(role: UserRole | string | null | undefined, priceReady: boolean | null | undefined): boolean {
  if (role === 'admin' || role === 'manager') return true;
  if (role === 'sales') return !!priceReady;
  return false;
}
