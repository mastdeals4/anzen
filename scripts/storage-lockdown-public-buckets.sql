/*
  Manual storage lockdown script.

  This script is intentionally NOT a migration because bucket privacy changes
  should be reviewed bucket-by-bucket with owners first.

  1. Review current bucket state:
     SELECT * FROM public.storage_bucket_security_audit;

  2. For every bucket approved for private access, add it to the IN (...) list
     below and run the UPDATE in a controlled maintenance window.

  3. Confirm app flows use signed URLs or authenticated storage policies before
     locking each bucket.
*/

BEGIN;

-- Example review query:
SELECT bucket_name, public, purpose
FROM public.storage_bucket_security_audit
ORDER BY public DESC, bucket_name;

-- Uncomment and edit after approval.
-- UPDATE storage.buckets
-- SET public = false
-- WHERE id IN (
--   'batch-documents',
--   'product-source-documents',
--   'product-documents',
--   'expense-documents',
--   'sales-order-documents',
--   'documents'
-- );

ROLLBACK;
