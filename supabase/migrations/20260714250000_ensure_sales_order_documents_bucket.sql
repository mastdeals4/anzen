-- ============================================================================
-- Ensure sales-order-documents bucket exists with correct configuration.
--
-- History:
--   20260411121449 — created the bucket (public = true, 10 MB, 7 MIME types)
--   20260411123528 — patched public = true (was already true)
--   20260713120000 — made private (public = false); MIME limit UPDATE only
--                    applied WHERE allowed_mime_types IS NULL, so existing
--                    MIME list was preserved.
--
-- If the bucket exists, ON CONFLICT DO NOTHING is a no-op.
-- If it is missing (e.g. fresh DB or missed migration), it is created with
-- the correct current state: private, 10 MB, original MIME types.
-- ============================================================================

BEGIN;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'sales-order-documents',
  'sales-order-documents',
  false,          -- private since 20260713120000
  10485760,       -- 10 MB
  ARRAY[
    'application/pdf',
    'image/jpeg',
    'image/jpg',
    'image/png',
    'image/webp',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ]
)
ON CONFLICT (id) DO NOTHING;

COMMIT;
