import { test, expect } from '@playwright/test';

test.describe('Kunal Pricing AI Operational Flow', () => {
  test('supplier email -> AI extracted pricing row -> inquiry select -> supplier rate -> landed cost -> quote price -> save', async ({ page }) => {
    // 1. Intercept Supabase Auth & RPC calls
    await page.route('**/rest/v1/rpc/lookup_login_email*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ email: 'kunal@sapharmajaya.co.id', is_active: true }),
      });
    });

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

    // 2. Mock CRM Inquiries
    const mockInquiries = [
      {
        id: 'inq-uuid-101',
        inquiry_number: 'INQ-2026-0287',
        aceerp_no: 'ACE-8842',
        company_name: 'PT Kalbe Farma Tbk',
        product_name: 'Metoclopramide Hydrochloride',
        specification: 'USP / EP',
        quantity: '1,000 kg',
        supplier_name: 'Sun Pharma',
        source_status: 'received',
        document_status: 'received',
        kunal_price_status: 'pending',
        quote_status: 'not_sent',
        purchase_price: null,
        offered_price: null,
        purchase_price_currency: 'USD',
        offered_price_currency: 'USD',
        remarks: 'Urgent requirement for Q3 manufacturing batch',
        kunal_pricing_requested_at: '2026-09-24T10:00:00Z',
        created_at: '2026-09-24T09:30:00Z',
      },
    ];

    await page.route('**/rest/v1/crm_inquiries*', async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(mockInquiries),
        });
      } else {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) });
      }
    });

    // 3. Mock AI Email Reviews (Supplier Quote Processed from Gmail Agent)
    const mockAiReviews = [
      {
        id: 'rev-uuid-501',
        gmail_message_id: '1918a567c8b21ef0',
        from_email: 'exports@ipcalabs.com',
        subject: 'RE: Quotation for Metoclopramide HCl - Ref ACE-8842',
        email_date: '2026-09-24T11:45:00Z',
        product_name: 'Metoclopramide Hydrochloride',
        offered_make: 'IPCA Laboratories',
        source_price: 1250,
        source_currency: 'INR',
        matched_inquiry_id: 'inq-uuid-101',
        confidence: 0.95,
        summary: 'Supplier offered INR 1,250/kg with COA & MSDS attached.',
        action_status: 'pending',
        raw_result: {
          direction: 'SOURCE -> SAPJ',
          matchedInquiryNumber: 'INQ-2026-0287',
          aceerpNo: 'ACE-8842',
          suggestedInquiryId: 'inq-uuid-101',
          alternativeMake: {
            detected: true,
            requestedMake: 'Sun Pharma',
            offeredMake: 'IPCA Laboratories',
            price: 1250,
            currency: 'INR',
          },
          extractionRows: [
            {
              product_name: 'Metoclopramide Hydrochloride',
              offered_make: 'IPCA Laboratories',
              source_price: 1250,
              source_currency: 'INR',
              availability: 'available',
              lead_time: '2 weeks',
              unit: 'KG',
              quantity: '1,000 kg',
              specification: 'USP / EP',
            },
          ],
          detectedDocuments: [
            { documentType: 'COA', filename: 'COA_Metoclopramide_Batch26.pdf', matchStatus: 'MATCHED' },
            { documentType: 'MSDS', filename: 'MSDS_Metoclopramide.pdf', matchStatus: 'MATCHED' },
          ],
          evidence: {
            sourceQuote: 'Our firm offer for Metoclopramide HCl is INR 1,250/kg CIF Jakarta by air/sea.',
            why: 'Subject references ACE-8842; exact product match.',
          },
          sourceEmail: {
            messageId: 'msg-ipca-991',
            threadId: 'th-ipca-991',
            from: 'exports@ipcalabs.com',
            to: 'kunal@sapharmajaya.co.id',
            date: '2026-09-24T11:45:00Z',
            subject: 'Re: Inquiry ACE-8842 - Metoclopramide HCl',
            bodyText: 'Our firm offer for Metoclopramide HCl is INR 1,250/kg CIF Jakarta by air/sea.\nPlease find COA and MSDS attached for review.',
            attachments: [
              { filename: 'COA_Metoclopramide_Batch26.pdf', documentType: 'COA' },
              { filename: 'MSDS_Metoclopramide.pdf', documentType: 'MSDS' },
            ],
          },
        },
        scanned_at: '2026-09-24T12:00:00Z',
      },
    ];

    await page.route('**/rest/v1/kunal_ai_email_reviews*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockAiReviews),
      });
    });

    // 4. Mock Pricing Settings, Pricing Options & Documents
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
              inr_usd_manual_rate: 91,
              inr_usd_cached_rate: 91,
            },
          },
        }),
      });
    });

    await page.route('**/rest/v1/crm_inquiry_pricing_options*', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) });
    });

    await page.route('**/rest/v1/crm_product_documents*', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) });
    });

    await page.route('**/rest/v1/pricing_ledger*', async (route) => {
      await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: 'ledger-uuid' }) });
    });

    await page.route('**/rest/v1/crm_inquiry_timeline*', async (route) => {
      await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: 'timeline-uuid' }) });
    });

    // 5. Login via Login Page
    await page.goto('/');
    await page.locator('#username').fill('kunal');
    await page.locator('#password').fill('secret');
    await page.locator('button[type="submit"]').click();

    // Wait until login completes and redirects
    await expect(page.locator('#username')).toBeHidden({ timeout: 10000 });

    // 6. Navigate to /pricing-worksheet
    await page.goto('/pricing-worksheet');

    // Verify Main Page Header
    await expect(page.getByRole('heading', { name: 'KUNAL PRICING AI' })).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#btn-check-now')).toBeVisible();
    await expect(page.locator('#btn-check-7-days')).toBeVisible();

    // Verify AI Auto-Populated Row appears in the table
    await expect(page.getByText('INQ-2026-0287')).toBeVisible();
    await expect(page.getByText('ACE-8842')).toBeVisible();
    await expect(page.getByText('Metoclopramide Hydrochloride')).toBeVisible();
    await expect(page.getByText('AI Prepared')).toBeVisible();
    await expect(page.locator('tbody tr input[value*="Kalbe Farma"]')).toBeVisible();

    // Verify Offered Make and Alternative Make badge
    await expect(page.getByText('ALT')).toBeVisible();

    // Verify Source Price populated as INR 1250 (draft string input)
    const sourcePriceInput = page.locator('tbody tr input[inputmode="decimal"]').first();
    await expect(sourcePriceInput).toHaveValue('1250');

    // Verify USD Landed Cost calculated automatically via canonical calculateFCL:
    // Base USD: 1250 / 91 = 13.736 USD/kg
    // Capacity: 12000 kg, India Margin: 4%, Freight: $0.08/kg, Duties: 4%, Clearance: $500
    // Total landed per kg = $15.00 / kg
    await expect(page.locator('tbody tr td').filter({ hasText: '$15.00' })).toBeVisible();

    // Verify Suggested Quote Price calculated with 4% Indonesia margin:
    // 15.00 * 1.04 = 15.60
    const quotePriceInput = page.locator('tbody tr input[inputmode="decimal"]').nth(1);
    await expect(quotePriceInput).toHaveValue('15.6');

    // 7. Test Stable Draft Input: Type 1350 without losing focus
    await sourcePriceInput.fill('1350');
    // Landed cost recalculates canonically: $16.19 / kg
    await expect(page.locator('tbody tr td').filter({ hasText: '$16.19' })).toBeVisible();

    // 8. Expand row to verify Supplier Rate Worksheet, Landed Cost breakdown, and Documents
    await page.locator('tbody tr button[title="Expand Details"]').first().click();

    // Verify Supplier Rate Worksheet section
    await expect(page.getByText('Supplier Rate Worksheet')).toBeVisible();
    await expect(page.getByText('Alternative Make Detected')).toBeVisible();

    // Verify Import Calculation breakdown
    await expect(page.getByText('Import Calculation (FCL)')).toBeVisible();
    await expect(page.getByText('20ft Mixed • 12,000 kg')).toBeVisible();
    await expect(page.getByText('SUGGESTED LANDED:')).toBeVisible();

    // Verify Documents detected in the same expanded row
    await expect(page.getByText(/✓ COA/)).toBeVisible();
    await expect(page.getByText(/✓ MSDS/)).toBeVisible();

    // 9. Open Internal Email Evidence Drawer
    const viewEmailBtn = page.getByRole('button', { name: /View Email & Evidence/i });
    await expect(viewEmailBtn).toBeVisible();
    await viewEmailBtn.click();

    // Verify Drawer opens with source evidence and AI extraction
    await expect(page.getByText('Source Evidence').last()).toBeVisible();
    await expect(page.getByText('What SAPJ Understood')).toBeVisible();
    await expect(page.getByText('exports@ipcalabs.com').first()).toBeVisible();
    await expect(page.getByText('Re: Inquiry ACE-8842 - Metoclopramide HCl').first()).toBeVisible();
    await expect(page.getByText('COA_Metoclopramide_Batch26.pdf')).toBeVisible();
    await expect(page.getByText('MSDS_Metoclopramide.pdf')).toBeVisible();

    // Close preview drawer
    await page.locator('button[aria-label="Close panel"]').click();
    await expect(page.getByText('Source Evidence')).toBeHidden();

    // 10. Click SAVE
    const saveButton = page.locator('button').filter({ hasText: /^SAVE$/ }).first();
    await expect(saveButton).toBeVisible();
    await saveButton.click();

    // Verify success toast or confirmation
    await expect(page.getByText(/pricing saved for/i)).toBeVisible({ timeout: 5000 });

    // Verify SEND TO TEAM button is enabled and clickable
    const sendButton = page.locator('button').filter({ hasText: 'SEND TO TEAM' }).first();
    await expect(sendButton).toBeVisible();
    await expect(sendButton).toBeEnabled();
  });
});

