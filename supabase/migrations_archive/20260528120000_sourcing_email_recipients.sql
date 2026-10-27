/*
  # Sourcing email recipients — per-route defaults

  Stores the default To/CC/BCC for India / China / Local sourcing emails.
  Lets admin/manager update them from Settings without code changes, and
  lets Anvi override them per-send in the preview modal.

  Idempotent.
*/

CREATE TABLE IF NOT EXISTS sourcing_email_recipients (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  route       text NOT NULL UNIQUE,
  to_emails   text[] NOT NULL DEFAULT '{}',
  cc_emails   text[] NOT NULL DEFAULT '{}',
  bcc_emails  text[] NOT NULL DEFAULT '{}',
  updated_by  uuid REFERENCES user_profiles(id) ON DELETE SET NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sourcing_email_recipients_route_chk') THEN
    EXECUTE 'ALTER TABLE sourcing_email_recipients DROP CONSTRAINT sourcing_email_recipients_route_chk';
  END IF;
  EXECUTE $X$
    ALTER TABLE sourcing_email_recipients
      ADD CONSTRAINT sourcing_email_recipients_route_chk
      CHECK (route IN ('india','china','local'))
  $X$;
END $$;

ALTER TABLE sourcing_email_recipients ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "sourcing_recipients_read"   ON sourcing_email_recipients;
DROP POLICY IF EXISTS "sourcing_recipients_insert" ON sourcing_email_recipients;
DROP POLICY IF EXISTS "sourcing_recipients_update" ON sourcing_email_recipients;

-- Anvi Sourcing preview needs to read these. Restrict to admin/manager,
-- which already corresponds to who can see/use Anvi Sourcing.
CREATE POLICY "sourcing_recipients_read" ON sourcing_email_recipients
  FOR SELECT TO authenticated
  USING (current_user_has_pricing_role(ARRAY['admin','manager']));

CREATE POLICY "sourcing_recipients_insert" ON sourcing_email_recipients
  FOR INSERT TO authenticated
  WITH CHECK (current_user_has_pricing_role(ARRAY['admin','manager']));

CREATE POLICY "sourcing_recipients_update" ON sourcing_email_recipients
  FOR UPDATE TO authenticated
  USING      (current_user_has_pricing_role(ARRAY['admin','manager']))
  WITH CHECK (current_user_has_pricing_role(ARRAY['admin','manager']));

DROP TRIGGER IF EXISTS trg_sourcing_recipients_updated_at ON sourcing_email_recipients;
CREATE TRIGGER trg_sourcing_recipients_updated_at
  BEFORE UPDATE ON sourcing_email_recipients
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Create empty route rows. Admin/manager configures recipients in the UI.
INSERT INTO sourcing_email_recipients (route, to_emails, cc_emails, bcc_emails)
VALUES
  ('india', '{}',                          '{}', '{}'),
  ('china', '{}',                          '{}', '{}'),
  ('local', '{}',                          '{}', '{}')
ON CONFLICT (route) DO NOTHING;
