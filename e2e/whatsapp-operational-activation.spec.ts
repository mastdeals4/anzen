import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';

test.describe('Anzen WhatsApp Operational Activation Verification', () => {
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

    const mockContacts = [
      {
        id: 'c-kalbe',
        company_name: 'PT Kalbe Farma Tbk',
        contact_person: 'Budi Santoso',
        designation: 'Purchasing Lead',
        email: 'budi.santoso@kalbe.co.id',
        mobile: '+6281288889999',
        phone: '+6281288889999',
        city: 'Jakarta Timur',
        customer_type: 'Pharma Manufacturer',
        is_active: true,
        created_at: '2026-01-15T10:00:00Z',
      },
      {
        id: 'c-bianglala',
        company_name: 'CV BIANGLALA BANDUNG',
        contact_person: 'Rina Wijaya',
        designation: 'Owner',
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
        designation: 'Procurement Specialist',
        email: 'sourcing@biofarma.co.id',
        mobile: null,
        phone: '022 123 4567',
        city: 'Bandung',
        customer_type: 'Pharma Manufacturer',
        is_active: true,
        created_at: '2026-02-20T10:00:00Z',
      },
      {
        id: 'c-testpartner',
        company_name: 'PT Shubham Anzen Test Partner',
        contact_person: 'Operational Verifier',
        designation: 'QA Lead',
        email: 'test@sapj.co.id',
        mobile: '+6285888600999',
        phone: '+6285888600999',
        city: 'Jakarta',
        customer_type: 'Testing Partner',
        is_active: true,
        created_at: '2026-03-01T10:00:00Z',
      },
    ];

    await page.route('**/rest/v1/crm_contacts*', async (route: any) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockContacts),
      });
    });

    const mockConversations = [
      {
        id: '77777777-7777-7777-7777-777777777777',
        channel: 'whatsapp',
        title: 'PT Kalbe Farma Tbk',
        customer_id: 'c-kalbe',
        crm_contact_id: 'c-kalbe',
        last_message_at: new Date().toISOString(),
        status: 'active',
        participant_identifiers: ['+6285888600999'],
        metadata: {
          language: 'id',
          intent: 'Price Inquiry',
          latest_summary: 'Customer requesting quotation & batch COA for Paracetamol USP Jakarta warehouse.',
          needs_action: true,
          entities: { product: 'Paracetamol USP' },
        },
        customers: mockContacts[0],
        enquiry_conversation_links: [],
        enquiry_conversation_messages: [
          {
            id: '88888888-8888-8888-8888-888888888888',
            conversation_id: '77777777-7777-7777-7777-777777777777',
            sender_name: 'Budi Santoso',
            sender_address: '+6285888600999',
            recipient_addresses: ['+6285888600999'],
            body_text: 'Selamat pagi Pak Kunal, apakah ready stock Paracetamol USP di gudang Jakarta ada 5 MT? Mohon info penawaran harga dan COA batch terbaru.',
            direction: 'inbound',
            received_or_sent_at: new Date(Date.now() - 3600000).toISOString(),
          },
          {
            id: '88888888-8888-8888-8888-999999999999',
            conversation_id: '77777777-7777-7777-7777-777777777777',
            sender_name: 'SAPJ Sales',
            sender_address: '+6285888600999',
            recipient_addresses: ['+6285888600999'],
            body_text: 'Halo Bapak Budi, ready stock Paracetamol USP tersedia di Gudang Jakarta. Kami lampirkan COA dan penawaran resmi.',
            direction: 'outbound',
            received_or_sent_at: new Date().toISOString(),
            attachments: [
              {
                filename: 'COA-Paracetamol-USP-2026.pdf',
                url: 'https://storage.sapj.co.id/docs/COA-Paracetamol-USP-2026.pdf',
                content_type: 'application/pdf',
              },
            ],
          },
        ],
      },
    ];

    await page.route('**/api/whatsapp/api/messages/send*', async (route: any) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          messageId: 'wa_sent_operational_test_777',
          status: 'sent',
          timestamp: new Date().toISOString(),
        }),
      });
    });

    await page.route('**/api/messages/send*', async (route: any) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          messageId: 'wa_sent_operational_test_777',
          status: 'sent',
          timestamp: new Date().toISOString(),
        }),
      });
    });

    await page.route('**/rest/v1/enquiry_conversations*', async (route: any) => {
      const method = route.request().method();
      if (method === 'PATCH' || method === 'PUT') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ success: true }),
        });
        return;
      }
      const accept = route.request().headers()['accept'] || '';
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(accept.includes('vnd.pgrst.object+json') ? mockConversations[0] : mockConversations),
      });
    });

    await page.route('**/rest/v1/enquiry_conversation_messages*', async (route: any) => {
      if (route.request().method() === 'POST') {
        const accept = route.request().headers()['accept'] || '';
        const newMsg = { id: 'msg-new-outbound-001' };
        await route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify(accept.includes('vnd.pgrst.object+json') ? newMsg : [newMsg]),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockConversations[0].enquiry_conversation_messages),
      });
    });

    await page.route('**/rest/v1/crm_inquiries*', async (route: any) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      });
    });

    await page.route('**/rest/v1/products*', async (route: any) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      });
    });

    await page.route('**/rest/v1/crm_email_templates*', async (route: any) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      });
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
  };

  const loginAndNavigate = async (page: any, targetPath: string, width = 1440, height = 900) => {
    await page.setViewportSize({ width, height });
    await setupAuthAndMocks(page);
    await page.goto('/');
    await page.locator('#username').fill('kunal');
    await page.locator('#password').fill('secret');
    await page.locator('button[type="submit"]').click();
    await expect(page.locator('#username')).toBeHidden({ timeout: 15000 });
    await page.goto(targetPath);
    await page.waitForTimeout(1000);
  };

  test('1. WhatsApp Settings: Authentic Connection & Business Identity', async ({ page }) => {
    await loginAndNavigate(page, '/crm?tab=inbox');

    // Click Integration Health & Settings button in the header
    const settingsBtn = page.locator('button[title*="Integration Health"]').first();
    await expect(settingsBtn).toBeVisible({ timeout: 10000 });
    await settingsBtn.click();
    await page.waitForTimeout(1200);

    // Verify WhatsApp Settings renders CONNECTED badge
    const connectedBadge = page.locator('text=CONNECTED').first();
    await expect(connectedBadge).toBeVisible({ timeout: 10000 });

    // Verify Business Phone shows +6285888600999
    const phoneElement = page.locator('text=+6285888600999').first();
    await expect(phoneElement).toBeVisible({ timeout: 5000 });

    const screenshotPath = path.join(artifactDir, 'whatsapp-settings-operational-1440x900.png');
    await page.screenshot({ path: screenshotPath, fullPage: false });
    expect(fs.existsSync(screenshotPath)).toBe(true);
  });

  test('2. Campaigns Module: Unique Recipient Selection, Duplicate Prevention, Consent & Scheduling', async ({ page }) => {
    await loginAndNavigate(page, '/crm?tab=campaigns&subtab=whatsapp');

    // Verify WhatsApp Business Composer
    await expect(page.locator('text=WhatsApp Business Composer')).toBeVisible({ timeout: 10000 });

    // Verify Audience Eligibility & Duplicate Prevention Card
    await expect(page.locator('text=Audience Eligibility & Duplicate Prevention')).toBeVisible();
    await expect(page.locator('text=Eligible Mobiles')).toBeVisible();
    await expect(page.locator('text=Duplicates Suppressed')).toBeVisible();

    // Verify Campaign Schedule selector
    await expect(page.locator('text=Campaign Schedule:')).toBeVisible();
    await expect(page.locator('text=Send Immediately')).toBeVisible();
    await expect(page.locator('text=Schedule for Later')).toBeVisible();

    // Verify Test Pilot mode displays Test Recipient Phone and 1-on-1 Test Pilot button
    await expect(page.locator('text=Test Recipient Phone:')).toBeVisible();
    const testPilotBtn = page.locator('button:has-text("Send 1-on-1 Test Pilot")');
    await expect(testPilotBtn).toBeVisible();

    // Switch to Live Campaign mode to verify safety gate
    await page.locator('label:has-text("Live Campaign")').click();
    await page.waitForTimeout(400);

    // Verify Save as Campaign Draft button and Bulk Dispatch Disabled gate
    const draftBtn = page.locator('button:has-text("Save as Campaign Draft")');
    await expect(draftBtn).toBeVisible();

    const bulkBtn = page.locator('button:has-text("Bulk Dispatch Disabled (OpenWA Transport)")');
    await expect(bulkBtn).toBeVisible();
    await expect(bulkBtn).toBeDisabled();

    // Verify draft-only planning notice is present
    await expect(page.locator('text=Draft-Only Campaign Planning:')).toBeVisible();

    const screenshotPath = path.join(artifactDir, 'whatsapp-campaigns-operational-1440x900.png');
    await page.screenshot({ path: screenshotPath, fullPage: false });
    expect(fs.existsSync(screenshotPath)).toBe(true);
  });

  test('3. 1-on-1 WhatsApp Communication: Conversation Thread & Actions', async ({ page }) => {
    await loginAndNavigate(page, '/crm/inbox?channel=whatsapp&conversationId=77777777-7777-7777-7777-777777777777');

    // Wait until conversation thread is loaded
    await expect(page.locator('text=Budi Santoso').first()).toBeVisible({ timeout: 10000 });
    await expect(page.locator('text=Paracetamol USP').first()).toBeVisible();

    // Verify quick action buttons: Send Quotation, Send COA, Check Stock
    await expect(page.locator('button:has-text("Send Quotation")').first()).toBeVisible();
    await expect(page.locator('button:has-text("Send COA / Spec")').first()).toBeVisible();
    await expect(page.locator('button:has-text("Check Stock")').first()).toBeVisible();

    // Verify recorded permission safeguard
    await expect(page.locator('text=Permission on File:').first()).toBeVisible();

    // Verify Composer is present and usable
    const composer = page.locator('textarea, input[placeholder*="Type"], input[placeholder*="Ketik"]').last();
    await expect(composer).toBeVisible();

    // Type a manual reply and submit to verify 20-second cooldown activation
    await composer.fill('Halo Pak Budi, kami verifikasi ready stock batch 2026 telah disiapkan.');
    const sendBtn = page.locator('button[title*="Send WhatsApp"]').first();
    await expect(sendBtn).toBeEnabled();
    await sendBtn.click();
    await page.waitForTimeout(600);

    // Verify that the operator cooldown is active and Send button is pacing-restricted
    await expect(page.locator('text=Operator Cooldown Active').first()).toBeVisible({ timeout: 5000 });

    const screenshotPath = path.join(artifactDir, 'whatsapp-inbox-operational-1440x900.png');
    await page.screenshot({ path: screenshotPath, fullPage: false });
    expect(fs.existsSync(screenshotPath)).toBe(true);
  });

  test('4. Tablet Responsive Two-Pane & Quick Actions (768x1024)', async ({ page }) => {
    await loginAndNavigate(page, '/crm/inbox?channel=whatsapp&conversationId=77777777-7777-7777-7777-777777777777', 768, 1024);

    await expect(page.locator('text=Budi Santoso').first()).toBeVisible({ timeout: 10000 });
    const composer = page.locator('textarea, input[placeholder*="Type"], input[placeholder*="Ketik"]').last();
    await expect(composer).toBeVisible();

    const screenshotPath = path.join(artifactDir, 'whatsapp-inbox-operational-768x1024.png');
    await page.screenshot({ path: screenshotPath, fullPage: false });
    expect(fs.existsSync(screenshotPath)).toBe(true);
  });

  test('5. Mobile Responsive Active Chat & Docked Composer (390x844)', async ({ page }) => {
    await loginAndNavigate(page, '/crm/inbox?channel=whatsapp&conversationId=77777777-7777-7777-7777-777777777777', 390, 844);

    await expect(page.locator('text=Budi Santoso').first()).toBeVisible({ timeout: 10000 });
    const composer = page.locator('textarea, input[placeholder*="Type"], input[placeholder*="Ketik"]').last();
    await expect(composer).toBeVisible();

    const screenshotPath = path.join(artifactDir, 'whatsapp-inbox-operational-390x844.png');
    await page.screenshot({ path: screenshotPath, fullPage: false });
    expect(fs.existsSync(screenshotPath)).toBe(true);
  });
});
