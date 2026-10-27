import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

test('CRM Inquiry Multi-Product Item Documents Required Regression Tests', async (t) => {
  const componentPath = path.resolve('src/components/crm/InquiryTableExcel.tsx');
  assert.ok(fs.existsSync(componentPath), 'InquiryTableExcel.tsx must exist');
  const content = fs.readFileSync(componentPath, 'utf8');

  // Verify InquiryItem interface includes required fields
  await t.test('1. InquiryItem interface defines item-level requirement flags', () => {
    assert.match(content, /price_required\?:\s*boolean\s*\|\s*null/);
    assert.match(content, /coa_required\?:\s*boolean\s*\|\s*null/);
    assert.match(content, /others_required\?:\s*boolean\s*\|\s*null/);
    assert.match(content, /sample_required\?:\s*boolean\s*\|\s*null/);
    assert.match(content, /agency_letter_required\?:\s*boolean\s*\|\s*null/);
  });

  // Verify item resolution logic in product row
  await t.test('2. Product row our_side column resolves parent requirement flags when unset', () => {
    assert.match(content, /item\.price_required\s*!==\s*undefined\s*&&\s*item\.price_required\s*!==\s*null/);
    assert.match(content, /item\.coa_required\s*!==\s*undefined\s*&&\s*item\.coa_required\s*!==\s*null/);
    assert.match(content, /item\.others_required\s*!==\s*undefined\s*&&\s*item\.others_required\s*!==\s*null/);
    assert.match(content, /inquiry\.price_required\s*\?\?\s*true/);
    assert.match(content, /inquiry\.coa_required\s*\?\?\s*true/);
    assert.match(content, /Boolean\(inquiry\.others_required\)/);
  });

  await t.test('3. Shows XCircle only when no applicable documents are required', () => {
    assert.match(content, /if\s*\(!anyRequired\)\s*\{\s*return\s*<XCircle/);
  });

  await t.test('4. Renders OurSideChips when documents are required without marking as sent merely because required', () => {
    assert.match(content, /<OurSideChips\s+inquiry=\{\{/);
    // price_sent_at and coa_sent_at use sent_at timestamps, not boolean required flags
    assert.match(content, /price_sent_at:\s*item\.price_sent_at\s*\?\?\s*inquiry\.price_sent_at\s*\?\?\s*null/);
    assert.match(content, /others_sent_at:\s*item\.others_sent_at\s*\?\?\s*inquiry\.others_sent_at\s*\?\?\s*null/);
  });

  // Behavioral simulation of the resolution logic
  function resolveItemReqs(item, inquiry) {
    const priceRequired = item.price_required !== undefined && item.price_required !== null
      ? Boolean(item.price_required)
      : (inquiry.price_required ?? true);

    const coaRequired = item.coa_required !== undefined && item.coa_required !== null
      ? Boolean(item.coa_required)
      : (inquiry.coa_required ?? true);

    const sampleRequired = item.sample_required !== undefined && item.sample_required !== null
      ? Boolean(item.sample_required)
      : Boolean(inquiry.sample_required);

    const agencyLetterRequired = item.agency_letter_required !== undefined && item.agency_letter_required !== null
      ? Boolean(item.agency_letter_required)
      : Boolean(inquiry.agency_letter_required);

    const othersRequired = item.others_required !== undefined && item.others_required !== null
      ? Boolean(item.others_required)
      : Boolean(inquiry.others_required);

    const anyRequired = priceRequired || coaRequired || sampleRequired || agencyLetterRequired || othersRequired;

    return {
      price_required: priceRequired,
      coa_required: coaRequired,
      sample_required: sampleRequired,
      agency_letter_required: agencyLetterRequired,
      others_required: othersRequired,
      price_sent_at: item.price_sent_at ?? inquiry.price_sent_at ?? null,
      coa_sent_at: item.coa_sent_at ?? (item.document_sent ? item.document_sent_at : null) ?? inquiry.coa_sent_at ?? null,
      sample_sent_at: item.sample_sent_at ?? inquiry.sample_sent_at ?? null,
      agency_letter_sent_at: item.agency_letter_sent_at ?? inquiry.agency_letter_sent_at ?? null,
      others_sent_at: item.others_sent_at ?? inquiry.others_sent_at ?? null,
      anyRequired,
    };
  }

  await t.test('5. Simulation against INQ-26-0131 (Erela): parent shows P, C, O and all 105 rows reflect P, C, O', () => {
    const parentErela = {
      id: 'erela-parent-id',
      inquiry_number: 'INQ-26-0131',
      company_name: 'PT Erlangga Edi Laboratories',
      price_required: true,
      coa_required: true,
      others_required: true,
      sample_required: false,
      agency_letter_required: false,
      price_sent_at: null,
      coa_sent_at: null,
      others_sent_at: null,
    };

    // Simulate 105 child rows with unset requirements
    const childRows = Array.from({ length: 105 }, (_, i) => ({
      id: `item-${i + 1}`,
      parent_inquiry_id: parentErela.id,
      inquiry_number: `INQ-26-0131-${String(i + 1).padStart(3, '0')}`,
      product_name: `Product ${i + 1}`,
      quantity: '100 kg',
      document_sent: false,
      document_sent_at: null,
      // unset item-level requirements
      price_required: undefined,
      coa_required: undefined,
      others_required: undefined,
    }));

    assert.equal(childRows.length, 105);

    for (const item of childRows) {
      const res = resolveItemReqs(item, parentErela);
      assert.equal(res.anyRequired, true, 'Row must require documents');
      assert.equal(res.price_required, true, 'Price (P) must be required');
      assert.equal(res.coa_required, true, 'COA (C) must be required');
      assert.equal(res.others_required, true, 'Others (O) must be required');
      assert.equal(res.sample_required, false, 'Sample must not be required');
      assert.equal(res.agency_letter_required, false, 'Agency letter must not be required');

      // Crucial: Sent status must NOT be true merely because required
      assert.equal(res.price_sent_at, null, 'Price must not be marked sent');
      assert.equal(res.coa_sent_at, null, 'COA must not be marked sent');
      assert.equal(res.others_sent_at, null, 'Others must not be marked sent');
    }
  });

  await t.test('6. Simulation of normal inquiry with no document requirements', () => {
    const parentNoReq = {
      id: 'no-req-id',
      inquiry_number: 'INQ-26-0200',
      company_name: 'Normal Customer Ltd',
      price_required: false,
      coa_required: false,
      others_required: false,
      sample_required: false,
      agency_letter_required: false,
    };

    const item = {
      id: 'item-1',
      parent_inquiry_id: parentNoReq.id,
      inquiry_number: 'INQ-26-0200-001',
      product_name: 'Test Product',
      quantity: '10 kg',
      document_sent: false,
    };

    const res = resolveItemReqs(item, parentNoReq);
    assert.equal(res.anyRequired, false, 'anyRequired must be false');
    assert.equal(res.price_required, false);
    assert.equal(res.coa_required, false);
    assert.equal(res.others_required, false);
    // In UI, when !res.anyRequired, XCircle is rendered (showing X)
  });

  await t.test('7. Simulation of explicit item-level overrides', () => {
    const parentInq = {
      id: 'override-parent-id',
      inquiry_number: 'INQ-26-0300',
      price_required: true,
      coa_required: true,
      others_required: true,
    };

    // Item explicitly unsets COA and Others, keeps only Price
    const itemWithOverrides = {
      id: 'item-override',
      parent_inquiry_id: parentInq.id,
      inquiry_number: 'INQ-26-0300-001',
      product_name: 'Overridden Product',
      quantity: '50 kg',
      price_required: true,
      coa_required: false,
      others_required: false,
    };

    const res = resolveItemReqs(itemWithOverrides, parentInq);
    assert.equal(res.anyRequired, true);
    assert.equal(res.price_required, true);
    assert.equal(res.coa_required, false, 'COA should be overridden to false');
    assert.equal(res.others_required, false, 'Others should be overridden to false');

    // Item explicitly overrides all to false
    const itemAllFalse = {
      id: 'item-all-false',
      parent_inquiry_id: parentInq.id,
      inquiry_number: 'INQ-26-0300-002',
      product_name: 'All False Product',
      quantity: '50 kg',
      price_required: false,
      coa_required: false,
      others_required: false,
      sample_required: false,
      agency_letter_required: false,
    };

    const resAllFalse = resolveItemReqs(itemAllFalse, parentInq);
    assert.equal(resAllFalse.anyRequired, false, 'Overridden item with all false must have anyRequired=false');
  });

  await t.test('8. Sent status is preserved when timestamps are set on item or parent', () => {
    const parentInq = {
      id: 'sent-parent-id',
      inquiry_number: 'INQ-26-0400',
      price_required: true,
      coa_required: true,
      price_sent_at: '2026-10-20T10:00:00Z',
      coa_sent_at: null,
    };

    const item = {
      id: 'item-sent',
      parent_inquiry_id: parentInq.id,
      inquiry_number: 'INQ-26-0400-001',
      product_name: 'Sent Product',
      quantity: '50 kg',
      price_sent_at: null, // parent had price sent
      coa_sent_at: '2026-10-21T08:00:00Z', // item had coa sent
    };

    const res = resolveItemReqs(item, parentInq);
    assert.equal(res.price_sent_at, '2026-10-20T10:00:00Z', 'Parent price_sent_at is preserved');
    assert.equal(res.coa_sent_at, '2026-10-21T08:00:00Z', 'Item coa_sent_at is preserved');
  });
});
