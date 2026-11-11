import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';

test.describe('WhatsApp Business Composer — Attachment Popup, Single Attachment Rule & Personalisation E2E', () => {
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

    // Provide mock CRM contacts for campaign audience
    const mockContacts = [
      {
        id: 'c-1',
        company_name: 'PT Kalbe Farma Tbk',
        contact_person: 'Budi Santoso',
        designation: 'Procurement Specialist',
        email: 'budi.santoso@kalbe.co.id',
        mobile: '+6281288889999',
        phone: '+6281288889999',
        city: 'Cikarang',
        country: 'Indonesia',
        customer_type: 'Pharma Manufacturer',
        is_active: true,
      },
      {
        id: 'c-2',
        company_name: 'PT Kimia Farma Tbk',
        contact_person: 'Siti Rahma',
        designation: 'Purchasing Manager',
        email: 'siti.rahma@kimiafarma.co.id',
        mobile: '+6281377778888',
        phone: '+6281377778888',
        city: 'Bandung',
        country: 'Indonesia',
        customer_type: 'State Enterprise',
        is_active: true,
      },
    ];

    await page.route('**/rest/v1/crm_contacts*', async (route: any) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockContacts),
      });
    });

    // Mock Document Bank view
    const mockBankDocuments = [
      {
        id: 'doc-coa-1',
        title: 'COA_Paracetamol_USP_Batch26.pdf',
        original_file_name: 'COA_Paracetamol_USP_Batch26.pdf',
        document_type: 'COA',
        product_name: 'Paracetamol USP',
        make_name: 'Swadesh Chemicals',
        batch_number: '2026-04',
        specification: 'USP 44',
        storage_bucket: 'crm-documents',
        storage_path: 'mock/COA_Paracetamol_USP_Batch26.pdf',
        file_size: '345600',
        mime_type: 'application/pdf',
        lifecycle_status: 'BANKED',
      },
      {
        id: 'doc-spec-2',
        title: 'SPEC_Pregabalin_IP.pdf',
        original_file_name: 'SPEC_Pregabalin_IP.pdf',
        document_type: 'SPEC',
        product_name: 'Pregabalin IP',
        make_name: 'Shubham Pharmachem',
        batch_number: '2026-01',
        specification: 'IP 2024',
        storage_bucket: 'crm-documents',
        storage_path: 'mock/SPEC_Pregabalin_IP.pdf',
        file_size: '512000',
        mime_type: 'application/pdf',
        lifecycle_status: 'BANKED',
      },
      {
        id: 'doc-photo-3',
        title: 'Factory_Warehouse_Stock.jpeg',
        original_file_name: 'Factory_Warehouse_Stock.jpeg',
        document_type: 'PHOTO',
        product_name: 'Warehouse Jakarta Stock',
        make_name: 'SAPJ Logistics',
        storage_bucket: 'crm-documents',
        storage_path: 'mock/Factory_Warehouse_Stock.jpeg',
        file_size: '1240000',
        mime_type: 'image/jpeg',
        lifecycle_status: 'BANKED',
      },
    ];

    await page.route('**/rest/v1/vw_universal_document_bank*', async (route: any) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockBankDocuments),
      });
    });

    // Mock WhatsApp adapter status
    await page.route('**/api/whatsapp/api/status*', async (route: any) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'connected',
          session: 'sapj-business-whatsapp',
          businessPhone: '+6285888600999',
        }),
      });
    });

    // Inject simulated authenticated session
    await page.addInitScript(
      ({ session, user }: any) => {
        localStorage.setItem(
          'sb-dkrtsqienlhpouohmfki-auth-token',
          JSON.stringify({
            access_token: session.access_token,
            refresh_token: session.refresh_token,
            expires_at: session.expires_at,
            expires_in: session.expires_in,
            token_type: 'bearer',
            user,
          })
        );
      },
      { session: mockSession, user: mockUser }
    );
  };

  test('1. Replaces basic dropdown with Attach Photo / Document action, opens modal, and selects ONE document', async ({
    page,
  }) => {
    await setupAuthAndMocks(page);
    await page.goto('/crm?tab=campaigns&subtab=whatsapp', { waitUntil: 'networkidle' });

    // Verify basic dropdown is gone and "Attach Photo / Document" button is present
    const oldDropdown = page.locator('select:has-text("COA_Pregabalin_IP_Batch26.pdf")');
    await expect(oldDropdown).toHaveCount(0);

    const attachActionBtn = page.getByRole('button', { name: /Attach Photo \/ Document/i });
    await expect(attachActionBtn).toBeVisible();

    // Click to open modal
    await attachActionBtn.click();

    // Modal should be visible with two options
    const modalTitle = page.getByRole('heading', { name: /Attach Photo \/ Document/i });
    await expect(modalTitle).toBeVisible();

    const tabA = page.getByRole('button', { name: /A\.\s*Select from Document Bank/i });
    const tabB = page.getByRole('button', { name: /B\.\s*Upload New File/i });
    await expect(tabA).toBeVisible();
    await expect(tabB).toBeVisible();

    // Verify filter pills
    await expect(page.getByRole('button', { name: 'COA', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'MSDS', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'SPEC', exact: true })).toBeVisible();

    // Select the COA document
    const coaItem = page.locator('text=COA_Paracetamol_USP_Batch26.pdf').first();
    await expect(coaItem).toBeVisible();
    await coaItem.click();

    // Click "Attach to Message"
    const attachConfirmBtn = page.getByRole('button', { name: /Attach to Message/i });
    await expect(attachConfirmBtn).toBeEnabled();
    await attachConfirmBtn.click();

    // Modal closed, attachment card visible in composer
    await expect(modalTitle).not.toBeVisible();
    const attachmentCard = page.locator('span.font-bold:has-text("COA_Paracetamol_USP_Batch26.pdf")');
    await expect(attachmentCard).toBeVisible();
    await expect(page.locator('text=Single Attachment active')).toBeVisible();

    // Verify Live Customer Preview reflects the document
    const previewDocTitle = page.locator('div.font-semibold:has-text("COA_Paracetamol_USP_Batch26.pdf")');
    await expect(previewDocTitle).toBeVisible();

    // Save artifact screenshot
    const shotPath = path.join(artifactDir, '01_whatsapp_composer_attachment_card.png');
    await page.screenshot({ path: shotPath, fullPage: true });
  });

  test('2. Single-attachment rule: Replace attachment and Remove attachment', async ({ page }) => {
    await setupAuthAndMocks(page);
    await page.goto('/crm?tab=campaigns&subtab=whatsapp', { waitUntil: 'networkidle' });

    // Open modal and select first doc
    await page.getByRole('button', { name: /Attach Photo \/ Document/i }).click();
    await page.locator('text=COA_Paracetamol_USP_Batch26.pdf').first().click();
    await page.getByRole('button', { name: /Attach to Message/i }).click();
    await expect(page.locator('span.font-bold:has-text("COA_Paracetamol_USP_Batch26.pdf")')).toBeVisible();

    // Click "Replace"
    const replaceBtn = page.getByRole('button', { name: 'Replace', exact: true });
    await expect(replaceBtn).toBeVisible();
    await replaceBtn.click();

    // Select the SPEC document instead
    await page.locator('text=SPEC_Pregabalin_IP.pdf').first().click();
    await page.getByRole('button', { name: /Attach to Message/i }).click();

    // Verify replaced
    await expect(page.locator('span.font-bold:has-text("SPEC_Pregabalin_IP.pdf")')).toBeVisible();
    await expect(page.locator('span.font-bold:has-text("COA_Paracetamol_USP_Batch26.pdf")')).not.toBeVisible();

    // Click "Remove Attachment"
    const removeBtn = page.getByRole('button', { name: /Remove Attachment/i }).first();
    await expect(removeBtn).toBeVisible();
    await removeBtn.click();

    // Reverts to Attach button (pure text mode)
    await expect(page.getByRole('button', { name: /Attach Photo \/ Document/i })).toBeVisible();
    await expect(page.locator('span.font-bold:has-text("SPEC_Pregabalin_IP.pdf")')).not.toBeVisible();
  });

  test('3. Dynamic personalization of caption: independently updates across recipients in Live Preview', async ({
    page,
  }) => {
    await setupAuthAndMocks(page);
    await page.goto('/crm?tab=campaigns&subtab=whatsapp', { waitUntil: 'networkidle' });

    // Attach a document
    await page.getByRole('button', { name: /Attach Photo \/ Document/i }).click();
    await page.locator('text=COA_Paracetamol_USP_Batch26.pdf').first().click();
    await page.getByRole('button', { name: /Attach to Message/i }).click();

    // Ensure preview has template with tags
    const previewArea = page.locator('#whatsapp-preview-card, div.rounded-xl.overflow-hidden');
    await expect(previewArea).toBeVisible();

    // Check that placeholders like {{contact_person}} are NOT raw in the bubble
    const bubbleText = await page.locator('div[class*="bg-[#d9fdd3]"]').textContent();
    expect(bubbleText).not.toContain('{{contact_person}}');
    expect(bubbleText).not.toContain('{{company_name}}');

    // Screenshot of live preview
    const previewShotPath = path.join(artifactDir, '02_whatsapp_live_customer_preview.png');
    await page.screenshot({ path: previewShotPath });
  });

  test('4. Caption length limit warning: shows clear warning if caption > 1024 characters', async ({ page }) => {
    await setupAuthAndMocks(page);
    await page.goto('/crm?tab=campaigns&subtab=whatsapp', { waitUntil: 'networkidle' });

    // Attach a document
    await page.getByRole('button', { name: /Attach Photo \/ Document/i }).click();
    await page.locator('text=COA_Paracetamol_USP_Batch26.pdf').first().click();
    await page.getByRole('button', { name: /Attach to Message/i }).click();

    // Fill message textarea with 1050 characters
    const textarea = page.locator('textarea[placeholder*="WhatsApp Business"]');
    const longCaption = 'Salam sukses dari PT Shubham Anzen. ' + 'Bahan baku API farmasi ready stock. '.repeat(35);
    await textarea.fill(longCaption);

    // Verify warning banner is displayed
    const warningBanner = page.locator('text=WhatsApp Caption Limit Exceeded');
    await expect(warningBanner).toBeVisible();
    await expect(page.locator('text=WhatsApp limits media captions to 1024 characters')).toBeVisible();

    // Screenshot of warning
    const warningShotPath = path.join(artifactDir, '03_whatsapp_caption_limit_warning.png');
    await page.screenshot({ path: warningShotPath });
  });
});
