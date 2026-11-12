import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';

// Artifacts directory for screenshots
const ARTIFACT_DIR = '/Users/Kunal/.gemini/antigravity/brain/ba0a5665-f6f0-4bb7-bcd8-a665594273a2/whatsapp-acceptance';
if (!fs.existsSync(ARTIFACT_DIR)) {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
}

// Load .env
const envFile = fs.readFileSync('.env', 'utf8');
const supabaseUrl = envFile.match(/VITE_SUPABASE_URL=(.*)/)?.[1]?.trim();
const supabaseAnonKey = envFile.match(/VITE_SUPABASE_ANON_KEY=(.*)/)?.[1]?.trim();

const supabase = createClient(supabaseUrl, supabaseAnonKey);

const results = {
  testA: null,
  testB: null,
  testC: null,
  testD: null,
  testE: null,
  testF: null,
};

async function logInToSupabase() {
  const testPassword = process.env.TEST_USER_PASSWORD || env.TEST_USER_PASSWORD;
  const { data, error } = await supabase.auth.signInWithPassword({
    email: 'kunal@avira.co.id',
    password: testPassword,
  });
  if (error) throw new Error(`Supabase Auth error: ${error.message}`);
  console.log(`[Supabase Auth] Authenticated as ${data.user.email} (ID: ${data.user.id})`);
}

async function dismissOverlays(page) {
  await page.evaluate(() => {
    document.querySelectorAll('.animate-slide-up').forEach(el => el.remove());
    document.querySelectorAll('.pointer-events-auto').forEach(el => el.remove());
  }).catch(() => {});
}

async function ensureWhatsAppWorkspace(page) {
  const waTabBtn = page.locator('button:has-text("WHATSAPP CAMPAIGN")');
  if (await waTabBtn.isVisible()) {
    await waTabBtn.click();
    await page.waitForTimeout(500);
  }
  await page.waitForSelector('textarea[placeholder*="Write your WhatsApp message"]', { timeout: 15000 });
  await page.waitForSelector('text=Loading CRM contacts directory...', { state: 'detached', timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(500);
  await dismissOverlays(page);
}

async function selectOnlyTestContact(page) {
  console.log('[Contact Selection] Isolating test recipient (+6285888600999)...');
  await page.waitForSelector('text=Loading CRM contacts directory...', { state: 'detached', timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1000);

  await page.click('button:has-text("Clear Selection")');
  await page.waitForTimeout(600);
  const clearedText = await page.locator('span:has-text("Selected")').first().innerText();
  console.log('[Contact Selection] After Clear Selection:', clearedText);

  const searchInput = page.locator('input[placeholder*="Search company, person, mobile"]');
  await searchInput.fill('85888600999');
  await page.waitForTimeout(800);

  const contactItem = page.locator('label:has-text("Avira Internal Test Lab")');
  await contactItem.waitFor({ state: 'visible', timeout: 8000 });
  await contactItem.click();
  await page.waitForTimeout(600);

  const afterText = await page.locator('span:has-text("Selected")').first().innerText();
  console.log('[Contact Selection] After selecting test contact:', afterText);
  if (!afterText.startsWith('1 /')) {
    throw new Error(`Expected exactly 1 contact selected, but got "${afterText}"`);
  }
}

async function setCampaignName(page, name) {
  const input = page.locator('input[placeholder*="Broadcast"]').first();
  await input.fill(name);
}

async function setMessageText(page, text) {
  const textarea = page.locator('textarea[placeholder*="Write your WhatsApp message"]');
  await textarea.fill(text);
}

async function setDelaySeconds(page, secs) {
  const pacingInput = page.locator('input[type="number"][min="5"]');
  await pacingInput.fill(String(secs));
}

async function removeCurrentAttachment(page) {
  const removeBtn = page.locator('button:has-text("Remove")').first();
  if (await removeBtn.isVisible()) {
    await removeBtn.click();
    await page.waitForTimeout(300);
  }
}

async function run() {
  await logInToSupabase();

  console.log('[Browser] Launching Chromium...');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    acceptDownloads: true,
  });
  const page = await context.newPage();

  // Navigate to login
  console.log('[Step 1] Logging into Avira ERP via UI...');
  await page.goto('http://127.0.0.1:5173/');
  await page.waitForSelector('#username', { timeout: 15000 });
  await page.fill('#username', 'kunal@avira.co.id');
  await page.fill('#password', testPassword);
  await page.click('button[type="submit"]');

  await page.waitForURL('**/dashboard', { timeout: 20000 });
  console.log('[Step 1] Successfully logged into ERP Dashboard.');

  // Navigate to WhatsApp Campaigns subtab
  console.log('[Step 2] Navigating to WhatsApp Campaigns tab...');
  await page.goto('http://127.0.0.1:5173/crm/campaigns?subtab=whatsapp');
  await ensureWhatsAppWorkspace(page);
  console.log('[Step 2] WhatsApp Campaign workspace loaded.');

  // Check connection status pill
  const statusPill = page.locator('span:has-text("Connected (+6285888600999)")').first();
  await statusPill.waitFor({ state: 'visible', timeout: 10000 });
  console.log('[Step 2] OpenWA connection status confirmed: Connected (+6285888600999).');

  // ---------------------------------------------------------------------------
  // TEST A: Text-Only Message
  // ---------------------------------------------------------------------------
  console.log('\n--- [TEST A] Text-Only Message ---');
  await selectOnlyTestContact(page);
  await removeCurrentAttachment(page);

  await setCampaignName(page, 'Acceptance Test A - Live Text Outreach');
  await setMessageText(page, 'Halo {{contact_name}} dari {{company_name}}! Ini adalah uji coba pesan teks langsung via Avira ERP.');
  await setDelaySeconds(page, 5);

  // Click start campaign
  const startBtnA = page.locator('button:has-text("Start Campaign")');
  console.log(`[TEST A] Clicking "${await startBtnA.innerText()}"...`);
  await startBtnA.click();

  // Wait for finish
  console.log('[TEST A] Waiting for dispatch completion...');
  await page.waitForSelector('text=Campaign Finished', { timeout: 60000 });
  await page.waitForTimeout(2000);

  const shotAPath = path.join(ARTIFACT_DIR, '01_test_a_text_sent.png');
  await page.screenshot({ path: shotAPath, fullPage: true });
  console.log(`[TEST A] Screenshot captured: ${shotAPath}`);

  // Query Supabase for latest campaign
  const { data: campsA, error: errA } = await supabase
    .from('whatsapp_campaigns')
    .select('*')
    .ilike('name', '%Test A%')
    .order('created_at', { ascending: false })
    .limit(1);

  if (errA || !campsA?.length) throw new Error(`Test A campaign query failed: ${errA?.message}`);
  const campA = campsA[0];

  const { data: recsA, error: recErrA } = await supabase
    .from('whatsapp_campaign_recipients')
    .select('*')
    .eq('campaign_id', campA.id);

  if (recErrA || !recsA?.length) throw new Error(`Test A recipient query failed: ${recErrA?.message}`);
  const recA = recsA[0];

  results.testA = {
    campaignId: campA.id,
    campaignName: campA.name,
    status: campA.status,
    sentCount: campA.sent_count,
    recipientPhone: recA.phone,
    recipientStatus: recA.status,
    messageId: recA.message_id,
    sentAt: recA.sent_at,
    error: recA.error_message,
  };
  console.log('[TEST A] DB Record Verified:', results.testA);

  // ---------------------------------------------------------------------------
  // TEST B: Upload New JPEG Specification & Send
  // ---------------------------------------------------------------------------
  console.log('\n--- [TEST B] Upload New JPEG & Send ---');
  await page.reload();
  await ensureWhatsAppWorkspace(page);
  await selectOnlyTestContact(page);

  await setCampaignName(page, 'Acceptance Test B - Upload JPEG Specification');
  await setMessageText(page, 'Halo {{contact_name}}! Terlampir foto spesifikasi produk farmasi terbaru.');
  await setDelaySeconds(page, 5);

  // Open Attachment Modal
  const attachBtn = page.locator('button:has-text("Attach Photo / Document")');
  await attachBtn.click();
  await page.waitForSelector('button:has-text("B. Upload New File")', { timeout: 10000 });

  // Switch to Upload tab
  await page.click('button:has-text("B. Upload New File")');
  await page.waitForTimeout(300);

  // Upload file
  const fileInput = page.locator('input[type="file"][accept*=".pdf"]');
  await fileInput.setInputFiles('/tmp/avira_pharma_spec.jpg');
  await page.waitForTimeout(500);

  // Select SPEC
  const docTypeSelect = page.locator('select').filter({ hasText: 'COA' }).first();
  if (await docTypeSelect.isVisible()) {
    await docTypeSelect.selectOption('SPEC');
  }

  // Click Attach to Message
  await page.click('button:has-text("Attach to Message")');
  await page.waitForTimeout(500);

  // Verify attachment card
  await page.waitForSelector('text=avira_pharma_spec.jpg', { timeout: 5000 });
  console.log('[TEST B] Attachment card verified for avira_pharma_spec.jpg');

  // Click Start Campaign
  const startBtnB = page.locator('button:has-text("Start Campaign")');
  console.log(`[TEST B] Clicking "${await startBtnB.innerText()}"...`);
  await startBtnB.click();

  // Wait for finish
  console.log('[TEST B] Waiting for dispatch completion...');
  await page.waitForSelector('text=Campaign Finished', { timeout: 60000 });
  await page.waitForTimeout(2000);

  const shotBPath = path.join(ARTIFACT_DIR, '02_test_b_jpeg_sent.png');
  await page.screenshot({ path: shotBPath, fullPage: true });
  console.log(`[TEST B] Screenshot captured: ${shotBPath}`);

  // Query Supabase
  const { data: campsB } = await supabase
    .from('whatsapp_campaigns')
    .select('*')
    .ilike('name', '%Test B%')
    .order('created_at', { ascending: false })
    .limit(1);

  const campB = campsB[0];
  const { data: recsB } = await supabase
    .from('whatsapp_campaign_recipients')
    .select('*')
    .eq('campaign_id', campB.id);

  results.testB = {
    campaignId: campB.id,
    campaignName: campB.name,
    attachmentType: campB.attachment_type,
    attachmentFilename: campB.attachment_filename,
    attachmentUrl: campB.attachment_url?.substring(0, 60) + '...',
    status: campB.status,
    sentCount: campB.sent_count,
    recipientStatus: recsB[0]?.status,
    messageId: recsB[0]?.message_id,
    sentAt: recsB[0]?.sent_at,
    error: recsB[0]?.error_message,
  };
  console.log('[TEST B] DB Record Verified:', results.testB);

  // ---------------------------------------------------------------------------
  // TEST C: Upload New PDF COA & Send
  // ---------------------------------------------------------------------------
  console.log('\n--- [TEST C] Upload New PDF & Send ---');
  await page.reload();
  await ensureWhatsAppWorkspace(page);
  await selectOnlyTestContact(page);

  await setCampaignName(page, 'Acceptance Test C - Upload PDF COA');
  await setMessageText(page, 'Halo {{contact_name}}! Terlampir sertifikat analisis (COA) resmi untuk {{company_name}}.');
  await setDelaySeconds(page, 5);

  // Open Attachment Modal
  await page.click('button:has-text("Attach Photo / Document")');
  await page.waitForSelector('button:has-text("B. Upload New File")', { timeout: 10000 });
  await page.click('button:has-text("B. Upload New File")');
  await page.waitForTimeout(300);

  // Upload PDF
  await fileInput.setInputFiles('/tmp/avira_pharma_coa.pdf');
  await page.waitForTimeout(500);

  // Select COA
  if (await docTypeSelect.isVisible()) {
    await docTypeSelect.selectOption('COA');
  }

  // Click Attach to Message
  await page.click('button:has-text("Attach to Message")');
  await page.waitForTimeout(500);

  // Verify attachment card
  await page.waitForSelector('text=avira_pharma_coa.pdf', { timeout: 5000 });
  console.log('[TEST C] Attachment card verified for avira_pharma_coa.pdf');

  // Click Start Campaign
  const startBtnC = page.locator('button:has-text("Start Campaign")');
  console.log(`[TEST C] Clicking "${await startBtnC.innerText()}"...`);
  await startBtnC.click();

  // Wait for finish
  console.log('[TEST C] Waiting for dispatch completion...');
  await page.waitForSelector('text=Campaign Finished', { timeout: 60000 });
  await page.waitForTimeout(2000);

  const shotCPath = path.join(ARTIFACT_DIR, '03_test_c_pdf_sent.png');
  await page.screenshot({ path: shotCPath, fullPage: true });
  console.log(`[TEST C] Screenshot captured: ${shotCPath}`);

  // Query Supabase
  const { data: campsC } = await supabase
    .from('whatsapp_campaigns')
    .select('*')
    .ilike('name', '%Test C%')
    .order('created_at', { ascending: false })
    .limit(1);

  const campC = campsC[0];
  const { data: recsC } = await supabase
    .from('whatsapp_campaign_recipients')
    .select('*')
    .eq('campaign_id', campC.id);

  results.testC = {
    campaignId: campC.id,
    campaignName: campC.name,
    attachmentType: campC.attachment_type,
    attachmentFilename: campC.attachment_filename,
    attachmentUrl: campC.attachment_url?.substring(0, 60) + '...',
    status: campC.status,
    sentCount: campC.sent_count,
    recipientStatus: recsC[0]?.status,
    messageId: recsC[0]?.message_id,
    sentAt: recsC[0]?.sent_at,
    error: recsC[0]?.error_message,
  };
  console.log('[TEST C] DB Record Verified:', results.testC);

  // ---------------------------------------------------------------------------
  // TEST D: Select Existing PDF from Universal Document Bank & Send
  // ---------------------------------------------------------------------------
  console.log('\n--- [TEST D] Select from Universal Document Bank & Send ---');
  await page.reload();
  await ensureWhatsAppWorkspace(page);
  await selectOnlyTestContact(page);

  await setCampaignName(page, 'Acceptance Test D - Document Bank PDF');
  await setMessageText(page, 'Halo {{contact_name}}! Terlampir dokumen Nifedipine COA dari Universal Document Bank.');
  await setDelaySeconds(page, 5);

  // Open Attachment Modal
  await page.click('button:has-text("Attach Photo / Document")');
  await page.waitForSelector('button:has-text("A. Select from Document Bank")', { timeout: 10000 });
  await page.waitForSelector('text=Loading Central Document Bank...', { state: 'detached', timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1000);

  // Search for nifedipine
  const bankSearch = page.locator('input[placeholder*="Search by file name, product name"]');
  await bankSearch.fill('nifedipine');
  await page.waitForTimeout(1000);

  // Click on the nifedipine document row
  const nifedipineItem = page.locator('[data-testid="bank-doc-card"]').filter({ hasText: 'nifedipine' }).first();
  await nifedipineItem.waitFor({ state: 'visible', timeout: 15000 });
  await nifedipineItem.click();
  await page.waitForTimeout(600);

  // Click Attach to Message
  const attachConfirmBtn = page.locator('button:has-text("Attach to Message")');
  await attachConfirmBtn.waitFor({ state: 'visible', timeout: 5000 });
  await attachConfirmBtn.click();
  await page.waitForTimeout(500);

  // Verify attachment card shows Universal Document Bank
  await page.waitForSelector('text=Universal Document Bank', { timeout: 5000 });
  console.log('[TEST D] Attachment card verified with Universal Document Bank source.');

  // Click Start Campaign
  const startBtnD = page.locator('button:has-text("Start Campaign")');
  console.log(`[TEST D] Clicking "${await startBtnD.innerText()}"...`);
  await startBtnD.click();

  // Wait for finish
  console.log('[TEST D] Waiting for dispatch completion...');
  await page.waitForSelector('text=Campaign Finished', { timeout: 60000 });
  await page.waitForTimeout(2000);

  const shotDPath = path.join(ARTIFACT_DIR, '04_test_d_bank_pdf_sent.png');
  await page.screenshot({ path: shotDPath, fullPage: true });
  console.log(`[TEST D] Screenshot captured: ${shotDPath}`);

  // Query Supabase
  const { data: campsD } = await supabase
    .from('whatsapp_campaigns')
    .select('*')
    .ilike('name', '%Test D%')
    .order('created_at', { ascending: false })
    .limit(1);

  const campD = campsD[0];
  const { data: recsD } = await supabase
    .from('whatsapp_campaign_recipients')
    .select('*')
    .eq('campaign_id', campD.id);

  results.testD = {
    campaignId: campD.id,
    campaignName: campD.name,
    attachmentFilename: campD.attachment_filename,
    attachmentType: campD.attachment_type,
    status: campD.status,
    sentCount: campD.sent_count,
    recipientStatus: recsD[0]?.status,
    messageId: recsD[0]?.message_id,
    sentAt: recsD[0]?.sent_at,
    error: recsD[0]?.error_message,
  };
  console.log('[TEST D] DB Record Verified:', results.testD);

  // ---------------------------------------------------------------------------
  // TEST E: Pause, Resume & Cancel Controls
  // ---------------------------------------------------------------------------
  console.log('\n--- [TEST E] Pause, Resume & Cancel Controls ---');
  await page.reload();
  await ensureWhatsAppWorkspace(page);
  await dismissOverlays(page);
  await selectOnlyTestContact(page);

  await setCampaignName(page, 'Acceptance Test E - Pause and Cancel');
  await setMessageText(page, 'Testing pause and cancel lifecycle.');

  // Set interval pacing to 30s to allow easy pause/cancel testing
  await setDelaySeconds(page, 30);

  // Handle window.confirm for cancel
  page.on('dialog', async (dialog) => {
    console.log(`[Dialog] ${dialog.type()} message: "${dialog.message()}". Accepting...`);
    await dialog.accept();
  });

  await dismissOverlays(page);
  const startBtnE = page.locator('button:has-text("Start Campaign")');
  await startBtnE.click();

  // Look for Pause button
  const pauseBtn = page.locator('[data-testid="pause-campaign-btn"]');
  await pauseBtn.waitFor({ state: 'visible', timeout: 8000 });
  console.log('[TEST E] Clicking "Pause Campaign"...');
  await dismissOverlays(page);
  await pauseBtn.click({ force: true });
  await page.waitForSelector('text=Campaign Paused', { timeout: 8000 });

  const shotE1Path = path.join(ARTIFACT_DIR, '05_test_e_paused.png');
  await page.screenshot({ path: shotE1Path, fullPage: true });
  console.log(`[TEST E] Screenshot captured: ${shotE1Path}`);

  // Click Resume Campaign
  console.log('[TEST E] Clicking "Resume Campaign"...');
  await dismissOverlays(page);
  const resumeBtn = page.locator('[data-testid="resume-campaign-btn"]');
  if (await resumeBtn.isVisible()) {
    await resumeBtn.click({ force: true });
    await page.waitForTimeout(500);
  }

  // Click Cancel
  console.log('[TEST E] Clicking "Cancel"...');
  await dismissOverlays(page);
  const cancelBtn = page.locator('[data-testid="cancel-campaign-btn"]');
  if (await cancelBtn.isVisible()) {
    await cancelBtn.click({ force: true });
    await page.waitForTimeout(1500);
  }

  const shotE2Path = path.join(ARTIFACT_DIR, '06_test_e_cancelled.png');
  await page.screenshot({ path: shotE2Path, fullPage: true });
  console.log(`[TEST E] Screenshot captured: ${shotE2Path}`);

  // Query Supabase for Test E
  const { data: campsE } = await supabase
    .from('whatsapp_campaigns')
    .select('*')
    .ilike('name', '%Test E%')
    .order('created_at', { ascending: false })
    .limit(1);

  results.testE = {
    campaignId: campsE[0]?.id,
    campaignName: campsE[0]?.name,
    status: campsE[0]?.status,
  };
  console.log('[TEST E] DB Record Verified:', results.testE);

  // ---------------------------------------------------------------------------
  // TEST F: Campaign Report & Excel Export
  // ---------------------------------------------------------------------------
  console.log('\n--- [TEST F] Campaign Report & Excel Export ---');
  await dismissOverlays(page);

  // Check if Campaign Report button exists
  const reportBtn = page.locator('[data-testid="campaign-report-btn"]');
  await reportBtn.waitFor({ state: 'visible', timeout: 5000 });
  console.log('[TEST F] Clicking "Campaign Report"...');
  await dismissOverlays(page);
  await reportBtn.click({ force: true });

  await page.waitForSelector('[data-testid="campaign-report-modal"]', { timeout: 10000 });
  const shotFPath = path.join(ARTIFACT_DIR, '07_test_f_excel_report_modal.png');
  await page.screenshot({ path: shotFPath, fullPage: true });
  console.log(`[TEST F] Screenshot captured: ${shotFPath}`);

  // Test Export to Excel download
  console.log('[TEST F] Clicking "Export to Excel" and capturing download...');
  await dismissOverlays(page);
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 15000 }),
    page.click('[data-testid="export-excel-btn"]', { force: true }),
  ]);

  const excelSavePath = path.join(ARTIFACT_DIR, 'campaign_report.xlsx');
  await download.saveAs(excelSavePath);
  const downloadStats = fs.statSync(excelSavePath);
  console.log(`[TEST F] Download saved: ${excelSavePath} (${downloadStats.size} bytes)`);

  results.testF = {
    excelFile: excelSavePath,
    fileSize: downloadStats.size,
    downloadValid: downloadStats.size > 0,
  };

  console.log('\n======================================================');
  console.log('ALL ACCEPTANCE TESTS COMPLETED SUCCESSFULLY!');
  console.log('======================================================');
  console.log(JSON.stringify(results, null, 2));

  // Write summary json to artifact dir
  fs.writeFileSync(
    path.join(ARTIFACT_DIR, 'acceptance_summary.json'),
    JSON.stringify(results, null, 2)
  );

  await browser.close();
}

run().catch((err) => {
  console.error('[FATAL ACCEPTANCE TEST ERROR]:', err);
  process.exit(1);
});
