CREATE OR REPLACE FUNCTION public.sync_si_state_on_rv_posting_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_invoice_id uuid;
BEGIN
  IF COALESCE(OLD.is_posted, FALSE) IS DISTINCT FROM COALESCE(NEW.is_posted, FALSE) THEN
    FOR v_invoice_id IN
      SELECT DISTINCT sales_invoice_id
      FROM public.voucher_allocations
      WHERE receipt_voucher_id = NEW.id
        AND voucher_type = 'receipt'
        AND sales_invoice_id IS NOT NULL
    LOOP
      -- Receipt posting already includes any small rounding difference in its
      -- own journal entry. Never let the follow-up invoice routine delete that
      -- journal entry while receipt_vouchers.journal_entry_id references it.
      IF EXISTS (
        SELECT 1
        FROM public.invoice_rounding_adjustments ira
        WHERE ira.receipt_voucher_id = NEW.id
          AND ira.sales_invoice_id = v_invoice_id
          AND ira.journal_entry_id = NEW.journal_entry_id
          AND NEW.journal_entry_id IS NOT NULL
      ) THEN
        PERFORM public.recalculate_sales_invoice_payment_state(v_invoice_id);
      ELSE
        PERFORM public.apply_receipt_allocation_rounding_adjustment(v_invoice_id, NEW.id);
      END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END;
$function$;
