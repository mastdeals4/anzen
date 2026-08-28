/*
  # Fix credit note stock timing + atomic payment voucher RPC + batch overdue balances

  ## Changes
  1. Fix trg_credit_note_item_inventory: stock is only added when CN is APPROVED, not on creation
  2. Add trg_credit_note_status_change: when status → 'approved', add stock for all items
     (skips items already having an inventory transaction to avoid double-counting for CNs
      created before this migration was applied)
  3. Create save_payment_voucher RPC: atomic insert of voucher + allocations + invoice updates
  4. Create get_overdue_balances RPC: returns all overdue sales invoice balances in one query
  5. Create get_cogs_for_period RPC: returns COGS from batch landed costs for a date range
*/

-- =====================================================================
-- 1. Fix credit note item trigger: only add stock when CN is approved
-- =====================================================================
CREATE OR REPLACE FUNCTION trg_credit_note_item_inventory()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_credit_note_number text;
  v_user_id uuid;
  v_status text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT cn.credit_note_number, cn.created_by, COALESCE(cn.status, 'pending')
    INTO v_credit_note_number, v_user_id, v_status
    FROM credit_notes cn WHERE cn.id = NEW.credit_note_id;

    -- Only add stock if credit note is already in approved state (edge case)
    -- Normal flow: CNs are created as 'pending', stock is added when approved
    IF v_status = 'approved' THEN
      INSERT INTO inventory_transactions (
        product_id, batch_id, transaction_type, quantity,
        transaction_date, reference_number, notes, created_by
      ) VALUES (
        NEW.product_id, NEW.batch_id, 'return', NEW.quantity,
        (SELECT credit_note_date FROM credit_notes WHERE id = NEW.credit_note_id),
        v_credit_note_number,
        'Credit note (return): ' || v_credit_note_number,
        v_user_id
      );
    END IF;
    RETURN NEW;

  ELSIF TG_OP = 'DELETE' THEN
    SELECT cn.credit_note_number, COALESCE(cn.status, 'pending')
    INTO v_credit_note_number, v_status
    FROM credit_notes cn WHERE cn.id = OLD.credit_note_id;

    -- Only reverse stock if the credit note was approved (meaning stock was actually added)
    IF v_status = 'approved' THEN
      INSERT INTO inventory_transactions (
        product_id, batch_id, transaction_type, quantity,
        transaction_date, reference_number, notes, created_by
      ) VALUES (
        OLD.product_id, OLD.batch_id, 'adjustment', -OLD.quantity,
        CURRENT_DATE, v_credit_note_number,
        'Reversed credit note item: ' || v_credit_note_number,
        auth.uid()
      );
    END IF;
    RETURN OLD;
  END IF;
END;
$$;

-- =====================================================================
-- 2. Add trigger on credit_notes status change to handle stock adjustment
-- =====================================================================
CREATE OR REPLACE FUNCTION trg_credit_note_status_change()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_item RECORD;
BEGIN
  -- When a credit note transitions to 'approved', add stock for all items
  -- Skip if stock was already added (CNs created before this migration had immediate stock addition)
  IF NEW.status = 'approved' AND COALESCE(OLD.status, 'pending') != 'approved' THEN
    FOR v_item IN SELECT * FROM credit_note_items WHERE credit_note_id = NEW.id LOOP
      -- Check if a return transaction already exists for this CN + batch to prevent double-counting
      IF NOT EXISTS (
        SELECT 1 FROM inventory_transactions
        WHERE reference_number = NEW.credit_note_number
          AND batch_id = v_item.batch_id
          AND transaction_type = 'return'
          AND quantity > 0
      ) THEN
        INSERT INTO inventory_transactions (
          product_id, batch_id, transaction_type, quantity,
          transaction_date, reference_number, notes, created_by
        ) VALUES (
          v_item.product_id, v_item.batch_id, 'return', v_item.quantity,
          NEW.credit_note_date, NEW.credit_note_number,
          'Credit note approved (return): ' || NEW.credit_note_number,
          NEW.approved_by
        );
      END IF;
    END LOOP;
  END IF;

  -- If a previously-approved CN is rejected, reverse the stock
  IF COALESCE(OLD.status, 'pending') = 'approved' AND NEW.status = 'rejected' THEN
    FOR v_item IN SELECT * FROM credit_note_items WHERE credit_note_id = NEW.id LOOP
      INSERT INTO inventory_transactions (
        product_id, batch_id, transaction_type, quantity,
        transaction_date, reference_number, notes, created_by
      ) VALUES (
        v_item.product_id, v_item.batch_id, 'adjustment', -v_item.quantity,
        CURRENT_DATE, NEW.credit_note_number,
        'Credit note rejected - stock reversed: ' || NEW.credit_note_number,
        auth.uid()
      );
    END LOOP;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_credit_note_status ON credit_notes;
CREATE TRIGGER trigger_credit_note_status
  AFTER UPDATE ON credit_notes
  FOR EACH ROW
  EXECUTE FUNCTION trg_credit_note_status_change();

-- =====================================================================
-- 3. Atomic save_payment_voucher RPC
-- =====================================================================
CREATE OR REPLACE FUNCTION save_payment_voucher(
  p_voucher_date date,
  p_supplier_id uuid,
  p_payment_method text,
  p_bank_account_id uuid,
  p_reference_number text,
  p_amount numeric,
  p_pph_amount numeric,
  p_pph_code_id uuid,
  p_description text,
  p_created_by uuid,
  p_allocations jsonb
)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_voucher_id uuid;
  v_voucher_number text;
  v_alloc jsonb;
  v_invoice_id uuid;
  v_alloc_amount numeric;
  v_total_paid numeric;
  v_total_amount numeric;
  v_new_balance numeric;
BEGIN
  -- Generate voucher number using existing atomic function
  v_voucher_number := generate_voucher_number('PV');

  -- Insert the payment voucher
  INSERT INTO payment_vouchers (
    voucher_number, voucher_date, supplier_id, payment_method,
    bank_account_id, reference_number, amount, pph_amount, pph_code_id,
    description, created_by
  ) VALUES (
    v_voucher_number, p_voucher_date, p_supplier_id, p_payment_method,
    p_bank_account_id, p_reference_number, p_amount, p_pph_amount, p_pph_code_id,
    p_description, p_created_by
  ) RETURNING id INTO v_voucher_id;

  -- Process each allocation atomically
  FOR v_alloc IN SELECT * FROM jsonb_array_elements(p_allocations) LOOP
    v_invoice_id := (v_alloc->>'invoice_id')::uuid;
    v_alloc_amount := (v_alloc->>'amount')::numeric;

    INSERT INTO voucher_allocations (
      voucher_type, payment_voucher_id, purchase_invoice_id, allocated_amount
    ) VALUES (
      'payment', v_voucher_id, v_invoice_id, v_alloc_amount
    );

    -- Recompute balance from ALL allocations (not just this one) to avoid race conditions
    SELECT
      COALESCE(SUM(va.allocated_amount), 0),
      pi.total_amount
    INTO v_total_paid, v_total_amount
    FROM purchase_invoices pi
    LEFT JOIN voucher_allocations va ON va.purchase_invoice_id = pi.id
      AND va.voucher_type = 'payment'
    WHERE pi.id = v_invoice_id
    GROUP BY pi.total_amount;

    v_new_balance := GREATEST(0, v_total_amount - v_total_paid);

    UPDATE purchase_invoices
    SET
      paid_amount = v_total_paid,
      balance_amount = v_new_balance,
      status = CASE WHEN v_new_balance <= 0 THEN 'paid' ELSE 'partial' END
    WHERE id = v_invoice_id;
  END LOOP;

  RETURN v_voucher_id;
END;
$$;

-- =====================================================================
-- 4. Batch overdue invoice balances (replaces N+1 loop in Dashboard)
-- =====================================================================
CREATE OR REPLACE FUNCTION get_overdue_balances()
RETURNS TABLE(invoice_id uuid, balance_due numeric)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN QUERY
  SELECT
    si.id AS invoice_id,
    GREATEST(
      0::numeric,
      si.total_amount - COALESCE(
        (SELECT SUM(va.allocated_amount)
         FROM voucher_allocations va
         WHERE va.sales_invoice_id = si.id AND va.voucher_type = 'receipt'),
        0::numeric
      )
    ) AS balance_due
  FROM sales_invoices si
  WHERE si.payment_status IN ('pending', 'partial')
    AND si.due_date::date < CURRENT_DATE;
END;
$$;

-- =====================================================================
-- 5. COGS for period (real profit calculation from landed costs)
-- =====================================================================
CREATE OR REPLACE FUNCTION get_cogs_for_period(p_start date, p_end date)
RETURNS numeric LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_cogs numeric;
BEGIN
  SELECT COALESCE(SUM(sii.quantity * COALESCE(b.landed_cost_per_unit, 0)), 0)
  INTO v_cogs
  FROM sales_invoice_items sii
  JOIN batches b ON sii.batch_id = b.id
  JOIN sales_invoices si ON sii.invoice_id = si.id
  WHERE si.invoice_date BETWEEN p_start AND p_end;

  RETURN v_cogs;
END;
$$;
