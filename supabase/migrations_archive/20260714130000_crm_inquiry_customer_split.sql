-- ============================================================================
-- CRM Inquiry / ERP Customer split (2026-07-14)
-- ============================================================================
-- Root cause:
--   1. crm_inquiries.customer_id was declared as a FK to customers(id) — the
--      ERP master. Any "Add Customer" click therefore had to write into the
--      ERP customers table to satisfy the FK.
--   2. Trigger sync_customer_from_inquiry (migration 20251120181805) fired
--      AFTER INSERT on crm_inquiries and additionally upserted a row into
--      crm_contacts. That is why every prospect ended up in BOTH tables.
--
-- Fix:
--   * Add a nullable crm_inquiries.crm_contact_id FK to crm_contacts. This
--     is the new authoritative link "which CRM prospect this inquiry is
--     about". Existing customer_id column is preserved (still nullable, still
--     FK to customers) for the case where a prospect has been promoted to an
--     ERP trading customer via the existing manual workflow.
--   * Backfill crm_contact_id for existing inquiries by matching company_name.
--     If no crm_contacts row exists (unlikely — the old trigger backfilled),
--     create one from the inquiry's own fields.
--   * Drop trigger sync_customer_from_inquiry and its function so future
--     inquiry inserts no longer implicitly touch crm_contacts. Explicit
--     Add-Customer writes from the frontend become the single source of
--     truth for CRM contact creation.
-- ============================================================================

BEGIN;

-- ── 1. Drop the auto-mirror trigger + function ───────────────────────────────
DROP TRIGGER IF EXISTS trigger_sync_customer_from_inquiry ON public.crm_inquiries;
DROP FUNCTION IF EXISTS public.sync_customer_from_inquiry();

-- ── 2. New crm_contact_id column + FK + index ────────────────────────────────
ALTER TABLE public.crm_inquiries
  ADD COLUMN IF NOT EXISTS crm_contact_id uuid REFERENCES public.crm_contacts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_crm_inquiries_crm_contact_id
  ON public.crm_inquiries(crm_contact_id);

-- ── 3. Backfill: match existing inquiries to a crm_contacts row ──────────────
-- Pass A: for inquiries that reference an ERP customer, use that customer's
-- company_name to find a crm_contacts row (case-insensitive).
UPDATE public.crm_inquiries i
SET crm_contact_id = cc.id
FROM public.customers c
JOIN public.crm_contacts cc
  ON lower(btrim(cc.company_name)) = lower(btrim(c.company_name))
WHERE i.crm_contact_id IS NULL
  AND i.customer_id IS NOT NULL
  AND i.customer_id = c.id;

-- Pass B: for inquiries with no customer_id, match by inquiry.company_name.
UPDATE public.crm_inquiries i
SET crm_contact_id = cc.id
FROM public.crm_contacts cc
WHERE i.crm_contact_id IS NULL
  AND i.company_name IS NOT NULL
  AND lower(btrim(cc.company_name)) = lower(btrim(i.company_name));

-- Pass C: any inquiry still without a link — create a crm_contacts row from
-- the inquiry's own fields, then set crm_contact_id. Unique constraint on
-- crm_contacts.company_name protects against duplicates.
WITH orphans AS (
  SELECT DISTINCT
    lower(btrim(company_name)) AS norm_name,
    MIN(company_name)          AS company_name,
    MIN(contact_person)        AS contact_person,
    MIN(contact_email)         AS email,
    MIN(contact_phone)         AS phone,
    MIN(supplier_country)      AS country,
    MIN(inquiry_date)          AS first_date,
    MAX(inquiry_date)          AS last_date,
    COUNT(*)                   AS inquiry_count
  FROM public.crm_inquiries
  WHERE crm_contact_id IS NULL
    AND company_name IS NOT NULL
    AND btrim(company_name) <> ''
  GROUP BY lower(btrim(company_name))
),
inserted AS (
  INSERT INTO public.crm_contacts (
    company_name, contact_person, email, phone, country,
    customer_type, first_contact_date, last_contact_date,
    total_inquiries, is_active, created_at, updated_at
  )
  SELECT
    o.company_name, o.contact_person, o.email, o.phone, o.country,
    'prospect', o.first_date, o.last_date,
    o.inquiry_count, true, now(), now()
  FROM orphans o
  ON CONFLICT (company_name) DO UPDATE SET
    last_contact_date = EXCLUDED.last_contact_date,
    updated_at        = now()
  RETURNING id, company_name
)
UPDATE public.crm_inquiries i
SET crm_contact_id = ins.id
FROM inserted ins
WHERE i.crm_contact_id IS NULL
  AND i.company_name IS NOT NULL
  AND lower(btrim(ins.company_name)) = lower(btrim(i.company_name));

-- ── 4. Column semantics documentation ────────────────────────────────────────
COMMENT ON COLUMN public.crm_inquiries.crm_contact_id IS
  'FK to crm_contacts — the CRM prospect this inquiry is about. Populated by the CRM Add/Select Customer flow. Independent of customer_id.';
COMMENT ON COLUMN public.crm_inquiries.customer_id IS
  'FK to customers (ERP master). Only set when the CRM prospect has been promoted to an ERP trading customer. May be NULL for pure prospects.';

NOTIFY pgrst, 'reload schema';

COMMIT;
