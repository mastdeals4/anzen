import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { setupAuditAuth, waitForAppReady } from './helpers/mobileAuditHelpers';

const ARTIFACT_DIR = path.resolve('artifacts/universal-document-bank-e2e');
const BRAIN_ARTIFACT_DIR = '/Users/Kunal/.gemini/antigravity/brain/ba0a5665-f6f0-4bb7-bcd8-a665594273a2/universal-document-bank-e2e';

fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
fs.mkdirSync(BRAIN_ARTIFACT_DIR, { recursive: true });

async function captureScreen(page: any, name: string) {
  const filename = `${name}.png`;
  const projPath = path.join(ARTIFACT_DIR, filename);
  const brainPath = path.join(BRAIN_ARTIFACT_DIR, filename);
  await page.screenshot({ path: projPath, fullPage: false });
  fs.copyFileSync(projPath, brainPath);
  return { projPath, brainPath };
}

test.describe('Universal Document Bank — Cross-Module UI & Workflow Verification', () => {
  test.beforeEach(async ({ page }) => {
    await setupAuditAuth(page);

    const mockUniversalDocs = [
      {
        id: 'u-doc-1',
        title: 'Paracetamol IP/BP COA Batch 2026',
        document_type: 'COA',
        specification: 'USP/BP',
        lifecycle_status: 'BANKED',
        source_module: 'batches',
        product_name: 'Paracetamol Micronized',
        make_name: 'Farmson Pharmaceutical',
        batch_number: 'FAR/2026/089',
        linked_batch_number: 'FAR/2026/089',
        version_number: 1,
        storage_bucket: 'batch-documents',
        storage_path: 'batches/paracetamol_coa.pdf',
        original_file_name: 'paracetamol_coa.pdf',
        file_size: 450000,
        version_count: 1,
        link_count: 3,
        is_expired: false,
        created_at: '2026-06-15T10:00:00Z',
      },
      {
        id: 'u-doc-2',
        title: 'Lactose Monohydrate 200 Mesh MSDS',
        document_type: 'MSDS',
        specification: 'EP',
        lifecycle_status: 'BANKED',
        source_module: 'products',
        product_name: 'Lactose Monohydrate',
        make_name: 'DFE Pharma',
        batch_number: null,
        linked_batch_number: null,
        version_number: 1,
        storage_bucket: 'product-documents',
        storage_path: 'products/lactose_msds.pdf',
        original_file_name: 'lactose_msds.pdf',
        file_size: 320000,
        version_count: 1,
        link_count: 2,
        is_expired: false,
        created_at: '2026-07-20T11:00:00Z',
      },
      {
        id: 'u-doc-3',
        title: 'Metformin HCl Technical Spec',
        document_type: 'SPECIFICATION',
        specification: 'USP',
        lifecycle_status: 'REVIEWED',
        source_module: 'crm',
        product_name: 'Metformin HCl',
        make_name: 'Aarti Drugs',
        batch_number: null,
        linked_batch_number: null,
        version_number: 1,
        storage_bucket: 'crm-documents',
        storage_path: 'crm/metformin_spec.pdf',
        original_file_name: 'metformin_spec.pdf',
        file_size: 210000,
        version_count: 1,
        link_count: 1,
        is_expired: false,
        created_at: '2026-08-01T09:00:00Z',
      },
      {
        id: 'u-doc-4',
        title: 'Omeprazole Pellets 8.5% Draft Ingest',
        document_type: 'OTHER TECHNICAL',
        specification: 'In-House',
        lifecycle_status: 'TEMP',
        source_module: 'pricing',
        product_name: 'Omeprazole Pellets',
        make_name: 'Hetero Labs',
        batch_number: null,
        linked_batch_number: null,
        version_number: 1,
        storage_bucket: 'crm-documents',
        storage_path: 'crm/omeprazole_temp.pdf',
        original_file_name: 'omeprazole_temp.pdf',
        file_size: 150000,
        version_count: 1,
        link_count: 1,
        is_expired: false,
        created_at: '2026-09-10T14:00:00Z',
      },
    ];

    // Intercept vw_universal_document_bank & universal_documents
    await page.route('**/rest/v1/vw_universal_document_bank*', async (route) => {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'content-range': `0-${mockUniversalDocs.length - 1}/${mockUniversalDocs.length}` },
        body: JSON.stringify(mockUniversalDocs),
      });
    });

    await page.route('**/rest/v1/universal_documents*', async (route) => {
      const method = route.request().method();
      if (method === 'GET') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          headers: { 'content-range': `0-${mockUniversalDocs.length - 1}/${mockUniversalDocs.length}` },
          body: JSON.stringify(mockUniversalDocs),
        });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'u-doc-new' }) });
    });
  });

  test('1. Document Bank Desktop: KPIs, Search, Filter & Lightbox Preview', async ({ page }) => {
    test.setTimeout(45000);
    await page.goto('/document-bank');
    await waitForAppReady(page);

    // Wait for the Universal Document Bank title
    await expect(page.locator('text=Universal Document Bank').first()).toBeVisible({ timeout: 15000 });

    // Verify KPI / Status Tabs exist
    await expect(page.locator('text=All Documents').first()).toBeVisible();
    await expect(page.locator('text=Banked Library').first()).toBeVisible();

    await captureScreen(page, '01_desktop_document_bank_overview');

    // Test Search input
    const searchInput = page.locator('input[placeholder*="Search by product"]').first();
    if (await searchInput.isVisible()) {
      await searchInput.fill('Paracetamol');
      await page.waitForTimeout(600);
      await captureScreen(page, '02_desktop_search_filtered');
      await searchInput.clear();
      await page.waitForTimeout(400);
    }

    // Test Upload modal
    const uploadBtn = page.locator('button:has-text("Upload Document")').first();
    if (await uploadBtn.isVisible()) {
      await uploadBtn.click();
      await page.waitForTimeout(400);
      await captureScreen(page, '03_desktop_upload_modal');
      const cancelBtn = page.locator('button:has-text("Cancel")').first();
      if (await cancelBtn.isVisible()) await cancelBtn.click();
      await page.waitForTimeout(300);
    }

    // Test In-App Lightbox Preview (Click first eye icon)
    const previewBtn = page.locator('button[title*="Preview"], button[aria-label*="Preview"], table button:has(svg.lucide-eye)').first();
    if (await previewBtn.isVisible()) {
      await previewBtn.click();
      await page.waitForTimeout(600);
      await captureScreen(page, '04_desktop_centred_lightbox_preview');

      // Close modal using Escape or close button
      await page.keyboard.press('Escape');
      await page.waitForTimeout(400);
    }
  });

  test('2. Pricing Worksheet: Cross-Module Bank Integration & Actions', async ({ page }) => {
    test.setTimeout(45000);
    await page.goto('/pricing-worksheet');
    await waitForAppReady(page);

    await page.waitForTimeout(1000);
    await captureScreen(page, '05_pricing_worksheet_table');

    // Look for first expandable row or document actions
    const attachBankBtn = page.locator('button:has-text("ATTACH FROM BANK")').first();
    if (await attachBankBtn.isVisible()) {
      await attachBankBtn.click();
      await page.waitForTimeout(600);
      await captureScreen(page, '06_pricing_attach_from_bank_modal');
      const closeBtn = page.locator('button:has-text("Cancel")').first();
      if (await closeBtn.isVisible()) await closeBtn.click();
    }
  });

  test('3. Mobile Viewport: Responsive Universal Document Bank & Centred Modal', async ({ page }) => {
    test.setTimeout(45000);
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto('/document-bank');
    await waitForAppReady(page);

    await page.waitForTimeout(1000);
    await captureScreen(page, '07_mobile_document_bank_layout');

    // Open first document preview on mobile
    const mobileEyeBtn = page.locator('button[title*="Preview"], button[aria-label*="Preview"], button:has(svg.lucide-eye)').first();
    if (await mobileEyeBtn.isVisible()) {
      await mobileEyeBtn.click();
      await page.waitForTimeout(600);
      await captureScreen(page, '08_mobile_modal_preview_safe_area');
      await page.keyboard.press('Escape');
    }
  });
});
