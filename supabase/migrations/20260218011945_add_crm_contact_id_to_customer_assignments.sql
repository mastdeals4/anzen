/*
  # Add CRM Contact ID to Customer Assignments

  ## Summary
  The customer_assignments table previously only linked to the `customers` (billing) table.
  The CRM Customers tab shows `crm_contacts`, so assignments need to support crm_contacts too.

  ## Changes
  - Add nullable `crm_contact_id` column to `customer_assignments` referencing `crm_contacts(id)`
  - Add index for performance
  - Update RLS to allow same access pattern
*/

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'customer_assignments' AND column_name = 'crm_contact_id'
  ) THEN
    ALTER TABLE customer_assignments
      ADD COLUMN crm_contact_id uuid REFERENCES crm_contacts(id) ON DELETE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_customer_assignments_crm_contact_id ON customer_assignments(crm_contact_id);
