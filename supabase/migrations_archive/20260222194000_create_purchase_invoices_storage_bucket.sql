
/*
  # Create purchase-invoices storage bucket

  Creates a storage bucket for purchase invoice PDF attachments.
  Enables RLS with authenticated user access.
*/

INSERT INTO storage.buckets (id, name, public)
VALUES ('purchase-invoices', 'purchase-invoices', false)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "Authenticated users can upload purchase invoices"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (bucket_id = 'purchase-invoices');

CREATE POLICY "Authenticated users can read purchase invoices"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (bucket_id = 'purchase-invoices');

CREATE POLICY "Authenticated users can delete purchase invoices"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (bucket_id = 'purchase-invoices');
