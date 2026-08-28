/*
  # Fix extracted_contacts RLS - add UPDATE policy for upsert support
  
  Upsert requires both INSERT and UPDATE permissions.
  Previously only INSERT existed, causing 403 on conflict resolution.
  Also tighten SELECT to only show own contacts.
*/

DROP POLICY IF EXISTS "Authenticated users can view all extracted contacts" ON extracted_contacts;

CREATE POLICY "Users can view own extracted contacts"
  ON extracted_contacts FOR SELECT
  TO authenticated
  USING (user_id = (SELECT auth.uid()));

CREATE POLICY "Users can update own extracted contacts"
  ON extracted_contacts FOR UPDATE
  TO authenticated
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));
