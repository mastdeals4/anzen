import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

test('1. Shared toolbar layout and deduplicated controls in CrmCustomersWorkspace.tsx', () => {
  const filePath = path.join(process.cwd(), 'src/components/crm/customers/CrmCustomersWorkspace.tsx');
  assert.ok(fs.existsSync(filePath), 'CrmCustomersWorkspace.tsx must exist');

  const content = fs.readFileSync(filePath, 'utf-8');

  // Shared search input placeholder
  assert.match(
    content,
    /placeholder="Search customers by company, contact person, email, phone or city\.\.\."/,
    'Must have single shared search input with exact placeholder'
  );

  // Exactly one "New Customer" button definition
  const newCustomerMatches = content.match(/>\s*New Customer\s*</g);
  assert.equal(newCustomerMatches?.length, 1, 'Must have exactly one "New Customer" button in workspace');

  // Single view switcher: Directory | Excel Spreadsheet
  assert.match(content, /title="Directory View"/, 'Must have Directory view button');
  assert.match(content, /title="Excel Spreadsheet View"/, 'Must have Excel Spreadsheet view button');

  // Passing externalSearch and hideToolbarSearchAndAdd to CustomerDatabaseExcel
  assert.match(content, /<CustomerDatabaseExcel[\s\S]*externalSearch=\{searchQuery\}[\s\S]*hideToolbarSearchAndAdd=\{true\}/,
    'Must pass externalSearch and hideToolbarSearchAndAdd to CustomerDatabaseExcel');

  // Persistent rendering: both views kept in DOM (no unmounting on switch)
  assert.match(content, /viewMode === 'directory' \? 'space-y-4' : 'hidden'/,
    'Directory view must use hidden class when inactive to preserve state');
  assert.match(content, /viewMode === 'excel' \? '.*' : 'hidden'/,
    'Excel Spreadsheet view must use hidden class when inactive to preserve unsaved edits');
});

test('2. Deduplicated toolbar in CustomerDatabaseExcel.tsx', () => {
  const filePath = path.join(process.cwd(), 'src/components/crm/CustomerDatabaseExcel.tsx');
  assert.ok(fs.existsSync(filePath), 'CustomerDatabaseExcel.tsx must exist');

  const content = fs.readFileSync(filePath, 'utf-8');

  // Props interface supports externalSearch and hideToolbarSearchAndAdd
  assert.match(content, /export interface CustomerDatabaseExcelProps/, 'Must export CustomerDatabaseExcelProps');
  assert.match(content, /externalSearch\?: string;/, 'Must support externalSearch prop');
  assert.match(content, /hideToolbarSearchAndAdd\?: boolean;/, 'Must support hideToolbarSearchAndAdd prop');

  // Duplicate Add Customer button is hidden when hideToolbarSearchAndAdd is true
  assert.match(content, /\{!hideToolbarSearchAndAdd && \([\s\S]*Add Customer[\s\S]*\)\}/,
    'Must hide internal Add Customer button when hideToolbarSearchAndAdd is true');

  // Duplicate search bar is hidden when hideToolbarSearchAndAdd is true
  assert.match(content, /\{!hideToolbarSearchAndAdd && \([\s\S]*name="search_term"[\s\S]*\)\}/,
    'Must hide internal search bar when hideToolbarSearchAndAdd is true');

  // Search filtering applies externalSearch
  assert.match(content, /const activeSearch = \(externalSearch !== undefined \? externalSearch : searchTerm\)\.trim\(\);/,
    'Must filter on externalSearch when provided');
});

test('3. Control Center CRM navigation accessibility in CRM.tsx', () => {
  const filePath = path.join(process.cwd(), 'src/pages/CRM.tsx');
  assert.ok(fs.existsSync(filePath), 'CRM.tsx must exist');

  const content = fs.readFileSync(filePath, 'utf-8');

  // Control Center tab in primary tabs
  assert.match(content, /\['control-center', Sparkles, 'CONTROL CENTER'\]/,
    'CONTROL CENTER tab must be present in primary navigation');

  // Renders EnquiryControlCenter
  assert.match(content, /activeTab === 'control-center' && \([\s\S]*<EnquiryControlCenter/,
    'Must render EnquiryControlCenter when activeTab is control-center');
});
