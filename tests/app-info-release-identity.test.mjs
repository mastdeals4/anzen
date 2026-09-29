import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const appInfoPath = resolve(process.cwd(), 'src/config/appInfo.ts');
const aboutSystemPath = resolve(process.cwd(), 'src/components/settings/AboutSystem.tsx');

const appInfoSrc = readFileSync(appInfoPath, 'utf8');
const aboutSystemSrc = readFileSync(aboutSystemPath, 'utf8');

test('1. Central Application Release Identity in appInfo.ts', () => {
  // Check version
  assert.match(appInfoSrc, /version:\s*'v1\.5\.0'/, 'APP_INFO.version must be v1.5.0');
  // Check build date remains automatic Vite build date
  assert.match(appInfoSrc, /buildDate:\s*__BUILD_DATE__/, 'APP_INFO.buildDate must remain __BUILD_DATE__');
});

test('2. VERSION_HISTORY newest entry in appInfo.ts', () => {
  // Check v1.5.0 entry
  assert.match(appInfoSrc, /version:\s*'v1\.5\.0'/, 'v1.5.0 version must exist');
  assert.match(appInfoSrc, /date:\s*'2026-09-29'/, 'v1.5.0 date must be 2026-09-29');
  assert.match(appInfoSrc, /title:\s*'CRM, Pricing & Omnichannel Operations'/, 'v1.5.0 title must match');
  assert.ok(
    appInfoSrc.includes(
      'Expanded SAPJ production operations with consolidated CRM navigation, Excel-style inquiry/pricing workflows, Kunal Pricing AI, Gmail thread evidence, WhatsApp omnichannel integration, pricing/status corrections, document traceability, and responsive navigation improvements.',
    ),
    'v1.5.0 summary must match requested text',
  );

  // Check previous releases remain intact
  assert.ok(appInfoSrc.includes("'v1.4.0'"), 'v1.4.0 must remain in history');
  assert.ok(appInfoSrc.includes("'v1.3.1'"), 'v1.3.1 must remain in history');
  assert.ok(appInfoSrc.includes("'v1.3.0'"), 'v1.3.0 must remain in history');
  assert.ok(appInfoSrc.includes("'v1.2.0'"), 'v1.2.0 must remain in history');
  assert.ok(appInfoSrc.includes("'v1.1.0'"), 'v1.1.0 must remain in history');
  assert.ok(appInfoSrc.includes("'v1.0.0'"), 'v1.0.0 must remain in history');
});

test('3. Settings -> About and Validation PDF use central appInfo', () => {
  // AboutSystem imports from appInfo
  assert.match(aboutSystemSrc, /import\s*\{[^}]*APP_INFO[^}]*\}\s*from\s*'\.\.\/\.\.\/config\/appInfo'/);
  assert.match(aboutSystemSrc, /const\s+currentVersion\s*=\s*VERSION_HISTORY\[0\];/);
  // Validation report uses APP_INFO.version
  assert.ok(
    aboutSystemSrc.includes('doc.save(`${APP_INFO.name.replace(/\\s+/g, \'_\')}_Validation_Report_${APP_INFO.version}.pdf`);'),
    'Validation PDF filename must use APP_INFO.version',
  );
  assert.ok(
    aboutSystemSrc.includes('kv(\'Version\', APP_INFO.version);'),
    'Validation PDF content must use APP_INFO.version',
  );
});
