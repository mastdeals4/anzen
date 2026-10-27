/*
  # Fix Function Search Paths for Security - Drop and Recreate

  This migration fixes functions that have role-mutable search_path, which can be a security issue.
  By explicitly setting search_path in each function, we prevent potential SQL injection attacks.

  ## Changes
  
  Drops and recreates functions with explicit search_path:
  - update_inquiry_items_updated_at
  - update_approval_workflows_updated_at
  - check_approval_required
  - generate_return_number
  - generate_rejection_number
  - handle_stock_rejection_approval
  - handle_material_return_approval
  - calculate_return_financial_impact
  - calculate_rejection_financial_loss
  - track_stock_levels_in_transaction
  - get_batch_transaction_history
  - get_rejection_history_with_photos
  - post_petty_cash_to_journal
*/

-- Drop existing functions
DROP FUNCTION IF EXISTS update_inquiry_items_updated_at() CASCADE;
DROP FUNCTION IF EXISTS update_approval_workflows_updated_at() CASCADE;
DROP FUNCTION IF EXISTS check_approval_required(text, decimal) CASCADE;
DROP FUNCTION IF EXISTS generate_return_number() CASCADE;
DROP FUNCTION IF EXISTS generate_rejection_number() CASCADE;
DROP FUNCTION IF EXISTS handle_stock_rejection_approval() CASCADE;
DROP FUNCTION IF EXISTS handle_material_return_approval() CASCADE;
DROP FUNCTION IF EXISTS calculate_return_financial_impact(uuid) CASCADE;
DROP FUNCTION IF EXISTS calculate_rejection_financial_loss(uuid) CASCADE;
DROP FUNCTION IF EXISTS track_stock_levels_in_transaction() CASCADE;
DROP FUNCTION IF EXISTS get_batch_transaction_history(uuid) CASCADE;
DROP FUNCTION IF EXISTS get_rejection_history_with_photos(uuid) CASCADE;
DROP FUNCTION IF EXISTS post_petty_cash_to_journal(uuid) CASCADE;

-- Recreate with fixed search_path

-- Update inquiry items trigger function
CREATE OR REPLACE FUNCTION update_inquiry_items_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- Update approval workflows trigger function
CREATE OR REPLACE FUNCTION update_approval_workflows_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- Check approval required function
CREATE OR REPLACE FUNCTION check_approval_required(
  p_transaction_type text,
  p_amount decimal
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_threshold decimal;
BEGIN
  SELECT amount_threshold INTO v_threshold
  FROM approval_thresholds
  WHERE transaction_type = p_transaction_type
  AND is_active = true
  ORDER BY amount_threshold DESC
  LIMIT 1;

  IF v_threshold IS NULL THEN
    RETURN false;
  END IF;

  RETURN p_amount >= v_threshold;
END;
$$;

-- Generate return number function
CREATE OR REPLACE FUNCTION generate_return_number()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  next_num integer;
  year_suffix text;
BEGIN
  year_suffix := TO_CHAR(CURRENT_DATE, 'YY');
  
  SELECT COALESCE(MAX(
    CASE 
      WHEN return_number ~ '^RET-[0-9]+-[0-9]+$' 
      THEN CAST(split_part(return_number, '-', 2) AS integer)
      ELSE 0
    END
  ), 0) + 1 INTO next_num
  FROM material_returns
  WHERE return_number LIKE 'RET-%';
  
  RETURN 'RET-' || LPAD(next_num::text, 5, '0') || '-' || year_suffix;
END;
$$;

-- Generate rejection number function
CREATE OR REPLACE FUNCTION generate_rejection_number()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  next_num integer;
  year_suffix text;
BEGIN
  year_suffix := TO_CHAR(CURRENT_DATE, 'YY');
  
  SELECT COALESCE(MAX(
    CASE 
      WHEN rejection_number ~ '^REJ-[0-9]+-[0-9]+$' 
      THEN CAST(split_part(rejection_number, '-', 2) AS integer)
      ELSE 0
    END
  ), 0) + 1 INTO next_num
  FROM stock_rejections
  WHERE rejection_number LIKE 'REJ-%';
  
  RETURN 'REJ-' || LPAD(next_num::text, 5, '0') || '-' || year_suffix;
END;
$$;

-- Handle stock rejection approval
CREATE OR REPLACE FUNCTION handle_stock_rejection_approval()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.status = 'approved' AND OLD.status != 'approved' THEN
    INSERT INTO inventory_transactions (
      product_id,
      batch_id,
      transaction_type,
      quantity_change,
      transaction_date,
      notes,
      reference_type,
      reference_id,
      created_by
    )
    VALUES (
      NEW.product_id,
      NEW.batch_id,
      'rejection',
      -NEW.quantity,
      NEW.rejection_date,
      'Stock rejection approved: ' || NEW.reason,
      'stock_rejection',
      NEW.id,
      NEW.approved_by
    );

    UPDATE batches
    SET current_stock = current_stock - NEW.quantity
    WHERE id = NEW.batch_id;
  END IF;

  RETURN NEW;
END;
$$;

-- Handle material return approval
CREATE OR REPLACE FUNCTION handle_material_return_approval()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_item record;
BEGIN
  IF NEW.status = 'approved' AND OLD.status != 'approved' THEN
    FOR v_item IN
      SELECT * FROM material_return_items WHERE return_id = NEW.id
    LOOP
      INSERT INTO inventory_transactions (
        product_id,
        batch_id,
        transaction_type,
        quantity_change,
        transaction_date,
        notes,
        reference_type,
        reference_id,
        created_by
      )
      VALUES (
        v_item.product_id,
        v_item.batch_id,
        'return',
        v_item.quantity_returned,
        NEW.return_date,
        'Material return approved: ' || NEW.reason,
        'material_return',
        NEW.id,
        NEW.approved_by
      );

      UPDATE batches
      SET current_stock = current_stock + v_item.quantity_returned
      WHERE id = v_item.batch_id;
    END LOOP;
  END IF;

  RETURN NEW;
END;
$$;

-- Calculate return financial impact
CREATE OR REPLACE FUNCTION calculate_return_financial_impact(p_return_id uuid)
RETURNS TABLE (
  total_value decimal,
  total_quantity decimal,
  product_count integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN QUERY
  SELECT
    SUM(mri.quantity_returned * mri.unit_price) as total_value,
    SUM(mri.quantity_returned) as total_quantity,
    COUNT(DISTINCT mri.product_id)::integer as product_count
  FROM material_return_items mri
  WHERE mri.return_id = p_return_id;
END;
$$;

-- Calculate rejection financial loss
CREATE OR REPLACE FUNCTION calculate_rejection_financial_loss(p_rejection_id uuid)
RETURNS decimal
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_loss decimal;
BEGIN
  SELECT sr.quantity * b.purchase_price INTO v_loss
  FROM stock_rejections sr
  JOIN batches b ON b.id = sr.batch_id
  WHERE sr.id = p_rejection_id;

  RETURN COALESCE(v_loss, 0);
END;
$$;

-- Track stock levels in transaction
CREATE OR REPLACE FUNCTION track_stock_levels_in_transaction()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.stock_before := (
    SELECT current_stock
    FROM batches
    WHERE id = NEW.batch_id
  );

  NEW.stock_after := NEW.stock_before + NEW.quantity_change;

  RETURN NEW;
END;
$$;

-- Get batch transaction history
CREATE OR REPLACE FUNCTION get_batch_transaction_history(p_batch_id uuid)
RETURNS TABLE (
  transaction_date timestamptz,
  transaction_type text,
  quantity_change decimal,
  stock_before decimal,
  stock_after decimal,
  notes text,
  created_by_name text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN QUERY
  SELECT
    it.transaction_date,
    it.transaction_type,
    it.quantity_change,
    it.stock_before,
    it.stock_after,
    it.notes,
    up.full_name
  FROM inventory_transactions it
  LEFT JOIN user_profiles up ON up.id = it.created_by
  WHERE it.batch_id = p_batch_id
  ORDER BY it.transaction_date DESC, it.created_at DESC;
END;
$$;

-- Get rejection history with photos
CREATE OR REPLACE FUNCTION get_rejection_history_with_photos(p_product_id uuid)
RETURNS TABLE (
  rejection_id uuid,
  rejection_number text,
  rejection_date date,
  batch_number text,
  quantity decimal,
  reason text,
  photo_urls text[]
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN QUERY
  SELECT
    sr.id,
    sr.rejection_number,
    sr.rejection_date,
    b.batch_number,
    sr.quantity,
    sr.reason,
    sr.photo_urls
  FROM stock_rejections sr
  JOIN batches b ON b.id = sr.batch_id
  WHERE sr.product_id = p_product_id
  AND sr.status = 'approved'
  ORDER BY sr.rejection_date DESC;
END;
$$;

-- Post petty cash to journal
CREATE OR REPLACE FUNCTION post_petty_cash_to_journal(p_transaction_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_transaction record;
  v_journal_id uuid;
  v_period_id uuid;
BEGIN
  SELECT * INTO v_transaction
  FROM petty_cash_transactions
  WHERE id = p_transaction_id;

  IF v_transaction IS NULL THEN
    RAISE EXCEPTION 'Transaction not found';
  END IF;

  SELECT id INTO v_period_id
  FROM accounting_periods
  WHERE v_transaction.transaction_date BETWEEN start_date AND end_date
  AND status = 'open'
  LIMIT 1;

  IF v_period_id IS NULL THEN
    RAISE EXCEPTION 'No open accounting period for this date';
  END IF;

  INSERT INTO journal_entries (
    entry_date,
    period_id,
    description,
    reference_number,
    source_type,
    source_id,
    created_by
  )
  VALUES (
    v_transaction.transaction_date,
    v_period_id,
    v_transaction.description,
    v_transaction.voucher_number,
    'petty_cash',
    p_transaction_id,
    v_transaction.created_by
  )
  RETURNING id INTO v_journal_id;

  IF v_transaction.transaction_type = 'expense' THEN
    INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit, description)
    VALUES
      (v_journal_id, v_transaction.expense_account_id, v_transaction.amount, 0, v_transaction.description),
      (v_journal_id, v_transaction.petty_cash_account_id, 0, v_transaction.amount, v_transaction.description);
  ELSE
    INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit, description)
    VALUES
      (v_journal_id, v_transaction.petty_cash_account_id, v_transaction.amount, 0, v_transaction.description),
      (v_journal_id, v_transaction.bank_account_id, 0, v_transaction.amount, v_transaction.description);
  END IF;

  RETURN v_journal_id;
END;
$$;

-- Recreate triggers that were dropped
CREATE TRIGGER set_inquiry_items_updated_at
  BEFORE UPDATE ON crm_inquiry_items
  FOR EACH ROW
  EXECUTE FUNCTION update_inquiry_items_updated_at();

CREATE TRIGGER set_approval_workflows_updated_at
  BEFORE UPDATE ON approval_workflows
  FOR EACH ROW
  EXECUTE FUNCTION update_approval_workflows_updated_at();

CREATE TRIGGER trg_stock_rejection_approval
  AFTER UPDATE ON stock_rejections
  FOR EACH ROW
  WHEN (NEW.status = 'approved' AND OLD.status != 'approved')
  EXECUTE FUNCTION handle_stock_rejection_approval();

CREATE TRIGGER trg_material_return_approval
  AFTER UPDATE ON material_returns
  FOR EACH ROW
  WHEN (NEW.status = 'approved' AND OLD.status != 'approved')
  EXECUTE FUNCTION handle_material_return_approval();

CREATE TRIGGER trg_track_stock_levels
  BEFORE INSERT ON inventory_transactions
  FOR EACH ROW
  EXECUTE FUNCTION track_stock_levels_in_transaction();
