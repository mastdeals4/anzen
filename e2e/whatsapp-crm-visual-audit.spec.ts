import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';

test.describe('SAPJ WhatsApp Smart CRM Visual & Responsiveness Acceptance Audit', () => {
  let anonKey = '';
  const artifactDir = '/Users/Kunal/.gemini/antigravity/brain/ba0a5665-f6f0-4bb7-bcd8-a665594273a2';

  test.beforeAll(() => {
    const envFile = fs.readFileSync('.env', 'utf8');
    const anonKeyMatch = envFile.match(/VITE_SUPABASE_ANON_KEY=(.*)/);
    anonKey = anonKeyMatch ? anonKeyMatch[1].trim() : '';
  });

  const setupAuthAndMocks = async (page: any) => {
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

    const mockCustomers = [
      {
        id: 'c-kalbe',
        company_name: 'PT Kalbe Farma Tbk',
        contact_person: 'Budi Santoso',
        phone: '+6281288889999',
        email: 'budi.santoso@kalbe.co.id',
      },
      {
        id: 'c-bianglala',
        company_name: 'CV BIANGLALA BANDUNG',
        contact_person: 'Rina Wijaya',
        phone: '+6282118111128',
        email: 'purchasing@bianglala.co.id',
      },
      {
        id: 'c-biofarma',
        company_name: 'PT Bio Farma',
        contact_person: 'Ahmad Subagyo',
        phone: '022 123 4567',
        email: 'sourcing@biofarma.co.id',
      },
      {
        id: 'c-wanbury',
        company_name: 'Wanbury Ltd India',
        contact_person: 'Rajesh Sharma',
        phone: '+91 98201 12345',
        email: 'exports@wanbury.com',
      },
      {
        id: 'c-astrazeneca',
        company_name: 'AstraZeneca UK',
        contact_person: 'David Smith',
        phone: '+44 20 7946 0958',
        email: 'dsmith@astrazeneca.co.uk',
      },
      {
        id: 'c-hanmi',
        company_name: 'Hanmi Pharma Korea',
        contact_person: 'Min-jun Kim',
        phone: '+82 10 1234 5678',
        email: 'mjkim@hanmi.co.kr',
      },
      {
        id: 'c-kimiafarma',
        company_name: 'PT Kimia Farma',
        contact_person: 'Dewi Lestari',
        phone: '+021 5678 1234',
        email: 'dewi@kimiafarma.co.id',
      },
    ];

    await page.route('**/rest/v1/customers*', async (route: any) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockCustomers),
      });
    });

    const mockContacts = [
      {
        id: 'c-kalbe',
        company_name: 'PT Kalbe Farma Tbk',
        contact_person: 'Budi Santoso',
        designation: 'Procurement Specialist',
        email: 'budi.santoso@kalbe.co.id',
        mobile: '+6281288889999',
        phone: '021 5678 1234',
        city: 'Jakarta Timur',
        customer_type: 'Pharma Manufacturer',
        is_active: true,
        created_at: '2026-01-15T10:00:00Z',
      },
      {
        id: 'c-bianglala',
        company_name: 'CV BIANGLALA BANDUNG',
        contact_person: 'Rina Wijaya',
        designation: 'Purchasing Manager',
        email: 'purchasing@bianglala.co.id',
        mobile: '+6282118111128',
        phone: '+6282118111128',
        city: 'Bandung',
        customer_type: 'Distributor',
        is_active: true,
        created_at: '2026-02-10T10:00:00Z',
      },
      {
        id: 'c-biofarma',
        company_name: 'PT Bio Farma',
        contact_person: 'Ahmad Subagyo',
        designation: 'Raw Materials Sourcing',
        email: 'sourcing@biofarma.co.id',
        mobile: null,
        phone: '022 123 4567',
        city: 'Bandung',
        customer_type: 'State Enterprise',
        is_active: true,
        created_at: '2026-02-12T10:00:00Z',
      },
      {
        id: 'c-wanbury',
        company_name: 'Wanbury Ltd India',
        contact_person: 'Rajesh Sharma',
        designation: 'Export Director',
        email: 'exports@wanbury.com',
        mobile: '+91 98201 12345',
        phone: '+91 98201 12345',
        city: 'Mumbai',
        customer_type: 'Supplier / Partner',
        is_active: true,
        created_at: '2026-03-01T10:00:00Z',
      },
      {
        id: 'c-astrazeneca',
        company_name: 'AstraZeneca UK',
        contact_person: 'David Smith',
        designation: 'Supply Chain Lead',
        email: 'dsmith@astrazeneca.co.uk',
        mobile: null,
        phone: '+44 20 7946 0958',
        city: 'London',
        customer_type: 'Global Pharma',
        is_active: true,
        created_at: '2026-03-05T10:00:00Z',
      },
      {
        id: 'c-hanmi',
        company_name: 'Hanmi Pharma Korea',
        contact_person: 'Min-jun Kim',
        designation: 'APAC Business Development',
        email: 'mjkim@hanmi.co.kr',
        mobile: '+82 10 1234 5678',
        phone: '+82 10 1234 5678',
        city: 'Seoul',
        customer_type: 'Global Pharma',
        is_active: true,
        created_at: '2026-03-10T10:00:00Z',
      },
      {
        id: 'c-kimiafarma',
        company_name: 'PT Kimia Farma',
        contact_person: 'Dewi Lestari',
        designation: 'Procurement Officer',
        email: 'dewi@kimiafarma.co.id',
        mobile: null,
        phone: '+021 5678 1234',
        city: 'Jakarta Pusat',
        customer_type: 'Pharma Manufacturer',
        is_active: true,
        created_at: '2026-03-15T10:00:00Z',
      },
    ];

    await page.route('**/rest/v1/crm_contacts*', async (route: any) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockContacts),
      });
    });

    await page.route('**/rest/v1/crm_contact_phones*', async (route: any) => {
      const phones = [
        {
          id: 'phone-kalbe-mobile',
          contact_id: 'c-kalbe',
          company_name: 'PT Kalbe Farma Tbk',
          contact_person: 'Budi Santoso',
          department: 'Purchasing',
          raw_phone: '081288889999',
          normalized_phone: '+6281288889999',
          phone_type: 'valid_mobile',
          country_code: '+62',
          country_name: 'Indonesia',
          is_whatsapp_eligible: true,
          is_primary: true,
          crm_contacts: mockContacts[0],
        },
        {
          id: 'phone-kalbe-landline',
          contact_id: 'c-kalbe',
          company_name: 'PT Kalbe Farma Tbk',
          contact_person: 'Budi Santoso',
          department: 'Purchasing',
          raw_phone: '021 5678 1234',
          normalized_phone: '+622156781234',
          phone_type: 'landline',
          country_code: '+62',
          country_name: 'Indonesia',
          is_whatsapp_eligible: false,
          is_primary: false,
          notes: 'Indonesian landline (021)',
          crm_contacts: mockContacts[0],
        },
        {
          id: 'phone-bianglala',
          contact_id: 'c-bianglala',
          company_name: 'CV BIANGLALA BANDUNG',
          contact_person: 'Rina Wijaya',
          department: 'Purchasing',
          raw_phone: '+6282118111128',
          normalized_phone: '+6282118111128',
          phone_type: 'valid_mobile',
          country_code: '+62',
          country_name: 'Indonesia',
          is_whatsapp_eligible: true,
          is_primary: true,
          crm_contacts: mockContacts[1],
        },
        {
          id: 'phone-biofarma',
          contact_id: 'c-biofarma',
          company_name: 'PT Bio Farma',
          contact_person: 'Ahmad Subagyo',
          department: 'Procurement',
          raw_phone: '022 123 4567',
          normalized_phone: '+62221234567',
          phone_type: 'landline',
          country_code: '+62',
          country_name: 'Indonesia',
          is_whatsapp_eligible: false,
          is_primary: true,
          notes: 'Indonesian landline (022)',
          crm_contacts: mockContacts[2],
        },
        {
          id: 'phone-wanbury',
          contact_id: 'c-wanbury',
          company_name: 'Wanbury Ltd India',
          contact_person: 'Rajesh Sharma',
          department: 'Export',
          raw_phone: '+91 98201 12345',
          normalized_phone: '+919820112345',
          phone_type: 'valid_mobile',
          country_code: '+91',
          country_name: 'India',
          is_whatsapp_eligible: true,
          is_primary: true,
          crm_contacts: mockContacts[3],
        },
        {
          id: 'phone-astrazeneca',
          contact_id: 'c-astrazeneca',
          company_name: 'AstraZeneca UK',
          contact_person: 'David Smith',
          department: 'Supply Chain',
          raw_phone: '+44 20 7946 0958',
          normalized_phone: '+442079460958',
          phone_type: 'landline',
          country_code: '+44',
          country_name: 'United Kingdom',
          is_whatsapp_eligible: false,
          is_primary: true,
          notes: 'UK Landline (+44)',
          crm_contacts: mockContacts[4],
        },
        {
          id: 'phone-hanmi',
          contact_id: 'c-hanmi',
          company_name: 'Hanmi Pharma Korea',
          contact_person: 'Min-jun Kim',
          department: 'Business Development',
          raw_phone: '+82 10 1234 5678',
          normalized_phone: '+821012345678',
          phone_type: 'valid_mobile',
          country_code: '+82',
          country_name: 'South Korea',
          is_whatsapp_eligible: true,
          is_primary: true,
          crm_contacts: mockContacts[5],
        },
        {
          id: 'phone-kimiafarma',
          contact_id: 'c-kimiafarma',
          company_name: 'PT Kimia Farma',
          contact_person: 'Dewi Lestari',
          department: 'Purchasing',
          raw_phone: '+021 5678 1234',
          normalized_phone: null,
          phone_type: 'invalid_format',
          country_code: '',
          country_name: 'Needs Review',
          is_whatsapp_eligible: false,
          is_primary: true,
          notes: 'Malformed +0 prefix — review required',
          crm_contacts: mockContacts[6],
        },
      ];
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(phones),
      });
    });

    await page.route('**/rest/v1/crm_email_templates*', async (route: any) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      });
    });

    const mockInquiries = [
      {
        id: 'inq-1111',
        inquiry_number: 'INQ-26-0357',
        inquiry_date: '2026-11-02',
        company_name: 'PT Kalbe Farma Tbk',
        product_name: 'Paracetamol IP/BP (Micronized)',
        quantity: '5,000 KG',
        supplier_name: 'Wanbury India',
        offered_price: 6.85,
        offered_price_currency: 'USD',
        status: 'price_ready',
        pipeline_status: 'price_ready',
        priority: 'high',
        created_at: '2026-11-01T09:00:00Z',
      },
    ];

    await page.route('**/rest/v1/crm_inquiries*', async (route: any) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockInquiries),
      });
    });

    const mockPricingOptions = [
      {
        id: 'opt-1',
        inquiry_id: 'inq-1111',
        offered_make: 'Wanbury Ltd',
        origin: 'India',
        specification: 'BP/USP Pharma Grade',
        selling_price: 6.85,
        selling_currency: 'USD',
        delivery_terms: 'Loco Jakarta Warehouse',
        payment_terms: '30 Days Net from Invoice',
        lead_time: 'Ready Stock',
        is_accepted: true,
        include_in_customer_quote: true,
        created_at: '2026-11-02T10:00:00Z',
      },
    ];

    await page.route('**/rest/v1/crm_inquiry_pricing_options*', async (route: any) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockPricingOptions),
      });
    });

    const mockBatches = [
      {
        id: 'batch-001',
        batch_number: 'APF-2026-001',
        product_name: 'Paracetamol IP/BP (Micronized)',
        current_stock: '5000',
        reserved_stock: '0',
        free_stock: '5000',
        expiry_date: '2028-10-15',
      },
    ];

    await page.route('**/rest/v1/v_batch_stock_summary*', async (route: any) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockBatches),
      });
    });

    const mockBatchDocuments = [
      {
        id: 'doc-coa-1',
        batch_id: 'batch-001',
        file_url: 'https://demo.storage/crm-documents/batches/COA_Paracetamol_APF2026001.pdf',
        file_name: 'COA_Paracetamol_APF2026001.pdf',
        file_type: 'application/pdf; coa',
        uploaded_at: '2026-11-01T12:00:00Z',
      },
    ];

    await page.route('**/rest/v1/batch_documents*', async (route: any) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockBatchDocuments),
      });
    });

    const mockCrmProductDocuments = [
      {
        id: 'doc-coa-1',
        product_name: 'Paracetamol IP/BP (Micronized)',
        document_type: 'COA',
        display_file_name: 'COA_Paracetamol_APF2026001.pdf',
        storage_path: 'batches/COA_Paracetamol_APF2026001.pdf',
        created_at: '2026-11-01T12:00:00Z',
      },
      {
        id: 'doc-spec-1',
        product_name: 'Paracetamol IP/BP (Micronized)',
        document_type: 'SPEC',
        display_file_name: 'Product_Specification_Paracetamol_IP.pdf',
        storage_path: 'specs/Product_Specification_Paracetamol_IP.pdf',
        created_at: '2026-11-01T12:00:00Z',
      },
    ];

    await page.route('**/rest/v1/crm_product_documents*', async (route: any) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockCrmProductDocuments),
      });
    });

    await page.route('**/storage/v1/object/sign/**', async (route: any) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ signedURL: 'https://demo.storage/mock-document.pdf' }),
      });
    });

    // 2 Distinct, Deterministic Conversations:
    // 1: Recognized ERP Customer (PT Kalbe Farma Tbk, +6281288889999)
    // 2: Unknown Lead (+6281999887766)
    const mockConversations = [
      {
        id: '77777777-7777-7777-7777-777777777777',
        channel: 'whatsapp',
        title: 'PT Kalbe Farma Tbk',
        customer_id: 'c-kalbe',
        crm_contact_id: 'c-kalbe',
        last_message_at: new Date().toISOString(),
        status: 'active',
        participant_identifiers: ['+6281288889999'],
        metadata: {
          language: 'id',
          intent: 'Price Inquiry',
          latest_summary:
            'Customer requesting quotation & batch COA for 5 MT Paracetamol IP Jakarta warehouse.',
          needs_action: true,
          entities: { product: 'Paracetamol IP/BP (Micronized)' },
        },
        customers: mockContacts[0],
        enquiry_conversation_links: [
          {
            inquiry_id: 'inq-1111',
            is_active: true,
            crm_inquiries: mockInquiries[0],
          },
        ],
        enquiry_conversation_messages: [
          {
            id: '88888888-8888-8888-8888-888888888888',
            conversation_id: '77777777-7777-7777-7777-777777777777',
            sender_name: 'Budi Santoso',
            sender_address: '+6281288889999',
            recipient_addresses: ['+6285888600999'],
            body_text:
              'Selamat pagi Pak Kunal, apakah ready stock Paracetamol IP di gudang Jakarta ada 5 MT? Mohon info penawaran harga dan COA batch terbaru.',
            direction: 'inbound',
            received_or_sent_at: new Date().toISOString(),
          },
        ],
      },
      {
        id: '99999999-9999-9999-9999-999999999999',
        channel: 'whatsapp',
        title: '+62 819-9988-7766',
        customer_id: null,
        crm_contact_id: null,
        last_message_at: new Date(Date.now() - 3600000).toISOString(),
        status: 'active',
        participant_identifiers: ['+6281999887766'],
        metadata: {
          language: 'id',
          intent: 'New Lead',
          latest_summary: 'Unknown WhatsApp lead inquiring on Metformin API pricing.',
          needs_action: true,
          entities: { product: 'Metformin HCl' },
        },
        customers: null,
        enquiry_conversation_links: [],
        enquiry_conversation_messages: [
          {
            id: '99998888-7777-6666-5555-444433332222',
            conversation_id: '99999999-9999-9999-9999-999999999999',
            sender_name: '+6281999887766',
            sender_address: '+6281999887766',
            recipient_addresses: ['+6285888600999'],
            body_text:
              'Halo PT Shubham Anzen, kami butuh info ketersediaan Metformin HCl USP untuk pengiriman ke Surabaya. Apakah ada stock?',
            direction: 'inbound',
            received_or_sent_at: new Date(Date.now() - 3600000).toISOString(),
          },
        ],
      },
    ];

    await page.route('**/rest/v1/enquiry_conversations*', async (route: any) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockConversations),
      });
    });

    await page.route('**/rest/v1/enquiry_conversation_messages*', async (route: any) => {
      const url = route.request().url();
      if (url.includes('99999999-9999-9999-9999-999999999999')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(mockConversations[1].enquiry_conversation_messages),
        });
      } else {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(mockConversations[0].enquiry_conversation_messages),
        });
      }
    });

    await page.route('**/rest/v1/tasks*', async (route: any) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      });
    });

    await page.route('**/rest/v1/crm_activities*', async (route: any) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
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

  const loginAndOpenWhatsAppCrm = async (
    page: any,
    width: number,
    height: number,
    conversationId?: string,
    customPath?: string
  ) => {
    await page.setViewportSize({ width, height });
    await setupAuthAndMocks(page);
    await page.goto('/');
    await page.locator('#username').fill('kunal');
    await page.locator('#password').fill('secret');
    await page.locator('button[type="submit"]').click();
    await expect(page.locator('#username')).toBeHidden({ timeout: 15000 });

    const targetUrl = customPath
      ? customPath
      : conversationId
        ? `/crm/inbox?channel=whatsapp&conversationId=${conversationId}`
        : '/crm/inbox?channel=whatsapp';
    await page.goto(targetUrl);
    await page.waitForTimeout(800);
  };

  test('1. Desktop Viewport (1440x900) Audit & Quick Actions', async ({ page }) => {
    await loginAndOpenWhatsAppCrm(page, 1440, 900, '77777777-7777-7777-7777-777777777777');

    // Wait until message stream loading and customer recognition matching are completely finished
    await expect(page.locator('text=Loading messages...')).toBeHidden({ timeout: 10000 });
    await expect(page.locator('text=Verifying customer recognition in ERP...')).toBeHidden({
      timeout: 10000,
    });
    await expect(page.locator('text=Customer & ERP Context').first()).toBeVisible();
    await expect(page.locator('text=Recognized ERP Customer').first()).toBeVisible();
    await expect(page.locator('text=PT Kalbe Farma Tbk').first()).toBeVisible();
    await expect(page.locator('text=Budi Santoso').first()).toBeVisible();

    // Assert no horizontal window overflow
    const hasNoOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    );
    expect(hasNoOverflow).toBe(true);

    // Save screenshot of fully-loaded desktop inbox with zero loading spinners
    await page.screenshot({ path: path.join(artifactDir, 'whatsapp-crm-main-1440x900.png') });

    // Save screenshot of fully-recognized Customer 360 Context
    await page.screenshot({ path: path.join(artifactDir, 'whatsapp-crm-context-1440x900.png') });

    // 1. Open Quotation Modal & Verify Strict Validation Gate
    await page.getByRole('button', { name: 'Send Quotation', exact: true }).click();
    await expect(page.locator('text=Send Commercial Quotation')).toBeVisible();
    await expect(page.locator('text=SIMULATED — NOT SENT TO CUSTOMER').first()).toBeVisible();

    // Verify Human Approval Gate is present
    const approveBtn = page.getByRole('button', { name: 'Approve & Send Quotation' });
    const humanReviewCheckbox = page.locator('#operatorConfirm');
    const pdfPreviewBtn = page.locator('button:has-text("Preview Quotation PDF")');
    await expect(humanReviewCheckbox).toBeVisible();

    // With human review checkbox unchecked, button should be disabled
    await expect(approveBtn).toBeDisabled();

    // Test positive numerical quantity validation
    const qtyInput = page.locator('input[placeholder="e.g. 5,000 KG"]');

    // 0 KG — invalid
    await qtyInput.fill('0 KG');
    await expect(approveBtn).toBeDisabled();
    await expect(pdfPreviewBtn).toBeDisabled();
    await expect(
      page.locator('text=A finite numerical quantity strictly greater than zero')
    ).toBeVisible();

    // -5 KG — invalid
    await qtyInput.fill('-5 KG');
    await expect(approveBtn).toBeDisabled();
    await expect(pdfPreviewBtn).toBeDisabled();

    // Non-numeric — invalid
    await qtyInput.fill('abc KG');
    await expect(approveBtn).toBeDisabled();
    await expect(pdfPreviewBtn).toBeDisabled();

    // Empty quantity — invalid
    await qtyInput.fill('');
    await expect(approveBtn).toBeDisabled();
    await expect(pdfPreviewBtn).toBeDisabled();

    // Restore valid 5,000 KG
    await qtyInput.fill('5,000 KG');

    // Test incomplete quotation with missing/zero price: approval and PDF generation are strictly disabled
    const priceInput = page.locator('input[placeholder="e.g. 6.85"]');
    await priceInput.fill('');
    await expect(
      page.locator('text=A positive unit price strictly greater than zero is required.')
    ).toBeVisible();
    await expect(approveBtn).toBeDisabled();
    await expect(pdfPreviewBtn).toBeDisabled();

    // Capture screenshot demonstrating disabled approval when price is missing or zero
    await page.screenshot({
      path: path.join(artifactDir, 'whatsapp-crm-quotation-disabled-1440x900.png'),
    });

    // Restore approved price (6.85 USD) and check human review gate
    await priceInput.fill('6.85');
    await humanReviewCheckbox.check();
    await expect(approveBtn).toBeEnabled();
    await expect(pdfPreviewBtn).toBeEnabled();

    // Capture screenshot with approved pricing and human review confirmed
    await page.screenshot({
      path: path.join(artifactDir, 'whatsapp-crm-quotation-modal-1440x900.png'),
    });

    // Close quotation modal
    await page.locator('button:has-text("Cancel")').first().click();

    // 2. Open Document Modal & Verify Explicit Warehouse Batch Isolation
    await page.getByRole('button', { name: 'Send COA / Spec', exact: true }).click();
    await expect(page.locator('text=Send COA / Technical Document')).toBeVisible();
    await expect(page.locator('text=SIMULATED — NOT SENT TO CUSTOMER').first()).toBeVisible();

    // Explicitly select warehouse batch APF-2026-001
    const batchSelect = page.locator('form select').first();
    await batchSelect.selectOption({
      label: 'Batch: APF-2026-001 (Free: 5000 KG, Exp: 10/15/2028)',
    });

    // Verify UI clearly shows selected batch and isolation badge
    await expect(page.locator('text=Batch Isolated')).toBeVisible();
    await expect(page.locator('span.font-bold:has-text("Batch: APF-2026-001")')).toBeVisible();

    // Wait for document list to load (no indefinite spinner)
    await expect(page.locator('text=COA_Paracetamol_APF2026001.pdf').first()).toBeVisible({
      timeout: 5000,
    });

    // Capture screenshot showing explicitly selected warehouse batch APF-2026-001
    await page.screenshot({
      path: path.join(artifactDir, 'whatsapp-crm-document-modal-1440x900.png'),
    });

    // Close document modal
    await page.locator('button:has-text("Cancel")').first().click();

    // 3. Open Stock Check Modal
    await page.getByRole('button', { name: 'Check Stock', exact: true }).click();
    await expect(page.locator('text=ERP Inventory Stock Check')).toBeVisible();
    await expect(page.getByText('APF-2026-001', { exact: true })).toBeVisible();
    await page.screenshot({
      path: path.join(artifactDir, 'whatsapp-crm-stock-modal-1440x900.png'),
    });

    // Close stock modal
    await page.locator('button:has-text("Close")').first().click();

    // 4. Open Follow-Up Modal
    await page.getByRole('button', { name: 'Follow-Up', exact: true }).click();
    await expect(page.locator('text=Schedule Durable Follow-Up')).toBeVisible();
    await page.screenshot({
      path: path.join(artifactDir, 'whatsapp-crm-followup-modal-1440x900.png'),
    });
    await page.locator('button:has-text("Cancel")').first().click();
  });

  test('2. Laptop Viewport (1366x768) Audit', async ({ page }) => {
    await loginAndOpenWhatsAppCrm(page, 1366, 768, '77777777-7777-7777-7777-777777777777');

    await expect(page.locator('text=PT Kalbe Farma Tbk').first()).toBeVisible({ timeout: 10000 });

    // Assert no horizontal window overflow
    const hasNoOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    );
    expect(hasNoOverflow).toBe(true);

    await page.screenshot({ path: path.join(artifactDir, 'whatsapp-crm-main-1366x768.png') });

    // Verify Quotation modal layout fits within 768px height without clipping
    await page.getByRole('button', { name: 'Send Quotation', exact: true }).click();
    await expect(page.locator('text=Send Commercial Quotation')).toBeVisible();
    await page.screenshot({
      path: path.join(artifactDir, 'whatsapp-crm-quotation-modal-1366x768.png'),
    });
    await page.locator('button:has-text("Cancel")').first().click();
  });

  test('3. Tablet Viewport (768x1024) Audit', async ({ page }) => {
    await loginAndOpenWhatsAppCrm(page, 768, 1024, '77777777-7777-7777-7777-777777777777');

    await expect(page.locator('text=PT Kalbe Farma Tbk').first()).toBeVisible({ timeout: 10000 });

    // Assert no horizontal window overflow
    const hasNoOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    );
    expect(hasNoOverflow).toBe(true);

    // Verify 2-pane layout (Slide-over drawer is not open initially on tablet)
    const drawerPanel = page.locator('.fixed.inset-0.z-50');
    await expect(drawerPanel).toBeHidden();

    // Capture tablet 2-pane view before opening drawer
    await page.screenshot({
      path: path.join(artifactDir, 'whatsapp-crm-tablet-twopane-768x1024.png'),
    });

    // Verify "Details" button opens Slide-Over Drawer
    const detailsBtn = page.getByRole('button', { name: 'Details' });
    await expect(detailsBtn).toBeVisible();
    await detailsBtn.click();

    // Drawer is now open with customer context
    await expect(drawerPanel.locator('text=Customer & ERP Context')).toBeVisible();
    await expect(drawerPanel.locator('text=Recognized ERP Customer')).toBeVisible();

    await page.screenshot({ path: path.join(artifactDir, 'whatsapp-crm-main-768x1024.png') });

    // Close drawer via close button inside drawer
    await drawerPanel.locator('button:has(svg.lucide-x)').click();
    await expect(drawerPanel).toBeHidden();

    // Verify all 4 ERP quick actions and composer are fully visible and wrap responsively at 768x1024
    const sendQuoteBtn = page.getByRole('button', { name: 'Send Quotation', exact: true });
    const sendCoaBtn = page.getByRole('button', { name: 'Send COA / Spec', exact: true });
    const checkStockBtn = page.getByRole('button', { name: 'Check Stock', exact: true });
    const followUpBtn = page.getByRole('button', { name: 'Follow-Up', exact: true });
    const composerTextarea = page.locator('textarea[placeholder*="Type a message"]');

    await expect(sendQuoteBtn).toBeVisible();
    await expect(sendCoaBtn).toBeVisible();
    await expect(checkStockBtn).toBeVisible();
    await expect(followUpBtn).toBeVisible();
    await expect(composerTextarea).toBeVisible();

    // Verify buttons are clickable
    await expect(sendQuoteBtn).toBeEnabled();
    await expect(sendCoaBtn).toBeEnabled();
    await expect(checkStockBtn).toBeEnabled();
    await expect(followUpBtn).toBeEnabled();

    // Capture tablet toolbar showing all 4 wrapped action buttons
    await page.screenshot({
      path: path.join(artifactDir, 'whatsapp-crm-tablet-toolbar-768x1024.png'),
    });
  });

  test('4. Mobile Viewport (390x844) Audit', async ({ page }) => {
    // Open on mobile without selecting conversation first -> Full-width Conversation List
    await loginAndOpenWhatsAppCrm(page, 390, 844);

    // Verify conversation list is visible and full-width
    const convCard = page.locator('text=PT Kalbe Farma Tbk').first();
    await expect(convCard).toBeVisible({ timeout: 10000 });

    // Verify unknown lead is also visible in list
    await expect(page.locator('text=+6281999887766').first()).toBeVisible();

    // Assert no horizontal overflow on conversation list
    const listNoOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    );
    expect(listNoOverflow).toBe(true);

    // Capture mobile conversation list screenshot
    await page.screenshot({ path: path.join(artifactDir, 'whatsapp-crm-main-390x844.png') });

    // Tap on PT Kalbe Farma Tbk conversation -> switches to Full-screen Chat
    await convCard.click();
    await page.waitForTimeout(500);

    // Verify Back Button is visible
    const backBtn = page.locator('button[aria-label="Back to conversation list"]');
    await expect(backBtn).toBeVisible();

    // Verify composer is docked and visible at bottom
    await expect(page.locator('textarea[placeholder*="Type a message"]')).toBeVisible();
    await expect(page.locator('button[title="Send WhatsApp Message"]')).toBeVisible();

    // Verify all 4 ERP quick-action buttons are accessible and wrap cleanly on mobile without clipping
    await expect(page.getByRole('button', { name: 'Send Quotation', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Send COA / Spec', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Check Stock', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Follow-Up', exact: true })).toBeVisible();

    // Assert no horizontal overflow on mobile chat
    const chatNoOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    );
    expect(chatNoOverflow).toBe(true);

    // Capture mobile full-screen chat screenshot with docked composer
    await page.screenshot({
      path: path.join(artifactDir, 'whatsapp-crm-composer-docked-390x844.png'),
    });

    // Test back button returns to list
    await backBtn.click();
    await page.waitForTimeout(400);
    await expect(page.locator('text=+6281999887766').first()).toBeVisible();
  });

  test('5. WhatsApp Campaigns Workspace Safety, Consent Gate & Preview Audit', async ({ page }) => {
    await loginAndOpenWhatsAppCrm(page, 1440, 900, undefined, '/crm/campaigns?subtab=whatsapp');

    // Verify Safety Banner is rendered and prominent
    await expect(
      page.locator('text=Bulk WhatsApp Dispatch Blocked — Safety & Consent Enforcement')
    ).toBeVisible({ timeout: 10000 });
    await expect(
      page.locator(
        'text=Bulk WhatsApp dispatch is disabled during CRM data and consent verification.'
      )
    ).toBeVisible();

    // Verify Dispatch Button is strictly disabled with active safety gate label
    const dispatchBtn = page.locator(
      'button:has-text("Bulk Dispatch Disabled (Safety Gate Active)")'
    );
    await expect(dispatchBtn).toBeVisible();
    await expect(dispatchBtn).toBeDisabled();

    // Verify candidate KPI card is labelled "WA Candidates" with truthful description
    const waCandidateCard = page.locator('button:has-text("WA Candidates")').first();
    await expect(waCandidateCard).toBeVisible();
    await expect(waCandidateCard).toHaveAttribute(
      'title',
      'Eligible campaign candidates — not verified WhatsApp accounts and not dispatched.'
    );
    await expect(page.locator('text=Eligible campaign candidates').first()).toBeVisible();

    // Capture campaign safety banner & KPI cards screenshot
    await page.screenshot({
      path: path.join(artifactDir, 'whatsapp-crm-campaigns-safety-1440x900.png'),
    });

    // Verify WhatsApp Phone Mockup shows PREVIEW — NOT SENT badge and NO fake ticks or fake incoming replies
    await expect(page.locator('text=PREVIEW — NOT SENT').first()).toBeVisible();
    await expect(page.locator('text=✓✓')).toBeHidden();

    // Capture campaign preview mockup screenshot
    await page.screenshot({
      path: path.join(artifactDir, 'whatsapp-crm-campaigns-preview-1440x900.png'),
    });
  });

  test('6. Phone Audit Centre Canonical Classification & Global Phone Verification', async ({
    page,
  }) => {
    await loginAndOpenWhatsAppCrm(page, 1440, 900, undefined, '/crm/campaigns?subtab=whatsapp');

    // Click Audit Centre button to launch modal
    const auditCentreBtn = page.locator('button:has-text("Audit Centre")').first();
    await expect(auditCentreBtn).toBeVisible({ timeout: 10000 });
    await auditCentreBtn.click();

    // Scope to the modal container to prevent ambiguity with background buttons
    const modal = page.locator('.fixed.inset-0.z-50');
    await expect(modal).toBeVisible({ timeout: 10000 });

    const searchInput = modal.locator('input[placeholder*="Search company"]');
    await expect(searchInput).toBeVisible({ timeout: 10000 });

    // 1. Indonesian Mobile: CV BIANGLALA BANDUNG (+6282118111128)
    await searchInput.fill('BIANGLALA');
    await page.waitForTimeout(300);
    const bianglalaRow = modal.locator('tbody tr', { hasText: 'CV BIANGLALA BANDUNG' });
    await expect(bianglalaRow).toBeVisible();
    await expect(bianglalaRow.getByText('Indonesia', { exact: true })).toBeVisible();
    await expect(bianglalaRow.getByText('+62', { exact: true })).toBeVisible();
    await expect(bianglalaRow.getByText('Valid Mobile', { exact: true })).toBeVisible();
    await page.screenshot({
      path: path.join(artifactDir, 'phone-audit-indonesia-mobile.png'),
    });

    // 2. Indonesian Jakarta Landline: PT Kalbe Farma Tbk (021 5678 1234)
    await searchInput.fill('021 5678 1234');
    await page.waitForTimeout(300);
    const kalbeRow = modal.locator('tbody tr', { hasText: 'PT Kalbe Farma Tbk' });
    await expect(kalbeRow).toBeVisible();
    await expect(kalbeRow.getByText('Landline', { exact: true })).toBeVisible();
    await expect(kalbeRow.getByText('Jakarta Timur', { exact: true })).toBeVisible();
    await page.screenshot({
      path: path.join(artifactDir, 'phone-audit-indonesia-jakarta-landline.png'),
    });

    // 3. Indonesian Bandung Landline: PT Bio Farma (022 123 4567)
    await searchInput.fill('022 123 4567');
    await page.waitForTimeout(300);
    const bioFarmaRow = modal.locator('tbody tr', { hasText: 'PT Bio Farma' });
    await expect(bioFarmaRow).toBeVisible();
    await expect(bioFarmaRow.getByText('Landline', { exact: true })).toBeVisible();
    await expect(bioFarmaRow.getByText('Bandung', { exact: true })).toBeVisible();
    await page.screenshot({
      path: path.join(artifactDir, 'phone-audit-indonesia-bandung-landline.png'),
    });

    // 4. Indian Mobile: Wanbury Ltd India (+91 98201 12345)
    await searchInput.fill('Wanbury');
    await page.waitForTimeout(300);
    const wanburyRow = modal.locator('tbody tr', { hasText: 'Wanbury Ltd India' });
    await expect(wanburyRow).toBeVisible();
    await expect(wanburyRow.getByText('India', { exact: true })).toBeVisible();
    await expect(wanburyRow.getByText('+91', { exact: true })).toBeVisible();
    await expect(wanburyRow.getByText('Valid Mobile', { exact: true })).toBeVisible();
    await page.screenshot({
      path: path.join(artifactDir, 'phone-audit-india.png'),
    });

    // 5. UK Landline: AstraZeneca UK (+44 20 7946 0958)
    await searchInput.fill('AstraZeneca');
    await page.waitForTimeout(300);
    const astraRow = modal.locator('tbody tr', { hasText: 'AstraZeneca UK' });
    await expect(astraRow).toBeVisible();
    await expect(astraRow.getByText('United Kingdom', { exact: true })).toBeVisible();
    await expect(astraRow.getByText('+44', { exact: true })).toBeVisible();
    await expect(astraRow.getByText('Landline', { exact: true })).toBeVisible();
    await page.screenshot({
      path: path.join(artifactDir, 'phone-audit-uk.png'),
    });

    // 6. South Korean Mobile: Hanmi Pharma Korea (+82 10 1234 5678)
    await searchInput.fill('Hanmi');
    await page.waitForTimeout(300);
    const hanmiRow = modal.locator('tbody tr', { hasText: 'Hanmi Pharma Korea' });
    await expect(hanmiRow).toBeVisible();
    await expect(hanmiRow.getByText('South Korea', { exact: true })).toBeVisible();
    await expect(hanmiRow.getByText('+82', { exact: true })).toBeVisible();
    await expect(hanmiRow.getByText('Valid Mobile', { exact: true })).toBeVisible();
    await page.screenshot({
      path: path.join(artifactDir, 'phone-audit-korea.png'),
    });

    // 7. Malformed +021: PT Kimia Farma (+021 5678 1234)
    await searchInput.fill('Kimia Farma');
    await page.waitForTimeout(300);
    const kimiaRow = modal.locator('tbody tr', { hasText: 'PT Kimia Farma' });
    await expect(kimiaRow).toBeVisible();
    await expect(kimiaRow.getByText('+021 5678 1234', { exact: false })).toBeVisible();
    await expect(kimiaRow.getByText('Needs Review')).toBeVisible();
    await expect(kimiaRow.getByText('Malformed +0 prefix — review required')).toBeVisible();
    await page.screenshot({
      path: path.join(artifactDir, 'phone-audit-malformed-021.png'),
    });
  });
});
