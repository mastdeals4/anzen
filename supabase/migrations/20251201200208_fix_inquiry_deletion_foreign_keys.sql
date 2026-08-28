/*
  # Fix Inquiry Deletion Foreign Key Constraints
  
  1. Problem
    - Cannot delete inquiries due to foreign key constraint from crm_email_inbox
    - Error: "violates foreign key constraint crm_email_inbox_converted_to_inquiry_fkey"
    - The constraint has NO ACTION on delete, blocking inquiry deletion
  
  2. Solution
    - Drop the existing foreign key constraint
    - Recreate it with ON DELETE SET NULL
    - When an inquiry is deleted, the email's converted_to_inquiry field will be set to NULL
    - This preserves the email record while removing the inquiry reference
  
  3. Impact
    - Inquiries can now be deleted without error
    - Related emails remain in inbox with cleared inquiry reference
    - Other related records (activity logs, reminders, etc.) already have CASCADE delete
*/

-- Drop the existing foreign key constraint
ALTER TABLE crm_email_inbox 
  DROP CONSTRAINT IF EXISTS crm_email_inbox_converted_to_inquiry_fkey;

-- Recreate the constraint with ON DELETE SET NULL
ALTER TABLE crm_email_inbox
  ADD CONSTRAINT crm_email_inbox_converted_to_inquiry_fkey
  FOREIGN KEY (converted_to_inquiry)
  REFERENCES crm_inquiries(id)
  ON DELETE SET NULL;