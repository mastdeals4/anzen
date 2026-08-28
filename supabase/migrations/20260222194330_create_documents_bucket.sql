
/*
  # Create documents storage bucket for purchase invoices

  Creates a public documents bucket used by PurchaseInvoiceManager for attachments.
*/

INSERT INTO storage.buckets (id, name, public)
VALUES ('documents', 'documents', true)
ON CONFLICT (id) DO NOTHING;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'objects' AND policyname = 'Authenticated users can upload documents'
  ) THEN
    EXECUTE 'CREATE POLICY "Authenticated users can upload documents"
      ON storage.objects FOR INSERT
      TO authenticated
      WITH CHECK (bucket_id = ''documents'')';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'objects' AND policyname = 'Public can read documents'
  ) THEN
    EXECUTE 'CREATE POLICY "Public can read documents"
      ON storage.objects FOR SELECT
      TO public
      USING (bucket_id = ''documents'')';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'objects' AND policyname = 'Authenticated users can delete documents'
  ) THEN
    EXECUTE 'CREATE POLICY "Authenticated users can delete documents"
      ON storage.objects FOR DELETE
      TO authenticated
      USING (bucket_id = ''documents'')';
  END IF;
END $$;
