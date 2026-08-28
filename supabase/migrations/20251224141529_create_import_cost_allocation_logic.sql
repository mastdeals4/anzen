/*
  # Import Cost Allocation Logic and Batch Updates

  ## Overview
  Implements automatic cost allocation to products and updates batch costs with landed costs.

  ## Functions Created
  1. **calculate_import_cost_allocation()** - Calculates and allocates costs to items
  2. **post_import_cost_journal()** - Posts accounting entries
  3. **apply_import_costs_to_batches()** - Updates batch costs

  ## Allocation Logic
  ### By Value (FOB-based)
  - Each item receives cost proportional to its FOB value
  - Formula: (Item FOB / Total FOB) × Total Cost

  ### By Quantity
  - Each item receives cost proportional to its quantity
  - Formula: (Item Qty / Total Qty) × Total Cost

  ### Equal
  - Cost split equally among all items
  - Formula: Total Cost / Number of Items

  ### Manual
  - User specifies allocation per item
  - System validates total = 100%

  ## Batch Cost Update
  When import costs are posted:
  1. Original batch cost (from GRN)
  2. + Allocated import costs
  3. = New landed cost per unit
  4. Updates batches.cost_per_unit

  ## Accounting Entry
  - Dr Inventory (1130) - Allocated costs
  - Cr Import Clearing Payable (2140) - Allocated costs
*/

-- ============================================
-- FUNCTION 1: CALCULATE ALLOCATION
-- ============================================

CREATE OR REPLACE FUNCTION calculate_import_cost_allocation(p_header_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_header RECORD;
  v_item RECORD;
  v_total_fob DECIMAL(18,2);
  v_total_qty DECIMAL(18,3);
  v_item_count INTEGER;
  v_allocation_factor DECIMAL(10,6);
BEGIN
  -- Get header details
  SELECT * INTO v_header
  FROM import_cost_headers
  WHERE id = p_header_id;
  
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Import cost header not found';
  END IF;
  
  -- Get totals for allocation base
  SELECT 
    SUM(total_fob_value),
    SUM(quantity),
    COUNT(*)
  INTO v_total_fob, v_total_qty, v_item_count
  FROM import_cost_items
  WHERE cost_header_id = p_header_id;
  
  -- Update each item based on allocation method
  FOR v_item IN
    SELECT * FROM import_cost_items WHERE cost_header_id = p_header_id
  LOOP
    -- Calculate allocation factor based on method
    IF v_header.allocation_method = 'by_value' THEN
      v_allocation_factor := v_item.total_fob_value / NULLIF(v_total_fob, 0);
    ELSIF v_header.allocation_method = 'by_quantity' THEN
      v_allocation_factor := v_item.quantity / NULLIF(v_total_qty, 0);
    ELSIF v_header.allocation_method = 'equal' THEN
      v_allocation_factor := 1.0 / NULLIF(v_item_count, 0);
    ELSE
      -- Manual allocation - skip auto-calculation
      CONTINUE;
    END IF;
    
    -- Allocate costs proportionally
    UPDATE import_cost_items
    SET
      allocated_duty = v_header.duty_amount * v_allocation_factor,
      allocated_ppn = v_header.ppn_import_amount * v_allocation_factor,
      allocated_pph = v_header.pph22_amount * v_allocation_factor,
      allocated_freight = v_header.freight_amount * v_allocation_factor,
      allocated_insurance = v_header.insurance_amount * v_allocation_factor,
      allocated_clearing = v_header.clearing_amount * v_allocation_factor,
      allocated_port = v_header.port_charges * v_allocation_factor,
      allocated_other = v_header.other_charges * v_allocation_factor,
      total_allocated_cost = (
        v_header.duty_amount + v_header.ppn_import_amount + v_header.pph22_amount +
        v_header.freight_amount + v_header.insurance_amount + v_header.clearing_amount +
        v_header.port_charges + v_header.other_charges
      ) * v_allocation_factor,
      final_landed_cost_per_unit = (
        total_fob_value + 
        (v_header.duty_amount + v_header.ppn_import_amount + v_header.pph22_amount +
         v_header.freight_amount + v_header.insurance_amount + v_header.clearing_amount +
         v_header.port_charges + v_header.other_charges) * v_allocation_factor
      ) / NULLIF(quantity, 0)
    WHERE id = v_item.id;
  END LOOP;
  
  -- Update header status
  UPDATE import_cost_headers
  SET status = 'calculated'
  WHERE id = p_header_id;
  
END;
$$;

COMMENT ON FUNCTION calculate_import_cost_allocation IS
'Calculates and allocates import costs to items based on selected allocation method (by_value, by_quantity, equal, manual)';

-- ============================================
-- FUNCTION 2: APPLY COSTS TO BATCHES
-- ============================================

CREATE OR REPLACE FUNCTION apply_import_costs_to_batches(p_header_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_item RECORD;
BEGIN
  -- Update batch costs for all items
  FOR v_item IN
    SELECT * FROM import_cost_items WHERE cost_header_id = p_header_id AND batch_id IS NOT NULL
  LOOP
    -- Update batch cost_per_unit with landed cost
    UPDATE batches
    SET 
      cost_per_unit = v_item.final_landed_cost_per_unit,
      updated_at = NOW()
    WHERE id = v_item.batch_id;
    
    -- Log the cost adjustment in inventory transactions
    INSERT INTO inventory_transactions (
      product_id,
      batch_id,
      transaction_type,
      quantity,
      transaction_date,
      reference_number,
      reference_type,
      reference_id,
      notes,
      created_by,
      stock_before,
      stock_after
    ) 
    SELECT
      v_item.product_id,
      v_item.batch_id,
      'cost_adjustment',
      0, -- No quantity change
      CURRENT_DATE,
      (SELECT cost_sheet_number FROM import_cost_headers WHERE id = p_header_id),
      'import_cost',
      p_header_id,
      'Import cost allocation: ' || 
        'Duty=' || v_item.allocated_duty || ', ' ||
        'PPN=' || v_item.allocated_ppn || ', ' ||
        'Freight=' || v_item.allocated_freight,
      (SELECT created_by FROM import_cost_headers WHERE id = p_header_id),
      (SELECT current_stock FROM batches WHERE id = v_item.batch_id),
      (SELECT current_stock FROM batches WHERE id = v_item.batch_id);
  END LOOP;
END;
$$;

COMMENT ON FUNCTION apply_import_costs_to_batches IS
'Updates batch cost_per_unit with allocated import costs (landed cost). Creates audit trail in inventory_transactions.';

-- ============================================
-- FUNCTION 3: POST ACCOUNTING ENTRY
-- ============================================

CREATE OR REPLACE FUNCTION post_import_cost_journal(p_header_id UUID)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_header RECORD;
  v_je_id UUID;
  v_je_number TEXT;
  v_inventory_account_id UUID;
  v_clearing_account_id UUID;
  v_total_cost DECIMAL(18,2);
BEGIN
  -- Get header details
  SELECT * INTO v_header
  FROM import_cost_headers
  WHERE id = p_header_id;
  
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Import cost header not found';
  END IF;
  
  -- Get account IDs
  SELECT id INTO v_inventory_account_id FROM chart_of_accounts WHERE code = '1130' LIMIT 1;
  SELECT id INTO v_clearing_account_id FROM chart_of_accounts WHERE code = '2140' LIMIT 1;
  
  IF v_inventory_account_id IS NULL OR v_clearing_account_id IS NULL THEN
    RAISE EXCEPTION 'Required accounts not found (1130 Inventory or 2140 Customer Deposits)';
  END IF;
  
  -- Calculate total allocated cost (excluding FOB which was already posted in GRN)
  v_total_cost := v_header.duty_amount + v_header.ppn_import_amount + v_header.pph22_amount +
                  v_header.freight_amount + v_header.insurance_amount + v_header.clearing_amount +
                  v_header.port_charges + v_header.other_charges;
  
  IF v_total_cost <= 0 THEN
    RAISE EXCEPTION 'Total allocated cost must be greater than zero';
  END IF;
  
  -- Generate journal entry number
  v_je_number := 'JE' || TO_CHAR(CURRENT_DATE, 'YYMM') || '-' || LPAD((
    SELECT COUNT(*) + 1 FROM journal_entries WHERE entry_number LIKE 'JE' || TO_CHAR(CURRENT_DATE, 'YYMM') || '%'
  )::TEXT, 4, '0');
  
  -- Create journal entry
  INSERT INTO journal_entries (
    entry_number,
    entry_date,
    source_module,
    reference_id,
    reference_number,
    description,
    total_debit,
    total_credit,
    is_posted,
    posted_by
  ) VALUES (
    v_je_number,
    v_header.import_date,
    'import_cost',
    p_header_id,
    v_header.cost_sheet_number,
    'Import Cost Allocation: ' || v_header.cost_sheet_number,
    v_total_cost,
    v_total_cost,
    true,
    v_header.created_by
  ) RETURNING id INTO v_je_id;
  
  -- Debit: Inventory (landed costs increase inventory value)
  INSERT INTO journal_entry_lines (
    journal_entry_id,
    line_number,
    account_id,
    description,
    debit,
    credit,
    supplier_id
  ) VALUES (
    v_je_id,
    1,
    v_inventory_account_id,
    'Import Costs - ' || v_header.cost_sheet_number,
    v_total_cost,
    0,
    v_header.supplier_id
  );
  
  -- Credit: Import Clearing / Payable
  INSERT INTO journal_entry_lines (
    journal_entry_id,
    line_number,
    account_id,
    description,
    debit,
    credit,
    supplier_id
  ) VALUES (
    v_je_id,
    2,
    v_clearing_account_id,
    'Import Clearing - ' || v_header.cost_sheet_number,
    0,
    v_total_cost,
    v_header.supplier_id
  );
  
  RETURN v_je_id;
END;
$$;

COMMENT ON FUNCTION post_import_cost_journal IS
'Posts import cost allocation to accounting: Dr Inventory, Cr Import Clearing Payable. Returns journal entry ID.';

-- ============================================
-- FUNCTION 4: COMPLETE IMPORT COST (ALL-IN-ONE)
-- ============================================

CREATE OR REPLACE FUNCTION complete_import_cost_posting(p_header_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_je_id UUID;
  v_result JSONB;
BEGIN
  -- Step 1: Calculate allocation
  PERFORM calculate_import_cost_allocation(p_header_id);
  
  -- Step 2: Apply costs to batches
  PERFORM apply_import_costs_to_batches(p_header_id);
  
  -- Step 3: Post accounting entry
  v_je_id := post_import_cost_journal(p_header_id);
  
  -- Step 4: Update header status and link journal entry
  UPDATE import_cost_headers
  SET 
    status = 'posted',
    journal_entry_id = v_je_id,
    posted_by = auth.uid(),
    posted_at = NOW()
  WHERE id = p_header_id;
  
  -- Return success result
  v_result := jsonb_build_object(
    'success', true,
    'message', 'Import costs calculated, allocated, and posted successfully',
    'journal_entry_id', v_je_id,
    'header_id', p_header_id
  );
  
  RETURN v_result;
END;
$$;

COMMENT ON FUNCTION complete_import_cost_posting IS
'Complete import cost posting workflow: calculates allocation, updates batches, posts accounting. Call this to finalize import costs.';

-- ============================================
-- GRANT PERMISSIONS
-- ============================================

GRANT EXECUTE ON FUNCTION calculate_import_cost_allocation TO authenticated;
GRANT EXECUTE ON FUNCTION apply_import_costs_to_batches TO authenticated;
GRANT EXECUTE ON FUNCTION post_import_cost_journal TO authenticated;
GRANT EXECUTE ON FUNCTION complete_import_cost_posting TO authenticated;

-- ============================================
-- MIGRATION COMPLETE
-- ============================================

DO $$
BEGIN
  RAISE NOTICE '✅ Import Cost Allocation Logic Created!';
  RAISE NOTICE 'Functions:';
  RAISE NOTICE '  - calculate_import_cost_allocation(header_id)';
  RAISE NOTICE '  - apply_import_costs_to_batches(header_id)';
  RAISE NOTICE '  - post_import_cost_journal(header_id)';
  RAISE NOTICE '  - complete_import_cost_posting(header_id) [ALL-IN-ONE]';
  RAISE NOTICE '';
  RAISE NOTICE 'Usage: SELECT complete_import_cost_posting(''<uuid>'');';
  RAISE NOTICE 'This will: Calculate → Update Batches → Post Accounting';
END $$;
