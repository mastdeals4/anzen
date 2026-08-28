/*
  # Prevent Invoice/DC Deletion + Add Credit Notes

  ## Changes:
  1. Prevent deletion of invoices that are linked to DCs
  2. Prevent deletion of DCs that are linked to invoices
  3. Add Credit Notes table for returns
  4. Add trigger to handle credit note inventory

  ## Logic:
  - Invoice linked to DC: CANNOT delete (must delete/unlink DC first)
  - DC linked to Invoice: CANNOT delete (must delete/unlink invoice first)
  - Credit Notes: Work like reverse invoices, add stock back
*/

-- 1. Function to prevent deletion of invoices linked to DCs
CREATE OR REPLACE FUNCTION prevent_linked_invoice_deletion()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_dc_count integer;
BEGIN
  -- Check if invoice is linked to any DCs
  IF OLD.linked_challan_ids IS NOT NULL AND array_length(OLD.linked_challan_ids, 1) > 0 THEN
    -- Get the number of DCs
    v_dc_count := array_length(OLD.linked_challan_ids, 1);
    
    RAISE EXCEPTION 'Cannot delete invoice %. It is linked to % Delivery Challan(s). Please delete or unlink the DCs first.',
      OLD.invoice_number, v_dc_count
    USING HINT = 'Delete the linked Delivery Challans or remove them from this invoice before deleting.';
  END IF;
  
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trigger_prevent_linked_invoice_deletion ON sales_invoices;
CREATE TRIGGER trigger_prevent_linked_invoice_deletion
  BEFORE DELETE ON sales_invoices
  FOR EACH ROW
  EXECUTE FUNCTION prevent_linked_invoice_deletion();

-- 2. Function to prevent deletion of DCs that are linked to invoices
CREATE OR REPLACE FUNCTION prevent_linked_dc_deletion()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_invoice_number text;
  v_invoice_exists boolean;
BEGIN
  -- Check if this DC is linked to any invoice
  SELECT EXISTS (
    SELECT 1 
    FROM sales_invoices si
    WHERE OLD.id = ANY(si.linked_challan_ids)
  ) INTO v_invoice_exists;
  
  IF v_invoice_exists THEN
    -- Get the invoice number
    SELECT invoice_number INTO v_invoice_number
    FROM sales_invoices
    WHERE OLD.id = ANY(linked_challan_ids)
    LIMIT 1;
    
    RAISE EXCEPTION 'Cannot delete Delivery Challan %. It is linked to Invoice %. Please delete the invoice first or remove this DC from the invoice.',
      OLD.challan_number, v_invoice_number
    USING HINT = 'Delete or edit the invoice to unlink this Delivery Challan first.';
  END IF;
  
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trigger_prevent_linked_dc_deletion ON delivery_challans;
CREATE TRIGGER trigger_prevent_linked_dc_deletion
  BEFORE DELETE ON delivery_challans
  FOR EACH ROW
  EXECUTE FUNCTION prevent_linked_dc_deletion();

-- 3. Create Credit Notes table (like invoices but adds stock back)
CREATE TABLE IF NOT EXISTS credit_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  credit_note_number text UNIQUE NOT NULL,
  credit_note_date date NOT NULL,
  customer_id uuid NOT NULL REFERENCES customers(id),
  original_invoice_id uuid REFERENCES sales_invoices(id),
  original_invoice_number text,
  reason text,
  notes text,
  currency text DEFAULT 'IDR',
  subtotal numeric(15,2) DEFAULT 0,
  tax_amount numeric(15,2) DEFAULT 0,
  total_amount numeric(15,2) DEFAULT 0,
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS credit_note_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  credit_note_id uuid NOT NULL REFERENCES credit_notes(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products(id),
  batch_id uuid NOT NULL REFERENCES batches(id),
  quantity numeric(10,3) NOT NULL CHECK (quantity > 0),
  unit_price numeric(15,2) NOT NULL,
  total_price numeric(15,2) GENERATED ALWAYS AS (quantity * unit_price) STORED,
  created_at timestamptz DEFAULT now()
);

-- 4. Create trigger for credit note inventory (adds stock back)
CREATE OR REPLACE FUNCTION trg_credit_note_item_inventory()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_credit_note_number text;
  v_user_id uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Get credit note details
    SELECT cn.credit_note_number, cn.created_by
    INTO v_credit_note_number, v_user_id
    FROM credit_notes cn
    WHERE cn.id = NEW.credit_note_id;
    
    -- Create inventory transaction to ADD stock back (positive quantity)
    INSERT INTO inventory_transactions (
      product_id,
      batch_id,
      transaction_type,
      quantity,
      transaction_date,
      reference_number,
      notes,
      created_by
    ) VALUES (
      NEW.product_id,
      NEW.batch_id,
      'return',
      NEW.quantity,  -- Positive to add stock back
      (SELECT credit_note_date FROM credit_notes WHERE id = NEW.credit_note_id),
      v_credit_note_number,
      'Credit note (return): ' || v_credit_note_number,
      v_user_id
    );
    
    RETURN NEW;
    
  ELSIF TG_OP = 'DELETE' THEN
    -- Get credit note number
    SELECT cn.credit_note_number
    INTO v_credit_note_number
    FROM credit_notes cn
    WHERE cn.id = OLD.credit_note_id;
    
    -- Reverse the return by deducting stock again
    INSERT INTO inventory_transactions (
      product_id,
      batch_id,
      transaction_type,
      quantity,
      transaction_date,
      reference_number,
      notes,
      created_by
    ) VALUES (
      OLD.product_id,
      OLD.batch_id,
      'adjustment',
      -OLD.quantity,  -- Negative to remove stock
      CURRENT_DATE,
      v_credit_note_number,
      'Reversed credit note from deleted item',
      auth.uid()
    );
    
    RETURN OLD;
  END IF;
END;
$$;

DROP TRIGGER IF EXISTS trigger_credit_note_item_insert ON credit_note_items;
CREATE TRIGGER trigger_credit_note_item_insert
  AFTER INSERT ON credit_note_items
  FOR EACH ROW
  EXECUTE FUNCTION trg_credit_note_item_inventory();

DROP TRIGGER IF EXISTS trigger_credit_note_item_delete ON credit_note_items;
CREATE TRIGGER trigger_credit_note_item_delete
  AFTER DELETE ON credit_note_items
  FOR EACH ROW
  EXECUTE FUNCTION trg_credit_note_item_inventory();

-- 5. Create sequence for credit note numbering
CREATE SEQUENCE IF NOT EXISTS credit_note_number_seq START 1;

-- 6. Function to generate credit note number
CREATE OR REPLACE FUNCTION generate_credit_note_number()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_year text;
  v_number text;
BEGIN
  v_year := TO_CHAR(CURRENT_DATE, 'YY');
  v_number := LPAD(nextval('credit_note_number_seq')::text, 4, '0');
  RETURN 'CN-' || v_year || '-' || v_number;
END;
$$;

-- 7. RLS Policies for Credit Notes
ALTER TABLE credit_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_note_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view all credit notes" ON credit_notes;
CREATE POLICY "Users can view all credit notes"
  ON credit_notes FOR SELECT
  TO authenticated
  USING (true);

DROP POLICY IF EXISTS "Users can create credit notes" ON credit_notes;
CREATE POLICY "Users can create credit notes"
  ON credit_notes FOR INSERT
  TO authenticated
  WITH CHECK (true);

DROP POLICY IF EXISTS "Users can update own credit notes" ON credit_notes;
CREATE POLICY "Users can update own credit notes"
  ON credit_notes FOR UPDATE
  TO authenticated
  USING (created_by = auth.uid());

DROP POLICY IF EXISTS "Users can delete own credit notes" ON credit_notes;
CREATE POLICY "Users can delete own credit notes"
  ON credit_notes FOR DELETE
  TO authenticated
  USING (created_by = auth.uid());

DROP POLICY IF EXISTS "Users can view all credit note items" ON credit_note_items;
CREATE POLICY "Users can view all credit note items"
  ON credit_note_items FOR SELECT
  TO authenticated
  USING (true);

DROP POLICY IF EXISTS "Users can insert credit note items" ON credit_note_items;
CREATE POLICY "Users can insert credit note items"
  ON credit_note_items FOR INSERT
  TO authenticated
  WITH CHECK (true);

DROP POLICY IF EXISTS "Users can delete credit note items" ON credit_note_items;
CREATE POLICY "Users can delete credit note items"
  ON credit_note_items FOR DELETE
  TO authenticated
  USING (true);

-- 8. Indexes for performance
CREATE INDEX IF NOT EXISTS idx_credit_notes_customer ON credit_notes(customer_id);
CREATE INDEX IF NOT EXISTS idx_credit_notes_invoice ON credit_notes(original_invoice_id);
CREATE INDEX IF NOT EXISTS idx_credit_note_items_cn ON credit_note_items(credit_note_id);
CREATE INDEX IF NOT EXISTS idx_credit_note_items_product ON credit_note_items(product_id);
CREATE INDEX IF NOT EXISTS idx_credit_note_items_batch ON credit_note_items(batch_id);

COMMENT ON TABLE credit_notes IS 'Credit notes for returns and adjustments. Adds stock back to inventory.';
COMMENT ON TABLE credit_note_items IS 'Line items for credit notes';
COMMENT ON FUNCTION prevent_linked_invoice_deletion IS 'Prevents deletion of invoices that are linked to DCs';
COMMENT ON FUNCTION prevent_linked_dc_deletion IS 'Prevents deletion of DCs that are linked to invoices';
COMMENT ON FUNCTION trg_credit_note_item_inventory IS 'Handles inventory transactions for credit notes (adds stock back)';
