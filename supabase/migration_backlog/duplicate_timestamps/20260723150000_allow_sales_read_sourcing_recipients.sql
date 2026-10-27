/*
  Sales uses the same sourcing recipient rows as the Admin panel.
  Recipient management remains restricted to admin/manager.
*/

DROP POLICY IF EXISTS "sourcing_recipients_read" ON sourcing_email_recipients;

CREATE POLICY "sourcing_recipients_read" ON sourcing_email_recipients
  FOR SELECT TO authenticated
  USING (current_user_has_pricing_role(ARRAY['admin','manager','sales']));
