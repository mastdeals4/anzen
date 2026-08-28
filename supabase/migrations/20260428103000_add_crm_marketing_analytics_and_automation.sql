/*
  # CRM Marketing Enhancements: Segmentation, KPI, Follow-up Automation, Lead Scoring, Dashboard Widgets

  Implements:
  1) Contact segmentation by industry/product interest/source/last engagement
  2) Campaign KPI tracking (delivery, response proxy, conversion to inquiry/quote/order)
  3) Automated follow-up rule outputs (failed delivery retry, no-response reminders)
  4) Lead scoring from recency/frequency and inquiry stage movement
  5) Dashboard-ready widgets for segment performance and campaign ROI proxies
*/

-- -----------------------------------------------------------------------------
-- 1) CONTACT SEGMENTATION VIEW
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW crm_contact_marketing_segments AS
WITH inquiry_rollup AS (
  SELECT
    ci.company_name,
    COALESCE(MAX(ci.source), 'unknown') AS last_known_source,
    ARRAY_REMOVE(ARRAY_AGG(DISTINCT NULLIF(TRIM(ci.product_name), '')), NULL) AS product_interests,
    MAX(
      GREATEST(
        COALESCE(ci.last_contact_date, ci.created_at),
        ci.inquiry_date::timestamptz,
        COALESCE(ci.updated_at, ci.created_at)
      )
    ) AS last_inquiry_engagement_at,
    COUNT(*) AS inquiry_count
  FROM crm_inquiries ci
  GROUP BY ci.company_name
),
contact_activity AS (
  SELECT
    c.id AS contact_id,
    MAX(
      GREATEST(
        COALESCE(ea.sent_date, '-infinity'::timestamptz),
        COALESCE(ea.opened_date, '-infinity'::timestamptz),
        COALESCE(ea.clicked_date, '-infinity'::timestamptz),
        ea.created_at
      )
    ) AS last_email_engagement_at,
    COUNT(*) AS email_activity_count
  FROM crm_contacts c
  LEFT JOIN crm_email_activities ea ON ea.contact_id = c.id
  GROUP BY c.id
)
SELECT
  c.id AS contact_id,
  c.company_name,
  c.contact_person,
  c.email,
  COALESCE(NULLIF(TRIM(c.industry), ''), 'unclassified') AS industry_segment,
  COALESCE(ir.product_interests, ARRAY[]::text[]) AS product_interest_segment,
  COALESCE(ir.last_known_source, 'unknown') AS source_segment,
  GREATEST(
    COALESCE(c.last_contact_date::timestamptz, '-infinity'::timestamptz),
    COALESCE(ir.last_inquiry_engagement_at, '-infinity'::timestamptz),
    COALESCE(ca.last_email_engagement_at, '-infinity'::timestamptz),
    c.created_at
  ) AS last_engagement_at,
  CASE
    WHEN GREATEST(
      COALESCE(c.last_contact_date::timestamptz, '-infinity'::timestamptz),
      COALESCE(ir.last_inquiry_engagement_at, '-infinity'::timestamptz),
      COALESCE(ca.last_email_engagement_at, '-infinity'::timestamptz),
      c.created_at
    ) >= now() - interval '30 days' THEN 'active_30d'
    WHEN GREATEST(
      COALESCE(c.last_contact_date::timestamptz, '-infinity'::timestamptz),
      COALESCE(ir.last_inquiry_engagement_at, '-infinity'::timestamptz),
      COALESCE(ca.last_email_engagement_at, '-infinity'::timestamptz),
      c.created_at
    ) >= now() - interval '90 days' THEN 'warm_90d'
    ELSE 'cold_90d_plus'
  END AS engagement_segment,
  COALESCE(ir.inquiry_count, 0) AS inquiry_count,
  COALESCE(ca.email_activity_count, 0) AS email_activity_count
FROM crm_contacts c
LEFT JOIN inquiry_rollup ir ON ir.company_name = c.company_name
LEFT JOIN contact_activity ca ON ca.contact_id = c.id;

-- -----------------------------------------------------------------------------
-- 2) CAMPAIGN KPI MATERIALIZED VIEW
-- -----------------------------------------------------------------------------
DROP MATERIALIZED VIEW IF EXISTS crm_campaign_kpi_mv;

CREATE MATERIALIZED VIEW crm_campaign_kpi_mv AS
WITH recipient_base AS (
  SELECT
    br.id AS recipient_id,
    br.campaign_id,
    br.contact_id,
    br.email,
    br.status,
    br.sent_at,
    br.created_at,
    bc.started_at,
    bc.completed_at
  FROM bulk_email_recipients br
  JOIN bulk_email_campaigns bc ON bc.id = br.campaign_id
),
response_proxy AS (
  SELECT DISTINCT rb.recipient_id
  FROM recipient_base rb
  JOIN crm_email_activities ea
    ON (
      (rb.contact_id IS NOT NULL AND ea.contact_id = rb.contact_id)
      OR lower(ea.from_email) = lower(rb.email)
      OR lower(COALESCE(ea.to_email[1], '')) = lower(rb.email)
    )
   AND ea.email_type = 'received'
   AND COALESCE(ea.sent_date, ea.created_at) >= rb.started_at
),
inquiry_conv AS (
  SELECT DISTINCT rb.recipient_id
  FROM recipient_base rb
  JOIN crm_inquiries ci
    ON (
      lower(COALESCE(ci.contact_email, '')) = lower(rb.email)
      OR (rb.contact_id IS NOT NULL AND ci.company_name = (
        SELECT company_name FROM crm_contacts c WHERE c.id = rb.contact_id
      ))
    )
   AND ci.created_at >= rb.started_at
),
quote_conv AS (
  SELECT DISTINCT rb.recipient_id
  FROM recipient_base rb
  JOIN crm_inquiries ci
    ON (
      lower(COALESCE(ci.contact_email, '')) = lower(rb.email)
      OR (rb.contact_id IS NOT NULL AND ci.company_name = (
        SELECT company_name FROM crm_contacts c WHERE c.id = rb.contact_id
      ))
    )
   AND ci.created_at >= rb.started_at
   AND (ci.price_quoted = true OR ci.quoted_price IS NOT NULL)
),
order_conv AS (
  SELECT DISTINCT rb.recipient_id
  FROM recipient_base rb
  JOIN crm_inquiries ci
    ON (
      lower(COALESCE(ci.contact_email, '')) = lower(rb.email)
      OR (rb.contact_id IS NOT NULL AND ci.company_name = (
        SELECT company_name FROM crm_contacts c WHERE c.id = rb.contact_id
      ))
    )
   AND ci.created_at >= rb.started_at
   AND ci.converted_to_order IS NOT NULL
)
SELECT
  bc.id AS campaign_id,
  bc.subject,
  bc.created_by,
  bc.started_at,
  bc.completed_at,
  bc.status AS campaign_status,
  COUNT(rb.recipient_id) AS total_recipients,
  COUNT(*) FILTER (WHERE rb.status = 'sent') AS delivered_count,
  COUNT(*) FILTER (WHERE rb.status = 'failed') AS failed_count,
  ROUND(
    (COUNT(*) FILTER (WHERE rb.status = 'sent')::numeric / NULLIF(COUNT(rb.recipient_id), 0)) * 100,
    2
  ) AS delivery_rate_pct,
  COUNT(rp.recipient_id) AS response_proxy_count,
  ROUND(
    (COUNT(rp.recipient_id)::numeric / NULLIF(COUNT(rb.recipient_id), 0)) * 100,
    2
  ) AS response_proxy_rate_pct,
  COUNT(ic.recipient_id) AS converted_to_inquiry_count,
  COUNT(qc.recipient_id) AS converted_to_quote_count,
  COUNT(oc.recipient_id) AS converted_to_order_count,
  ROUND(
    (COUNT(ic.recipient_id)::numeric / NULLIF(COUNT(rb.recipient_id), 0)) * 100,
    2
  ) AS inquiry_conversion_rate_pct,
  ROUND(
    (COUNT(oc.recipient_id)::numeric / NULLIF(COUNT(rb.recipient_id), 0)) * 100,
    2
  ) AS order_conversion_rate_pct
FROM bulk_email_campaigns bc
LEFT JOIN recipient_base rb ON rb.campaign_id = bc.id
LEFT JOIN response_proxy rp ON rp.recipient_id = rb.recipient_id
LEFT JOIN inquiry_conv  ic ON ic.recipient_id = rb.recipient_id
LEFT JOIN quote_conv    qc ON qc.recipient_id = rb.recipient_id
LEFT JOIN order_conv    oc ON oc.recipient_id = rb.recipient_id
GROUP BY bc.id, bc.subject, bc.created_by, bc.started_at, bc.completed_at, bc.status;

CREATE UNIQUE INDEX idx_crm_campaign_kpi_mv_campaign_id ON crm_campaign_kpi_mv(campaign_id);
CREATE INDEX idx_crm_campaign_kpi_mv_started_at ON crm_campaign_kpi_mv(started_at DESC);

-- -----------------------------------------------------------------------------
-- 3) AUTOMATED FOLLOW-UP RULE VIEW
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW crm_campaign_follow_up_actions AS
WITH recipient_context AS (
  SELECT
    br.id AS recipient_id,
    br.campaign_id,
    br.contact_id,
    br.company_name,
    br.email,
    br.status,
    br.error_message,
    br.sent_at,
    br.created_at,
    bc.started_at,
    bc.created_by
  FROM bulk_email_recipients br
  JOIN bulk_email_campaigns bc ON bc.id = br.campaign_id
),
response_flags AS (
  SELECT
    rc.recipient_id,
    EXISTS (
      SELECT 1
      FROM crm_email_activities ea
      WHERE (
        (rc.contact_id IS NOT NULL AND ea.contact_id = rc.contact_id)
        OR lower(ea.from_email) = lower(rc.email)
      )
      AND ea.email_type = 'received'
      AND COALESCE(ea.sent_date, ea.created_at) >= COALESCE(rc.sent_at, rc.created_at)
    ) AS has_response,
    EXISTS (
      SELECT 1
      FROM crm_inquiries ci
      WHERE (
        lower(COALESCE(ci.contact_email, '')) = lower(rc.email)
        OR ci.company_name = rc.company_name
      )
      AND ci.created_at >= rc.started_at
    ) AS has_conversion
  FROM recipient_context rc
)
SELECT
  rc.recipient_id,
  rc.campaign_id,
  rc.contact_id,
  rc.company_name,
  rc.email,
  rc.created_by AS action_owner,
  CASE
    WHEN rc.status = 'failed' THEN 'retry_failed_delivery'
    WHEN rc.status = 'sent' AND NOT rf.has_response AND NOT rf.has_conversion THEN 'send_no_response_reminder'
  END AS action_type,
  CASE
    WHEN rc.status = 'failed' THEN now()
    WHEN rc.status = 'sent' AND NOT rf.has_response AND NOT rf.has_conversion THEN COALESCE(rc.sent_at, rc.created_at) + interval '3 days'
  END AS due_at,
  CASE
    WHEN rc.status = 'failed' THEN COALESCE(rc.error_message, 'delivery_failed')
    WHEN rc.status = 'sent' AND NOT rf.has_response AND NOT rf.has_conversion THEN 'no_response_after_3d'
  END AS reason,
  CASE
    WHEN rc.status = 'failed' THEN 'high'
    WHEN rc.status = 'sent' AND NOT rf.has_response AND NOT rf.has_conversion THEN 'medium'
  END AS priority
FROM recipient_context rc
JOIN response_flags rf ON rf.recipient_id = rc.recipient_id
WHERE rc.status = 'failed'
   OR (rc.status = 'sent' AND NOT rf.has_response AND NOT rf.has_conversion);

-- -----------------------------------------------------------------------------
-- 4) LEAD SCORING MATERIALIZED VIEW
-- -----------------------------------------------------------------------------
DROP MATERIALIZED VIEW IF EXISTS crm_lead_scoring_mv;

CREATE MATERIALIZED VIEW crm_lead_scoring_mv AS
WITH interaction AS (
  SELECT
    c.id AS contact_id,
    GREATEST(
      COALESCE(c.last_contact_date::timestamptz, '-infinity'::timestamptz),
      COALESCE(MAX(ea.created_at), '-infinity'::timestamptz),
      COALESCE(MAX(ci.updated_at), '-infinity'::timestamptz),
      c.created_at
    ) AS last_interaction_at,
    COUNT(DISTINCT ea.id) FILTER (WHERE ea.created_at >= now() - interval '90 days')
      + COUNT(DISTINCT ci.id) FILTER (WHERE ci.updated_at >= now() - interval '90 days') AS interaction_frequency_90d,
    COUNT(DISTINCT ci.id) FILTER (WHERE ci.status IN ('price_quoted', 'negotiation', 'po_received', 'won')) AS progressed_inquiry_count,
    COUNT(DISTINCT ci.id) FILTER (WHERE ci.status = 'won') AS won_count,
    COUNT(DISTINCT ci.id) FILTER (WHERE ci.status = 'lost') AS lost_count,
    COUNT(DISTINCT ci.id) AS total_inquiries
  FROM crm_contacts c
  LEFT JOIN crm_email_activities ea ON ea.contact_id = c.id
  LEFT JOIN crm_inquiries ci ON ci.company_name = c.company_name
  GROUP BY c.id, c.last_contact_date, c.created_at
),
scored AS (
  SELECT
    i.*,
    CASE
      WHEN i.last_interaction_at >= now() - interval '7 days' THEN 40
      WHEN i.last_interaction_at >= now() - interval '30 days' THEN 30
      WHEN i.last_interaction_at >= now() - interval '90 days' THEN 15
      ELSE 5
    END AS recency_score,
    LEAST(30, i.interaction_frequency_90d * 3) AS frequency_score,
    GREATEST(
      0,
      LEAST(
        30,
        (i.progressed_inquiry_count * 6)
        + (i.won_count * 8)
        - (i.lost_count * 4)
      )
    ) AS stage_movement_score
  FROM interaction i
)
SELECT
  s.contact_id,
  s.last_interaction_at,
  s.interaction_frequency_90d,
  s.total_inquiries,
  s.progressed_inquiry_count,
  s.won_count,
  s.lost_count,
  s.recency_score,
  s.frequency_score,
  s.stage_movement_score,
  (s.recency_score + s.frequency_score + s.stage_movement_score) AS lead_score,
  CASE
    WHEN (s.recency_score + s.frequency_score + s.stage_movement_score) >= 75 THEN 'hot'
    WHEN (s.recency_score + s.frequency_score + s.stage_movement_score) >= 45 THEN 'warm'
    ELSE 'cold'
  END AS lead_temperature
FROM scored s;

CREATE UNIQUE INDEX idx_crm_lead_scoring_mv_contact_id ON crm_lead_scoring_mv(contact_id);
CREATE INDEX idx_crm_lead_scoring_mv_lead_score ON crm_lead_scoring_mv(lead_score DESC);

-- -----------------------------------------------------------------------------
-- 5) DASHBOARD WIDGET VIEWS
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW crm_dashboard_segment_performance AS
SELECT
  cms.industry_segment,
  cms.source_segment,
  cms.engagement_segment,
  COUNT(*) AS contacts,
  SUM(cms.inquiry_count) AS inquiries,
  ROUND(AVG(COALESCE(ls.lead_score, 0)), 2) AS avg_lead_score,
  COUNT(*) FILTER (WHERE COALESCE(ls.lead_temperature, 'cold') = 'hot') AS hot_leads
FROM crm_contact_marketing_segments cms
LEFT JOIN crm_lead_scoring_mv ls ON ls.contact_id = cms.contact_id
GROUP BY cms.industry_segment, cms.source_segment, cms.engagement_segment;

CREATE OR REPLACE VIEW crm_dashboard_campaign_roi AS
SELECT
  kpi.campaign_id,
  kpi.subject,
  kpi.started_at,
  kpi.campaign_status,
  kpi.total_recipients,
  kpi.delivered_count,
  kpi.failed_count,
  kpi.delivery_rate_pct,
  kpi.response_proxy_count,
  kpi.response_proxy_rate_pct,
  kpi.converted_to_inquiry_count,
  kpi.converted_to_quote_count,
  kpi.converted_to_order_count,
  kpi.inquiry_conversion_rate_pct,
  kpi.order_conversion_rate_pct,
  ROUND(
    (
      (kpi.converted_to_order_count::numeric * 4)
      + (kpi.converted_to_quote_count::numeric * 2)
      + (kpi.response_proxy_count::numeric)
    ) / NULLIF(kpi.total_recipients::numeric, 0),
    4
  ) AS roi_proxy_score
FROM crm_campaign_kpi_mv kpi;

-- Utility: single-call refresh for dashboard materialized views
CREATE OR REPLACE FUNCTION refresh_crm_marketing_analytics()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  REFRESH MATERIALIZED VIEW crm_campaign_kpi_mv;
  REFRESH MATERIALIZED VIEW crm_lead_scoring_mv;
END;
$$;

GRANT SELECT ON crm_contact_marketing_segments TO authenticated;
GRANT SELECT ON crm_campaign_kpi_mv TO authenticated;
GRANT SELECT ON crm_campaign_follow_up_actions TO authenticated;
GRANT SELECT ON crm_lead_scoring_mv TO authenticated;
GRANT SELECT ON crm_dashboard_segment_performance TO authenticated;
GRANT SELECT ON crm_dashboard_campaign_roi TO authenticated;
GRANT EXECUTE ON FUNCTION refresh_crm_marketing_analytics() TO authenticated;
