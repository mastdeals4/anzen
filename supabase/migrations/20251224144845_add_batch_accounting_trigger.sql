/*
  # Add Accounting Trigger to Batches

  ## Overview
  Automatically posts journal entries when batches are created (goods received).
  This simplifies the procurement flow by removing the need for a separate GRN module.

  ## Accounting Entry Created
  When batch is inserted:
  - Dr Inventory (1130) - Purchase cost
  - Dr PPN Input (1150) - 11% VAT (if applicable)
  - Cr Accounts Payable (2110) - Total amount due to supplier

  ## Features
  - Creates journal entry automatically on batch creation
  - Links journal entry to batch
  - Records supplier details in journal lines
  - Calculates PPN based on cost

  ## Workflow
  1. Create Purchase Order (optional)
  2. Create Batch → Auto-posts accounting
  3. Add Import Costs (optional)
  4. Supplier Invoice → Payment
*/

-- ============================================
-- BATCH ACCOUNTING TRIGGER FUNCTION
-- ============================================

CREATE OR REPLACE FUNCTION post_batch_purchase_journal()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_je_id UUID;
  v_je_number TEXT;
  v_inventory_account_id UUID;
  v_ap_account_id UUID;
  v_ppn_account_id UUID;
  v_purchase_value DECIMAL(18,2);
  v_ppn_amount DECIMAL(18,2);
  v_total_amount DECIMAL(18,2);
BEGIN
  -- Only post on insert for batches with supplier
  IF TG_OP = 'INSERT' AND NEW.supplier_id IS NOT NULL THEN
    
    -- Calculate purchase value
    v_purchase_value := NEW.quantity_purchased * NEW.cost_per_unit;
    v_ppn_amount := v_purchase_value * 0.11; -- 11% PPN
    v_total_amount := v_purchase_value + v_ppn_amount;
    
    -- Skip if amount is zero
    IF v_total_amount <= 0 THEN
      RETURN NEW;
    END IF;
    
    -- Get account IDs
    SELECT id INTO v_inventory_account_id FROM chart_of_accounts WHERE code = '1130' LIMIT 1;
    SELECT id INTO v_ap_account_id FROM chart_of_accounts WHERE code = '2110' LIMIT 1;
    SELECT id INTO v_ppn_account_id FROM chart_of_accounts WHERE code = '1150' LIMIT 1;
    
    IF v_inventory_account_id IS NULL OR v_ap_account_id IS NULL THEN
      -- If accounts don't exist, skip accounting (don't fail the batch creation)
      RETURN NEW;
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
      NEW.purchase_date, 
      'batch_purchase', 
      NEW.id, 
      NEW.batch_number,
      'Goods Received - Batch: ' || NEW.batch_number,
      v_total_amount, 
      v_total_amount, 
      true, 
      NEW.created_by
    ) RETURNING id INTO v_je_id;
    
    -- Debit: Inventory (purchase value)
    INSERT INTO journal_entry_lines (
      journal_entry_id, 
      line_number, 
      account_id, 
      description, 
      debit, 
      credit, 
      supplier_id,
      batch_id
    ) VALUES (
      v_je_id, 
      1, 
      v_inventory_account_id, 
      'Inventory - Batch ' || NEW.batch_number, 
      v_purchase_value, 
      0, 
      NEW.supplier_id,
      NEW.id
    );
    
    -- Debit: PPN Input (if applicable)
    IF v_ppn_amount > 0 AND v_ppn_account_id IS NOT NULL THEN
      INSERT INTO journal_entry_lines (
        journal_entry_id, 
        line_number, 
        account_id, 
        description, 
        debit, 
        credit, 
        supplier_id,
        batch_id
      ) VALUES (
        v_je_id, 
        2, 
        v_ppn_account_id, 
        'PPN Input - Batch ' || NEW.batch_number, 
        v_ppn_amount, 
        0, 
        NEW.supplier_id,
        NEW.id
      );
    END IF;
    
    -- Credit: Accounts Payable (total amount)
    INSERT INTO journal_entry_lines (
      journal_entry_id, 
      line_number, 
      account_id, 
      description, 
      debit, 
      credit, 
      supplier_id,
      batch_id
    ) VALUES (
      v_je_id, 
      3, 
      v_ap_account_id, 
      'A/P - Batch ' || NEW.batch_number, 
      0, 
      v_total_amount, 
      NEW.supplier_id,
      NEW.id
    );
    
  END IF;
  
  RETURN NEW;
END;
$$;

-- ============================================
-- CREATE TRIGGER
-- ============================================

DROP TRIGGER IF EXISTS trg_post_batch_purchase_journal ON batches;
CREATE TRIGGER trg_post_batch_purchase_journal
  AFTER INSERT ON batches
  FOR EACH ROW
  EXECUTE FUNCTION post_batch_purchase_journal();

COMMENT ON FUNCTION post_batch_purchase_journal IS
'Posts batch purchase to accounting: Dr Inventory + Dr PPN Input, Cr Accounts Payable. Triggered when batch is created with supplier.';

-- ============================================
-- DROP OLD GRN TABLES (Cleanup)
-- ============================================

DROP TABLE IF EXISTS goods_receipt_items CASCADE;
DROP TABLE IF EXISTS goods_receipt_notes CASCADE;

-- ============================================
-- MIGRATION COMPLETE
-- ============================================

DO $$
BEGIN
  RAISE NOTICE '✅ Batch Accounting Trigger Created!';
  RAISE NOTICE 'Entry: Dr Inventory (1130), Dr PPN Input (1150), Cr Accounts Payable (2110)';
  RAISE NOTICE 'Triggered on: Batch creation with supplier';
  RAISE NOTICE 'Old GRN tables dropped - using Batches page directly';
  RAISE NOTICE '';
  RAISE NOTICE 'Simplified Flow: Purchase Order → Batches → Accounting';
END $$;
