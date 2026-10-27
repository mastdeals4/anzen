/*
  # Fix storage buckets - make sales-order-documents and documents public

  The 'sales-order-documents' and 'documents' buckets were created as private,
  but the application uses getPublicUrl() which requires public buckets.
  This migration makes them public so file viewing and downloading works correctly.
*/

UPDATE storage.buckets
SET public = true
WHERE id IN ('sales-order-documents', 'documents');
