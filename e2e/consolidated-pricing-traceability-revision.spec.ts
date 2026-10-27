import { test, expect } from '@playwright/test';

test.describe('Consolidated Verification: Multi-Option Pricing AI, Stock Movements PI Traceability, & Controlled Sales Revision', () => {
  const mockUser = {
    id: '1075a773-bb55-4296-bc71-af2eab9a0780',
    aud: 'authenticated',
    role: 'admin',
    email: 'kunal@sapharmajaya.co.id',
    app_metadata: { provider: 'email', providers: ['email'] },
    user_metadata: { full_name: 'Kunal Lunkad' },
    created_at: '2025-10-31T12:00:00.000Z',
    updated_at: '2025-10-31T12:00:00.000Z',
  };

  const mockJwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMDc1YTc3My1iYjU1LTQyOTYtYmM3MS1hZjJlYWI5YTA3ODAiLCJyb2xlIjoiYXV0aGVudGljYXRlZCIsImV4cCI6MTk5OTk5OTk5OX0.dummy-signature';

  const mockSession = {
    access_token: mockJwt,
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 7200,
    refresh_token: 'valid-mock-refresh-token',
    user: mockUser,
  };

  test.beforeEach(async ({ page }) => {
    page.on('console', msg => {
      if (msg.type() === 'error') console.log('PAGE LOG ERROR:', msg.text());
    });
    page.on('pageerror', err => console.log('PAGE EXCEPTION:', err.message));

    // Intercept common auth and permissions
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
          { module: 'stock', can_access: true },
          { module: 'sales', can_access: true },
          { module: 'crm', can_access: true },
        ]),
      });
    });
  });

  // -------------------------------------------------------------------------
  // 1. Issue 1 Verification: Kunal Pricing AI Multi-Option Support
  // -------------------------------------------------------------------------
  test('Issue 1: Pricing Worksheet supports multi-option sourcing cards, independent quotes, and Send to Team table', async ({ page }) => {
    const mockInquiryId = 'inq-pyrantel-001';

    await page.route('**/rest/v1/pricing_settings*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'test-pricing-settings-id',
          config: {
            fcl: {
              '20ft': { clearance: 500, capacity: { mixed: 12000, bags_25kg: 20000, bags_50kg: 20000, drums_25kg: 10000, drums_50kg: 16000 } },
              '40ft': { clearance: 800, capacity: { mixed: 25000, bags_25kg: 26000, bags_50kg: 26000, drums_25kg: 15000, drums_50kg: 20000 } },
            },
            general: {
              fx_mode: 'manual',
              manual_fx_rate: 16000,
              inr_usd_mode: 'manual',
              inr_usd_manual_rate: 86.5,
              inr_usd_cached_rate: 86.5,
            },
          },
        }),
      });
    });

    await page.route('**/rest/v1/crm_inquiries*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            id: mockInquiryId,
            inquiry_number: 'INQ-2026-0999',
            aceerp_no: 'ACE-999',
            company_name: 'PT Kalbe Farma Tbk',
            product_name: 'Pyrantel Pamoate USP',
            specification: 'USP',
            quantity: '1,000 kg',
            supplier_name: 'JRC',
            source_status: 'received',
            document_status: 'received',
            kunal_price_status: 'pending',
            quote_status: 'not_sent',
            purchase_price: 23.35,
            offered_price: 25.50,
            purchase_price_currency: 'USD',
            offered_price_currency: 'USD',
            remarks: 'Customer wants JRC or IPCA quote comparison',
            created_at: '2026-10-20T10:00:00Z',
          },
        ]),
      });
    });

    await page.route('**/rest/v1/crm_inquiry_pricing_options*', async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([
            {
              id: 'opt-uuid-jrc',
              inquiry_id: mockInquiryId,
              offered_make: 'JRC',
              source_price: 1850,
              source_currency: 'INR',
              selling_price: 25.50,
              selling_currency: 'USD',
              is_selected: true,
              kunal_remark: 'Direct manufacturer rate',
            },
            {
              id: 'opt-uuid-ipca',
              inquiry_id: mockInquiryId,
              offered_make: 'IPCA',
              source_price: 2050,
              source_currency: 'INR',
              selling_price: 28.00,
              selling_currency: 'USD',
              is_selected: false,
              kunal_remark: 'Prompt delivery',
            },
          ]),
        });
      } else {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) });
      }
    });

    await page.route('**/rest/v1/kunal_ai_email_reviews*', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) });
    });
    await page.route('**/rest/v1/crm_product_documents*', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) });
    });
    await page.route('**/rest/v1/pricing_ledger*', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) });
    });

    // Login
    await page.goto('/');
    await page.locator('#username').fill('kunal');
    await page.locator('#password').fill('secret');
    await page.locator('button[type="submit"]').click();
    await expect(page.locator('#username')).toBeHidden({ timeout: 10000 });

    // Open Pricing Worksheet
    await page.goto('/pricing-worksheet');
    await expect(page.getByRole('heading', { name: 'KUNAL PRICING AI' })).toBeVisible({ timeout: 10000 });

    // Switch to All tab
    const allTabBtn = page.getByRole('button', { name: /All/i });
    if (await allTabBtn.isVisible()) {
      await allTabBtn.click();
    }

    // Confirm Pyrantel Pamoate row is rendered
    await expect(page.getByText('Pyrantel Pamoate USP')).toBeVisible();

    // Expand Details row
    await page.locator('tbody tr button[title="Expand Details"]').first().click();

    // Verify Sourcing Options section
    await expect(page.getByText('Sourcing Options & Competing Makes')).toBeVisible();
    await expect(page.getByText(/Option A/i).first()).toBeVisible();
    await expect(page.getByText(/Option B/i).first()).toBeVisible();

    // Verify Option A active and Option B has "Set as Active"
    await expect(page.getByText('✓ Active for Main Quote')).toBeVisible();
    const setAsActiveBtn = page.getByRole('button', { name: 'Set as Active' });
    await expect(setAsActiveBtn).toBeVisible();

    // Click "SEND TO TEAM" to open KunalInternalReplyModal
    const sendButton = page.locator('button').filter({ hasText: 'SEND TO TEAM' }).first();
    await expect(sendButton).toBeVisible();
    await sendButton.click();

    // Verify Send Pricing to Team Modal opens
    await expect(page.getByRole('heading', { name: 'Send Internal Price Reply' })).toBeVisible();

    // Verify email preview contains Option A and Option B in the internal price table
    await expect(page.getByText('JRC (Option A)')).toBeVisible();
    await expect(page.getByText('IPCA (Option B)')).toBeVisible();
    await expect(page.getByText('INR 1,850').first()).toBeVisible();
    await expect(page.getByText('INR 2,050').first()).toBeVisible();

    // Close modal
    await page.locator('button').filter({ hasText: 'Cancel' }).click();
  });

  // -------------------------------------------------------------------------
  // 2. Issue 2 Verification: Stock Movements PI Traceability & Quick View
  // -------------------------------------------------------------------------
  test('Issue 2: Stock Movements displays clean PI references and opens Purchase Invoice Quick View', async ({ page }) => {
    const mockProductId = 'prod-cyp-001';

    await page.route('**/rest/v1/inventory_v1_stock_summary*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            product_id: mockProductId,
            product_code: 'P-001',
            product_name: 'Cyproheptadine Hydrochloride USP',
            unit: 'KG',
            total_current_stock: 50,
            reserved_stock: 0,
            shortage_quantity: 0,
            available_quantity: 50,
            available_to_promise_stock: 50,
            active_batches_count: 1,
            nearest_expiry_date: '2028-12-31',
          },
        ]),
      });
    });

    await page.route('**/rest/v1/batches*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            id: 'batch-001',
            batch_number: 'BCYPH/2510070',
            product_id: mockProductId,
            current_stock: 50,
            reserved_stock: 0,
            status: 'active',
            expiry_date: '2028-12-31',
            make_id: null,
            unit_cost: 300,
            total_cost: 15000,
            products: { unit: 'KG', tax_rate: 11 },
          },
        ]),
      });
    });

    await page.route('**/rest/v1/product_sources*', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) });
    });

    await page.route('**/rest/v1/inventory_v1_effective_ledger*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            id: 'mov-1',
            product_id: mockProductId,
            batch_id: 'batch-001',
            transaction_type: 'purchase_receipt',
            reference_type: 'purchase_invoice_receiving',
            reference_id: 'pi-menjangan-80103232',
            reference_number: '80103232',
            quantity: 50,
            transaction_date: '2026-08-15',
            created_at: '2026-08-15T08:00:00Z',
            notes: 'Received from supplier',
          },
          {
            id: 'mov-2',
            product_id: mockProductId,
            batch_id: 'batch-001',
            transaction_type: 'certified_opening',
            reference_type: null,
            reference_id: null,
            reference_number: null,
            quantity: 25,
            transaction_date: '2026-01-01',
            created_at: '2026-01-01T08:00:00Z',
            notes: 'Opening audit balance',
          },
        ]),
      });
    });

    await page.route('**/rest/v1/purchase_invoices*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            id: 'pi-menjangan-80103232',
            invoice_number: '80103232',
            invoice_date: '2026-08-15',
            currency: 'USD',
            total_amount: 15400,
            receiving_approval_status: 'approved',
            suppliers: {
              company_name: 'PT Menjangan Sakti',
              phone: '+62-21-5551234',
              tax_id: '01.234.567.8-012.000',
              address: 'Jakarta Barat, Indonesia',
            },
          },
        ]),
      });
    });

    await page.route('**/rest/v1/purchase_invoice_items*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            id: 'pi-item-1',
            invoice_id: 'pi-menjangan-80103232',
            product_id: mockProductId,
            quantity: 50,
            unit_price: 308,
            total_price: 15400,
            products: { product_name: 'Cyproheptadine Hydrochloride USP' },
          },
        ]),
      });
    });

    await page.route('**/rest/v1/stock_reservations*', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) });
    });
    await page.route('**/rest/v1/so_product_reservations*', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) });
    });
    await page.route('**/rest/v1/delivery_challans*', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) });
    });

    // Login
    await page.goto('/');
    await page.locator('#username').fill('kunal');
    await page.locator('#password').fill('secret');
    await page.locator('button[type="submit"]').click();
    await expect(page.locator('#username')).toBeHidden({ timeout: 10000 });

    // Open Stock page
    await page.goto('/stock');
    await expect(page.getByRole('heading', { name: 'Stock' })).toBeVisible({ timeout: 10000 });

    // Verify Cyproheptadine product is displayed
    await expect(page.getByText('Cyproheptadine Hydrochloride USP')).toBeVisible();

    // Click movements button for Cyproheptadine
    const movementsBtn = page.getByRole('button', { name: /Movements/i }).first();
    await expect(movementsBtn).toBeVisible();
    await movementsBtn.click();

    // Verify StockMovementsModal is displayed
    await expect(page.getByRole('heading', { name: 'Stock Movements' })).toBeVisible();

    // Verify party resolved to PT Menjangan Sakti and Opening Balance displayed cleanly
    await expect(page.getByText('PT Menjangan Sakti')).toBeVisible();
    await expect(page.getByText('Opening Balance')).toBeVisible();

    // Verify clickable PI reference "80103232"
    const piLink = page.getByRole('button', { name: '80103232' });
    await expect(piLink).toBeVisible();
    await piLink.click();

    // Verify Purchase Invoice Quick View modal appears
    await expect(page.getByRole('heading', { name: /Purchase Invoice: 80103232/i })).toBeVisible();
    await expect(page.getByText('USD 15,400')).toBeVisible();
    await expect(page.getByText('Invoice Line Items')).toBeVisible();
  });

  // -------------------------------------------------------------------------
  // 3. Issue 3 Verification: Controlled Sales Invoice Price Revision
  // -------------------------------------------------------------------------
  test('Issue 3: Financially posted invoice enters Controlled Revision Mode with locked quantity and editable unit price', async ({ page }) => {
    const mockInvoiceId = 'inv-posted-072';

    await page.route('**/rest/v1/sales_invoices*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            id: mockInvoiceId,
            invoice_number: 'SAPJ-26-072',
            invoice_date: '2026-08-20',
            due_date: '2026-09-20',
            customer_id: 'cust-01',
            so_id: 'so-0087',
            delivery_challan_id: 'do-0073',
            customer_name: 'PT Kimia Farma Trading',
            subtotal: 10000000,
            tax_amount: 1100000,
            total_amount: 11100000,
            paid_amount: 0,
            balance_amount: 11100000,
            status: 'posted',
            payment_status: 'unpaid',
            tax_invoice_number: '010.000-26.0000072',
            notes: 'Delivered via DO-26-0073',
            created_at: '2026-08-20T10:00:00Z',
            customers: {
              company_name: 'PT Kimia Farma Trading',
              address: 'Jl. Veteran No. 9',
              city: 'Jakarta',
              phone: '021-3847709',
              npwp: '01.000.000.0-000.000',
              pharmacy_license: 'SIPA-1234',
              gst_vat_type: 'taxable',
            },
          },
        ]),
      });
    });

    await page.route('**/rest/v1/sales_invoice_items*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            id: 'item-072-1',
            invoice_id: mockInvoiceId,
            product_id: 'prod-001',
            batch_id: 'batch-001',
            quantity: 100,
            unit_price: 100000,
            total_price: 10000000,
            tax_rate: 11,
            tax_amount: 1100000,
            products: { product_name: 'Paracetamol Micronized BP' },
            batches: { batch_number: 'BPAR-2026-01' },
          },
        ]),
      });
    });

    await page.route('**/rest/v1/voucher_allocations*', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) });
    });
    await page.route('**/rest/v1/invoice_rounding_adjustments*', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) });
    });
    await page.route('**/rest/v1/delivery_challan_items*', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) });
    });
    await page.route('**/rest/v1/pending_dc_items_by_customer*', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) });
    });
    await page.route('**/rest/v1/delivery_challans*', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) });
    });
    await page.route('**/rest/v1/sales_orders*', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) });
    });
    await page.route('**/rest/v1/customers*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            id: 'cust-01',
            name: 'PT Kimia Farma Trading',
            code: 'CUST-001',
          },
        ]),
      });
    });
    await page.route('**/rest/v1/products*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            id: 'prod-001',
            product_name: 'Paracetamol Micronized BP',
            product_code: 'PAR-001',
            unit: 'KG',
          },
        ]),
      });
    });
    await page.route('**/rest/v1/batches*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            id: 'batch-001',
            batch_number: 'BPAR-2026-01',
            product_id: 'prod-001',
          },
        ]),
      });
    });

    // Login
    await page.goto('/');
    await page.locator('#username').fill('kunal');
    await page.locator('#password').fill('secret');
    await page.locator('button[type="submit"]').click();
    await expect(page.locator('#username')).toBeHidden({ timeout: 10000 });

    // Open Sales Page
    await page.goto('/sales');
    await expect(page.getByRole('heading', { name: 'Sales' })).toBeVisible({ timeout: 10000 });

    // Confirm SAPJ-26-072 row is rendered
    await expect(page.getByText('SAPJ-26-072')).toBeVisible();

    // Click Edit button for posted invoice
    const editBtn = page.locator('button[title*="Edit"]').first();
    await expect(editBtn).toBeVisible();
    await editBtn.click();

    // Verify Controlled Revision Mode banner
    await expect(page.getByText('Financially Posted Invoice — Controlled Revision Mode')).toBeVisible();

    // Verify Product and Quantity are disabled (locked to protect warehouse delivery lineage)
    const qtyInput = page.locator('input[name="quantity"]');
    await expect(qtyInput).toBeDisabled();

    // Verify Unit Price is enabled and editable
    const unitPriceInput = page.locator('div:has(> label:has-text("Unit Price *")) input');
    await expect(unitPriceInput).toBeEnabled();

    // Amend unit price to 95000
    await unitPriceInput.fill('95000');

    // Verify total recalculates dynamically: 95,000 * 100 * 1.11 = 10,545,000
    await expect(page.getByText(/10\.545\.000/)).toBeVisible();
  });
});
