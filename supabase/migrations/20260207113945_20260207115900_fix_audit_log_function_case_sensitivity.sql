/*
  # Fix Audit Log Function Case Sensitivity

  1. Problem
    - log_audit_event() function uses TG_OP which returns uppercase values ('INSERT', 'UPDATE', 'DELETE')
    - audit_logs table check constraint expects lowercase values ('insert', 'update', 'delete')
    - This causes constraint violations when triggers fire

  2. Solution
    - Update log_audit_event() function to use LOWER(TG_OP)
    - This ensures the action_type is stored in lowercase format
*/

CREATE OR REPLACE FUNCTION log_audit_event()
RETURNS TRIGGER AS $$
DECLARE
  v_user_id uuid;
  v_user_email text;
  v_old_data jsonb;
  v_new_data jsonb;
  v_changed_fields text[];
  v_key text;
BEGIN
  -- Get current user info
  v_user_id := auth.uid();
  IF v_user_id IS NOT NULL THEN
    SELECT email INTO v_user_email FROM auth.users WHERE id = v_user_id;
  END IF;

  -- Capture old and new values based on operation
  IF TG_OP = 'DELETE' THEN
    v_old_data := to_jsonb(OLD);
    v_new_data := NULL;
  ELSIF TG_OP = 'INSERT' THEN
    v_old_data := NULL;
    v_new_data := to_jsonb(NEW);
  ELSIF TG_OP = 'UPDATE' THEN
    v_old_data := to_jsonb(OLD);
    v_new_data := to_jsonb(NEW);
    v_changed_fields := ARRAY[]::text[];
    
    -- Track which fields changed
    FOR v_key IN SELECT jsonb_object_keys(v_new_data) LOOP
      IF v_old_data->v_key IS DISTINCT FROM v_new_data->v_key THEN
        v_changed_fields := array_append(v_changed_fields, v_key);
      END IF;
    END LOOP;
    
    -- Skip audit if only updated_at changed
    IF v_changed_fields = ARRAY['updated_at']::text[] THEN
      RETURN NEW;
    END IF;
  END IF;

  -- Insert audit log with LOWERCASE action_type
  INSERT INTO audit_logs (table_name, record_id, action_type, old_values, new_values, changed_fields, user_id, user_email, created_at)
  VALUES (TG_TABLE_NAME, COALESCE(NEW.id, OLD.id), LOWER(TG_OP), v_old_data, v_new_data, v_changed_fields, v_user_id, v_user_email, now());

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  ELSE
    RETURN NEW;
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public';