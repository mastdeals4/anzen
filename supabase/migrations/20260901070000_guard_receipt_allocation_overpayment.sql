-- Finance integrity: receipt allocations must never exceed the receipt value.
-- An excess receipt is intentionally left unallocated (customer advance policy
-- can classify it separately); silently allocating it to AR overstates
-- settlement and creates negative customer balances.
CREATE OR REPLACE FUNCTION public.prevent_receipt_allocation_overpayment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_receipt_amount numeric;
  v_existing numeric;
BEGIN
  IF NEW.voucher_type <> 'receipt' OR NEW.receipt_voucher_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.sales_invoice_id IS NULL AND NEW.sales_order_id IS NULL THEN
    RAISE EXCEPTION 'Receipt allocation must reference a sales invoice or sales order';
  END IF;
  IF NEW.sales_invoice_id IS NOT NULL AND NEW.sales_order_id IS NOT NULL THEN
    RAISE EXCEPTION 'Receipt allocation cannot reference both a sales invoice and sales order';
  END IF;
  IF COALESCE(NEW.allocated_amount, 0) <= 0 THEN
    RAISE EXCEPTION 'Receipt allocation amount must be greater than zero';
  END IF;

  -- Lock the voucher while checking to make concurrent allocations safe.
  SELECT amount INTO v_receipt_amount
    FROM public.receipt_vouchers
   WHERE id = NEW.receipt_voucher_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Receipt voucher % not found', NEW.receipt_voucher_id;
  END IF;

  SELECT COALESCE(sum(allocated_amount), 0) INTO v_existing
    FROM public.voucher_allocations
   WHERE receipt_voucher_id = NEW.receipt_voucher_id
     AND voucher_type = 'receipt'
     AND (TG_OP <> 'UPDATE' OR id <> NEW.id);
  IF v_existing + NEW.allocated_amount > COALESCE(v_receipt_amount, 0) + 0.01 THEN
    RAISE EXCEPTION 'Receipt allocations exceed receipt amount (%, attempted %) ',
      v_receipt_amount, v_existing + NEW.allocated_amount;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.prevent_receipt_allocation_overpayment() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prevent_receipt_allocation_overpayment() TO service_role;

DROP TRIGGER IF EXISTS trg_prevent_receipt_allocation_overpayment ON public.voucher_allocations;
CREATE TRIGGER trg_prevent_receipt_allocation_overpayment
  BEFORE INSERT OR UPDATE OF allocated_amount, receipt_voucher_id, voucher_type,
    sales_invoice_id, sales_order_id
  ON public.voucher_allocations
  FOR EACH ROW EXECUTE FUNCTION public.prevent_receipt_allocation_overpayment();

COMMENT ON FUNCTION public.prevent_receipt_allocation_overpayment() IS
  'Prevents receipt allocations from exceeding voucher amount and enforces one target per allocation.';

-- Keep SO-advance conversion compatible with the guard above: consume the
-- source SO allocation before creating its invoice allocation.
CREATE OR REPLACE FUNCTION public.apply_advance_to_invoice()
RETURNS trigger SECURITY DEFINER SET search_path = public, pg_temp
LANGUAGE plpgsql AS $$
DECLARE r record; v_applied numeric := 0; v_remaining numeric; v_take numeric;
BEGIN
  IF NEW.sales_order_id IS NULL THEN RETURN NEW; END IF;
  FOR r IN SELECT id, receipt_voucher_id, allocated_amount
             FROM public.voucher_allocations
            WHERE sales_order_id = NEW.sales_order_id AND voucher_type = 'receipt'
            ORDER BY created_at, id
  LOOP
    v_remaining := NEW.total_amount - v_applied;
    EXIT WHEN v_remaining <= 0;
    v_take := LEAST(r.allocated_amount, v_remaining);
    IF v_take >= r.allocated_amount THEN
      DELETE FROM public.voucher_allocations WHERE id = r.id;
    ELSE
      UPDATE public.voucher_allocations SET allocated_amount = allocated_amount - v_take WHERE id = r.id;
    END IF;
    INSERT INTO public.voucher_allocations(voucher_type, receipt_voucher_id, sales_invoice_id, allocated_amount)
      VALUES ('receipt', r.receipt_voucher_id, NEW.id, v_take);
    v_applied := v_applied + v_take;
  END LOOP;
  IF v_applied > 0 THEN
    UPDATE public.sales_invoices
       SET paid_amount = v_applied,
           balance_amount = total_amount - v_applied,
           payment_status = CASE WHEN v_applied >= total_amount THEN 'paid' ELSE 'partial' END,
           updated_at = now()
     WHERE id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

NOTIFY pgrst, 'reload schema';
