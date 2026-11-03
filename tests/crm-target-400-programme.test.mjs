import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

test('1. CrmCustomersWorkspace supports prospect classifications (Pharma Mfr, API Mfr, Distributor, etc.)', () => {
  const wsPath = path.join(process.cwd(), 'src/components/crm/customers/CrmCustomersWorkspace.tsx');
  const src = fs.readFileSync(wsPath, 'utf-8');

  assert.match(src, /classificationFilter|company_type|industry/i, 'Must support classification filtering');
  assert.match(src, /Pharma Mfr|Pharma Manufacturer|Distributor/i, 'Must support pharmaceutical classifications');
});

test('2. CrmCustomerDrawer supports LinkedIn interaction logging in customer timeline', () => {
  const drawerPath = path.join(process.cwd(), 'src/components/crm/customers/CrmCustomerDrawer.tsx');
  const src = fs.readFileSync(drawerPath, 'utf-8');

  assert.match(src, /LinkedIn|linkedin/i, 'Must support LinkedIn interaction logging and display');
});

