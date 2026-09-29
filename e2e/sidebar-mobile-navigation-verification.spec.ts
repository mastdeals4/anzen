import { test, expect } from '@playwright/test';

test.describe('Sidebar & Mobile Navigation Multi-Viewport Verification', () => {
  const setupMocks = async (page: any) => {
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
          { module: 'dashboard', can_access: true },
          { module: 'crm', can_access: true },
          { module: 'sales', can_access: true },
          { module: 'stock', can_access: true },
          { module: 'finance', can_access: true },
          { module: 'price-calculator', can_access: true },
        ]),
      });
    });

    await page.goto('/');
    const usernameInput = page.locator('#username');
    await usernameInput.fill('kunal');
    await page.locator('#password').fill('secret');
    await page.locator('button[type="submit"]').click();
    await expect(usernameInput).toBeHidden({ timeout: 15000 });
  };

  test('Desktop Viewports (1280x800 & 1440x900): compact sidebar, no duplicate PI or Tax in sidebar, Finance accessible', async ({ page }) => {
    await setupMocks(page);

    for (const size of [{ width: 1280, height: 800 }, { width: 1440, height: 900 }]) {
      await page.setViewportSize(size);
      await page.goto('/dashboard');
      await page.waitForLoadState('domcontentloaded');

      // Desktop sidebar should be visible
      const desktopSidebar = page.locator('aside.hidden.lg\\:flex');
      await expect(desktopSidebar).toBeVisible();

      // Mobile bottom nav should NOT be visible on desktop
      const mobileBottomNav = page.locator('nav[aria-label="Mobile Navigation"]');
      await expect(mobileBottomNav).toBeHidden();

      // Verify Purchase Invoices & Tax Compliance DO NOT appear in global sidebar
      const sidebarLinks = desktopSidebar.locator('a');
      const linkTexts = await sidebarLinks.allInnerTexts();
      const lowerTexts = linkTexts.map(t => t.toLowerCase());

      expect(lowerTexts).not.toContain('purchase invoices');
      expect(lowerTexts).not.toContain('tax compliance');

      // Verify module-level groups are present
      expect(lowerTexts).toContain('dashboard');
      expect(lowerTexts).toContain('finance');
      expect(lowerTexts).toContain('price calculator');
      expect(lowerTexts).toContain('crm');
      expect(lowerTexts).toContain('sales');
      expect(lowerTexts).toContain('stock');

      // Verify no horizontal overflow
      const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
      expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 2);
    }
  });

  test('Mobile Viewports (375x812, 390x844, 430x932, 768px tablet): slide-over drawer, sticky header, bottom navigation', async ({ page }) => {
    await setupMocks(page);

    const mobileSizes = [
      { width: 375, height: 812, name: 'iPhone SE/Mini' },
      { width: 390, height: 844, name: 'iPhone 12/13/14' },
      { width: 430, height: 932, name: 'iPhone Pro Max' },
      { width: 768, height: 1024, name: 'iPad / Tablet' },
    ];

    for (const size of mobileSizes) {
      await page.setViewportSize({ width: size.width, height: size.height });
      await page.goto('/dashboard');
      await page.waitForLoadState('domcontentloaded');

      // Desktop sidebar must NOT be visible on mobile
      const desktopSidebar = page.locator('aside.hidden.lg\\:flex');
      await expect(desktopSidebar).toBeHidden();

      // Mobile bottom navigation must be visible (except on 768px if lg breakpoint is 1024)
      const mobileBottomNav = page.locator('nav[aria-label="Mobile Navigation"]');
      await expect(mobileBottomNav).toBeVisible();

      // Verify 5 bottom navigation buttons: Home, CRM, Sales, Stock, More
      await expect(mobileBottomNav.getByText('Home')).toBeVisible();
      await expect(mobileBottomNav.getByText('CRM')).toBeVisible();
      await expect(mobileBottomNav.getByText('Sales')).toBeVisible();
      await expect(mobileBottomNav.getByText('Stock')).toBeVisible();
      await expect(mobileBottomNav.getByText('More')).toBeVisible();

      // Drawer is hidden by default
      const mobileDrawer = page.locator('aside[aria-label="Mobile Navigation Drawer"]');
      await expect(mobileDrawer).toHaveClass(/-translate-x-full/);

      // Open drawer using header hamburger or More button
      const moreBtn = mobileBottomNav.getByText('More');
      await moreBtn.click();

      // Drawer should slide in
      await expect(mobileDrawer).toHaveClass(/translate-x-0/);

      // Verify drawer contents
      await expect(mobileDrawer.getByText('SAPJ ERP')).toBeVisible();
      await expect(mobileDrawer.getByText('Main', { exact: true })).toBeVisible();
      await expect(mobileDrawer.getByRole('button', { name: 'Sales', exact: true })).toBeVisible();
      await expect(mobileDrawer.getByRole('button', { name: 'Finance', exact: true })).toBeVisible();

      // Purchase Invoices & Tax Compliance must NOT be standalone entries in drawer
      const drawerButtons = mobileDrawer.locator('nav button');
      const drawerTexts = (await drawerButtons.allInnerTexts()).map(t => t.toLowerCase());
      expect(drawerTexts).not.toContain('purchase invoices');
      expect(drawerTexts).not.toContain('tax compliance');

      // Close drawer using close button
      const closeBtn = mobileDrawer.locator('button[aria-label="Close menu"]');
      await closeBtn.click();
      await expect(mobileDrawer).toHaveClass(/-translate-x-full/);

      // Verify no horizontal page scrolling on mobile
      const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
      expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 2);
    }
  });

  test('Finance internal sub-navigation preserves Purchase Invoices and Tax Compliance tabs', async ({ page }) => {
    await setupMocks(page);
    await page.setViewportSize({ width: 1280, height: 800 });

    // Navigate to /finance
    await page.goto('/finance');
    await page.waitForLoadState('domcontentloaded');

    // Both Purchase Invoices and Tax tabs must be accessible inside Finance
    // Test direct subroute navigation
    await page.goto('/finance/purchase');
    await page.waitForLoadState('domcontentloaded');
    expect(page.url()).toContain('/finance/purchase');

    await page.goto('/finance/tax');
    await page.waitForLoadState('domcontentloaded');
    expect(page.url()).toContain('/finance/tax');
  });
});
