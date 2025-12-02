/*
  # Create Comprehensive Inquiry-Based CRM System
  
  1. New Tables
    - `crm_inquiries` - Main inquiry tracking (replaces basic leads)
      - Maps to your Excel: Date, Product, Qty, Supplier, Subject, Inquiry No, Status, Remarks
      - Additional fields for workflow management
    
    - `crm_email_inbox` - Email integration inbox
      - Fetch emails and convert to inquiries
      - Track email threads and responses
    
    - `crm_email_templates` - Reusable email templates
      - Quick responses for common scenarios
    
    - `crm_reminders` - Follow-up reminders and tasks
      - Calendar integration with notifications
    
    - `crm_contacts` - Enhanced contact database
      - Importable from CSV/Excel
      - Link to inquiries and companies
    
    - `crm_pipeline_stages` - Customizable pipeline stages
      - Visual kanban board support
  
  2. Security
    - Enable RLS on all tables
    - Policies for authenticated users
*/

-- Drop old CRM tables if needed (we'll keep them for now but create new system)

-- Create inquiry statuses enum type
DO $$ BEGIN
  CREATE TYPE inquiry_status AS ENUM (
    'new', 'price_quoted', 'coa_pending', 'sample_sent', 
    'negotiation', 'po_received', 'won', 'lost', 'on_hold'
  );
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- Create priority enum
DO $$ BEGIN
  CREATE TYPE inquiry_priority AS ENUM ('low', 'medium', 'high', 'urgent');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- Main inquiries table (your Excel structure)
CREATE TABLE IF NOT EXISTS crm_inquiries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inquiry_number text UNIQUE NOT NULL,
  inquiry_date date NOT NULL DEFAULT CURRENT_DATE,
  
  -- Product & Supplier Info (from your Excel)
  product_name text NOT NULL,
  quantity text NOT NULL,
  supplier_name text,
  supplier_country text,
  
  -- Contact & Company Info
  contact_person text,
  contact_email text,
  contact_phone text,
  company_name text NOT NULL,
  
  -- Email Subject & Details
  email_subject text,
  email_body text,
  
  -- Status & Tracking
  status inquiry_status DEFAULT 'new',
  priority inquiry_priority DEFAULT 'medium',
  
  -- Follow-up & Reminders
  next_follow_up timestamptz,
  last_contact_date timestamptz,
  
  -- Financial
  quoted_price numeric,
  quoted_currency text DEFAULT 'IDR',
  target_price numeric,
  estimated_value numeric,
  
  -- Documents & Actions Needed
  coa_sent boolean DEFAULT false,
  coa_sent_date date,
  msds_sent boolean DEFAULT false,
  msds_sent_date date,
  sample_sent boolean DEFAULT false,
  sample_sent_date date,
  price_quoted boolean DEFAULT false,
  price_quoted_date date,
  
  -- Additional tracking
  remarks text,
  internal_notes text,
  tags text[],
  
  -- Assignment
  assigned_to uuid REFERENCES user_profiles(id),
  
  -- Source tracking
  source text DEFAULT 'email',
  source_email_id uuid,
  
  -- Conversion tracking
  converted_to_quotation uuid,
  converted_to_order uuid,
  
  -- Timestamps
  created_by uuid REFERENCES user_profiles(id),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  closed_at timestamptz
);

-- Indexes for fast queries
CREATE INDEX IF NOT EXISTS idx_crm_inquiries_status ON crm_inquiries(status);
CREATE INDEX IF NOT EXISTS idx_crm_inquiries_date ON crm_inquiries(inquiry_date DESC);
CREATE INDEX IF NOT EXISTS idx_crm_inquiries_company ON crm_inquiries(company_name);
CREATE INDEX IF NOT EXISTS idx_crm_inquiries_assigned ON crm_inquiries(assigned_to);
CREATE INDEX IF NOT EXISTS idx_crm_inquiries_next_followup ON crm_inquiries(next_follow_up);

-- Email inbox table
CREATE TABLE IF NOT EXISTS crm_email_inbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_email text NOT NULL,
  from_name text,
  to_email text,
  subject text NOT NULL,
  body text,
  received_date timestamptz NOT NULL DEFAULT now(),
  
  -- Processing status
  is_processed boolean DEFAULT false,
  is_inquiry boolean DEFAULT false,
  converted_to_inquiry uuid REFERENCES crm_inquiries(id),
  
  -- Email metadata
  email_id text UNIQUE,
  thread_id text,
  in_reply_to text,
  has_attachments boolean DEFAULT false,
  attachment_urls text[],
  
  -- Assignment
  assigned_to uuid REFERENCES user_profiles(id),
  
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_email_inbox_received ON crm_email_inbox(received_date DESC);
CREATE INDEX IF NOT EXISTS idx_email_inbox_processed ON crm_email_inbox(is_processed, is_inquiry);

-- Email templates table
CREATE TABLE IF NOT EXISTS crm_email_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_name text NOT NULL,
  subject text NOT NULL,
  body text NOT NULL,
  category text,
  
  -- Variables support (e.g., {{company_name}}, {{product}})
  variables text[],
  
  -- Usage tracking
  use_count integer DEFAULT 0,
  last_used timestamptz,
  
  is_active boolean DEFAULT true,
  created_by uuid REFERENCES user_profiles(id),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Reminders & Tasks table
CREATE TABLE IF NOT EXISTS crm_reminders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inquiry_id uuid REFERENCES crm_inquiries(id) ON DELETE CASCADE,
  
  reminder_type text NOT NULL CHECK (reminder_type IN ('follow_up', 'send_coa', 'send_sample', 'send_price', 'custom')),
  title text NOT NULL,
  description text,
  
  due_date timestamptz NOT NULL,
  reminder_date timestamptz,
  
  is_completed boolean DEFAULT false,
  completed_at timestamptz,
  completed_by uuid REFERENCES user_profiles(id),
  
  assigned_to uuid NOT NULL REFERENCES user_profiles(id),
  created_by uuid REFERENCES user_profiles(id),
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_reminders_due_date ON crm_reminders(due_date) WHERE is_completed = false;
CREATE INDEX IF NOT EXISTS idx_reminders_assigned ON crm_reminders(assigned_to, is_completed);

-- Contacts database (for bulk import)
CREATE TABLE IF NOT EXISTS crm_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- Company info
  company_name text NOT NULL,
  company_type text,
  industry text,
  country text,
  city text,
  address text,
  website text,
  
  -- Primary contact
  contact_person text,
  designation text,
  email text,
  phone text,
  mobile text,
  
  -- Additional contacts (JSON array)
  additional_contacts jsonb,
  
  -- Classification
  customer_type text CHECK (customer_type IN ('prospect', 'active', 'inactive', 'vip')),
  tags text[],
  
  -- Relationship info
  first_contact_date date,
  last_contact_date date,
  total_inquiries integer DEFAULT 0,
  total_orders integer DEFAULT 0,
  lifetime_value numeric DEFAULT 0,
  
  -- Notes
  notes text,
  
  is_active boolean DEFAULT true,
  created_by uuid REFERENCES user_profiles(id),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_contacts_company ON crm_contacts(company_name);
CREATE INDEX IF NOT EXISTS idx_contacts_email ON crm_contacts(email);
CREATE INDEX IF NOT EXISTS idx_contacts_type ON crm_contacts(customer_type);

-- Pipeline stages (customizable)
CREATE TABLE IF NOT EXISTS crm_pipeline_stages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stage_name text NOT NULL,
  stage_order integer NOT NULL,
  color text DEFAULT '#3B82F6',
  is_active boolean DEFAULT true,
  created_at timestamptz DEFAULT now()
);

-- Insert default stages
INSERT INTO crm_pipeline_stages (stage_name, stage_order, color) VALUES
  ('New Inquiry', 1, '#6B7280'),
  ('Price Quoted', 2, '#3B82F6'),
  ('COA Pending', 3, '#F59E0B'),
  ('Sample Sent', 4, '#8B5CF6'),
  ('Negotiation', 5, '#EC4899'),
  ('PO Received', 6, '#10B981'),
  ('Won', 7, '#059669'),
  ('Lost', 8, '#EF4444')
ON CONFLICT DO NOTHING;

-- Email activity log
CREATE TABLE IF NOT EXISTS crm_email_activities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inquiry_id uuid REFERENCES crm_inquiries(id) ON DELETE CASCADE,
  contact_id uuid REFERENCES crm_contacts(id),
  
  email_type text CHECK (email_type IN ('sent', 'received', 'draft')),
  from_email text,
  to_email text[],
  cc_email text[],
  bcc_email text[],
  
  subject text NOT NULL,
  body text,
  template_id uuid REFERENCES crm_email_templates(id),
  
  sent_date timestamptz,
  opened_date timestamptz,
  clicked_date timestamptz,
  
  attachment_urls text[],
  
  created_by uuid REFERENCES user_profiles(id),
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_email_activities_inquiry ON crm_email_activities(inquiry_id);

-- Enable RLS on all tables
ALTER TABLE crm_inquiries ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_email_inbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_email_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_reminders ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_pipeline_stages ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_email_activities ENABLE ROW LEVEL SECURITY;

-- RLS Policies
CREATE POLICY "Users can view all inquiries"
  ON crm_inquiries FOR SELECT TO authenticated USING (true);

CREATE POLICY "Sales and admin can manage inquiries"
  ON crm_inquiries FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid() AND role IN ('admin', 'sales')
    )
  );

CREATE POLICY "Users can view email inbox"
  ON crm_email_inbox FOR SELECT TO authenticated USING (true);

CREATE POLICY "Sales and admin can manage emails"
  ON crm_email_inbox FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid() AND role IN ('admin', 'sales')
    )
  );

CREATE POLICY "Users can view email templates"
  ON crm_email_templates FOR SELECT TO authenticated USING (true);

CREATE POLICY "Admin can manage email templates"
  ON crm_email_templates FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid() AND role = 'admin'
    )
  );

CREATE POLICY "Users can view their reminders"
  ON crm_reminders FOR SELECT TO authenticated
  USING (assigned_to = auth.uid() OR created_by = auth.uid());

CREATE POLICY "Users can manage their reminders"
  ON crm_reminders FOR ALL TO authenticated
  USING (assigned_to = auth.uid() OR created_by = auth.uid());

CREATE POLICY "Users can view all contacts"
  ON crm_contacts FOR SELECT TO authenticated USING (true);

CREATE POLICY "Sales and admin can manage contacts"
  ON crm_contacts FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid() AND role IN ('admin', 'sales')
    )
  );

CREATE POLICY "Users can view pipeline stages"
  ON crm_pipeline_stages FOR SELECT TO authenticated USING (true);

CREATE POLICY "Admin can manage pipeline stages"
  ON crm_pipeline_stages FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid() AND role = 'admin'
    )
  );

CREATE POLICY "Users can view email activities"
  ON crm_email_activities FOR SELECT TO authenticated USING (true);

CREATE POLICY "Sales and admin can manage email activities"
  ON crm_email_activities FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid() AND role IN ('admin', 'sales')
    )
  );

-- Trigger to update timestamps
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_inquiries_updated_at ON crm_inquiries;
CREATE TRIGGER update_inquiries_updated_at
  BEFORE UPDATE ON crm_inquiries
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_contacts_updated_at ON crm_contacts;
CREATE TRIGGER update_contacts_updated_at
  BEFORE UPDATE ON crm_contacts
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- Function to auto-generate inquiry numbers
CREATE OR REPLACE FUNCTION generate_inquiry_number()
RETURNS text AS $$
DECLARE
  new_number text;
  last_number text;
  numeric_part integer;
BEGIN
  SELECT inquiry_number INTO last_number
  FROM crm_inquiries
  WHERE inquiry_number ~ '^\d+$'
  ORDER BY created_at DESC
  LIMIT 1;
  
  IF last_number IS NULL THEN
    new_number := '500';
  ELSE
    numeric_part := CAST(last_number AS integer) + 1;
    new_number := CAST(numeric_part AS text);
  END IF;
  
  RETURN new_number;
END;
$$ LANGUAGE plpgsql;
