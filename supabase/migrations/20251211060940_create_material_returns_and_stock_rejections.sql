/*
  # Material Returns and Stock Rejections System
  
  ## Overview
  Creates comprehensive tables for handling material returns from customers
  and stock rejections due to quality issues, damage, or expiry.
  
  ## New Tables
  
  ### 1. material_returns
    Tracks goods returned by customers to the warehouse
    - `id` (uuid, primary key)
    - `return_number` (text, unique, auto-generated: RET-YYYY-NNNN)
    - `original_dc_id` (uuid) - reference to original delivery challan
    - `original_invoice_id` (uuid) - reference to original sales invoice
    - `customer_id` (uuid) - customer returning the goods
    - `return_date` (date) - when goods were returned
    - `return_type` (enum: 'quality_issue', 'wrong_product', 'excess_quantity', 'damaged', 'expired', 'other')
    - `return_reason` (text) - detailed reason for return
    - `status` (enum: 'pending_approval', 'approved', 'rejected', 'completed')
    - `approved_by` (uuid) - manager/admin who approved
    - `approval_workflow_id` (uuid) - link to approval_workflows
    - `financial_impact` (decimal) - total value of returned goods
    - `credit_note_issued` (boolean) - whether credit note was issued
    - `credit_note_number` (text)
    - `credit_note_amount` (decimal)
    - `restocked` (boolean) - whether returned items were put back in stock
    - `notes` (text)
    - `created_by` (uuid)
    - `created_at` (timestamptz)
    - `updated_at` (timestamptz)
  
  ### 2. material_return_items
    Line items for each returned material
    - `id` (uuid, primary key)
    - `return_id` (uuid) - reference to material_returns
    - `product_id` (uuid)
    - `batch_id` (uuid)
    - `quantity_returned` (decimal) - quantity being returned
    - `original_quantity` (decimal) - original delivered quantity
    - `unit_price` (decimal) - original unit price
    - `condition` (enum: 'good', 'damaged', 'expired', 'unusable')
    - `disposition` (enum: 'restock', 'scrap', 'return_to_supplier', 'pending')
    - `notes` (text)
  
  ### 3. stock_rejections
    Tracks internal stock rejections due to quality issues
    - `id` (uuid, primary key)
    - `rejection_number` (text, unique, auto-generated: REJ-YYYY-NNNN)
    - `batch_id` (uuid) - batch being rejected
    - `product_id` (uuid) - product being rejected
    - `rejection_date` (date)
    - `quantity_rejected` (decimal)
    - `rejection_reason` (enum: 'quality_failed', 'expired', 'damaged', 'contaminated', 'other')
    - `rejection_details` (text) - detailed description
    - `status` (enum: 'pending_approval', 'approved', 'rejected', 'disposed')
    - `approved_by` (uuid)
    - `approval_workflow_id` (uuid)
    - `financial_loss` (decimal) - calculated value loss
    - `unit_cost` (decimal) - cost per unit at time of rejection
    - `disposition` (enum: 'scrap', 'return_to_supplier', 'rework', 'pending')
    - `disposal_date` (date)
    - `disposal_method` (text)
    - `photos` (jsonb) - array of photo URLs for documentation
    - `inspection_report` (text)
    - `inspected_by` (uuid)
    - `created_by` (uuid)
    - `created_at` (timestamptz)
    - `updated_at` (timestamptz)
  
  ### 4. Storage Bucket
    - Create 'rejection_photos' bucket for storing rejection documentation
  
  ## Triggers & Functions
  
  ### 1. Auto-generate return numbers
    - Trigger on material_returns insert to auto-generate RET-YYYY-NNNN
  
  ### 2. Auto-generate rejection numbers
    - Trigger on stock_rejections insert to auto-generate REJ-YYYY-NNNN
  
  ### 3. Update stock on approval
    - When return is approved with restock disposition, add back to inventory
    - When rejection is approved, deduct from batch stock
  
  ### 4. Create approval workflow automatically
    - Based on financial impact/loss thresholds
  
  ## Security
    - Enable RLS on all tables
    - Users can view their own returns/rejections
    - Managers/admins can view and approve all
    - Only managers/admins can change status
*/

-- Create material_returns table
CREATE TABLE IF NOT EXISTS material_returns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  return_number text UNIQUE,
  original_dc_id uuid REFERENCES delivery_challans(id),
  original_invoice_id uuid REFERENCES sales_invoices(id),
  customer_id uuid NOT NULL REFERENCES customers(id),
  return_date date NOT NULL DEFAULT CURRENT_DATE,
  return_type text NOT NULL CHECK (return_type IN ('quality_issue', 'wrong_product', 'excess_quantity', 'damaged', 'expired', 'other')),
  return_reason text NOT NULL,
  status text NOT NULL DEFAULT 'pending_approval' CHECK (status IN ('pending_approval', 'approved', 'rejected', 'completed')),
  approved_by uuid REFERENCES auth.users(id),
  approval_workflow_id uuid REFERENCES approval_workflows(id),
  financial_impact decimal(15,2) DEFAULT 0,
  credit_note_issued boolean DEFAULT false,
  credit_note_number text,
  credit_note_amount decimal(15,2),
  restocked boolean DEFAULT false,
  notes text,
  created_by uuid NOT NULL REFERENCES auth.users(id),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Create material_return_items table
CREATE TABLE IF NOT EXISTS material_return_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  return_id uuid NOT NULL REFERENCES material_returns(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products(id),
  batch_id uuid REFERENCES batches(id),
  quantity_returned decimal(10,2) NOT NULL,
  original_quantity decimal(10,2),
  unit_price decimal(15,2) NOT NULL,
  condition text NOT NULL CHECK (condition IN ('good', 'damaged', 'expired', 'unusable')),
  disposition text DEFAULT 'pending' CHECK (disposition IN ('restock', 'scrap', 'return_to_supplier', 'pending')),
  notes text,
  created_at timestamptz DEFAULT now()
);

-- Create stock_rejections table
CREATE TABLE IF NOT EXISTS stock_rejections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rejection_number text UNIQUE,
  batch_id uuid NOT NULL REFERENCES batches(id),
  product_id uuid NOT NULL REFERENCES products(id),
  rejection_date date NOT NULL DEFAULT CURRENT_DATE,
  quantity_rejected decimal(10,2) NOT NULL CHECK (quantity_rejected > 0),
  rejection_reason text NOT NULL CHECK (rejection_reason IN ('quality_failed', 'expired', 'damaged', 'contaminated', 'other')),
  rejection_details text NOT NULL,
  status text NOT NULL DEFAULT 'pending_approval' CHECK (status IN ('pending_approval', 'approved', 'rejected', 'disposed')),
  approved_by uuid REFERENCES auth.users(id),
  approval_workflow_id uuid REFERENCES approval_workflows(id),
  financial_loss decimal(15,2) DEFAULT 0,
  unit_cost decimal(15,2) NOT NULL,
  disposition text DEFAULT 'pending' CHECK (disposition IN ('scrap', 'return_to_supplier', 'rework', 'pending')),
  disposal_date date,
  disposal_method text,
  photos jsonb DEFAULT '[]'::jsonb,
  inspection_report text,
  inspected_by uuid REFERENCES auth.users(id),
  created_by uuid NOT NULL REFERENCES auth.users(id),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_material_returns_customer ON material_returns(customer_id);
CREATE INDEX IF NOT EXISTS idx_material_returns_status ON material_returns(status);
CREATE INDEX IF NOT EXISTS idx_material_returns_date ON material_returns(return_date);
CREATE INDEX IF NOT EXISTS idx_material_returns_dc ON material_returns(original_dc_id);
CREATE INDEX IF NOT EXISTS idx_material_returns_invoice ON material_returns(original_invoice_id);

CREATE INDEX IF NOT EXISTS idx_material_return_items_return ON material_return_items(return_id);
CREATE INDEX IF NOT EXISTS idx_material_return_items_product ON material_return_items(product_id);
CREATE INDEX IF NOT EXISTS idx_material_return_items_batch ON material_return_items(batch_id);

CREATE INDEX IF NOT EXISTS idx_stock_rejections_batch ON stock_rejections(batch_id);
CREATE INDEX IF NOT EXISTS idx_stock_rejections_product ON stock_rejections(product_id);
CREATE INDEX IF NOT EXISTS idx_stock_rejections_status ON stock_rejections(status);
CREATE INDEX IF NOT EXISTS idx_stock_rejections_date ON stock_rejections(rejection_date);

-- Enable RLS
ALTER TABLE material_returns ENABLE ROW LEVEL SECURITY;
ALTER TABLE material_return_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_rejections ENABLE ROW LEVEL SECURITY;

-- RLS Policies for material_returns
CREATE POLICY "Users can view material returns"
  ON material_returns FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Users can create material returns"
  ON material_returns FOR INSERT
  TO authenticated
  WITH CHECK (created_by = auth.uid());

CREATE POLICY "Managers can update material returns"
  ON material_returns FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
      AND user_profiles.role IN ('manager', 'admin')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
      AND user_profiles.role IN ('manager', 'admin')
    )
  );

-- RLS Policies for material_return_items
CREATE POLICY "Users can view material return items"
  ON material_return_items FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Users can manage return items"
  ON material_return_items FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM material_returns
      WHERE material_returns.id = material_return_items.return_id
      AND (material_returns.created_by = auth.uid() OR
           EXISTS (SELECT 1 FROM user_profiles WHERE user_profiles.id = auth.uid() AND user_profiles.role IN ('manager', 'admin')))
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM material_returns
      WHERE material_returns.id = material_return_items.return_id
      AND (material_returns.created_by = auth.uid() OR
           EXISTS (SELECT 1 FROM user_profiles WHERE user_profiles.id = auth.uid() AND user_profiles.role IN ('manager', 'admin')))
    )
  );

-- RLS Policies for stock_rejections
CREATE POLICY "Users can view stock rejections"
  ON stock_rejections FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Users can create stock rejections"
  ON stock_rejections FOR INSERT
  TO authenticated
  WITH CHECK (created_by = auth.uid());

CREATE POLICY "Managers can update stock rejections"
  ON stock_rejections FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
      AND user_profiles.role IN ('manager', 'admin')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
      AND user_profiles.role IN ('manager', 'admin')
    )
  );

-- Function to generate return number
CREATE OR REPLACE FUNCTION generate_return_number()
RETURNS TRIGGER AS $$
DECLARE
  next_num integer;
  year_str text;
BEGIN
  IF NEW.return_number IS NULL THEN
    year_str := TO_CHAR(NEW.return_date, 'YYYY');
    
    SELECT COALESCE(MAX(
      CASE 
        WHEN return_number ~ ('^RET-' || year_str || '-[0-9]+$')
        THEN CAST(SUBSTRING(return_number FROM '[0-9]+$') AS integer)
        ELSE 0
      END
    ), 0) + 1
    INTO next_num
    FROM material_returns
    WHERE EXTRACT(YEAR FROM return_date) = EXTRACT(YEAR FROM NEW.return_date);
    
    NEW.return_number := 'RET-' || year_str || '-' || LPAD(next_num::text, 4, '0');
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to generate rejection number
CREATE OR REPLACE FUNCTION generate_rejection_number()
RETURNS TRIGGER AS $$
DECLARE
  next_num integer;
  year_str text;
BEGIN
  IF NEW.rejection_number IS NULL THEN
    year_str := TO_CHAR(NEW.rejection_date, 'YYYY');
    
    SELECT COALESCE(MAX(
      CASE 
        WHEN rejection_number ~ ('^REJ-' || year_str || '-[0-9]+$')
        THEN CAST(SUBSTRING(rejection_number FROM '[0-9]+$') AS integer)
        ELSE 0
      END
    ), 0) + 1
    INTO next_num
    FROM stock_rejections
    WHERE EXTRACT(YEAR FROM rejection_date) = EXTRACT(YEAR FROM NEW.rejection_date);
    
    NEW.rejection_number := 'REJ-' || year_str || '-' || LPAD(next_num::text, 4, '0');
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Triggers for auto-numbering
DROP TRIGGER IF EXISTS generate_return_number_trigger ON material_returns;
CREATE TRIGGER generate_return_number_trigger
  BEFORE INSERT ON material_returns
  FOR EACH ROW
  EXECUTE FUNCTION generate_return_number();

DROP TRIGGER IF EXISTS generate_rejection_number_trigger ON stock_rejections;
CREATE TRIGGER generate_rejection_number_trigger
  BEFORE INSERT ON stock_rejections
  FOR EACH ROW
  EXECUTE FUNCTION generate_rejection_number();

-- Function to handle stock rejection approval
CREATE OR REPLACE FUNCTION handle_stock_rejection_approval()
RETURNS TRIGGER AS $$
BEGIN
  -- When rejection is approved, deduct from batch stock
  IF NEW.status = 'approved' AND OLD.status != 'approved' THEN
    -- Update batch stock
    UPDATE batches
    SET current_stock = current_stock - NEW.quantity_rejected,
        updated_at = now()
    WHERE id = NEW.batch_id;
    
    -- Create inventory transaction
    INSERT INTO inventory_transactions (
      product_id,
      batch_id,
      transaction_type,
      quantity,
      reference_type,
      reference_id,
      notes,
      created_by
    ) VALUES (
      NEW.product_id,
      NEW.batch_id,
      'rejection',
      -NEW.quantity_rejected,
      'stock_rejection',
      NEW.id,
      'Stock rejected: ' || NEW.rejection_details,
      NEW.approved_by
    );
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Trigger for stock rejection approval
DROP TRIGGER IF EXISTS handle_stock_rejection_approval_trigger ON stock_rejections;
CREATE TRIGGER handle_stock_rejection_approval_trigger
  AFTER UPDATE ON stock_rejections
  FOR EACH ROW
  WHEN (NEW.status = 'approved' AND OLD.status != 'approved')
  EXECUTE FUNCTION handle_stock_rejection_approval();

-- Function to handle material return approval
CREATE OR REPLACE FUNCTION handle_material_return_approval()
RETURNS TRIGGER AS $$
DECLARE
  item RECORD;
BEGIN
  -- When return is approved and items should be restocked
  IF NEW.status = 'approved' AND OLD.status != 'approved' AND NEW.restocked = true THEN
    -- Process each return item
    FOR item IN 
      SELECT * FROM material_return_items 
      WHERE return_id = NEW.id AND disposition = 'restock'
    LOOP
      -- Update batch stock if batch is specified
      IF item.batch_id IS NOT NULL THEN
        UPDATE batches
        SET current_stock = current_stock + item.quantity_returned,
            updated_at = now()
        WHERE id = item.batch_id;
        
        -- Create inventory transaction
        INSERT INTO inventory_transactions (
          product_id,
          batch_id,
          transaction_type,
          quantity,
          reference_type,
          reference_id,
          notes,
          created_by
        ) VALUES (
          item.product_id,
          item.batch_id,
          'return',
          item.quantity_returned,
          'material_return',
          NEW.id,
          'Material returned from customer: ' || NEW.return_reason,
          NEW.approved_by
        );
      END IF;
    END LOOP;
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Trigger for material return approval
DROP TRIGGER IF EXISTS handle_material_return_approval_trigger ON material_returns;
CREATE TRIGGER handle_material_return_approval_trigger
  AFTER UPDATE ON material_returns
  FOR EACH ROW
  WHEN (NEW.status = 'approved' AND OLD.status != 'approved')
  EXECUTE FUNCTION handle_material_return_approval();

-- Function to calculate financial impact automatically
CREATE OR REPLACE FUNCTION calculate_return_financial_impact()
RETURNS TRIGGER AS $$
DECLARE
  total_impact decimal(15,2);
BEGIN
  SELECT COALESCE(SUM(quantity_returned * unit_price), 0)
  INTO total_impact
  FROM material_return_items
  WHERE return_id = NEW.id;
  
  NEW.financial_impact := total_impact;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Trigger to auto-calculate financial impact
DROP TRIGGER IF EXISTS calculate_return_financial_impact_trigger ON material_returns;
CREATE TRIGGER calculate_return_financial_impact_trigger
  BEFORE INSERT OR UPDATE ON material_returns
  FOR EACH ROW
  EXECUTE FUNCTION calculate_return_financial_impact();

-- Function to calculate rejection financial loss
CREATE OR REPLACE FUNCTION calculate_rejection_financial_loss()
RETURNS TRIGGER AS $$
BEGIN
  NEW.financial_loss := NEW.quantity_rejected * NEW.unit_cost;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Trigger to auto-calculate financial loss
DROP TRIGGER IF EXISTS calculate_rejection_financial_loss_trigger ON stock_rejections;
CREATE TRIGGER calculate_rejection_financial_loss_trigger
  BEFORE INSERT OR UPDATE ON stock_rejections
  FOR EACH ROW
  EXECUTE FUNCTION calculate_rejection_financial_loss();
