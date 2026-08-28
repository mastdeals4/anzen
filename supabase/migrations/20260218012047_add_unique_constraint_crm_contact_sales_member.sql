/*
  # Add unique constraint for crm_contact_id + sales_member_id in customer_assignments

  Enables upsert operations when assigning salespeople to CRM contacts.
*/

ALTER TABLE customer_assignments
  DROP CONSTRAINT IF EXISTS customer_assignments_crm_contact_sales_member_unique;

ALTER TABLE customer_assignments
  ADD CONSTRAINT customer_assignments_crm_contact_sales_member_unique
  UNIQUE (crm_contact_id, sales_member_id);
