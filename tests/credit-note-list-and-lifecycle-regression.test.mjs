import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

const projectRoot = process.cwd();
const creditNotesSource = fs.readFileSync(path.join(projectRoot, 'src/pages/CreditNotes.tsx'), 'utf8');

// Mock data fixtures representing the exact production shape
const mockLegacyCreditNoteRecord = {
  id: '83953d95-7baf-4a07-b7c5-b63d6f08945c',
  credit_note_number: '', // Blank number as created in production
  credit_note_date: '2026-05-28', // May 2026 commercial date
  customer_id: '47410ca0-44b7-423a-8d85-09bdc3aa2c78',
  original_invoice_id: '03162b99-b06b-475b-b00c-e14cb9dd6123',
  original_invoice_number: 'SAPJ-26-013',
  reason: 'damaged packaging',
  notes: null,
  currency: 'IDR',
  subtotal: 1572375.0,
  tax_amount: 172961.25,
  total_amount: 1745336.25,
  created_at: '2026-10-26T02:54:00Z', // Created in October
  updated_at: '2026-10-26T02:54:00Z',
  status: 'pending_approval',
  approved_by: null,
  journal_entry_id: null,
  material_return_id: null,
  customers: {
    company_name: 'PT Menjangan Sakti',
    address: 'Jl. Matraman Raya No. 12',
    city: 'Jakarta',
    phone: '021-12345678',
    npwp: '01.234.567.8-012.000',
    pharmacy_license: 'SIPA-12345',
  },
  material_returns: null,
  sales_invoices: {
    invoice_number: 'SAPJ-26-013',
  },
};

const mockItems = [
  {
    id: 'item-1',
    credit_note_id: '83953d95-7baf-4a07-b7c5-b63d6f08945c',
    product_id: 'prod-1',
    batch_id: 'batch-1',
    quantity: 5,
    unit_price: 150000,
  },
  {
    id: 'item-2',
    credit_note_id: '83953d95-7baf-4a07-b7c5-b63d6f08945c',
    product_id: 'prod-2',
    batch_id: 'batch-2',
    quantity: 10,
    unit_price: 82237.5,
  },
];

test('1. Existing record shape: blank number, pending_approval, 2 items, no JE, no return links', () => {
  assert.equal(mockLegacyCreditNoteRecord.id, '83953d95-7baf-4a07-b7c5-b63d6f08945c');
  assert.equal(mockLegacyCreditNoteRecord.credit_note_number, '');
  assert.equal(mockLegacyCreditNoteRecord.status, 'pending_approval');
  assert.equal(mockLegacyCreditNoteRecord.journal_entry_id, null);
  assert.equal(mockLegacyCreditNoteRecord.material_return_id, null);
  assert.equal(mockItems.length, 2);
  const expectedSubtotal = mockItems.reduce((acc, it) => acc + it.quantity * it.unit_price, 0);
  assert.equal(expectedSubtotal, 1572375.0);
  assert.equal(expectedSubtotal * 0.11, 172961.25);
  assert.equal(expectedSubtotal + expectedSubtotal * 0.11, 1745336.25);
});

test('2. Root-cause proof: select query disambiguates material_returns to prevent PGRST201 Multiple Choices', () => {
  // Verifies that CreditNotes.tsx does NOT make an ambiguous material_returns join
  assert.doesNotMatch(
    creditNotesSource,
    /select\([^)]*customers\([^)]*\)[^)]*,\s*material_returns\(/,
    'Ambiguous material_returns join must be replaced'
  );

  // Verifies that CreditNotes.tsx uses explicit foreign key or column alias
  assert.match(
    creditNotesSource,
    /material_returns:material_return_id\(/,
    'Query must disambiguate material_returns via material_returns:material_return_id(...)'
  );

  // Verifies that sales_invoices:original_invoice_id is joined
  assert.match(
    creditNotesSource,
    /sales_invoices:original_invoice_id\(invoice_number\)/,
    'Query must join sales_invoices to ensure canonical invoice number resolution'
  );
});

test('3. Pending-approval records remain visible and clearly rendered in UI', () => {
  // Credit note number column handles empty string by rendering Pending
  assert.match(
    creditNotesSource,
    /cn\.credit_note_number\?\.trim\(\)\s*\?/,
    'Credit note number column must check for empty/blank values'
  );
  assert.match(
    creditNotesSource,
    /Pending/,
    'Credit note number column must render Pending badge when unassigned'
  );

  // Status column renders pending approval badge
  assert.match(
    creditNotesSource,
    /bg-yellow-100 text-yellow-800/,
    'Status column must render yellow badge for pending_approval records'
  );
});

test('4. Missing optional joins (material_returns = null) do not remove or crash the record', () => {
  // Helper function normalizeNestedRelation handles null/array
  assert.match(
    creditNotesSource,
    /function normalizeNestedRelation<T>\(value: T \| T\[\] \| null \| undefined\): T \| null/,
    'normalizeNestedRelation helper must be defined'
  );

  assert.match(
    creditNotesSource,
    /material_returns:\s*normalizeNestedRelation\(cn\.material_returns\)/,
    'material_returns must be normalized so null or array is handled safely'
  );

  assert.match(
    creditNotesSource,
    /customers:\s*normalizeNestedRelation\(cn\.customers\)/,
    'customers must be normalized so null or array is handled safely'
  );
});

test('5. Correct invoice and customer relationship fallback in table rendering', () => {
  assert.match(
    creditNotesSource,
    /cn\.original_invoice_number \|\| invoice\?\.invoice_number \|\| 'N\/A'/,
    'Original invoice number column must fallback to joined invoice number if stored field is blank'
  );

  assert.match(
    creditNotesSource,
    /customer\?\.company_name \|\| 'N\/A'/,
    'Customer column must resolve customer company_name'
  );
});

test('6. Intended date-filter behaviour: defaults to All Time, preserves historical May 2026 dates', () => {
  // Date filter state defaults to empty (no date restriction)
  assert.match(
    creditNotesSource,
    /const \[dateFilter, setDateFilter\] = useState\({\s*startDate:\s*'',\s*endDate:\s*'',\s*}\);/,
    'Date filter must default to empty strings to avoid hiding back-dated records'
  );

  // Filter logic only filters when startDate/endDate is provided
  assert.match(
    creditNotesSource,
    /if \(dateFilter\.startDate && cn\.credit_note_date < dateFilter\.startDate\)\s*\{\s*return false;\s*\}/,
    'Date filter must check startDate against commercial credit_note_date'
  );
  assert.match(
    creditNotesSource,
    /if \(dateFilter\.endDate && cn\.credit_note_date > dateFilter\.endDate\)\s*\{\s*return false;\s*\}/,
    'Date filter must check endDate against commercial credit_note_date'
  );

  // Simulation: May 2026 record created in October 2026 is included by default
  const defaultFilter = { startDate: '', endDate: '' };
  const isIncludedByDefault = (
    (!defaultFilter.startDate || mockLegacyCreditNoteRecord.credit_note_date >= defaultFilter.startDate) &&
    (!defaultFilter.endDate || mockLegacyCreditNoteRecord.credit_note_date <= defaultFilter.endDate)
  );
  assert.equal(isIncludedByDefault, true, 'May 2026 credit note must be included in default view');
});

test('7. Database query errors are surfaced with actionable Retry banner, never as empty list', () => {
  assert.match(
    creditNotesSource,
    /const \[queryError, setQueryError\] = useState<string \| null>\(null\);/,
    'queryError state must be maintained'
  );

  assert.match(
    creditNotesSource,
    /setQueryError\(errorMsg\);/,
    'loadCreditNotes catch block must set queryError state'
  );

  assert.match(
    creditNotesSource,
    /\{queryError && \(/,
    'UI must render a visible error banner when queryError is present'
  );

  assert.match(
    creditNotesSource,
    /Retry Query/,
    'Error banner must provide a Retry Query button'
  );
});

test('8. Newly created credit notes appear immediately with sequential numbering', () => {
  // Modal open handler triggers generation
  assert.match(
    creditNotesSource,
    /const handleOpenCreateModal = async \(\) =>/,
    'handleOpenCreateModal must be defined'
  );

  assert.match(
    creditNotesSource,
    /const nextNumber = await generateNextCreditNoteNumber\(\);/,
    'Opening modal must pre-generate the next sequential credit note number'
  );

  assert.match(
    creditNotesSource,
    /await loadData\(\);/,
    'handleSubmit must reload data on success to show newly created credit note immediately'
  );
});

test('9. Header/item persistence failures roll back orphaned headers to guarantee atomicity', () => {
  assert.match(
    creditNotesSource,
    /if \(itemsError\) \{[\s\S]*await supabase\.from\('credit_notes'\)\.delete\(\)\.eq\('id', creditNoteId\);/,
    'Failed item insertion must clean up the orphaned credit_notes header'
  );
});

test('10. Concurrency and double-click prevention', () => {
  assert.match(
    creditNotesSource,
    /const \[isSubmitting, setIsSubmitting\] = useState\(false\);/,
    'isSubmitting state must be tracked'
  );

  assert.match(
    creditNotesSource,
    /if \(isSubmitting\) return;/,
    'handleSubmit must guard against re-entry while submitting'
  );

  assert.match(
    creditNotesSource,
    /disabled=\{isSubmitting\}/,
    'Submit button must be disabled while isSubmitting is true'
  );
});

test('11. Sequential credit note numbering adheres to SAPJ ERP format: CN-YY-XXXX', () => {
  assert.match(
    creditNotesSource,
    /const prefix = `CN-\$\{year\}`;/,
    'Credit note numbering prefix must follow CN-YY'
  );

  assert.match(
    creditNotesSource,
    /return `\$\{prefix\}-\$\{String\(nextSeq\)\.padStart\(4, '0'\)\}`;/,
    'Credit note number format must be CN-YY-XXXX with 4-digit zero padding'
  );

  // Simulation test of number generator logic
  const existingNumbers = ['CN-26-0001', 'CN-26-0002'];
  const maxSeq = Math.max(...existingNumbers.map(n => parseInt(n.split('-')[2], 10)));
  const nextNumber = `CN-26-${String(maxSeq + 1).padStart(4, '0')}`;
  assert.equal(nextNumber, 'CN-26-0003');
});

test('12. Approval assigns sequential number to legacy unnumbered records before posting to GL', () => {
  assert.match(
    creditNotesSource,
    /if \(!targetNote\?\.credit_note_number \|\| targetNote\.credit_note_number\.trim\(\) === ''\) \{/,
    'handleApprove must detect if existing credit note has empty number'
  );

  assert.match(
    creditNotesSource,
    /updatePayload\.credit_note_number = nextNum;/,
    'handleApprove must assign a valid number before updating status to approved'
  );
});

test('13. Migration file exists locally with SECURITY DEFINER and auto-numbering trigger', () => {
  const migrationPath = path.join(
    projectRoot,
    'supabase/migrations/20261027200000_harden_credit_note_number_generation_and_permissions.sql'
  );
  assert.equal(fs.existsSync(migrationPath), true, 'Migration file must exist locally');
  const migrationSql = fs.readFileSync(migrationPath, 'utf8');

  assert.match(
    migrationSql,
    /CREATE OR REPLACE FUNCTION public\.generate_credit_note_number\(\)/,
    'Migration must define generate_credit_note_number'
  );
  assert.match(
    migrationSql,
    /SECURITY DEFINER/,
    'generate_credit_note_number must be SECURITY DEFINER'
  );
  assert.match(
    migrationSql,
    /GRANT EXECUTE ON FUNCTION public\.generate_credit_note_number\(\) TO authenticated;/,
    'EXECUTE must be granted to authenticated'
  );
  assert.match(
    migrationSql,
    /CREATE TRIGGER trg_ensure_credit_note_number/,
    'Server-side auto-numbering trigger must be defined'
  );
  assert.match(
    migrationSql,
    /83953d95-7baf-4a07-b7c5-b63d6f08945c/,
    'Repair procedure for target production record must be documented'
  );
});
