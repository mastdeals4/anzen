/*
  # Sales Team & Company Assignment System

  ## Overview
  Creates a system to:
  1. Define sales team members (Zara, Aanvi, Mayur, etc.)
  2. Assign customer companies to specific salespeople
  3. Track inquiries, conversions, and performance per salesperson

  ## New Tables
  - `sales_team_members`: Salesperson profiles (name, user_id link optional)
  - `customer_assignments`: Links customers to a salesperson
  - `crm_inquiries.assigned_sales_member_id`: FK to sales_team_members

  ## Security
  - RLS enabled on all new tables
  - All authenticated users can read; admins can write
*/

-- Sales Team Members table
CREATE TABLE IF NOT EXISTS sales_team_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  email text,
  phone text,
  is_active boolean DEFAULT true,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE sales_team_members ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view sales team members"
  ON sales_team_members FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Admins can insert sales team members"
  ON sales_team_members FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
      AND user_profiles.role = 'admin'
    )
  );

CREATE POLICY "Admins can update sales team members"
  ON sales_team_members FOR UPDATE
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

-- Customer Assignments: link customers to sales members
CREATE TABLE IF NOT EXISTS customer_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  sales_member_id uuid NOT NULL REFERENCES sales_team_members(id) ON DELETE CASCADE,
  assigned_at timestamptz DEFAULT now(),
  assigned_by uuid REFERENCES auth.users(id),
  notes text,
  is_active boolean DEFAULT true,
  UNIQUE (customer_id, sales_member_id)
);

ALTER TABLE customer_assignments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view customer assignments"
  ON customer_assignments FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Admins and sales can insert customer assignments"
  ON customer_assignments FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
      AND user_profiles.role IN ('admin', 'sales')
    )
  );

CREATE POLICY "Admins and sales can update customer assignments"
  ON customer_assignments FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
      AND user_profiles.role IN ('admin', 'sales')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
      AND user_profiles.role IN ('admin', 'sales')
    )
  );

CREATE POLICY "Admins can delete customer assignments"
  ON customer_assignments FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
      AND user_profiles.role = 'admin'
    )
  );

-- Add sales_member_id to crm_inquiries for direct inquiry assignment
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'crm_inquiries' AND column_name = 'sales_member_id'
  ) THEN
    ALTER TABLE crm_inquiries ADD COLUMN sales_member_id uuid REFERENCES sales_team_members(id) ON DELETE SET NULL;
  END IF;
END $$;

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_customer_assignments_customer_id ON customer_assignments(customer_id);
CREATE INDEX IF NOT EXISTS idx_customer_assignments_sales_member_id ON customer_assignments(sales_member_id);
CREATE INDEX IF NOT EXISTS idx_crm_inquiries_sales_member_id ON crm_inquiries(sales_member_id);

-- Function: Get sales member performance summary
CREATE OR REPLACE FUNCTION public.get_sales_member_performance(p_member_id uuid DEFAULT NULL)
RETURNS TABLE (
  member_id uuid,
  member_name text,
  total_inquiries bigint,
  new_count bigint,
  in_progress_count bigint,
  follow_up_count bigint,
  won_count bigint,
  lost_count bigint,
  on_hold_count bigint,
  conversion_rate numeric,
  assigned_customers bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT
    stm.id AS member_id,
    stm.name AS member_name,
    COUNT(ci.id) AS total_inquiries,
    COUNT(ci.id) FILTER (WHERE ci.pipeline_status = 'new') AS new_count,
    COUNT(ci.id) FILTER (WHERE ci.pipeline_status = 'in_progress') AS in_progress_count,
    COUNT(ci.id) FILTER (WHERE ci.pipeline_status = 'follow_up') AS follow_up_count,
    COUNT(ci.id) FILTER (WHERE ci.pipeline_status = 'won') AS won_count,
    COUNT(ci.id) FILTER (WHERE ci.pipeline_status = 'lost') AS lost_count,
    COUNT(ci.id) FILTER (WHERE ci.pipeline_status = 'on_hold') AS on_hold_count,
    CASE
      WHEN COUNT(ci.id) FILTER (WHERE ci.pipeline_status IN ('won', 'lost')) > 0
      THEN ROUND(
        100.0 * COUNT(ci.id) FILTER (WHERE ci.pipeline_status = 'won') /
        COUNT(ci.id) FILTER (WHERE ci.pipeline_status IN ('won', 'lost')), 1
      )
      ELSE 0
    END AS conversion_rate,
    COUNT(DISTINCT ca.customer_id) AS assigned_customers
  FROM sales_team_members stm
  LEFT JOIN crm_inquiries ci ON ci.sales_member_id = stm.id
  LEFT JOIN customer_assignments ca ON ca.sales_member_id = stm.id AND ca.is_active = true
  WHERE stm.is_active = true
    AND (p_member_id IS NULL OR stm.id = p_member_id)
  GROUP BY stm.id, stm.name
  ORDER BY total_inquiries DESC;
END;
$$;

-- Seed 3 initial sales team members
INSERT INTO sales_team_members (name, is_active) VALUES
  ('Zara', true),
  ('Aanvi', true),
  ('Mayur', true)
ON CONFLICT DO NOTHING;
