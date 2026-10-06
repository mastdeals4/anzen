import { test, expect } from '@playwright/test';
import fs from 'fs';

test.describe('CRM Inquiry Save Operations (E2E)', () => {
  let anonKey = '';

  test.beforeAll(() => {
    const envFile = fs.readFileSync('.env', 'utf8');
    const anonKeyMatch = envFile.match(/VITE_SUPABASE_ANON_KEY=(.*)/);
    anonKey = anonKeyMatch ? anonKeyMatch[1].trim() : '';
  });

  const setupAuth = async (page: any) => {
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
      access_token: anonKey,
      token_type: 'bearer',
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 7200,
      refresh_token: 'dummy-refresh-token',
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
          { module: 'crm', can_access: true },
        ]),
      });
    });

    // Mock CRM contacts
    await page.route('**/rest/v1/crm_contacts*', async (route: any) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            id: 'd290f1ee-6c54-4b01-90e6-d701748f0851',
            company_name: 'PT Kalbe Farma Tbk',
            contact_person: 'Ms Wulan',
            email: 'wulan@kalbefarma.com',
            phone: '+62 821-1811-1128',
            country: 'Indonesia',
            address: 'Jakarta',
            city: 'Jakarta Timur',
            is_active: true,
          },
        ]),
      });
    });
  };

  test('A & B. Save Inquiry with existing customer and verify payload cleanliness', async ({ page }) => {
    await setupAuth(page);

    const savedPayloads: any[] = [];
    await page.route('**/rest/v1/crm_inquiries*', async (route: any) => {
      const method = route.request().method();
      if (method === 'POST') {
        const body = route.request().postDataJSON();
        savedPayloads.push(body);
        const inserted = (Array.isArray(body) ? body : [body]).map((item, idx) => ({
          ...item,
          id: `inq-${Date.now()}-${idx}`,
          inquiry_number: `INQ-26-000${idx + 1}`,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }));
        await route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify(inserted),
        });
      } else if (method === 'GET') {
        // Return active inquiries list
        const items = savedPayloads.flatMap((payload, pIdx) =>
          (Array.isArray(payload) ? payload : [payload]).map((item, idx) => ({
            ...item,
            id: `inq-${Date.now()}-${pIdx}-${idx}`,
            inquiry_number: `INQ-26-000${pIdx + 1}`,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            user_profiles: { full_name: 'Kunal Lunkad' },
          }))
        );
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(items),
        });
      } else {
        await route.continue();
      }
    });

    // Login via UI
    await page.goto('/');
    await page.locator('#username').fill('kunal');
    await page.locator('#password').fill('secret');
    await page.locator('button[type="submit"]').click();
    await expect(page.locator('#username')).toBeHidden({ timeout: 15000 });

    // Go to CRM
    await page.goto('/crm');
    await page.waitForLoadState('domcontentloaded');

    // Click INQUIRIES tab
    const inqTab = page.locator('button', { hasText: 'INQUIRIES' });
    if (await inqTab.isVisible()) {
      await inqTab.click();
    }

    // Open Add Inquiry modal
    const addInquiryBtn = page.getByRole('button', { name: /add inquiry|new inquiry/i }).first();
    await expect(addInquiryBtn).toBeVisible({ timeout: 8000 });
    await addInquiryBtn.click();

    // Select existing customer
    const customerInput = page.locator('input[placeholder*="search customer" i]').first();
    await customerInput.click();
    const dropdownItem = page.locator('div', { hasText: 'PT Kalbe Farma Tbk' }).last();
    await expect(dropdownItem).toBeVisible({ timeout: 5000 });
    await dropdownItem.click();

    // Fill Product Name
    const productInput = page.locator('#inquiry_product_name');
    await productInput.fill('Fenbendazole');

    // Fill Quantity
    const qtyInput = page.locator('input[name="quantity"]');
    await qtyInput.fill('250 kg');

    // Submit
    const submitBtn = page.locator('form button[type="submit"]');
    await submitBtn.click();

    // Modal should close upon successful save
    await expect(page.getByRole('heading', { name: /new inquiry/i })).toBeHidden({ timeout: 10000 });

    // Verify saved payload
    expect(savedPayloads.length).toBeGreaterThan(0);
    const firstPayload = Array.isArray(savedPayloads[0]) ? savedPayloads[0][0] : savedPayloads[0];

    // INVARIANTS:
    // 1. products array must NOT be in payload
    expect(firstPayload.products).toBeUndefined();
    // 2. items array must NOT be in payload
    expect(firstPayload.items).toBeUndefined();
    // 3. Customer ID must match selected contact
    expect(firstPayload.crm_contact_id).toBe('d290f1ee-6c54-4b01-90e6-d701748f0851');
    expect(firstPayload.company_name).toBe('PT Kalbe Farma Tbk');
    expect(firstPayload.product_name).toBe('Fenbendazole');
    expect(firstPayload.quantity).toBe('250 kg');
    expect(firstPayload.assigned_to).toBe('1075a773-bb55-4296-bc71-af2eab9a0780');
    expect(firstPayload.created_by).toBe('1075a773-bb55-4296-bc71-af2eab9a0780');

    console.log('[VERIFIED SINGLE INQUIRY PAYLOAD]:', firstPayload);
  });

  test('C. Multi-product inquiry creation saves each product row without products column', async ({ page }) => {
    await setupAuth(page);

    let capturedMultiPayload: any = null;
    await page.route('**/rest/v1/crm_inquiries*', async (route: any) => {
      const method = route.request().method();
      if (method === 'POST') {
        capturedMultiPayload = route.request().postDataJSON();
        const inserted = (Array.isArray(capturedMultiPayload) ? capturedMultiPayload : [capturedMultiPayload]).map((item, idx) => ({
          ...item,
          id: `inq-multi-${idx}`,
          inquiry_number: `INQ-26-0001.${idx + 1}`,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }));
        await route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify(inserted),
        });
      } else if (method === 'PATCH') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({}),
        });
      } else {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([]),
        });
      }
    });

    // Login
    await page.goto('/');
    await page.locator('#username').fill('kunal');
    await page.locator('#password').fill('secret');
    await page.locator('button[type="submit"]').click();
    await expect(page.locator('#username')).toBeHidden({ timeout: 15000 });

    // Go to CRM
    await page.goto('/crm');
    const inqTab = page.locator('button', { hasText: 'INQUIRIES' });
    if (await inqTab.isVisible()) {
      await inqTab.click();
    }

    // Open Add Inquiry modal
    const addInquiryBtn = page.getByRole('button', { name: /add inquiry|new inquiry/i }).first();
    await addInquiryBtn.click();

    // Check Multi-Product Toggle
    const multiToggle = page.locator('#multiProductToggle');
    await multiToggle.check();

    // Select customer
    const customerInput = page.locator('input[placeholder*="search customer" i]').first();
    await customerInput.click();
    const dropdownItem = page.locator('div', { hasText: 'PT Kalbe Farma Tbk' }).last();
    await dropdownItem.click();

    // First product row
    const firstProductName = page.locator('input[placeholder="e.g., Paracetamol IP"]').first();
    await firstProductName.fill('Fluconazole');
    const firstProductQty = page.locator('input[placeholder="e.g., 500 KG"]').first();
    await firstProductQty.fill('50 kg');

    // Add another product row
    const addMoreBtn = page.locator('button', { hasText: /add another product/i });
    await addMoreBtn.click();

    // Second product row
    const secondProductName = page.locator('input[placeholder="e.g., Paracetamol IP"]').nth(1);
    await secondProductName.fill('Folic Acid');
    const secondProductQty = page.locator('input[placeholder="e.g., 500 KG"]').nth(1);
    await secondProductQty.fill('10 kg');

    // Submit
    const submitBtn = page.locator('form button[type="submit"]');
    await submitBtn.click();

    // Modal closes
    await expect(page.getByRole('heading', { name: /new inquiry/i })).toBeHidden({ timeout: 10000 });

    // Verify multi-payload
    expect(capturedMultiPayload).not.toBeNull();
    expect(Array.isArray(capturedMultiPayload)).toBe(true);
    expect(capturedMultiPayload.length).toBe(2);

    expect(capturedMultiPayload[0].product_name).toBe('Fluconazole');
    expect(capturedMultiPayload[0].quantity).toBe('50 kg');
    expect(capturedMultiPayload[0].is_multi_product).toBe(true);
    expect(capturedMultiPayload[0].has_items).toBe(true);
    expect(capturedMultiPayload[0].products).toBeUndefined();

    expect(capturedMultiPayload[1].product_name).toBe('Folic Acid');
    expect(capturedMultiPayload[1].quantity).toBe('10 kg');
    expect(capturedMultiPayload[1].is_multi_product).toBe(true);
    expect(capturedMultiPayload[1].has_items).toBe(true);
    expect(capturedMultiPayload[1].products).toBeUndefined();

    console.log('[VERIFIED MULTI-PRODUCT PAYLOAD]:', capturedMultiPayload);
  });

  test('B. Save Inquiry with new customer (not in master) sets company_name and null crm_contact_id', async ({ page }) => {
    await setupAuth(page);

    let capturedPayload: any = null;
    await page.route('**/rest/v1/crm_inquiries*', async (route: any) => {
      const method = route.request().method();
      if (method === 'POST') {
        capturedPayload = route.request().postDataJSON();
        const inserted = (Array.isArray(capturedPayload) ? capturedPayload : [capturedPayload]).map((item, idx) => ({
          ...item,
          id: `inq-new-cust-${idx}`,
          inquiry_number: `INQ-26-0005`,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }));
        await route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify(inserted),
        });
      } else {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([]),
        });
      }
    });

    // Login
    await page.goto('/');
    await page.locator('#username').fill('kunal');
    await page.locator('#password').fill('secret');
    await page.locator('button[type="submit"]').click();
    await expect(page.locator('#username')).toBeHidden({ timeout: 15000 });

    // Go to CRM
    await page.goto('/crm');
    const inqTab = page.locator('button', { hasText: 'INQUIRIES' });
    if (await inqTab.isVisible()) {
      await inqTab.click();
    }

    // Open modal
    const addInquiryBtn = page.getByRole('button', { name: /add inquiry|new inquiry/i }).first();
    await addInquiryBtn.click();

    // Type a brand new customer name (do NOT click dropdown item)
    const customerInput = page.locator('input[placeholder*="search customer" i]').first();
    await customerInput.fill('PT New Prospect Indonesia');

    // Product Name
    const productInput = page.locator('#inquiry_product_name');
    await productInput.fill('Paracetamol');

    // Quantity
    const qtyInput = page.locator('input[name="quantity"]');
    await qtyInput.fill('500 kg');

    // Submit
    const submitBtn = page.locator('form button[type="submit"]');
    await submitBtn.click();

    // Modal closes
    await expect(page.getByRole('heading', { name: /new inquiry/i })).toBeHidden({ timeout: 10000 });

    const payload = Array.isArray(capturedPayload) ? capturedPayload[0] : capturedPayload;
    expect(payload.company_name).toBe('PT New Prospect Indonesia');
    expect(payload.crm_contact_id).toBeNull();
    expect(payload.products).toBeUndefined();
    expect(payload.product_name).toBe('Paracetamol');
    expect(payload.quantity).toBe('500 kg');

    console.log('[VERIFIED NEW CUSTOMER PAYLOAD]:', payload);
  });

  test('D. Edit existing inquiry performs PATCH without schema errors', async ({ page }) => {
    await setupAuth(page);

    const existingInquiry = {
      id: 'd9b73678-2b87-4318-9717-dcf3ea37b601',
      inquiry_number: 'INQ-26-0001',
      product_name: 'Paracetamol',
      specification: 'USP',
      quantity: '100 kg',
      priority: 'medium',
      inquiry_source: 'email',
      supplier_name: 'Acme Pharma',
      supplier_country: 'India',
      crm_contact_id: 'd290f1ee-6c54-4b01-90e6-d701748f0851',
      company_name: 'PT Kalbe Farma Tbk',
      contact_person: 'Ms Wulan',
      contact_email: 'wulan@kalbefarma.com',
      contact_phone: '+62 821-1811-1128',
      pipeline_status: 'new',
      is_multi_product: false,
      has_items: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      user_profiles: { full_name: 'Kunal Lunkad' },
    };

    let capturedPatch: any = null;
    await page.route('**/rest/v1/crm_inquiries*', async (route: any) => {
      const method = route.request().method();
      if (method === 'PATCH') {
        capturedPatch = route.request().postDataJSON();
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([{ ...existingInquiry, ...capturedPatch }]),
        });
      } else if (method === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([existingInquiry]),
        });
      } else {
        await route.continue();
      }
    });

    // Login
    await page.goto('/');
    await page.locator('#username').fill('kunal');
    await page.locator('#password').fill('secret');
    await page.locator('button[type="submit"]').click();
    await expect(page.locator('#username')).toBeHidden({ timeout: 15000 });

    // Go to CRM
    await page.goto('/crm');
    const inqTab = page.getByRole('button', { name: 'INQUIRIES' });
    await expect(inqTab).toBeVisible({ timeout: 10000 });
    await inqTab.click();

    // Inquiry table should display the existing inquiry
    const inquiryButton = page.locator('button', { hasText: 'INQ-26-0001' }).first();
    await expect(inquiryButton).toBeVisible({ timeout: 10000 });

    // Change pipeline status via inline dropdown to trigger PATCH update
    const pipelineSelect = page.locator('select').first();
    await expect(pipelineSelect).toBeVisible({ timeout: 5000 });
    await pipelineSelect.selectOption('in_progress');

    // Wait for PATCH request
    await expect.poll(() => capturedPatch, { timeout: 5000 }).not.toBeNull();

    expect(capturedPatch.pipeline_status).toBe('in_progress');
    expect(capturedPatch.products).toBeUndefined();
    expect(capturedPatch.items).toBeUndefined();
    console.log('[VERIFIED EDIT INQUIRY PATCH PAYLOAD]:', capturedPatch);
  });
});
