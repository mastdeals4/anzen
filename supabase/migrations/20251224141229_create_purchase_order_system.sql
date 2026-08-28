/*
  # Create Purchase Order System

  ## Overview
  Complete purchase order management system for tracking procurement from suppliers.

  ## Tables Created
  1. **purchase_orders** - PO header with supplier, dates, and totals
  2. **purchase_order_items** - Line items with products, quantities, and prices

  ## Features
  - Auto-numbering (PO-YYMM-0001)
  - Status workflow: draft → approved → partially_received → received
  - Multi-currency support
  - Approval workflow ready
  - Links to suppliers and products

  ## Status Flow
  1. **draft** - Being created/edited
  2. **pending_approval** - Awaiting manager approval
  3. **approved** - Ready for ordering
  4. **partially_received** - Some items received via GRN
  5. **received** - All items received
  6. **cancelled** - PO cancelled

  ## Security
  - RLS enabled for all tables
  - Authenticated users can read all POs
  - Only admins/managers can approve
*/

-- ============================================
-- 1. PURCHASE ORDERS TABLE
-- ============================================

CREATE TABLE IF NOT EXISTS purchase_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  po_number VARCHAR(50) NOT NULL UNIQUE,
  po_date DATE NOT NULL DEFAULT CURRENT_DATE,
  supplier_id UUID NOT NULL REFERENCES suppliers(id),
  expected_delivery_date DATE,
  delivery_address TEXT,
  currency VARCHAR(10) DEFAULT 'IDR',
  exchange_rate DECIMAL(18,6) DEFAULT 1,
  subtotal DECIMAL(18,2) DEFAULT 0,
  discount_amount DECIMAL(18,2) DEFAULT 0,
  tax_amount DECIMAL(18,2) DEFAULT 0,
  freight_amount DECIMAL(18,2) DEFAULT 0,
  total_amount DECIMAL(18,2) DEFAULT 0,
  status VARCHAR(30) DEFAULT 'draft' CHECK (status IN (
    'draft',
    'pending_approval',
    'approved',
    'partially_received',
    'received',
    'cancelled'
  )),
  payment_terms VARCHAR(100),
  notes TEXT,
  terms_conditions TEXT,
  approved_by UUID REFERENCES auth.users(id),
  approved_at TIMESTAMPTZ,
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_po_number ON purchase_orders(po_number);
CREATE INDEX idx_po_supplier ON purchase_orders(supplier_id);
CREATE INDEX idx_po_date ON purchase_orders(po_date);
CREATE INDEX idx_po_status ON purchase_orders(status);

-- ============================================
-- 2. PURCHASE ORDER ITEMS TABLE
-- ============================================

CREATE TABLE IF NOT EXISTS purchase_order_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  po_id UUID NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  line_number INTEGER NOT NULL,
  product_id UUID REFERENCES products(id),
  description TEXT NOT NULL,
  quantity DECIMAL(18,3) NOT NULL,
  unit VARCHAR(50),
  unit_price DECIMAL(18,2) NOT NULL,
  discount_percent DECIMAL(5,2) DEFAULT 0,
  discount_amount DECIMAL(18,2) DEFAULT 0,
  line_total DECIMAL(18,2) NOT NULL,
  quantity_received DECIMAL(18,3) DEFAULT 0,
  quantity_pending DECIMAL(18,3) GENERATED ALWAYS AS (quantity - quantity_received) STORED,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(po_id, line_number)
);

CREATE INDEX idx_poi_po ON purchase_order_items(po_id);
CREATE INDEX idx_poi_product ON purchase_order_items(product_id);

-- ============================================
-- 3. AUTO-NUMBERING FUNCTION
-- ============================================

CREATE OR REPLACE FUNCTION generate_po_number()
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
  FROM purchase_orders
  WHERE po_number LIKE 'PO-' || v_year || v_month || '%';
  
  v_number := 'PO-' || v_year || v_month || '-' || LPAD(v_count::TEXT, 4, '0');
  
  RETURN v_number;
END;
$$;

-- ============================================
-- 4. TRIGGER: AUTO-GENERATE PO NUMBER
-- ============================================

CREATE OR REPLACE FUNCTION trg_generate_po_number()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.po_number IS NULL OR NEW.po_number = '' THEN
    NEW.po_number := generate_po_number();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_generate_po_number ON purchase_orders;
CREATE TRIGGER trigger_generate_po_number
  BEFORE INSERT ON purchase_orders
  FOR EACH ROW
  EXECUTE FUNCTION trg_generate_po_number();

-- ============================================
-- 5. TRIGGER: UPDATE TIMESTAMPS
-- ============================================

CREATE OR REPLACE FUNCTION trg_update_po_timestamp()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_update_po_timestamp ON purchase_orders;
CREATE TRIGGER trigger_update_po_timestamp
  BEFORE UPDATE ON purchase_orders
  FOR EACH ROW
  EXECUTE FUNCTION trg_update_po_timestamp();

DROP TRIGGER IF EXISTS trigger_update_poi_timestamp ON purchase_order_items;
CREATE TRIGGER trigger_update_poi_timestamp
  BEFORE UPDATE ON purchase_order_items
  FOR EACH ROW
  EXECUTE FUNCTION trg_update_po_timestamp();

-- ============================================
-- 6. ROW LEVEL SECURITY
-- ============================================

ALTER TABLE purchase_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_order_items ENABLE ROW LEVEL SECURITY;

-- Everyone can read
CREATE POLICY "purchase_orders_select" ON purchase_orders 
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "purchase_order_items_select" ON purchase_order_items 
  FOR SELECT TO authenticated USING (true);

-- Everyone can insert/update/delete (app-level controls for approval)
CREATE POLICY "purchase_orders_insert" ON purchase_orders 
  FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "purchase_orders_update" ON purchase_orders 
  FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "purchase_orders_delete" ON purchase_orders 
  FOR DELETE TO authenticated USING (
    status = 'draft' OR 
    EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role IN ('admin', 'manager'))
  );

CREATE POLICY "purchase_order_items_insert" ON purchase_order_items 
  FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "purchase_order_items_update" ON purchase_order_items 
  FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "purchase_order_items_delete" ON purchase_order_items 
  FOR DELETE TO authenticated USING (true);

-- ============================================
-- 7. HELPER FUNCTIONS
-- ============================================

-- Get PO summary with received quantities
CREATE OR REPLACE FUNCTION get_po_summary(p_po_id UUID)
RETURNS TABLE (
  total_items BIGINT,
  total_received_items BIGINT,
  is_fully_received BOOLEAN,
  is_partially_received BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT
    COUNT(*)::BIGINT as total_items,
    COUNT(CASE WHEN quantity_received >= quantity THEN 1 END)::BIGINT as total_received_items,
    COUNT(CASE WHEN quantity_received >= quantity THEN 1 END) = COUNT(*) as is_fully_received,
    COUNT(CASE WHEN quantity_received > 0 AND quantity_received < quantity THEN 1 END) > 0 as is_partially_received
  FROM purchase_order_items
  WHERE po_id = p_po_id;
END;
$$;

GRANT EXECUTE ON FUNCTION get_po_summary TO authenticated;
GRANT EXECUTE ON FUNCTION generate_po_number TO authenticated;

-- ============================================
-- MIGRATION COMPLETE
-- ============================================

DO $$
BEGIN
  RAISE NOTICE '✅ Purchase Order System Created!';
  RAISE NOTICE 'Tables: purchase_orders, purchase_order_items';
  RAISE NOTICE 'Auto-numbering: PO-YYMM-0001';
  RAISE NOTICE 'Status workflow: draft → approved → partially_received → received';
  RAISE NOTICE 'Helper function: get_po_summary(po_id)';
END $$;
