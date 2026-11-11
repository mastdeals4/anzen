import { test, expect } from '@playwright/test';
import {
  VIEWPORTS,
  setupAuditAuth,
  waitForAppReady,
  assertNoLoadingState,
  assertNoHorizontalOverflow,
  captureVerifiedScreenshot,
} from './helpers/mobileAuditHelpers';

test.describe('Anzen ERP — Master Multi-Module & Multi-Viewport Mobile Audit', () => {

  test('Module 1: Executive Dashboard (All 4 Viewports)', async ({ page }) => {
    test.setTimeout(120000);
    await setupAuditAuth(page);

    // 1. Desktop (1440x900)
    await page.setViewportSize({ width: VIEWPORTS.desktop.width, height: VIEWPORTS.desktop.height });
    await page.goto('/dashboard', { waitUntil: 'networkidle' });
    await waitForAppReady(page);
    await expect(page.locator('text=Welcome, Kunal Lunkad!').first()).toBeVisible({ timeout: 20000 });
    await assertNoLoadingState(page);
    await captureVerifiedScreenshot(page, 'dashboard', 'executive', VIEWPORTS.desktop.name);

    // 2. Tablet (768x1024)
    await page.setViewportSize({ width: VIEWPORTS.tablet.width, height: VIEWPORTS.tablet.height });
    await page.waitForTimeout(300);
    await assertNoHorizontalOverflow(page);
    await captureVerifiedScreenshot(page, 'dashboard', 'executive', VIEWPORTS.tablet.name);

    // 3. Mobile Standard (390x844)
    await page.setViewportSize({ width: VIEWPORTS.mobileStandard.width, height: VIEWPORTS.mobileStandard.height });
    await page.waitForTimeout(300);
    await assertNoHorizontalOverflow(page);
    await expect(page.locator('nav[aria-label="Mobile Navigation"]')).toBeVisible();
    await captureVerifiedScreenshot(page, 'dashboard', 'executive', VIEWPORTS.mobileStandard.name);

    // 4. Mobile Compact (360x800)
    await page.setViewportSize({ width: VIEWPORTS.mobileCompact.width, height: VIEWPORTS.mobileCompact.height });
    await page.waitForTimeout(300);
    await assertNoHorizontalOverflow(page);
    await captureVerifiedScreenshot(page, 'dashboard', 'executive', VIEWPORTS.mobileCompact.name);
  });

  test('Module 2: Sales & Sales Orders (Desktop & Mobile)', async ({ page }) => {
    test.setTimeout(120000);
    await setupAuditAuth(page);

    // A. Sales Orders on Mobile (390x844)
    await page.setViewportSize({ width: VIEWPORTS.mobileStandard.width, height: VIEWPORTS.mobileStandard.height });
    await page.goto('/sales-orders', { waitUntil: 'networkidle' });
    await waitForAppReady(page);

    const soMobileCards = page.locator('div.block.md\\:hidden');
    await expect(soMobileCards).toBeVisible({ timeout: 20000 });
    await expect(soMobileCards.getByText('SO-2026-0045').first()).toBeVisible({ timeout: 15000 });
    await assertNoLoadingState(page);
    await assertNoHorizontalOverflow(page);
    await captureVerifiedScreenshot(page, 'sales', 'sales-orders', VIEWPORTS.mobileStandard.name);

    // B. Sales Orders on Desktop (1440x900)
    await page.setViewportSize({ width: VIEWPORTS.desktop.width, height: VIEWPORTS.desktop.height });
    await page.waitForTimeout(300);
    const soDesktopTable = page.locator('div.hidden.md\\:block');
    await expect(soDesktopTable).toBeVisible();
    await expect(soMobileCards).toBeHidden();
    await captureVerifiedScreenshot(page, 'sales', 'sales-orders', VIEWPORTS.desktop.name);

    // C. Delivery Challan on Mobile (390x844)
    await page.setViewportSize({ width: VIEWPORTS.mobileStandard.width, height: VIEWPORTS.mobileStandard.height });
    await page.goto('/delivery-challan', { waitUntil: 'networkidle' });
    await waitForAppReady(page);

    const dcMobileCards = page.locator('div.block.md\\:hidden');
    await expect(dcMobileCards).toBeVisible({ timeout: 20000 });
    await expect(dcMobileCards.getByText('DC-2026-0312').first()).toBeVisible({ timeout: 15000 });
    await assertNoLoadingState(page);
    await assertNoHorizontalOverflow(page);
    await captureVerifiedScreenshot(page, 'sales', 'delivery-challan', VIEWPORTS.mobileStandard.name);
  });

  test('Module 3: Purchase Invoices & Orders (Desktop & Mobile)', async ({ page }) => {
    test.setTimeout(120000);
    await setupAuditAuth(page);

    // A. Purchase Invoices on Mobile (390x844)
    await page.setViewportSize({ width: VIEWPORTS.mobileStandard.width, height: VIEWPORTS.mobileStandard.height });
    await page.goto('/finance/purchase', { waitUntil: 'networkidle' });
    await waitForAppReady(page);

    const piMobileCards = page.locator('[data-testid="purchase-invoices-mobile-list"]');
    await expect(piMobileCards).toBeVisible({ timeout: 20000 });
    await expect(piMobileCards.getByText('PI-2026-0089').first()).toBeVisible({ timeout: 15000 });
    await assertNoLoadingState(page);
    await assertNoHorizontalOverflow(page);
    await captureVerifiedScreenshot(page, 'purchase', 'purchase-invoices', VIEWPORTS.mobileStandard.name);

    // B. Small Mobile (360x800)
    await page.setViewportSize({ width: VIEWPORTS.mobileCompact.width, height: VIEWPORTS.mobileCompact.height });
    await page.waitForTimeout(300);
    await assertNoHorizontalOverflow(page);
    await captureVerifiedScreenshot(page, 'purchase', 'purchase-invoices', VIEWPORTS.mobileCompact.name);

    // C. Desktop (1440x900)
    await page.setViewportSize({ width: VIEWPORTS.desktop.width, height: VIEWPORTS.desktop.height });
    await page.waitForTimeout(300);
    const piDesktopTable = page.locator('div.hidden.md\\:block');
    await expect(piDesktopTable).toBeVisible();
    await captureVerifiedScreenshot(page, 'purchase', 'purchase-invoices', VIEWPORTS.desktop.name);
  });

  test('Module 4: Finance Vouchers (Receipt, Payment, Expense, Petty Cash)', async ({ page }) => {
    test.setTimeout(150000);
    await setupAuditAuth(page);

    // 1. Receipt Vouchers on Mobile (390x844)
    await page.setViewportSize({ width: VIEWPORTS.mobileStandard.width, height: VIEWPORTS.mobileStandard.height });
    await page.goto('/finance/receipt', { waitUntil: 'networkidle' });
    await waitForAppReady(page);

    const rvMobileCards = page.locator('[data-testid="receipt-vouchers-mobile-list"]');
    await expect(rvMobileCards).toBeVisible({ timeout: 20000 });
    await expect(rvMobileCards.getByText('RV-2026-0034').first()).toBeVisible({ timeout: 15000 });
    await assertNoLoadingState(page);
    await assertNoHorizontalOverflow(page);
    await captureVerifiedScreenshot(page, 'finance', 'receipt-vouchers', VIEWPORTS.mobileStandard.name);

    // 2. Payment Vouchers on Mobile (390x844)
    await page.goto('/finance/payment', { waitUntil: 'networkidle' });
    await waitForAppReady(page);

    const pvMobileCards = page.locator('[data-testid="payment-vouchers-mobile-list"]');
    await expect(pvMobileCards).toBeVisible({ timeout: 20000 });
    await expect(pvMobileCards.getByText('PV-2026-0056').first()).toBeVisible({ timeout: 15000 });
    await assertNoLoadingState(page);
    await assertNoHorizontalOverflow(page);
    await captureVerifiedScreenshot(page, 'finance', 'payment-vouchers', VIEWPORTS.mobileStandard.name);

    // 3. Expenses on Mobile (390x844)
    await page.goto('/finance/expenses', { waitUntil: 'networkidle' });
    await waitForAppReady(page);

    const expMobileCards = page.locator('div.block.md\\:hidden');
    await expect(expMobileCards).toBeVisible({ timeout: 20000 });
    await expect(expMobileCards.getByText('EXP-2026-0112').first()).toBeVisible({ timeout: 15000 });
    await assertNoLoadingState(page);
    await assertNoHorizontalOverflow(page);
    await captureVerifiedScreenshot(page, 'finance', 'expenses', VIEWPORTS.mobileStandard.name);

    // 4. Petty Cash on Mobile (390x844)
    await page.goto('/finance/petty-cash', { waitUntil: 'networkidle' });
    await waitForAppReady(page);

    const pcMobileCards = page.locator('div.block.md\\:hidden');
    await expect(pcMobileCards).toBeVisible({ timeout: 20000 });
    await expect(pcMobileCards.getByText('PC-2026-0044').first()).toBeVisible({ timeout: 15000 });
    await assertNoLoadingState(page);
    await assertNoHorizontalOverflow(page);
    await captureVerifiedScreenshot(page, 'finance', 'petty-cash', VIEWPORTS.mobileStandard.name);
  });

  test('Module 5: Inventory, Products & Customers (Mobile & Desktop)', async ({ page }) => {
    test.setTimeout(120000);
    await setupAuditAuth(page);

    // 1. Products on Mobile (390x844)
    await page.setViewportSize({ width: VIEWPORTS.mobileStandard.width, height: VIEWPORTS.mobileStandard.height });
    await page.goto('/products', { waitUntil: 'networkidle' });
    await waitForAppReady(page);

    const prodMobileCards = page.locator('div.block.md\\:hidden');
    await expect(prodMobileCards).toBeVisible({ timeout: 20000 });
    await expect(prodMobileCards.getByText('Paracetamol Micronized BP/USP').first()).toBeVisible({ timeout: 15000 });
    await assertNoLoadingState(page);
    await assertNoHorizontalOverflow(page);
    await captureVerifiedScreenshot(page, 'inventory', 'products', VIEWPORTS.mobileStandard.name);

    // 2. Batches on Mobile (390x844)
    await page.goto('/batches', { waitUntil: 'networkidle' });
    await waitForAppReady(page);

    // Expand product group to view batches
    const expandAllBtn = page.getByRole('button', { name: 'Expand All' });
    if (await expandAllBtn.isVisible()) {
      await expandAllBtn.click();
    }
    const batchMobileSection = page.locator('div.block.md\\:hidden');
    await expect(batchMobileSection.first()).toBeVisible({ timeout: 20000 });
    await expect(batchMobileSection.getByText('BTC-2026-091').first()).toBeVisible({ timeout: 15000 });
    await assertNoLoadingState(page);
    await assertNoHorizontalOverflow(page);
    await captureVerifiedScreenshot(page, 'inventory', 'batches', VIEWPORTS.mobileStandard.name);

    // 3. Customers on Mobile (390x844)
    await page.goto('/customers', { waitUntil: 'networkidle' });
    await waitForAppReady(page);

    const custMobileCards = page.locator('div.block.md\\:hidden');
    await expect(custMobileCards).toBeVisible({ timeout: 20000 });
    await expect(custMobileCards.getByText('PT Kalbe Farma Tbk').first()).toBeVisible({ timeout: 15000 });
    await assertNoLoadingState(page);
    await assertNoHorizontalOverflow(page);
    await captureVerifiedScreenshot(page, 'crm', 'customers', VIEWPORTS.mobileStandard.name);
  });

  test('Module 6: Sales Invoices (Desktop & Mobile)', async ({ page }) => {
    test.setTimeout(120000);
    await setupAuditAuth(page);

    // A. Sales Invoices on Mobile (390x844)
    await page.setViewportSize({ width: VIEWPORTS.mobileStandard.width, height: VIEWPORTS.mobileStandard.height });
    await page.goto('/sales', { waitUntil: 'networkidle' });
    await waitForAppReady(page);

    const invMobileCards = page.locator('div.block.md\\:hidden');
    await expect(invMobileCards).toBeVisible({ timeout: 20000 });
    await expect(invMobileCards.getByText('INV-2026-0101').first()).toBeVisible({ timeout: 15000 });
    await assertNoLoadingState(page);
    await assertNoHorizontalOverflow(page);
    await captureVerifiedScreenshot(page, 'sales', 'sales-invoices', VIEWPORTS.mobileStandard.name);

    // B. Sales Invoices on Desktop (1440x900)
    await page.setViewportSize({ width: VIEWPORTS.desktop.width, height: VIEWPORTS.desktop.height });
    await page.waitForTimeout(300);
    const invDesktopTable = page.locator('div.hidden.md\\:block');
    await expect(invDesktopTable).toBeVisible();
    await captureVerifiedScreenshot(page, 'sales', 'sales-invoices', VIEWPORTS.desktop.name);
  });

  test('Module 7: Contra Transfers & Ledger (Mobile)', async ({ page }) => {
    test.setTimeout(120000);
    await setupAuditAuth(page);

    // 1. Contra / Fund Transfers on Mobile (390x844)
    await page.setViewportSize({ width: VIEWPORTS.mobileStandard.width, height: VIEWPORTS.mobileStandard.height });
    await page.goto('/finance/contra', { waitUntil: 'networkidle' });
    await waitForAppReady(page);

    const contraMobileCards = page.locator('div.block.md\\:hidden');
    await expect(contraMobileCards).toBeVisible({ timeout: 20000 });
    await assertNoLoadingState(page);
    await assertNoHorizontalOverflow(page);
    await captureVerifiedScreenshot(page, 'finance', 'contra', VIEWPORTS.mobileStandard.name);

    // 2. Account Ledger on Mobile (390x844)
    await page.goto('/finance/ledger', { waitUntil: 'networkidle' });
    await waitForAppReady(page);
    await assertNoLoadingState(page);
    await assertNoHorizontalOverflow(page);
    await captureVerifiedScreenshot(page, 'finance', 'ledger', VIEWPORTS.mobileStandard.name);
  });

  test('Module 8: CRM & WhatsApp Workspace (Mobile)', async ({ page }) => {
    test.setTimeout(120000);
    await setupAuditAuth(page);

    await page.setViewportSize({ width: VIEWPORTS.mobileStandard.width, height: VIEWPORTS.mobileStandard.height });
    await page.goto('/crm', { waitUntil: 'networkidle' });
    await waitForAppReady(page);
    await assertNoLoadingState(page);
    await assertNoHorizontalOverflow(page);
    await captureVerifiedScreenshot(page, 'crm', 'workspace', VIEWPORTS.mobileStandard.name);
  });

  test('Module 9: Reports & Tax Compliance (Mobile)', async ({ page }) => {
    test.setTimeout(120000);
    await setupAuditAuth(page);

    // 1. Reports Overview on Mobile (390x844)
    await page.setViewportSize({ width: VIEWPORTS.mobileStandard.width, height: VIEWPORTS.mobileStandard.height });
    await page.goto('/reports', { waitUntil: 'networkidle' });
    await waitForAppReady(page);
    await expect(page.getByText('Sales Profitability').first()).toBeVisible({ timeout: 15000 });
    await assertNoLoadingState(page);
    await assertNoHorizontalOverflow(page);
    await captureVerifiedScreenshot(page, 'reports', 'overview', VIEWPORTS.mobileStandard.name);

    // 2. Tax Compliance on Mobile (390x844)
    await page.goto('/finance/tax', { waitUntil: 'networkidle' });
    await waitForAppReady(page);
    await assertNoLoadingState(page);
    await assertNoHorizontalOverflow(page);
    await captureVerifiedScreenshot(page, 'finance', 'tax', VIEWPORTS.mobileStandard.name);
  });

  test('Module 10: Bilingual Localization & Bahasa Indonesia Persistence (Mobile & Desktop)', async ({ page }) => {
    test.setTimeout(120000);
    await setupAuditAuth(page);

    // 1. Start in Mobile View (390x844)
    await page.setViewportSize({ width: VIEWPORTS.mobileStandard.width, height: VIEWPORTS.mobileStandard.height });
    await page.goto('/crm', { waitUntil: 'networkidle' });
    await waitForAppReady(page);

    // 2. Toggle Language to Bahasa Indonesia
    const langBtn = page.locator('button[aria-label="Toggle language"]').first();
    await expect(langBtn).toBeVisible({ timeout: 10000 });
    await langBtn.click();
    await page.waitForTimeout(500);

    // 3. Verify Bottom Navigation and Shell localized in Bahasa Indonesia
    const bottomNav = page.locator('nav[aria-label="Mobile Navigation"]');
    await expect(bottomNav.getByText('Beranda')).toBeVisible({ timeout: 10000 });
    await expect(bottomNav.getByText('Penjualan')).toBeVisible({ timeout: 10000 });
    await expect(bottomNav.getByText('Stok')).toBeVisible({ timeout: 10000 });
    await expect(bottomNav.getByText('Lainnya')).toBeVisible({ timeout: 10000 });

    // 4. Navigate to Purchase Invoices in Indonesian
    await page.goto('/finance/purchase', { waitUntil: 'networkidle' });
    await waitForAppReady(page);
    await expect(page.getByText('Faktur Pembelian').first()).toBeVisible({ timeout: 15000 });

    await assertNoLoadingState(page);
    await assertNoHorizontalOverflow(page);
    await captureVerifiedScreenshot(page, 'localization', 'purchase-invoices-id', VIEWPORTS.mobileStandard.name);

    // 5. Toggle back to English and confirm reversion
    await langBtn.click();
    await page.waitForTimeout(500);
    await expect(page.getByText('Purchase Invoices').first()).toBeVisible({ timeout: 15000 });
    await expect(bottomNav.getByText('Sales')).toBeVisible({ timeout: 10000 });
    await captureVerifiedScreenshot(page, 'localization', 'purchase-invoices-en', VIEWPORTS.mobileStandard.name);
  });

  test('Module 11: Multi-Viewport Responsive Matrix (360x800, 375x812, 390x844, 412x915, 430x932)', async ({ page }) => {
    test.setTimeout(180000);
    await setupAuditAuth(page);

    const targetViewports = [
      { name: '360x800', width: 360, height: 800 },
      { name: '375x812', width: 375, height: 812 },
      { name: '390x844', width: 390, height: 844 },
      { name: '412x915', width: 412, height: 915 },
      { name: '430x932', width: 430, height: 932 },
    ];

    for (const vp of targetViewports) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/dashboard', { waitUntil: 'networkidle' });
      await waitForAppReady(page);
      await assertNoHorizontalOverflow(page);

      // Verify bottom nav is visible and properly anchored
      const nav = page.locator('nav[aria-label="Mobile Navigation"]');
      await expect(nav).toBeVisible();

      // Test a data-dense page (batches)
      await page.goto('/batches', { waitUntil: 'networkidle' });
      await waitForAppReady(page);
      await assertNoHorizontalOverflow(page);
    }
  });

  test('Module 12: Pricing, Sourcing & Operational Reports Workspaces (Mobile & Desktop)', async ({ page }) => {
    test.setTimeout(120000);
    await setupAuditAuth(page);

    // 1. Pricing Dashboard
    await page.setViewportSize({ width: VIEWPORTS.mobileStandard.width, height: VIEWPORTS.mobileStandard.height });
    await page.goto('/pricing-dashboard', { waitUntil: 'networkidle' });
    await waitForAppReady(page);
    await expect(page.getByText('Pricing Overview').first()).toBeVisible({ timeout: 15000 });
    await assertNoHorizontalOverflow(page);

    // 2. Price Calculator
    await page.goto('/calculator', { waitUntil: 'networkidle' });
    await waitForAppReady(page);
    await expect(page.getByText('Price Calculator').first()).toBeVisible({ timeout: 15000 });
    await assertNoHorizontalOverflow(page);

    // 3. Operational Reports (Tab Navigation)
    await page.goto('/reports', { waitUntil: 'networkidle' });
    await waitForAppReady(page);
    await expect(page.getByText('Reports').first()).toBeVisible({ timeout: 15000 });
    await assertNoHorizontalOverflow(page);

    // 4. Chart of Accounts
    await page.goto('/finance/chart-of-accounts', { waitUntil: 'networkidle' });
    await waitForAppReady(page);
    await expect(page.getByText('Chart of Accounts').first()).toBeVisible({ timeout: 15000 });
    await assertNoHorizontalOverflow(page);
  });
});
