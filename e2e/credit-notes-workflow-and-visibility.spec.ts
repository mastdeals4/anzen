import { test, expect } from '@playwright/test';

const mockUser = {
  id: '00000000-0000-0000-0000-000000000001',
  email: 'kunal@sapharmajaya.co.id',
  role: 'authenticated',
};

const mockSession = {
  access_token: 'fake-jwt-token',
  token_type: 'bearer',
  expires_in: 3600,
  refresh_token: 'fake-refresh-token',
  user: mockUser,
};

const mockTargetCreditNote = {
  id: '83953d95-7baf-4a07-b7c5-b63d6f08945c',
  credit_note_number: '', // Blank in production
  credit_note_date: '2026-05-28',
  customer_id: '47410ca0-44b7-423a-8d85-09bdc3aa2c78',
  original_invoice_id: '03162b99-b06b-475b-b00c-e14cb9dd6123',
  original_invoice_number: 'SAPJ-26-013',
  reason: 'damaged packaging',
  notes: null,
  currency: 'IDR',
  subtotal: 1572375.0,
  tax_amount: 172961.25,
  total_amount: 1745336.25,
  created_at: '2026-10-26T02:54:00Z',
  updated_at: '2026-10-26T02:54:00Z',
  status: 'pending_approval',
  approved_by: null,
  material_return_id: null,
  customers: {
    company_name: 'PT Menjangan Sakti',
    address: 'Jl. Matraman Raya No. 12',
    city: 'Jakarta',
    phone: '021-12345678',
    npwp: '01.234.567.8-012.000',
    pharmacy_license: 'SIPA-12345',
  },
  material_returns: null,
  sales_invoices: {
    invoice_number: 'SAPJ-26-013',
  },
};

test.describe('Credit Notes UI Workflow and Production Visibility', () => {
  test.beforeEach(async ({ page }) => {
    page.on('console', msg => console.log('BROWSER LOG:', msg.type(), msg.text()));
    page.on('pageerror', err => console.log('BROWSER ERROR:', err.message));

    // Intercept auth endpoints
    await page.route('**/rest/v1/rpc/lookup_login_email*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ email: 'kunal@sapharmajaya.co.id', is_active: true }),
      });
    });

    await page.route('**/auth/v1/token?grant_type=password*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockSession),
      });
    });

    await page.route('**/auth/v1/user*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockUser),
      });
    });

    await page.route('**/rest/v1/user_profiles*', async (route) => {
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

    await page.route('**/rest/v1/user_permissions*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      });
    });

    await page.route('**/rest/v1/app_settings*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      });
    });

    await page.route('**/rest/v1/rpc/get_current_financial_year*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify('26'),
      });
    });

    await page.route('**/rest/v1/customers*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { id: '47410ca0-44b7-423a-8d85-09bdc3aa2c78', company_name: 'PT Menjangan Sakti' },
        ]),
      });
    });

    await page.route('**/rest/v1/products*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      });
    });

    await page.route('**/rest/v1/material_returns*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      });
    });

    await page.route('**/rest/v1/notifications*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      });
    });
  });

  test('Existing credit note record is visible with customer, invoice, and pending badge', async ({ page }) => {
    // Intercept credit_notes query returning the target record
    await page.route('**/rest/v1/credit_notes*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([mockTargetCreditNote]),
      });
    });

    // 1. Log in
    await page.goto('/');
    await page.locator('#username').fill('kunal');
    await page.locator('#password').fill('TestPassword123!');
    await page.locator('button[type="submit"]').click();
    await expect(page.locator('h1')).toContainText('Welcome');

    // 2. Navigate directly to Credit Notes route
    await page.goto('/credit-notes');

    // 3. Verify Credit Notes page header
    await expect(page.locator('h1')).toContainText('Credit Notes');

    // 4. Verify target record row in DataTable
    await expect(page.getByText('PT Menjangan Sakti')).toBeVisible({ timeout: 10000 });
    await expect(page.getByText('SAPJ-26-013')).toBeVisible();
    await expect(page.getByText('damaged packaging')).toBeVisible();
    await expect(page.getByText('Pending', { exact: true })).toBeVisible();
    await expect(page.locator('tbody').getByText('pending approval')).toBeVisible();

    // 5. Verify action buttons for pending credit note (View, Approve, Reject, Delete)
    await expect(page.locator('button[title="View Credit Note"]')).toBeVisible();
    await expect(page.locator('button[title="Approve Credit Note"]')).toBeVisible();
    await expect(page.locator('button[title="Reject Credit Note"]')).toBeVisible();
    await expect(page.locator('button[title="Delete Credit Note"]')).toBeVisible();
  });

  test('Query error displays actionable error banner with Retry button instead of empty list', async ({ page }) => {
    // Simulate PostgREST PGRST201 error
    await page.route('**/rest/v1/credit_notes*', async (route) => {
      await route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 'PGRST201',
          message: "Could not embed because more than one relationship was found for 'credit_notes' and 'material_returns'",
        }),
      });
    });

    // 1. Log in
    await page.goto('/');
    await page.locator('#username').fill('kunal');
    await page.locator('#password').fill('TestPassword123!');
    await page.locator('button[type="submit"]').click();
    await expect(page.locator('h1')).toContainText('Welcome');

    // 2. Navigate to Credit Notes route
    await page.goto('/credit-notes');

    // 3. Verify error banner is visible
    await expect(page.getByText(/Failed to load credit notes/i)).toBeVisible({ timeout: 10000 });
    await expect(page.getByRole('button', { name: /Retry Query/i })).toBeVisible();
  });
});

