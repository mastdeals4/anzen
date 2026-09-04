/*
  # Fix app_settings: add missing rounding columns + deduplicate rows

  ## Problems
  1. rounding_tolerance_amount, rounding_writeoff_account_id, rounding_gain_account_id
     were defined in 20260616120000 but that migration was never applied, so
     Settings.tsx save fails with 400 (unknown column).

  2. app_settings has 2 rows. Settings.tsx uses .limit(1) without ORDER BY so
     it loads a random row; the worker URL/secret may be on a different row than
     the one that gets saved to.

  ## Fixes
  1. Add the three missing rounding columns (IF NOT EXISTS — safe to re-run).
  2. Merge non-null values from newer row(s) into oldest (canonical) row via COALESCE:
       COALESCE(canonical_value, newer_value)
     This means: canonical value always wins; newer value only fills in when canonical is NULL.
     Columns that are NULL in both rows remain NULL after the merge — no false preservation.
     bulk_email_worker_url / bulk_email_worker_secret: if both rows have NULL, they remain NULL.
     Re-enter them manually in Settings after applying this migration.
  3. Delete the newer row only after the merge completes.
  4. Notify PostgREST to reload schema so new columns are immediately usable.
*/

-- ===========================================================================
-- 1. Add missing rounding columns
-- ===========================================================================
ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS rounding_tolerance_amount   numeric(18,2) NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS rounding_writeoff_account_id uuid NULL
    REFERENCES public.chart_of_accounts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS rounding_gain_account_id    uuid NULL
    REFERENCES public.chart_of_accounts(id) ON DELETE SET NULL;

-- Seed default accounts when the column was just added and is still NULL
UPDATE public.app_settings s
SET
  rounding_writeoff_account_id = COALESCE(
    s.rounding_writeoff_account_id,
    (SELECT id FROM public.chart_of_accounts WHERE code = '6900' LIMIT 1)
  ),
  rounding_gain_account_id = COALESCE(
    s.rounding_gain_account_id,
    (SELECT id FROM public.chart_of_accounts WHERE code = '4900' LIMIT 1)
  );

-- ===========================================================================
-- 2. Deduplicate: merge all non-null data into the oldest row, delete the rest
-- ===========================================================================
DO $$
DECLARE
  v_keep_id   uuid;
  v_newer_id  uuid;
BEGIN
  -- Only run when more than one row exists
  IF (SELECT COUNT(*) FROM public.app_settings) <= 1 THEN
    RETURN;
  END IF;

  -- The oldest row is the canonical one
  SELECT id INTO v_keep_id
  FROM public.app_settings
  ORDER BY created_at ASC NULLS LAST, id ASC
  LIMIT 1;

  -- Merge every non-null value from newer rows into the canonical row
  -- (coalesce picks the canonical value first, falls back to the newer row's value)
  UPDATE public.app_settings dst
  SET
    company_name                  = COALESCE(dst.company_name,                  src.company_name),
    company_address               = COALESCE(dst.company_address,               src.company_address),
    company_phone                 = COALESCE(dst.company_phone,                 src.company_phone),
    company_email                 = COALESCE(dst.company_email,                 src.company_email),
    tax_rate                      = COALESCE(dst.tax_rate,                      src.tax_rate),
    invoice_prefix                = COALESCE(dst.invoice_prefix,                src.invoice_prefix),
    invoice_start_number          = COALESCE(dst.invoice_start_number,          src.invoice_start_number),
    email_host                    = COALESCE(dst.email_host,                    src.email_host),
    email_port                    = COALESCE(dst.email_port,                    src.email_port),
    email_username                = COALESCE(dst.email_username,                src.email_username),
    low_stock_threshold           = COALESCE(dst.low_stock_threshold,           src.low_stock_threshold),
    expiry_alert_days             = COALESCE(dst.expiry_alert_days,             src.expiry_alert_days),
    default_language              = COALESCE(dst.default_language,              src.default_language),
    financial_year_start          = COALESCE(dst.financial_year_start,          src.financial_year_start),
    financial_year_end            = COALESCE(dst.financial_year_end,            src.financial_year_end),
    current_financial_year        = COALESCE(dst.current_financial_year,        src.current_financial_year),
    rounding_tolerance_amount     = COALESCE(dst.rounding_tolerance_amount,     src.rounding_tolerance_amount),
    rounding_writeoff_account_id  = COALESCE(dst.rounding_writeoff_account_id,  src.rounding_writeoff_account_id),
    rounding_gain_account_id      = COALESCE(dst.rounding_gain_account_id,      src.rounding_gain_account_id),
    bulk_email_batch_size         = COALESCE(dst.bulk_email_batch_size,         src.bulk_email_batch_size),
    bulk_email_batch_delay_seconds= COALESCE(dst.bulk_email_batch_delay_seconds,src.bulk_email_batch_delay_seconds),
    bulk_email_worker_url         = COALESCE(dst.bulk_email_worker_url,         src.bulk_email_worker_url),
    bulk_email_worker_secret      = COALESCE(dst.bulk_email_worker_secret,      src.bulk_email_worker_secret)
  FROM (
    SELECT *
    FROM public.app_settings
    WHERE id <> v_keep_id
    ORDER BY created_at DESC NULLS FIRST, id DESC
    LIMIT 1
  ) src
  WHERE dst.id = v_keep_id;

  -- Delete all rows except the canonical one
  DELETE FROM public.app_settings
  WHERE id <> v_keep_id;

  RAISE NOTICE 'app_settings: kept row %, deleted all others', v_keep_id;
END $$;

-- ===========================================================================
-- 3. Reload PostgREST schema cache so new columns are immediately usable
-- ===========================================================================
NOTIFY pgrst, 'reload schema';
