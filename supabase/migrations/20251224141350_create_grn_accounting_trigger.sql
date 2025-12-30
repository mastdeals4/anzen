/*
  # Create GRN Accounting Trigger

  ## Overview
  Automatically posts journal entries when GRN is posted to record inventory receipt
  and accounts payable.

  ## Accounting Entry Created
  When GRN status changes to 'posted':
  - Dr Inventory (1130) - Total amount
  - Cr Accounts Payable (2110) - Total amount

  ## Features
  - Creates journal entry automatically on GRN post
  - Links journal entry to GRN
  - Records supplier details in journal lines
  - Idempotent (won't create duplicate entries)

  ## Double-Entry Bookkeeping
  - Total Debit = Total Credit (balanced entry)
  - Source module: 'goods_receipt_note'
  - Reference: GRN number and ID
*/

-- ============================================
-- GRN ACCOUNTING TRIGGER FUNCTION
-- ============================================

CREATE OR REPLACE FUNCTION post_grn_journal()
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
BEGIN
  -- Only post when status changes to 'posted' and no journal entry exists yet
  IF TG_OP = 'UPDATE' 
     AND NEW.status = 'posted' 
     AND OLD.status = 'draft'
     AND NEW.journal_entry_id IS NULL THEN
    
    -- Get account IDs
    SELECT id INTO v_inventory_account_id FROM chart_of_accounts WHERE code = '1130' LIMIT 1;
    SELECT id INTO v_ap_account_id FROM chart_of_accounts WHERE code = '2110' LIMIT 1;
    SELECT id INTO v_ppn_account_id FROM chart_of_accounts WHERE code = '1150' LIMIT 1; -- PPN Input
    
    IF v_inventory_account_id IS NULL OR v_ap_account_id IS NULL THEN
      -- If accounts don't exist, skip accounting (don't fail the GRN)
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
      NEW.grn_date, 
      'goods_receipt_note', 
      NEW.id, 
      NEW.grn_number,
      'GRN: ' || NEW.grn_number || ' - ' || (SELECT company_name FROM suppliers WHERE id = NEW.supplier_id),
      NEW.total_amount, 
      NEW.total_amount, 
      true, 
      NEW.posted_by
    ) RETURNING id INTO v_je_id;
    
    -- Debit: Inventory (subtotal - before tax)
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
      'Inventory - GRN ' || NEW.grn_number, 
      NEW.subtotal, 
      0, 
      NEW.supplier_id
    );
    
    -- Debit: PPN Input (if applicable)
    IF NEW.tax_amount > 0 AND v_ppn_account_id IS NOT NULL THEN
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
        v_ppn_account_id, 
        'PPN Input - GRN ' || NEW.grn_number, 
        NEW.tax_amount, 
        0, 
        NEW.supplier_id
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
      supplier_id
    ) VALUES (
      v_je_id, 
      3, 
      v_ap_account_id, 
      'A/P - GRN ' || NEW.grn_number, 
      0, 
      NEW.total_amount, 
      NEW.supplier_id
    );
    
    -- Link journal entry to GRN
    NEW.journal_entry_id := v_je_id;
  END IF;
  
  RETURN NEW;
END;
$$;

-- ============================================
-- CREATE TRIGGER
-- ============================================

DROP TRIGGER IF EXISTS trg_post_grn_journal ON goods_receipt_notes;
CREATE TRIGGER trg_post_grn_journal
  BEFORE UPDATE ON goods_receipt_notes
  FOR EACH ROW
  EXECUTE FUNCTION post_grn_journal();

COMMENT ON FUNCTION post_grn_journal IS
'Posts GRN to accounting: Dr Inventory + Dr PPN Input, Cr Accounts Payable. Triggered when GRN status changes to posted.';

-- ============================================
-- MIGRATION COMPLETE
-- ============================================

DO $$
BEGIN
  RAISE NOTICE '✅ GRN Accounting Trigger Created!';
  RAISE NOTICE 'Entry: Dr Inventory (1130), Dr PPN Input (1150), Cr Accounts Payable (2110)';
  RAISE NOTICE 'Triggered on: GRN status change to posted';
  RAISE NOTICE 'Next: Create Import Costing System';
END $$;
