import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const drawerFile = readFileSync(
  new URL('../src/components/crm/enquiry-control-center/EnquiryDetailDrawer.tsx', import.meta.url),
  'utf8',
);
const convTimelineFile = readFileSync(
  new URL('../src/components/crm/enquiry-control-center/ConversationTimeline.tsx', import.meta.url),
  'utf8',
);
const docsListFile = readFileSync(
  new URL('../src/components/crm/enquiry-control-center/DocumentsList.tsx', import.meta.url),
  'utf8',
);
const requestCardFile = readFileSync(
  new URL('../src/components/crm/enquiry-control-center/RequestCard.tsx', import.meta.url),
  'utf8',
);
const barrelIndexFile = readFileSync(
  new URL('../src/components/crm/enquiry-control-center/index.ts', import.meta.url),
  'utf8',
);
const foundationMigration = readFileSync(
  new URL('../supabase/migrations/20260914150000_enquiry_control_center_foundation.sql', import.meta.url),
  'utf8',
);

function runDbScript(sql) {
  const tmpPath = join(tmpdir(), `phase74_test_${Date.now()}_${Math.random().toString(36).slice(2)}.sql`);
  writeFileSync(tmpPath, sql, 'utf8');
  try {
    const cmd = `npx supabase db query --linked --file "${tmpPath}"`;
    const output = execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    const parsed = JSON.parse(output);
    return parsed.rows || [];
  } catch (err) {
    throw new Error(`Database query failed: ${err.stderr || err.stdout || err.message}`);
  } finally {
    try { unlinkSync(tmpPath); } catch {}
  }
}

// ============================================================================
// 1. Enquiry with no conversation
// ============================================================================
test('1. Enquiry with no conversation renders clean empty state', () => {
  assert.match(convTimelineFile, /No canonical conversation linked to this enquiry\./);
  assert.match(convTimelineFile, /Incoming and outgoing emails mapped to \{currentInquiryNumber\} will appear here/);
});

// ============================================================================
// 2. Enquiry with one conversation
// ============================================================================
test('2. Enquiry with one conversation loads and renders canonical messages', () => {
  assert.match(drawerFile, /from\('enquiry_conversation_links'\)/);
  assert.match(drawerFile, /from\('enquiry_conversation_messages'\)/);
  assert.match(convTimelineFile, /export const ConversationTimeline/);
});

// ============================================================================
// 3. Multiple messages & 4. Chronological ordering
// ============================================================================
test('3 & 4. Multiple messages sorted in continuous ascending chronological order', () => {
  assert.match(convTimelineFile, /new Date\(a\.received_or_sent_at\)\.getTime\(\) - new Date\(b\.received_or_sent_at\)\.getTime\(\)/);
  assert.match(drawerFile, /\.order\('received_or_sent_at', \{ ascending: true \}\)/);
});

// ============================================================================
// 5. Message direction (inbound / outbound / internal)
// ============================================================================
test('5. Message direction distinction (inbound vs outbound vs internal)', () => {
  assert.match(convTimelineFile, /msg\.direction === 'outbound'/);
  assert.match(convTimelineFile, /msg\.direction === 'internal'/);
  assert.match(convTimelineFile, /Outbound/);
  assert.match(convTimelineFile, /Inbound/);
  assert.match(convTimelineFile, /ArrowUpRight/);
  assert.match(convTimelineFile, /ArrowDownLeft/);
});

// ============================================================================
// 6. Sender / recipient display
// ============================================================================
test('6. Sender and recipient addresses displayed faithfully', () => {
  assert.match(convTimelineFile, /From:\s*<\/span>/);
  assert.match(convTimelineFile, /msg\.sender_name \? `\$\{msg\.sender_name\} <\$\{msg\.sender_address\}>` : msg\.sender_address/);
  assert.match(convTimelineFile, /To:\s*<\/span>/);
  assert.match(convTimelineFile, /msg\.recipient_addresses\.join\(', '\)/);
});

// ============================================================================
// 7. Attachment metadata & download
// ============================================================================
test('7. Message attachment metadata displayed without duplicating files in storage', () => {
  assert.match(convTimelineFile, /Attachments \(\{rawAttachments\.length\}\)/);
  assert.match(convTimelineFile, /getSignedUrlCached\(bucket, path, 3600/);
  // Must NOT upload or duplicate attachments to new tables
  assert.doesNotMatch(convTimelineFile, /supabase\.storage\.from\(.+\)\.upload/);
  assert.doesNotMatch(convTimelineFile, /enquiry_attachments/);
});

// ============================================================================
// 8. Multi-enquiries linked to one conversation
// ============================================================================
test('8. Multi-enquiry conversation clearly surfaced without assuming 1:1', () => {
  assert.match(convTimelineFile, /Multi-Enquiry Conversation Thread/);
  assert.match(convTimelineFile, /This thread also links to:/);
  assert.match(convTimelineFile, /oe\.inquiry_number\} \(\{oe\.link_type\}\)/);
});

// ============================================================================
// 9. Unlinked conversation is not incorrectly shown
// ============================================================================
test('9. Drawer only queries conversations explicitly linked to the selected enquiry', () => {
  assert.match(drawerFile, /\.from\('enquiry_conversation_links'\)/);
  assert.match(drawerFile, /\.eq\('inquiry_id', inquiryId\)/);
  assert.match(drawerFile, /\.eq\('is_active', true\)/);
});

// ============================================================================
// 10. Duplicate messages are not displayed twice
// ============================================================================
test('10. Continuous thread deduplicates messages sharing a conversation', () => {
  assert.match(convTimelineFile, /const uniqueMessagesMap = new Map<string, typeof allMessages\[0\]>\(\);/);
  assert.match(convTimelineFile, /if \(!uniqueMessagesMap\.has\(item\.id\)\)/);
});

// ============================================================================
// 11. Request-message relationship is displayed (enquiry_request_messages)
// ============================================================================
test('11. Request-message provenance displayed with relationship chips', () => {
  assert.match(convTimelineFile, /Requirement Context:/);
  assert.match(convTimelineFile, /relConfig\.label\}:<\/strong>/);
  assert.match(drawerFile, /\.from\('enquiry_request_messages'\)/);
  assert.match(requestCardFile, /Communication Provenance \(\{linkedMessages\.length\}\)/);
  assert.match(requestCardFile, /lm\.relationship\}:/);
});

// ============================================================================
// 12. Request document is displayed under correct request
// ============================================================================
test('12. Request document displayed on RequestCard and in Documents tab', () => {
  assert.match(requestCardFile, /Linked Documents \(\{linkedDocuments\.length\}\)/);
  assert.match(requestCardFile, /handleDownloadDoc\(doc\)/);
  assert.match(drawerFile, /documentsByRequestId\[req\.id\]/);
  assert.match(docsListFile, /Associated Requirement:/);
});

// ============================================================================
// 13. Existing document storage is reused
// ============================================================================
test('13. Reuses existing crm_product_documents and crm-documents bucket', () => {
  assert.match(drawerFile, /\.from\('crm_product_documents'\)/);
  assert.match(docsListFile, /getSignedUrlCached\('crm-documents', doc\.storage_path/);
  assert.match(foundationMigration, /ALTER TABLE public\.crm_product_documents\s+ADD COLUMN IF NOT EXISTS enquiry_request_id/);
});

// ============================================================================
// 14. No new document tables created
// ============================================================================
test('14. Prohibited document tables (enquiry_documents, crm_enquiry_documents) do NOT exist', () => {
  assert.doesNotMatch(drawerFile, /enquiry_documents/);
  assert.doesNotMatch(drawerFile, /crm_enquiry_documents/);
  assert.doesNotMatch(drawerFile, /request_documents/);
  assert.doesNotMatch(docsListFile, /enquiry_documents/);

  const rows = runDbScript(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN ('enquiry_documents', 'crm_enquiry_documents', 'request_documents');
  `);
  assert.equal(rows.length, 0, 'No prohibited document tables should exist in public schema');
});

// ============================================================================
// 15. Canonical message immutability & read-only drawer
// ============================================================================
test('15. Canonical communication is strictly read-only; no DB mutations or reply composer in drawer', () => {
  // Must not perform database writes on canonical tables from drawer timeline
  assert.doesNotMatch(convTimelineFile, /supabase\s*\.\s*from\([^)]+\)\s*\.\s*(?:delete|update|insert)/);
  // Must not have send/reply composer UI
  assert.doesNotMatch(convTimelineFile, /<textarea/i);
  assert.doesNotMatch(convTimelineFile, /Send Reply/i);
  assert.doesNotMatch(convTimelineFile, /sendEmail/i);
  assert.doesNotMatch(convTimelineFile, /send-bulk-email/i);
});

// ============================================================================
// 16. No AI behavior
// ============================================================================
test('16. Strictly zero AI extraction, summarization, or reply drafting in Phase 7.4', () => {
  assert.doesNotMatch(convTimelineFile, /ai_summary/);
  assert.doesNotMatch(convTimelineFile, /generateReply/);
  assert.doesNotMatch(convTimelineFile, /extractRequirements/);
  assert.doesNotMatch(docsListFile, /extractCOA/);
  assert.doesNotMatch(docsListFile, /aiAnalysis/);
});

// ============================================================================
// 17. Lazy loading / no main-grid conversation query
// ============================================================================
test('17. Conversations and documents are lazy-loaded on drawer open only', () => {
  const serviceFile = readFileSync(
    new URL('../src/services/enquiry/EnquiryControlCenterService.ts', import.meta.url),
    'utf8',
  );
  // Main grid query must not query all messages or all documents
  assert.doesNotMatch(serviceFile, /enquiry_conversation_messages/);
  assert.doesNotMatch(serviceFile, /crm_product_documents/);
});

// ============================================================================
// 18. Future WhatsApp compatibility without new tables
// ============================================================================
test('18. WhatsApp channel compatibility natively supported in conversation timeline', () => {
  assert.match(convTimelineFile, /whatsapp:\s*\{ label: 'WhatsApp'/);
  assert.match(foundationMigration, /CHECK \(channel IN \('email', 'whatsapp', 'internal'\)\)/);
});
