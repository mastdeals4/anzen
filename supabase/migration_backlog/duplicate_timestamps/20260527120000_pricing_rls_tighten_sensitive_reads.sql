/*
  # Tighten sensitive pricing-table reads to admin/manager only

  Sales should not be able to query internal purchase/source pricing data
  directly. We tighten the read policies on the two tables that explicitly
  hold internal pricing detail:

    - pricing_ledger              (purchase_price, source_price, internal cost)
    - crm_inquiry_pricing_options (offered_make, source_price, raw remarks)

  We do NOT change crm_inquiries reads — sales still needs to see the CRM
  master sheet to do their job. Column-level masking on crm_inquiries is
  handled in the frontend (canSeeInternalPricing) plus the CSV export gate.
  A future hardening step is to introduce a safe view that strips
  purchase_price / purchase_price_currency before exposing to non-managers;
  documented below for that follow-up.

  Idempotent and additive. No data is touched, no columns dropped.
*/

-- ────────────────────────────────────────────────────────────────────────────
-- pricing_ledger — admin/manager only for SELECT/INSERT/UPDATE
-- ────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "pricing_ledger_read"   ON pricing_ledger;
DROP POLICY IF EXISTS "pricing_ledger_insert" ON pricing_ledger;
DROP POLICY IF EXISTS "pricing_ledger_update" ON pricing_ledger;

CREATE POLICY "pricing_ledger_read" ON pricing_ledger
  FOR SELECT TO authenticated
  USING (current_user_has_pricing_role(ARRAY['admin','manager']));

CREATE POLICY "pricing_ledger_insert" ON pricing_ledger
  FOR INSERT TO authenticated
  WITH CHECK (current_user_has_pricing_role(ARRAY['admin','manager']));

CREATE POLICY "pricing_ledger_update" ON pricing_ledger
  FOR UPDATE TO authenticated
  USING      (current_user_has_pricing_role(ARRAY['admin','manager']))
  WITH CHECK (current_user_has_pricing_role(ARRAY['admin','manager']));

-- ────────────────────────────────────────────────────────────────────────────
-- crm_inquiry_pricing_options — admin/manager only for SELECT.
-- Was already admin/manager-only for write; we now also tighten SELECT.
-- ────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.crm_inquiry_pricing_options') IS NOT NULL THEN
    EXECUTE 'DROP POLICY IF EXISTS "pricing_options_read" ON crm_inquiry_pricing_options';
    EXECUTE $POL$
      CREATE POLICY "pricing_options_read" ON crm_inquiry_pricing_options
        FOR SELECT TO authenticated
        USING (current_user_has_pricing_role(ARRAY['admin','manager']))
    $POL$;
  END IF;
END $$;

-- ────────────────────────────────────────────────────────────────────────────
-- (Follow-up, not applied here.) Suggested view for hardening crm_inquiries
-- column-level masking on the read path:
--
--   CREATE OR REPLACE VIEW public.crm_inquiries_safe
--   WITH (security_invoker = true) AS
--   SELECT id, inquiry_number, ...,
--          CASE WHEN current_user_has_pricing_role(ARRAY['admin','manager'])
--               THEN purchase_price ELSE NULL END           AS purchase_price,
--          CASE WHEN current_user_has_pricing_role(ARRAY['admin','manager'])
--               THEN purchase_price_currency ELSE NULL END  AS purchase_price_currency,
--          CASE WHEN current_user_has_pricing_role(ARRAY['admin','manager']) OR price_ready
--               THEN offered_price ELSE NULL END            AS offered_price
--     FROM public.crm_inquiries;
--
-- The CRM table reads crm_inquiries.* directly today; switching the
-- frontend to this view is a deliberate follow-up so we don't break
-- existing CRM behaviour in this pass.
-- ────────────────────────────────────────────────────────────────────────────
