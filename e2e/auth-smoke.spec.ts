import { test, expect } from '@playwright/test';

test.describe('Authentication & Landing Smoke Suite', () => {
  test('login page loads with branding, inputs, and form controls', async ({ page }) => {
    await page.goto('/');

    // Verify company branding & headers
    await expect(page.locator('h1')).toBeVisible();
    await expect(page.getByText(/welcome back/i)).toBeVisible();

    // Verify username and password inputs
    const usernameInput = page.locator('#username');
    const passwordInput = page.locator('#password');
    const submitButton = page.locator('button[type="submit"]');

    await expect(usernameInput).toBeVisible();
    await expect(passwordInput).toBeVisible();
    await expect(submitButton).toBeVisible();
  });

  test('invalid login credentials display expected error message', async ({ page }) => {
    await page.goto('/');

    await page.locator('#username').fill('non_existent_test_user');
    await page.locator('#password').fill('InvalidPassword999!');
    await page.locator('button[type="submit"]').click();

    // Assert error state appears
    await expect(page.getByText(/invalid username or password/i)).toBeVisible({ timeout: 8000 });
  });

  test('responsive layout renders correctly across viewport sizes', async ({ page }) => {
    await page.goto('/');

    const formCard = page.locator('.max-w-md').first();
    await expect(formCard).toBeVisible();

    // Verify card does not cause horizontal page scrolling
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 2);
  });
});
