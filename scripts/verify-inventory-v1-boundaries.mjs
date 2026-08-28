#!/usr/bin/env node

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const failures = [];

function trackedFiles(directory = 'src') {
  const files = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...trackedFiles(file));
    else if (entry.isFile() && /\.(ts|tsx)$/.test(file)) files.push(file);
  }

  return files.sort();
}

function checkSourceFile(file) {
  const source = readFileSync(file, 'utf8');
  const forbidden = [
    {
      label: 'direct inventory_transactions mutation',
      pattern:
        /\.from\(['"]inventory_transactions['"]\)[\s\S]{0,220}\.(insert|update|upsert|delete)\s*\(/g,
    },
    {
      label: 'direct Batch insertion',
      pattern:
        /\.from\(['"]batches['"]\)[\s\S]{0,220}\.(insert|upsert)\s*\(/g,
    },
    {
      label: 'direct current_stock update',
      pattern:
        /\.from\(['"]batches['"]\)[\s\S]{0,260}\.update\s*\(\s*\{[\s\S]{0,180}current_stock\s*:/g,
    },
  ];

  for (const rule of forbidden) {
    if (rule.pattern.test(source)) {
      failures.push(`${file}: ${rule.label}`);
    }
  }
}

for (const file of trackedFiles()) checkSourceFile(file);

const requiredSourceContracts = [
  {
    file: 'src/pages/Batches.tsx',
    pattern: /\.rpc\(['"]save_batch_inventory_v1['"]/,
    message: 'Batch create/edit is not routed through save_batch_inventory_v1',
  },
  {
    file: 'src/pages/SalesOrders.tsx',
    pattern: /\.rpc\(['"]approve_sales_order_product_reservation_v2['"]/,
    message: 'Sales Order approval is not routed through the product-reservation approval RPC',
  },
  {
    file: 'src/pages/Inventory.tsx',
    pattern: /p_transaction_type:\s*['"]adjustment['"]/,
    message: 'Manual stock entry is not adjustment-only',
  },
  {
    file: 'src/pages/Batches.tsx',
    pattern: /\.rpc\(['"]archive_batch_inventory_v1['"]/,
    message: 'Batch archive is not routed through the canonical archive RPC',
  },
  {
    file: 'src/pages/Stock.tsx',
    pattern: /\.from\(['"]inventory_v1_stock_summary['"]\)/,
    message: 'Stock Summary is not using the canonical backend view',
  },
  {
    file: 'src/components/finance/CAReports.tsx',
    pattern: /\.rpc\(\s*['"]inventory_v1_movement_report['"]/,
    message: 'Inventory Movement report is not using the canonical backend RPC',
  },
];

for (const contract of requiredSourceContracts) {
  const source = readFileSync(contract.file, 'utf8');
  if (!contract.pattern.test(source)) {
    failures.push(`${contract.file}: ${contract.message}`);
  }
}

const migrationFile =
  'supabase/migrations/20260801120000_inventory_v1_canonical_stock_engine.sql';
const migration = readFileSync(migrationFile, 'utf8');
const productReservationMigration = readFileSync(
  'supabase/migrations/20260827140000_product_so_reservation_dc_batch_allocation.sql',
  'utf8',
);
const requiredDatabaseContracts = [
  'CREATE OR REPLACE FUNCTION public.post_inventory_movement',
  'CREATE OR REPLACE FUNCTION public.save_batch_inventory_v1',
  'CREATE OR REPLACE FUNCTION public.approve_sales_order_inventory_v1',
  'CREATE OR REPLACE FUNCTION public.trg_dc_approval_deduct_stock',
  'CREATE OR REPLACE FUNCTION public.trg_sales_invoice_item_inventory',
  'CREATE OR REPLACE FUNCTION public.trg_material_return_inventory_v1',
  'CREATE OR REPLACE FUNCTION public.trg_credit_note_inventory_v1',
  'CREATE OR REPLACE FUNCTION public.trg_stock_rejection_inventory_v1',
  'CREATE OR REPLACE FUNCTION public.archive_batch_inventory_v1',
  'CREATE OR REPLACE FUNCTION public.inventory_v1_movement_report',
  'CREATE OR REPLACE VIEW public.inventory_v1_stock_summary',
  'CREATE TRIGGER guard_batch_quantity_canonical_engine',
  'CREATE TRIGGER guard_inventory_movement_canonical_engine',
  'CREATE OR REPLACE FUNCTION public.inventory_v1_certification_status',
];

for (const contract of requiredDatabaseContracts) {
  if (!migration.includes(contract)) {
    failures.push(`${migrationFile}: missing database contract: ${contract}`);
  }
}

for (const contract of [
  'CREATE TABLE IF NOT EXISTS public.so_product_reservations',
  'CREATE OR REPLACE FUNCTION public.approve_sales_order_product_reservation_v2',
  'CREATE OR REPLACE FUNCTION public.consume_so_product_reservation_v2',
  'CREATE OR REPLACE VIEW public.so_product_reservation_status',
]) {
  if (!productReservationMigration.includes(contract)) {
    failures.push(`product reservation migration: missing database contract: ${contract}`);
  }
}

if (failures.length > 0) {
  console.error('Inventory V1 canonical boundary verification failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  'Inventory V1 canonical boundary verification passed: no frontend stock writer bypasses detected.',
);
