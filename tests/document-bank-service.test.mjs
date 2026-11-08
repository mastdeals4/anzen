import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatBytes, buildDeletionPlan, executeSafeDeletion } from '../src/services/crm/documentBankService.ts';

describe('ANZEN CRM Document Bank — Document Bank Service & Safety Guard Tests', () => {
  it('formats bytes correctly across standard boundaries', () => {
    assert.equal(formatBytes(0), '0 B');
    assert.equal(formatBytes(512), '512 B');
    assert.equal(formatBytes(1024), '1.00 KB');
    assert.equal(formatBytes(1048576), '1.00 MB');
    assert.equal(formatBytes(106881358), '101.93 MB');
    assert.equal(formatBytes(320076149), '305.25 MB');
  });

  const mockAllDocs = [
    {
      id: 'doc-1-perm',
      is_permanent: true,
      inquiry_id: null,
      pricing_option_id: null,
      document_type: 'COA',
      storage_path: 'path/cert1.pdf',
      display_file_name: 'cert1.pdf',
      file_size: 1000000,
    },
    {
      id: 'doc-2-inq',
      is_permanent: false,
      inquiry_id: 'inq-123',
      pricing_option_id: null,
      document_type: 'SPEC',
      storage_path: 'path/spec1.pdf',
      display_file_name: 'spec1.pdf',
      file_size: 500000,
      crm_inquiries: [{ inquiry_number: 'INQ-2026-0042' }],
    },
    {
      id: 'doc-3-pricing',
      is_permanent: false,
      inquiry_id: null,
      pricing_option_id: 'po-789',
      document_type: 'PRICE_LIST',
      storage_path: 'path/price.xlsx',
      display_file_name: 'price.xlsx',
      file_size: 200000,
    },
    {
      id: 'doc-4-junk-unique',
      is_permanent: false,
      inquiry_id: null,
      pricing_option_id: null,
      document_type: 'OTHER',
      storage_path: 'path/image001.png',
      display_file_name: 'image001.png',
      file_size: 30000,
    },
    {
      id: 'doc-5-junk-shared-a',
      is_permanent: false,
      inquiry_id: null,
      pricing_option_id: null,
      document_type: 'OTHER',
      storage_path: 'path/shared_doc.pdf',
      display_file_name: 'shared_doc.pdf',
      file_size: 400000,
    },
    {
      id: 'doc-6-junk-shared-b',
      is_permanent: false,
      inquiry_id: null,
      pricing_option_id: null,
      document_type: 'OTHER',
      storage_path: 'path/shared_doc.pdf',
      display_file_name: 'shared_doc_copy.pdf',
      file_size: 400000,
    },
  ];

  it('protects permanent, inquiry-linked, and pricing-linked documents from deletion', () => {
    const selected = [
      mockAllDocs[0], // permanent
      mockAllDocs[1], // inquiry linked
      mockAllDocs[2], // pricing option linked
      mockAllDocs[3], // junk unique
    ];

    const plan = buildDeletionPlan(selected, mockAllDocs);

    assert.equal(plan.totalSelected, 4);
    assert.equal(plan.protected.length, 3);
    assert.equal(plan.eligible.length, 1);
    assert.equal(plan.eligible[0].doc.id, 'doc-4-junk-unique');
    assert.equal(plan.reclaimableBytes, 30000);
    assert.equal(plan.filesToDeleteCount, 1);
  });

  it('safely handles shared storage objects when one copy is deleted and one is retained', () => {
    // Only doc-5 is selected for deletion; doc-6 is NOT selected
    const selected = [mockAllDocs[4]];

    const plan = buildDeletionPlan(selected, mockAllDocs);

    assert.equal(plan.eligible.length, 1);
    assert.equal(plan.eligible[0].isSharedStorage, true);
    // Since doc-6 still uses path/shared_doc.pdf, the physical file must NOT be deleted yet
    assert.equal(plan.reclaimableBytes, 0);
    assert.equal(plan.filesToDeleteCount, 0);
  });

  it('reclaims physical file if all duplicate copies are selected together for deletion', () => {
    // Both doc-5 and doc-6 selected
    const selected = [mockAllDocs[4], mockAllDocs[5]];

    const plan = buildDeletionPlan(selected, mockAllDocs);

    assert.equal(plan.eligible.length, 2);
    assert.equal(plan.eligible[0].isSharedStorage, false);
    assert.equal(plan.eligible[1].isSharedStorage, false);
    // 400000 counted once (not doubled)
    assert.equal(plan.reclaimableBytes, 400000);
    assert.equal(plan.filesToDeleteCount, 1);
  });

  it('runs dry run simulation safely without making actual mutations', async () => {
    const selected = [mockAllDocs[3], mockAllDocs[4], mockAllDocs[5]];
    const plan = buildDeletionPlan(selected, mockAllDocs);

    const result = await executeSafeDeletion(plan, { dryRun: true });

    assert.equal(result.dryRun, true);
    assert.equal(result.success, true);
    assert.equal(result.deletedRecordIds.length, 3);
    assert.equal(result.deletedStoragePaths.length, 2); // path/image001.png and path/shared_doc.pdf
    assert.equal(result.reclaimedBytes, 430000);
    assert.equal(result.failedItems.length, 0);
  });
});

