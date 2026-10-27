-- Ensure audit_logs has the required audit fields.
-- Safe/idempotent: only adds missing columns and default.

ALTER TABLE IF EXISTS public.audit_logs
  ADD COLUMN IF NOT EXISTS action_type TEXT,
  ADD COLUMN IF NOT EXISTS table_name TEXT,
  ADD COLUMN IF NOT EXISTS record_id UUID,
  ADD COLUMN IF NOT EXISTS new_values JSONB,
  ADD COLUMN IF NOT EXISTS old_values JSONB,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ;

ALTER TABLE IF EXISTS public.audit_logs
  ALTER COLUMN created_at SET DEFAULT NOW();
