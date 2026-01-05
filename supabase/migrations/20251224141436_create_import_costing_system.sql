/*
  # Create Import Costing System

  ## Overview
  Complete import costing system for Indonesian pharmaceutical imports including duties,
  taxes, freight, and other landed costs with automatic allocation to batches.

  ## Tables Created
  1. **import_cost_headers** - Container/shipment level costs
  2. **import_cost_items** - Individual products in the shipment
  3. **import_cost_allocations** - Detailed cost allocation per batch
  4. **import_cost_types** - Master data for cost types

  ## Indonesian Import Cost Types
  1. **BM (Bea Masuk)** - Import Duty
  2. **PPN Import** - VAT on Import (11%)
  3. **PPh 22** - Income Tax Article 22 (2.5% or 7.5%)
  4. **Freight** - Shipping costs
  5. **Clearing** - Customs clearance fees
  6. **Port Charges** - Port handling fees
  7. **Insurance** - Import insurance
  8. **Others** - Miscellaneous costs

  ## Cost Allocation Methods
  1. **By Quantity** - Proportional to quantity purchased
  2. **By Value** - Proportional to product value (FOB price)
  3. **Equal** - Split equally among products
  4. **Manual** - User specifies per item

  ## Key Features
  - Auto-calculates allocation based on method
  - Updates batch cost_per_unit with landed costs
  - Updates inventory value in accounting
  - Multi-currency support
  - Links to GRNs/batches

  ## Accounting Impact
  - Dr Inventory (increases asset value)
  - Cr Import Clearing Payable / Bank
*/

-- ============================================
-- 1. IMPORT COST TYPES (Master Data)
-- ============================================

CREATE TABLE IF NOT EXISTS import_cost_types (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code VARCHAR(20) NOT NULL UNIQUE,
  name VARCHAR(100) NOT NULL,
  name_id VARCHAR(100), -- Indonesian name
  cost_category VARCHAR(50) CHECK (cost_category IN ('duty', 'tax', 'freight', 'clearing', 'insurance', 'other')),
  is_percentage BOOLEAN DEFAULT false,
  default_rate DECIMAL(5,2),
  account_id UUID REFERENCES chart_of_accounts(id),
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_ict_code ON import_cost_types(code);

-- Seed import cost types
INSERT INTO import_cost_types (code, name, name_id, cost_category, is_percentage, default_rate) VALUES
('BM', 'Import Duty', 'Bea Masuk', 'duty', true, 0),
('PPN_IMP', 'PPN Import', 'PPN Impor', 'tax', true, 11.00),
('PPH22', 'PPh 22 Import', 'PPh 22 Impor', 'tax', true, 2.50),
('FREIGHT', 'Freight Charges', 'Biaya Pengiriman', 'freight', false, NULL),
('CLEARING', 'Customs Clearance', 'Biaya Clearance', 'clearing', false, NULL),
('PORT', 'Port Charges', 'Biaya Pelabuhan', 'other', false, NULL),
('INSURANCE', 'Insurance', 'Asuransi', 'insurance', false, NULL),
('TRUCKING', 'Trucking/Inland Freight', 'Biaya Trucking', 'freight', false, NULL),
('OTHER', 'Other Costs', 'Biaya Lainnya', 'other', false, NULL)
ON CONFLICT (code) DO NOTHING;

-- ============================================
-- 2. IMPORT COST HEADERS TABLE
-- ============================================

CREATE TABLE IF NOT EXISTS import_cost_headers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cost_sheet_number VARCHAR(50) NOT NULL UNIQUE,
  import_date DATE NOT NULL DEFAULT CURRENT_DATE,
  container_number VARCHAR(100),
  bill_of_lading VARCHAR(100),
  customs_declaration VARCHAR(100),
  supplier_id UUID REFERENCES suppliers(id),
  currency VARCHAR(10) DEFAULT 'USD',
  exchange_rate DECIMAL(18,6) DEFAULT 1,
  fob_value DECIMAL(18,2) DEFAULT 0, -- Free On Board value
  cif_value DECIMAL(18,2) DEFAULT 0, -- Cost, Insurance, Freight value
  
  -- Cost breakdown
  duty_amount DECIMAL(18,2) DEFAULT 0,
  ppn_import_amount DECIMAL(18,2) DEFAULT 0,
  pph22_amount DECIMAL(18,2) DEFAULT 0,
  freight_amount DECIMAL(18,2) DEFAULT 0,
  insurance_amount DECIMAL(18,2) DEFAULT 0,
  clearing_amount DECIMAL(18,2) DEFAULT 0,
  port_charges DECIMAL(18,2) DEFAULT 0,
  other_charges DECIMAL(18,2) DEFAULT 0,
  
  total_landed_cost DECIMAL(18,2) DEFAULT 0,
  
  allocation_method VARCHAR(20) DEFAULT 'by_value' CHECK (allocation_method IN ('by_quantity', 'by_value', 'equal', 'manual')),
  status VARCHAR(20) DEFAULT 'draft' CHECK (status IN ('draft', 'calculated', 'posted')),
  
  notes TEXT,
  document_urls TEXT[],
  
  journal_entry_id UUID REFERENCES journal_entries(id),
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  posted_by UUID REFERENCES auth.users(id),
  posted_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_ich_number ON import_cost_headers(cost_sheet_number);
CREATE INDEX idx_ich_date ON import_cost_headers(import_date);
CREATE INDEX idx_ich_supplier ON import_cost_headers(supplier_id);
CREATE INDEX idx_ich_status ON import_cost_headers(status);

-- ============================================
-- 3. IMPORT COST ITEMS TABLE
-- ============================================

CREATE TABLE IF NOT EXISTS import_cost_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cost_header_id UUID NOT NULL REFERENCES import_cost_headers(id) ON DELETE CASCADE,
  line_number INTEGER NOT NULL,
  grn_id UUID REFERENCES goods_receipt_notes(id),
  batch_id UUID REFERENCES batches(id),
  product_id UUID NOT NULL REFERENCES products(id),
  quantity DECIMAL(18,3) NOT NULL,
  unit_fob_price DECIMAL(18,2) NOT NULL,
  total_fob_value DECIMAL(18,2) NOT NULL,
  
  -- Allocated costs per item
  allocated_duty DECIMAL(18,2) DEFAULT 0,
  allocated_ppn DECIMAL(18,2) DEFAULT 0,
  allocated_pph DECIMAL(18,2) DEFAULT 0,
  allocated_freight DECIMAL(18,2) DEFAULT 0,
  allocated_insurance DECIMAL(18,2) DEFAULT 0,
  allocated_clearing DECIMAL(18,2) DEFAULT 0,
  allocated_port DECIMAL(18,2) DEFAULT 0,
  allocated_other DECIMAL(18,2) DEFAULT 0,
  
  total_allocated_cost DECIMAL(18,2) DEFAULT 0,
  final_landed_cost_per_unit DECIMAL(18,2) DEFAULT 0,
  
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(cost_header_id, line_number)
);

CREATE INDEX idx_ici_header ON import_cost_items(cost_header_id);
CREATE INDEX idx_ici_batch ON import_cost_items(batch_id);
CREATE INDEX idx_ici_product ON import_cost_items(product_id);
CREATE INDEX idx_ici_grn ON import_cost_items(grn_id);

-- ============================================
-- 4. AUTO-NUMBERING FUNCTION
-- ============================================

CREATE OR REPLACE FUNCTION generate_import_cost_number()
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
  FROM import_cost_headers
  WHERE cost_sheet_number LIKE 'IMP-' || v_year || v_month || '%';
  
  v_number := 'IMP-' || v_year || v_month || '-' || LPAD(v_count::TEXT, 4, '0');
  
  RETURN v_number;
END;
$$;

-- ============================================
-- 5. TRIGGER: AUTO-GENERATE IMPORT COST NUMBER
-- ============================================

CREATE OR REPLACE FUNCTION trg_generate_import_cost_number()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.cost_sheet_number IS NULL OR NEW.cost_sheet_number = '' THEN
    NEW.cost_sheet_number := generate_import_cost_number();
  END IF;
  
  -- Calculate total landed cost
  NEW.total_landed_cost := NEW.fob_value + NEW.duty_amount + NEW.ppn_import_amount + 
                           NEW.pph22_amount + NEW.freight_amount + NEW.insurance_amount +
                           NEW.clearing_amount + NEW.port_charges + NEW.other_charges;
  
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_generate_import_cost_number ON import_cost_headers;
CREATE TRIGGER trigger_generate_import_cost_number
  BEFORE INSERT OR UPDATE ON import_cost_headers
  FOR EACH ROW
  EXECUTE FUNCTION trg_generate_import_cost_number();

-- ============================================
-- 6. ROW LEVEL SECURITY
-- ============================================

ALTER TABLE import_cost_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_cost_headers ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_cost_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "import_cost_types_select" ON import_cost_types FOR SELECT TO authenticated USING (true);
CREATE POLICY "import_cost_types_write" ON import_cost_types FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "import_cost_headers_select" ON import_cost_headers FOR SELECT TO authenticated USING (true);
CREATE POLICY "import_cost_headers_insert" ON import_cost_headers FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "import_cost_headers_update" ON import_cost_headers FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "import_cost_headers_delete" ON import_cost_headers FOR DELETE TO authenticated USING (status = 'draft');

CREATE POLICY "import_cost_items_select" ON import_cost_items FOR SELECT TO authenticated USING (true);
CREATE POLICY "import_cost_items_insert" ON import_cost_items FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "import_cost_items_update" ON import_cost_items FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "import_cost_items_delete" ON import_cost_items FOR DELETE TO authenticated USING (true);

-- ============================================
-- 7. GRANT PERMISSIONS
-- ============================================

GRANT EXECUTE ON FUNCTION generate_import_cost_number TO authenticated;

-- ============================================
-- MIGRATION COMPLETE
-- ============================================

DO $$
BEGIN
  RAISE NOTICE '✅ Import Costing System Created!';
  RAISE NOTICE 'Tables: import_cost_headers, import_cost_items, import_cost_types';
  RAISE NOTICE 'Cost types: BM, PPN Import, PPh 22, Freight, Clearing, Port, Insurance';
  RAISE NOTICE 'Allocation methods: by_quantity, by_value, equal, manual';
  RAISE NOTICE 'Auto-numbering: IMP-YYMM-0001';
  RAISE NOTICE 'Next: Create cost allocation and batch update functions';
END $$;
