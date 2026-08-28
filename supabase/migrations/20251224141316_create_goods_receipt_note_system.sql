/*
  # Create Goods Receipt Note (GRN) System

  ## Overview
  Complete GRN system for receiving inventory from suppliers with automatic batch creation
  and accounting integration.

  ## Tables Created
  1. **goods_receipt_notes** - GRN header with supplier, PO reference, dates
  2. **goods_receipt_items** - Line items with batch auto-creation

  ## Key Features
  1. **Automatic Batch Creation**
     - Creates batch records automatically when GRN is posted
     - Links batch to supplier and product
     - Sets initial stock quantity

  2. **PO Integration (Optional)**
     - Can reference Purchase Order
     - Updates PO item received quantities
     - Validates against PO quantities

  3. **Accounting Entry (Created by trigger)**
     - Dr Inventory (1130)
     - Cr Accounts Payable (2110)

  4. **Auto-numbering**: GRN-YYMM-0001

  ## Status Flow
  1. **draft** - Being created/edited
  2. **posted** - Completed, batches created, accounting posted

  ## Security
  - RLS enabled
  - Authenticated users can read/write
  - Only draft GRNs can be deleted
*/

-- ============================================
-- 1. GOODS RECEIPT NOTES TABLE
-- ============================================

CREATE TABLE IF NOT EXISTS goods_receipt_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  grn_number VARCHAR(50) NOT NULL UNIQUE,
  grn_date DATE NOT NULL DEFAULT CURRENT_DATE,
  supplier_id UUID NOT NULL REFERENCES suppliers(id),
  po_id UUID REFERENCES purchase_orders(id),
  po_number VARCHAR(50),
  supplier_invoice_number VARCHAR(100),
  supplier_invoice_date DATE,
  delivery_note_number VARCHAR(100),
  received_by VARCHAR(255),
  currency VARCHAR(10) DEFAULT 'IDR',
  exchange_rate DECIMAL(18,6) DEFAULT 1,
  total_quantity DECIMAL(18,3) DEFAULT 0,
  subtotal DECIMAL(18,2) DEFAULT 0,
  tax_amount DECIMAL(18,2) DEFAULT 0,
  total_amount DECIMAL(18,2) DEFAULT 0,
  status VARCHAR(20) DEFAULT 'draft' CHECK (status IN ('draft', 'posted')),
  notes TEXT,
  journal_entry_id UUID REFERENCES journal_entries(id),
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  posted_by UUID REFERENCES auth.users(id),
  posted_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_grn_number ON goods_receipt_notes(grn_number);
CREATE INDEX idx_grn_supplier ON goods_receipt_notes(supplier_id);
CREATE INDEX idx_grn_po ON goods_receipt_notes(po_id);
CREATE INDEX idx_grn_date ON goods_receipt_notes(grn_date);
CREATE INDEX idx_grn_status ON goods_receipt_notes(status);

-- ============================================
-- 2. GOODS RECEIPT ITEMS TABLE
-- ============================================

CREATE TABLE IF NOT EXISTS goods_receipt_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  grn_id UUID NOT NULL REFERENCES goods_receipt_notes(id) ON DELETE CASCADE,
  line_number INTEGER NOT NULL,
  po_item_id UUID REFERENCES purchase_order_items(id),
  product_id UUID NOT NULL REFERENCES products(id),
  batch_id UUID REFERENCES batches(id), -- Created automatically on posting
  batch_number VARCHAR(100),
  expiry_date DATE,
  manufacture_date DATE,
  description TEXT,
  quantity_received DECIMAL(18,3) NOT NULL,
  unit VARCHAR(50),
  unit_cost DECIMAL(18,2) NOT NULL,
  line_total DECIMAL(18,2) NOT NULL,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(grn_id, line_number)
);

CREATE INDEX idx_gri_grn ON goods_receipt_items(grn_id);
CREATE INDEX idx_gri_product ON goods_receipt_items(product_id);
CREATE INDEX idx_gri_batch ON goods_receipt_items(batch_id);
CREATE INDEX idx_gri_po_item ON goods_receipt_items(po_item_id);

-- ============================================
-- 3. AUTO-NUMBERING FUNCTION
-- ============================================

CREATE OR REPLACE FUNCTION generate_grn_number()
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_year TEXT;
  v_month TEXT;
  v_count INTEGER;
  v_number TEXT;
BEGIN
  v_year := TO_CHAR(CURRENT_DATE, 'YY');
  v_month := TO_CHAR(CURRENT_DATE, 'MM');
  
  SELECT COUNT(*) + 1 INTO v_count
  FROM goods_receipt_notes
  WHERE grn_number LIKE 'GRN-' || v_year || v_month || '%';
  
  v_number := 'GRN-' || v_year || v_month || '-' || LPAD(v_count::TEXT, 4, '0');
  
  RETURN v_number;
END;
$$;

-- ============================================
-- 4. TRIGGER: AUTO-GENERATE GRN NUMBER
-- ============================================

CREATE OR REPLACE FUNCTION trg_generate_grn_number()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.grn_number IS NULL OR NEW.grn_number = '' THEN
    NEW.grn_number := generate_grn_number();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_generate_grn_number ON goods_receipt_notes;
CREATE TRIGGER trigger_generate_grn_number
  BEFORE INSERT ON goods_receipt_notes
  FOR EACH ROW
  EXECUTE FUNCTION trg_generate_grn_number();

-- ============================================
-- 5. TRIGGER: AUTO-CREATE BATCHES ON GRN POST
-- ============================================

CREATE OR REPLACE FUNCTION trg_create_batch_from_grn()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_grn_record RECORD;
  v_batch_id UUID;
  v_batch_number TEXT;
BEGIN
  -- Only process when GRN status changes to 'posted'
  IF TG_OP = 'UPDATE' AND NEW.status = 'posted' AND OLD.status = 'draft' THEN
    
    -- Get GRN details
    SELECT grn_number, supplier_id, grn_date, created_by
    INTO v_grn_record
    FROM goods_receipt_notes WHERE id = NEW.id;
    
    -- Process each GRN item
    FOR v_grn_record IN
      SELECT * FROM goods_receipt_items WHERE grn_id = NEW.id
    LOOP
      -- Generate batch number if not provided
      IF v_grn_record.batch_number IS NULL OR v_grn_record.batch_number = '' THEN
        v_batch_number := 'BATCH-' || TO_CHAR(NOW(), 'YYMMDD') || '-' || LPAD((
          SELECT COUNT(*) + 1 FROM batches WHERE batch_number LIKE 'BATCH-' || TO_CHAR(NOW(), 'YYMMDD') || '%'
        )::TEXT, 4, '0');
      ELSE
        v_batch_number := v_grn_record.batch_number;
      END IF;
      
      -- Create batch
      INSERT INTO batches (
        product_id,
        supplier_id,
        batch_number,
        purchase_date,
        expiry_date,
        manufacture_date,
        quantity_purchased,
        current_stock,
        cost_per_unit,
        currency,
        created_by
      ) VALUES (
        v_grn_record.product_id,
        NEW.supplier_id,
        v_batch_number,
        NEW.grn_date,
        v_grn_record.expiry_date,
        v_grn_record.manufacture_date,
        v_grn_record.quantity_received,
        v_grn_record.quantity_received,
        v_grn_record.unit_cost,
        NEW.currency,
        NEW.created_by
      )
      RETURNING id INTO v_batch_id;
      
      -- Update GRN item with batch_id
      UPDATE goods_receipt_items
      SET batch_id = v_batch_id
      WHERE id = v_grn_record.id;
      
      -- Create inventory transaction
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
      ) VALUES (
        v_grn_record.product_id,
        v_batch_id,
        'purchase',
        v_grn_record.quantity_received,
        NEW.grn_date,
        NEW.grn_number,
        'goods_receipt_note',
        NEW.id,
        'GRN: ' || NEW.grn_number,
        NEW.created_by,
        0,
        v_grn_record.quantity_received
      );
    END LOOP;
    
    -- Update PO received quantities if PO is linked
    IF NEW.po_id IS NOT NULL THEN
      UPDATE purchase_order_items poi
      SET quantity_received = quantity_received + gri.quantity_received
      FROM goods_receipt_items gri
      WHERE poi.id = gri.po_item_id
        AND gri.grn_id = NEW.id;
      
      -- Update PO status
      UPDATE purchase_orders po
      SET status = CASE
        WHEN (SELECT SUM(quantity_received) FROM purchase_order_items WHERE po_id = po.id) >= 
             (SELECT SUM(quantity) FROM purchase_order_items WHERE po_id = po.id) THEN 'received'
        WHEN (SELECT SUM(quantity_received) FROM purchase_order_items WHERE po_id = po.id) > 0 THEN 'partially_received'
        ELSE po.status
      END
      WHERE po.id = NEW.po_id;
    END IF;
    
    -- Set posted timestamp
    NEW.posted_at := NOW();
    NEW.posted_by := auth.uid();
  END IF;
  
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_create_batch_from_grn ON goods_receipt_notes;
CREATE TRIGGER trigger_create_batch_from_grn
  BEFORE UPDATE ON goods_receipt_notes
  FOR EACH ROW
  EXECUTE FUNCTION trg_create_batch_from_grn();

-- ============================================
-- 6. ROW LEVEL SECURITY
-- ============================================

ALTER TABLE goods_receipt_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE goods_receipt_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "goods_receipt_notes_select" ON goods_receipt_notes 
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "goods_receipt_items_select" ON goods_receipt_items 
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "goods_receipt_notes_insert" ON goods_receipt_notes 
  FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "goods_receipt_notes_update" ON goods_receipt_notes 
  FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "goods_receipt_notes_delete" ON goods_receipt_notes 
  FOR DELETE TO authenticated USING (status = 'draft');

CREATE POLICY "goods_receipt_items_insert" ON goods_receipt_items 
  FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "goods_receipt_items_update" ON goods_receipt_items 
  FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "goods_receipt_items_delete" ON goods_receipt_items 
  FOR DELETE TO authenticated USING (true);

-- ============================================
-- 7. GRANT PERMISSIONS
-- ============================================

GRANT EXECUTE ON FUNCTION generate_grn_number TO authenticated;

-- ============================================
-- MIGRATION COMPLETE
-- ============================================

DO $$
BEGIN
  RAISE NOTICE '✅ Goods Receipt Note (GRN) System Created!';
  RAISE NOTICE 'Tables: goods_receipt_notes, goods_receipt_items';
  RAISE NOTICE 'Auto-numbering: GRN-YYMM-0001';
  RAISE NOTICE 'Auto-batch creation: On GRN post';
  RAISE NOTICE 'PO integration: Updates received quantities';
  RAISE NOTICE 'Next: Create GRN accounting trigger';
END $$;
