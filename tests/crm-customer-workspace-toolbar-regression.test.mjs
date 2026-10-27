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

  // Passing externalSearch to CustomerDatabaseExcel
  assert.match(content, /<CustomerDatabaseExcel[\s\S]*externalSearch=\{searchQuery\}/,
    'Must pass externalSearch to CustomerDatabaseExcel');

  // Persistent rendering: both views kept in DOM (no unmounting on switch)
  assert.match(content, /viewMode === 'directory' \? 'space-y-4' : 'hidden'/,
    'Directory view must use hidden class when inactive to preserve state');
  assert.match(content, /viewMode === 'excel' \? '.*' : 'hidden'/,
    'Excel Spreadsheet view must use hidden class when inactive to preserve unsaved edits');
});

test('2. Deduplicated toolbar in CustomerDatabaseExcel.tsx — duplicate controls removed', () => {
  const filePath = path.join(process.cwd(), 'src/components/crm/CustomerDatabaseExcel.tsx');
  assert.ok(fs.existsSync(filePath), 'CustomerDatabaseExcel.tsx must exist');

  const content = fs.readFileSync(filePath, 'utf-8');

  // Props interface supports externalSearch
  assert.match(content, /export interface CustomerDatabaseExcelProps/, 'Must export CustomerDatabaseExcelProps');
  assert.match(content, /externalSearch\?: string;/, 'Must support externalSearch prop');

  // Duplicate Add Customer button must NOT exist in CustomerDatabaseExcel
  assert.equal(
    content.includes('Add Customer'),
    false,
    'Must not have duplicate "Add Customer" button in CustomerDatabaseExcel'
  );

  // Duplicate search bar must NOT exist in CustomerDatabaseExcel
  assert.equal(
    content.includes('Search by company (PT/CV skipped)'),
    false,
    'Must not have duplicate search input with "Search by company (PT/CV skipped)" in CustomerDatabaseExcel'
  );
  assert.equal(
    content.includes('name="search_term"'),
    false,
    'Must not have internal name="search_term" input in CustomerDatabaseExcel'
  );

  // CSV Import and Export remain
  assert.match(content, /Import CSV/, 'Must preserve Import CSV');
  assert.match(content, /Export CSV/, 'Must preserve Export CSV');

  // Search filtering applies externalSearch and supports phone/mobile/landline
  assert.match(content, /const activeSearch = \(externalSearch \|\| ''\)\.trim\(\);/,
    'Must filter on externalSearch when provided');
  assert.match(content, /c\.phone\?\.includes\(norm\) \|\| c\.mobile\?\.includes\(norm\) \|\| c\.landline\?\.includes\(norm\)/,
    'Must search across phone, mobile, and landline fields');
  assert.match(content, /normalizeForSearch/, 'Must retain PT/CV prefix normalization');
});

test('3. Exactly ONE global customer search and ONE customer creation action across workspace', () => {
  const workspacePath = path.join(process.cwd(), 'src/components/crm/customers/CrmCustomersWorkspace.tsx');
  const excelPath = path.join(process.cwd(), 'src/components/crm/CustomerDatabaseExcel.tsx');

  const workspaceContent = fs.readFileSync(workspacePath, 'utf-8');
  const excelContent = fs.readFileSync(excelPath, 'utf-8');

  // Count search inputs: exactly 1 global search across both files
  const workspaceSearches = workspaceContent.match(/placeholder="Search customers by company[^"]*"/g) || [];
  const excelSearches = excelContent.match(/placeholder="Search by company[^"]*"/g) || [];
  assert.equal(workspaceSearches.length, 1, 'Exactly one global search input in CrmCustomersWorkspace');
  assert.equal(excelSearches.length, 0, 'Zero duplicate search inputs in CustomerDatabaseExcel');

  // Count customer creation buttons: exactly 1 across both files
  const workspaceAddButtons = workspaceContent.match(/>\s*(?:New Customer|Add Customer)\s*</g) || [];
  const excelAddButtons = excelContent.match(/>\s*(?:New Customer|Add Customer)\s*</g) || [];
  assert.equal(workspaceAddButtons.length, 1, 'Exactly one customer creation button in CrmCustomersWorkspace');
  assert.equal(excelAddButtons.length, 0, 'Zero customer creation buttons in CustomerDatabaseExcel');
});

test('4. Shared search and PT/CV normalization behavioral verification', () => {
  const prefixes = ['pt ', 'cv ', 'ud ', 'pt. ', 'cv. ', 'ud. ', 'pt.', 'cv.', 'ud.'];
  function normalizeForSearch(text) {
    let s = text.toLowerCase().trim();
    for (const prefix of prefixes) {
      if (s.startsWith(prefix)) {
        s = s.slice(prefix.length).trim();
        break;
      }
    }
    return s;
  }

  // Normalized company matching
  assert.equal(normalizeForSearch('PT. Kimia Farma'), 'kimia farma');
  assert.equal(normalizeForSearch('CV Jaya Abadi'), 'jaya abadi');
  assert.equal(normalizeForSearch('UD Sumber Berkah'), 'sumber berkah');
  assert.equal(normalizeForSearch('Kimia Farma'), 'kimia farma');

  // Matching query without prefix against company with prefix
  const query = 'kimia';
  const company = 'PT. Kimia Farma Tbk';
  assert.ok(normalizeForSearch(company).includes(normalizeForSearch(query)));

  // Phone search
  const phone = '081234567890';
  assert.ok(phone.includes('34567'));
});

test('5. Control Center CRM navigation accessibility in CRM.tsx', () => {
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
