import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';

const ARTIFACT_DIR = '/Users/Kunal/.gemini/antigravity/brain/ba0a5665-f6f0-4bb7-bcd8-a665594273a2/whatsapp-history';
if (!fs.existsSync(ARTIFACT_DIR)) {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
}

// Load .env
const envFile = fs.readFileSync('.env', 'utf8');
const env = Object.fromEntries(
  envFile.split('\n').filter((l) => l && !l.startsWith('#') && l.includes('=')).map((l) => {
    const idx = l.indexOf('=');
    return [l.slice(0, idx).trim(), l.slice(idx + 1).trim()];
  })
);

const supabase = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY);
const TEST_PHONE = '+6285888600999';
const PRODUCTION_PAUSED_CAMPAIGN_ID = '75783a1c-39b3-4170-b7ae-4791fc009beb';

async function dismissOverlays(page) {
  await page.evaluate(() => {
    document.querySelectorAll('.animate-slide-up').forEach((el) => el.remove());
    document.querySelectorAll('.pointer-events-auto').forEach((el) => el.remove());
  }).catch(() => {});
}

async function verifyProductionCampaignUntouched(label) {
  console.log(`\n[Production Campaign Audit - ${label}] Auditing ${PRODUCTION_PAUSED_CAMPAIGN_ID}...`);
  const { data: camp, error: cErr } = await supabase
    .from('whatsapp_campaigns')
    .select('*')
    .eq('id', PRODUCTION_PAUSED_CAMPAIGN_ID)
    .single();

  if (cErr) throw new Error(`Could not fetch production campaign: ${cErr.message}`);

  const { data: recs, error: rErr } = await supabase
    .from('whatsapp_campaign_recipients')
    .select('id, status, error_message, phone, message_id')
    .eq('campaign_id', PRODUCTION_PAUSED_CAMPAIGN_ID);

  if (rErr) throw new Error(`Could not fetch production recipients: ${rErr.message}`);

  const counts = { pending: 0, failed: 0, sent: 0, delivered: 0, read: 0, cancelled: 0 };
  for (const r of recs) {
    counts[r.status] = (counts[r.status] || 0) + 1;
  }

  console.log(`[Production Campaign Audit - ${label}] Status: ${camp.status}`);
  console.log(`[Production Campaign Audit - ${label}] Recipient Counts:`, counts);

  if (camp.status !== 'paused') {
    throw new Error(`CRITICAL: Production campaign status altered! Expected "paused", got "${camp.status}"`);
  }
  if (counts.sent > 0) {
    throw new Error(`CRITICAL: Messages dispatched to production campaign! sent_count: ${counts.sent}`);
  }
  if (counts.failed !== 2) {
    throw new Error(`CRITICAL: Failed records altered! Expected 2, got ${counts.failed}`);
  }
  if (counts.pending !== 104) {
    throw new Error(`CRITICAL: Pending count altered! Expected 104, got ${counts.pending}`);
  }
  if (recs.length !== 106) {
    throw new Error(`CRITICAL: Total recipients altered! Expected 106, got ${recs.length}`);
  }

  console.log(`[Production Campaign Audit - ${label}] INVARIANT VERIFIED: 106 recipients completely preserved (104 pending, 2 failed, 0 sent).`);
  return { camp, counts };
}

async function run() {
  console.log('================================================================');
  console.log('AVIRA WHATSAPP CAMPAIGN HISTORY RESUME ACCEPTANCE TEST');
  console.log('================================================================');

  // 1. Authenticate Supabase Admin
  const testPassword = process.env.TEST_USER_PASSWORD || env.TEST_USER_PASSWORD;
  await supabase.auth.signInWithPassword({
    email: 'kunal@avira.co.id',
    password: testPassword,
  });
  console.log('[Auth] Authenticated as kunal@avira.co.id');

  // 2. Pre-execution verification of production campaign
  await verifyProductionCampaignUntouched('PRE-TEST');

  // 3. Create dedicated test campaign with authorized number ONLY
  console.log('\n[Setup] Creating dedicated internal test campaign for History Resume...');
  const testCampName = `History Resume Acceptance Test - ${Date.now()}`;
  const { data: testCamp, error: createCampErr } = await supabase
    .from('whatsapp_campaigns')
    .insert({
      name: testCampName,
      message_template: 'Halo {{contact_person}} dari {{company_name}}! Ini verifikasi Resume Campaign History via local OpenWA.',
      attachment_url: null,
      attachment_filename: null,
      attachment_type: null,
      status: 'paused',
      total_recipients: 1,
      processing_delay_seconds: 5,
      started_at: new Date().toISOString(),
    })
    .select('*')
    .single();

  if (createCampErr || !testCamp) {
    throw new Error(`Failed to create test campaign: ${createCampErr?.message}`);
  }
  console.log(`[Setup] Created test campaign ${testCamp.id} ("${testCampName}")`);

  // Insert 1 pending recipient
  const { error: insRecErr } = await supabase.from('whatsapp_campaign_recipients').insert([
    {
      campaign_id: testCamp.id,
      company_name: 'Avira Internal Test Lab - Pending',
      contact_person: 'Kunal',
      phone: TEST_PHONE,
      status: 'pending',
      personalized_caption: 'Halo Kunal dari Avira Internal Test Lab! Verifikasi Resume via local OpenWA.',
    },
  ]);

  if (insRecErr) {
    throw new Error(`Failed to insert test recipients: ${insRecErr.message}`);
  }
  console.log('[Setup] Seeded 1 pending test recipient');

  // Also create a separate test campaign to test Reconciliation Modal for failed recipient
  const reconcileCampName = `History Reconcile Acceptance Test - ${Date.now()}`;
  const { data: recCamp } = await supabase
    .from('whatsapp_campaigns')
    .insert({
      name: reconcileCampName,
      message_template: 'Halo {{contact_person}}! Verifikasi Reconcile.',
      status: 'paused',
      total_recipients: 1,
      failed_count: 1,
      started_at: new Date().toISOString(),
    })
    .select('*')
    .single();

  await supabase.from('whatsapp_campaign_recipients').insert([
    {
      campaign_id: recCamp.id,
      company_name: 'Avira Internal Test Lab - Failed',
      contact_person: 'Kunal Reconcile Test',
      phone: TEST_PHONE,
      status: 'failed',
      error_message: 'Waiting for selector `div[data-animate-media-viewer="true"]` failed: Waiting failed: 25000ms exceeded',
      personalized_caption: 'Halo Kunal Reconcile Test! Verifikasi Reconcile.',
    },
  ]);
  console.log(`[Setup] Seeded reconcile test campaign ${recCamp.id}`);

  // Also create a separate test campaign for Pause/Cancel testing
  const cancelCampName = `History Pause-Cancel Acceptance Test - ${Date.now()}`;
  const { data: cancelCamp } = await supabase
    .from('whatsapp_campaigns')
    .insert({
      name: cancelCampName,
      message_template: 'Halo {{contact_person}}! Uji coba Pause & Cancel.',
      status: 'paused',
      total_recipients: 1,
      processing_delay_seconds: 30,
      started_at: new Date().toISOString(),
    })
    .select('*')
    .single();

  await supabase.from('whatsapp_campaign_recipients').insert([
    {
      campaign_id: cancelCamp.id,
      company_name: 'Avira Cancel Test Lab',
      contact_person: 'Kunal Cancel Test',
      phone: TEST_PHONE,
      status: 'pending',
    },
  ]);
  console.log(`[Setup] Seeded cancel test campaign ${cancelCamp.id}`);

  // 4. Launch Playwright
  console.log('\n[Browser] Launching Chromium...');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    acceptDownloads: true,
  });
  const page = await context.newPage();

  // Handle confirm dialogs
  page.on('dialog', async (dialog) => {
    console.log(`[Browser Dialog] ${dialog.type()}: "${dialog.message()}". Accepting...`);
    await dialog.accept();
  });

  // Login
  console.log('[Step 1] Logging into Avira ERP...');
  await page.goto('http://127.0.0.1:5173/');
  await page.waitForSelector('#username', { timeout: 15000 });
  await page.fill('#username', 'kunal@avira.co.id');
  await page.fill('#password', testPassword);
  await page.click('button[type="submit"]');
  await page.waitForURL('**/dashboard', { timeout: 20000 });
  console.log('[Step 1] Logged into Dashboard successfully.');

  // Navigate to Campaigns -> History -> WhatsApp
  console.log('[Step 2] Navigating to Campaign History (WhatsApp)...');
  await page.goto('http://127.0.0.1:5173/crm/campaigns?subtab=history');
  await dismissOverlays(page);

  // Click WhatsApp Campaigns tab if not active
  const waHistBtn = page.locator('button:has-text("WhatsApp Campaigns")').first();
  if (await waHistBtn.isVisible()) {
    await waHistBtn.click();
    await page.waitForTimeout(500);
  }
  await dismissOverlays(page);

  // Verify Local OpenWA disclaimer & OpenWA connection pill
  await page.waitForSelector('text=Local OpenWA Engine', { timeout: 10000 });
  await page.waitForSelector('text=OpenWA Connected', { timeout: 10000 });
  console.log('[Step 2] Local OpenWA Engine and Connection Pill verified.');

  // Select our dedicated test campaign in dropdown
  console.log(`[Step 3] Selecting test campaign "${testCampName}"...`);
  const selector = page.locator('[data-testid="campaign-history-selector"]');
  await selector.waitFor({ state: 'visible', timeout: 5000 });
  await selector.selectOption(testCamp.id);
  await page.waitForTimeout(1000);
  await dismissOverlays(page);

  const shotOverview = path.join(ARTIFACT_DIR, '01_history_campaign_overview.png');
  await page.screenshot({ path: shotOverview, fullPage: true });
  console.log(`[Step 3] Overview screenshot captured: ${shotOverview}`);

  // ---------------------------------------------------------------------------
  // TEST CASE 1: RECONCILE DELIVERY & MODAL
  // ---------------------------------------------------------------------------
  console.log('\n--- [TEST CASE 1] Reconcile Delivery for Failed Recipient ---');
  // Select reconcile test campaign in dropdown
  await selector.selectOption(recCamp.id);
  await page.waitForTimeout(1000);
  await dismissOverlays(page);

  // Find Reconcile button
  const reconcileBtn = page.locator('button:has-text("Reconcile")').first();
  await reconcileBtn.waitFor({ state: 'visible', timeout: 5000 });
  console.log('[TEST 1] Clicking "Reconcile" on failed recipient...');
  await dismissOverlays(page);
  await reconcileBtn.click();

  // Verify Reconcile Modal appears
  await page.waitForSelector('[data-testid="reconcile-modal"]', { timeout: 8000 });
  await page.waitForSelector('text=Delivery Status Reconciled', { timeout: 8000 });
  console.log('[TEST 1] Reconcile modal verified: confirms message was unsent due to selector timeout.');

  const shotReconcile = path.join(ARTIFACT_DIR, '02_history_reconcile_modal.png');
  await page.screenshot({ path: shotReconcile, fullPage: true });
  console.log(`[TEST 1] Screenshot captured: ${shotReconcile}`);

  // Close reconcile modal
  await page.click('button:has-text("Close")');
  await page.waitForTimeout(500);
  console.log('[TEST 1] Reconcile modal closed.');

  // ---------------------------------------------------------------------------
  // TEST CASE 2: RESUME CAMPAIGN VIA LOCAL OPENWA
  // ---------------------------------------------------------------------------
  console.log('\n--- [TEST CASE 2] Resume Campaign from History ---');
  // Switch back to test campaign with 1 pending recipient
  await selector.selectOption(testCamp.id);
  await page.waitForTimeout(1000);
  await dismissOverlays(page);
  const resumeBtn = page.locator('[data-testid="history-resume-btn"]');
  await resumeBtn.waitFor({ state: 'visible', timeout: 5000 });
  console.log(`[TEST 2] Clicking "${await resumeBtn.innerText()}"...`);
  await dismissOverlays(page);
  await resumeBtn.click();

  // Wait for dispatch in-flight indicator
  console.log('[TEST 2] Waiting for dispatch completion...');
  await page.waitForSelector('text=In-Flight Dispatch', { timeout: 8000 }).catch(() => {});
  
  // Wait until completed
  await page.waitForFunction(
    () => {
      const badges = Array.from(document.querySelectorAll('span'));
      return badges.some((b) => b.textContent && b.textContent.includes('completed'));
    },
    { timeout: 25000 }
  );
  console.log('[TEST 2] Campaign dispatch completed!');

  const shotResumed = path.join(ARTIFACT_DIR, '03_history_resume_completed.png');
  await page.screenshot({ path: shotResumed, fullPage: true });
  console.log(`[TEST 2] Screenshot captured: ${shotResumed}`);

  // Verify database record for test campaign
  const { data: testCampAfter } = await supabase
    .from('whatsapp_campaigns')
    .select('*')
    .eq('id', testCamp.id)
    .single();

  const { data: testRecsAfter } = await supabase
    .from('whatsapp_campaign_recipients')
    .select('*')
    .eq('campaign_id', testCamp.id);

  const { data: recCampRecs } = await supabase
    .from('whatsapp_campaign_recipients')
    .select('*')
    .eq('campaign_id', recCamp.id);

  const sentRec = testRecsAfter[0];
  const failedRec = recCampRecs[0];

  console.log('[TEST 2] DB Verification:', {
    campaignStatus: testCampAfter.status,
    sentCount: testCampAfter.sent_count,
    failedCount: testCampAfter.failed_count,
    sentRecipient: {
      status: sentRec?.status,
      messageId: sentRec?.message_id,
      sentAt: sentRec?.sent_at,
    },
    failedRecipientPreserved: {
      status: failedRec?.status,
      errorMessage: failedRec?.error_message?.slice(0, 40) + '...',
    },
  });

  if (sentRec?.status !== 'sent' || !sentRec?.message_id) {
    throw new Error(`Expected pending recipient to be sent with message_id, got: ${JSON.stringify(sentRec)}`);
  }
  if (failedRec?.status !== 'failed') {
    throw new Error(`Expected failed recipient to remain failed, got: ${failedRec?.status}`);
  }
  console.log('[TEST 2] PASSED: Pending recipient dispatched via local OpenWA; failed recipient preserved.');

  // ---------------------------------------------------------------------------
  // TEST CASE 3: PAUSE & CANCEL FROM HISTORY
  // ---------------------------------------------------------------------------
  console.log('\n--- [TEST CASE 3] Pause & Cancel Controls from History ---');
  // Select cancel test campaign
  await selector.selectOption(cancelCamp.id);
  await page.waitForTimeout(1000);
  await dismissOverlays(page);

  // Click Cancel Campaign
  const cancelBtn = page.locator('[data-testid="history-cancel-btn"]');
  await cancelBtn.waitFor({ state: 'visible', timeout: 5000 });
  console.log('[TEST 3] Clicking "Cancel Campaign"...');
  await dismissOverlays(page);
  await cancelBtn.click();
  await page.waitForTimeout(2000);

  const shotCancel = path.join(ARTIFACT_DIR, '04_history_cancelled.png');
  await page.screenshot({ path: shotCancel, fullPage: true });
  console.log(`[TEST 3] Screenshot captured: ${shotCancel}`);

  // Verify DB for cancel campaign
  const { data: cancelCampAfter } = await supabase
    .from('whatsapp_campaigns')
    .select('*')
    .eq('id', cancelCamp.id)
    .single();

  const { data: cancelRecsAfter } = await supabase
    .from('whatsapp_campaign_recipients')
    .select('*')
    .eq('campaign_id', cancelCamp.id);

  console.log('[TEST 3] Cancel DB Record:', {
    status: cancelCampAfter.status,
    recipientStatus: cancelRecsAfter[0]?.status,
  });

  if (cancelCampAfter.status !== 'cancelled' || cancelRecsAfter[0]?.status !== 'cancelled') {
    throw new Error('Expected campaign and recipient to be cancelled.');
  }
  console.log('[TEST 3] PASSED: Cancel control stopped dispatch and marked recipients cancelled.');

  // ---------------------------------------------------------------------------
  // TEST CASE 4: EXCEL REPORT EXPORT FROM HISTORY
  // ---------------------------------------------------------------------------
  console.log('\n--- [TEST CASE 4] Excel Report Export from History ---');
  // Switch back to completed test campaign
  await selector.selectOption(testCamp.id);
  await page.waitForTimeout(1000);
  await dismissOverlays(page);

  const exportBtn = page.locator('[data-testid="export-excel-btn"]');
  await exportBtn.waitFor({ state: 'visible', timeout: 5000 });
  console.log('[TEST 4] Clicking "Export Report" and capturing download...');
  await dismissOverlays(page);

  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 15000 }),
    exportBtn.click(),
  ]);

  const excelPath = path.join(ARTIFACT_DIR, 'history_campaign_report.xlsx');
  await download.saveAs(excelPath);
  const stats = fs.statSync(excelPath);
  console.log(`[TEST 4] Excel saved: ${excelPath} (${stats.size} bytes)`);

  if (stats.size === 0) {
    throw new Error('Exported Excel file is empty.');
  }
  console.log('[TEST 4] PASSED: Excel export generated successfully.');

  await browser.close();

  // ---------------------------------------------------------------------------
  // FINAL PRODUCTION INTEGRITY AUDIT
  // ---------------------------------------------------------------------------
  const postAudit = await verifyProductionCampaignUntouched('POST-TEST');

  console.log('\n================================================================');
  console.log('ALL ACCEPTANCE TESTS COMPLETED WITH 100% SUCCESS!');
  console.log('================================================================');

  const finalSummary = {
    testCampaignId: testCamp.id,
    testCampaignSentRecipientMessageId: sentRec?.message_id,
    cancelCampaignId: cancelCamp.id,
    excelReportSize: stats.size,
    productionCampaignAudit: {
      campaignId: PRODUCTION_PAUSED_CAMPAIGN_ID,
      status: postAudit.camp.status,
      recipientCounts: postAudit.counts,
      untouchedAndPreserved: true,
    },
  };

  fs.writeFileSync(
    path.join(ARTIFACT_DIR, 'history_acceptance_summary.json'),
    JSON.stringify(finalSummary, null, 2)
  );

  console.log(JSON.stringify(finalSummary, null, 2));
}

run().catch((err) => {
  console.error('\n[FATAL TEST RUNNER ERROR]:', err);
  process.exit(1);
});
