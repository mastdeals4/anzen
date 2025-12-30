/*
  # Bank Statements Storage Bucket
  
  ## Purpose
  Create storage bucket for uploaded bank statement PDFs
  
  ## Storage
  - Bucket: bank-statements
  - Public: false (sensitive financial data)
  - File size limit: 50MB
  - Allowed MIME types: application/pdf
  
  ## Security
  - Only authenticated users can upload
  - Only accounts/admin roles can access
*/

-- Create storage bucket
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'bank-statements',
  'bank-statements',
  false,
  52428800, -- 50MB
  ARRAY['application/pdf']
)
ON CONFLICT (id) DO NOTHING;

-- Storage policies
CREATE POLICY "Accounts/admin can upload bank statements"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'bank-statements'
    AND EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
      AND user_profiles.role IN ('admin', 'accounts')
    )
  );

CREATE POLICY "Accounts/admin can view bank statements"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'bank-statements'
    AND EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
      AND user_profiles.role IN ('admin', 'accounts')
    )
  );

CREATE POLICY "Accounts/admin can delete bank statements"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'bank-statements'
    AND EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
      AND user_profiles.role IN ('admin', 'accounts')
    )
  );
