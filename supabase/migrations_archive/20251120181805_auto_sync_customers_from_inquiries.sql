/*
  # Auto-sync Customers from Inquiries

  1. Purpose
    - Automatically create/update customer records when inquiries are created
    - Ensure all inquiry sources (Email, WhatsApp, Calls) create unified customer records
    - Link customers to inquiries for complete history tracking

  2. Changes
    - Create trigger function to auto-create customers from inquiries
    - Update customer inquiry counts automatically
    - Ensure data consistency across all entry points
*/

-- Function to auto-create or update customer from inquiry
CREATE OR REPLACE FUNCTION sync_customer_from_inquiry()
RETURNS TRIGGER AS $$
BEGIN
  -- Insert or update customer record
  INSERT INTO crm_contacts (
    company_name,
    contact_person,
    email,
    phone,
    country,
    customer_type,
    first_contact_date,
    last_contact_date,
    total_inquiries,
    is_active,
    created_at,
    updated_at
  )
  VALUES (
    NEW.company_name,
    NEW.contact_person,
    NEW.contact_email,
    NEW.contact_phone,
    NEW.supplier_country,
    'prospect',
    NEW.inquiry_date,
    NEW.inquiry_date,
    1,
    true,
    NOW(),
    NOW()
  )
  ON CONFLICT (company_name) 
  DO UPDATE SET
    contact_person = COALESCE(EXCLUDED.contact_person, crm_contacts.contact_person),
    email = COALESCE(EXCLUDED.email, crm_contacts.email),
    phone = COALESCE(EXCLUDED.phone, crm_contacts.phone),
    country = COALESCE(EXCLUDED.country, crm_contacts.country),
    last_contact_date = EXCLUDED.last_contact_date,
    total_inquiries = crm_contacts.total_inquiries + 1,
    updated_at = NOW();

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger to auto-sync customers
DROP TRIGGER IF EXISTS trigger_sync_customer_from_inquiry ON crm_inquiries;
CREATE TRIGGER trigger_sync_customer_from_inquiry
  AFTER INSERT ON crm_inquiries
  FOR EACH ROW
  EXECUTE FUNCTION sync_customer_from_inquiry();

-- Add unique constraint on company_name if not exists
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'crm_contacts_company_name_key'
  ) THEN
    ALTER TABLE crm_contacts ADD CONSTRAINT crm_contacts_company_name_key UNIQUE (company_name);
  END IF;
END $$;

-- Backfill existing inquiries into customer database
INSERT INTO crm_contacts (
  company_name,
  contact_person,
  email,
  phone,
  country,
  customer_type,
  first_contact_date,
  last_contact_date,
  total_inquiries,
  is_active,
  created_at,
  updated_at
)
SELECT 
  company_name,
  contact_person,
  contact_email,
  contact_phone,
  supplier_country,
  'prospect',
  MIN(inquiry_date),
  MAX(inquiry_date),
  COUNT(*),
  true,
  MIN(created_at),
  NOW()
FROM crm_inquiries
GROUP BY company_name, contact_person, contact_email, contact_phone, supplier_country
ON CONFLICT (company_name) DO UPDATE SET
  last_contact_date = EXCLUDED.last_contact_date,
  total_inquiries = EXCLUDED.total_inquiries,
  updated_at = NOW();
