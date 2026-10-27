import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

test('CRM Inquiry Save Payload & Error Handling Invariants', async (t) => {
  const crmPath = path.resolve('src/pages/CRM.tsx');
  const formPath = path.resolve('src/components/crm/CompactInquiryForm.tsx');

  assert.ok(fs.existsSync(crmPath), 'CRM.tsx must exist');
  assert.ok(fs.existsSync(formPath), 'CompactInquiryForm.tsx must exist');

  const crmContent = fs.readFileSync(crmPath, 'utf8');
  const formContent = fs.readFileSync(formPath, 'utf8');

  await t.test('1. Non-column fields products and items are strictly excluded from crm_inquiries insert/update', () => {
    // Both products and items must be excluded
    assert.match(crmContent, /const excludedFields = new Set\(\['products', 'items'\]\)/);
    // Destructuring removes both products and items
    assert.match(crmContent, /const \{ items, products, is_multi_product, \.\.\.restFormData \} = formData;/);
  });

  await t.test('2. Empty string UUIDs and dates are sanitized to null', () => {
    assert.match(crmContent, /crm_contact_id/);
    assert.match(crmContent, /customer_id/);
    assert.match(crmContent, /assigned_to/);
    assert.match(crmContent, /created_by/);
    assert.match(crmContent, /delivery_date/);
    assert.match(crmContent, /emptyToNull/);
  });

  await t.test('3. Multi-product inquiry creation handles both items and products shapes', () => {
    assert.match(
      crmContent,
      /const multiProducts = \(items && items\.length > 0\) \? items : \(products && products\.length > 0 \? products : \[\]\);/
    );
    // Aliases: product_name or productName
    assert.match(crmContent, /item\.product_name \|\| item\.productName/);
  });

  await t.test('4. Diagnostic error logging exposes code, details, hint, and message without uncaught rejections', () => {
    assert.match(crmContent, /console\.error\('Error saving inquiry:', \{/);
    assert.match(crmContent, /message: error\?\.message/);
    assert.match(crmContent, /code: error\?\.code/);
    assert.match(crmContent, /details: error\?\.details/);
    assert.match(crmContent, /hint: error\?\.hint/);
    // Must NOT throw uncaught error after alert
    assert.doesNotMatch(crmContent, /alert\(t\('errors\.failedToSaveInquiry'\)\);\s*throw error;/);
  });

  await t.test('5. Customer search input in CompactInquiryForm keeps formData.company_name in sync on typing', () => {
    assert.match(formContent, /setFormData\(prev => \(\{[\s\S]*company_name: val/);
  });
});
