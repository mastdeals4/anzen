-- During an atomic invoice edit, the RPC deliberately clears
-- sales_invoices.journal_entry_id before deleting/recreating the journal.
-- The old posting trigger was reattaching the old journal during that UPDATE,
-- so the following DELETE violated sales_invoices_journal_entry_id_fkey.

ALTER FUNCTION public.post_sales_invoice_journal()
  RENAME TO post_sales_invoice_journal_impl;

CREATE OR REPLACE FUNCTION public.post_sales_invoice_journal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- An explicit UPDATE from a non-null journal to NULL is the journal
  -- replacement protocol used by update_sales_invoice_atomic. Do not look up
  -- and reattach the old journal; the RPC is about to delete it safely.
  IF TG_OP = 'UPDATE'
     AND NEW.journal_entry_id IS NULL
     AND OLD.journal_entry_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  RETURN post_sales_invoice_journal_impl();
END;
$$;

DROP TRIGGER IF EXISTS trg_post_sales_invoice ON public.sales_invoices;
CREATE TRIGGER trg_post_sales_invoice
  BEFORE INSERT OR UPDATE ON public.sales_invoices
  FOR EACH ROW EXECUTE FUNCTION public.post_sales_invoice_journal();

COMMENT ON FUNCTION public.post_sales_invoice_journal() IS
  'Sales invoice journal posting wrapper; preserves explicit NULL during atomic journal replacement.';
