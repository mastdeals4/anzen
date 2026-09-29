import { test, expect } from '@playwright/test';

test.describe('Settings -> About Release Identity Verification', () => {
  test('Verifies v1.5.0, Release Date 29 September 2026, and Version History in UI', async ({ page }) => {
    const mockUser = {
      id: '1075a773-bb55-4296-bc71-af2eab9a0780',
      aud: 'authenticated',
      role: 'authenticated',
      email: 'kunal@sapharmajaya.co.id',
      app_metadata: { provider: 'email', providers: ['email'] },
      user_metadata: { full_name: 'Kunal Lunkad' },
      created_at: '2025-10-31T12:00:00.000Z',
      updated_at: '2025-10-31T12:00:00.000Z',
    };

    const mockSession = {
      access_token: 'valid-token',
      token_type: 'bearer',
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 7200,
      refresh_token: 'valid-refresh-token',
      user: mockUser,
    };

    await page.route('**/rest/v1/rpc/lookup_login_email*', async (route: any) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ email: 'kunal@sapharmajaya.co.id', is_active: true }),
      });
    });

    await page.route('**/auth/v1/token?grant_type=password*', async (route: any) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockSession),
      });
    });

    await page.route('**/auth/v1/user*', async (route: any) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockUser),
      });
    });

    await page.route('**/rest/v1/user_profiles*', async (route: any) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: mockUser.id,
          role: 'admin',
          full_name: 'Kunal Lunkad',
          is_active: true,
        }),
      });
    });

    await page.route('**/rest/v1/user_permissions*', async (route: any) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { module: 'settings', can_access: true },
          { module: 'dashboard', can_access: true },
        ]),
      });
    });

    await page.route('**/rest/v1/company_profiles*', async (route: any) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{
          id: 'cp-1',
          company_name: 'PT SAP HARMA JAYA',
          company_legal_name: 'PT SAP HARMA JAYA',
          company_address: 'Jakarta, Indonesia',
          company_phone: '+62 21 1234567',
          company_email: 'info@sapharmajaya.co.id',
          company_website: 'www.sapharmajaya.co.id',
          company_tax_id: '01.234.567.8-901.000',
          effective_from: '2026-01-01',
        }]),
      });
    });

    await page.route('**/rest/v1/app_settings*', async (route: any) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{ id: 'default', company_name: 'PT SAP HARMA JAYA' }]),
      });
    });

    await page.route('**/rest/v1/rpc/get_company_profile_reference_counts*', async (route: any) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      });
    });

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');

    const usernameInput = page.locator('#username');
    await usernameInput.fill('kunal');
    await page.locator('#password').fill('secret');
    await page.locator('button[type="submit"]').click();
    await expect(usernameInput).toBeHidden({ timeout: 15000 });

    // Navigate to Settings
    await page.goto('/settings');
    await page.waitForLoadState('domcontentloaded');

    // Click 'About' tab in Settings
    const aboutTab = page.locator('button:has-text("About")');
    await expect(aboutTab).toBeVisible({ timeout: 10000 });
    await aboutTab.click();

    // Verify Version displays v1.5.0
    const currentVersionBadge = page.locator('text=Current Version: v1.5.0');
    await expect(currentVersionBadge).toBeVisible();

    // Verify Software Information table
    const versionRow = page.locator('div:has-text("Version") >> text=v1.5.0');
    await expect(versionRow.first()).toBeVisible();

    const releaseDateRow = page.locator('div:has-text("Release Date") >> text=29 September 2026');
    await expect(releaseDateRow.first()).toBeVisible();

    // Verify Version History
    const historyHeader = page.locator('h3:has-text("Version History")');
    await expect(historyHeader).toBeVisible();

    const v150HistoryCard = page.locator('div:has-text("v1.5.0") >> text=CRM, Pricing & Omnichannel Operations');
    await expect(v150HistoryCard.first()).toBeVisible();

    const currentBadge = page.locator('span:has-text("Current")');
    await expect(currentBadge.first()).toBeVisible();

    // Verify summary is visible
    const summaryText = page.locator('text=Expanded SAPJ production operations with consolidated CRM navigation');
    await expect(summaryText.first()).toBeVisible();

    // Verify validation report button exists
    const downloadReportBtn = page.locator('button:has-text("Download PDF")');
    await expect(downloadReportBtn).toBeVisible();

    // Capture screenshot as evidence
    await page.screenshot({ path: 'settings_about_v150_verified.png', fullPage: true });
  });
});
