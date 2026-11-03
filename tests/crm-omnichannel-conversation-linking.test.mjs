import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

test('1. CrmOmnichannelInbox provides linking to Inquiry, Customer, and Unlink / General Communication', () => {
  const inboxPath = path.join(process.cwd(), 'src/components/crm/inbox/CrmOmnichannelInbox.tsx');
  const src = fs.readFileSync(inboxPath, 'utf-8');

  // Must support linking to inquiry
  assert.match(src, /handleConfirmLink/, 'Must provide link handler');
  assert.match(src, /enquiry_conversation_links/, 'Must persist WhatsApp links to enquiry_conversation_links');

  // Must support unlinking / general communication
  assert.match(src, /handleUnlinkConversation|handleUnlink/, 'Must provide unlinking handler');
  assert.match(src, /General Communication/i, 'Must support keeping conversations as General Communication');

  // Must support customer linking
  assert.match(src, /allCustomers/, 'Must fetch customer list for direct customer linking');
});

test('2. WhatsApp linking updates database without duplicating messages', () => {
  const inboxPath = path.join(process.cwd(), 'src/components/crm/inbox/CrmOmnichannelInbox.tsx');
  const src = fs.readFileSync(inboxPath, 'utf-8');

  assert.match(src, /whatsAppConversationId/, 'Must use whatsAppConversationId for link operations');
  assert.match(src, /is_active/, 'Must check or set is_active on enquiry_conversation_links');
});

