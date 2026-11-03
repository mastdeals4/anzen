import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';

test.describe('SAPJ ERP CRM Redesign & 4-Destination Navigation Suite', () => {
  let anonKey = '';
  const artifactDir = '/Users/Kunal/.gemini/antigravity/brain/ba0a5665-f6f0-4bb7-bcd8-a665594273a2';

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
      const accept = route.request().headers()['accept'] || '';
      const profile = {
        id: mockUser.id,
        role: 'admin',
        full_name: 'Kunal Lunkad',
        is_active: true,
      };
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(accept.includes('vnd.pgrst.object+json') ? profile : [profile]),
      });
    });

    await page.route('**/rest/v1/user_permissions*', async (route: any) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{ module: 'crm', can_access: true }]),
      });
    });

    const mockInquiries = [
      {
        id: '11111111-1111-1111-1111-111111111111',
        inquiry_number: 'INQ-26-0357',
        inquiry_date: '2026-11-02',
        company_name: 'PT Kalbe Farma Tbk',
        product_name: 'Paracetamol IP/BP (Micronized)',
        quantity: '5000 kg',
        supplier_name: 'Anupam Rasayan India Ltd',
        supplier_country: 'India',
        status: 'quoted',
        pipeline_status: 'quoted',
        priority: 'urgent',
        purchase_price: 3.85,
        purchase_price_currency: 'USD',
        offered_price: 68000,
        offered_price_currency: 'IDR',
        quote_sent_at: '2026-11-02T10:00:00Z',
        next_follow_up: '2026-11-04',
        created_at: '2026-11-02T08:00:00Z',
        user_profiles: { full_name: 'Kunal Lunkad' },
      },
      {
        id: '22222222-2222-2222-2222-222222222222',
        inquiry_number: 'INQ-26-0356',
        inquiry_date: '2026-11-01',
        company_name: 'PT Kimia Farma Tbk',
        product_name: 'Amoxicillin Trihydrate Compacted',
        quantity: '2000 kg',
        supplier_name: 'Aurobindo Pharma',
        supplier_country: 'India',
        status: 'price_ready',
        pipeline_status: 'price_ready',
        priority: 'high',
        purchase_price: 24.5,
        purchase_price_currency: 'USD',
        price_ready: true,
        created_at: '2026-11-01T09:00:00Z',
        user_profiles: { full_name: 'Kunal Lunkad' },
      },
      {
        id: '33333333-3333-3333-3333-333333333333',
        inquiry_number: 'INQ-26-0355',
        inquiry_date: '2026-10-30',
        company_name: 'PT Darya-Varia Laboratoria',
        product_name: 'Metformin HCl USP',
        quantity: '10000 kg',
        status: 'sourcing',
        pipeline_status: 'sourcing',
        source_status: 'waiting_supplier',
        priority: 'medium',
        created_at: '2026-10-30T11:00:00Z',
        user_profiles: { full_name: 'Sales Team' },
      },
      {
        id: '44444444-4444-4444-4444-444444444444',
        inquiry_number: 'INQ-26-0001',
        inquiry_date: '2026-05-10',
        company_name: 'PT Dexa Medica',
        product_name: 'Ibuprofen DC 85%',
        quantity: '3000 kg',
        supplier_name: 'IOL Chemicals',
        status: 'closed',
        pipeline_status: 'won',
        priority: 'normal',
        purchase_price: 12.0,
        offered_price: 215000,
        created_at: '2026-05-10T12:00:00Z',
        user_profiles: { full_name: 'Kunal Lunkad' },
      },
    ];

    // Mock crm_inquiries with realistic sample dataset across stages
    await page.route('**/rest/v1/crm_inquiries*', async (route: any) => {
      if (route.request().method() === 'GET') {
        const accept = route.request().headers()['accept'] || '';
        const url = route.request().url();
        if (accept.includes('vnd.pgrst.object+json') || url.includes('id=eq.')) {
          const match = mockInquiries.find((i) => url.includes(i.id)) || mockInquiries[0];
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(match),
          });
        } else {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(mockInquiries),
          });
        }
      } else {
        await route.continue();
      }
    });

    const mockContacts = [
      {
        id: '55555555-5555-5555-5555-555555555555',
        company_name: 'PT Kalbe Farma Tbk',
        contact_person: 'Budi Santoso',
        email: 'budi@kalbe.co.id',
        phone: '+62811888999',
        mobile: '+62811888999',
        city: 'Jakarta',
        customer_type: 'Pharma Manufacturer',
        is_active: true,
      },
      {
        id: '66666666-6666-6666-6666-666666666666',
        company_name: 'PT Kimia Farma Tbk',
        contact_person: 'Siti Rahma',
        email: 'siti@kimiafarma.co.id',
        phone: '+62812999888',
        mobile: '+62812999888',
        city: 'Bandung',
        customer_type: 'State Enterprise Pharma',
        is_active: true,
      },
    ];

    // Mock CRM contacts
    await page.route('**/rest/v1/crm_contacts*', async (route: any) => {
      const accept = route.request().headers()['accept'] || '';
      const url = route.request().url();
      if (accept.includes('vnd.pgrst.object+json') || url.includes('id=eq.')) {
        const match = mockContacts.find((c) => url.includes(c.id)) || mockContacts[0];
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(match),
        });
      } else {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(mockContacts),
        });
      }
    });

    // Mock enquiry_conversations
    await page.route('**/rest/v1/enquiry_conversations*', async (route: any) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            id: '77777777-7777-7777-7777-777777777777',
            channel: 'whatsapp',
            title: 'PT Kalbe Farma - Paracetamol Inquiry',
            customer_id: '55555555-5555-5555-5555-555555555555',
            last_message_at: new Date().toISOString(),
            status: 'active',
            metadata: {
              language: 'id',
              intent: 'Price Inquiry',
              latest_summary: 'Customer requesting ready stock quotation for 5 MT Paracetamol IP Jakarta warehouse.',
              needs_action: true,
            },
            customers: { id: '55555555-5555-5555-5555-555555555555', company_name: 'PT Kalbe Farma Tbk' },
            enquiry_conversation_links: [
              {
                inquiry_id: '11111111-1111-1111-1111-111111111111',
                is_active: true,
                crm_inquiries: {
                  id: '11111111-1111-1111-1111-111111111111',
                  inquiry_number: 'INQ-26-0357',
                  product_name: 'Paracetamol IP/BP (Micronized)',
                  company_name: 'PT Kalbe Farma Tbk',
                },
              },
            ],
            enquiry_conversation_messages: [
              {
                id: '88888888-8888-8888-8888-888888888888',
                conversation_id: '77777777-7777-7777-7777-777777777777',
                sender_name: 'Budi Santoso',
                sender_address: '+62811888999',
                body_text: 'Selamat pagi Pak Kunal, apakah ready stock Paracetamol IP di gudang Jakarta ada 5 MT? Mohon info penawaran harga dan COA batch terbaru.',
                direction: 'inbound',
                received_or_sent_at: new Date().toISOString(),
                ai_proposal: {
                  language: 'id',
                  english_translation: 'Good morning Mr. Kunal, is there 5 MT ready stock of Paracetamol IP at Jakarta warehouse? Please provide price offer and latest batch COA.',
                  intent: 'Price Inquiry',
                  entities: { product: 'Paracetamol IP', quantity: '5 MT' },
                  needs_action: true,
                  running_summary: 'Customer requesting ready stock quotation for 5 MT Paracetamol IP Jakarta warehouse.',
                },
              },
            ],
          },
        ]),
      });
    });

    // Mock enquiry_conversation_messages
    await page.route('**/rest/v1/enquiry_conversation_messages*', async (route: any) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            id: '88888888-8888-8888-8888-888888888888',
            conversation_id: '77777777-7777-7777-7777-777777777777',
            sender_name: 'Budi Santoso',
            sender_address: '+62811888999',
            body_text: 'Selamat pagi Pak Kunal, apakah ready stock Paracetamol IP di gudang Jakarta ada 5 MT? Mohon info penawaran harga dan COA batch terbaru.',
            direction: 'inbound',
            received_or_sent_at: new Date().toISOString(),
            ai_proposal: {
              language: 'id',
              english_translation: 'Good morning Mr. Kunal, is there 5 MT ready stock of Paracetamol IP at Jakarta warehouse? Please provide price offer and latest batch COA.',
              intent: 'Price Inquiry',
              entities: { product: 'Paracetamol IP', quantity: '5 MT' },
              needs_action: true,
              running_summary: 'Customer requesting ready stock quotation for 5 MT Paracetamol IP Jakarta warehouse.',
            },
          },
        ]),
      });
    });
  };

  const loginDirectly = async (page: any) => {
    await setupAuth(page);
    await page.goto('/');
    await page.locator('#username').fill('kunal');
    await page.locator('#password').fill('secret');
    await page.locator('button[type="submit"]').click();
    await expect(page.locator('#username')).toBeHidden({ timeout: 15000 });
  };

  test('1. Verify 5-destination consolidated top navigation bar', async ({ page }) => {
    await loginDirectly(page);
    await page.goto('/crm');

    // Verify 5 navigation tabs
    await expect(page.getByRole('button', { name: 'INBOX', exact: true })).toBeVisible({ timeout: 10000 });
    await expect(page.getByRole('button', { name: 'INQUIRIES', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /CAMPAIGNS|BULK EMAIL/i }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'CUSTOMERS', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'DOCUMENT BANK', exact: true })).toBeVisible();

    // Verify removed standalone tabs are not in primary nav
    await expect(page.getByRole('button', { name: 'CONTROL CENTER', exact: true })).not.toBeVisible();
  });

  test('2. Verify Inquiries Workspace with KPI metric cards and zero cutoff filter', async ({ page }) => {
    await loginDirectly(page);
    await page.goto('/crm/inquiries');

    // Verify Inquiries tab is active
    const inqTab = page.getByRole('button', { name: 'INQUIRIES', exact: true });
    await expect(inqTab).toBeVisible({ timeout: 10000 });

    // Verify KPI filter cards render
    await expect(page.getByText('All Inquiries')).toBeVisible({ timeout: 10000 });
    await expect(page.getByText('Active Inquiries')).toBeVisible();
    await expect(page.getByText(/Needs Attention/i).first()).toBeVisible();
    await expect(page.getByText(/Waiting India/i).first()).toBeVisible();
    await expect(page.getByText(/Waiting Customer/i).first()).toBeVisible();
    await expect(page.getByText(/Price Ready/i).first()).toBeVisible();

    // Verify Inquiries are displayed in table (not 0 records)
    await expect(page.getByText('INQ-26-0357')).toBeVisible();
    await expect(page.getByText('PT Kalbe Farma Tbk').first()).toBeVisible();
    await expect(page.getByText('Paracetamol IP/BP (Micronized)').first()).toBeVisible();

    // Take screenshot of Inquiries workspace
    await page.screenshot({ path: path.join(artifactDir, 'crm-inquiries-redesign.png') });
  });

  test('3. Verify Unified Inbox 3-Column Workspace', async ({ page, isMobile }) => {
    await loginDirectly(page);
    await page.goto('/crm/inbox');

    // Switch to INBOX destination
    const inboxTab = page.getByRole('button', { name: 'INBOX', exact: true });
    await expect(inboxTab).toBeVisible({ timeout: 10000 });

    // Wait for conversation list
    await expect(page.getByText('PT Kalbe Farma - Paracetamol Inquiry').first()).toBeVisible({ timeout: 10000 });

    // Verify Column 2: Thread Header & AI Intelligence Pill
    await expect(page.getByText(/AI Intelligence/i)).toBeVisible();
    await expect(page.getByText(/Customer requesting ready stock quotation/i).first()).toBeVisible();

    // Verify Column 3: Customer 360 & Linked Sourcing Inquiry (on desktop/laptop viewports)
    if (!isMobile) {
      await expect(page.getByText('Customer 360')).toBeVisible();
      await expect(page.getByText('Linked Sourcing Inquiry')).toBeVisible();
      await expect(page.getByText('Follow-up Tracker')).toBeVisible();
    }

    // Take screenshot of 3-column unified inbox
    await page.screenshot({ path: path.join(artifactDir, 'crm-inbox-3column.png') });
  });

  test('4. Verify Campaigns Workspace with WhatsApp Campaign Builder & Phone Audit', async ({ page }) => {
    await loginDirectly(page);
    await page.goto('/crm/campaigns');

    // Switch to WhatsApp sub-tab
    const waSubTab = page.getByRole('button', { name: /WHATSAPP CAMPAIGN/i });
    await expect(waSubTab).toBeVisible({ timeout: 10000 });
    await waSubTab.click();

    // Verify Phone Audit & Verification Bar
    await expect(page.getByText(/Contact Phone Verification & WhatsApp Audit/i)).toBeVisible({ timeout: 10000 });
    await expect(page.getByText('WA Eligible')).toBeVisible();
    await expect(page.getByText('Landlines')).toBeVisible();

    // Verify WhatsApp builder controls
    await expect(page.getByText('WhatsApp Business Composer')).toBeVisible();
    await expect(page.getByText('Delivery Safeguards & Anti-Ban Controls')).toBeVisible();
    await expect(page.getByText('Live Customer Preview')).toBeVisible();

    // Take screenshot of Campaigns workspace
    await page.screenshot({ path: path.join(artifactDir, 'crm-campaigns-builder.png') });
  });

  test('5. Verify Customers Workspace & Spreadsheet Database View', async ({ page }) => {
    await loginDirectly(page);
    await page.goto('/crm/customers');

    // Verify Customers tab is active
    await expect(page.getByRole('button', { name: 'CUSTOMERS', exact: true })).toBeVisible({ timeout: 10000 });

    // Switch to Excel Spreadsheet View
    const excelViewBtn = page.getByTitle('Excel Spreadsheet View');
    if (await excelViewBtn.isVisible()) {
      await excelViewBtn.click();
    }

    // Verify company names & contact details render in table
    await expect(page.locator('table').getByText('PT Kalbe Farma Tbk').last()).toBeVisible({ timeout: 10000 });

    // Take screenshot of Customers workspace
    await page.screenshot({ path: path.join(artifactDir, 'crm-customers-database.png') });
  });

  test('6. Verify Standalone Document Bank Destination', async ({ page }) => {
    await loginDirectly(page);
    await page.goto('/crm/documents');

    // Verify Document Bank tab is active
    await expect(page.getByRole('button', { name: 'DOCUMENT BANK', exact: true })).toBeVisible({ timeout: 10000 });

    // Verify Document Bank filters and table render
    await expect(page.getByText(/Document Type/i).first()).toBeVisible({ timeout: 10000 });

    // Take screenshot of Document Bank destination
    await page.screenshot({ path: path.join(artifactDir, 'crm-document-bank.png') });
  });

  test('7. Verify WhatsApp Settings & Protected Pairing Modal', async ({ page }) => {
    // Mock WhatsApp adapter status as unpaired with authentic QR
    const samplePath = path.join(artifactDir, 'live-pairing-qr.png');
    let qrDataUrl = '';
    if (fs.existsSync(samplePath)) {
      qrDataUrl = `data:image/png;base64,${fs.readFileSync(samplePath).toString('base64')}`;
    }

    await page.route('**/api/whatsapp/api/status*', async (route: any) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'unpaired',
          session: 'sapj-business-whatsapp',
          businessPhone: '+628119999999',
          qrCode: qrDataUrl,
        }),
      });
    });

    await loginDirectly(page);
    await page.goto('/crm');

    // Open Settings / Integration Health modal (gear/slider icon)
    const settingsBtn = page.getByTitle(/Integration Health & Settings/i);
    await expect(settingsBtn).toBeVisible({ timeout: 10000 });
    await settingsBtn.click();

    // Verify Settings Modal title and unpaired QR instructions
    await expect(page.getByText(/CRM Settings & Integration Health/i)).toBeVisible({ timeout: 10000 });
    await expect(page.getByText(/Scan QR Code to Authenticate SAPJ WhatsApp Business/i)).toBeVisible({ timeout: 10000 });

    // Verify enlarged QR image in settings card
    const qrImg = page.locator('img[alt="WhatsApp Business QR Code"]');
    await expect(qrImg).toBeVisible({ timeout: 5000 });
    const qrBox = await qrImg.boundingBox();
    console.log(`[E2E] In-App QR Dimensions: ${Math.round(qrBox?.width || 0)}px x ${Math.round(qrBox?.height || 0)}px`);
    expect(qrBox?.width).toBeGreaterThanOrEqual(280);

    // Take screenshot of protected settings & pairing card
    await page.screenshot({ path: path.join(artifactDir, 'crm-whatsapp-settings.png') });

    // Test Enlarge QR button & high-contrast modal
    const enlargeBtn = page.getByRole('button', { name: /Enlarge QR/i }).first();
    await expect(enlargeBtn).toBeVisible();
    await enlargeBtn.click();

    // Verify modal overlay opens
    await expect(page.getByText(/High-Contrast Pairing Mode/i)).toBeVisible({ timeout: 5000 });
    const modalQrImg = page.locator('img[alt="WhatsApp QR Enlarged"]');
    await expect(modalQrImg).toBeVisible();
    const modalBox = await modalQrImg.boundingBox();
    console.log(`[E2E] In-App Modal Enlarged QR Dimensions: ${Math.round(modalBox?.width || 0)}px x ${Math.round(modalBox?.height || 0)}px`);
    const isMobile = (page.viewportSize()?.width || 1000) < 600;
    if (!isMobile) {
      expect(modalBox?.width).toBeGreaterThanOrEqual(360);
    } else {
      expect(modalBox?.width).toBeGreaterThanOrEqual(240);
    }

    // Take screenshot of in-app enlarged modal
    await page.screenshot({ path: path.join(artifactDir, 'crm-settings-qr-modal.png') });
  });
});

