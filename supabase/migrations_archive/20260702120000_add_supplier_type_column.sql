-- Add supplier_type to suppliers table
-- This is a UI-only metadata column with no effect on triggers, RPCs, or accounting logic.
-- Existing rows get supplier_type = NULL — no backfill needed.

ALTER TABLE public.suppliers
  ADD COLUMN IF NOT EXISTS supplier_type VARCHAR(50);

COMMENT ON COLUMN public.suppliers.supplier_type IS
  'Import Broker | Utility | Transport | Employee | Government | Professional Services | General';
