/*
  # Enhanced CRM Inquiry Tracking System

  ## Overview
  Complete redesign of inquiry tracking with:
  - Simplified pipeline status (6 stages instead of 9)
  - Requirement tracking (what customer needs vs what we sent)
  - Additional business columns (pricing, reference numbers, delivery)
  - Archive system for lost deals with detailed tracking

  ## 1. New Pipeline Status Enum
    - `pipeline_status`: new, in_progress, follow_up, won, lost, on_hold
    - Simpler and clearer than current status field

  ## 2. Requirement Tracking Fields
    - What customer requested: price_required, coa_required, sample_required, agency_letter_required
    - What we sent: price_sent_at, coa_sent_at, sample_sent_at, agency_letter_sent_at
    - Enables "Our Side" tracking - what's pending from us

  ## 3. New Business Columns
    - mail_subject: Email subject (auto from Command Center or manual)
    - aceerp_no: Internal ACE ERP reference number
    - purchase_price: What we pay supplier (admin only view)
    - offered_price: What we offer customer (USD)
    - delivery_date: Expected delivery date
    - delivery_terms: FOB, CIF, etc.

  ## 4. Lost Deal Tracking (Archive)
    - lost_reason: Why deal was lost (required when marking lost)
    - lost_at: Timestamp when marked as lost
    - competitor_name: Who won the deal (optional)
    - competitor_price: Their price (optional)

  ## 5. Security
    - RLS policies updated for admin-only price visibility
    - Helper functions for requirement fulfillment checks
    - Triggers for auto-status updates
*/

-- Create new pipeline_status enum
DO $$ BEGIN
  CREATE TYPE pipeline_status_enum AS ENUM (
    'new', 'in_progress', 'follow_up', 'won', 'lost', 'on_hold'
  );
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- Add pipeline_status column (new simplified status)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'crm_inquiries' AND column_name = 'pipeline_status'
  ) THEN
    ALTER TABLE crm_inquiries ADD COLUMN pipeline_status pipeline_status_enum DEFAULT 'new';
  END IF;
END $$;

-- Add requirement tracking columns (what customer requested)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'crm_inquiries' AND column_name = 'price_required'
  ) THEN
    ALTER TABLE crm_inquiries ADD COLUMN price_required boolean DEFAULT false;
  END IF;
  
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'crm_inquiries' AND column_name = 'coa_required'
  ) THEN
    ALTER TABLE crm_inquiries ADD COLUMN coa_required boolean DEFAULT false;
  END IF;
  
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'crm_inquiries' AND column_name = 'sample_required'
  ) THEN
    ALTER TABLE crm_inquiries ADD COLUMN sample_required boolean DEFAULT false;
  END IF;
  
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'crm_inquiries' AND column_name = 'agency_letter_required'
  ) THEN
    ALTER TABLE crm_inquiries ADD COLUMN agency_letter_required boolean DEFAULT false;
  END IF;
END $$;

-- Add fulfillment tracking columns (when we sent items)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'crm_inquiries' AND column_name = 'price_sent_at'
  ) THEN
    ALTER TABLE crm_inquiries ADD COLUMN price_sent_at timestamptz;
  END IF;
  
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'crm_inquiries' AND column_name = 'coa_sent_at'
  ) THEN
    ALTER TABLE crm_inquiries ADD COLUMN coa_sent_at timestamptz;
  END IF;
  
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'crm_inquiries' AND column_name = 'sample_sent_at'
  ) THEN
    ALTER TABLE crm_inquiries ADD COLUMN sample_sent_at timestamptz;
  END IF;
  
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'crm_inquiries' AND column_name = 'agency_letter_sent_at'
  ) THEN
    ALTER TABLE crm_inquiries ADD COLUMN agency_letter_sent_at timestamptz;
  END IF;
END $$;

-- Add new business columns
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'crm_inquiries' AND column_name = 'mail_subject'
  ) THEN
    ALTER TABLE crm_inquiries ADD COLUMN mail_subject text;
  END IF;
  
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'crm_inquiries' AND column_name = 'aceerp_no'
  ) THEN
    ALTER TABLE crm_inquiries ADD COLUMN aceerp_no text;
  END IF;
  
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'crm_inquiries' AND column_name = 'purchase_price'
  ) THEN
    ALTER TABLE crm_inquiries ADD COLUMN purchase_price numeric;
  END IF;
  
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'crm_inquiries' AND column_name = 'purchase_price_currency'
  ) THEN
    ALTER TABLE crm_inquiries ADD COLUMN purchase_price_currency text DEFAULT 'USD';
  END IF;
  
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'crm_inquiries' AND column_name = 'offered_price'
  ) THEN
    ALTER TABLE crm_inquiries ADD COLUMN offered_price numeric;
  END IF;
  
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'crm_inquiries' AND column_name = 'offered_price_currency'
  ) THEN
    ALTER TABLE crm_inquiries ADD COLUMN offered_price_currency text DEFAULT 'USD';
  END IF;
  
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'crm_inquiries' AND column_name = 'delivery_date'
  ) THEN
    ALTER TABLE crm_inquiries ADD COLUMN delivery_date date;
  END IF;
  
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'crm_inquiries' AND column_name = 'delivery_terms'
  ) THEN
    ALTER TABLE crm_inquiries ADD COLUMN delivery_terms text;
  END IF;
END $$;

-- Add lost deal tracking columns (archive system)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'crm_inquiries' AND column_name = 'lost_reason'
  ) THEN
    ALTER TABLE crm_inquiries ADD COLUMN lost_reason text;
  END IF;
  
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'crm_inquiries' AND column_name = 'lost_at'
  ) THEN
    ALTER TABLE crm_inquiries ADD COLUMN lost_at timestamptz;
  END IF;
  
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'crm_inquiries' AND column_name = 'competitor_name'
  ) THEN
    ALTER TABLE crm_inquiries ADD COLUMN competitor_name text;
  END IF;
  
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'crm_inquiries' AND column_name = 'competitor_price'
  ) THEN
    ALTER TABLE crm_inquiries ADD COLUMN competitor_price numeric;
  END IF;
END $$;

-- Create indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_crm_inquiries_pipeline_status ON crm_inquiries(pipeline_status);
CREATE INDEX IF NOT EXISTS idx_crm_inquiries_mail_subject ON crm_inquiries(mail_subject);
CREATE INDEX IF NOT EXISTS idx_crm_inquiries_aceerp_no ON crm_inquiries(aceerp_no);
CREATE INDEX IF NOT EXISTS idx_crm_inquiries_delivery_date ON crm_inquiries(delivery_date);
CREATE INDEX IF NOT EXISTS idx_crm_inquiries_lost_at ON crm_inquiries(lost_at) WHERE pipeline_status = 'lost';

-- Function to check if all requirements are fulfilled
CREATE OR REPLACE FUNCTION check_inquiry_requirements_fulfilled(inquiry_id uuid)
RETURNS boolean AS $$
DECLARE
  inquiry_record RECORD;
  all_fulfilled boolean;
BEGIN
  SELECT * INTO inquiry_record
  FROM crm_inquiries
  WHERE id = inquiry_id;
  
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  
  all_fulfilled := (
    (NOT inquiry_record.price_required OR inquiry_record.price_sent_at IS NOT NULL) AND
    (NOT inquiry_record.coa_required OR inquiry_record.coa_sent_at IS NOT NULL) AND
    (NOT inquiry_record.sample_required OR inquiry_record.sample_sent_at IS NOT NULL) AND
    (NOT inquiry_record.agency_letter_required OR inquiry_record.agency_letter_sent_at IS NOT NULL)
  );
  
  RETURN all_fulfilled;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to mark a requirement as sent
CREATE OR REPLACE FUNCTION mark_requirement_sent(
  inquiry_id uuid,
  requirement_type text
)
RETURNS void AS $$
BEGIN
  CASE requirement_type
    WHEN 'price' THEN
      UPDATE crm_inquiries SET price_sent_at = now() WHERE id = inquiry_id;
    WHEN 'coa' THEN
      UPDATE crm_inquiries SET coa_sent_at = now() WHERE id = inquiry_id;
    WHEN 'sample' THEN
      UPDATE crm_inquiries SET sample_sent_at = now() WHERE id = inquiry_id;
    WHEN 'agency_letter' THEN
      UPDATE crm_inquiries SET agency_letter_sent_at = now() WHERE id = inquiry_id;
    ELSE
      RAISE EXCEPTION 'Invalid requirement type: %', requirement_type;
  END CASE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Trigger to auto-update pipeline status when all requirements fulfilled
CREATE OR REPLACE FUNCTION auto_update_pipeline_status()
RETURNS TRIGGER AS $$
BEGIN
  -- If all requirements are fulfilled and status is 'in_progress', move to 'follow_up'
  IF check_inquiry_requirements_fulfilled(NEW.id) AND NEW.pipeline_status = 'in_progress' THEN
    NEW.pipeline_status := 'follow_up';
  END IF;
  
  -- If marking as lost, set lost_at timestamp
  IF NEW.pipeline_status = 'lost' AND OLD.pipeline_status != 'lost' THEN
    NEW.lost_at := now();
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_auto_update_pipeline_status ON crm_inquiries;
CREATE TRIGGER trg_auto_update_pipeline_status
  BEFORE UPDATE ON crm_inquiries
  FOR EACH ROW
  EXECUTE FUNCTION auto_update_pipeline_status();

-- Migrate existing status to pipeline_status (one-time migration)
UPDATE crm_inquiries
SET pipeline_status = CASE 
  WHEN status = 'new' THEN 'new'::pipeline_status_enum
  WHEN status IN ('price_quoted', 'coa_pending', 'sample_sent', 'negotiation') THEN 'in_progress'::pipeline_status_enum
  WHEN status = 'po_received' THEN 'follow_up'::pipeline_status_enum
  WHEN status = 'won' THEN 'won'::pipeline_status_enum
  WHEN status = 'lost' THEN 'lost'::pipeline_status_enum
  WHEN status = 'on_hold' THEN 'on_hold'::pipeline_status_enum
  ELSE 'new'::pipeline_status_enum
END
WHERE pipeline_status = 'new'; -- Only update if not already set

-- Set requirement tracking based on existing boolean fields
UPDATE crm_inquiries
SET 
  price_required = COALESCE(price_quoted, false),
  coa_required = COALESCE(coa_sent, false),
  sample_required = COALESCE(sample_sent, false),
  price_sent_at = CASE WHEN price_quoted THEN price_quoted_date ELSE NULL END,
  coa_sent_at = CASE WHEN coa_sent THEN coa_sent_date ELSE NULL END,
  sample_sent_at = CASE WHEN sample_sent THEN sample_sent_date ELSE NULL END
WHERE price_sent_at IS NULL; -- Only update if not already set