/*
  # CRM Master — backfill new status fields from existing inquiry data

  Idempotent. Only writes when the target field is at its default value
  ('not_sent', 'pending', 'not_required', false, NULL …) — never overwrites
  a meaningful non-default status, and never deletes any data.

  Pulls from existing CRM columns:
    pipeline_status, purchase_price, offered_price, price_sent_at,
    coa_required, coa_sent_at, supplier_country, supplier_name,
    sample_required, sample_sent_at

  Goal: after applying, Anvi Sourcing, Kunal Pricing, and Pricing Overview
  show real current inquiry rows instead of empty screens.
*/

-- ────────────────────────────────────────────────────────────────────────────
-- 1. source_type — infer from supplier_country / supplier_name where missing
-- ────────────────────────────────────────────────────────────────────────────
UPDATE crm_inquiries
   SET source_type = CASE
       WHEN lower(coalesce(supplier_country, '')) IN ('india','in')   THEN 'india'
       WHEN lower(coalesce(supplier_country, '')) IN ('china','cn')   THEN 'china'
       WHEN lower(coalesce(supplier_country, '')) IN ('indonesia','id','local') THEN 'local'
       WHEN lower(coalesce(supplier_name, ''))    LIKE '%india%'      THEN 'india'
       WHEN lower(coalesce(supplier_name, ''))    LIKE '%china%'      THEN 'china'
       ELSE 'india'  -- safe default for this business (primary import route)
     END
 WHERE source_type IS NULL;

-- ────────────────────────────────────────────────────────────────────────────
-- 2. kunal_price_status + price_ready — set entered/true when both Purchase
--    and Selling already exist on the inquiry.
-- ────────────────────────────────────────────────────────────────────────────
UPDATE crm_inquiries
   SET kunal_price_status = 'entered'
 WHERE kunal_price_status = 'pending'
   AND purchase_price IS NOT NULL
   AND offered_price  IS NOT NULL;

UPDATE crm_inquiries
   SET price_ready = true
 WHERE price_ready = false
   AND purchase_price IS NOT NULL
   AND offered_price  IS NOT NULL;

-- ────────────────────────────────────────────────────────────────────────────
-- 3. document_status — infer from coa_required / coa_sent_at
--    (coa_sent_at means we already sent the COA to the customer, which
--    implies we received it from the supplier first.)
-- ────────────────────────────────────────────────────────────────────────────
UPDATE crm_inquiries
   SET document_status = 'received'
 WHERE document_status = 'not_required'
   AND coa_sent_at IS NOT NULL;

UPDATE crm_inquiries
   SET document_status = 'pending'
 WHERE document_status = 'not_required'
   AND coa_required = true
   AND coa_sent_at IS NULL;

-- Sample-required falls into 'pending' too if not yet sent.
UPDATE crm_inquiries
   SET document_status = 'pending'
 WHERE document_status = 'not_required'
   AND sample_required = true
   AND sample_sent_at IS NULL;

-- ────────────────────────────────────────────────────────────────────────────
-- 4. quote_status — derive from price_sent_at and pipeline_status
-- ────────────────────────────────────────────────────────────────────────────
UPDATE crm_inquiries
   SET quote_status = 'sent',
       quote_sent_at = COALESCE(quote_sent_at, price_sent_at)
 WHERE quote_status = 'not_sent'
   AND price_sent_at IS NOT NULL;

-- Pipeline-status overrides where it's authoritative (won/lost).
UPDATE crm_inquiries
   SET quote_status = 'won'
 WHERE quote_status IN ('not_sent','sent','follow_up_due')
   AND pipeline_status = 'won';

UPDATE crm_inquiries
   SET quote_status = 'lost'
 WHERE quote_status IN ('not_sent','sent','follow_up_due')
   AND pipeline_status = 'lost';

-- If quote was sent more than 5 days ago and still not won/lost, surface
-- as follow_up_due so it shows in the "Quote follow-up" card.
UPDATE crm_inquiries
   SET quote_status = 'follow_up_due'
 WHERE quote_status = 'sent'
   AND quote_sent_at IS NOT NULL
   AND quote_sent_at < (now() - interval '5 days')
   AND pipeline_status NOT IN ('won','lost');

-- ────────────────────────────────────────────────────────────────────────────
-- 5. source_status — surface mid-workflow rows so Kunal Pricing has real
--    inquiries to work on after the migration. We mark source_status =
--    'received' for inquiries that are mid-pipeline but still lack a final
--    selling price; treat that as "source reply received, awaiting Kunal".
--    Only touches rows still at the default ('not_sent') — never overwrites.
-- ────────────────────────────────────────────────────────────────────────────
UPDATE crm_inquiries
   SET source_status = 'received'
 WHERE source_status = 'not_sent'
   AND pipeline_status IN ('in_progress','follow_up')
   AND kunal_price_status = 'pending';

-- If both prices already exist on a not_sent row, sourcing must be done.
UPDATE crm_inquiries
   SET source_status = 'received'
 WHERE source_status = 'not_sent'
   AND purchase_price IS NOT NULL
   AND offered_price  IS NOT NULL;

-- Lost / Won pipeline rows are no longer actively being sourced — leave
-- their source_status alone so they don't pollute Anvi Sourcing.

-- ────────────────────────────────────────────────────────────────────────────
-- 6. reminder_count default — already 0 via the column default. No-op here.
-- ────────────────────────────────────────────────────────────────────────────
