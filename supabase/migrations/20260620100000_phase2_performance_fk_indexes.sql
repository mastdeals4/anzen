/*
  PHASE 2 — Performance Advisor: Missing FK Indexes
  ==================================================

  Creates indexes for foreign-key columns that have no covering index.
  Missing FK indexes cause sequential scans on DELETE / UPDATE cascade
  operations and slow JOIN queries.

  RULES APPLIED
  -------------
  - CREATE INDEX IF NOT EXISTS — idempotent; safe to re-run.
  - No CONCURRENTLY — not allowed inside a migration transaction (Supabase
    wraps migrations in BEGIN/COMMIT). Standard lock is acceptable for tables
    that are not continuously written at high rate during deployment.
  - Partial indexes (WHERE col IS NOT NULL) used for nullable FK columns to
    keep the index compact and avoid indexing NULL entries.
  - Skipping customer_assignments.customer_id: already covered as the leading
    column of the existing UNIQUE(customer_id, sales_member_id) index.

  WHAT THIS DOES NOT CHANGE
  -------------------------
  - No schema columns added or removed.
  - No data modified.
  - No RLS or grant changes.
  - Existing queries are unaffected; the planner gains new access paths.

  PHASE 3 (not in this file — deferred)
  ------
  - Duplicate index cleanup
  - Unused index removal
  - Multiple permissive policies consolidation
  - auth.uid() initplan RLS rewrites
  - notifications table bloat cleanup
*/

-- ===========================================================================
-- bulk_email_campaigns
-- ===========================================================================

-- template_id → crm_email_templates(id)  [nullable FK, ON DELETE SET NULL]
CREATE INDEX IF NOT EXISTS idx_bulk_email_campaigns_template_id
  ON public.bulk_email_campaigns (template_id)
  WHERE template_id IS NOT NULL;


-- ===========================================================================
-- bulk_email_recipients
-- ===========================================================================

-- contact_id → crm_contacts(id)  [nullable FK, ON DELETE SET NULL]
CREATE INDEX IF NOT EXISTS idx_bulk_email_recipients_contact_id
  ON public.bulk_email_recipients (contact_id)
  WHERE contact_id IS NOT NULL;


-- ===========================================================================
-- crm_inquiries
-- ===========================================================================

-- kunal_pricing_requested_by → user_profiles(id)  [nullable FK]
CREATE INDEX IF NOT EXISTS idx_crm_inquiries_kunal_pricing_requested_by
  ON public.crm_inquiries (kunal_pricing_requested_by)
  WHERE kunal_pricing_requested_by IS NOT NULL;


-- ===========================================================================
-- crm_inquiry_pricing_options
-- ===========================================================================

-- created_by → user_profiles(id)  [nullable FK, ON DELETE SET NULL]
CREATE INDEX IF NOT EXISTS idx_crm_inquiry_pricing_options_created_by
  ON public.crm_inquiry_pricing_options (created_by)
  WHERE created_by IS NOT NULL;

-- parser_result_id → sourcing_parser_results(id)  [nullable FK, ON DELETE SET NULL]
CREATE INDEX IF NOT EXISTS idx_crm_inquiry_pricing_options_parser_result_id
  ON public.crm_inquiry_pricing_options (parser_result_id)
  WHERE parser_result_id IS NOT NULL;


-- ===========================================================================
-- kunal_ai_email_reviews
-- ===========================================================================

-- scanned_by → user_profiles(id)  [nullable FK, ON DELETE SET NULL]
CREATE INDEX IF NOT EXISTS idx_kunal_ai_email_reviews_scanned_by
  ON public.kunal_ai_email_reviews (scanned_by)
  WHERE scanned_by IS NOT NULL;


-- ===========================================================================
-- sales_team_members
-- ===========================================================================

-- user_id → auth.users(id)  [nullable FK, ON DELETE SET NULL]
-- Needed for JOIN from user_profiles → sales_team_members to find member by user.
CREATE INDEX IF NOT EXISTS idx_sales_team_members_user_id
  ON public.sales_team_members (user_id)
  WHERE user_id IS NOT NULL;


-- ===========================================================================
-- customer_assignments
-- ===========================================================================

-- customer_id is already the LEADING column of UNIQUE(customer_id, sales_member_id)
-- so the planner uses that index for FK cascade and customer_id-only filters.
-- No duplicate index created for customer_id.

-- sales_member_id is the SECOND column of UNIQUE(customer_id, sales_member_id) —
-- queries that filter only on sales_member_id cannot use the composite unique
-- index efficiently (leading-column rule). Own index required.
CREATE INDEX IF NOT EXISTS idx_customer_assignments_sales_member_id
  ON public.customer_assignments (sales_member_id);

-- assigned_by → auth.users(id)  [nullable FK]
CREATE INDEX IF NOT EXISTS idx_customer_assignments_assigned_by
  ON public.customer_assignments (assigned_by)
  WHERE assigned_by IS NOT NULL;


-- ===========================================================================
-- email_inquiry_links
-- ===========================================================================

-- created_by → user_profiles(id)  [nullable FK, ON DELETE SET NULL]
-- idx_eil_inquiry and idx_eil_thread already exist (from 20260529120000).
-- created_by is missing.
CREATE INDEX IF NOT EXISTS idx_email_inquiry_links_created_by
  ON public.email_inquiry_links (created_by)
  WHERE created_by IS NOT NULL;


-- ===========================================================================
-- email_thread_map
-- ===========================================================================

-- created_by → user_profiles(id)  [nullable FK, ON DELETE SET NULL]
CREATE INDEX IF NOT EXISTS idx_email_thread_map_created_by
  ON public.email_thread_map (created_by)
  WHERE created_by IS NOT NULL;


-- ===========================================================================
-- Summary notice
-- ===========================================================================
DO $$
BEGIN
  RAISE NOTICE '============================================================';
  RAISE NOTICE 'Phase 2 FK indexes created (IF NOT EXISTS):';
  RAISE NOTICE '  bulk_email_campaigns.template_id';
  RAISE NOTICE '  bulk_email_recipients.contact_id';
  RAISE NOTICE '  crm_inquiries.kunal_pricing_requested_by';
  RAISE NOTICE '  crm_inquiry_pricing_options.created_by';
  RAISE NOTICE '  crm_inquiry_pricing_options.parser_result_id';
  RAISE NOTICE '  kunal_ai_email_reviews.scanned_by';
  RAISE NOTICE '  sales_team_members.user_id';
  RAISE NOTICE '  customer_assignments.sales_member_id';
  RAISE NOTICE '  customer_assignments.assigned_by';
  RAISE NOTICE '  email_inquiry_links.created_by';
  RAISE NOTICE '  email_thread_map.created_by';
  RAISE NOTICE 'Skipped (already covered): customer_assignments.customer_id';
  RAISE NOTICE '============================================================';
END $$;
