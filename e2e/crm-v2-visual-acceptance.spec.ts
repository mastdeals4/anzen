import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';

test.describe('SAPJ CRM 2.0 Visual Redesign & Multi-Viewport Acceptance Suite', () => {
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
        created_at: '2026-11-02T08:00:00Z',
        user_profiles: { full_name: 'Kunal Lunkad' },
      },
      {
        id: '22222222-2222-2222-2222-222222222222',
        inquiry_number: 'INQ-26-0356',
        inquiry_date: '2026-11-01',
        company_name: 'PT Dexa Medica',
        product_name: 'Pregabalin IP/USP',
        quantity: '1000 kg',
        supplier_name: 'Shubham Pharmachem Ltd',
        supplier_country: 'India',
        status: 'price_ready',
        pipeline_status: 'price_ready',
        priority: 'high',
        purchase_price: 48.0,
        purchase_price_currency: 'USD',
        offered_price: 850000,
        offered_price_currency: 'IDR',
        price_ready: true,
        kunal_price_status: 'price_received',
        created_at: '2026-11-01T09:00:00Z',
        user_profiles: { full_name: 'Kunal Lunkad' },
      },
    ];

    await page.route('**/rest/v1/crm_inquiries*', async (route: any) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockInquiries),
      });
    });

    const mockContacts = [
      {
        id: 'c1111111-1111-1111-1111-111111111111',
        company_name: 'PT Kalbe Farma Tbk',
        contact_person: 'Budi Santoso',
        designation: 'Head of Purchasing & API Sourcing',
        email: 'budi.santoso@kalbe.co.id; purchasing.api@kalbe.co.id',
        mobile: '+6281288889999',
        landline: '021-42873888',
        phone: '021-42873888',
        city: 'Jakarta Timur',
        country: 'Indonesia',
        address: 'Jl. Let. Jend. Suprapto Kav. 4, Cempaka Putih',
        website: 'https://kalbe.co.id',
        customer_type: 'Pharma Manufacturer',
        notes: 'Top tier B2B API account. Requires USP/BP grades with COA and Halal.',
        is_active: true,
        created_at: '2026-01-15T10:00:00Z',
      },
      {
        id: 'c2222222-2222-2222-2222-222222222222',
        company_name: 'PT Dexa Medica',
        contact_person: 'Dra. Maya Wijaya',
        designation: 'Procurement Specialist',
        email: 'maya.wijaya@dexa-medica.com',
        mobile: '+6285888600999',
        landline: '021-7451234',
        phone: '+6285888600999',
        city: 'Tangerang Selatan',
        country: 'Indonesia',
        address: 'Titan Center Lantai 3, Bintaro Jaya Sektor 7',
        website: 'https://dexa-medica.com',
        customer_type: 'Pharma Manufacturer',
        notes: 'Regular orders of Pregabalin and Metformin HCl.',
        is_active: true,
        created_at: '2026-02-10T11:00:00Z',
      },
      {
        id: 'c3333333-3333-3333-3333-333333333333',
        company_name: 'PT Kimia Farma Tbk',
        contact_person: 'Agus Setiawan',
        designation: 'Supply Chain Manager',
        email: 'agus.setiawan@kimiafarma.co.id',
        mobile: '+6281312345678',
        landline: '021-3847777',
        phone: '+6281312345678',
        city: 'Jakarta Pusat',
        country: 'Indonesia',
        address: 'Jl. Veteran No. 9',
        website: 'https://kimiafarma.co.id',
        customer_type: 'State-Owned Pharma',
        notes: 'Annual tender participant.',
        is_active: true,
        created_at: '2026-03-01T08:00:00Z',
      },
      {
        id: 'c4444444-4444-4444-4444-444444444444',
        company_name: 'PT Sanbe Farma',
        contact_person: 'Hendrawan S.',
        designation: 'Raw Material Buyer',
        email: 'hendrawan@sanbe-farma.com',
        mobile: '022-6011234',
        landline: '022-6011234',
        phone: '022-6011234',
        city: 'Bandung',
        country: 'Indonesia',
        address: 'Jl. Tamansari No. 10',
        website: 'https://sanbe-farma.com',
        customer_type: 'Pharma Manufacturer',
        notes: 'Landline number on file. Mobile verification required.',
        is_active: true,
        created_at: '2026-04-12T09:00:00Z',
      },
    ];

    await page.route('**/rest/v1/crm_contacts*', async (route: any) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockContacts),
      });
    });

    await page.route('**/rest/v1/customer_assignments*', async (route: any) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { crm_contact_id: mockContacts[0].id, sales_member_id: 'sm1', sales_team_members: { name: 'Kunal Lunkad' }, is_active: true },
          { crm_contact_id: mockContacts[1].id, sales_member_id: 'sm1', sales_team_members: { name: 'Kunal Lunkad' }, is_active: true },
        ]),
      });
    });

    await page.route('**/rest/v1/sales_team_members*', async (route: any) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { id: 'sm1', name: 'Kunal Lunkad', is_active: true },
          { id: 'sm2', name: 'Sarah S.', is_active: true },
        ]),
      });
    });

    const mockEmailInbox = [
      {
        id: 'e1111111-1111-1111-1111-111111111111',
        from_address: 'budi.santoso@kalbe.co.id',
        from_name: 'Budi Santoso',
        subject: 'Permintaan Penawaran Harga Paracetamol Micronized USP 5000 kg',
        snippet: 'Dear Kunal, Mohon info ketersediaan stok ready dan penawaran harga untuk Paracetamol Micronized USP 5000 kg gudang Jakarta...',
        body_text: 'Dear Kunal / Tim SAPJ,\n\nMohon info ketersediaan stok ready dan penawaran harga resmi untuk Paracetamol Micronized USP sejumlah 5000 kg franco gudang Cikarang.\n\nLampirkan COA terbaru dan sertifikat Halal.\n\nSalam,\nBudi Santoso\nPT Kalbe Farma Tbk',
        date: '2026-11-02T07:30:00Z',
        channel: 'email',
        mailbox_account: 'sales@avira.co.id',
        is_inquiry: true,
        converted_to_inquiry: '11111111-1111-1111-1111-111111111111',
        created_at: '2026-11-02T07:30:00Z',
      },
      {
        id: 'w1111111-1111-1111-1111-111111111111',
        from_address: '+6285888600999',
        from_name: 'Dra. Maya Wijaya',
        subject: 'WhatsApp Inquiry: Pregabalin IP Ready Stock',
        snippet: 'Halo Pak Kunal, apakah Pregabalin IP ready di gudang Sunter? Kami butuh 1000 kg untuk produksi batch November...',
        body_text: 'Halo Pak Kunal, apakah Pregabalin IP ready di gudang Sunter? Kami butuh 1000 kg untuk produksi batch November. Mohon penawaran harga dan kirim COA ya.',
        date: '2026-11-02T09:15:00Z',
        channel: 'whatsapp',
        mailbox_account: '+6285888600999',
        is_inquiry: true,
        converted_to_inquiry: '22222222-2222-2222-2222-222222222222',
        created_at: '2026-11-02T09:15:00Z',
      },
    ];

    await page.route('**/rest/v1/crm_email_inbox*', async (route: any) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockEmailInbox),
      });
    });

    await page.route('**/rest/v1/enquiry_conversations*', async (route: any) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            id: '77777777-7777-7777-7777-777777777777',
            channel: 'whatsapp',
            title: 'PT Kalbe Farma - Paracetamol Inquiry',
            customer_id: 'c1111111-1111-1111-1111-111111111111',
            last_message_at: new Date().toISOString(),
            status: 'active',
            metadata: {
              language: 'id',
              intent: 'Price Inquiry',
              latest_summary: 'Customer requesting ready stock quotation for 5 MT Paracetamol IP Jakarta warehouse.',
              needs_action: true,
            },
            customers: { id: 'c1111111-1111-1111-1111-111111111111', company_name: 'PT Kalbe Farma Tbk' },
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
                sender_address: '+6281288889999',
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

    await page.route('**/rest/v1/enquiry_conversation_messages*', async (route: any) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            id: '88888888-8888-8888-8888-888888888888',
            conversation_id: '77777777-7777-7777-7777-777777777777',
            sender_name: 'Budi Santoso',
            sender_address: '+6281288889999',
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

    const mockDocuments = [
      {
        id: 'doc1',
        product_name: 'Paracetamol IP/BP (Micronized)',
        make: 'Anupam Rasayan India Ltd',
        specification: 'USP',
        document_type: 'COA',
        original_file_name: 'COA_Paracetamol_Micronized_Batch_2026.pdf',
        display_file_name: 'COA_Paracetamol_Micronized_Batch_2026.pdf',
        storage_path: 'crm-documents/COA_Paracetamol_2026.pdf',
        is_permanent: true,
        created_at: '2026-11-02T08:00:00Z',
        crm_inquiries: [{ inquiry_number: 'INQ-26-0357' }],
      },
      {
        id: 'doc2',
        product_name: 'Pregabalin IP/USP',
        make: 'Shubham Pharmachem Ltd',
        specification: 'IP',
        document_type: 'HALAL',
        original_file_name: 'Halal_Certificate_Pregabalin_2026.pdf',
        display_file_name: 'Halal_Certificate_Pregabalin_2026.pdf',
        storage_path: 'crm-documents/Halal_Pregabalin_2026.pdf',
        is_permanent: true,
        created_at: '2026-11-01T09:00:00Z',
        crm_inquiries: [{ inquiry_number: 'INQ-26-0356' }],
      },
      {
        id: 'doc3',
        product_name: 'Metformin HCl',
        make: 'Wanbury India',
        specification: 'EP',
        document_type: 'GMP',
        original_file_name: 'EU_GMP_Certificate_Wanbury.pdf',
        display_file_name: 'EU_GMP_Certificate_Wanbury.pdf',
        storage_path: 'crm-documents/GMP_Wanbury.pdf',
        is_permanent: true,
        created_at: '2026-10-25T11:00:00Z',
        crm_inquiries: [],
      },
    ];

    await page.route('**/rest/v1/crm_product_documents*', async (route: any) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockDocuments),
      });
    });

    await page.route('**/api/whatsapp/api/status*', async (route: any) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'connected',
          session: 'sapj-business-whatsapp',
          businessPhone: '+6285888600999',
          lastSeen: new Date().toISOString(),
          webhookConfigured: true,
        }),
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

  // Viewports to test
  const viewports = [
    { name: '1440', width: 1440, height: 900, label: 'Desktop (1440x900)' },
    { name: '1280', width: 1280, height: 800, label: 'Laptop (1280x800)' },
  ];

  for (const vp of viewports) {
    test(`Visual Verification & Screenshots at ${vp.label}`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await loginDirectly(page);

      // ==========================================
      // 1. CUSTOMERS VIEW (High-Density Spreadsheet)
      // ==========================================
      await page.goto('/crm/customers');
      await page.waitForLoadState('networkidle');

      // Verify Customers nav button
      await expect(page.getByRole('button', { name: 'CUSTOMERS', exact: true })).toBeVisible({ timeout: 10000 });

      // Verify table rendered with customer records
      await expect(page.locator('table').getByText('PT Kalbe Farma Tbk').last()).toBeVisible({ timeout: 10000 });

      // Verify frozen company column is sticky
      const companyCell = page.locator('td.sticky').getByText('PT Kalbe Farma Tbk').first();
      await expect(companyCell).toBeVisible();

      // Verify salesperson badge in table
      await expect(page.locator('table').getByText('Kunal Lunkad').first()).toBeVisible();

      // Capture full-page screenshot
      await page.screenshot({
        path: path.join(artifactDir, `crm-v2-customers-${vp.name}.png`),
        fullPage: true,
      });
      console.log(`[E2E] Captured Customers View at ${vp.width}x${vp.height}`);

      // ==========================================
      // 2. CAMPAIGNS VIEW (Command Center & WhatsApp Builder)
      // ==========================================
      await page.goto('/crm/campaigns?subtab=whatsapp');
      await page.waitForLoadState('networkidle');

      // Verify Phone Audit & Safeguards
      await expect(page.getByText(/Contact Phone Verification & WhatsApp Audit/i)).toBeVisible({ timeout: 10000 });
      await expect(page.getByText('WA Eligible')).toBeVisible();
      await expect(page.getByText('Landlines')).toBeVisible();

      // Verify WhatsApp Business Composer & Preview
      await expect(page.getByText('WhatsApp Business Composer')).toBeVisible();
      await expect(page.getByText('Delivery Safeguards & Anti-Ban Controls')).toBeVisible();
      await expect(page.getByText('Live Customer Preview')).toBeVisible();

      // Capture full-page screenshot
      await page.screenshot({
        path: path.join(artifactDir, `crm-v2-campaigns-${vp.name}.png`),
        fullPage: true,
      });
      console.log(`[E2E] Captured Campaigns View at ${vp.width}x${vp.height}`);

      // ==========================================
      // 3. UNIFIED INBOX VIEW (3-Column Workspace)
      // ==========================================
      await page.goto('/crm/inbox');
      await page.waitForLoadState('networkidle');

      // Verify Inbox tab
      await expect(page.getByRole('button', { name: 'INBOX', exact: true })).toBeVisible({ timeout: 10000 });

      // Click on conversation to open thread & Customer 360
      const convoItem = page.getByText('PT Kalbe Farma - Paracetamol Inquiry').first();
      await expect(convoItem).toBeVisible({ timeout: 10000 });
      await convoItem.click();

      // Verify Column 2 & Column 3
      await expect(page.getByText('Customer 360')).toBeVisible();

      // Capture full-page screenshot
      await page.screenshot({
        path: path.join(artifactDir, `crm-v2-inbox-${vp.name}.png`),
        fullPage: true,
      });
      console.log(`[E2E] Captured Inbox View at ${vp.width}x${vp.height}`);

      // ==========================================
      // 4. INQUIRIES VIEW (High-Density Operational Hub)
      // ==========================================
      await page.goto('/crm/inquiries');
      await page.waitForLoadState('networkidle');

      // Verify Inquiries KPI cards
      await expect(page.getByText('All Inquiries')).toBeVisible({ timeout: 10000 });
      await expect(page.getByText('Active Inquiries')).toBeVisible();

      // Verify Inquiry records rendered
      await expect(page.getByText('INQ-26-0357').first()).toBeVisible({ timeout: 10000 });

      // Capture full-page screenshot
      await page.screenshot({
        path: path.join(artifactDir, `crm-v2-inquiries-${vp.name}.png`),
        fullPage: true,
      });
      console.log(`[E2E] Captured Inquiries View at ${vp.width}x${vp.height}`);

      // ==========================================
      // 5. DOCUMENT BANK VIEW (Certificate Repository)
      // ==========================================
      await page.goto('/crm/documents');
      await page.waitForLoadState('networkidle');

      // Verify Document Bank
      await expect(page.getByRole('button', { name: 'DOCUMENT BANK', exact: true })).toBeVisible({ timeout: 10000 });
      await expect(page.getByText(/CRM Document Bank/i)).toBeVisible({ timeout: 10000 });

      // Verify document records
      await expect(page.getByText('Paracetamol IP/BP (Micronized)').first()).toBeVisible({ timeout: 10000 });

      // Capture full-page screenshot
      await page.screenshot({
        path: path.join(artifactDir, `crm-v2-documents-${vp.name}.png`),
        fullPage: true,
      });
      console.log(`[E2E] Captured Document Bank View at ${vp.width}x${vp.height}`);
    });
  }
});

