import { test, expect } from '@playwright/test';

test.describe('Navigation & Auth Gate Smoke Suite', () => {
  const protectedRoutes = ['/dashboard', '/finance', '/inventory', '/settings'];

  for (const route of protectedRoutes) {
    test(`unauthenticated navigation to ${route} redirects to login`, async ({ page }) => {
      await page.goto(route);

      // Verify redirection to login view
      await expect(page.locator('#username')).toBeVisible({ timeout: 8000 });
      await expect(page.locator('#password')).toBeVisible();
      await expect(page.locator('button[type="submit"]')).toBeVisible();
    });
  }
});
