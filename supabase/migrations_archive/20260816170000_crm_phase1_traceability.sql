-- CRM traceability foundation.
-- No accounting, inventory, CRM-contact, or historical document data is changed.

ALTER TABLE public.sales_orders
  ADD COLUMN IF NOT EXISTS inquiry_id uuid REFERENCES public.crm_inquiries(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_sales_orders_inquiry_id
  ON public.sales_orders(inquiry_id);

COMMENT ON COLUMN public.sales_orders.inquiry_id IS
  'Optional CRM source inquiry. Set only when an employee creates an SO from an inquiry.';

NOTIFY pgrst, 'reload schema';
