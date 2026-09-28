import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const evidenceDrawerCode = fs.readFileSync('src/components/pricing/KunalEmailEvidenceDrawer.tsx', 'utf8');
const gmailInboxMessageCode = fs.readFileSync('supabase/functions/gmail-inbox-message/index.ts', 'utf8');
const gmailAttachmentViewCode = fs.readFileSync('supabase/functions/gmail-attachment-view/index.ts', 'utf8');

const SUPABASE_URL = 'https://dkrtsqienlhpouohmfki.supabase.co';
const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRrcnRzcWllbmxocG91b2htZmtpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjE5MTQxNzQsImV4cCI6MjA3NzQ5MDE3NH0.Kjo9RU0WAfQSSEm2vTWmuN5BIYk_hvanKDQkm5qdCGY';
const supabase = createClient(SUPABASE_URL, ANON_KEY);

test('1. Thread Invocation: Evidence Drawer calls gmail-inbox-message with includeThread = true', () => {
  assert.ok(evidenceDrawerCode.includes("supabase.functions.invoke('gmail-inbox-message'"), 'invokes gmail-inbox-message');
  assert.ok(evidenceDrawerCode.includes('includeThread: true'), 'passes includeThread: true to fetch complete thread');
  assert.ok(evidenceDrawerCode.includes('threadId:'), 'passes threadId');
  assert.ok(evidenceDrawerCode.includes('messageId:'), 'passes messageId');
});

test('2. Chronological Rendering: oldest to newest with expandable/collapsible messages', () => {
  assert.ok(gmailInboxMessageCode.includes('internalDate || 0) - Number(b.internalDate || 0)'), 'sorts messages oldest to newest in edge function');
  assert.ok(evidenceDrawerCode.includes('threadMessages.map('), 'iterates over chronological thread messages');
  assert.ok(evidenceDrawerCode.includes('toggleMessage'), 'provides toggleMessage for expand/collapse');
  assert.ok(evidenceDrawerCode.includes('handleExpandAll'), 'provides Expand All capability');
  assert.ok(evidenceDrawerCode.includes('handleCollapseAll'), 'provides Collapse Older capability');
});

test('3. AI Extraction Source Highlighting: highlights specific supplier message that produced extraction', () => {
  assert.ok(
    evidenceDrawerCode.includes('isTargetExtracted = msg.messageId === row.evidence?.messageId'),
    'identifies the exact message matching row.evidence.messageId',
  );
  assert.ok(evidenceDrawerCode.includes('AI EXTRACTION SOURCE'), 'renders AI EXTRACTION SOURCE badge');
  assert.ok(evidenceDrawerCode.includes('border-indigo-400') || evidenceDrawerCode.includes('ring-indigo-400'), 'highlights container border/ring');
});

test('4. Real Error Handling: shows actual retrieval error instead of fake/empty evidence', () => {
  assert.ok(evidenceDrawerCode.includes('threadError'), 'tracks real threadError state');
  assert.ok(evidenceDrawerCode.includes('Gmail Retrieval Notice'), 'renders real retrieval notice on failure');
  assert.ok(evidenceDrawerCode.includes('Retry Fetch'), 'provides retry button to re-attempt fetch');
  assert.ok(!evidenceDrawerCode.includes('from crm_email_inbox'), 'does NOT query dead crm_email_inbox table for Gmail threads');
});

test('5. Real Attachments: provides View/Get from Supabase Storage or live stream via gmail-attachment-view', () => {
  assert.ok(evidenceDrawerCode.includes('handleOpenDocument'), 'supports opening verified CRM storage files');
  assert.ok(evidenceDrawerCode.includes('handleStreamGmailAttachment'), 'supports streaming live Gmail attachments');
  assert.ok(evidenceDrawerCode.includes("supabase.functions.invoke('gmail-attachment-view'"), 'invokes gmail-attachment-view');
  assert.ok(gmailAttachmentViewCode.includes('listGmailConnectionSecrets'), 'searches connected company Gmail accounts for attachments');
});

test('6. Side-by-Side Split View: AI Extraction panel stays beside the complete thread', () => {
  assert.ok(evidenceDrawerCode.includes('max-w-5xl') || evidenceDrawerCode.includes('max-w-6xl'), 'uses spacious container for side-by-side view');
  assert.ok(evidenceDrawerCode.includes('activeTab === \'both\' ? \'lg:col-span-7\' : \'\''), 'allocates left column for thread');
  assert.ok(evidenceDrawerCode.includes('activeTab === \'both\' ? \'lg:col-span-5\' : \'\''), 'allocates right column for AI extraction');
});

test('7. Live Verification: Ammonium Chloride RFQ example returns complete thread and body', async () => {
  const { data, error } = await supabase.functions.invoke('gmail-inbox-message', {
    body: { threadId: '19e8e84f191e4d93', messageId: '19e8e84f191e4d93', includeThread: true },
  });

  assert.equal(error, null, 'no invocation error for Ammonium Chloride');
  assert.ok(data?.success, 'success is true');
  assert.equal(data?.emailAddress, 'kunal@avira.co.id', 'matches connected kunal@avira.co.id account');
  assert.ok(data?.thread_messages?.length >= 1, 'at least 1 message in thread');

  const msg = data.thread_messages[0];
  assert.ok(msg.from.includes('Kunal Lunkad') || msg.from.includes('kunallunkad@gmail.com'), 'contains sender');
  assert.ok(msg.subject.includes('Ammonium Chloride'), 'contains subject Ammonium Chloride');
  assert.ok(msg.body && msg.body.length > 200, 'contains full email body (not empty)');
  assert.ok(msg.body.includes('Rasino') || msg.body.includes('Aanvi Pasari'), 'contains forwarded supplier reply details');
});

test('8. Live Verification: Multi-message negotiation thread (Metoclopramide) returns all 15 messages', async () => {
  const { data, error } = await supabase.functions.invoke('gmail-inbox-message', {
    body: { messageId: '1a0d123fb97017dd', includeThread: true },
  });

  assert.equal(error, null, 'no invocation error for Metoclopramide');
  assert.ok(data?.success, 'success is true');
  assert.equal(data?.thread_messages?.length, 15, 'returns all 15 messages in chronological thread');

  // Verify chronological ordering (oldest -> newest)
  const firstDate = new Date(data.thread_messages[0].date).getTime();
  const lastDate = new Date(data.thread_messages[14].date).getTime();
  assert.ok(firstDate <= lastDate, 'messages ordered chronologically (oldest to newest)');

  // Verify target extracted message is present in thread
  const target = data.thread_messages.find(m => m.messageId === '1a0d123fb97017dd');
  assert.ok(target, 'extracted supplier message 1a0d123fb97017dd is present in thread');
  assert.ok(target.from.includes('Shrestha') || target.from.includes('Liza') || target.from.includes('sapharmajaya') || target.body.length > 50, 'target message has content');
});
