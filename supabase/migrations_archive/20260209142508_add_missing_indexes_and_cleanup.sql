/*
  # Add Missing Indexes and Cleanup Documentation
  
  1. Performance Improvements
    - Add 4 missing foreign key indexes for better query performance
    
  2. Documentation
    - Add clear comments to legacy/backup tables
    - Mark deprecated systems properly
*/

-- =====================================================
-- PART 1: ADD MISSING FOREIGN KEY INDEXES
-- =====================================================

-- These indexes improve performance for foreign key lookups
-- and JOIN operations

CREATE INDEX IF NOT EXISTS idx_capital_contributions_bank_account_id 
  ON capital_contributions(bank_account_id);

CREATE INDEX IF NOT EXISTS idx_product_source_documents_uploaded_by 
  ON product_source_documents(uploaded_by);

CREATE INDEX IF NOT EXISTS idx_product_sources_created_by 
  ON product_sources(created_by);

CREATE INDEX IF NOT EXISTS idx_tasks_dismissed_by 
  ON tasks(dismissed_by);

-- =====================================================
-- PART 2: DOCUMENTATION AND CLEANUP
-- =====================================================

-- Mark legacy table properly
COMMENT ON TABLE approval_thresholds IS 
'Legacy approval threshold configuration table. Currently unused but kept for historical reference. May be deprecated in future releases.';

-- Clarify active table (not temp!)
COMMENT ON TABLE crm_email_templates IS 
'✅ ACTIVE: Email templates for CRM module. Used for bulk emails, automated responses, and email campaigns.';

-- Mark backup table clearly
COMMENT ON TABLE invoice_payment_allocations_backup_20260209 IS 
'⛔ BACKUP ONLY (2026-02-09): Historical backup created before fixing double payment bug. Read-only. Admin access only. Do not use for active operations.';

-- Mark deprecated main table
COMMENT ON TABLE invoice_payment_allocations IS 
'⛔ DEPRECATED (2026-02-09): Replaced by voucher_allocations. Kept for schema compatibility only. Do not insert new records.';
