/*
  # Enhance CRM with Quotations and Pipeline Management
  
  1. New Tables
    - `crm_quotations` - Track quotations sent to leads/customers
      - `id` (uuid, primary key)
      - `quotation_number` (text, unique)
      - `lead_id` (uuid, nullable, references crm_leads)
      - `customer_id` (uuid, nullable, references customers)
      - `quotation_date` (date)
      - `valid_until` (date)
      - `subtotal` (numeric)
      - `tax_amount` (numeric)
      - `discount_amount` (numeric)
      - `total_amount` (numeric)
      - `status` (text - draft, sent, accepted, rejected, expired)
      - `notes` (text)
      - `terms_conditions` (text)
      - `created_by` (uuid)
      - `created_at` (timestamptz)
      - `updated_at` (timestamptz)
    
    - `crm_quotation_items` - Line items for quotations
      - `id` (uuid, primary key)
      - `quotation_id` (uuid, references crm_quotations)
      - `product_id` (uuid, references products)
      - `product_name` (text)
      - `quantity` (numeric)
      - `unit_price` (numeric)
      - `tax_rate` (numeric)
      - `discount_percent` (numeric)
      - `line_total` (numeric, generated)
      - `created_at` (timestamptz)
  
  2. Enhancements to existing tables
    - Add `priority` field to crm_leads (low, medium, high, urgent)
    - Add `next_follow_up` field to crm_leads
    - Add `deal_value` field to crm_leads (rename from estimated_value)
    - Add `lead_score` field to crm_leads (1-100)
    - Add `tags` array field to crm_leads
  
  3. Security
    - Enable RLS on new tables
    - Add appropriate policies for authenticated users
*/

-- Add priority and tracking fields to crm_leads
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'crm_leads' AND column_name = 'priority'
  ) THEN
    ALTER TABLE crm_leads ADD COLUMN priority text DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'urgent'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'crm_leads' AND column_name = 'next_follow_up'
  ) THEN
    ALTER TABLE crm_leads ADD COLUMN next_follow_up timestamptz;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'crm_leads' AND column_name = 'lead_score'
  ) THEN
    ALTER TABLE crm_leads ADD COLUMN lead_score integer DEFAULT 50 CHECK (lead_score >= 0 AND lead_score <= 100);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'crm_leads' AND column_name = 'tags'
  ) THEN
    ALTER TABLE crm_leads ADD COLUMN tags text[];
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'crm_leads' AND column_name = 'deal_value'
  ) THEN
    ALTER TABLE crm_leads ADD COLUMN deal_value numeric DEFAULT 0;
  END IF;
END $$;

-- Create crm_quotations table
CREATE TABLE IF NOT EXISTS crm_quotations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quotation_number text UNIQUE NOT NULL,
  lead_id uuid REFERENCES crm_leads(id) ON DELETE SET NULL,
  customer_id uuid REFERENCES customers(id) ON DELETE SET NULL,
  quotation_date date NOT NULL DEFAULT CURRENT_DATE,
  valid_until date NOT NULL,
  subtotal numeric NOT NULL DEFAULT 0,
  tax_amount numeric NOT NULL DEFAULT 0,
  discount_amount numeric DEFAULT 0,
  total_amount numeric NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'accepted', 'rejected', 'expired')),
  notes text,
  terms_conditions text,
  created_by uuid REFERENCES user_profiles(id),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  CONSTRAINT at_least_one_entity CHECK (lead_id IS NOT NULL OR customer_id IS NOT NULL)
);

-- Create index for faster lookups
CREATE INDEX IF NOT EXISTS idx_crm_quotations_lead_id ON crm_quotations(lead_id);
CREATE INDEX IF NOT EXISTS idx_crm_quotations_customer_id ON crm_quotations(customer_id);
CREATE INDEX IF NOT EXISTS idx_crm_quotations_status ON crm_quotations(status);

-- Create crm_quotation_items table
CREATE TABLE IF NOT EXISTS crm_quotation_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quotation_id uuid NOT NULL REFERENCES crm_quotations(id) ON DELETE CASCADE,
  product_id uuid REFERENCES products(id) ON DELETE SET NULL,
  product_name text NOT NULL,
  quantity numeric NOT NULL CHECK (quantity > 0),
  unit_price numeric NOT NULL CHECK (unit_price >= 0),
  tax_rate numeric DEFAULT 0 CHECK (tax_rate >= 0),
  discount_percent numeric DEFAULT 0 CHECK (discount_percent >= 0 AND discount_percent <= 100),
  line_total numeric GENERATED ALWAYS AS (
    quantity * unit_price * (1 - discount_percent / 100) * (1 + tax_rate / 100)
  ) STORED,
  created_at timestamptz DEFAULT now()
);

-- Create index for quotation items
CREATE INDEX IF NOT EXISTS idx_crm_quotation_items_quotation_id ON crm_quotation_items(quotation_id);

-- Enable RLS on new tables
ALTER TABLE crm_quotations ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_quotation_items ENABLE ROW LEVEL SECURITY;

-- RLS Policies for crm_quotations
CREATE POLICY "Users can view all quotations"
  ON crm_quotations FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Admin and sales can insert quotations"
  ON crm_quotations FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid()
      AND role IN ('admin', 'sales')
    )
  );

CREATE POLICY "Admin and sales can update quotations"
  ON crm_quotations FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid()
      AND role IN ('admin', 'sales')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid()
      AND role IN ('admin', 'sales')
    )
  );

CREATE POLICY "Admin can delete quotations"
  ON crm_quotations FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid()
      AND role = 'admin'
    )
  );

-- RLS Policies for crm_quotation_items
CREATE POLICY "Users can view quotation items"
  ON crm_quotation_items FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Admin and sales can manage quotation items"
  ON crm_quotation_items FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid()
      AND role IN ('admin', 'sales')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid()
      AND role IN ('admin', 'sales')
    )
  );

-- Function to update quotation totals
CREATE OR REPLACE FUNCTION update_quotation_totals()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE crm_quotations
  SET 
    subtotal = (
      SELECT COALESCE(SUM(quantity * unit_price * (1 - discount_percent / 100)), 0)
      FROM crm_quotation_items
      WHERE quotation_id = COALESCE(NEW.quotation_id, OLD.quotation_id)
    ),
    tax_amount = (
      SELECT COALESCE(SUM(quantity * unit_price * (1 - discount_percent / 100) * (tax_rate / 100)), 0)
      FROM crm_quotation_items
      WHERE quotation_id = COALESCE(NEW.quotation_id, OLD.quotation_id)
    ),
    total_amount = (
      SELECT COALESCE(SUM(line_total), 0)
      FROM crm_quotation_items
      WHERE quotation_id = COALESCE(NEW.quotation_id, OLD.quotation_id)
    ),
    updated_at = now()
  WHERE id = COALESCE(NEW.quotation_id, OLD.quotation_id);
  
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Trigger to update quotation totals
DROP TRIGGER IF EXISTS trg_update_quotation_totals ON crm_quotation_items;
CREATE TRIGGER trg_update_quotation_totals
AFTER INSERT OR UPDATE OR DELETE ON crm_quotation_items
FOR EACH ROW
EXECUTE FUNCTION update_quotation_totals();

-- Function to auto-update next_follow_up when activities are added
CREATE OR REPLACE FUNCTION update_lead_next_follow_up()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.follow_up_date IS NOT NULL AND NEW.lead_id IS NOT NULL THEN
    UPDATE crm_leads
    SET next_follow_up = NEW.follow_up_date
    WHERE id = NEW.lead_id
    AND (next_follow_up IS NULL OR NEW.follow_up_date < next_follow_up);
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Trigger for activity follow-up updates
DROP TRIGGER IF EXISTS trg_update_lead_next_follow_up ON crm_activities;
CREATE TRIGGER trg_update_lead_next_follow_up
AFTER INSERT OR UPDATE ON crm_activities
FOR EACH ROW
WHEN (NEW.follow_up_date IS NOT NULL)
EXECUTE FUNCTION update_lead_next_follow_up();

-- Function to update lead status when quotation is accepted
CREATE OR REPLACE FUNCTION update_lead_on_quotation_status()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'accepted' AND OLD.status != 'accepted' AND NEW.lead_id IS NOT NULL THEN
    UPDATE crm_leads
    SET status = 'won'
    WHERE id = NEW.lead_id;
  END IF;
  
  IF NEW.status = 'rejected' AND OLD.status != 'rejected' AND NEW.lead_id IS NOT NULL THEN
    UPDATE crm_leads
    SET status = 'lost'
    WHERE id = NEW.lead_id;
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Trigger for quotation status updates
DROP TRIGGER IF EXISTS trg_update_lead_on_quotation_status ON crm_quotations;
CREATE TRIGGER trg_update_lead_on_quotation_status
AFTER UPDATE ON crm_quotations
FOR EACH ROW
WHEN (NEW.status IS DISTINCT FROM OLD.status)
EXECUTE FUNCTION update_lead_on_quotation_status();
