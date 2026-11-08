-- Migration: 20261107100000_revoke_anon_policies_crm_contact_phones.sql
-- Description: Revoke inappropriate anonymous (anon) policies from crm_contact_phones
-- Standard: Only authenticated users and service_role should access CRM contact phone records.
-- Status: PREPARED ONLY — DO NOT APPLY DIRECTLY TO PRODUCTION DATABASE.

DO $$
BEGIN
  -- Drop overly permissive anon policies on crm_contact_phones
  IF EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE tablename = 'crm_contact_phones' 
      AND policyname = 'Allow anon delete crm_contact_phones'
  ) THEN
    DROP POLICY "Allow anon delete crm_contact_phones" ON public.crm_contact_phones;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE tablename = 'crm_contact_phones' 
      AND policyname = 'Allow anon insert crm_contact_phones'
  ) THEN
    DROP POLICY "Allow anon insert crm_contact_phones" ON public.crm_contact_phones;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE tablename = 'crm_contact_phones' 
      AND policyname = 'Allow anon read crm_contact_phones'
  ) THEN
    DROP POLICY "Allow anon read crm_contact_phones" ON public.crm_contact_phones;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE tablename = 'crm_contact_phones' 
      AND policyname = 'Allow anon update crm_contact_phones'
  ) THEN
    DROP POLICY "Allow anon update crm_contact_phones" ON public.crm_contact_phones;
  END IF;
END $$;

