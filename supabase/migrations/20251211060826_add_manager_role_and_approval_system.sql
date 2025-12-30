/*
  # Add Manager Role and Approval System
  
  ## Overview
  Adds manager role to the system and creates a comprehensive approval workflow
  for returns, rejections, and other transactions requiring authorization.
  
  ## Changes
  
  ### 1. Role System Enhancement
    - Add 'manager' role to user_profiles role constraint
    - Keep existing 'admin', 'accounts', 'sales', 'warehouse' roles
  
  ### 2. New Tables
    - `approval_workflows`: Central approval tracking table
      - `id` (uuid, primary key)
      - `transaction_type` (enum: 'material_return', 'stock_rejection', 'purchase_approval')
      - `transaction_id` (uuid) - references the specific transaction
      - `requested_by` (uuid) - user who initiated the request
      - `amount` (decimal) - monetary value for approval threshold checks
      - `status` (enum: 'pending', 'approved', 'rejected')
      - `approved_by` (uuid) - manager/admin who approved
      - `rejection_reason` (text)
      - `notes` (text)
      - `created_at` (timestamptz)
      - `updated_at` (timestamptz)
    
    - `approval_thresholds`: Configurable approval limits
      - `id` (uuid, primary key)
      - `transaction_type` (text)
      - `min_amount` (decimal)
      - `max_amount` (decimal)
      - `required_role` (text) - 'manager' or 'admin'
      - `description` (text)
      - `is_active` (boolean)
  
  ### 3. Security
    - Enable RLS on all new tables
    - Add policies for authenticated users
    - Managers can view and approve pending requests
    - Admins have full access
    - Users can view their own requests
*/

-- Update user_profiles role constraint to include 'manager'
ALTER TABLE user_profiles DROP CONSTRAINT IF EXISTS user_profiles_role_check;
ALTER TABLE user_profiles ADD CONSTRAINT user_profiles_role_check 
  CHECK (role IN ('admin', 'accounts', 'sales', 'warehouse', 'manager'));

-- Create approval workflows table
CREATE TABLE IF NOT EXISTS approval_workflows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_type text NOT NULL CHECK (transaction_type IN ('material_return', 'stock_rejection', 'purchase_approval', 'expense_approval')),
  transaction_id uuid NOT NULL,
  requested_by uuid NOT NULL REFERENCES auth.users(id),
  amount decimal(15,2) DEFAULT 0,
  quantity decimal(10,2) DEFAULT 0,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  approved_by uuid REFERENCES auth.users(id),
  rejection_reason text,
  notes text,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Create approval thresholds table
CREATE TABLE IF NOT EXISTS approval_thresholds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_type text NOT NULL,
  min_amount decimal(15,2) DEFAULT 0,
  max_amount decimal(15,2),
  required_role text NOT NULL CHECK (required_role IN ('manager', 'admin')),
  description text,
  is_active boolean DEFAULT true,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(transaction_type, min_amount, max_amount)
);

-- Insert default approval thresholds
INSERT INTO approval_thresholds (transaction_type, min_amount, max_amount, required_role, description) VALUES
  ('stock_rejection', 0, 100, 'manager', 'Rejections under $100 require manager approval'),
  ('stock_rejection', 100, 1000, 'manager', 'Rejections $100-$1000 require manager approval'),
  ('stock_rejection', 1000, NULL, 'admin', 'Rejections over $1000 require admin approval'),
  ('material_return', 500, NULL, 'manager', 'Returns over $500 require manager inspection')
ON CONFLICT (transaction_type, min_amount, max_amount) DO NOTHING;

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_approval_workflows_status ON approval_workflows(status);
CREATE INDEX IF NOT EXISTS idx_approval_workflows_requested_by ON approval_workflows(requested_by);
CREATE INDEX IF NOT EXISTS idx_approval_workflows_approved_by ON approval_workflows(approved_by);
CREATE INDEX IF NOT EXISTS idx_approval_workflows_transaction ON approval_workflows(transaction_type, transaction_id);
CREATE INDEX IF NOT EXISTS idx_approval_thresholds_type ON approval_thresholds(transaction_type);

-- Enable RLS
ALTER TABLE approval_workflows ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_thresholds ENABLE ROW LEVEL SECURITY;

-- RLS Policies for approval_workflows

-- Users can view their own requests
CREATE POLICY "Users can view own approval requests"
  ON approval_workflows FOR SELECT
  TO authenticated
  USING (
    requested_by = auth.uid() OR
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
      AND user_profiles.role IN ('manager', 'admin')
    )
  );

-- Users can create approval requests
CREATE POLICY "Users can create approval requests"
  ON approval_workflows FOR INSERT
  TO authenticated
  WITH CHECK (requested_by = auth.uid());

-- Managers and admins can update approvals
CREATE POLICY "Managers can update approval requests"
  ON approval_workflows FOR UPDATE
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

-- RLS Policies for approval_thresholds

-- Everyone can view thresholds
CREATE POLICY "Users can view approval thresholds"
  ON approval_thresholds FOR SELECT
  TO authenticated
  USING (true);

-- Only admins can manage thresholds
CREATE POLICY "Admins can manage approval thresholds"
  ON approval_thresholds FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
      AND user_profiles.role = 'admin'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
      AND user_profiles.role = 'admin'
    )
  );

-- Function to automatically update updated_at
CREATE OR REPLACE FUNCTION update_approval_workflows_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Trigger for updated_at
DROP TRIGGER IF EXISTS update_approval_workflows_updated_at_trigger ON approval_workflows;
CREATE TRIGGER update_approval_workflows_updated_at_trigger
  BEFORE UPDATE ON approval_workflows
  FOR EACH ROW
  EXECUTE FUNCTION update_approval_workflows_updated_at();

-- Function to check if approval is required
CREATE OR REPLACE FUNCTION check_approval_required(
  p_transaction_type text,
  p_amount decimal
)
RETURNS TABLE (
  required boolean,
  required_role text,
  threshold_id uuid
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    true as required,
    at.required_role,
    at.id as threshold_id
  FROM approval_thresholds at
  WHERE at.transaction_type = p_transaction_type
    AND at.is_active = true
    AND p_amount >= at.min_amount
    AND (at.max_amount IS NULL OR p_amount < at.max_amount)
  ORDER BY at.min_amount DESC
  LIMIT 1;
  
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, NULL::text, NULL::uuid;
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
