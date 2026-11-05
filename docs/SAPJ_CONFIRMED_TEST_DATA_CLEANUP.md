# SAPJ ERP — Confirmed Test Data Audit & Safe Cleanup Protocol

**Project:** SAPJ ERP — CRM 3.0 Acceptance & Data Integrity Pass  
**Production Database:** `dkrtsqienlhpouohmfki` (AWS `ap-southeast-1`)  
**Audit & Execution Date:** 4 November 2026  
**Execution Safety Level:** **Zero Uncontrolled Mutation / Pre-Backup Mandate**  
**Execution Status:** **EXECUTED AND COMMITTED TO PRODUCTION**

---

## 1. Safety Principles & Data Protection Mandate

In strict accordance with SAPJ data governance principles, all mutations complied with the following boundaries:
1. **Absolute Protection:** All General Ledger entries (`journal_entries`, `journal_entry_lines`), bank accounts and statements (`bank_statement_lines`, `bank_statement_allocations`), inventory stocks, batches, purchase orders, sales orders, delivery challans, sales invoices, and tax filing periods were strictly protected and untouched.
2. **Pre-Deletion Backup:** All confirmed synthetic entities were dumped to local persistent storage in JSON format prior to SQL deletion (`backups/confirmed_test_data_backup_20261104.json`).
3. **Foreign Key Integrity:** Child table dependencies were traced and deleted in referentially correct order inside a single atomic transaction (`BEGIN ... COMMIT`).
4. **Diagnostic Containment vs Hard Deletion:** Diagnostic webhook threads required for continuous integration and live transport health checks remain isolated behind the `🧪 Test Threads` toggle in CRM Inbox rather than deleted, ensuring production users only see genuine customer threads while diagnostic capabilities remain preserved.

---

## 2. Table-by-Table Scan Findings

A comprehensive scan for synthetic, test, or race-condition records was conducted across all CRM operational tables:

| Table | Total Rows Before | Rows Deleted | Total Rows After | Audit Assessment & Action |
| :--- | :---: | :---: | :---: | :--- |
| `crm_contacts` | 521 | 0 | **521** | **100% Genuine.** All 521 records represent legitimate Indonesian pharmaceutical manufacturers and distributors. |
| `crm_contact_phones` | 572 | 0 | **572** | **100% Genuine.** Validated E.164 phone numbers with normalized country codes and department mappings. |
| `customer_assignments` | 20 | 0 | **20** | **100% Legitimate.** 20 accounts assigned to salesperson Zara (`46b3d50c-ace4-42ea-8ab1-12cc6397a169`). |
| `tasks` | 4 | 0 | **4** | **100% Legitimate.** Active customer follow-ups (PT Sunthi Sepuri & PT Her Bayu Inti). Preserved. |
| `crm_activities` | 29 | 0 | **29** | **100% Genuine.** 17 meetings, 1 call, 11 notes with real discussion minutes. Preserved. |
| `enquiry_conversations` | 781 | 2 | **779** | Deleted 2 synthetic race test conversations (`baf9c7e9...`, `f6dbf344...`). 4 diagnostic WhatsApp threads preserved isolated behind toggle. |
| `enquiry_conversation_messages` | 8,973 | 2 | **8,971** | Deleted 2 race test message bodies (`e1538fa2...`, `6f567e8d...`). |
| `enquiry_requests` | 2 | 2 | **0** | Deleted `REQ-6771` and `REQ-0017`. Zero test requests remaining. |
| `enquiry_request_events` | 2 | 2 | **0** | Deleted 2 event logs tied to test requests. |
| `enquiry_request_messages` | 2 | 2 | **0** | Deleted 2 message link records tied to test requests. |
| `crm_inquiries` | 357 | 2 | **355** | Deleted `INQ-RACE-846` and `INQ-RACE-787`. All 355 remaining rows are authentic commercial inquiries. |

---

## 3. Forensic Trace & Executed Deletion of Test Inquiries

During concurrency testing on 2026-09-15, two synthetic test inquiries were generated:
1. **`INQ-RACE-846`** (UUID: `0b6cdd91-f58e-4355-b739-83751f6ab97e`)
   - Company: `Concurrent Corp`, Product: `Test Product`, Contact: `Dave`, Email: `dave@race.com`
2. **`INQ-RACE-787`** (UUID: `0c7d8f2e-ff7e-443b-8f2c-8b93a95234f1`)
   - Company: `Concurrent Corp`, Product: `Test Product`, Contact: `Dave`, Email: `dave@race.com`

### Relational Dependency Chain
Both inquiries were traced through the foreign key hierarchy:
- Linked to `enquiry_requests` (`REQ-6771` and `REQ-0017`).
- Linked to `enquiry_request_events` (2 rows) and `enquiry_request_messages` (2 rows).
- Tied via `source_message_id` to synthetic test messages `e1538fa2-023f-45fb-89c3-c140421e6320` and `6f567e8d-6bf8-48bf-8dfc-babc96e7e313`.
- Stored within test conversations `baf9c7e9-95f7-4836-a945-8421b36b2196` and `f6dbf344-8dbe-4715-a0ed-29528c5807c0` (Title: *"Concurrent Race Conv"*).
- Zero links existed to quotations, price requests, sales orders, invoices, or financial ledgers.

### Executed Cleanup Action (Committed to Production)
1. **Full Pre-Deletion Backup:** Complete JSON dump saved to [`backups/confirmed_test_data_backup_20261104.json`](file:///Users/Kunal/Documents/anzen-main/backups/confirmed_test_data_backup_20261104.json).
2. **Referential Deletion Order Executed:**
   ```sql
   BEGIN;
   -- 1. Delete request message links
   DELETE FROM enquiry_request_messages WHERE request_id IN ('8ec82c7c-136c-40b9-a243-addad20d43f7', '5efccf84-ba9d-4b93-81e4-4a6bd18d3508');
   -- 2. Delete request events
   DELETE FROM enquiry_request_events WHERE request_id IN ('8ec82c7c-136c-40b9-a243-addad20d43f7', '5efccf84-ba9d-4b93-81e4-4a6bd18d3508');
   -- 3. Delete enquiry requests (REQ-6771, REQ-0017)
   DELETE FROM enquiry_requests WHERE id IN ('8ec82c7c-136c-40b9-a243-addad20d43f7', '5efccf84-ba9d-4b93-81e4-4a6bd18d3508');
   -- 4. Delete synthetic inquiries (INQ-RACE-846, INQ-RACE-787)
   DELETE FROM crm_inquiries WHERE id IN ('0b6cdd91-f58e-4355-b739-83751f6ab97e', '0c7d8f2e-ff7e-443b-8f2c-8b93a95234f1');
   -- 5. Delete conversation messages
   DELETE FROM enquiry_conversation_messages WHERE id IN ('e1538fa2-023f-45fb-89c3-c140421e6320', '6f567e8d-6bf8-48bf-8dfc-babc96e7e313');
   -- 6. Delete synthetic conversations
   DELETE FROM enquiry_conversations WHERE id IN ('baf9c7e9-95f7-4836-a945-8421b36b2196', 'f6dbf344-8dbe-4715-a0ed-29528c5807c0');
   COMMIT;
   ```
3. **Post-Cleanup Verification:**
   - Remaining `crm_inquiries`: **355** (all 100% genuine customer records).
   - Remaining `enquiry_requests`: **0** (all synthetic test requests eliminated).
   - Zero orphaned child records.

---

## 4. Inbox Diagnostic Test Thread Containment

In [`src/components/crm/inbox/CrmOmnichannelInbox.tsx`](file:///Users/Kunal/Documents/anzen-main/src/components/crm/inbox/CrmOmnichannelInbox.tsx):

- The 4 diagnostic WhatsApp threads are retained strictly for QA transport verification and webhook health checks.
- They are filtered out of the operational view by default.
- Staff see only authentic customer correspondence.
- Clicking the `🧪 Test Threads` toggle allows administrators to monitor transport health without contaminating active conversations.

---

## 5. Verification Checklist

- [x] Pre-deletion JSON backup created in `backups/confirmed_test_data_backup_20261104.json`.
- [x] 12 test records deleted in referentially correct order inside a committed transaction.
- [x] Zero financial, GL, tax, or inventory records touched.
- [x] Zero genuine customer contacts or phone records modified.
- [x] Relational tree integrity verified across `crm_inquiries` and `enquiry_requests`.
- [x] Diagnostic thread filtering active and verified in CRM Inbox UI.
