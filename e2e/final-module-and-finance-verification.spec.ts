import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { setupAuditAuth, waitForAppReady, assertNoLoadingState, assertNoHorizontalOverflow } from './helpers/mobileAuditHelpers';

const PROJ_FINAL_DIR = path.resolve('artifacts/final-verification');
const BRAIN_FINAL_DIR = '/Users/Kunal/.gemini/antigravity/brain/ba0a5665-f6f0-4bb7-bcd8-a665594273a2/final-verification';
const BRAIN_RESPONSIVE_DIR = '/Users/Kunal/.gemini/antigravity/brain/ba0a5665-f6f0-4bb7-bcd8-a665594273a2/responsive-audit';

[PROJ_FINAL_DIR, BRAIN_FINAL_DIR, BRAIN_RESPONSIVE_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

async function captureScreen(page: any, filename: string, copyToResponsiveName?: string) {
  const projPath = path.join(PROJ_FINAL_DIR, filename);
  const brainPath = path.join(BRAIN_FINAL_DIR, filename);
  await page.screenshot({ path: projPath, fullPage: false });
  fs.copyFileSync(projPath, brainPath);
  if (copyToResponsiveName) {
    const responsivePath = path.join(BRAIN_RESPONSIVE_DIR, copyToResponsiveName);
    fs.copyFileSync(projPath, responsivePath);
  }
}

test.describe('ANZEN ERP — Complete Loaded-State Verification Across Viewports', () => {

  test('1. Payment Vouchers: Mobile Card View (360px & 390px) & Desktop Table (1440px)', async ({ page }) => {
    test.setTimeout(90000);
    await setupAuditAuth(page);

    // A. Mobile (390x844)
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/finance/payment', { waitUntil: 'domcontentloaded' });
    await waitForAppReady(page);
    await assertNoLoadingState(page);

    // Verify mobile card view is visible
    const voucherCard = page.locator('[data-testid="payment-voucher-card"]').filter({ hasText: 'PV-2026-0056' }).first();
    await expect(voucherCard).toBeVisible({ timeout: 15000 });

    // Verify Mobile Navigation bar is visible
    await expect(page.locator('nav[aria-label="Mobile Navigation"]')).toBeVisible();

    // Verify no horizontal overflow
    await assertNoHorizontalOverflow(page);

    // Expand the first card to reveal the drawer details
    const chevronBtn = voucherCard.locator('button[title*="Expand"]').first();
    if (await chevronBtn.isVisible()) {
      await chevronBtn.click();
      await page.waitForTimeout(300);
    }

    await captureScreen(page, '01_payment_vouchers_mobile_390px.png');

    // B. Small Mobile (360x800)
    await page.setViewportSize({ width: 360, height: 800 });
    await page.waitForTimeout(300);
    await assertNoLoadingState(page);
    await assertNoHorizontalOverflow(page);
    await captureScreen(page, '02_payment_vouchers_small_mobile_360px.png');

    // C. Desktop (1440x900)
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(300);
    await assertNoLoadingState(page);

    const desktopTable = page.locator('div.hidden.md\\:block table');
    await expect(desktopTable).toBeVisible({ timeout: 15000 });
    await expect(page.locator('[data-testid="payment-vouchers-mobile-list"]')).toBeHidden();
    await captureScreen(page, '03_payment_vouchers_desktop_1440px.png');
  });

  test('2. Populated General Ledger / Account Ledger: Desktop & Mobile View', async ({ page }) => {
    test.setTimeout(90000);
    await setupAuditAuth(page);

    // A. Desktop View (1440x900)
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/finance/ledger?account=1110', { waitUntil: 'domcontentloaded' });
    await waitForAppReady(page);
    await assertNoLoadingState(page);

    // Verify account selector or table is loaded
    await expect(page.locator('h1:has-text("Account Ledger")').first()).toBeVisible({ timeout: 15000 });
    await captureScreen(page, '04_general_ledger_desktop_1440px.png');

    // B. Mobile View (390x844) — Content Unobscured
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(300);
    await assertNoLoadingState(page);
    await assertNoHorizontalOverflow(page);
    await captureScreen(page, '05_general_ledger_mobile_390px.png');

    // C. Mobile Drawer Open
    const menuBtn = page.locator('button[aria-label*="finance menu"]').first();
    if (await menuBtn.isVisible()) {
      await menuBtn.click();
      await page.waitForTimeout(300);
      await captureScreen(page, '05b_general_ledger_menu_mobile_390px.png');
    }
  });

  test('3. Delivery Challan: Fully Loaded App Cards on Mobile & Table on Desktop', async ({ page }) => {
    test.setTimeout(90000);
    await setupAuditAuth(page);

    // A. Mobile (390x844)
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/delivery-challan', { waitUntil: 'domcontentloaded' });
    await waitForAppReady(page);
    await assertNoLoadingState(page);

    const dcMobileCards = page.locator('div.block.md\\:hidden');
    await expect(dcMobileCards).toBeVisible({ timeout: 15000 });
    await expect(dcMobileCards.getByText('DC-2026-0312').first()).toBeVisible({ timeout: 15000 });
    await expect(page.locator('nav[aria-label="Mobile Navigation"]')).toBeVisible();
    await assertNoHorizontalOverflow(page);

    await captureScreen(page, '06_delivery_challan_mobile_390px.png', 'delivery-challan-mobile-390x844.png');

    // B. Desktop (1440x900)
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(300);
    await assertNoLoadingState(page);

    const dcDesktopTable = page.locator('div.hidden.md\\:block table');
    await expect(dcDesktopTable).toBeVisible({ timeout: 15000 });
    await expect(dcMobileCards).toBeHidden();
    await captureScreen(page, '07_delivery_challan_desktop_1440px.png', 'delivery-challan-desktop-1440x900.png');
  });

  test('4. Purchase Invoices: Loaded Mobile Cards & Desktop Table', async ({ page }) => {
    test.setTimeout(90000);
    await setupAuditAuth(page);

    // A. Mobile (390x844)
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/finance/purchase', { waitUntil: 'domcontentloaded' });
    await waitForAppReady(page);
    await assertNoLoadingState(page);

    const piMobileCards = page.locator('div.block.md\\:hidden');
    await expect(piMobileCards).toBeVisible({ timeout: 15000 });
    await expect(piMobileCards.getByText('PI-2026-0089').first()).toBeVisible({ timeout: 15000 });
    await expect(page.locator('nav[aria-label="Mobile Navigation"]')).toBeVisible();
    await assertNoHorizontalOverflow(page);

    await captureScreen(page, '08_purchase_invoices_mobile_390px.png', 'purchase-invoices-mobile-390x844.png');

    // B. Small Mobile (360x800)
    await page.setViewportSize({ width: 360, height: 800 });
    await page.waitForTimeout(300);
    await assertNoLoadingState(page);
    await assertNoHorizontalOverflow(page);
    await captureScreen(page, '09_purchase_invoices_small_mobile_360px.png', 'purchase-invoices-small-mobile-360x800.png');

    // C. Desktop (1440x900)
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(300);
    await assertNoLoadingState(page);

    const piDesktopTable = page.locator('div.hidden.md\\:block table');
    await expect(piDesktopTable).toBeVisible({ timeout: 15000 });
    await expect(piMobileCards).toBeHidden();
    await captureScreen(page, '10_purchase_invoices_desktop_1440px.png', 'purchase-invoices-desktop-1440x900.png');
  });

  test('5. Expenses & Petty Cash: Mobile App Cards', async ({ page }) => {
    test.setTimeout(90000);
    await setupAuditAuth(page);

    // A. Expenses (390px)
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/finance/expenses', { waitUntil: 'domcontentloaded' });
    await waitForAppReady(page);
    await assertNoLoadingState(page);
    await assertNoHorizontalOverflow(page);
    await captureScreen(page, '11_expenses_mobile_390px.png');

    // B. Petty Cash (390px)
    await page.goto('/finance/petty-cash', { waitUntil: 'domcontentloaded' });
    await waitForAppReady(page);
    await assertNoLoadingState(page);
    await assertNoHorizontalOverflow(page);
    await captureScreen(page, '12_petty_cash_mobile_390px.png');
  });

  test('6. Dashboard, Products, Customers & CRM: Populated Mobile Screens', async ({ page }) => {
    test.setTimeout(90000);
    await setupAuditAuth(page);

    // A. Dashboard (390px)
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
    await waitForAppReady(page);
    await assertNoLoadingState(page);
    await expect(page.locator('text=Welcome, Kunal Lunkad!').first()).toBeVisible({ timeout: 15000 });
    await expect(page.locator('nav[aria-label="Mobile Navigation"]')).toBeVisible();
    await assertNoHorizontalOverflow(page);
    await captureScreen(page, '13_dashboard_mobile_390px.png', 'dashboard-mobile-390x844.png');

    // B. Products (390px)
    await page.goto('/products', { waitUntil: 'domcontentloaded' });
    await waitForAppReady(page);
    await assertNoLoadingState(page);
    const prodCards = page.locator('div.block.md\\:hidden');
    await expect(prodCards).toBeVisible({ timeout: 15000 });
    await expect(prodCards.getByText('Paracetamol Micronized BP/USP').first()).toBeVisible({ timeout: 15000 });
    await assertNoHorizontalOverflow(page);
    await captureScreen(page, '14_products_mobile_390px.png', 'products-mobile-390x844.png');

    // C. Customers (390px)
    await page.goto('/customers', { waitUntil: 'domcontentloaded' });
    await waitForAppReady(page);
    await assertNoLoadingState(page);
    const custCards = page.locator('div.block.md\\:hidden');
    await expect(custCards).toBeVisible({ timeout: 15000 });
    await expect(custCards.getByText('PT Kalbe Farma Tbk').first()).toBeVisible({ timeout: 15000 });
    await assertNoHorizontalOverflow(page);
    await captureScreen(page, '15_customers_mobile_390px.png', 'customers-mobile-390x844.png');

    // D. CRM (390px)
    await page.goto('/crm', { waitUntil: 'domcontentloaded' });
    await waitForAppReady(page);
    await assertNoLoadingState(page);
    await assertNoHorizontalOverflow(page);
    await captureScreen(page, '16_crm_mobile_390px.png');
  });

});
