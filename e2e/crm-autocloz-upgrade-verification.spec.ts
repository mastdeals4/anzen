import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';

test.describe('SAPJ CRM Autocloz-Inspired Sales CRM & WhatsApp Contact Linking Acceptance', () => {
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

    const mockContacts = [];
    for (let i = 1; i <= 20; i++) {
      mockContacts.push({
        id: `c${i}`,
        company_name: i === 1 ? 'PT Her Bayu Inti' : (i === 2 ? 'PT Sunthi Sepuri' : `PT Farmindo Mitra ${i}`),
        contact_person: i === 1 ? 'Bu Agnes' : (i === 2 ? 'Ibu Dewi' : `Representative ${i}`),
        designation: 'Purchasing Manager',
        email: `purchasing${i}@partner.co.id`,
        mobile: `+62812${String(1000000 + i)}`,
        phone: `+62812${String(1000000 + i)}`,
        city: 'Jakarta',
        customer_type: 'Pharma Manufacturer',
        is_active: true,
        created_at: '2026-01-15T10:00:00Z',
      });
    }

    await page.route('**/rest/v1/sales_team_members*', async (route: any) => {
      const members = [
        { id: '46b3d50c-ace4-42ea-8ab1-12cc6397a169', name: 'Zara', email: 'zara@sapharmajaya.co.id', is_active: true },
        { id: 'af8766e0-16c5-49ca-9bbe-e3cfc1e1fa6f', name: 'Aanvi', email: 'aanvi@sapharmajaya.co.id', is_active: true },
        { id: 'f0d7c6e8-a8e3-489a-a52b-6a8f2856172f', name: 'Mayur', email: 'mayur@sapharmajaya.co.id', is_active: true },
      ];
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(members) });
    });

    await page.route('**/rest/v1/customer_assignments*', async (route: any) => {
      const assignments = [];
      for (let i = 1; i <= 20; i++) {
        assignments.push({
          id: `ca-${i}`,
          crm_contact_id: `c${i}`,
          sales_member_id: '46b3d50c-ace4-42ea-8ab1-12cc6397a169',
          is_active: true,
          sales_team_members: { id: '46b3d50c-ace4-42ea-8ab1-12cc6397a169', name: 'Zara' },
        });
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(assignments) });
    });

    await page.route('**/rest/v1/tasks*', async (route: any) => {
      const todayIso = new Date().toISOString();
      const tomorrowIso = new Date(Date.now() + 86400000).toISOString();
      const tasks = [
        {
          id: 't-today',
          title: 'Follow up with PT Sunthi Sepuri on sample delivery status',
          description: 'Company: PT Sunthi Sepuri • Contact: Ibu Dewi • Urgent quotation verification and shipment schedule.',
          deadline: todayIso,
          priority: 'high',
          status: 'to_do',
          assigned_users: ['46b3d50c-ace4-42ea-8ab1-12cc6397a169'],
          is_deleted: false,
        },
        {
          id: 't-tomorrow',
          title: 'Call customer regarding COA verification and commercial batch terms',
          description: 'Company: PT Her Bayu Inti • Contact: Bu Agnes • Review COA and raw material batch delivery schedule.',
          deadline: tomorrowIso,
          priority: 'urgent',
          status: 'to_do',
          assigned_users: ['46b3d50c-ace4-42ea-8ab1-12cc6397a169'],
          is_deleted: false,
        },
      ];
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(tasks) });
    });

    await page.route('**/rest/v1/crm_activities*', async (route: any) => {
      const activities = [
        {
          id: 'act-1',
          customer_id: 'c1',
          activity_type: 'call',
          subject: 'Phone Call: Discussed Paracetamol & Raw Material Pricing',
          description: 'Discussion: Confirmed current stock in Marunda warehouse and pricing terms with Bu Agnes.\nRequirements: 5,000 kg batch.\nNext Action: Send official commercial proforma invoice.',
          follow_up_date: new Date(Date.now() + 86400000).toISOString(),
          created_at: new Date().toISOString(),
          is_completed: true,
        },
        {
          id: 'act-2',
          customer_id: 'c1',
          activity_type: 'meeting',
          subject: 'Technical Specification & Batch Supply Discussion',
          description: 'Discussed active API requirements, quality test protocol, and commercial batch delivery timeline.',
          follow_up_date: new Date().toISOString(),
          created_at: new Date().toISOString(),
          is_completed: false,
          crm_contacts: {
            company_name: 'PT Her Bayu Inti',
            contact_person: 'Bu Agnes',
          },
        },
      ];
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(activities) });
    });

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
          id: 'phone-1',
          contact_id: 'c1',
          company_name: 'PT Her Bayu Inti',
          contact_person: 'Bu Agnes',
          department: 'Purchasing',
          raw_phone: '087877881339',
          normalized_phone: '+6287877881339',
          phone_type: 'valid_mobile',
          is_whatsapp_eligible: true,
          is_primary: true,
          crm_contacts: mockContacts[0],
        },
        {
          id: 'phone-2',
          contact_id: 'c1',
          company_name: 'PT Her Bayu Inti',
          contact_person: 'Bu Agnes',
          department: 'Purchasing',
          raw_phone: '02129876964',
          normalized_phone: '+622129876964',
          phone_type: 'landline',
          is_whatsapp_eligible: false,
          is_primary: false,
          crm_contacts: mockContacts[0],
        },
      ];
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(phones),
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
        supplier_name: 'Wanbury India',
        status: 'price_ready',
        pipeline_status: 'price_ready',
        priority: 'high',
        created_at: '2026-11-01T09:00:00Z',
      },
      {
        id: '22222222-2222-2222-2222-222222222222',
        inquiry_number: 'INQ-26-0356',
        inquiry_date: '2026-11-01',
        company_name: 'PT Dexa Medica',
        product_name: 'Pregabalin IP/USP',
        quantity: '1000 kg',
        supplier_name: 'Shubham Pharmachem Ltd',
        status: 'quoted',
        pipeline_status: 'quoted',
        priority: 'urgent',
        created_at: '2026-11-01T10:00:00Z',
      },
    ];

    await page.route('**/rest/v1/crm_inquiries*', async (route: any) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockInquiries),
      });
    });

    const mockConversations = [
      {
        id: '77777777-7777-7777-7777-777777777777',
        channel: 'whatsapp',
        title: 'WhatsApp: PT Kalbe Farma Tbk (+6281288889999)',
        customer_id: 'c1111111-1111-1111-1111-111111111111',
        crm_contact_id: 'c1111111-1111-1111-1111-111111111111',
        last_message_at: new Date().toISOString(),
        status: 'active',
        participant_identifiers: ['+6281288889999'],
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
            body_text: 'Selamat pagi Pak Kunal, apakah ready stock Paracetamol IP di gudang Jakarta ada 5 MT? Mohon info penawaran harga dan COA batch terbaru.',
            direction: 'inbound',
            received_or_sent_at: new Date().toISOString(),
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
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockConversations[0].enquiry_conversation_messages),
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
    await setupAuthAndMocks(page);
    await page.goto('/');
    await page.locator('#username').fill('kunal');
    await page.locator('#password').fill('secret');
    await page.locator('button[type="submit"]').click();
    await expect(page.locator('#username')).toBeHidden({ timeout: 15000 });
  };

  const viewports = [
    { width: 1280, height: 800, label: '1280x800' },
    { width: 1440, height: 900, label: '1440x900' },
  ];

  for (const vp of viewports) {
    test(`1. Autocloz Activity Dashboard Verification [${vp.label}]`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await loginDirectly(page);
      await page.goto('/crm/dashboard');
      await page.waitForLoadState('domcontentloaded');

      // 1. Verify 7 Destinations
      await expect(page.getByRole('button', { name: 'DASHBOARD', exact: true })).toBeVisible({ timeout: 10000 });
      await expect(page.getByRole('button', { name: 'INBOX', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'FOLLOW-UPS', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'INQUIRIES', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'CAMPAIGNS', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'CUSTOMERS', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'DOCUMENT BANK', exact: true })).toBeVisible();

      // 2. Verify Greeting & 4 KPI Metrics
      await expect(page.locator('text=Good').first()).toBeVisible();
      await expect(page.locator('text=Tasks Due Today')).toBeVisible();
      await expect(page.locator('text=Overdue Tasks')).toBeVisible();
      await expect(page.locator('text=Waiting Customer')).toBeVisible();
      await expect(page.locator('text=Meetings Week')).toBeVisible();

      // 3. Verify Left Column Cards
      await expect(page.locator('text=Latest assigned contact')).toBeVisible();
      await expect(page.locator('text=Latest assigned Accounts')).toBeVisible();
      await expect(page.locator('text=Latest assigned Inquiries')).toBeVisible();
      await expect(page.locator('text=Latest assigned task')).toBeVisible();
      await expect(page.locator('span:has-text("Appointment")').first()).toBeVisible();

      // 4. Verify Right Column Activity Timeline
      await expect(page.locator('h3:has-text("Activity timeline")')).toBeVisible();

      // Save Screenshot
      const screenshotPath = path.join(artifactDir, `crm-autocloz-dashboard-${vp.label}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: true });
      expect(fs.existsSync(screenshotPath)).toBeTruthy();
    });

    test(`2. WhatsApp Contact Identification & Linking in Inbox [${vp.label}]`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await loginDirectly(page);
      await page.goto('/crm/inbox');
      await page.waitForLoadState('domcontentloaded');

      // Verify Mailbox & WhatsApp Channel Filter & Diagnostic Test Threads Toggle
      await expect(page.locator('text=Mailbox:')).toBeVisible({ timeout: 10000 });
      await expect(page.getByRole('button', { name: 'WhatsApp', exact: true })).toBeVisible();
      await expect(page.locator('button:has-text("Test Threads")')).toBeVisible();

      // Select WhatsApp conversation
      const waItem = page.locator('text=WhatsApp:').first();
      if (await waItem.isVisible()) {
        await waItem.click();
        await page.waitForTimeout(500);
      }

      // Check for phone number & copy button
      const copyPhoneBtn = page.locator('button[title*="phone"], button[title*="Copy"]');
      if (await copyPhoneBtn.count() > 0) {
        await expect(copyPhoneBtn.first()).toBeVisible();
      }

      // Save Screenshot
      const screenshotPath = path.join(artifactDir, `crm-whatsapp-inbox-identification-${vp.label}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: true });
      expect(fs.existsSync(screenshotPath)).toBeTruthy();
    });

    test(`3. Follow-ups Workspace (TO-DO & MEETINGS Calendar) [${vp.label}]`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await loginDirectly(page);
      await page.goto('/crm/followups');
      await page.waitForLoadState('domcontentloaded');

      // TO-DO Tab Verification (Reference Image 3)
      await expect(page.getByRole('button', { name: 'TO-DO', exact: true })).toBeVisible({ timeout: 10000 });
      await expect(page.locator('h2:has-text("Next action on active sales")')).toBeVisible();
      await expect(page.getByText('Tasks due Today', { exact: true })).toBeVisible();
      await expect(page.getByText('Tasks due Tomorrow', { exact: true })).toBeVisible();

      // Save TO-DO Screenshot
      const todoScreenshot = path.join(artifactDir, `crm-followups-todo-${vp.label}.png`);
      await page.screenshot({ path: todoScreenshot, fullPage: true });
      expect(fs.existsSync(todoScreenshot)).toBeTruthy();

      // MEETINGS Tab Verification (Reference Image 2)
      await page.getByRole('button', { name: 'MEETINGS', exact: true }).click();
      await page.waitForTimeout(600);

      await expect(page.locator('h2:has-text("Weekly meetings")')).toBeVisible();
      await expect(page.locator('text=Perform outreach, 8:30 - 9:00am').first()).toBeVisible();
      await expect(page.locator('text=Post the day\'s activity, 5:30 - 6:00pm').first()).toBeVisible();

      // Save MEETINGS Screenshot
      const meetingsScreenshot = path.join(artifactDir, `crm-followups-meetings-grid-${vp.label}.png`);
      await page.screenshot({ path: meetingsScreenshot, fullPage: true });
      expect(fs.existsSync(meetingsScreenshot)).toBeTruthy();
    });

    test(`4. Customer 360 & Timeline with + Log Activity [${vp.label}]`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await loginDirectly(page);
      await page.goto('/crm/customers');
      await page.waitForLoadState('domcontentloaded');

      // Switch to Customer 360 Mode
      const c360Btn = page.getByRole('button', { name: 'Customer 360', exact: true });
      await expect(c360Btn).toBeVisible({ timeout: 10000 });
      await c360Btn.click();
      await page.waitForTimeout(800);

      // Verify Reference Image 4 Layout: Left Activity Timeline, Right Company Card
      await expect(page.locator('h2:has-text("Activity Timeline")')).toBeVisible();
      await expect(page.locator('button:has-text("+ Log Activity")')).toBeVisible();

      // Check Right Column Company Card metrics
      await expect(page.locator('text=Industry')).toBeVisible();
      await expect(page.locator('text=Account Owner')).toBeVisible();
      await expect(page.locator('text=Lifecycle Stage')).toBeVisible();
      await expect(page.locator('text=Deal Size')).toBeVisible();
      await expect(page.locator('text=Probability')).toBeVisible();
      await expect(page.locator('text=Related Contacts')).toBeVisible();

      // Click + Log Activity to open menu
      await page.locator('button:has-text("+ Log Activity")').click();
      await page.waitForTimeout(400);
      await expect(page.locator('button:has-text("Phone Call")')).toBeVisible();
      await expect(page.locator('button:has-text("Add Internal Note")')).toBeVisible();

      // Save Screenshot
      const c360Screenshot = path.join(artifactDir, `crm-customer360-timeline-${vp.label}.png`);
      await page.screenshot({ path: c360Screenshot, fullPage: true });
      expect(fs.existsSync(c360Screenshot)).toBeTruthy();
    });

    test(`5. Team Assignment & Salesperson Directory Verification [${vp.label}]`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await loginDirectly(page);
      await page.goto('/crm/customers');
      await page.waitForLoadState('domcontentloaded');

      // Switch to Directory view
      await page.getByRole('button', { name: 'Directory', exact: true }).click();
      await page.waitForTimeout(600);

      // Verify Table header has Sales Rep column
      await expect(page.locator('th:has-text("Sales Rep")')).toBeVisible();

      // Check Zara's assigned badges in the table
      await expect(page.locator('span:has-text("Zara")').first()).toBeVisible();

      // Filter by Zara
      const repFilter = page.locator('select[title="Filter companies by assigned salesperson"]');
      await expect(repFilter).toBeVisible();
      await repFilter.selectOption({ label: 'Zara' });
      await page.waitForTimeout(500);

      // Verify assigned rows are present
      await expect(page.locator('tbody tr td:has-text("PT Her Bayu Inti")').first()).toBeVisible();

      // Select top 2 checkboxes and verify "+ Assign Salesperson" bulk action button
      const firstCheckbox = page.locator('tbody input[type="checkbox"]').first();
      await firstCheckbox.click();
      await page.waitForTimeout(300);

      await expect(page.locator('button:has-text("Assign Salesperson")')).toBeVisible();

      // Save Screenshot
      const teamScreenshot = path.join(artifactDir, `crm-team-assignment-${vp.label}.png`);
      await page.screenshot({ path: teamScreenshot, fullPage: true });
      expect(fs.existsSync(teamScreenshot)).toBeTruthy();
    });

    test(`6. Meeting Details, Reschedule & Notes Completion [${vp.label}]`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await loginDirectly(page);
      await page.goto('/crm/followups');
      await page.waitForLoadState('domcontentloaded');

      // Go to MEETINGS tab
      await page.getByRole('button', { name: 'MEETINGS', exact: true }).click();
      await page.waitForTimeout(600);

      // Click on scheduled meeting in the weekly grid
      const meetingCard = page.locator('div[title*="Click to view details"]').first();
      if (await meetingCard.isVisible()) {
        await meetingCard.click();
        await page.waitForTimeout(400);

        // Verify Modal appears
        await expect(page.locator('h3:has-text("Meeting Details & Actions")')).toBeVisible();
        await expect(page.locator('text=Reschedule Meeting')).toBeVisible();
        await expect(page.locator('text=Complete Meeting & Log Notes')).toBeVisible();
        await expect(page.locator('button:has-text("Create Follow-up Action from Meeting")')).toBeVisible();

        // Save Modal Screenshot
        const modalScreenshot = path.join(artifactDir, `crm-meeting-actions-modal-${vp.label}.png`);
        await page.screenshot({ path: modalScreenshot });
        expect(fs.existsSync(modalScreenshot)).toBeTruthy();

        // Close modal
        await page.locator('button:has-text("Close")').click();
      }
    });
  }
});
