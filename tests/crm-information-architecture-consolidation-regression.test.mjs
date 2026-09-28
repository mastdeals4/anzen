import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

test('CRM Information Architecture & Consolidation Verification', async (t) => {
  const crmPagePath = path.resolve('src/pages/CRM.tsx');
  assert.ok(fs.existsSync(crmPagePath), 'CRM.tsx must exist');
  const crmContent = fs.readFileSync(crmPagePath, 'utf8');

  await t.test('Primary CRM Navigation is exactly 4 items: INBOX, INQUIRIES, BULK EMAIL, CUSTOMERS', () => {
    // Check tab definition
    assert.match(crmContent, /type CrmPrimaryTab = 'inbox' \| 'inquiries' \| 'bulk_email' \| 'customers'/);

    // Check rendered primary nav buttons
    assert.match(crmContent, /\['inbox', Inbox, 'INBOX'\]/);
    assert.match(crmContent, /\['inquiries', Table, 'INQUIRIES'\]/);
    assert.match(crmContent, /\['bulk_email', Send, 'BULK EMAIL'\]/);
    assert.match(crmContent, /\['customers', Users, 'CUSTOMERS'\]/);

    // Ensure forbidden standalone nav destinations are not primary tabs
    assert.doesNotMatch(crmContent, /'dashboard'/);
    assert.doesNotMatch(crmContent, /'inquiry-360'/);
    assert.doesNotMatch(crmContent, /'customer-360'/);
    assert.doesNotMatch(crmContent, /'conversion-intelligence'/);
  });

  await t.test('CRM defaults to opening directly into INBOX', () => {
    assert.match(crmContent, /useState<CrmPrimaryTab>\('inbox'\)/);
  });

  await t.test('Inquiries Workspace contains [ LIST ] [ PIPELINE ] and quick filters', () => {
    const inqWorkspacePath = path.resolve('src/components/crm/inquiries/CrmInquiriesWorkspace.tsx');
    assert.ok(fs.existsSync(inqWorkspacePath), 'CrmInquiriesWorkspace.tsx must exist');
    const inqContent = fs.readFileSync(inqWorkspacePath, 'utf8');

    // List and Pipeline toggle
    assert.match(inqContent, /LIST/);
    assert.match(inqContent, /PIPELINE/);
    assert.match(inqContent, /viewMode === 'pipeline'/);

    // Quick filters
    assert.match(inqContent, /'needs_action'/);
    assert.match(inqContent, /'waiting_customer'/);
    assert.match(inqContent, /'waiting_supplier'/);
    assert.match(inqContent, /'needs_sourcing'/);
    assert.match(inqContent, /'price_ready'/);
    assert.match(inqContent, /'quote_sent'/);
    assert.match(inqContent, /'needs_review'/);
    assert.match(inqContent, /'archived'/);

    // Compact columns
    assert.match(inqContent, /Inquiry/);
    assert.match(inqContent, /Customer/);
    assert.match(inqContent, /Product/);
    assert.match(inqContent, /Qty/);
    assert.match(inqContent, /Stage/);
    assert.match(inqContent, /Waiting For/);
    assert.match(inqContent, /Last Contact/);
    assert.match(inqContent, /Next Action/);
    assert.match(inqContent, /Owner/);

    // Needs action strict rule: Ordinary Waiting Supplier must NOT be in Needs Action
    assert.match(inqContent, /isOrdinaryWaitingSupplier/);
    assert.match(inqContent, /!isOrdinaryWaitingSupplier/);
  });

  await t.test('Inquiry Drawer contains required 5 sections and chronological timeline', () => {
    const inqDrawerPath = path.resolve('src/components/crm/inquiries/CrmInquiryDrawer.tsx');
    assert.ok(fs.existsSync(inqDrawerPath), 'CrmInquiryDrawer.tsx must exist');
    const inqDrawerContent = fs.readFileSync(inqDrawerPath, 'utf8');

    assert.match(inqDrawerContent, /'overview'/);
    assert.match(inqDrawerContent, /'pricing'/);
    assert.match(inqDrawerContent, /'conversation'/);
    assert.match(inqDrawerContent, /'documents'/);
    assert.match(inqDrawerContent, /'activity'/);

    // Single chronological timeline for Email + WhatsApp + Internal
    assert.match(inqDrawerContent, /EMAIL/);
    assert.match(inqDrawerContent, /WHATSAPP/);
    assert.match(inqDrawerContent, /timelineEvents/);
  });

  await t.test('Customer Workspace & Drawer provide 6 sections without page hopping', () => {
    const custDrawerPath = path.resolve('src/components/crm/customers/CrmCustomerDrawer.tsx');
    assert.ok(fs.existsSync(custDrawerPath), 'CrmCustomerDrawer.tsx must exist');
    const custDrawerContent = fs.readFileSync(custDrawerPath, 'utf8');

    assert.match(custDrawerContent, /OVERVIEW/);
    assert.match(custDrawerContent, /INQUIRIES/);
    assert.match(custDrawerContent, /CONVERSATIONS/);
    assert.match(custDrawerContent, /DOCUMENTS/);
    assert.match(custDrawerContent, /ORDERS/);
    assert.match(custDrawerContent, /ACTIVITY/);

    const custWorkspacePath = path.resolve('src/components/crm/customers/CrmCustomersWorkspace.tsx');
    assert.ok(fs.existsSync(custWorkspacePath), 'CrmCustomersWorkspace.tsx must exist');
    const custWorkspaceContent = fs.readFileSync(custWorkspacePath, 'utf8');

    assert.match(custWorkspaceContent, /CrmCustomerDrawer/);
  });

  await t.test('Bulk Email Workspace houses Compose, Recipients, Templates, Sent/History, Drafts', () => {
    const bulkWorkspacePath = path.resolve('src/components/crm/bulk-email/CrmBulkEmailWorkspace.tsx');
    assert.ok(fs.existsSync(bulkWorkspacePath), 'CrmBulkEmailWorkspace.tsx must exist');
    const bulkContent = fs.readFileSync(bulkWorkspacePath, 'utf8');

    assert.match(bulkContent, /COMPOSE/);
    assert.match(bulkContent, /RECIPIENTS/);
    assert.match(bulkContent, /TEMPLATES/);
    assert.match(bulkContent, /SENT \/ HISTORY/);
    assert.match(bulkContent, /DRAFTS/);
    assert.match(bulkContent, /BulkEmailComposer/);
    assert.match(bulkContent, /DeliveryLog/);
  });

  await t.test('Global CRM Search Modal (Cmd+K) searches all CRM entities', () => {
    const searchModalPath = path.resolve('src/components/crm/search/CrmGlobalSearchModal.tsx');
    assert.ok(fs.existsSync(searchModalPath), 'CrmGlobalSearchModal.tsx must exist');
    const searchContent = fs.readFileSync(searchModalPath, 'utf8');

    assert.match(searchContent, /crm_inquiries/);
    assert.match(searchContent, /crm_contacts/);
    assert.match(searchContent, /enquiry_conversation_messages/);
    assert.match(searchContent, /crm_product_documents/);
    assert.match(searchContent, /sales_orders/);
  });
});
