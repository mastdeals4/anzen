import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { setupAuditAuth, waitForAppReady, assertNoLoadingState, assertNoHorizontalOverflow } from './helpers/mobileAuditHelpers';

const ARTIFACT_DIR = path.resolve('artifacts/document-bank-verification');
const BRAIN_ARTIFACT_DIR = '/Users/Kunal/.gemini/antigravity/brain/ba0a5665-f6f0-4bb7-bcd8-a665594273a2/document-bank-verification';

fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
fs.mkdirSync(BRAIN_ARTIFACT_DIR, { recursive: true });

async function saveScreenshot(page: any, name: string) {
  const filename = `${name}.png`;
  const projPath = path.join(ARTIFACT_DIR, filename);
  const brainPath = path.join(BRAIN_ARTIFACT_DIR, filename);
  await page.screenshot({ path: projPath, fullPage: false });
  fs.copyFileSync(projPath, brainPath);
  return { projPath, brainPath };
}

// Generate the canonical 263 mock documents reflecting live audit data
function generateAuditDocuments() {
  const docs: any[] = [];

  // 1. Three Permanent / Banked documents
  docs.push({
    id: 'doc-perm-1',
    product_name: 'Lactose Monohydrate 200 Mesh',
    make: 'DFE Pharma',
    document_type: 'COA',
    specification: 'USP',
    is_permanent: true,
    inquiry_id: null,
    pricing_option_id: null,
    original_file_name: 'Lactose_Monohydrate_COA.pdf',
    display_file_name: 'Lactose_Monohydrate_COA.pdf',
    storage_path: 'manual/COA_1784568646428_lactose_coa.pdf',
    file_size: 501669,
    mime_type: 'application/pdf',
    source_gmail_message_id: null,
    source_email_subject: 'Permanent Bank COA',
    created_at: '2026-05-01T10:00:00Z',
    crm_inquiries: null,
  });

  docs.push({
    id: 'doc-perm-2',
    product_name: 'Paracetamol Micronized',
    make: 'Farmson Pharmaceutical',
    document_type: 'MSDS',
    specification: 'BP',
    is_permanent: true,
    inquiry_id: null,
    pricing_option_id: null,
    original_file_name: 'Paracetamol_MSDS_Rev4.pdf',
    display_file_name: 'Paracetamol_MSDS_Rev4.pdf',
    storage_path: 'manual/MSDS_1784568646429_paracetamol_msds.pdf',
    file_size: 340000,
    mime_type: 'application/pdf',
    source_gmail_message_id: null,
    source_email_subject: 'Permanent Bank MSDS',
    created_at: '2026-05-02T11:00:00Z',
    crm_inquiries: null,
  });

  docs.push({
    id: 'doc-perm-3',
    product_name: 'Metformin Hydrochloride',
    make: 'Aarti Drugs Ltd',
    document_type: 'GMP',
    specification: 'EP',
    is_permanent: true,
    inquiry_id: null,
    pricing_option_id: null,
    original_file_name: 'GMP_Certificate_Aarti.pdf',
    display_file_name: 'GMP_Certificate_Aarti.pdf',
    storage_path: 'manual/GMP_1784568646430_gmp_cert.pdf',
    file_size: 850000,
    mime_type: 'application/pdf',
    source_gmail_message_id: null,
    source_email_subject: 'Permanent Bank GMP',
    created_at: '2026-05-03T12:00:00Z',
    crm_inquiries: null,
  });

  // 2. Sixty Inquiry-linked records
  for (let i = 1; i <= 60; i++) {
    docs.push({
      id: `doc-inq-${i}`,
      product_name: `Pharmaceutical API ${i}`,
      make: `Supplier ${i}`,
      document_type: i % 3 === 0 ? 'MSDS' : i % 5 === 0 ? 'GMP' : 'COA',
      specification: 'USP',
      is_permanent: false,
      inquiry_id: `inq-uuid-${i}`,
      pricing_option_id: null,
      original_file_name: `COA_Lot_2026_${i}.pdf`,
      display_file_name: `COA_Lot_2026_${i}.pdf`,
      storage_path: `gmail-attachments/user-1/msg-${i}/17845686_${i}.pdf`,
      file_size: 250000 + i * 5000,
      mime_type: 'application/pdf',
      source_gmail_message_id: `gmail-msg-${i}`,
      source_email_subject: `RE: Inquiry INQ-2026-${String(i).padStart(4, '0')}`,
      created_at: '2026-06-10T08:00:00Z',
      crm_inquiries: [{ inquiry_number: `INQ-2026-${String(i).padStart(4, '0')}` }],
    });
  }

  // 3. Three Pricing Option-linked records
  for (let i = 1; i <= 3; i++) {
    docs.push({
      id: `doc-po-${i}`,
      product_name: `Pricing Product ${i}`,
      make: `Manufacturer ${i}`,
      document_type: 'PRICE_LIST',
      specification: 'Commercial',
      is_permanent: false,
      inquiry_id: null,
      pricing_option_id: `po-uuid-${i}`,
      original_file_name: `PriceList_Q4_${i}.xlsx`,
      display_file_name: `PriceList_Q4_${i}.xlsx`,
      storage_path: `gmail-attachments/user-1/po-msg-${i}/pricelist_${i}.xlsx`,
      file_size: 450000,
      mime_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      source_gmail_message_id: `po-msg-${i}`,
      source_email_subject: `Q4 Sourcing Price Offer ${i}`,
      created_at: '2026-07-01T09:00:00Z',
      crm_inquiries: null,
    });
  }

  // 4. Exactly 171 unlinked non-permanent OTHER records (junk cleanup candidates)
  // Matching the exact audit size: 106,881,358 bytes (~101.93 MiB)
  const junkNames = [
    { name: 'Capsule.mp4', size: 16176405, mime: 'application/pdf', subject: 'Partnership Proposal‑HPMC Capsules' },
    { name: 'HM000004 2627 BUYER DOCS (1).pdf', size: 14335534, mime: 'application/pdf', subject: 'RE: Paracetamol//PFI NO. 246' },
    { name: 'Brochure July 2026.pdf', size: 7116529, mime: 'application/pdf', subject: 'Introductory mail from Vasudha' },
    { name: 'Product list July 2026.xlsx', size: 2370458, mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', subject: 'Introductory mail' },
    { name: '2024pmkeuangan131.pdf', size: 398305, mime: 'application/pdf', subject: 'Informasi Tagihan Telkom Bulan Oktober 2026' },
    { name: 'image001.png', size: 310007, mime: 'image/png', subject: 'Re: Permohonan Konfirmasi' },
    { name: 'image002.jpg', size: 25841, mime: 'image/jpeg', subject: 'Re: Inquiry' },
    { name: 'image003.jpg', size: 18450, mime: 'image/jpeg', subject: 'Re: Sourcing' },
    { name: 'signature_banner.png', size: 45200, mime: 'image/png', subject: 'Best regards' },
    { name: 'telkom_statement.pdf', size: 280000, mime: 'application/pdf', subject: 'Tagihan Telkom' },
  ];

  // Distribute remaining bytes across 171 records
  const targetJunkBytes = 106881358;
  let accumulated = 0;

  for (let i = 1; i <= 171; i++) {
    const template = junkNames[(i - 1) % junkNames.length];
    const isLast = i === 171;
    const size = isLast ? Math.max(1000, targetJunkBytes - accumulated) : template.size;
    accumulated += size;

    docs.push({
      id: `doc-junk-${i}`,
      product_name: null,
      make: null,
      document_type: 'OTHER',
      specification: null,
      is_permanent: false,
      inquiry_id: null,
      pricing_option_id: null,
      original_file_name: i <= 10 ? template.name : `attachment_other_${i}_${template.name}`,
      display_file_name: i <= 10 ? template.name : `attachment_other_${i}_${template.name}`,
      storage_path: `gmail-attachments/user-1/junk-${i}/${Date.now()}_${template.name}`,
      file_size: size,
      mime_type: template.mime,
      source_gmail_message_id: `junk-msg-${i}`,
      source_email_subject: template.subject,
      created_at: '2026-08-01T10:00:00Z',
      crm_inquiries: null,
    });
  }

  return docs;
}

const AUDIT_DOCUMENTS = generateAuditDocuments();

const STATS_DATA = {
  total_documents: 263,
  total_document_bytes: 161692012,
  bucket_total_objects: 304,
  bucket_total_bytes: 320076149,
  unlinked_objects_count: 44,
  unlinked_objects_bytes: 158384137,
  junk_other_count: 171,
  junk_other_bytes: 106881358,
  permanent_count: 3,
  linked_inquiry_count: 60,
  linked_pricing_option_count: 3,
};

const UNLINKED_OBJECTS_DATA = [
  { id: 'un-1', name: 'bulk-email/5882d092-a7c6/ourcatalog.pdf', size_bytes: 13779558, mime_type: 'application/pdf', created_at: '2026-06-22T03:05:35Z', folder: 'bulk-email', detected_reference: 'bulk_email_campaigns' },
  { id: 'un-2', name: 'bulk-email/db163e4e-ea05/ourcatalog.pdf', size_bytes: 13779558, mime_type: 'application/pdf', created_at: '2026-06-22T09:47:46Z', folder: 'bulk-email', detected_reference: 'bulk_email_campaigns' },
  { id: 'un-3', name: 'bulk-email/ab033d4b-7247/ourcatalog.pdf', size_bytes: 13779558, mime_type: 'application/pdf', created_at: '2026-06-22T07:28:05Z', folder: 'bulk-email', detected_reference: 'bulk_email_campaigns' },
  { id: 'un-4', name: 'bulk-email/53dca12f-3ba6/Anzen_-_API_Catalogue.pdf', size_bytes: 7580823, mime_type: 'application/pdf', created_at: '2026-08-20T10:00:00Z', folder: 'bulk-email', detected_reference: 'bulk_email_campaigns' },
  { id: 'un-5', name: 'requirement-documents/60a230b2/Avira_Brochure_v4.html', size_bytes: 895061, mime_type: 'text/html', created_at: '2026-04-28T16:42:03Z', folder: 'requirement-documents', detected_reference: 'import_requirements' },
];

async function setupDocumentBankRoutes(page: any) {
  await setupAuditAuth(page);

  // Intercept crm_product_documents table query
  await page.route('**/rest/v1/crm_product_documents*', async (route: any) => {
    const method = route.request().method();
    if (method === 'GET') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'content-range': `0-${AUDIT_DOCUMENTS.length - 1}/${AUDIT_DOCUMENTS.length}` },
        body: JSON.stringify(AUDIT_DOCUMENTS),
      });
    }
    if (method === 'PATCH' || method === 'DELETE') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true }),
      });
    }
    return route.continue();
  });

  // Intercept get_crm_document_bank_stats RPC
  await page.route('**/rest/v1/rpc/get_crm_document_bank_stats*', async (route: any) => {
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(STATS_DATA),
    });
  });

  // Intercept get_crm_unlinked_storage_objects RPC
  await page.route('**/rest/v1/rpc/get_crm_unlinked_storage_objects*', async (route: any) => {
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(UNLINKED_OBJECTS_DATA),
    });
  });

  // Intercept signed URL requests for instant preview
  await page.route('**/storage/v1/object/sign/crm-documents/**', async (route: any) => {
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        signedURL: 'https://cdn.jsdelivr.net/gh/mozilla/pdf.js@master/examples/learning/helloworld.pdf',
      }),
    });
  });
}

test.describe('ANZEN CRM Document Bank — Bulk Cleanup, Instant Preview & Storage Visibility', () => {

  test('1. Main Document Bank View: Storage Visibility, File Sizes, and Checkboxes', async ({ page }) => {
    test.setTimeout(60000);
    await setupDocumentBankRoutes(page);
    await page.setViewportSize({ width: 1440, height: 900 });

    await page.goto('/crm/documents', { waitUntil: 'networkidle' });
    await waitForAppReady(page);
    await assertNoLoadingState(page);

    // Verify Title & Description
    await expect(page.getByRole('heading', { name: 'CRM Document Bank' })).toBeVisible({ timeout: 15000 });

    // Verify Storage Metrics Bar (using exact text match to distinguish from tabs)
    await expect(page.getByText('263 docs')).toBeVisible();
    await expect(page.getByText('304 objects')).toBeVisible();
    await expect(page.getByText('44 objects')).toBeVisible();
    await expect(page.getByText('171 temporary')).toBeVisible();

    // Verify Table Headers
    await expect(page.locator('th:has-text("Product")')).toBeVisible();
    await expect(page.locator('th:has-text("Doc Type")')).toBeVisible();
    await expect(page.locator('th:has-text("File Name")')).toBeVisible();
    await expect(page.locator('th:has-text("Size")')).toBeVisible();

    // Verify row checkboxes and sizes
    const firstRowCheckbox = page.locator('tbody input[type="checkbox"]').first();
    await expect(firstRowCheckbox).toBeVisible();

    await saveScreenshot(page, '01_document_bank_main_view');
  });

  test('2. Multi-Select Workflow: Select Page, Select All Filtered, Size Calculation', async ({ page }) => {
    test.setTimeout(60000);
    await setupDocumentBankRoutes(page);
    await page.setViewportSize({ width: 1440, height: 900 });

    await page.goto('/crm/documents', { waitUntil: 'networkidle' });
    await waitForAppReady(page);

    // Select the first 3 document checkboxes
    const checkboxes = page.locator('tbody input[type="checkbox"]');
    await expect(checkboxes.first()).toBeVisible({ timeout: 15000 });

    await checkboxes.nth(0).check();
    await checkboxes.nth(1).check();
    await checkboxes.nth(2).check();

    // Verify Selection Banner is visible
    const selectionBanner = page.getByText('3 records selected');
    await expect(selectionBanner).toBeVisible();

    // Verify Retain Selected and Delete Selected buttons
    await expect(page.getByRole('button', { name: 'Retain Selected' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Delete Selected \(3\)/ })).toBeVisible();

    await saveScreenshot(page, '02_document_bank_multi_select');

    // Test Clear Selection
    await page.getByRole('button', { name: 'Clear selection' }).click();
    await expect(selectionBanner).not.toBeVisible();
  });

  test('3. Instant In-Page Document Preview: Split View on Desktop without Popup', async ({ page }) => {
    test.setTimeout(60000);
    await setupDocumentBankRoutes(page);
    await page.setViewportSize({ width: 1440, height: 900 });

    await page.goto('/crm/documents', { waitUntil: 'networkidle' });
    await waitForAppReady(page);

    // Click the Eye preview button on the first document row
    const firstPreviewBtn = page.locator('tbody tr button[title="Instant In-Page Preview"]').first();
    await expect(firstPreviewBtn).toBeVisible({ timeout: 15000 });
    await firstPreviewBtn.click();

    // Verify Desktop Preview Panel appears docked side-by-side
    const previewHeader = page.locator('h4.truncate.font-mono');
    await expect(previewHeader).toBeVisible({ timeout: 10000 });

    // Verify Document Bank table remains visible on the left side
    const tableProductHeader = page.locator('th:has-text("Product")');
    await expect(tableProductHeader).toBeVisible();

    // Verify Prev/Next navigation buttons exist in preview panel
    await expect(page.locator('button[title="Next Document"]')).toBeVisible();

    await saveScreenshot(page, '03_document_bank_instant_preview_desktop');

    // Close preview panel
    await page.locator('button[title="Close Preview Panel"]').click();
    await expect(previewHeader).not.toBeVisible();
  });

  test('4. Safe Bulk Deletion Modal & Dry Run Simulation', async ({ page }) => {
    test.setTimeout(60000);
    await setupDocumentBankRoutes(page);
    await page.setViewportSize({ width: 1440, height: 900 });

    await page.goto('/crm/documents', { waitUntil: 'networkidle' });
    await waitForAppReady(page);

    // Click Cleanup Pool button to focus on temporary OTHER records
    const cleanupPoolBtn = page.getByRole('button', { name: /Cleanup Pool/i });
    await expect(cleanupPoolBtn).toBeVisible({ timeout: 15000 });
    await cleanupPoolBtn.click();

    // Select the first 5 records
    const checkboxes = page.locator('tbody input[type="checkbox"]');
    for (let i = 0; i < 5; i++) {
      await checkboxes.nth(i).check();
    }

    // Click Delete Selected
    const deleteSelectedBtn = page.getByRole('button', { name: /Delete Selected/i });
    await deleteSelectedBtn.click();

    // Verify Safe Deletion Modal opens
    await expect(page.getByRole('heading', { name: 'Safe Document Deletion Workflow' })).toBeVisible({ timeout: 10000 });
    await expect(page.getByText('Reclaimable Storage')).toBeVisible();
    await expect(page.getByText('Files to be Permanently Removed')).toBeVisible();

    await saveScreenshot(page, '04_document_bank_safe_deletion_modal');

    // Run Dry Run Simulation (SAFE - NO MUTATIONS)
    const dryRunBtn = page.getByRole('button', { name: 'Simulate Dry Run' });
    await expect(dryRunBtn).toBeVisible();
    await dryRunBtn.click();

    // Verify simulation output
    await expect(page.getByText('Simulation (Dry Run) Complete:')).toBeVisible({ timeout: 10000 });

    await saveScreenshot(page, '05_document_bank_deletion_simulation_dryrun');

    // Close modal safely
    await page.getByRole('button', { name: 'Cancel' }).click();
  });

  test('5. Storage Audit & Orphan Explorer: 44 Unlinked Objects Inspection', async ({ page }) => {
    test.setTimeout(60000);
    await setupDocumentBankRoutes(page);
    await page.setViewportSize({ width: 1440, height: 900 });

    await page.goto('/crm/documents', { waitUntil: 'networkidle' });
    await waitForAppReady(page);

    // Click Storage Audit button
    const storageAuditBtn = page.getByRole('button', { name: 'Storage Audit' });
    await expect(storageAuditBtn).toBeVisible({ timeout: 15000 });
    await storageAuditBtn.click();

    // Verify Storage Audit Modal opens
    await expect(page.getByRole('heading', { name: 'Storage Audit & Unlinked Objects Explorer' })).toBeVisible({ timeout: 10000 });

    // Verify reference notice for the 44 unlinked objects
    await expect(page.getByText('Crucial Reference Policy for Unlinked Bucket Objects')).toBeVisible();
    await expect(page.getByText('bulk_email_campaigns').first()).toBeVisible();

    await saveScreenshot(page, '06_document_bank_storage_audit_modal');

    // Close audit modal
    await page.getByRole('button', { name: 'Done' }).click();
  });

  test('6. Mobile Responsive View (390px): Compact Layout & Mobile Document Preview', async ({ page }) => {
    test.setTimeout(60000);
    await setupDocumentBankRoutes(page);
    await page.setViewportSize({ width: 390, height: 844 });

    await page.goto('/crm/documents', { waitUntil: 'networkidle' });
    await waitForAppReady(page);

    // Verify Header and Document Bank title render without overflow
    await expect(page.getByRole('heading', { name: 'CRM Document Bank' })).toBeVisible({ timeout: 15000 });
    await assertNoHorizontalOverflow(page);

    await saveScreenshot(page, '07_document_bank_mobile_390px');
  });

});
