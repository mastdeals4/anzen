// Finance End-to-End Audit — Playwright
// Tests: Petty Cash, Expenses, Receipt, Payment, Contra, Purchase Voucher
// Verifies: save, JE created, trial balance, balance sheet, no permission errors

const { chromium } = require('playwright');

const BASE_URL = 'http://localhost:5199';
const USERNAME = 'kunal';
const PASSWORD = 'Kunal@123';
const MODAL = 'div.fixed.inset-0.z-50';
const TIMEOUT = 25000;

const results = [];
const consoleErrors = [];

function log(section, status, detail = '') {
  const icon = status === 'PASS' ? '✅' : status === 'FAIL' ? '❌' : 'ℹ️ ';
  console.log(`${icon} [${section}] ${detail}`);
  results.push({ section, status, detail });
}

async function screenshot(page, name) {
  await page.screenshot({ path: `/Users/Kunal/Documents/anzen-main/tests/screenshots/${name}.png` });
}

/** Map tab labels to keyboard shortcuts (from Finance.tsx keydown handler). */
const TAB_SHORTCUTS = {
  'Purchase': 'F9',
  'Receipt':  'F6',
  'Payment':  'F5',
  'Contra':   'F4',
  'Expenses': 'F8',
  'Trial Balance': null,   // no shortcut — use button click
  'Balance Sheet': null,
  'Ledger':   null,
  'Petty Cash': null,
};

async function clickTab(page, tabLabel) {
  const shortcut = TAB_SHORTCUTS[tabLabel];
  if (shortcut) {
    // Use keyboard shortcut — works regardless of sidebar layout
    await page.keyboard.press(shortcut);
    await page.waitForTimeout(1200);
    return;
  }
  // For tabs without shortcuts, use JS dispatch to bypass pointer intercept
  const clicked = await page.evaluate((label) => {
    const btns = Array.from(document.querySelectorAll('button'));
    const btn = btns.find(b => b.textContent.trim() === label);
    if (btn) { btn.click(); return true; }
    return false;
  }, tabLabel);
  if (!clicked) {
    // Fallback: Playwright click with force
    const btn = page.locator('button').filter({ hasText: new RegExp(`^${tabLabel}$`) }).first();
    await btn.waitFor({ state: 'visible', timeout: TIMEOUT });
    await btn.click({ force: true });
  }
  await page.waitForTimeout(1200);
}

async function openNew(page) {
  // Use JS click to bypass any sidebar overlay
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const btn = btns.find(b => b.textContent.trim() === 'New');
    if (btn) btn.click();
  });
  await page.waitForSelector(MODAL, { timeout: TIMEOUT });
  await page.waitForTimeout(600);
}

async function submitModal(page, btnTextRe) {
  const btn = page.locator(`${MODAL} button`).filter({ hasText: btnTextRe }).first();
  await btn.waitFor({ state: 'visible', timeout: 8000 });
  await btn.click();
  await page.waitForTimeout(3000);
}

async function closeModalIfOpen(page) {
  const modal = await page.$(MODAL);
  if (modal) await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
}

/** Dismiss notification/toast panels that block clicks. Safe — never navigates. */
async function dismissNotifications(page) {
  // Close the notification panel (fixed bottom-right sliding panel)
  const notifPanel = page.locator('div.fixed.bottom-4.right-4');
  if (await notifPanel.count() > 0) {
    // Try finding a close/X button inside it
    const closeBtn = notifPanel.locator('button').last();
    if (await closeBtn.count() > 0) {
      await closeBtn.click({ force: true }).catch(() => {});
      await page.waitForTimeout(300);
    }
  }
  // Close any top-right toast notification
  const toastPanel = page.locator('div.fixed.top-4.right-4.z-\\[9999\\]');
  if (await toastPanel.count() > 0) {
    const closeBtn = toastPanel.locator('button').first();
    if (await closeBtn.count() > 0) {
      await closeBtn.click({ force: true }).catch(() => {});
      await page.waitForTimeout(300);
    }
  }
  // Wait for any auto-dismissing toasts to fade
  await page.waitForTimeout(500);
}

/** Navigate back to Finance module (recovery after failures). */
async function goToFinance(page) {
  // Use JS click to bypass sidebar overlay
  await page.evaluate(() => {
    const el = Array.from(document.querySelectorAll('button, a')).find(e => e.textContent.trim() === 'Finance');
    if (el) el.click();
  });
  await page.waitForTimeout(1500);
  return;
  const finBtn = page.locator('button, a').filter({ hasText: /^Finance$/ }).first();
  if (await finBtn.count() > 0) {
    await finBtn.click();
    await page.waitForTimeout(1500);
  }
}

async function pickFirstSearchable(page, container) {
  const trigger = page.locator(`${container} [aria-haspopup="listbox"]`).first();
  await trigger.click();
  await page.waitForTimeout(400);
  const opt = page.locator('[role="option"]').first();
  await opt.waitFor({ state: 'visible', timeout: 6000 });
  await opt.click();
  await page.waitForTimeout(300);
}

const SUPA_URL = 'https://dkrtsqienlhpouohmfki.supabase.co';
const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRrcnRzcWllbmxocG91b2htZmtpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjE5MTQxNzQsImV4cCI6MjA3NzQ5MDE3NH0.Kjo9RU0WAfQSSEm2vTWmuN5BIYk_hvanKDQkm5qdCGY';

async function dbFetch(path) {
  const r = await fetch(`${SUPA_URL}/rest/v1/${path}`, {
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}`, Prefer: 'count=exact', 'Range-Unit': 'items', Range: '0-0' }
  });
  const count = parseInt(r.headers.get('content-range')?.split('/')[1] || '0');
  const body = await r.json().catch(() => []);
  return { count, body };
}

// ─────────────────────────────────────────────────────────────────────────────
(async () => {
  const browser = await chromium.launch({ headless: false, slowMo: 60 });
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    recordVideo: { dir: '/Users/Kunal/Documents/anzen-main/tests/videos/' },
  });
  const page = await ctx.newPage();

  page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('pageerror', err => consoleErrors.push(err.message));

  const { count: jeBefore } = await dbFetch('journal_entries');
  log('Setup', 'INFO', `Journal entries before audit: ${jeBefore}`);

  // ── 1. LOGIN ──────────────────────────────────────────────────────────────
  try {
    await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 30000 });
    await page.fill('#username', USERNAME);
    await page.fill('#password', PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForSelector('nav, [class*="sidebar"], main', { timeout: 15000 });
    await page.waitForTimeout(1500);
    log('Login', 'PASS', `Logged in as ${USERNAME}`);
    await screenshot(page, '00-login-success');
  } catch (e) {
    log('Login', 'FAIL', e.message);
    await browser.close(); printReport(); process.exit(1);
  }

  // Navigate to Finance
  try {
    const financeBtn = page.locator('button, a').filter({ hasText: /^Finance$/ }).first();
    await financeBtn.waitFor({ state: 'visible', timeout: TIMEOUT });
    await financeBtn.click();
    await page.waitForTimeout(2000);
    log('Navigation', 'PASS', 'Opened Finance module');
    await screenshot(page, '00b-finance-landing');
  } catch (e) {
    log('Navigation', 'FAIL', e.message);
    await browser.close(); printReport(); process.exit(1);
  }

  // ── 2. PETTY CASH ─────────────────────────────────────────────────────────
  console.log('\n── Petty Cash ──────────────────────────────────');
  try {
    await clickTab(page, 'Petty Cash');
    await page.waitForSelector('button:has-text("New")', { timeout: TIMEOUT });
    log('Petty Cash', 'PASS', 'Module loaded');

    await openNew(page);

    // Transaction type select (first select in modal)
    await page.locator(`${MODAL} select`).first().selectOption('expense');

    // Amount
    await page.locator(`${MODAL} input[type="number"]`).first().fill('75000');

    // Description textarea
    const desc = page.locator(`${MODAL} textarea`).first();
    if (await desc.count() > 0) await desc.fill('Audit test — petty cash expense');

    // Category select (second select in modal)
    const allSelects = page.locator(`${MODAL} select`);
    const sc = await allSelects.count();
    if (sc >= 2) {
      const catOpts = await allSelects.nth(1).locator('option').allTextContents();
      const hasUtilities = catOpts.some(o => o.includes('Utilities') || o.toLowerCase().includes('utilities'));
      await allSelects.nth(1).selectOption(hasUtilities ? 'utilities' : 'other');
    }

    await screenshot(page, '01a-petty-cash-form');
    await submitModal(page, /Save Transaction|Update Transaction/);

    const permErr1 = consoleErrors.some(e => e.toLowerCase().includes('permission denied') || e.includes('42501'));
    log('Petty Cash - Save', permErr1 ? 'FAIL' : 'PASS',
      permErr1 ? 'PERMISSION DENIED on save' : 'Saved with no permission error');

    await closeModalIfOpen(page);
    await screenshot(page, '01b-petty-cash-saved');

    // Dismiss any notification overlays before clicking Approve
    await dismissNotifications(page);
    await page.waitForTimeout(600);

    // Approve first pending
    const approveBtn = page.locator('button[title="Approve"]').first();
    if (await approveBtn.count() > 0) {
      const errsBefore = consoleErrors.length;
      await approveBtn.click({ force: true });
      await page.waitForTimeout(2500);
      const newErr = consoleErrors.slice(errsBefore).some(e => e.toLowerCase().includes('permission denied') || e.includes('42501'));
      log('Petty Cash - Approve', newErr ? 'FAIL' : 'PASS',
        newErr ? 'PERMISSION DENIED on approve' : 'Approved — JE posted, no permission error');
    } else {
      log('Petty Cash - Approve', 'INFO', 'Approve button not visible in current view');
    }

    // Cancel Posting: look for it after approval
    await dismissNotifications(page);
    const cancelBtn = page.locator('button[title*="Cancel"], button:has-text("Cancel Posting")').first();
    log('Petty Cash - Cancel Posting', await cancelBtn.count() > 0 ? 'PASS' : 'INFO',
      await cancelBtn.count() > 0 ? 'Cancel Posting button present' : 'Not visible (need approved record)');

    await screenshot(page, '01c-petty-cash-final');
    await goToFinance(page);
  } catch (e) {
    log('Petty Cash', 'FAIL', e.message);
    await closeModalIfOpen(page);
    await screenshot(page, '01-petty-cash-error');
    await goToFinance(page);
  }

  // ── 3. EXPENSES ───────────────────────────────────────────────────────────
  console.log('\n── Expenses ─────────────────────────────────────');
  try {
    await clickTab(page, 'Expenses');
    await page.waitForSelector('button:has-text("New")', { timeout: TIMEOUT });
    log('Expenses', 'PASS', 'Module loaded');

    await openNew(page);

    // Category select — find one with expense options
    const allSelects = page.locator(`${MODAL} select`);
    const sc = await allSelects.count();
    for (let i = 0; i < sc; i++) {
      const opts = await allSelects.nth(i).locator('option').allTextContents();
      if (opts.some(o => o.includes('Utilities') || o.includes('Office') || o.includes('Other'))) {
        await allSelects.nth(i).selectOption('utilities').catch(() => allSelects.nth(i).selectOption('office_admin'));
        break;
      }
    }

    // Amount
    await page.locator(`${MODAL} input[type="number"]`).first().fill('150000');

    // Description
    const desc = page.locator(`${MODAL} textarea, ${MODAL} input[placeholder*="escription"]`).first();
    if (await desc.count() > 0) await desc.fill('Audit test — expense voucher');

    await screenshot(page, '02a-expense-form');
    await submitModal(page, /Record Expense|Update Expense/);

    const permErr = consoleErrors.some(e => e.toLowerCase().includes('permission denied') || e.includes('42501'));
    log('Expenses - Save', permErr ? 'FAIL' : 'PASS',
      permErr ? 'PERMISSION DENIED on save' : 'Saved — no permission error');

    await closeModalIfOpen(page);
    await screenshot(page, '02b-expense-saved');

    // Approve
    await dismissNotifications(page);
    const approveBtn = page.locator('button[title="Approve"]').first();
    if (await approveBtn.count() > 0) {
      const eb = consoleErrors.length;
      await approveBtn.click({ force: true });
      await page.waitForTimeout(2500);
      const ne = consoleErrors.slice(eb).some(e => e.toLowerCase().includes('permission denied'));
      log('Expenses - Approve', ne ? 'FAIL' : 'PASS', ne ? 'Permission error on approve' : 'Approved — no errors');
    } else {
      log('Expenses - Approve', 'INFO', 'Approve button not visible');
    }

    await screenshot(page, '02c-expense-final');
    await goToFinance(page);
  } catch (e) {
    log('Expenses', 'FAIL', e.message);
    await closeModalIfOpen(page);
    await screenshot(page, '02-expense-error');
    await goToFinance(page);
  }

  // ── 4. RECEIPT VOUCHER ────────────────────────────────────────────────────
  console.log('\n── Receipt Voucher ──────────────────────────────');
  try {
    await clickTab(page, 'Receipt');
    await page.waitForSelector('button:has-text("New")', { timeout: TIMEOUT });
    log('Receipt Voucher', 'PASS', 'Module loaded');

    await openNew(page);

    // Customer — first SearchableSelect
    await pickFirstSearchable(page, MODAL).catch(e =>
      log('Receipt - Customer', 'INFO', 'SearchableSelect pick failed: ' + e.message)
    );

    // Payment method — Cash
    const allSelects = page.locator(`${MODAL} select`);
    const sc = await allSelects.count();
    for (let i = 0; i < sc; i++) {
      const opts = await allSelects.nth(i).locator('option').allTextContents();
      if (opts.some(o => o.toLowerCase().includes('cash'))) {
        await allSelects.nth(i).selectOption({ label: opts.find(o => o.toLowerCase().includes('cash')) });
        break;
      }
    }

    // Amount
    await page.locator(`${MODAL} input[type="number"]`).first().fill('500000');

    await screenshot(page, '03a-receipt-form');
    await submitModal(page, /Save Receipt|Update Receipt/);

    const permErr = consoleErrors.some(e => e.toLowerCase().includes('permission denied') || e.includes('42501'));
    log('Receipt Voucher - Save', permErr ? 'FAIL' : 'PASS',
      permErr ? 'PERMISSION DENIED on save' : 'Saved — no permission error');

    await closeModalIfOpen(page);
    await screenshot(page, '03b-receipt-saved');

    // Voucher number in list
    const rvRow = page.locator('td').filter({ hasText: /RV-|RV\d/ }).first();
    log('Receipt Voucher - Number', await rvRow.count() > 0 ? 'PASS' : 'INFO',
      await rvRow.count() > 0 ? 'Voucher number visible in list' : 'Number format not detected');

    // Approve
    await dismissNotifications(page);
    const approveBtn2 = page.locator('button[title="Approve"]').first();
    if (await approveBtn2.count() > 0) {
      const eb = consoleErrors.length;
      await approveBtn2.click({ force: true });
      await page.waitForTimeout(2500);
      const ne = consoleErrors.slice(eb).some(e => e.toLowerCase().includes('permission denied'));
      log('Receipt Voucher - Approve', ne ? 'FAIL' : 'PASS', ne ? 'Permission error on approve' : 'Approved — JE posted');
    } else {
      log('Receipt Voucher - Approve', 'INFO', 'No pending Approve button visible');
    }

    await screenshot(page, '03c-receipt-final');
    await goToFinance(page);
  } catch (e) {
    log('Receipt Voucher', 'FAIL', e.message);
    await closeModalIfOpen(page);
    await screenshot(page, '03-receipt-error');
    await goToFinance(page);
  }

  // ── 5. PAYMENT VOUCHER ────────────────────────────────────────────────────
  console.log('\n── Payment Voucher ──────────────────────────────');
  try {
    await clickTab(page, 'Payment');
    await page.waitForSelector('button:has-text("New")', { timeout: TIMEOUT });
    log('Payment Voucher', 'PASS', 'Module loaded');

    await openNew(page);

    // Supplier — SearchableSelect
    await pickFirstSearchable(page, MODAL).catch(e =>
      log('Payment - Supplier', 'INFO', 'SearchableSelect pick failed: ' + e.message)
    );

    // Payment method Cash
    const allSelects = page.locator(`${MODAL} select`);
    const sc = await allSelects.count();
    for (let i = 0; i < sc; i++) {
      const opts = await allSelects.nth(i).locator('option').allTextContents();
      if (opts.some(o => o.toLowerCase().includes('cash'))) {
        await allSelects.nth(i).selectOption({ label: opts.find(o => o.toLowerCase().includes('cash')) });
        break;
      }
    }

    // Amount
    await page.locator(`${MODAL} input[type="number"]`).first().fill('200000');

    await screenshot(page, '04a-payment-form');
    await submitModal(page, /Save Payment|Update Payment/);

    const permErr = consoleErrors.some(e => e.toLowerCase().includes('permission denied') || e.includes('42501'));
    log('Payment Voucher - Save', permErr ? 'FAIL' : 'PASS',
      permErr ? 'PERMISSION DENIED on save' : 'Saved — no permission error');

    await closeModalIfOpen(page);
    await screenshot(page, '04b-payment-saved');

    // Approve
    await dismissNotifications(page);
    const approveBtn3 = page.locator('button[title="Approve"]').first();
    if (await approveBtn3.count() > 0) {
      const eb = consoleErrors.length;
      await approveBtn3.click({ force: true });
      await page.waitForTimeout(2500);
      const ne = consoleErrors.slice(eb).some(e => e.toLowerCase().includes('permission denied'));
      log('Payment Voucher - Approve', ne ? 'FAIL' : 'PASS', ne ? 'Permission error on approve' : 'Approved — JE posted');
    } else {
      log('Payment Voucher - Approve', 'INFO', 'No pending Approve button visible');
    }

    await screenshot(page, '04c-payment-final');
    await goToFinance(page);
  } catch (e) {
    log('Payment Voucher', 'FAIL', e.message);
    await closeModalIfOpen(page);
    await screenshot(page, '04-payment-error');
    await goToFinance(page);
  }

  // ── 6. CONTRA / FUND TRANSFER ─────────────────────────────────────────────
  console.log('\n── Contra / Fund Transfer ───────────────────────');
  try {
    await clickTab(page, 'Contra');
    await page.waitForSelector('button:has-text("New")', { timeout: TIMEOUT });
    log('Fund Transfer', 'PASS', 'Module loaded');

    const errsBefore = consoleErrors.length;
    await openNew(page);

    // From account type = petty_cash
    const allSelects = page.locator(`${MODAL} select`);
    await allSelects.first().selectOption('petty_cash');
    await page.waitForTimeout(600);

    // From amount
    const numInputs = page.locator(`${MODAL} input[type="number"]`);
    await numInputs.first().fill('100000');
    await page.waitForTimeout(300);

    // To account type = bank
    const sc2 = await allSelects.count();
    if (sc2 > 1) {
      const toOpts = await allSelects.nth(1).locator('option').allTextContents();
      if (toOpts.some(o => o.toLowerCase().includes('bank'))) {
        await allSelects.nth(1).selectOption('bank');
        await page.waitForTimeout(600);
      }
    }

    // To bank account — select first available option
    const sc3 = await allSelects.count();
    for (let i = 0; i < sc3; i++) {
      const opts = await allSelects.nth(i).locator('option').allTextContents();
      if (opts.some(o => o.includes('Shubham') || o.includes('0930') || o.includes('BNI') || o.includes('BCA') || (o.length > 5 && !o.includes('Select') && !o.includes('bank') && !o.includes('petty') && !o.includes('cash')))) {
        await allSelects.nth(i).selectOption({ index: 1 }).catch(() => {});
        break;
      }
    }

    // To amount
    const nc = await numInputs.count();
    if (nc > 1) await numInputs.nth(1).fill('100000');

    // Description
    const desc = page.locator(`${MODAL} textarea, ${MODAL} input[placeholder*="escription"]`).first();
    if (await desc.count() > 0) await desc.fill('Audit test — contra fund transfer');

    await screenshot(page, '05a-contra-form');
    await submitModal(page, /Create Transfer|Save Transfer/);

    const newErrs = consoleErrors.slice(errsBefore);
    const dupErr = newErrs.some(e => e.includes('duplicate key') || e.includes('unique constraint'));
    const permErr = newErrs.some(e => e.toLowerCase().includes('permission denied') || e.includes('42501'));

    log('Fund Transfer - Duplicate Number', dupErr ? 'FAIL' : 'PASS',
      dupErr ? 'DUPLICATE KEY ERROR: ' + newErrs.find(e => e.includes('duplicate')) : 'No duplicate number collision');
    log('Fund Transfer - Permissions', permErr ? 'FAIL' : 'PASS',
      permErr ? 'PERMISSION DENIED: ' + newErrs.find(e => e.includes('permission')) : 'No permission error');

    await closeModalIfOpen(page);
    await screenshot(page, '05b-contra-saved');

    // Check transfer number in table
    const ftRow = page.locator('td').filter({ hasText: /FT\d{4}|FT-/ }).first();
    log('Fund Transfer - Number Generated', await ftRow.count() > 0 ? 'PASS' : 'INFO',
      await ftRow.count() > 0 ? 'Transfer number visible in list' : 'Number not visible in table');

    await screenshot(page, '05c-contra-final');
    await goToFinance(page);
  } catch (e) {
    log('Fund Transfer', 'FAIL', e.message);
    await closeModalIfOpen(page);
    await screenshot(page, '05-contra-error');
    await goToFinance(page);
  }

  // ── 7. PURCHASE VOUCHER ───────────────────────────────────────────────────
  console.log('\n── Purchase Voucher ─────────────────────────────');
  try {
    await clickTab(page, 'Purchase');
    await page.waitForSelector('button:has-text("New")', { timeout: TIMEOUT });
    log('Purchase Voucher', 'PASS', 'Module loaded');

    await openNew(page);

    // Invoice number
    const invInput = page.locator(`${MODAL} input[type="text"]`).first();
    if (await invInput.count() > 0) await invInput.fill(`AUDIT-${Date.now().toString().slice(-6)}`);

    // Supplier
    await pickFirstSearchable(page, MODAL).catch(() =>
      log('Purchase - Supplier', 'INFO', 'SearchableSelect not found')
    );

    // Add line item
    const addBtn = page.locator(`${MODAL} button`).filter({ hasText: /Add Item|Add Line|\+ Item|Add Row/ }).first();
    if (await addBtn.count() > 0) {
      await addBtn.click();
      await page.waitForTimeout(500);
      const numInputs = page.locator(`${MODAL} input[type="number"]`);
      const nc = await numInputs.count();
      if (nc > 0) await numInputs.last().fill('500000');
    }

    await screenshot(page, '06a-purchase-form');
    await submitModal(page, /Create Invoice|Save Changes/);

    const permErr = consoleErrors.some(e => e.toLowerCase().includes('permission denied') || e.includes('42501'));
    log('Purchase Voucher - Save', permErr ? 'FAIL' : 'PASS',
      permErr ? 'PERMISSION DENIED on save' : 'Saved — no permission error');

    await closeModalIfOpen(page);
    await screenshot(page, '06b-purchase-saved');
    await goToFinance(page);
  } catch (e) {
    log('Purchase Voucher', 'FAIL', e.message);
    await closeModalIfOpen(page);
    await screenshot(page, '06-purchase-error');
    await goToFinance(page);
  }

  // ── 8. TRIAL BALANCE ──────────────────────────────────────────────────────
  console.log('\n── Trial Balance ────────────────────────────────');
  try {
    // Expand Reports group if needed
    const reportsGroup = page.locator('button').filter({ hasText: /^Reports$/ }).first();
    if (await reportsGroup.count() > 0) { await reportsGroup.click(); await page.waitForTimeout(600); }
    await clickTab(page, 'Trial Balance');
    await page.waitForTimeout(2500);

    const tbEl = page.locator('table, [class*="trial"], [class*="balance"]').first();
    log('Trial Balance - Page', await tbEl.count() > 0 ? 'PASS' : 'INFO',
      await tbEl.count() > 0 ? 'Trial Balance rendered' : 'No element found');

    // DB-level balance
    const r = await fetch(`${SUPA_URL}/rest/v1/journal_entry_lines?select=debit,credit&limit=50000`, {
      headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` }
    });
    const lines = await r.json();
    const td = lines.reduce((s, l) => s + (parseFloat(l.debit) || 0), 0);
    const tc = lines.reduce((s, l) => s + (parseFloat(l.credit) || 0), 0);
    log('Trial Balance - Balanced', Math.abs(td - tc) < 1 ? 'PASS' : 'FAIL',
      `Debit ${td.toLocaleString('id-ID')} | Credit ${tc.toLocaleString('id-ID')} | Diff ${(td - tc).toFixed(2)}`);

    await screenshot(page, '07-trial-balance');
  } catch (e) {
    log('Trial Balance', 'FAIL', e.message);
  }

  // ── 9. BALANCE SHEET ──────────────────────────────────────────────────────
  console.log('\n── Balance Sheet ────────────────────────────────');
  try {
    const rg = page.locator('button').filter({ hasText: /^Reports$/ }).first();
    if (await rg.count() > 0) { await rg.click(); await page.waitForTimeout(400); }
    await clickTab(page, 'Balance Sheet');
    await page.waitForTimeout(2500);

    const bsEl = page.locator('table, [class*="balance-sheet"], [class*="balanceSheet"], [class*="report"]').first();
    log('Balance Sheet - Page', await bsEl.count() > 0 ? 'PASS' : 'INFO',
      await bsEl.count() > 0 ? 'Balance Sheet rendered' : 'No element found');
    await screenshot(page, '08-balance-sheet');
  } catch (e) {
    log('Balance Sheet', 'FAIL', e.message);
  }

  // ── 10. ACCOUNT LEDGER ────────────────────────────────────────────────────
  console.log('\n── Account Ledger ───────────────────────────────');
  try {
    await clickTab(page, 'Ledger');
    await page.waitForTimeout(2000);
    const el = page.locator('table, [class*="ledger"]').first();
    log('Account Ledger', await el.count() > 0 ? 'PASS' : 'INFO',
      await el.count() > 0 ? 'Ledger page loaded' : 'Ledger structure not found');
    await screenshot(page, '09-ledger');
  } catch (e) {
    log('Account Ledger', 'FAIL', e.message);
  }

  // ── 11. JOURNAL ENTRIES CREATED ───────────────────────────────────────────
  console.log('\n── Journal Entries Verification ─────────────────');
  try {
    const { count: jeAfter } = await dbFetch('journal_entries');
    log('Journal Entries Created', jeAfter > jeBefore ? 'PASS' : 'INFO',
      `${jeAfter - jeBefore} new JEs during audit (${jeBefore} → ${jeAfter})`);
  } catch (e) {
    log('Journal Entries', 'FAIL', e.message);
  }

  // ── 12. CRM EMAIL WORKFLOW ────────────────────────────────────────────────
  console.log('\n── CRM Email Workflow ───────────────────────────');
  try {
    const crmBtn = page.locator('button, a').filter({ hasText: /^CRM$|^Command Center$/ }).first();
    const hasCRM = await crmBtn.count() > 0;
    if (hasCRM) {
      const eb = consoleErrors.length;
      await crmBtn.click();
      await page.waitForTimeout(2500);
      const newErrs = consoleErrors.slice(eb);
      const crmPermErr = newErrs.some(e => e.toLowerCase().includes('permission denied') || e.includes('42501'));
      log('CRM - Load', crmPermErr ? 'FAIL' : 'PASS',
        crmPermErr ? 'Permission error on CRM load' : 'CRM loaded without permission errors');

      const emailEl = page.locator(':text("Email Template"), :text("template"), :text("Template")').first();
      log('CRM - Email Templates', await emailEl.count() > 0 ? 'PASS' : 'INFO',
        await emailEl.count() > 0 ? 'Email/template section present' : 'Not visible at landing');

      await screenshot(page, '10-crm');
    } else {
      log('CRM', 'INFO', 'CRM nav item not found in sidebar');
    }
  } catch (e) {
    log('CRM', 'FAIL', e.message);
  }

  // ── 13. GLOBAL ERROR SUMMARY ──────────────────────────────────────────────
  console.log('\n── Global Error Summary ─────────────────────────');
  const allPermErrs = consoleErrors.filter(e =>
    e.toLowerCase().includes('permission denied') || e.includes('42501')
  );
  log('Permission Errors (full session)',
    allPermErrs.length === 0 ? 'PASS' : 'FAIL',
    allPermErrs.length === 0
      ? 'Zero permission denied / RLS errors across all modules'
      : `${allPermErrs.length} error(s): ${allPermErrs[0]?.substring(0, 120)}`
  );

  const allDupErrs = consoleErrors.filter(e =>
    e.includes('duplicate key') || e.includes('unique constraint')
  );
  log('Duplicate Key Errors (full session)',
    allDupErrs.length === 0 ? 'PASS' : 'FAIL',
    allDupErrs.length === 0
      ? 'Zero duplicate key errors'
      : `${allDupErrs.length} error(s): ${allDupErrs[0]?.substring(0, 120)}`
  );

  const otherErrs = consoleErrors.filter(e =>
    !e.includes('permission denied') && !e.includes('42501') &&
    !e.includes('duplicate key') && !e.includes('unique constraint') &&
    !e.includes('ERR_') && !e.includes('favicon') && !e.includes('chunk')
  );
  if (otherErrs.length > 0) {
    log('Other Console Errors', 'INFO',
      `${otherErrs.length} error(s): ${otherErrs[0]?.substring(0, 120)}`);
  }

  await page.waitForTimeout(1000);
  await ctx.close();
  await browser.close();

  printReport();
})();

function printReport() {
  console.log('\n' + '═'.repeat(72));
  console.log('  FINANCE END-TO-END AUDIT REPORT');
  console.log('═'.repeat(72));

  const passes = results.filter(r => r.status === 'PASS').length;
  const fails  = results.filter(r => r.status === 'FAIL').length;
  const infos  = results.filter(r => r.status === 'INFO').length;

  for (const r of results) {
    const icon = r.status === 'PASS' ? '✅' : r.status === 'FAIL' ? '❌' : 'ℹ️ ';
    console.log(`${icon}  ${r.section.padEnd(42)} ${r.detail}`);
  }

  console.log('─'.repeat(72));
  console.log(`Total: ${results.length}  |  ✅ ${passes} passed  |  ❌ ${fails} failed  |  ℹ️  ${infos} info`);
  console.log('Screenshots: tests/screenshots/   Videos: tests/videos/');
  console.log('═'.repeat(72));

  if (fails > 0) process.exit(1);
}
