-- CRM Phase 3: additive inquiry-to-sales-order traceability foundation.
--
-- This migration changes schema metadata only. Existing sales orders remain
-- unchanged and no historical inquiry relationships are inferred or created.

ALTER TABLE public.sales_orders
  ADD COLUMN IF NOT EXISTS inquiry_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'sales_orders_inquiry_id_fkey'
      AND conrelid = 'public.sales_orders'::regclass
  ) THEN
    ALTER TABLE public.sales_orders
      ADD CONSTRAINT sales_orders_inquiry_id_fkey
      FOREIGN KEY (inquiry_id)
      REFERENCES public.crm_inquiries(id)
      ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_sales_orders_inquiry_id
  ON public.sales_orders(inquiry_id);

COMMENT ON COLUMN public.sales_orders.inquiry_id IS
  'Optional CRM source inquiry; populated only for an explicit future CRM-to-SO creation.';

NOTIFY pgrst, 'reload schema';
