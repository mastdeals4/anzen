import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import {
  setupAuditAuth,
  waitForAppReady,
  assertNoLoadingState,
  assertNoHorizontalOverflow,
} from './helpers/mobileAuditHelpers';
import { getRollingMonthsRange } from '../src/utils/dateRange';

const PROJECT_ARTIFACT_DIR = path.resolve('artifacts/purchase-invoice-verification');
const BRAIN_ARTIFACT_DIR =
  '/Users/Kunal/.gemini/antigravity/brain/ba0a5665-f6f0-4bb7-bcd8-a665594273a2/purchase-invoice-verification';

fs.mkdirSync(PROJECT_ARTIFACT_DIR, { recursive: true });
fs.mkdirSync(BRAIN_ARTIFACT_DIR, { recursive: true });

async function saveVerifiedScreenshot(page: any, name: string) {
  const filename = `${name}.png`;
  const projPath = path.join(PROJECT_ARTIFACT_DIR, filename);
  const brainPath = path.join(BRAIN_ARTIFACT_DIR, filename);
  await page.screenshot({ path: projPath, fullPage: false });
  fs.copyFileSync(projPath, brainPath);
  return { projPath, brainPath };
}

test.describe('Purchase Invoice Responsive Verification & Global Date Range Optimization', () => {
  const viewports = [
    { width: 1440, height: 900, name: '1440px-desktop' },
    { width: 1280, height: 800, name: '1280px-laptop' },
    { width: 1024, height: 768, name: '1024px-tablet-landscape' },
    { width: 768, height: 1024, name: '768px-tablet-portrait' },
    { width: 430, height: 932, name: '430px-mobile-large' },
    { width: 390, height: 844, name: '390px-mobile-standard' },
    { width: 360, height: 800, name: '360px-mobile-compact' },
  ];

  for (const vp of viewports) {
    test(`Issue 1: Purchase Invoices at ${vp.width}px (${vp.name}) - Action buttons never overlap financial data`, async ({
      page,
    }) => {
      test.setTimeout(60000);
      await setupAuditAuth(page);
      await page.setViewportSize({ width: vp.width, height: vp.height });

      await page.goto('/finance/purchase', { waitUntil: 'networkidle' });
      await waitForAppReady(page);
      await assertNoLoadingState(page);

      if (vp.width >= 768) {
        // Desktop / Intermediate Table Verification
        const desktopTable = page.locator('div.hidden.md\\:block table');
        await expect(desktopTable).toBeVisible({ timeout: 15000 });

        // Total and Balance columns must be explicitly visible in the table header
        await expect(desktopTable.locator('th:has-text("Total")')).toBeVisible();
        await expect(desktopTable.locator('th:has-text("Balance")')).toBeVisible();
        await expect(desktopTable.locator('th:has-text("Actions")')).toBeVisible();

        // Check first invoice row
        const firstRow = desktopTable.locator('tbody tr').first();
        await expect(firstRow).toBeVisible();

        // Locate Total, Balance, and Actions cells
        const totalCell = firstRow.locator('td').nth(4);
        const balanceCell = firstRow.locator('td').nth(5);
        const actionsCell = firstRow.locator('td').nth(7);

        await expect(totalCell).toBeVisible();
        await expect(balanceCell).toBeVisible();
        await expect(actionsCell).toBeVisible();

        // Assert strictly no sticky or absolute positioning on actions
        const actionsThStyle = await desktopTable
          .locator('th:has-text("Actions")')
          .evaluate((el) => {
            const comp = window.getComputedStyle(el);
            return { position: comp.position, right: comp.right };
          });
        expect(actionsThStyle.position).not.toBe('sticky');
        expect(actionsThStyle.position).not.toBe('absolute');

        const actionsTdStyle = await actionsCell.evaluate((el) => {
          const comp = window.getComputedStyle(el);
          return { position: comp.position, right: comp.right };
        });
        expect(actionsTdStyle.position).not.toBe('sticky');
        expect(actionsTdStyle.position).not.toBe('absolute');

        // Bounding box overlap assertion: Actions bounding box must NOT intersect Total or Balance bounding box
        const totalBox = await totalCell.boundingBox();
        const balanceBox = await balanceCell.boundingBox();
        const actionsBox = await actionsCell.boundingBox();

        expect(totalBox).not.toBeNull();
        expect(balanceBox).not.toBeNull();
        expect(actionsBox).not.toBeNull();

        if (totalBox && actionsBox && balanceBox) {
          // Actions cell must be completely to the right of Balance cell
          expect(actionsBox.x).toBeGreaterThanOrEqual(balanceBox.x + balanceBox.width - 2);
          // Balance cell must be completely to the right of Total cell
          expect(balanceBox.x).toBeGreaterThanOrEqual(totalBox.x + totalBox.width - 2);
        }
      } else {
        // Mobile Cards (< 768px)
        const mobileContainer = page.locator('div.block.md\\:hidden');
        await expect(mobileContainer).toBeVisible({ timeout: 15000 });

        const firstCard = mobileContainer.locator('> div').first();
        await expect(firstCard).toBeVisible();

        // Line 1: Invoice # and Status
        await expect(firstCard.getByText('PI-2026-0089')).toBeVisible();
        await expect(firstCard.getByText('partial')).toBeVisible();
        // Line 2: Supplier
        await expect(firstCard.getByText('PT Kimia Farma Trading & Distribution')).toBeVisible();
        // Line 3: Total and Balance
        await expect(firstCard.getByText('Rp 125.000.000,00')).toBeVisible();
        await expect(firstCard.getByText('Due: Rp 45.000.000,00')).toBeVisible();

        await assertNoHorizontalOverflow(page);
      }

      await saveVerifiedScreenshot(page, `purchase_invoice_${vp.width}px_${vp.name}`);
    });
  }

  test('Issue 1 Baseline: Receipt Vouchers reference layout remains correct and in-flow', async ({
    page,
  }) => {
    test.setTimeout(60000);
    await setupAuditAuth(page);
    await page.setViewportSize({ width: 1440, height: 900 });

    await page.goto('/finance/receipt', { waitUntil: 'networkidle' });
    await waitForAppReady(page);
    await assertNoLoadingState(page);

    const rvTable = page.locator('div.hidden.md\\:block table');
    await expect(rvTable).toBeVisible({ timeout: 15000 });
    await expect(rvTable.locator('th:has-text("Amount")')).toBeVisible();
    await expect(rvTable.locator('th:has-text("Actions")')).toBeVisible();

    await saveVerifiedScreenshot(page, 'receipt_vouchers_reference_desktop_1440px');
  });

  test('Issue 2: Central Date Range - Defaults to Rolling 1 Month, 2M preset, and Navigation Persistence', async ({
    page,
  }) => {
    test.setTimeout(60000);
    await setupAuditAuth(page);
    await page.setViewportSize({ width: 1440, height: 900 });

    // 1. Fresh Application Load on Finance module (where date filter is active)
    await page.goto('/finance', { waitUntil: 'networkidle' });
    await waitForAppReady(page);

    const expected1M = getRollingMonthsRange(1);
    const expected2M = getRollingMonthsRange(2);

    // Verify desktop date inputs have rolling 1M range
    const startInput = page.locator('input[type="date"]').first();
    const endInput = page.locator('input[type="date"]').nth(1);

    await expect(startInput).toHaveValue(expected1M.startDate);
    await expect(endInput).toHaveValue(expected1M.endDate);

    // Verify 1M preset button is active (bg-blue-600)
    const btn1M = page.getByRole('button', { name: '1M' });
    const btn2M = page.getByRole('button', { name: '2M' });
    await expect(btn1M).toHaveClass(/bg-blue-600/);

    // 2. Click 2M Preset
    await btn2M.click();
    await expect(startInput).toHaveValue(expected2M.startDate);
    await expect(endInput).toHaveValue(expected2M.endDate);
    await expect(btn2M).toHaveClass(/bg-blue-600/);

    // 3. Set Custom Historical Date Range
    await startInput.fill('2026-03-01');
    await endInput.fill('2026-05-31');
    await expect(startInput).toHaveValue('2026-03-01');
    await expect(endInput).toHaveValue('2026-05-31');

    // Neither preset should be highlighted
    await expect(btn1M).not.toHaveClass(/bg-blue-600/);
    await expect(btn2M).not.toHaveClass(/bg-blue-600/);

    // 4. Navigate to Purchase Invoices
    await page.goto('/finance/purchase', { waitUntil: 'networkidle' });
    await waitForAppReady(page);

    // Date range MUST NOT reset upon navigation
    await expect(page.locator('input[type="date"]').first()).toHaveValue('2026-03-01');
    await expect(page.locator('input[type="date"]').nth(1)).toHaveValue('2026-05-31');

    // 5. Navigate to Sales
    await page.goto('/sales', { waitUntil: 'networkidle' });
    await waitForAppReady(page);
    await expect(page.locator('input[type="date"]').first()).toHaveValue('2026-03-01');
    await expect(page.locator('input[type="date"]').nth(1)).toHaveValue('2026-05-31');

    // 6. Test 1M button resets to rolling 1M
    await page.getByRole('button', { name: '1M' }).click();
    await expect(page.locator('input[type="date"]').first()).toHaveValue(expected1M.startDate);
    await expect(page.locator('input[type="date"]').nth(1)).toHaveValue(expected1M.endDate);

    await saveVerifiedScreenshot(page, 'date_range_preset_optimization_verified');
  });
});
