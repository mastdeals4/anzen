-- Pricing worksheet grid fields (Part 5 — Manual Pricing Grid)
--
-- Adds the columns the inline Excel-like pricing grid needs so the user can
-- capture a full quote line without stuffing everything into `remark`.
-- Every column is nullable and added with IF NOT EXISTS so this migration is
-- idempotent and backward-compatible: the frontend folds these values into
-- `remark` when the migration has not yet been applied, and reads/writes the
-- real columns once it has.

ALTER TABLE crm_inquiry_pricing_options
  ADD COLUMN IF NOT EXISTS moq              text,
  ADD COLUMN IF NOT EXISTS packing          text,
  ADD COLUMN IF NOT EXISTS lead_time        text,
  ADD COLUMN IF NOT EXISTS origin           text,
  ADD COLUMN IF NOT EXISTS supplier         text,
  ADD COLUMN IF NOT EXISTS specification    text,
  ADD COLUMN IF NOT EXISTS margin_pct       numeric,
  ADD COLUMN IF NOT EXISTS selling_price    numeric,
  ADD COLUMN IF NOT EXISTS selling_currency text;
