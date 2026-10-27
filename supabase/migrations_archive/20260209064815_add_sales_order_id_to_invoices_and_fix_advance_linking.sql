/*
  # Fix Advance Payment Linking Between Sales Orders and Invoices

  1. Schema Changes
    - Add `sales_order_id` column to `sales_invoices` table (FK to sales_orders)
    - Add index on `sales_order_id` for performance

  2. New Functions
    - `apply_advance_to_invoice()` - Trigger function that auto-applies SO advance payments
      to the newly created invoice when `sales_order_id` is set
    - Updates `get_invoice_paid_amount()` to also include `invoice_payment_allocations`

  3. Triggers
    - `trg_apply_advance_to_invoice` on `sales_invoices` AFTER INSERT
      Automatically transfers advance payment allocations from SO to invoice

  4. Security
    - No RLS changes needed (existing policies cover the new column)

  5. Important Notes
    - When a sales invoice is created with a linked sales_order_id, any advance
      payments previously allocated to that SO are automatically transferred to the invoice
    - The advance allocation on the SO is removed/reduced accordingly
    - Invoice paid_amount and payment_status are updated automatically
*/

-- 1. Add sales_order_id column to sales_invoices
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'sales_invoices' AND column_name = 'sales_order_id'
  ) THEN
    ALTER TABLE sales_invoices
    ADD COLUMN sales_order_id UUID REFERENCES sales_orders(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_sales_invoices_sales_order_id
  ON sales_invoices(sales_order_id);

-- 2. Create the apply_advance_to_invoice function
CREATE OR REPLACE FUNCTION apply_advance_to_invoice()
RETURNS TRIGGER
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql AS $$
DECLARE
  v_advance_rec RECORD;
  v_total_advance DECIMAL(18,2) := 0;
  v_remaining_invoice DECIMAL(18,2);
  v_amount_to_apply DECIMAL(18,2);
BEGIN
  IF NEW.sales_order_id IS NULL THEN
    RETURN NEW;
  END IF;

  FOR v_advance_rec IN
    SELECT va.id, va.receipt_voucher_id, va.allocated_amount
    FROM voucher_allocations va
    WHERE va.sales_order_id = NEW.sales_order_id
      AND va.voucher_type = 'receipt'
    ORDER BY va.created_at ASC
  LOOP
    v_remaining_invoice := NEW.total_amount - v_total_advance;

    IF v_remaining_invoice <= 0 THEN
      EXIT;
    END IF;

    v_amount_to_apply := LEAST(v_advance_rec.allocated_amount, v_remaining_invoice);

    INSERT INTO voucher_allocations (
      voucher_type,
      receipt_voucher_id,
      sales_invoice_id,
      allocated_amount
    ) VALUES (
      'receipt',
      v_advance_rec.receipt_voucher_id,
      NEW.id,
      v_amount_to_apply
    );

    IF v_amount_to_apply >= v_advance_rec.allocated_amount THEN
      DELETE FROM voucher_allocations WHERE id = v_advance_rec.id;
    ELSE
      UPDATE voucher_allocations
      SET allocated_amount = allocated_amount - v_amount_to_apply
      WHERE id = v_advance_rec.id;
    END IF;

    v_total_advance := v_total_advance + v_amount_to_apply;
  END LOOP;

  IF v_total_advance > 0 THEN
    UPDATE sales_invoices
    SET
      paid_amount = v_total_advance,
      payment_status = CASE
        WHEN v_total_advance >= NEW.total_amount THEN 'paid'
        ELSE 'partial'
      END
    WHERE id = NEW.id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_apply_advance_to_invoice ON sales_invoices;
CREATE TRIGGER trg_apply_advance_to_invoice
  AFTER INSERT ON sales_invoices
  FOR EACH ROW
  EXECUTE FUNCTION apply_advance_to_invoice();

-- 3. Update get_invoice_paid_amount to also check invoice_payment_allocations
CREATE OR REPLACE FUNCTION get_invoice_paid_amount(p_invoice_id uuid)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_paid_amount NUMERIC;
BEGIN
  SELECT
    COALESCE(
      (SELECT SUM(allocated_amount)
       FROM voucher_allocations
       WHERE sales_invoice_id = p_invoice_id
       AND voucher_type = 'receipt'), 0
    ) +
    COALESCE(
      (SELECT SUM(allocated_amount)
       FROM invoice_payment_allocations
       WHERE invoice_id = p_invoice_id), 0
    )
  INTO v_paid_amount;

  RETURN v_paid_amount;
END;
$$;
