/*
  # Fix Function Search Paths for Security

  1. Security Improvements
    - Set explicit search_path for all functions to prevent search_path injection attacks
    - Use 'pg_catalog, public' as the safe search path
    
  2. Functions Fixed
    - update_tasks_updated_at
    - create_task_status_history
    - update_task_completion
    - notify_mentioned_users
    - notify_task_assignment
    - set_inquiry_number
    - generate_inquiry_number
*/

-- Fix update_tasks_updated_at function
CREATE OR REPLACE FUNCTION update_tasks_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

-- Fix create_task_status_history function
CREATE OR REPLACE FUNCTION create_task_status_history()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF (TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM NEW.status) THEN
    INSERT INTO task_status_history (
      task_id,
      old_status,
      new_status,
      changed_by,
      notes
    ) VALUES (
      NEW.id,
      OLD.status,
      NEW.status,
      NEW.updated_by,
      'Status changed from ' || OLD.status || ' to ' || NEW.status
    );
  END IF;
  RETURN NEW;
END;
$$;

-- Fix update_task_completion function
CREATE OR REPLACE FUNCTION update_task_completion()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF (TG_OP = 'UPDATE' AND NEW.status = 'completed' AND OLD.status != 'completed') THEN
    NEW.completed_at = NOW();
    NEW.completed_by = auth.uid();
  ELSIF (TG_OP = 'UPDATE' AND NEW.status != 'completed' AND OLD.status = 'completed') THEN
    NEW.completed_at = NULL;
    NEW.completed_by = NULL;
  END IF;
  RETURN NEW;
END;
$$;

-- Fix notify_mentioned_users function
CREATE OR REPLACE FUNCTION notify_mentioned_users()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  -- This is a placeholder for notification logic
  -- In a real implementation, you would insert notifications here
  RETURN NEW;
END;
$$;

-- Fix notify_task_assignment function
CREATE OR REPLACE FUNCTION notify_task_assignment()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  -- This is a placeholder for notification logic
  -- In a real implementation, you would insert notifications here
  RETURN NEW;
END;
$$;

-- Fix set_inquiry_number function
CREATE OR REPLACE FUNCTION set_inquiry_number()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.inquiry_number IS NULL THEN
    NEW.inquiry_number := generate_inquiry_number();
  END IF;
  RETURN NEW;
END;
$$;

-- Fix generate_inquiry_number function
CREATE OR REPLACE FUNCTION generate_inquiry_number()
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  next_num INTEGER;
  year_prefix TEXT;
BEGIN
  year_prefix := TO_CHAR(CURRENT_DATE, 'YY');
  
  SELECT COALESCE(MAX(
    CASE 
      WHEN inquiry_number ~ '^INQ-[0-9]{2}-[0-9]+$' 
      THEN CAST(SPLIT_PART(inquiry_number, '-', 3) AS INTEGER)
      ELSE 0
    END
  ), 0) + 1
  INTO next_num
  FROM crm_inquiries
  WHERE inquiry_number LIKE 'INQ-' || year_prefix || '-%';
  
  RETURN 'INQ-' || year_prefix || '-' || LPAD(next_num::TEXT, 4, '0');
END;
$$;