import { test, expect } from '@playwright/test';

test.describe('Real User-Level Workflow Verification', () => {
  test('Complete verification of Kunal Pricing, Gmail Thread, Send Price, and CRM Inquiry Table', async ({ page }) => {
    page.on('console', msg => console.log('PAGE LOG:', msg.text()));
    page.on('pageerror', err => console.log('PAGE ERROR:', err.message));

    // 1. Authenticate with admin session
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
      access_token: 'valid-mock-jwt-token',
      token_type: 'bearer',
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 7200,
      refresh_token: 'valid-mock-refresh-token',
      user: mockUser,
    };

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
        body: JSON.stringify([
          { module: 'pricing-worksheet', can_access: true },
          { module: 'pricing-desk', can_access: true },
          { module: 'crm', can_access: true },
        ]),
      });
    });

    // Login via UI
    await page.goto('/');
    const usernameInput = page.locator('#username');
    await usernameInput.fill('kunal');
    await page.locator('#password').fill('secret');
    await page.locator('button[type="submit"]').click();
    await expect(usernameInput).toBeHidden({ timeout: 15000 });

    // 2. Navigate to /pricing-worksheet (loads real data from live Supabase)
    await page.goto('/pricing-worksheet');
    await expect(page.getByRole('heading', { name: 'KUNAL PRICING AI' })).toBeVisible({ timeout: 15000 });

    // Wait for real data to finish loading
    await expect(page.getByText('Loading pricing worksheet...')).toBeHidden({ timeout: 20000 });

    // Verify Workflow Tabs & Completed Count
    const completedTab = page.locator('button', { hasText: 'Completed' });
    await expect(completedTab).toBeVisible();
    const completedText = await completedTab.innerText();
    console.log('[USER VERIFY] Completed Tab Text:', completedText);

    // Click Completed tab
    await completedTab.click();

    // Verify Table Headers
    await expect(page.locator('th', { hasText: 'SUPPLIER PRICE' })).toBeVisible();
    await expect(page.locator('th', { hasText: 'CURR/UNIT' })).toBeVisible();
    await expect(page.locator('th', { hasText: 'LANDED' })).toBeVisible();
    await expect(page.locator('th', { hasText: 'SUGGESTED QUOTE' })).toBeVisible();
    await expect(page.locator('th', { hasText: 'QUOTED PRICE' })).toBeVisible();
    await expect(page.locator('th', { hasText: 'STATUS / REASON' })).toBeVisible();

    // Verify Completed Rows do not show blank Quoted Price
    const completedRows = page.locator('tbody tr.group');
    const rowCount = await completedRows.count();
    console.log('[USER VERIFY] Number of displayed rows in Completed view (Page 1):', rowCount);
    expect(rowCount).toBeGreaterThan(0);

    // Inspect first 5 completed rows
    for (let i = 0; i < Math.min(rowCount, 5); i++) {
      const row = completedRows.nth(i);
      const quotedInput = row.locator('input[title="Actual Customer Quoted Price"]');
      await expect(quotedInput).toBeVisible();
      const val = await quotedInput.inputValue();
      console.log(`[USER VERIFY] Row ${i + 1} Quoted Price Value: "${val}"`);
      expect(val.trim()).not.toBe('');
      expect(val.trim()).not.toBe('—');
    }

    // 3. Test Gmail Evidence Drawer
    // Switch to All or Needs Action tab to find an Enriched row or click an inquiry
    const allTab = page.locator('button', { hasText: 'All' });
    await allTab.click();
    await page.waitForTimeout(500);

    // Find any inquiry button or product name that opens the evidence drawer
    const inquiryLink = page.locator('button[title="Click to preview email & source evidence"]').first();
    await expect(inquiryLink).toBeVisible();
    const inqNum = await inquiryLink.innerText();
    console.log('[USER VERIFY] Opening Email Evidence Drawer for Inquiry:', inqNum);
    await inquiryLink.click();

    // Drawer should open
    const drawer = page.locator('.fixed.inset-0.z-50');
    await expect(drawer).toBeVisible({ timeout: 10000 });

    // Verify Header details
    await expect(drawer.getByText(/From:/i).first()).toBeVisible();

    // Verify AI Extraction side panel fields
    await expect(drawer.getByText('Product', { exact: true })).toBeVisible();
    await expect(drawer.getByText('Supplier', { exact: true })).toBeVisible();
    await expect(drawer.getByText('Requested Make', { exact: true })).toBeVisible();
    await expect(drawer.getByText('Offered Make', { exact: true })).toBeVisible();
    await expect(drawer.getByText('Supplier Price', { exact: true })).toBeVisible();
    await expect(drawer.getByText('Currency', { exact: true })).toBeVisible();
    await expect(drawer.getByText('Quantity', { exact: true })).toBeVisible();
    await expect(drawer.getByText('MOQ & Availability', { exact: true })).toBeVisible();
    await expect(drawer.getByText('Lead Time', { exact: true })).toBeVisible();
    await expect(drawer.getByText('Inquiry', { exact: true })).toBeVisible();
    await expect(drawer.getByText('ACE ERP', { exact: true })).toBeVisible();

    // Verify no raw HTML displayed as literal text
    const drawerText = await drawer.innerText();
    expect(drawerText).not.toContain('<table');
    expect(drawerText).not.toContain('<tr>');
    expect(drawerText).not.toContain('<td>');
    expect(drawerText).not.toContain('<style>');

    // Close drawer
    const closeBtn = drawer.locator('button[title="Close panel (Esc)"]');
    await closeBtn.click();
    await expect(drawer).toBeHidden();

    // 4. Test Send Price / Send to Team action modal
    const sendBtn = page.locator('button[title="Send price to Sales Team via Email"]').first();
    await expect(sendBtn).toBeVisible();
    await sendBtn.click();

    // Internal Reply Modal should appear
    const replyModal = page.locator('.fixed.inset-0.z-50', { hasText: 'Send Price to Sales Team' });
    await expect(replyModal).toBeVisible({ timeout: 10000 });

    // Verify modal has product, price, sender account, and recipient
    await expect(replyModal.getByText('Connected Sender')).toBeVisible();
    await expect(replyModal.getByText('Recipient Team')).toBeVisible();
    await expect(replyModal.getByText('Subject')).toBeVisible();
    await expect(replyModal.getByRole('button', { name: 'Close' })).toBeVisible();

    // Close modal WITHOUT sending
    await replyModal.getByRole('button', { name: 'Close' }).click();
    await expect(replyModal).toBeHidden();

    // 5. Verify CRM -> INQUIRIES Original Excel-Style Table
    await page.goto('/crm');
    await expect(page.getByRole('heading', { name: 'CRM WORKSPACE' })).toBeVisible({ timeout: 15000 });

    // Click INQUIRIES tab in primary navigation
    const inquiriesNav = page.locator('nav button', { hasText: 'INQUIRIES' });
    await expect(inquiriesNav).toBeVisible();
    await inquiriesNav.click();

    // Verify Excel-style InquiryTableExcel is active
    await expect(page.getByPlaceholder('Search all inquiries...')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('th', { hasText: 'ACRP / Inquiry No' })).toBeVisible();
    await expect(page.locator('th', { hasText: 'ACE ERP' })).toBeVisible();
    await expect(page.locator('th', { hasText: 'Customer' })).toBeVisible();
    await expect(page.locator('th', { hasText: 'Product' })).toBeVisible();
    await expect(page.locator('th', { hasText: 'Specification' })).toBeVisible();
    await expect(page.locator('th', { hasText: 'Quantity' })).toBeVisible();
    await expect(page.locator('th', { hasText: 'Supplier' })).toBeVisible();
    await expect(page.locator('th', { hasText: 'P.Price' })).toBeVisible();
    await expect(page.locator('th', { hasText: 'O.Price' })).toBeVisible();
    await expect(page.locator('th', { hasText: 'Price Status' })).toBeVisible();
    await expect(page.locator('th', { hasText: 'COA/Doc' })).toBeVisible();
    await expect(page.locator('th', { hasText: 'Quote' })).toBeVisible();

    console.log('[USER VERIFY] ALL 5 USER-LEVEL WORKFLOWS VERIFIED SUCCESSFULLY!');
  });
});
