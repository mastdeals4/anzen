import { test, expect } from '@playwright/test';

test.describe('Public Pricing Calculator Smoke Suite', () => {
  test('public calculator renders without authentication', async ({ page }) => {
    await page.goto('/calculator');

    // Header check
    await expect(page.getByText('Import Price Calculator')).toBeVisible();

    // Mode selectors (FCL / LCL / Air)
    await expect(page.getByRole('button', { name: 'FCL' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'LCL' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'AIR' })).toBeVisible();

    // Calculation result card
    await expect(page.getByText('Result', { exact: true })).toBeVisible();
  });

  test('switching freight modes updates form controls', async ({ page }) => {
    await page.goto('/calculator');

    // Switch to LCL
    const lclButton = page.getByRole('button', { name: 'LCL' });
    await lclButton.click();

    // Verify LCL specific controls appear
    await expect(page.getByText('Packing Type')).toBeVisible();

    // Switch to Air
    const airButton = page.getByRole('button', { name: 'AIR' });
    await airButton.click();

    // Verify Air specific field appears
    await expect(page.getByText(/shipment weight/i)).toBeVisible();
  });
});
