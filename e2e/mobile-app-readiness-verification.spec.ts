import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';

test.describe('Anzen ERP Mobile-App Readiness & Responsive Verification Suite', () => {
  const artifactDir = '/Users/Kunal/.gemini/antigravity/brain/ba0a5665-f6f0-4bb7-bcd8-a665594273a2/responsive-audit';

  const setupAuth = async (page: any) => {
    const envFile = fs.readFileSync('.env', 'utf8');
    const anonKeyMatch = envFile.match(/VITE_SUPABASE_ANON_KEY=(.*)/);
    const anonKey = anonKeyMatch ? anonKeyMatch[1].trim() : '';

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

    await page.addInitScript(({ session, userId }) => {
      window.localStorage.setItem('sb-dkrtsqienlhpouohmfki-auth-token', JSON.stringify(session));
      // Pre-dismiss approval popup so it doesn't cover main content during responsive checks
      window.localStorage.setItem(`approval_popup_dismissed_${userId}`, 'dismissed_for_responsive_audit');
    }, { session: mockSession, userId: mockUser.id });

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

    // Mock realistic business data
    const mockProducts = [
      {
        id: 'prod-1',
        product_name: 'Paracetamol Micronized BP/USP',
        product_code: 'PARA-MIC-01',
        hsn_code: '29242990',
        category: 'API',
        unit: 'KG',
        packaging_type: 'Drum',
        default_supplier: 'Anhui BBCA Pharma',
        description: 'High purity analgesic API',
        current_stock: 1250,
        is_active: true,
      },
      {
        id: 'prod-2',
        product_name: 'Amoxicillin Trihydrate Compacted',
        product_code: 'AMOX-TRI-02',
        hsn_code: '29411019',
        category: 'Antibiotic API',
        unit: 'KG',
        packaging_type: 'Carton',
        default_supplier: 'Sinopharm Group',
        description: 'Oral antibiotic powder',
        current_stock: 800,
        is_active: true,
      },
    ];

    const mockPurchaseInvoices = [
      {
        id: 'pi-1',
        invoice_number: 'PI-2026-0089',
        invoice_date: '2026-11-05',
        due_date: '2026-12-05',
        currency: 'IDR',
        exchange_rate: 1,
        total_amount: 125000000,
        balance_amount: 45000000,
        status: 'partial',
        receiving_approval_status: 'approved',
        supplier_id: 'sup-1',
        suppliers: { id: 'sup-1', company_name: 'PT Kimia Farma Trading & Distribution' },
        items: [],
      },
      {
        id: 'pi-2',
        invoice_number: 'PI-2026-0090',
        invoice_date: '2026-11-06',
        due_date: '2026-12-06',
        currency: 'USD',
        exchange_rate: 15850,
        total_amount: 12500,
        balance_amount: 12500,
        status: 'unpaid',
        receiving_approval_status: 'approved',
        supplier_id: 'sup-2',
        suppliers: { id: 'sup-2', company_name: 'Jiangsu Huaxi Pharma Chem Ltd' },
        items: [],
      },
    ];

    const mockDeliveryChallans = [
      {
        id: 'dc-1',
        challan_number: 'DC-2026-0312',
        challan_date: '2026-11-07',
        status: 'delivered',
        approval_status: 'approved',
        customer_id: 'c-1',
        customers: { id: 'c-1', company_name: 'PT Kalbe Farma Tbk', address: 'Jl. Letjen Suprapto Kav 4', city: 'Jakarta Pusat', phone: '021-42873888', pbf_license: 'PBF-JKT-2024' },
        sales_orders: { so_number: 'SO-2026-0045', so_date: '2026-11-01' },
        driver_name: 'Budi Santoso',
        vehicle_number: 'B 9482 KBA',
        total_quantity: 450,
      },
      {
        id: 'dc-2',
        challan_number: 'DC-2026-0313',
        challan_date: '2026-11-07',
        status: 'dispatched',
        approval_status: 'approved',
        customer_id: 'c-2',
        customers: { id: 'c-2', company_name: 'PT Dexa Medica', address: 'Titan Center Lt. 3, Bintaro', city: 'Tangerang Selatan', phone: '021-7451234', pbf_license: 'PBF-TNG-2023' },
        sales_orders: { so_number: 'SO-2026-0046', so_date: '2026-11-02' },
        driver_name: 'Agus Setiawan',
        vehicle_number: 'B 1204 SS',
        total_quantity: 200,
      },
    ];

    const mockCustomers = [
      {
        id: 'c-1',
        company_name: 'PT Kalbe Farma Tbk',
        npwp: '01.234.567.8-012.000',
        address: 'Jl. Letjen Suprapto Kav 4',
        city: 'Jakarta Pusat',
        country: 'Indonesia',
        contact_person: 'Dr. Hendra Gunawan',
        email: 'hendra.g@kalbefarma.com',
        phone: '081234567890',
        pbf_license: 'PBF-JKT-2024',
        gst_vat_type: 'taxable',
        payment_terms: 'net_30',
        is_active: true,
      },
      {
        id: 'c-2',
        company_name: 'PT Dexa Medica',
        npwp: '01.987.654.3-098.000',
        address: 'Titan Center Lt. 3, Bintaro',
        city: 'Tangerang Selatan',
        country: 'Indonesia',
        contact_person: 'Ibu Ratna Dewi',
        email: 'ratna.dewi@dexagroup.com',
        phone: '081398765432',
        pbf_license: 'PBF-TNG-2023',
        gst_vat_type: 'taxable',
        payment_terms: 'net_60',
        is_active: true,
      },
    ];

    const mockBatches = [
      {
        id: 'batch-1',
        batch_number: 'BTC-2026-091',
        product_id: 'prod-1',
        product_name: 'Paracetamol Micronized BP/USP',
        current_stock: 1250,
        reserved_stock: 450,
        expiry_date: '2028-10-31',
        import_price: 65000,
        is_active: true,
      },
    ];

    // Master REST router for Supabase API requests
    await page.route('**/rest/v1/**', async (route: any) => {
      const url = route.request().url();
      const accept = route.request().headers()['accept'] || '';

      if (url.includes('/rest/v1/rpc/lookup_login_email')) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ email: 'kunal@sapharmajaya.co.id', is_active: true }),
        });
      }

      if (url.includes('/rest/v1/user_profiles')) {
        const profile = {
          id: mockUser.id,
          role: 'admin',
          full_name: 'Kunal Lunkad',
          is_active: true,
        };
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(accept.includes('vnd.pgrst.object+json') ? profile : [profile]),
        });
      }

      if (url.includes('/rest/v1/user_permissions')) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([]),
        });
      }

      if (url.includes('/rest/v1/company_profiles')) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([{ company_name: 'PT SAPHARMA JAYA' }]),
        });
      }

      if (url.includes('/rest/v1/app_settings')) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([{ setup_mode: false }]),
        });
      }

      if (url.includes('/rest/v1/inventory_v1_stock_summary')) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([
            { product_id: 'prod-1', total_current_stock: 1250 },
            { product_id: 'prod-2', total_current_stock: 800 },
          ]),
        });
      }

      if (url.includes('/rest/v1/products')) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(mockProducts),
        });
      }

      if (url.includes('/rest/v1/purchase_invoices')) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(mockPurchaseInvoices),
        });
      }

      if (url.includes('/rest/v1/delivery_challans')) {
        if (url.includes('approval_status=eq.pending_approval')) {
          return route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify([]),
          });
        }
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(mockDeliveryChallans),
        });
      }

      if (url.includes('/rest/v1/dc_invoicing_summary')) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([
            { challan_id: 'dc-1', dc_status: 'delivered', total_items: 1, not_invoiced_items: 0, partially_invoiced_items: 0, fully_invoiced_items: 1, total_remaining_quantity: 0, linked_invoices: ['INV-2026-0101'] },
            { challan_id: 'dc-2', dc_status: 'dispatched', total_items: 1, not_invoiced_items: 1, partially_invoiced_items: 0, fully_invoiced_items: 0, total_remaining_quantity: 200, linked_invoices: [] },
          ]),
        });
      }

      if (url.includes('/rest/v1/sales_orders')) {
        if (url.includes('status=eq.pending_approval') || url.includes('approval_status=eq.pending_approval')) {
          return route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify([]),
          });
        }
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([
            { id: 'so-1', so_number: 'SO-2026-0045', customer_id: 'c-1', status: 'approved', customers: { company_name: 'PT Kalbe Farma Tbk' } },
            { id: 'so-2', so_number: 'SO-2026-0046', customer_id: 'c-2', status: 'approved', customers: { company_name: 'PT Dexa Medica' } },
          ]),
        });
      }

      if (url.includes('/rest/v1/sales_invoices')) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([
            { id: 'inv-1', invoice_number: 'INV-2026-0101', sales_order_id: 'so-1', linked_challan_ids: ['dc-1'], status: 'unpaid', total_amount: 85000000, balance_amount: 85000000, customers: { company_name: 'PT Kalbe Farma Tbk' } },
          ]),
        });
      }

      if (url.includes('/rest/v1/sales_invoice_items')) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([
            { invoice_id: 'inv-1', delivery_challan_item_id: 'dci-1' }
          ]),
        });
      }

      if (url.includes('/rest/v1/delivery_challan_items')) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([
            { id: 'dci-1', challan_id: 'dc-1', product_id: 'prod-1', quantity: 450, products: { product_name: 'Paracetamol Micronized BP/USP' } },
            { id: 'dci-2', challan_id: 'dc-2', product_id: 'prod-2', quantity: 200, products: { product_name: 'Amoxicillin Trihydrate Compacted' } },
          ]),
        });
      }

      if (url.includes('/rest/v1/customers')) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(mockCustomers),
        });
      }

      if (url.includes('/rest/v1/batches')) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(mockBatches),
        });
      }

      if (url.includes('/rest/v1/suppliers')) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([
            { id: 'sup-1', company_name: 'PT Kimia Farma Trading & Distribution', country: 'Indonesia' },
            { id: 'sup-2', company_name: 'Jiangsu Huaxi Pharma Chem Ltd', country: 'China' },
          ]),
        });
      }

      // Default fallback for any other table/view: return empty array with 200 OK
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'content-range': '0-0/0' },
        body: JSON.stringify([]),
      });
    });
  };

  test('Purchase Invoices: Responsive App-Style Cards on Mobile & Sticky Table on Desktop', async ({ page }) => {
    test.setTimeout(90000);
    await setupAuth(page);

    // 1. Mobile (390x844)
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/finance/purchase', { waitUntil: 'networkidle' });

    // Wait for Suspense chunk to load
    await expect(page.locator('#username')).toBeHidden({ timeout: 15000 });

    // Target the visible mobile cards specifically
    const mobileCardsContainer = page.locator('div.block.md\\:hidden');
    await expect(mobileCardsContainer).toBeVisible({ timeout: 20000 });
    await expect(mobileCardsContainer.getByText('PI-2026-0089').first()).toBeVisible({ timeout: 15000 });

    // Verify desktop table is hidden
    const desktopTable = page.locator('div.hidden.md\\:block');
    await expect(desktopTable).toBeHidden();

    // Verify NO loading spinner is active
    await expect(page.locator('.animate-spin')).toHaveCount(0);

    // Measure horizontal overflow: must be <= 390
    const mobileOverflow = await page.evaluate(() => {
      return document.documentElement.scrollWidth <= window.innerWidth + 2;
    });
    expect(mobileOverflow).toBe(true);

    const mobile390Path = path.join(artifactDir, 'purchase-invoices-mobile-390x844.png');
    await page.screenshot({ path: mobile390Path });
    console.log('[E2E] Verified & Captured purchase-invoices-mobile-390x844.png');

    // 2. Small Mobile (360x800)
    await page.setViewportSize({ width: 360, height: 800 });
    await page.waitForTimeout(300);

    const smallMobileOverflow = await page.evaluate(() => {
      return document.documentElement.scrollWidth <= window.innerWidth + 2;
    });
    expect(smallMobileOverflow).toBe(true);

    const mobile360Path = path.join(artifactDir, 'purchase-invoices-small-mobile-360x800.png');
    await page.screenshot({ path: mobile360Path });
    console.log('[E2E] Verified & Captured purchase-invoices-small-mobile-360x800.png');

    // 3. Desktop (1440x900)
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(300);

    await expect(desktopTable).toBeVisible();
    await expect(mobileCardsContainer).toBeHidden();

    // Verify desktop sticky action column
    const desktopActionTh = page.locator('th:has-text("Actions")');
    await expect(desktopActionTh).toBeVisible();

    const desktopPath = path.join(artifactDir, 'purchase-invoices-desktop-1440x900.png');
    await page.screenshot({ path: desktopPath });
    console.log('[E2E] Verified & Captured purchase-invoices-desktop-1440x900.png');
  });

  test('Delivery Challan: App-Style Card View on Mobile & Standard Table on Desktop', async ({ page }) => {
    test.setTimeout(90000);
    await setupAuth(page);

    // 1. Mobile (390x844)
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/delivery-challan', { waitUntil: 'networkidle' });

    await expect(page.locator('#username')).toBeHidden({ timeout: 15000 });

    // Target the visible mobile cards specifically
    const mobileCardsContainer = page.locator('div.block.md\\:hidden');
    await expect(mobileCardsContainer).toBeVisible({ timeout: 20000 });
    await expect(mobileCardsContainer.getByText('DC-2026-0312').first()).toBeVisible({ timeout: 15000 });

    // Verify NO loading spinner is active
    await expect(page.locator('.animate-spin')).toHaveCount(0);

    // Verify Mobile Bottom Nav is visible
    const bottomNav = page.locator('nav[aria-label="Mobile Navigation"]');
    await expect(bottomNav).toBeVisible();

    // Measure horizontal overflow: must be <= 390
    const dcMobileOverflow = await page.evaluate(() => {
      return document.documentElement.scrollWidth <= window.innerWidth + 2;
    });
    expect(dcMobileOverflow).toBe(true);

    const dcMobilePath = path.join(artifactDir, 'delivery-challan-mobile-390x844.png');
    await page.screenshot({ path: dcMobilePath });
    console.log('[E2E] Verified & Captured delivery-challan-mobile-390x844.png');

    // 2. Desktop (1440x900)
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(300);

    const dcDesktopTable = page.locator('div.hidden.md\\:block');
    await expect(dcDesktopTable).toBeVisible();
    await expect(mobileCardsContainer).toBeHidden();

    const dcDesktopPath = path.join(artifactDir, 'delivery-challan-desktop-1440x900.png');
    await page.screenshot({ path: dcDesktopPath });
    console.log('[E2E] Verified & Captured delivery-challan-desktop-1440x900.png');
  });

  test('Products, Customers & Dashboard: Mobile App Layout & Verified Content', async ({ page }) => {
    test.setTimeout(90000);
    await setupAuth(page);

    // 1. Products on Mobile (390x844)
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/products', { waitUntil: 'networkidle' });

    const prodMobileCards = page.locator('div.block.md\\:hidden');
    await expect(prodMobileCards).toBeVisible({ timeout: 20000 });
    await expect(prodMobileCards.getByText('Paracetamol Micronized BP/USP').first()).toBeVisible({ timeout: 15000 });
    await expect(page.locator('.animate-spin')).toHaveCount(0);

    const productsMobileOverflow = await page.evaluate(() => {
      return document.documentElement.scrollWidth <= window.innerWidth + 2;
    });
    expect(productsMobileOverflow).toBe(true);

    const prodMobilePath = path.join(artifactDir, 'products-mobile-390x844.png');
    await page.screenshot({ path: prodMobilePath });
    console.log('[E2E] Verified & Captured products-mobile-390x844.png');

    // 2. Customers on Mobile (390x844)
    await page.goto('/customers', { waitUntil: 'networkidle' });

    const custMobileCards = page.locator('div.block.md\\:hidden');
    await expect(custMobileCards).toBeVisible({ timeout: 20000 });
    await expect(custMobileCards.getByText('PT Kalbe Farma Tbk').first()).toBeVisible({ timeout: 15000 });
    await expect(page.locator('.animate-spin')).toHaveCount(0);

    const custMobileOverflow = await page.evaluate(() => {
      return document.documentElement.scrollWidth <= window.innerWidth + 2;
    });
    expect(custMobileOverflow).toBe(true);

    const custMobilePath = path.join(artifactDir, 'customers-mobile-390x844.png');
    await page.screenshot({ path: custMobilePath });
    console.log('[E2E] Verified & Captured customers-mobile-390x844.png');

    // 3. Dashboard on Mobile (390x844)
    await page.goto('/dashboard', { waitUntil: 'networkidle' });
    await expect(page.locator('text=Welcome, Kunal Lunkad!').first()).toBeVisible({ timeout: 20000 });
    await expect(page.locator('.animate-spin')).toHaveCount(0);

    const dashMobileOverflow = await page.evaluate(() => {
      return document.documentElement.scrollWidth <= window.innerWidth + 2;
    });
    expect(dashMobileOverflow).toBe(true);

    const dashMobilePath = path.join(artifactDir, 'dashboard-mobile-390x844.png');
    await page.screenshot({ path: dashMobilePath });
    console.log('[E2E] Verified & Captured dashboard-mobile-390x844.png');
  });
});
