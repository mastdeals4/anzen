import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// Helper mimicking Batches.tsx unified search filtering logic
function filterBatches({ batches, importContainers, batchSearch, showArchived }) {
  const containerMap = new Map();
  importContainers.forEach(c => {
    if (c.id && c.container_ref) {
      containerMap.set(c.id, c.container_ref);
    }
  });

  const q = batchSearch.trim().toLowerCase().replace(/\s+/g, ' ');
  return batches.filter(batch => {
    const isArchived = !batch.is_active;
    if (!showArchived && isArchived) return false;
    if (!q) return true;

    const batchNo = (batch.batch_number || '').toLowerCase();
    const prodName = (batch.products?.product_name || '').toLowerCase();
    const prodCode = (batch.products?.product_code || '').toLowerCase();
    const supplier = (batch.product_sources?.supplier_name || '').toLowerCase();
    const containerRef = (
      batch.import_containers?.container_ref ||
      (batch.import_container_id ? containerMap.get(batch.import_container_id) : '') ||
      ''
    ).toLowerCase();

    // 1. Direct match on any unified dimension
    if (
      batchNo.includes(q) ||
      prodName.includes(q) ||
      prodCode.includes(q) ||
      supplier.includes(q) ||
      containerRef.includes(q)
    ) {
      return true;
    }

    // 2. Multi-word keyword match across combined batch identity
    if (q.includes(' ')) {
      const combined = `${batchNo} ${prodName} ${prodCode} ${supplier} ${containerRef}`;
      return q.split(' ').every(word => combined.includes(word));
    }

    return false;
  });
}

// Mock dataset representing realistic batches across containers
const mockContainers = [
  { id: 'ctr-1', container_ref: '1st 20MT FCL NOV 25', status: 'arrived' },
  { id: 'ctr-2', container_ref: '2nd FCL 20MT - FEB26', status: 'arrived' },
  { id: 'ctr-3', container_ref: 'E0000167/2627 – LCL CEFIXIME', status: 'arrived' },
  { id: 'ctr-4', container_ref: 'E0000117/2627 - Air - Pregabalin', status: 'draft' },
];

const mockBatches = [
  // Container 1: 1st 20MT FCL NOV 25 (Multiple batches: Ibuprofen USP & Paracetamol)
  {
    id: 'b-1',
    batch_number: 'XMAL250001',
    product_id: 'p-ibu',
    products: { product_name: 'Ibuprofen USP', product_code: 'IBU-USP', unit: 'KG' },
    product_sources: { supplier_name: 'Shandong Xinhua' },
    import_container_id: 'ctr-1',
    import_containers: { container_ref: '1st 20MT FCL NOV 25' },
    import_quantity: 5000,
    current_stock: 5000,
    is_active: true,
  },
  {
    id: 'b-2',
    batch_number: 'XMAL250002',
    product_id: 'p-ibu',
    products: { product_name: 'Ibuprofen USP', product_code: 'IBU-USP', unit: 'KG' },
    product_sources: { supplier_name: 'Shandong Xinhua' },
    import_container_id: 'ctr-1',
    import_containers: { container_ref: '1st 20MT FCL NOV 25' },
    import_quantity: 5000,
    current_stock: 3500,
    is_active: true,
  },
  {
    id: 'b-3',
    batch_number: 'PARA25001',
    product_id: 'p-para',
    products: { product_name: 'Paracetamol USP', product_code: 'PARA-USP', unit: 'KG' },
    product_sources: { supplier_name: 'Farmson' },
    import_container_id: 'ctr-1',
    import_containers: { container_ref: '1st 20MT FCL NOV 25' },
    import_quantity: 10000,
    current_stock: 10000,
    is_active: true,
  },

  // Container 2: 2nd FCL 20MT - FEB26 (A-0512B)
  {
    id: 'b-4',
    batch_number: '4002/1101/25/A-0512B',
    product_id: 'p-ibu',
    products: { product_name: 'Ibuprofen USP', product_code: 'IBU-USP', unit: 'KG' },
    product_sources: { supplier_name: 'IOL Chemicals' },
    import_container_id: 'ctr-2',
    import_containers: { container_ref: '2nd FCL 20MT - FEB26' },
    import_quantity: 5000,
    current_stock: 5000,
    is_active: true,
  },

  // Container 3: E0000167/2627 – LCL CEFIXIME (Cefixime batches)
  {
    id: 'b-5',
    batch_number: 'CEF260101',
    product_id: 'p-cef',
    products: { product_name: 'Cefixime Trihydrate', product_code: 'CEF-TRI', unit: 'KG' },
    product_sources: { supplier_name: 'Aurobindo' },
    import_container_id: 'ctr-3',
    // Emulate sparse import_containers join where containerMap resolves via import_container_id
    import_containers: null,
    import_quantity: 250,
    current_stock: 250,
    is_active: true,
  },
  {
    id: 'b-6',
    batch_number: 'CEF260102',
    product_id: 'p-cef',
    products: { product_name: 'Cefixime Trihydrate', product_code: 'CEF-TRI', unit: 'KG' },
    product_sources: { supplier_name: 'Aurobindo' },
    import_container_id: 'ctr-3',
    import_containers: { container_ref: 'E0000167/2627 – LCL CEFIXIME' },
    import_quantity: 250,
    current_stock: 150,
    is_active: true,
  },

  // Container 4: E0000117/2627 - Air - Pregabalin (PRGI/B2606008)
  {
    id: 'b-7',
    batch_number: 'PRGI/B2606008',
    product_id: 'p-preg',
    products: { product_name: 'Pregabalin', product_code: 'PREG-API', unit: 'KG' },
    product_sources: { supplier_name: 'Megafine' },
    import_container_id: 'ctr-4',
    import_containers: { container_ref: 'E0000117/2627 - Air - Pregabalin' },
    import_quantity: 100,
    current_stock: 0,
    is_active: true,
  },

  // Archived batch
  {
    id: 'b-8',
    batch_number: 'OLD-ARCHIVED-001',
    product_id: 'p-ibu',
    products: { product_name: 'Ibuprofen USP', product_code: 'IBU-USP', unit: 'KG' },
    product_sources: { supplier_name: 'Shandong Xinhua' },
    import_container_id: 'ctr-1',
    import_containers: { container_ref: '1st 20MT FCL NOV 25' },
    import_quantity: 1000,
    current_stock: 0,
    is_active: false,
  },
];

test('1. Search "1st 20MT FCL NOV 25" returns all linked batches across products', () => {
  const result = filterBatches({
    batches: mockBatches,
    importContainers: mockContainers,
    batchSearch: '1st 20MT FCL NOV 25',
    showArchived: false,
  });

  // Should return b-1 (Ibuprofen), b-2 (Ibuprofen), and b-3 (Paracetamol)
  assert.equal(result.length, 3);
  const batchNumbers = result.map(b => b.batch_number).sort();
  assert.deepEqual(batchNumbers, ['PARA25001', 'XMAL250001', 'XMAL250002']);
});

test('2. Search "E0000167/2627" returns all Cefixime batches linked to that container', () => {
  const result = filterBatches({
    batches: mockBatches,
    importContainers: mockContainers,
    batchSearch: 'E0000167/2627',
    showArchived: false,
  });

  // b-5 has import_containers = null, but import_container_id = 'ctr-3'
  // b-6 has container_ref text
  // Both must be returned through unified relationship resolution
  assert.equal(result.length, 2);
  const batchNumbers = result.map(b => b.batch_number).sort();
  assert.deepEqual(batchNumbers, ['CEF260101', 'CEF260102']);
});

test('3. Search "Pregabalin" returns all Pregabalin batches', () => {
  const result = filterBatches({
    batches: mockBatches,
    importContainers: mockContainers,
    batchSearch: 'Pregabalin',
    showArchived: false,
  });

  assert.equal(result.length, 1);
  assert.equal(result[0].batch_number, 'PRGI/B2606008');
  assert.equal(result[0].products.product_name, 'Pregabalin');
});

test('4. Search "PRGI/B2606008" returns exact batch match', () => {
  const result = filterBatches({
    batches: mockBatches,
    importContainers: mockContainers,
    batchSearch: 'PRGI/B2606008',
    showArchived: false,
  });

  assert.equal(result.length, 1);
  assert.equal(result[0].batch_number, 'PRGI/B2606008');
});

test('5. Search "A-0512B" returns the 2nd FCL batch', () => {
  const result = filterBatches({
    batches: mockBatches,
    importContainers: mockContainers,
    batchSearch: 'A-0512B',
    showArchived: false,
  });

  assert.equal(result.length, 1);
  assert.equal(result[0].batch_number, '4002/1101/25/A-0512B');
});

test('6. Clear search returns all active batches', () => {
  const result = filterBatches({
    batches: mockBatches,
    importContainers: mockContainers,
    batchSearch: '',
    showArchived: false,
  });

  // 7 active batches (b-1 through b-7); b-8 is archived
  assert.equal(result.length, 7);
});

test('7. Search normalization: trims spaces and handles case-insensitivity', () => {
  // Extra leading/trailing spaces and mixed case
  const result = filterBatches({
    batches: mockBatches,
    importContainers: mockContainers,
    batchSearch: '   e0000167/2627   ',
    showArchived: false,
  });

  assert.equal(result.length, 2);

  // Multi-spaced search
  const resultMultiSpace = filterBatches({
    batches: mockBatches,
    importContainers: mockContainers,
    batchSearch: '1st   20mt   fcl',
    showArchived: false,
  });

  assert.equal(resultMultiSpace.length, 3);
});

test('8. Archived filtering preservation', () => {
  // When showArchived = false, b-8 is omitted
  const activeResult = filterBatches({
    batches: mockBatches,
    importContainers: mockContainers,
    batchSearch: '1st 20MT FCL NOV 25',
    showArchived: false,
  });
  assert.equal(activeResult.length, 3);

  // When showArchived = true, b-8 is included
  const allResult = filterBatches({
    batches: mockBatches,
    importContainers: mockContainers,
    batchSearch: '1st 20MT FCL NOV 25',
    showArchived: true,
  });
  assert.equal(allResult.length, 4);
});

test('9. Source Code Static Integrity: Batches.tsx Search Implementation', () => {
  const batchesCode = fs.readFileSync('src/pages/Batches.tsx', 'utf8');

  // Verify containerMap memoization
  assert.match(batchesCode, /const containerMap = useMemo/);
  assert.match(batchesCode, /map\.set\(c\.id, c\.container_ref\)/);

  // Verify containerRef check in filter
  assert.match(batchesCode, /containerRef\.includes\(q\)/);
  assert.match(batchesCode, /batch\.import_containers\?\.container_ref/);
  assert.match(batchesCode, /containerMap\.get\(batch\.import_container_id\)/);

  // Verify input placeholder
  assert.match(batchesCode, /placeholder="Search by batch #, product, or import container\.\.\."/);
});

